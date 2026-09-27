import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { sizeOf, type Deck, type Measured } from '../shared/deck'

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
        webPreferences: { offscreen, zoomFactor: offscreen ? ZOOM : 1, backgroundThrottling: false },
      })
      if (offscreen) win.webContents.setFrameRate(60)
      win.setContentSize(1280 * ZOOM, 721 * ZOOM)
      if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${mode}`)
      else await win.loadFile(join(__dirname, '../renderer/index.html'), { hash: mode })
      win.on('closed', () => hosts.delete(mode))
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
  const r = await win.webContents.executeJavaScript(`(async () => { try { while (!window.dw) await new Promise((r) => setTimeout(r, 20)); return await ${js} } catch (e) { return { __dwError: String((e && (e.stack || e.message)) || e) } } })()`, true)
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

/** Render slide i: measure; optionally capture the full slide and/or the background (everything non-native). */
export function renderSlide(deck: Deck, i: number, opts: { png?: boolean; background?: boolean } = {}): Promise<Rendered> {
  return serial(async () => {
    const win = await host('render')
    const { w, h } = sizeOf(deck)
    fitWindow(win, w * ZOOM, (h + 1) * ZOOM) // vor dem Rendern: nach einem Resize zeigt der Offscreen-Compositor alte Canvas nicht mehr
    const measured = await call<Measured>(win, `dw.render(${JSON.stringify(deck)}, ${i})`)
    const out: Rendered = { measured }
    if (opts.png) out.png = await snap(win, h, w)
    if (opts.background) {
      await call(win, 'dw.hideExportables(true)')
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
