import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { isA4, PRINT_SIZES, sizeOf, type Deck, type Measured, type PrintOptions } from '../shared/deck'
import { setPrintBoxes } from './pdf-boxes'

// Offscreen Chromium windows that render slides with the exact same React code as the app.
// Render at zoom 2 → 2560x1440 captures (crisp backgrounds), while the CSS layout stays 1280x720.
const ZOOM = 2

const hosts = new Map<string, Promise<BrowserWindow>>()
function host(mode: 'render' | 'print' | 'overview'): Promise<BrowserWindow> {
  let p = hosts.get(mode)
  if (!p) {
    p = (async () => {
      const offscreen = mode !== 'print'
      const win = new BrowserWindow({
        show: false, width: 1280 * ZOOM, height: 721 * ZOOM, useContentSize: true, frame: false, enableLargerThanScreen: true,
        // spellcheck aus: Electron prüft standardmäßig, Wellenlinien unter editierbarem Text landeten sonst im Export
        webPreferences: { offscreen, zoomFactor: offscreen ? ZOOM : 1, backgroundThrottling: false, spellcheck: false },
      })
      if (offscreen) win.webContents.setFrameRate(60)
      win.setContentSize(1280 * ZOOM, 721 * ZOOM)
      if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${mode}`)
      else await win.loadFile(join(__dirname, '../renderer/index.html'), { hash: mode })
      win.on('closed', () => hosts.delete(mode))
      // Stirbt der Renderer (z. B. OOM bei wenig RAM neben der Spracherkennung), Seite neu laden statt das Fenster zu schließen:
      // ohne Fenster beendet window-all-closed den MCP-Prozess. call() wartet danach wieder auf window.dw.
      win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.webContents.reload() })
      return win
    })()
    hosts.set(mode, p)
  }
  return p
}

// One job at a time per process: the host windows hold a single slide state.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => {})
  return run
}

// Fehler aus dem Renderer kommen über executeJavaScript als leeres Objekt an; deshalb Meldung und Stack als Text zurückgeben.
// window.dw entsteht erst, wenn das nachgeladene Bundle (boot.ts) den Host gerendert hat – bis dahin warten.
const call = async <T>(win: BrowserWindow, js: string): Promise<T> => {
  const wc = win.webContents
  // executeJavaScript kehrt nach einem Renderer-Absturz nie zurück: dann abbrechen statt ewig zu warten
  let gone = (_: unknown, d: { reason: string }) => {}
  const r = await new Promise<unknown>((resolve, reject) => {
    gone = (_, d) => reject(new Error(`Der Render-Prozess wurde beendet (${d.reason}), oft wegen knappen Arbeitsspeichers. Bitte noch einmal versuchen.`))
    wc.once('render-process-gone', gone)
    wc.executeJavaScript(`(async () => { try { while (!window.dw) await new Promise((r) => setTimeout(r, 20)); return await ${js} } catch (e) { return { __dwError: String((e && (e.stack || e.message)) || e) } } })()`, true).then(resolve, reject)
  }).finally(() => { if (!wc.isDestroyed()) wc.off('render-process-gone', gone) }) as { __dwError?: string } | T
  if (r && typeof r === 'object' && '__dwError' in r) throw new Error(`Renderer: ${r.__dwError}`)
  return r as T
}

// Offscreen frames arrive with latency, so capturePage() can return a stale slide. Each capture bumps a
// sequence number that the page paints into a 1px marker row below the slide; we take the first frame
// whose marker matches, then crop the marker away.
let seq = 0
async function snap(win: BrowserWindow, heightCss = 720, widthCss = 1280): Promise<Buffer> {
  const wc = win.webContents
  const n = ++seq
  const want = [n % 200, 255 - (n % 200), 128]
  const [w, h] = [Math.round(widthCss * ZOOM), Math.round(heightCss * ZOOM)]
  const matches = (img: Electron.NativeImage | null): img is Electron.NativeImage => {
    if (!img) return false
    const size = img.getSize()
    if (size.width < w || size.height < h + 1) return false
    const px = img.crop({ x: 4, y: size.height - 1, width: 1, height: 1 }).toBitmap() // BGRA or RGBA, platform-dependent
    const near = (a: number, b: number) => Math.abs(a - b) < 6
    return near(px[1], want[1]) && ((near(px[2], want[0]) && near(px[0], want[2])) || (near(px[0], want[0]) && near(px[2], want[2])))
  }
  await call(win, `dw.mark(${n})`)
  // Direkt nach setContentSize (Kontaktbogen) wirft capturePage teils UnknownVizError → wie einen alten Frame behandeln
  const capture = () => wc.capturePage().catch(() => null)
  let img = await capture()
  for (let t = 0; !matches(img); t++) {
    if (t > 150) {
      if (!img) throw new Error(`Frame ${n} ließ sich nicht aufnehmen`)
      console.warn(`[render] Frame ${n} ohne passenden Marker nach 3 s – nehme den letzten`)
      break
    }
    wc.invalidate()
    await new Promise((r) => setTimeout(r, 20))
    img = await capture()
  }
  return img.crop({ x: 0, y: 0, width: w, height: h }).toPNG()
}

const fitWindow = (win: BrowserWindow, w: number, h: number) => {
  if (win.getContentSize().join() !== `${Math.round(w)},${Math.round(h)}`) win.setContentSize(Math.round(w), Math.round(h))
}

export interface Rendered { measured: Measured; png?: Buffer; background?: Buffer }

/** Render slide i: measure; optionally capture the full slide and/or the background (everything non-native; 'text' = nur ohne Text, für Word). */
export function renderSlide(deck: Deck, i: number, opts: { png?: boolean; background?: boolean | 'text' } = {}): Promise<Rendered> {
  return serial(async () => {
    const win = await host('render')
    const { w, h } = sizeOf(deck)
    fitWindow(win, w * ZOOM, (h + 1) * ZOOM) // vor dem Rendern: nach einem Resize zeigt der Offscreen-Compositor alte Canvas nicht mehr
    const measured = await call<Measured>(win, `dw.render(${JSON.stringify(deck)}, ${i})`)
    const out: Rendered = { measured }
    if (opts.png) out.png = await snap(win, h, w)
    if (opts.background) {
      await call(win, `dw.hideExportables(${JSON.stringify(opts.background)})`)
      out.background = await snap(win, h, w)
      await call(win, 'dw.hideExportables(false)')
    }
    return out
  })
}

export function renderPdf(deck: Deck): Promise<Buffer> {
  return serial(async () => {
    const win = await host('print')
    const { w, h } = sizeOf(deck)
    fitWindow(win, w, h + 1)
    await call(win, `dw.renderAll(${JSON.stringify(deck)})`)
    return win.webContents.printToPDF({ pageSize: { width: w / 96, height: h / 96 }, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 }, preferCSSPageSize: true })
  })
}

// Druck-PDF: Seite = Endformat + Beschnitt ringsum, die Folie (w×h px) auf das Endformat skaliert. Chromium rundet die Papiergröße
// auf ganze pt; ragt die Seite auch nur um Bruchteile darüber hinaus, verkleinert es den ganzen Inhalt (bis auf 2/3). Deshalb Seite
// in ganzen pt und Endformat = Seite − 2·Beschnitt: weicht höchstens 0,5 pt (0,18 mm) vom Nennmaß ab, der Beschnitt bleibt ringsum gleich.
const PT = 72 / 25.4 // pt je mm
export function renderPrintPdf(deck: Deck, opts: PrintOptions = {}): Promise<Buffer> {
  const { w, h } = sizeOf(deck)
  const a4 = isA4({ w, h }) // A4 hoch oder quer; die Visitenkarte druckt in ihrer eigenen Größe
  if (opts.size && !a4) throw new Error(`Druckformat ${opts.size.toUpperCase()} geht nur bei A4-Decks (hoch oder quer); dieses Deck ist ${w}×${h} px. Ohne Format wird es in seiner eigenen Größe gedruckt.`)
  const [pw, ph] = PRINT_SIZES[opts.size ?? 'a4']
  const [tw, th] = a4 ? (w > h ? [ph, pw] : [pw, ph]) : [(w * 25.4) / 96, (h * 25.4) / 96] // Endformat in mm
  const bleed = (Math.min(5, Math.max(0, opts.bleed ?? 3)) || 0) * PT
  const pageW = Math.round(tw * PT + 2 * bleed), pageH = Math.round(th * PT + 2 * bleed)
  const fx = ((pageW - 2 * bleed) * 4) / 3 / w, fy = ((pageH - 2 * bleed) * 4) / 3 / h // 1 pt = 4/3 CSS-px
  const geo = { pageW, pageH, bleed, fx, fy, bx: (bleed * 4) / 3 / fx, by: (bleed * 4) / 3 / fy }
  return serial(async () => {
    const win = await host('print')
    fitWindow(win, w, h + 1)
    await call(win, `dw.renderAll(${JSON.stringify(deck)}, ${JSON.stringify(geo)})`)
    const pdf = await win.webContents.printToPDF({ pageSize: { width: pageW / 72, height: pageH / 72 }, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 }, preferCSSPageSize: true })
    return setPrintBoxes(pdf, bleed)
  })
}

export function renderOverview(deck: Deck): Promise<Buffer> {
  return serial(async () => {
    const win = await host('overview')
    const json = JSON.stringify(deck)
    await call(win, `dw.renderAll(${json})`)
    const h = await call<number>(win, 'document.getElementById("root").firstElementChild.scrollHeight') // #root ist mind. fensterhoch (app.css)
    const size = [1280 * ZOOM, Math.ceil((h + 1) * ZOOM)]
    if (win.getContentSize().join() !== size.join()) {
      win.setContentSize(size[0], size[1])
      // Nach dem Resize zeigt der Offscreen-Compositor vorhandene Canvas (Diagramme) nicht mehr → neu aufbauen
      await call(win, `dw.renderAll(${JSON.stringify({ ...deck, slides: [] })})`)
      await call(win, `dw.renderAll(${json})`)
    }
    return snap(win, h)
  })
}

export function closeHosts() {
  for (const p of hosts.values()) p.then((w) => w.destroy())
  hosts.clear()
}
