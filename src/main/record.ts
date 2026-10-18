// Bildschirmaufnahme (Animation → Demo-Szenen): Quelle wählen, MediaRecorder-Chunks in eine Datei unter assets/, nach dem Stopp remuxen.
// Unter Wayland nimmt Chromium PipeWire, auch mit --ozone-platform=x11; dann wählt das xdg-desktop-portal die Quelle.
import { desktopCapturer, webContents, type BrowserWindow, type WebContents } from 'electron'
import { createWriteStream, existsSync, rmSync, type WriteStream } from 'node:fs'
import { mkdir, rename, rm, statfs } from 'node:fs/promises'
import { dataDir } from './clients'
import { basename, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

const MAX_MS = 30 * 60_000
const CHUNK_MAX = 32 * 1024 * 1024 // je Teil (timeslice 1 s); bei 8 Mbit/s kommt ~1 MB
const MIN_FREE = 2 * 1024 ** 3 // 30 min bei 8 Mbit/s ≈ 1,8 GB. ponytail: nur vorab geprüft; läuft der Datenträger voll, scheitert der nächste Chunk
const CUT = 0.7 // Stopp per Rückkehr: die letzten 0,7 s zeigen den Klick zurück ins Fenster; Aufnahmen unter 1,2 s bleiben ungekürzt

/** Wie webrtc (DesktopCapturer::IsRunningUnderWayland): dann nimmt Chromium PipeWire, getSources öffnet das Portal */
export const usesPortal = () => process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY && !!process.env.XDG_SESSION_TYPE?.startsWith('wayland')

const assetDir = () => join(dataDir(), 'assets')

// eigene App-Seite: Dev-Server oder die gebaute index.html (wie createWindow in index.ts)
const ownPage = (url: string) => {
  const dev = process.env.ELECTRON_RENDERER_URL
  try {
    return dev ? new URL(url).origin === new URL(dev).origin : url.startsWith(pathToFileURL(join(__dirname, '../renderer/index.html')).href)
  } catch { return false }
}

interface Rec { win: BrowserWindow; wc: number; source: string | null; mic: boolean; file?: string; raw?: string; out?: WriteStream; err?: Error; t0?: number; timer?: NodeJS.Timeout; ret?: () => void; unwatch?: () => void }
/** angefordert (armed) bis start, dann laufend (out gesetzt) */
let rec: Rec | null = null
let listed = new Set<string>()
let arming = 0 // neue Anforderung oder Abbruch: laufende Prüfungen in recordArm verfallen

/** Rechte und getDisplayMedia nur für das Fenster mit angeforderter Aufnahme. Electron erlaubt ohne Handler jede Berechtigung; das bleibt für alle anderen so. */
export function guardMedia(win: BrowserWindow): void {
  const ses = win.webContents.session
  const armed = (wc: WebContents | null | undefined, url: string) => !!rec && !rec.out && wc?.id === rec.wc && ownPage(url)
  ses.setPermissionRequestHandler((wc, perm, cb, d) => {
    if (perm !== 'media' && perm !== 'display-capture') return cb(true)
    // getDisplayMedia fragt 'media' ohne Gerätetyp an; Mikrofon nur mit Schalter, Kamera nie
    const types = ('mediaTypes' in d ? d.mediaTypes : undefined) ?? []
    cb(armed(wc, d.requestingUrl) && d.isMainFrame && types.every((t) => t === 'audio' && rec!.mic))
  })
  ses.setDisplayMediaRequestHandler((req, cb) => {
    const f = req.frame
    if (!f || f.parent || !armed(webContents.fromFrame(f), f.url)) return cb({})
    if (rec!.source) return cb({ video: { id: rec!.source, name: 'Aufnahme' } })
    // Portal: getSources zeigt die Auswahl des Systems und liefert genau die gewählte Quelle (Fenster oder Bildschirm)
    desktopCapturer.getSources({ types: ['screen', 'window'] })
      .then((s) => cb(s[0] ? { video: s[0] } : {}), () => cb({}))
  })
}

/** Quellen mit Vorschau; unter Wayland leer (portal: true), dort wählt das System beim Start */
export async function recordSources(win: BrowserWindow, sender: WebContents) {
  if (sender !== win.webContents) throw new Error('Aufnahme nur aus dem Hauptfenster.') // Vorschaubilder zeigen Bildschirminhalte
  if (usesPortal()) return { portal: true, sources: [] }
  const mine = win.getMediaSourceId().split(':').slice(0, 2).join(':') + ':' // window:<id>: – minimiert wäre es nur schwarz
  const all = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
  const sources = all.filter((s) => !s.id.startsWith(mine)).map((s) => ({ id: s.id, name: s.name, screen: s.id.startsWith('screen:'), thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() }))
  listed = new Set(sources.map((s) => s.id))
  return { portal: false, sources }
}

const mineOf = (sender: WebContents) => {
  if (!rec || sender.id !== rec.wc) throw new Error('Keine Aufnahme angefordert.')
  return rec
}

/** Aufnahme anfordern: Quelle prüfen (nur aus recordSources), Platz prüfen; danach darf das Fenster getDisplayMedia/Mikrofon */
export async function recordArm(win: BrowserWindow, sender: WebContents, source: unknown, mic: unknown): Promise<void> {
  if (sender !== win.webContents) throw new Error('Aufnahme nur aus dem Hauptfenster.')
  if (rec?.out) throw new Error('Es läuft schon eine Aufnahme.')
  const portal = usesPortal()
  if (portal ? source !== null : typeof source !== 'string' || !listed.has(source)) throw new Error('Bitte zuerst eine Quelle wählen.')
  const g = ++arming
  const dir = assetDir()
  await mkdir(dir, { recursive: true })
  const fs = await statfs(dir)
  if (g !== arming) throw new Error('Aufnahme abgebrochen.')
  if (rec?.out) throw new Error('Es läuft schon eine Aufnahme.') // inzwischen gestartet
  if (fs.bavail * fs.bsize < MIN_FREE) throw new Error(`Zu wenig freier Speicher für eine Aufnahme: mindestens 2 GB unter ${dir}.`)
  if (rec) end(rec)
  const r: Rec = rec = { win, wc: sender.id, source: portal ? null : (source as string), mic: mic === true }
  // Renderer weg (Reload, HMR, Absturz, Fenster zu): sonst bliebe die Aufnahme „laufend“, das Fenster minimiert und die Rohdatei liegen
  const gone = () => void drop(r, true)
  const nav = (d: { isMainFrame: boolean; isSameDocument: boolean }) => { if (d.isMainFrame && !d.isSameDocument) gone() }
  sender.on('destroyed', gone).on('render-process-gone', gone).on('did-start-navigation', nav)
  r.unwatch = () => { if (!sender.isDestroyed()) sender.off('destroyed', gone).off('render-process-gone', gone).off('did-start-navigation', nav) }
}

/** Nach dem Countdown: Datei anlegen, Deckwerk minimieren; Rückkehr ins Fenster meldet record:back (cut = true) */
export async function recordStart(sender: WebContents): Promise<void> {
  const r = mineOf(sender)
  if (r.out) throw new Error('Es läuft schon eine Aufnahme.')
  const stamp = new Date().toLocaleString('sv').replace(' ', '-').replace(/:/g, '') // JJJJ-MM-TT-HHMMSS
  let name = `aufnahme-${stamp}`
  for (let n = 2; existsSync(join(assetDir(), `${name}.webm`)); n++) name = `aufnahme-${stamp}-${n}` // nie still überschreiben
  r.file = join(assetDir(), `${name}.webm`)
  r.raw = join(assetDir(), `.${name}.roh.webm`) // Punktdatei: der Cloud-Sync lässt sie aus
  r.out = createWriteStream(r.raw)
  r.out.on('error', (e) => { r.err = e })
  r.t0 = Date.now()
  const back = (cut: boolean) => { if (rec === r && !r.win.isDestroyed()) r.win.webContents.send('record:back', cut) }
  r.timer = setTimeout(() => back(false), MAX_MS)
  r.win.minimize()
  // Minimieren samt Animation abwarten: sonst ist Deckwerk im ersten Bild, und der Fokuswechsel zählte schon als Rückkehr
  await new Promise((go) => setTimeout(go, 600))
  if (rec !== r) return
  const ret = r.ret = () => { r.win.off('focus', ret).off('restore', ret); back(true) } // focus und restore kommen meist beide: einmal melden
  r.win.on('focus', ret).on('restore', ret)
}

export function recordChunk(sender: WebContents, data: unknown): void {
  const r = mineOf(sender)
  if (!r.out) throw new Error('Keine laufende Aufnahme.')
  if (!(data instanceof Uint8Array) || data.byteLength > CHUNK_MAX) throw new Error('Ungültiger Teil der Aufnahme.')
  if (Date.now() - r.t0! > MAX_MS + 60_000) throw new Error('Die Aufnahme ist länger als 30 Minuten.')
  if (r.err) throw r.err
  r.out.write(data)
}

// Aufnahme beenden: keine Chunks/Rechte mehr, Fenster zurück
function end(r: Rec) {
  if (rec === r) rec = null
  clearTimeout(r.timer)
  r.unwatch?.()
  if (r.win.isDestroyed()) return
  if (r.ret) r.win.off('focus', r.ret).off('restore', r.ret)
  if (r.out) { if (r.win.isMinimized()) r.win.restore(); r.win.focus() }
}

/** Stopp → fertige Datei (absoluter Pfad). Remux mit -c copy, damit Dauer und Spulen stimmen; cut schneidet die Rückkehr ab. */
export async function recordStop(sender: WebContents, cut: boolean): Promise<string> {
  const r = mineOf(sender)
  if (!r.out) throw new Error('Keine laufende Aufnahme.')
  end(r)
  const raw = r.raw!, file = r.file!, tmp = join(assetDir(), `.${basename(file)}`)
  r.out.end()
  await finished(r.out).catch(() => {}) // Schreibfehler (Platte voll): was da ist, bleibt
  try {
    const { probe, runFfmpeg } = await import('./ffmpeg')
    await runFfmpeg(['-i', raw, '-c', 'copy', tmp])
    const keep = cut ? (await probe(tmp)).duration - CUT : 0
    if (keep > 0.5) await runFfmpeg(['-i', tmp, '-t', keep.toFixed(3), '-c', 'copy', file])
    else await rename(tmp, file)
    await rm(raw, { force: true })
  } catch (e) {
    // ohne ffmpeg oder bei vollem Datenträger nicht die Aufnahme verlieren: ungeremuxt abspielbar, nur ohne Dauer
    console.warn('[record] Remux fehlgeschlagen, Rohdatei bleibt:', e)
    await rename(raw, file)
  } finally {
    await rm(tmp, { force: true })
  }
  return file
}

// Abbruch: angefangene Datei weg. now: Fenster zu, die App beendet sich gleich und ein asynchrones Löschen käme nicht mehr dran;
// Unix löscht offene Dateien, libuv öffnet sie auch unter Windows mit FILE_SHARE_DELETE
async function drop(r: Rec, now = false) {
  end(r)
  if (!r.out) return
  r.out.destroy()
  if (now) try { rmSync(r.raw!, { force: true }) } catch {}
  await finished(r.out).catch(() => {}) // erst schließen, dann löschen (Windows: EBUSY)
  await rm(r.raw!, { force: true }).catch((e) => console.warn('[record] Rohdatei nicht gelöscht:', e))
}

/** Abbruch (Sheet geschlossen, Fehler) */
export async function recordCancel(sender: WebContents): Promise<void> {
  arming++
  const r = rec
  if (r && sender.id === r.wc) await drop(r)
}
