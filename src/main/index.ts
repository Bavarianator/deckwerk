import { app, BrowserWindow, net, protocol, shell } from 'electron'
import { spawn } from 'node:child_process'
import { setDefaultResultOrder } from 'node:dns'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MEDIA_EXT, profileOf, VIDEO_FILE } from '../shared/deck'
import type { createEngine } from './engine'
import { setupSpellcheck } from './spellcheck'
import { localAsset } from './sync'

// Schwere Module (Engine, Agent, MCP, pptxgenjs, lucide …) erst nach dem Fenster laden: der Splash erscheint sofort,
// und der Renderer lädt parallel zum Main-Prozess. Die Preload-Brücke wiederholt Aufrufe, bis registerIpc steht.
const loadEngine = async () => (await import('./engine')).createEngine()

// IPv4 zuerst: mit kaputtem IPv6 (häufig im Heimnetz) hing jede Verbindung bis zum Timeout; Bildsuche und Bild-KI brauchten so
// Minuten statt Sekunden. Reine IPv6-Netze liefern keine IPv4-Adresse und gehen weiter über IPv6.
setDefaultResultOrder('ipv4first')

// macOS: aus dem Finder gestartete Apps erben den PATH der Shell nicht, claude/node/pdftotext wären sonst unauffindbar
if (process.platform === 'darwin') process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')].filter(Boolean).join(':')

// Linux-Paket (AppImage) ohne Startskript: unter Wayland hängt printToPDF, deshalb einmal über XWayland neu starten.
// Nur die App; CLI und MCP bekommen die Flags über ihren Aufruf (MCP-Eintrag in ipc.ts wählt x11 oder headless).
const argv0 = process.argv
if (process.platform === 'linux' && app.isPackaged && process.env.WAYLAND_DISPLAY && !argv0.some((a) => a.startsWith('--ozone-platform'))
  && !['--mcp', '--render', '--check'].some((f) => argv0.includes(f))) {
  // eigener Prozess statt app.relaunch (greift so früh nicht); das neue AppImage hängt sich selbst ein
  spawn(process.env.APPIMAGE ?? process.execPath, [...argv0.slice(1), '--ozone-platform=x11'], { detached: true, stdio: 'ignore' }).unref()
  app.exit(0)
}

// Kein Fenster navigiert weg oder öffnet neue (z. B. ein auf die Folie gezogener Link): fremde Seiten bekämen sonst die Preload-API
app.on('web-contents-created', (_, wc) => {
  wc.on('will-navigate', (e) => e.preventDefault())
  // Ausnahme: verlinkte Elemente beim Präsentieren (window.open) – nur Web- und Mail-Adressen, im System-Browser
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?:\/\/|mailto:)/.test(url)) void shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
})

protocol.registerSchemesAsPrivileged([{ scheme: 'asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])

// Höchstens 2 ffmpeg-Standbilder gleichzeitig: eine fremde deck.json mit vielen Clip-Folien löste sonst eine Prozessflut aus
let frameFree = 2
const frameQueue: (() => void)[] = []
async function frameSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (frameFree > 0) frameFree--
  else await new Promise<void>((go) => frameQueue.push(go))
  try { return await fn() } finally { const next = frameQueue.shift(); if (next) next(); else frameFree++ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1200, minHeight: 760, backgroundColor: '#ffffff', title: 'Deckwerk',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true },
  })
  win.removeMenu() // keine native Menüleiste (File/Edit/View) unter Linux/Windows; macOS behält sein App-Menü
  // DW_SHOT=<file.png>: screenshot the real app once it has settled, then quit (visual verification)
  const shot = process.env.DW_SHOT
  if (shot)
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        await writeFile(shot, (await win.webContents.capturePage()).toPNG())
        app.exit(0)
      }, Number(process.env.DW_SHOT_DELAY ?? 4000)),
    )
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

// CLI: electron . --render examples/pitch.json [--out exports]   → pptx + pdf + pngs + lint report
async function renderCli(engine: ReturnType<typeof createEngine>, file: string, outDir: string) {
  const { localizeDeck } = await import('./tools')
  const deck = localizeDeck(JSON.parse(await readFile(resolve(file), 'utf8')), dirname(resolve(file)))
  const fonts = await (await import('./webfonts')).withDeckFonts(deck) // Katalogschriften laden bzw. Ersatz, verwaiste Einträge weg
  deck.theme = fonts.theme
  for (const n of fonts.notes) console.log(`Schriften: ${n}`)
  const issues = await engine.lint(deck)
  for (const i of issues) console.log(`${i.severity === 'error' ? '✗' : '!'} Folie ${i.slide + 1} [${i.rule}] ${i.message}`)
  console.log(`${issues.filter((i) => i.severity === 'error').length} Fehler, ${issues.filter((i) => i.severity === 'warn').length} Warnungen`)
  for (const f of ['pptx', 'docx', 'pdf', 'png', 'zip', ...(profileOf(deck) === 'doc' ? (['print'] as const) : [])] as const) {
    const files = await engine.exportDeck(deck, f, outDir)
    console.log(`→ ${f}: ${files.length > 1 ? dirname(files[0]) : files[0]}`)
  }
}

app.whenReady().then(async () => {
  // CORS-Header, damit Canvas Pixel lesen darf (Video-Poster, Freisteller); stream + Range für Video/Audio
  protocol.handle('asset', async (req) => {
    const file = localAsset(decodeURIComponent(new URL(req.url).pathname))
    if (!MEDIA_EXT.test(file)) return new Response(null, { status: 403 })
    // ?frame=<s> auf einer Videodatei: Standbild als JPEG (ffmpeg, gecacht). Die Clip-Folie braucht kein <video>, das im Offscreen-Fenster nach dem Spulen hängt.
    const frame = new URL(req.url).searchParams.get('frame')
    if (frame !== null && VIDEO_FILE.test(file)) {
      try {
        const t = Math.round(Math.min(48 * 3600, Math.max(0, Number(frame) || 0)) * 10) / 10 // fremde deck.json: keine Fantasiezeiten im Cache-Namen
        const st = await stat(file)
        const dir = join(process.env.DECKWERK_HOME ?? join(homedir(), 'Deckwerk'), 'assets', '.video')
        const jpg = join(dir, `${createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex')}-${t}.jpg`)
        let buf: Uint8Array | undefined = await readFile(jpg).catch(() => undefined)
        if (!buf) {
          buf = await frameSlot(async () => (await (await import('./ffmpeg')).frames(file, [t], 1280))[0])
          await mkdir(dir, { recursive: true })
          await writeFile(jpg, buf)
        }
        return new Response(buf as BodyInit, { headers: { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*' } })
      } catch {
        return new Response(null, { status: 404 })
      }
    }
    // net.fetch schneidet bei Range zwar die Bytes zu, antwortet aber mit 200 ohne Content-Range: dann hält Chromium Videos für nicht spulbar.
    // Darum Range selbst auflösen (auch bytes=100- und bytes=-500) und als 206 beantworten.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
    let part: { start: number; end: number; size: number } | undefined
    if (m && (m[1] || m[2])) {
      const size = (await stat(file)).size
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      part = { start, end, size }
    }
    const ask = new Headers(req.headers)
    if (part) ask.set('Range', `bytes=${part.start}-${part.end}`)
    const res = await net.fetch(pathToFileURL(file).toString(), { headers: ask })
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Accept-Ranges', 'bytes')
    if (part && res.status === 200) {
      headers.set('Content-Range', `bytes ${part.start}-${part.end}/${part.size}`)
      headers.set('Content-Length', String(part.end - part.start + 1))
      return new Response(res.body, { status: 206, headers })
    }
    return new Response(res.body, { status: res.status, headers })
  })
  const argv = process.argv
  const at = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  const cli = argv.includes('--render') || argv.includes('--check')
  if (!cli && !argv.includes('--mcp')) {
    // Zweiter Klick aufs Symbol holt das offene Fenster nach vorn statt einer zweiten Instanz (CLI/MCP dürfen parallel laufen)
    if (!app.requestSingleInstanceLock()) return app.quit()
    const win = createWindow()
    setupSpellcheck(win)
    // Die versteckten Render-Fenster (render.ts) halten die App sonst nach dem Schließen am Leben: window-all-closed kommt nie,
    // und ein zweiter Start griff auf das zerstörte Fenster zu („Object has been destroyed“). Speichern (ipc.ts flush) läuft vorher.
    win.on('closed', () => app.quit())
    app.on('second-instance', () => { if (win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.show(); win.focus() })
    const [engine, { registerIpc }] = await Promise.all([loadEngine(), import('./ipc')])
    return registerIpc(win, engine)
  }
  app.dock?.hide() // CLI/MCP: kein Dock-Symbol (macOS)
  const engine = await loadEngine()
  if (argv.includes('--mcp')) {
    // ponytail: Bild-Einstellungen nur beim Start; Änderungen in der App gelten im Agenten ab dessen nächster Sitzung
    ;(await import('./image-settings')).loadImageSettings()
    return (await import('./mcp')).startMcp(engine) // no window; stdout belongs to the MCP protocol
  }
  try {
    if (argv.includes('--render')) await renderCli(engine, at('--render')!, at('--out') ?? 'exports')
    else if (argv.includes('--check')) process.exitCode = (await (await import('./check')).checkLayouts(engine)) ? 0 : 1
  } catch (e) {
    console.error(e instanceof Error ? e : `Fehler: ${JSON.stringify(e, Object.getOwnPropertyNames(Object(e)))}`) // Renderer-Fehler kommen als Objekt ohne eigene Felder
    process.exitCode = 1
  }
  if (cli) {
    ;(await import('./render')).closeHosts()
    app.exit(Number(process.exitCode ?? 0))
  }
})

// auch unter macOS beenden: die IPC hängt am einen Hauptfenster, ein neues Fenster per Dock-Klick hätte keine
app.on('window-all-closed', () => app.quit())
