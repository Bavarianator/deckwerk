// IPC zwischen UI und Main: aktuelles Deck, Agent, Speichern/Öffnen, Export, API-Key.
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, screen, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Deck } from '../shared/deck'
import { DeckAgent, type AgentEvent, type Engine } from './agent'
import { ClaudeAgent, findClaude } from './claude-agent'
import { modelOf } from '../shared/models'
import { setRemoteState, startRemote, stopRemote, type RemoteState } from './remote'
import { SOURCE_EXT, SOURCE_MAX, sourceText } from './source-text'
import { assetUrl, buildTools, localizeDeck, STYLE_FILE } from './tools'

const HOME = join(homedir(), 'Deckwerk')

// Versionen (Canva „Versionsverlauf“): vor dem Überschreiben den alten Stand nach <deck>/versions/<zeit>.json,
// höchstens alle 10 min (force: immer), weil der Autosave alle paar Sekunden speichert; die ältesten ab 100 fallen weg.
async function snapshot(file: string, force = false) {
  if (!existsSync(file)) return
  const dir = join(dirname(file), 'versions')
  const all = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort()
  if (!force && all.length && Date.now() - (await stat(join(dir, all.at(-1)!))).mtimeMs < 600_000) return
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${new Date().toLocaleString('sv').replace(' ', 'T').replace(/:/g, '-')}.json`), await readFile(file))
  for (const old of all.slice(0, Math.max(0, all.length + 1 - 100))) await rm(join(dir, old), { force: true })
}

// Zurück zu einer Version: eine Datei aus <deck>/versions/ öffnen macht sie wieder zum Deck; der bisherige Stand
// wandert vorher selbst in die Versionen. Andere Dateien bleiben, wie sie sind.
async function restore(file: string): Promise<string> {
  const main = join(dirname(dirname(file)), 'deck.json')
  if (basename(dirname(file)) !== 'versions' || !existsSync(main)) return file
  const json = await readFile(file)
  await snapshot(main, true)
  await writeFile(main, json)
  return main
}

export function registerIpc(win: BrowserWindow, engine: Engine): void {
  const keyFile = join(app.getPath('userData'), 'api-key.bin')
  // Einrichtung erledigt: Datei statt localStorage, das bei hartem Beenden oder mehreren Instanzen verloren geht
  const setupFile = join(app.getPath('userData'), 'setup-done')
  let deck: Deck | null = null
  let path: string | null = null // …/deck.json, null = noch nie gespeichert
  let dirty = false // Änderungen (UI oder KI) seit dem letzten Speichern
  let agent: DeckAgent | ClaudeAgent | null = null
  const claude = findClaude() // ohne API-Key läuft der Chat über Claude Code (Abo-Login)

  const emit = (e: AgentEvent) => {
    if (e.type === 'deck') { deck = e.deck; dirty = true }
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
  const state = () => ({ deck, path, hasKey: existsSync(keyFile) || !!process.env.ANTHROPIC_API_KEY || !!claude, setupDone: existsSync(setupFile) })
  // Auto-Speichern: der Renderer speichert 1,5 s nach jeder Änderung. Was in diesem Fenster noch offen ist, sichert
  // flush() synchron, bevor ein anderes Deck geladen oder das Fenster geschlossen wird.
  const flush = () => {
    if (!dirty || !deck) return
    path ??= join(freeDir(deck.title), 'deck.json')
    writeFileSync(path, JSON.stringify(deck, null, 2))
    dirty = false
  }
  win.on('closed', () => {
    try { flush() } catch (e) { console.error('[ipc] Speichern beim Schließen fehlgeschlagen:', e) }
  })
  const reset = (d: Deck | null, p: string | null) => {
    flush()
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
    dirty = true
    agent?.setDeck(d)
  })
  ipcMain.handle('deck:new', () => reset(null, null))

  ipcMain.handle('deck:open', async () => {
    await mkdir(HOME, { recursive: true })
    const r = await dialog.showOpenDialog(win, { defaultPath: HOME, properties: ['openFile'], filters: [{ name: 'Deckwerk-Deck', extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    readDeck(r.filePaths[0]) // keine gültige deck.json → Fehler, bevor restore() etwas überschreibt
    flush() // offene Änderungen zuerst, sonst überschriebe reset() eine gerade wiederhergestellte Version
    const file = await restore(r.filePaths[0])
    reset(readDeck(file), file)
    return state()
  })

  ipcMain.handle('deck:openPath', async (_, f: string) => {
    readDeck(resolve(f))
    flush()
    const file = await restore(resolve(f))
    reset(readDeck(file), file)
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
    path ??= join(freeDir(deck.title), 'deck.json')
    await snapshot(path)
    const json = JSON.stringify(deck, null, 2)
    dirty = false // vor dem Schreiben: eine Änderung, die währenddessen kommt, bleibt markiert
    await writeFile(path, json)
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
    const text = (await sourceText(path, join(HOME, 'assets'))).trim()
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
  // Vorlagen-Galerie (Canva „Vorlagen“): kuratierte Decks aus examples/, Bildpfade aufgelöst; geöffnet wird immer eine Kopie
  ipcMain.handle('templates:list', () =>
    ['foto', 'canva-look', 'quartal', 'strategie'].flatMap((name) => {
      const file = join(app.getAppPath(), 'examples', `${name}.json`)
      try { return [readDeck(file)] } catch { return [] }
    }))
  ipcMain.handle('deck:saveCopy', async (_, copy: Deck) => {
    const file = join(freeDir(copy.title), 'deck.json')
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
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true },
    })
    audience.on('closed', () => { audience = null; if (!win.isDestroyed()) win.webContents.send('present:ended') })
    if (process.env.ELECTRON_RENDERER_URL) audience.loadURL(`${process.env.ELECTRON_RENDERER_URL}#audience`)
    else audience.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'audience' })
    return true
  })
  ipcMain.handle('present:deck', () => show)
  ipcMain.handle('present:cmd', (_, cmd: unknown) => { audience?.webContents.send('present:cmd', cmd) })
  ipcMain.handle('present:close', () => { audience?.close() })
  // Handy als Fernbedienung: Befehle gehen an die Referentenansicht, die sie wie Tastendrücke behandelt
  ipcMain.handle('remote:start', () => startRemote((c) => { if (!win.isDestroyed()) win.webContents.send('present:remote', c) }))
  ipcMain.handle('remote:stop', () => stopRemote())
  ipcMain.handle('remote:state', (_, s: RemoteState) => setRemoteState(s))

  // Einrichtung: KI-Zugang prüfen und Deckwerk als MCP-Server in Claude Code eintragen (User-Scope, alle Projekte).
  // Status aus ~/.claude.json lesen, weil `claude mcp get` den Server testweise startet und dafür zu lange braucht.
  // Start-Befehl für Claude Code: das Skript im Projekt (baut bei Bedarf neu), sonst Electron direkt mit dem App-Ordner
  // (z. B. wenn die App aus einer Kopie ohne scripts/ läuft); gepackte App (macOS): das Programm selbst, ohne app.asar-Pfad.
  // x11: printToPDF hängt unter Wayland.
  const script = join(app.getAppPath(), 'scripts', 'deckwerk.sh')
  const mcpCmd = app.isPackaged ? { command: process.execPath, args: ['--mcp'] }
    : existsSync(script) ? { command: script, args: ['--mcp'] }
    : { command: process.execPath, args: [app.getAppPath(), ...(process.platform === 'linux' ? ['--ozone-platform=x11'] : []), '--mcp'] }
  ipcMain.handle('setup:done', () => writeFile(setupFile, ''))
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
  return localizeDeck(d, dirname(file)) // relative Bildpfade (Deck-Ordner mit assets/ weitergegeben) auflösen
}

// ~/Deckwerk/<titel-slug>, bei Kollision mit -2, -3 …
function freeDir(title: string): string {
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deck'
  let dir = join(HOME, slug)
  for (let i = 2; existsSync(dir); i++) dir = join(HOME, `${slug}-${i}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
