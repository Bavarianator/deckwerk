import { app, BrowserWindow, net, protocol } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MEDIA_EXT } from '../shared/deck'
import type { createEngine } from './engine'

// Schwere Module (Engine, Agent, MCP, pptxgenjs, lucide …) erst nach dem Fenster laden: der Splash erscheint sofort,
// und der Renderer lädt parallel zum Main-Prozess. Die Preload-Brücke wiederholt Aufrufe, bis registerIpc steht.
const loadEngine = async () => (await import('./engine')).createEngine()

// macOS: aus dem Finder gestartete Apps erben den PATH der Shell nicht, claude/node/pdftotext wären sonst unauffindbar
if (process.platform === 'darwin') process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')].filter(Boolean).join(':')

// Kein Fenster navigiert weg oder öffnet neue (z. B. ein auf die Folie gezogener Link): fremde Seiten bekämen sonst die Preload-API
app.on('web-contents-created', (_, wc) => {
  wc.on('will-navigate', (e) => e.preventDefault())
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
})

protocol.registerSchemesAsPrivileged([{ scheme: 'asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }])

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
  const issues = await engine.lint(deck)
  for (const i of issues) console.log(`${i.severity === 'error' ? '✗' : '!'} Folie ${i.slide + 1} [${i.rule}] ${i.message}`)
  console.log(`${issues.filter((i) => i.severity === 'error').length} Fehler, ${issues.filter((i) => i.severity === 'warn').length} Warnungen`)
  for (const f of ['pptx', 'pdf', 'png'] as const) {
    const files = await engine.exportDeck(deck, f, outDir)
    console.log(`→ ${f}: ${files.length > 1 ? dirname(files[0]) : files[0]}`)
  }
}

app.whenReady().then(async () => {
  // CORS-Header, damit Canvas Pixel lesen darf (Video-Poster, Freisteller); stream + Range für Video/Audio
  protocol.handle('asset', async (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname)
    if (!MEDIA_EXT.test(file)) return new Response(null, { status: 403 })
    const res = await net.fetch(pathToFileURL(file).toString(), { headers: req.headers })
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: res.status, headers })
  })
  const argv = process.argv
  const at = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  const cli = argv.includes('--render') || argv.includes('--check')
  if (!cli && !argv.includes('--mcp')) {
    // Zweiter Klick aufs Symbol holt das offene Fenster nach vorn statt einer zweiten Instanz (CLI/MCP dürfen parallel laufen)
    if (!app.requestSingleInstanceLock()) return app.quit()
    const win = createWindow()
    app.on('second-instance', () => { if (win.isMinimized()) win.restore(); win.show(); win.focus() })
    const [engine, { registerIpc }] = await Promise.all([loadEngine(), import('./ipc')])
    return registerIpc(win, engine)
  }
  app.dock?.hide() // CLI/MCP: kein Dock-Symbol (macOS)
  const engine = await loadEngine()
  if (argv.includes('--mcp')) return (await import('./mcp')).startMcp(engine) // no window; stdout belongs to the MCP protocol
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
