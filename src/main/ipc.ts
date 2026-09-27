// IPC zwischen UI und Main: aktuelles Deck, Agent, Speichern/Öffnen, Export, API-Key.
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, screen, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Deck } from '../shared/deck'
import { DeckAgent, type AgentEvent, type Engine } from './agent'
import { ClaudeAgent, findClaude } from './claude-agent'
import { modelOf } from '../shared/models'
import { SOURCE_EXT, SOURCE_MAX, sourceText } from './source-text'
import { assetUrl, buildTools, STYLE_FILE } from './tools'

const HOME = join(homedir(), 'Deckwerk')

export function registerIpc(win: BrowserWindow, engine: Engine): void {
  const keyFile = join(app.getPath('userData'), 'api-key.bin')
  let deck: Deck | null = null
  let path: string | null = null // …/deck.json, null = noch nie gespeichert
  let agent: DeckAgent | ClaudeAgent | null = null
  const claude = findClaude() // ohne API-Key läuft der Chat über Claude Code (Abo-Login)

  const emit = (e: AgentEvent) => {
    if (e.type === 'deck') deck = e.deck
    if (!win.isDestroyed()) win.webContents.send('agent:event', e)
  }
  const apiKey = () => {
    try {
      if (existsSync(keyFile)) return safeStorage.decryptString(readFileSync(keyFile))
    } catch (e) {
      console.warn('[ipc] gespeicherter API-Key nicht lesbar:', e)
    }
    return process.env.ANTHROPIC_API_KEY
  }
  const state = () => ({ deck, path, hasKey: existsSync(keyFile) || !!process.env.ANTHROPIC_API_KEY || !!claude })
  const reset = (d: Deck | null, p: string | null) => {
    agent?.abort()
    agent = null // neues Deck = neues Gespräch
    deck = d
    path = p
  }
  const outDir = () => (path ? dirname(path) : join(HOME, 'out'))

  // electron . --open <deck.json>: startet direkt mit diesem Deck im Editor
  const arg = process.argv.indexOf('--open')
  if (arg >= 0 && process.argv[arg + 1]) {
    const file = resolve(process.argv[arg + 1])
    try {
      reset(readDeck(file), file)
    } catch (e) {
      console.error(`[ipc] --open ${file}:`, e instanceof Error ? e.message : e)
    }
  }

  ipcMain.handle('state', state)
  ipcMain.handle('deck:set', (_, d: Deck) => {
    deck = d
    agent?.setDeck(d)
  })
  ipcMain.handle('deck:new', () => reset(null, null))

  ipcMain.handle('deck:open', async () => {
    await mkdir(HOME, { recursive: true })
    const r = await dialog.showOpenDialog(win, { defaultPath: HOME, properties: ['openFile'], filters: [{ name: 'Deckwerk-Deck', extensions: ['json'] }] })
    const file = r.filePaths[0]
    if (r.canceled || !file) return null
    reset(readDeck(file), file)
    return state()
  })

  ipcMain.handle('deck:openPath', (_, file: string) => {
    reset(readDeck(resolve(file)), resolve(file))
    return state()
  })
  // zuletzt geänderte Decks unter ~/Deckwerk/*/deck.json, neueste zuerst
  ipcMain.handle('decks:recent', async (_, limit = 12) => {
    const dirs = await readdir(HOME, { withFileTypes: true }).catch(() => [])
    const found = await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => {
      const file = join(HOME, d.name, 'deck.json')
      try {
        const deck = readDeck(file)
        return { path: file, title: deck.title, mtime: (await stat(file)).mtimeMs, deck }
      } catch { return null }
    }))
    return found.filter((x) => x !== null).sort((a, b) => b.mtime - a.mtime).slice(0, limit)
  })

  ipcMain.handle('deck:save', async () => {
    if (!deck) throw new Error('Es gibt noch kein Deck zum Speichern.')
    path ??= join(await freeDir(deck.title), 'deck.json')
    await writeFile(path, JSON.stringify(deck, null, 2))
    return path
  })

  ipcMain.handle('deck:export', async (_, format: 'pptx' | 'pdf' | 'png' | 'md') => {
    if (!deck) throw new Error('Es gibt noch kein Deck zum Exportieren.')
    await mkdir(outDir(), { recursive: true })
    const [file] = await engine.exportDeck(deck, format, outDir())
    shell.showItemInFolder(file)
    return file
  })

  ipcMain.handle('agent:send', async (_, text: string, model?: string) => {
    const key = apiKey()
    const opts = { engine, onEvent: emit, apiKey: key, deck: deck ?? undefined, outDir: outDir() }
    agent ??= !key && claude ? new ClaudeAgent(claude, opts) : new DeckAgent(opts)
    agent.model = modelOf(model).id // unbekannt → Standardmodell
    await agent.send(text)
  })
  ipcMain.handle('agent:abort', () => agent?.abort())

  ipcMain.handle('key:set', async (_, key: string) => {
    if (!key.trim()) throw new Error('Der API-Key ist leer.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Keine sichere Schlüsselablage verfügbar. Setze stattdessen die Umgebungsvariable ANTHROPIC_API_KEY.')
    await mkdir(dirname(keyFile), { recursive: true })
    await writeFile(keyFile, safeStorage.encryptString(key.trim()))
    agent?.abort()
    agent = null // nächster send nutzt den neuen Key
  })

  ipcMain.handle('image:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }] })
    const file = r.filePaths[0]
    return r.canceled || !file ? null : `asset://local${pathToFileURL(file).pathname}`
  })

  const assets = join(HOME, 'assets')
  // Freisteller (nativ, siehe bg-remove.ts); Fortschritt des einmaligen Modell-Downloads als Ereignis
  ipcMain.handle('image:removeBg', async (_, src: string) => {
    if (!src.startsWith('asset://')) throw new Error('Nur eigene Bilddateien lassen sich freistellen')
    const file = decodeURIComponent(new URL(src).pathname)
    const { removeBackground } = await import('./bg-remove')
    const png = await removeBackground(file, join(HOME, 'models'), (pct) => !win.isDestroyed() && win.webContents.send('bg:progress', pct))
    await mkdir(assets, { recursive: true })
    const out = join(assets, `freigestellt-${Date.now()}.png`)
    await writeFile(out, png)
    return assetUrl(out)
  })
  ipcMain.handle('media:pick', async (_, kind: 'video' | 'audio') => {
    const extensions = kind === 'video' ? ['mp4', 'webm', 'mov', 'm4v'] : ['mp3', 'wav', 'm4a', 'ogg', 'aac']
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: kind === 'video' ? 'Videos' : 'Audio', extensions }] })
    const file = r.filePaths[0]
    return r.canceled || !file ? null : assetUrl(file)
  })
  // Quellmaterial für ein neues Deck; ohne Pfad per Dialog. null = abgebrochen
  ipcMain.handle('source:read', async (_, path?: string) => {
    if (!path) {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Dokumente', extensions: SOURCE_EXT }] })
      if (r.canceled || !r.filePaths[0]) return null
      path = r.filePaths[0]
    }
    const text = (await sourceText(path)).trim()
    if (!text) throw new Error('In der Datei steht kein lesbarer Text (gescanntes PDF?).')
    return { name: path.split('/').pop()!, text: text.slice(0, SOURCE_MAX), cut: text.length > SOURCE_MAX }
  })
  ipcMain.handle('style:open', async () => {
    await mkdir(HOME, { recursive: true })
    if (!existsSync(STYLE_FILE)) await writeFile(STYLE_FILE, '# Hausstil\n\n<!-- Gilt für jedes Deck. Eine Vorliebe pro Zeile; die KI ergänzt hier, wenn du „merk dir …“ sagst. -->\n')
    const err = await shell.openPath(STYLE_FILE)
    if (err) throw new Error(err)
  })
  // eigene Schrift: 1–2 TTF (Regular, Bold am Dateinamen erkannt); Familienname aus der name-Tabelle, damit PowerPoint sie zuordnet
  ipcMain.handle('font:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'TrueType-Schrift', extensions: ['ttf'] }] })
    if (r.canceled || !r.filePaths.length) return null
    const { fontFamilyOf } = await import('./embed-fonts')
    const bold = r.filePaths.find((f) => /bold/i.test(f)), regular = r.filePaths.find((f) => f !== bold) ?? bold!
    const family = fontFamilyOf(readFileSync(regular))
    if (!family) throw new Error('Keine gültige TrueType-Schrift')
    return { family, regular: assetUrl(regular), bold: bold && bold !== regular ? assetUrl(bold) : undefined }
  })
  // erzeugte Bilder (Video-Poster, Freisteller) als Datei unter ~/Deckwerk/assets ablegen
  ipcMain.handle('asset:save', async (_, dataUrl: string, name: string) => {
    const m = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/)
    if (!m) throw new Error('Nur PNG, JPEG oder WebP als data-URL')
    await mkdir(assets, { recursive: true })
    const file = join(assets, `${name.replace(/[^\w.-]+/g, '-').slice(0, 60)}-${Date.now()}.${m[1].replace('jpeg', 'jpg')}`)
    await writeFile(file, Buffer.from(m[2], 'base64'))
    return assetUrl(file)
  })
  ipcMain.handle('image:paste', async () => {
    // Electron 44: asynchrone Clipboard-API mit ClipboardItem/Blob wie im Web
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => /^image\/(png|jpeg|webp|gif)$/.test(t))
      if (!type) continue
      const blob = (await item.getType(type)) as Blob
      await mkdir(assets, { recursive: true })
      const file = join(assets, `eingefuegt-${Date.now()}.${type.split('/')[1].replace('jpeg', 'jpg')}`)
      await writeFile(file, Buffer.from(await blob.arrayBuffer()))
      return assetUrl(file)
    }
    return null
  })
  // dieselbe Suche wie das KI-Tool find_images; die asset://-Pfade stehen in dessen Textantwort
  ipcMain.handle('image:find', async (_, query: string) => {
    const find = buildTools({ engine, getDeck: () => deck, setDeck: () => {}, assetDir: assets, outDir: outDir(), unsplashKey: process.env.UNSPLASH_ACCESS_KEY }).find((t) => t.name === 'find_images')!
    const out = await find.run({ query: query || undefined, source: 'auto', limit: 5, orientation: 'landscape' })
    const urls = out.text.match(/asset:\/\/local\S+/g) ?? []
    return { urls, note: urls.length ? undefined : out.text }
  })

  // Kopie als eigenes Deck unter ~/Deckwerk/<titel>/deck.json speichern (Formate: Quadrat, Story …); das offene Deck bleibt
  ipcMain.handle('deck:saveCopy', async (_, copy: Deck) => {
    const file = join(await freeDir(copy.title), 'deck.json')
    await writeFile(file, JSON.stringify(copy, null, 2))
    return file
  })

  // Referentenansicht auf zwei Bildschirmen: Publikum im Vollbild auf dem anderen Display (index.html#audience),
  // der Referent steuert; Befehle (weiter/gehe zu) werden durchgereicht, beide Fenster laufen dieselbe Logik.
  let audience: BrowserWindow | null = null
  let show: { deck: Deck; start: number } | null = null
  ipcMain.handle('present:open', (_, d: Deck, start: number) => {
    const here = screen.getDisplayMatching(win.getBounds())
    const other = screen.getAllDisplays().find((x) => x.id !== here.id)
    if (!other) return false
    show = { deck: d, start }
    audience?.close()
    audience = new BrowserWindow({
      ...other.bounds, fullscreen: true, frame: false, backgroundColor: '#000000', title: 'Deckwerk – Präsentation',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false },
    })
    audience.on('closed', () => { audience = null; if (!win.isDestroyed()) win.webContents.send('present:ended') })
    if (process.env.ELECTRON_RENDERER_URL) audience.loadURL(`${process.env.ELECTRON_RENDERER_URL}#audience`)
    else audience.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'audience' })
    return true
  })
  ipcMain.handle('present:deck', () => show)
  ipcMain.handle('present:cmd', (_, cmd: unknown) => { audience?.webContents.send('present:cmd', cmd) })
  ipcMain.handle('present:close', () => { audience?.close() })

  // Einrichtung: KI-Zugang prüfen und Deckwerk als MCP-Server in Claude Code eintragen (User-Scope, alle Projekte).
  // Status aus ~/.claude.json lesen, weil `claude mcp get` den Server testweise startet und dafür zu lange braucht.
  // Start-Befehl für Claude Code: das Skript im Projekt (baut bei Bedarf neu), sonst Electron direkt mit dem App-Ordner
  // (z. B. wenn die App aus einer Kopie ohne scripts/ läuft). x11: printToPDF hängt unter Wayland.
  const script = join(app.getAppPath(), 'scripts', 'deckwerk.sh')
  const mcpCmd = existsSync(script) ? { command: script, args: ['--mcp'] } : { command: process.execPath, args: [app.getAppPath(), '--ozone-platform=x11', '--mcp'] }
  ipcMain.handle('setup:status', () => {
    let mcp = false
    try { mcp = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')).mcpServers?.deckwerk?.command === mcpCmd.command } catch { /* keine Datei = nicht eingerichtet */ }
    return { claude: !!claude, key: existsSync(keyFile) || !!process.env.ANTHROPIC_API_KEY, mcp }
  })
  ipcMain.handle('setup:mcp', async () => {
    if (!claude) throw new Error('Claude Code ist nicht installiert.')
    const run = (args: string[]) => new Promise<void>((ok, fail) =>
      execFile(claude, args, { timeout: 60_000 }, (e, _out, err) => (e ? fail(new Error(err.trim() || e.message)) : ok())))
    await run(['mcp', 'remove', '-s', 'user', 'deckwerk']).catch(() => {}) // alter Eintrag mit anderem Pfad
    await run(['mcp', 'add', '-s', 'user', 'deckwerk', '--', mcpCmd.command, ...mcpCmd.args])
  })
  // Verbindung testen wie Claude Code: Server per stdio starten, initialize + tools/list, Anzahl der Werkzeuge zurück
  ipcMain.handle('setup:mcpTest', () => new Promise<number>((ok, fail) => {
    const p = spawn(mcpCmd.command, mcpCmd.args, { stdio: ['pipe', 'pipe', 'ignore'] })
    const done = (e: Error | null, n = 0) => { clearTimeout(timer); p.kill(); e ? fail(e) : ok(n) }
    const timer = setTimeout(() => done(new Error('Der Server hat nicht innerhalb von 30 Sekunden geantwortet. Einmal „npm run build“ ausführen oder die App neu starten.')), 30_000)
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        const msg = (() => { try { return JSON.parse(buf.slice(0, i)) } catch { return null } })()
        if (msg?.id === 1) {
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
        } else if (msg?.id === 2) done(null, msg.result?.tools?.length ?? 0)
      }
    })
    p.on('error', (e) => done(e))
    p.on('exit', (code) => done(new Error(`Der Server ist beendet (Code ${code}).`)))
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deckwerk-setup', version: '1' } } }) + '\n')
  }))
}

function readDeck(file: string): Deck {
  const d = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(d?.slides) || !d.theme) throw new Error('Das ist keine gültige deck.json.')
  return d
}

// ~/Deckwerk/<titel-slug>, bei Kollision mit -2, -3 …
async function freeDir(title: string): Promise<string> {
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deck'
  let dir = join(HOME, slug)
  for (let i = 2; existsSync(dir); i++) dir = join(HOME, `${slug}-${i}`)
  await mkdir(dir, { recursive: true })
  return dir
}
