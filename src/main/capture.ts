// Website-Aufnahme für Demos: eine fremde Seite in einem abgeschotteten Offscreen-Fenster laden und als PNG festhalten.
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BrowserWindow, session } from 'electron'

// Fenster in CSS-Pixeln mal Zoom (wie render.ts): die Seite sieht 1440 bzw. 390 px Breite, das PNG hat die volle Auflösung.
// ponytail: „handy“ ist ein schmales Fenster mit Mobil-Kennung, ohne Touch-Emulation; Upgrade: webContents.enableDeviceEmulation({ screenPosition: 'mobile' }).
const DEVICES = {
  desktop: { w: 1440, h: 900, f: 2, ua: undefined },
  handy: { w: 390, h: 844, f: 3, ua: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Mobile Safari/537.36` },
}

const MAX_SHOTS = 12, MAX_STEP = 60_000, TOTAL = 120_000 // Grenzen gegen ausufernde Wünsche der KI: Bilder, Frist je Schritt, Frist gesamt
const web = (url: string) => /^https?:/i.test(url)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const within = <T>(p: Promise<T>, ms: number, msg: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms).unref())])

/** Prüft die Adresse. localhost und das LAN sind ausdrücklich erlaubt: Hauptfall ist die Live-Demo der eigenen App, die noch auf dem
 *  Entwicklungsrechner läuft. Das Fenster hat weder Preload noch Node und eine leere Partition, eine Seite dort erreicht also nichts,
 *  was der Nutzer nicht ohnehin im Browser öffnen könnte. */
function checkUrl(raw: string): URL {
  let u: URL
  try { u = new URL(raw) } catch { throw new Error(`Keine gültige Adresse: ${raw}`) }
  if (!web(u.protocol)) throw new Error(`Nur Webseiten (http:// oder https://) lassen sich aufnehmen, nicht ${u.protocol}`)
  if (u.username || u.password) throw new Error('Adressen mit Zugangsdaten (name:passwort@…) nimmt Deckwerk nicht auf.')
  return u
}

/** Nimmt die Seite auf; je Scroll-Stelle p (0 = oben, 1 = ganz unten) ein PNG in outDir. Gibt die absoluten Pfade zurück. */
export async function capturePage(url: string, o: { device?: 'desktop' | 'handy'; scroll?: number[]; outDir: string; timeoutMs?: number }): Promise<string[]> {
  const u = checkUrl(url)
  const dev = DEVICES[o.device ?? 'desktop'], timeout = Math.min(MAX_STEP, Math.max(1000, o.timeoutMs ?? 20_000))
  const outDir = resolve(o.outDir)
  await mkdir(outDir, { recursive: true })

  // Eigene Partition je Aufruf, ohne „persist:“: Cookies, Logins und Cache bleiben im Speicher und sehen keine andere Seite der App
  // ponytail: Electron behält das Session-Objekt je Partitionsname bis zum Prozessende (nur die Daten werden gelöscht); bei sehr vielen Aufnahmen eine Partition wiederverwenden
  const ses = session.fromPartition(`capture-${randomUUID()}`, { cache: false })
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (e) => e.preventDefault())
  // Unterressourcen nur aus dem Netz; file:, asset:, chrome: usw. nie. data:/blob: entstehen in der Seite selbst.
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(https?|wss?|data|blob):/i.test(d.url) }))
  if (dev.ua) ses.setUserAgent(dev.ua)

  const win = new BrowserWindow({
    show: false, width: dev.w * dev.f, height: dev.h * dev.f, useContentSize: true, frame: false, enableLargerThanScreen: true,
    webPreferences: {
      session: ses, offscreen: true, zoomFactor: dev.f, sandbox: true, contextIsolation: true, nodeIntegration: false,
      spellcheck: false, backgroundThrottling: false,
    },
  })
  const wc = win.webContents
  const shoot = async () => {
    wc.setFrameRate(60)
    win.setContentSize(dev.w * dev.f, dev.h * dev.f)
    wc.setAudioMuted(true) // Autoplay-Ton einer Seite soll nicht aus den Lautsprechern kommen
    // Ersetzt den Handler aus index.ts, der http-Adressen im System-Browser öffnet: eine aufgenommene Seite öffnet gar nichts
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    // In der App sperrt index.ts zusätzlich jede Navigation aus der Seite heraus; Weiterleitungen des Servers bleiben auf http(s)
    wc.on('will-navigate', (e, to) => { if (!web(to)) e.preventDefault() })
    wc.on('will-redirect', (e, to) => { if (!web(to)) e.preventDefault() })

    let dom = false
    wc.once('dom-ready', () => (dom = true))
    await within(wc.loadURL(u.href), timeout, `Die Seite ${u.host} hat nicht innerhalb von ${Math.round(timeout / 1000)} s geladen.`).catch((e: Error) => {
      if (!/nicht innerhalb/.test(e.message)) throw new Error(`Die Seite ${u.href} ließ sich nicht laden (${e.message}).`)
      if (!dom) throw e
      wc.stop() // Dokument steht, nur Fremdressourcen hängen: den Stand aufnehmen
    })
    // Eigene Welt für unsere Skripte: die Seite kann scrollTo oder requestAnimationFrame nicht verbiegen
    const js = (code: string) => within(wc.executeJavaScriptInIsolatedWorld(1001, [{ code }]), timeout, `Die Seite ${u.host} reagiert nicht.`)
    await Promise.race([js('document.fonts.ready.then(() => 0)'), sleep(3000)]).catch(() => {}) // hängende Webfonts: mit Ersatzschrift weiter
    await sleep(800) // Einblend-Animationen und nachgeladene Bilder

    const host = u.hostname.replace(/[^a-z0-9.-]+/gi, '-').slice(0, 60).replace(/^-+|-+$/g, '') || 'seite' // gekürzt: ENAMETOOLONG
    const files: string[] = []
    let k = 0
    for (const p of (o.scroll ?? [0]).slice(0, MAX_SHOTS)) {
      const at = Math.min(1, Math.max(0, Number(p) || 0))
      await js(`(() => { const el = document.scrollingElement || document.documentElement; scrollTo(0, ${at} * Math.max(0, el.scrollHeight - innerHeight))
        return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0)))) })()`)
      wc.invalidate()
      await sleep(300)
      let img = await within(wc.capturePage(), timeout, `Die Seite ${u.host} ließ sich nicht aufnehmen.`)
      if (img.isEmpty()) throw new Error(`Die Aufnahme von ${u.host} ist leer.`)
      const [w, h] = [dev.w * dev.f, dev.h * dev.f]
      const size = img.getSize()
      if (size.width !== w || size.height !== h) img = img.resize({ width: w, height: h }) // Offscreen mit Bildschirm-Skalierung ≠ 1
      // eindeutiger Name, auch neben früheren Aufnahmen derselben Seite (wx: nie überschreiben)
      for (;;) {
        const file = join(outDir, `seite-${host}-${++k}.png`)
        try { await writeFile(file, img.toPNG(), { flag: 'wx' }); files.push(file); break } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      }
    }
    return files
  }
  try {
    return await within(shoot(), TOTAL, `Die Aufnahme von ${u.host} dauerte länger als ${TOTAL / 60_000} min.`)
  } finally {
    if (!win.isDestroyed()) win.destroy() // destroy statt close: ein beforeunload der Seite hält das Fenster sonst offen
    await Promise.all([ses.clearStorageData(), ses.clearCache()]).catch(() => {})
  }
}
