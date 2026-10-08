// IPC zwischen UI und Main: aktuelles Deck, Agent, Speichern/Öffnen, Export, API-Key.
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, screen, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PRINT_SIZES, type BrandKit, type Deck, type PrintOptions } from '../shared/deck'
import { DeckAgent, type AgentEvent, type Engine, type ExportFormat } from './agent'
import { CLI_NAME, CLIS, CliAgent, findCli, type Cli } from './claude-agent'
import { AUTO, autoPick, modelOf, routeOf, type ChatModels } from '../shared/models'
import { setRemoteState, startRemote, stopRemote, type RemoteState } from './remote'
import { SOURCE_EXT, SOURCE_MAX, sourceText } from './source-text'
import { assetUrl, BRAND_FILE, buildTools, defaultBrand, IMAGE_SIZE, IMG_FILE, localizeDeck, makeImage, NO_IMAGE_AI, saveBrand, STYLE_FILE, type Orientation } from './tools'
import { APP_DIR, checkUpdate, installUpdate } from './update'
import { imageStatus, loadImageSettings, saveImageSettings } from './image-settings'
import { createSyncer, isFolder, localAsset, testSync, type SyncSettings } from './sync'
import { checkSyncFolder, findFolder, syncFetchFor } from './sync-folder'
import { CLOUDS } from '../shared/clouds'
import { cliLogin, cliLogout, cliStatus, nextcloudLogin, setVibeKey, vibeKey, type LoginCli } from './accounts'

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
  // Einrichtung erledigt: einmal pro Rechner, nicht pro Chromium-Profil. userData wechselt zwischen Entwicklung (deckwerk),
  // installierter App (Deckwerk) und jedem Lauf mit --user-data-dir; dort kam der Assistent sonst jedes Mal neu.
  const setupFile = join(app.getPath('appData'), 'deckwerk', 'setup-done')
  const setupDone = () => existsSync(setupFile) || existsSync(join(app.getPath('userData'), 'setup-done')) // alte Markierung im Profil
  let deck: Deck | null = null
  let path: string | null = null // …/deck.json, null = noch nie gespeichert
  let dirty = false // Änderungen (UI oder KI) seit dem letzten Speichern
  let agent: DeckAgent | CliAgent | null = null
  let agentKind: 'api' | Cli | null = null // wechselt die Modellwahl den Weg, beginnt ein neues Gespräch
  // Agenten-CLIs mit dem Login des Nutzers (Claude Code, Codex, Vibe). Welches der Chat nutzt, entscheidet das Modell-Dropdown.
  const clis = {} as Record<Cli, string | null>
  const detect = () => { for (const c of CLIS) clis[c] = findCli(c) } // erneut in Einrichtung und Modell-Liste: frisch Installiertes zählt sofort
  detect()
  const hasApiKey = () => existsSync(keyFile) || !!process.env.ANTHROPIC_API_KEY
  loadImageSettings()

  // Cloud-Sync (WebDAV): Zugang verschlüsselt unter appData/deckwerk wie image-settings.bin; Lauf beim Start und 5 s nach dem Speichern
  const syncFile = join(app.getPath('appData'), 'deckwerk', 'sync.bin')
  let syncCfg: SyncSettings | null = null
  try { if (existsSync(syncFile)) syncCfg = JSON.parse(safeStorage.decryptString(readFileSync(syncFile))) } catch (e) { console.warn('[sync] Zugang nicht lesbar:', e) }
  // Hat der Sync das offene Deck überschrieben, neu laden. ponytail: mit ungesicherten Änderungen gewinnt die lokale Fassung beim nächsten Speichern
  const syncChanged = (files: string[]) => {
    if (!path || dirty || !files.includes(path) || !existsSync(path)) return
    try { deck = readDeck(path); agent?.setDeck(deck); if (!win.isDestroyed()) win.webContents.send('deck:synced', deck) } catch (e) { console.warn('[sync] Deck neu laden:', e) }
  }
  const syncFetch = syncFetchFor(HOME) // Ordner-Ziele nie in HOME, auch wenn der Ordner später per Link dorthin zeigt
  const syncer = createSyncer(HOME, () => syncCfg, (st) => { if (!win.isDestroyed()) win.webContents.send('sync:status', st) }, syncChanged, syncFetch)
  syncer.later(3000)
  // Änderungen anderer Geräte bzw. des MCP-Prozesses: beim Zurückkehren ins Fenster und alle 5 Minuten abholen
  win.on('focus', () => syncer.later(1000))
  const syncTick = setInterval(() => syncer.later(0), 5 * 60_000)
  win.on('closed', () => clearInterval(syncTick))

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
  const state = () => ({ deck, path, hasKey: hasApiKey() || CLIS.some((c) => !!clis[c]), setupDone: setupDone() })
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

  // Deck aus der Kommandozeile: --open <datei> oder eine .json-Datei als Argument (Doppelklick im Dateimanager, %f im
  // Startmenü-Eintrag). Beim Start sofort; läuft die App schon, kommt es über second-instance ins offene Fenster.
  const deckArg = (argv: string[], cwd = process.cwd()) => {
    const i = argv.indexOf('--open')
    const f = i >= 0 ? argv[i + 1] : argv.slice(1).find((a) => !a.startsWith('-') && a.endsWith('.json'))
    return f ? resolve(cwd, f) : null
  }
  const first = deckArg(process.argv)
  if (first) {
    try {
      reset(readDeck(first), first)
    } catch (e) {
      console.error(`[ipc] --open ${first}:`, e instanceof Error ? e.message : e)
    }
  }
  app.on('second-instance', async (_, argv, cwd) => {
    const f = deckArg(argv, cwd)
    if (!f) return
    try {
      readDeck(f) // ungültig → nichts anfassen
      flush()
      const file = await restore(f)
      reset(readDeck(file), file)
      if (!win.isDestroyed()) win.webContents.send('deck:opened', state())
    } catch (e) {
      console.error(`[ipc] Öffnen von außen ${f}:`, e instanceof Error ? e.message : e)
    }
  })

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
    // atomar über eine Punktdatei (vom Sync ausgenommen): ein gleichzeitiger Cloud-Abgleich liest nie eine halbe deck.json
    await writeFile(`${dirname(path)}/.deck.json.part`, json)
    await rename(`${dirname(path)}/.deck.json.part`, path)
    syncer.later()
    return path
  })

  ipcMain.handle('deck:export', async (_, format: ExportFormat, printIn?: PrintOptions) => {
    if (!deck) throw new Error('Es gibt noch kein Deck zum Exportieren.')
    // Vertrauensgrenze: print kommt aus dem Renderer, nur bekannte Größe und Beschnitt 0–5 mm durchlassen
    const size = typeof printIn?.size === 'string' && Object.hasOwn(PRINT_SIZES, printIn.size) ? printIn.size : undefined
    const bleed = typeof printIn?.bleed === 'number' && Number.isFinite(printIn.bleed) ? Math.min(5, Math.max(0, printIn.bleed)) : undefined
    const print: PrintOptions = { size, bleed }
    await mkdir(outDir(), { recursive: true })
    const [file] = await engine.exportDeck(deck, format, outDir(), print)
    shell.showItemInFolder(file)
    return file
  })

  ipcMain.handle('agent:send', async (_, text: string, model?: string) => {
    const key = apiKey()
    const r = routeOf(model)
    // Weg aus der Modellwahl: Vibe oder Codex, sonst Claude über den API-Key (hat Vorrang) oder Claude Code
    const kind: 'api' | Cli = r ? r.cli : key || !clis.claude ? 'api' : 'claude'
    if (kind !== 'api' && !clis[kind]) throw new Error(`${CLI_NAME[kind]} ist nicht installiert. Ein anderes Modell wählen oder in der Einrichtung nachsehen.`)
    if (agent && agentKind !== kind) { agent.abort(); agent = null } // anderer Weg = neues Gespräch, das Deck bleibt
    const opts = { engine, onEvent: emit, apiKey: key, deck: deck ?? undefined, outDir: outDir() }
    agent ??= kind === 'api' ? new DeckAgent(opts) : new CliAgent(kind, clis[kind]!, opts)
    agentKind = kind
    const auto = !r && model === AUTO ? autoPick(text, !!deck?.slides.length) : null
    agent.model = r ? r.model : auto?.model ?? modelOf(model).id // unbekannte Claude-ID → Standardmodell
    agent.effort = auto?.effort ?? 'high'
    if (auto) emit({ type: 'tool', name: 'auto_model', status: 'done', summary: `${modelOf(auto.model).name} (${auto.why})` })
    await agent.send(text)
  })
  ipcMain.handle('agent:abort', () => agent?.abort())

  // Prüft den Key vorher bei Anthropic (GET /v1/models kostet nichts). Ohne Netz wird er ungeprüft gespeichert.
  ipcMain.handle('key:set', async (_, key: string): Promise<'geprüft' | 'ungeprüft'> => {
    key = key.trim()
    if (!key) throw new Error('Der API-Schlüssel ist leer.')
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Keine sichere Schlüsselablage verfügbar. Setze stattdessen die Umgebungsvariable ANTHROPIC_API_KEY.')
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000) }).catch(() => null)
    if (r?.status === 401) throw new Error(`Diesen Schlüssel kennt Anthropic nicht. Kopier ihn noch einmal vollständig${key.startsWith('sk-ant-') ? '' : ', er beginnt mit „sk-ant-“'}.`)
    if (r?.status === 403) throw new Error('Anthropic lehnt den Schlüssel ab. Prüf in der Anthropic-Konsole, ob dein Konto freigeschaltet ist.')
    await mkdir(dirname(keyFile), { recursive: true })
    await writeFile(keyFile, safeStorage.encryptString(key))
    agent?.abort()
    agent = null // nächster send nutzt den neuen Key
    return r?.ok ? 'geprüft' : 'ungeprüft'
  })
  ipcMain.handle('key:clear', async () => {
    await rm(keyFile, { force: true })
    agent?.abort()
    agent = null
  })
  // Hilfe-Links der Einrichtung öffnen im Browser; nur diese Ziele, der Renderer kann keine beliebige Adresse öffnen
  const HILFE = {
    'api-keys': 'https://platform.claude.com/settings/keys', claude: 'https://code.claude.com/docs/en/setup', node: 'https://nodejs.org/',
    mistral: 'https://console.mistral.ai/api-keys', openai: 'https://platform.openai.com/api-keys', unsplash: 'https://unsplash.com/oauth/applications',
  }
  ipcMain.handle('hilfe:open', (_, id: string) => {
    if (!Object.hasOwn(HILFE, id)) throw new Error(`Unbekannter Link: ${id}`)
    return shell.openExternal(HILFE[id as keyof typeof HILFE])
  })

  // KI-Bilder (Einstellungen → Bilder): Keys bleiben im Main-Prozess, generate_image liest sie beim Aufruf
  ipcMain.handle('imageSettings:get', () => imageStatus())
  ipcMain.handle('imageSettings:set', (_, patch: unknown) => saveImageSettings(patch))

  ipcMain.handle('sync:get', () => syncer.status())
  ipcMain.handle('sync:run', () => syncer.run())
  ipcMain.handle('sync:test', (_, s: SyncSettings) => testSync(s))
  const saveSync = async (s: SyncSettings | null) => {
    const sent = () => { if (!win.isDestroyed()) win.webContents.send('sync:status', syncer.status()) } // auch die Wolke in der Kopfleiste
    if (!s) { syncCfg = null; await rm(syncFile, { force: true }); sent(); return syncer.status() }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Keine sichere Schlüsselablage verfügbar, das Passwort kann nicht gespeichert werden.')
    const url = String(s.url).trim(), user = String(s.user).trim()
    // gespeichertes Passwort nur für denselben Zugang, nie an eine neue Adresse
    const next = { url, user, pass: String(s.pass) || (syncCfg?.url === url && syncCfg.user === user ? syncCfg.pass : '') }
    // Ordner-Zugang (Dropbox & Co.) ohne Nutzer und Passwort; geprüft auch hier, weil sync:set file:-Adressen durchreicht
    if (isFolder(url)) {
      let dir: string
      try { dir = fileURLToPath(url) } catch { throw new Error('Diesen Ordner kann Deckwerk nicht nutzen: Die Adresse ist ungültig.') }
      await checkSyncFolder(dir, HOME)
    } else if (!next.url || !next.user || !next.pass) throw new Error('Adresse, Nutzername und App-Passwort ausfüllen.')
    await testSync(next, syncFetch)
    syncCfg = next
    await mkdir(dirname(syncFile), { recursive: true })
    await writeFile(syncFile, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 })
    sent()
    return syncer.run()
  }
  ipcMain.handle('sync:set', (_, s: SyncSettings | null) => saveSync(s))
  // Cloud über den Sync-Ordner einer Desktop-App: Deckwerk spiegelt nach <ordner>/Deckwerk, die App lädt hoch
  ipcMain.handle('sync:folder', (_, dir: unknown) => {
    if (typeof dir !== 'string' || !dir.trim() || !isAbsolute(dir)) throw new Error('Diesen Ordner kann Deckwerk nicht nutzen: Bitte einen Ordner auswählen.')
    return saveSync({ url: pathToFileURL(dir).href, user: '', pass: '' })
  })
  ipcMain.handle('cloud:folders', async () => {
    const found: { id: string; path: string }[] = []
    for (const c of CLOUDS) for (const f of c.folders ?? []) {
      const path = await findFolder(f)
      if (path) { found.push({ id: c.id, path }); break }
    }
    return found
  })
  ipcMain.handle('cloud:pickFolder', async (_, start?: unknown) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: typeof start === 'string' && existsSync(start) ? start : undefined })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  // nur Links aus CLOUDS und nur https: der Renderer kann keine beliebige Adresse öffnen
  ipcMain.handle('cloud:help', (_, id: unknown) => {
    const help = CLOUDS.find((c) => c.id === id)?.help
    if (!help?.startsWith('https://')) throw new Error('Für diesen Anbieter gibt es keine Hilfeseite.')
    return shell.openExternal(help)
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
    const file = localAsset(decodeURIComponent(new URL(src).pathname))
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
  // Quellmaterial (mehrere Dateien, auch Bilder); ohne Pfade per Dialog. null = abgebrochen
  ipcMain.handle('source:read', async (_, paths?: string[]) => {
    if (!paths?.length) {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Dokumente und Bilder', extensions: SOURCE_EXT }] })
      if (r.canceled || !r.filePaths.length) return null
      paths = r.filePaths
    }
    const srcs: { name: string; text: string; cut: boolean }[] = []
    const errors: string[] = []
    for (const path of paths) {
      const name = path.split('/').pop()!
      try {
        const text = (await sourceText(path, join(HOME, 'assets'))).trim()
        if (!text) throw new Error('In der Datei steht kein lesbarer Text (gescanntes PDF?).')
        // an der Zeilengrenze kürzen, damit keine „Bild: asset://…“-Zeile mitten im Pfad abreißt
        srcs.push({ name, text: text.length > SOURCE_MAX ? text.slice(0, SOURCE_MAX).replace(/\n[^\n]*$/, '') : text, cut: text.length > SOURCE_MAX })
      } catch (e) {
        errors.push(`${name}: ${(e as Error).message}`)
      }
    }
    return { srcs, errors }
  })
  ipcMain.handle('brand:get', () => defaultBrand() ?? null)
  ipcMain.handle('brand:set', (_e, b: BrandKit) => saveBrand(b))
  ipcMain.handle('brand:clear', () => rm(BRAND_FILE, { force: true }))
  ipcMain.handle('style:get', () => readFile(STYLE_FILE, 'utf8').catch(() => ''))
  ipcMain.handle('style:set', async (_, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Ungültiger Hausstil.')
    if (text.length > 20_000) throw new Error('Der Hausstil ist zu lang (höchstens 20 000 Zeichen).')
    await mkdir(dirname(STYLE_FILE), { recursive: true })
    await writeFile(STYLE_FILE, text)
  })
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: `${process.platform} ${process.arch}`, home: HOME,
  }))
  ipcMain.handle('update:check', () => checkUpdate(app.getVersion()))
  ipcMain.handle('update:install', async () => {
    if (!(await checkUpdate(app.getVersion())).canInstall) throw new Error('Diese Installation aktualisiert sich nicht selbst. Im Terminal: deckwerk update')
    await installUpdate()
    // das alte Verzeichnis ist ersetzt: neu starten, auch wenn die Fenster noch Dateien daraus halten
    app.relaunch({ execPath: join(APP_DIR, 'AppRun'), args: process.argv.slice(1) })
    app.exit(0)
  })
  ipcMain.handle('app:openHome', async () => {
    await mkdir(HOME, { recursive: true })
    const err = await shell.openPath(HOME)
    if (err) throw new Error(err)
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
    const find = buildTools({ engine, getDeck: () => deck, setDeck: () => {}, assetDir: assets, outDir: outDir(), unsplashKey: process.env.UNSPLASH_ACCESS_KEY, previews: false }).find((t) => t.name === 'find_images')!
    const out = await find.run({ query: query || undefined, source: 'auto', limit: 5, orientation: 'landscape' })
    const urls = out.text.match(/asset:\/\/local\S+/g) ?? []
    return { urls, note: urls.length ? undefined : out.text }
  })
  // Einfügen-Panel (Canva „Magic Media“): dieselbe Bild-KI wie generate_image, Datei landet unter ~/Deckwerk/assets
  let generating = false
  ipcMain.handle('image:generate', async (_, prompt: unknown, orientation: unknown) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000) throw new Error('Bitte das Bild beschreiben (höchstens 2000 Zeichen).')
    if (typeof orientation !== 'string' || !Object.hasOwn(IMAGE_SIZE, orientation)) throw new Error(`Unbekanntes Format: ${orientation}`)
    // eine Erzeugung zur Zeit aus dem Panel: jeder Aufruf kostet beim Anbieter Geld
    if (generating) throw new Error('Es wird schon ein Bild erzeugt. Bitte kurz warten.')
    generating = true
    try {
      const img = await makeImage(prompt.trim(), orientation as Orientation, assets)
      if (!img) throw new Error(NO_IMAGE_AI)
      return assetUrl(img.file)
    } finally { generating = false }
  })
  // „Deine Bilder“ (Canva „Uploads“): die neuesten Bilder unter ~/Deckwerk/assets, auch aus Unterordnern wie import-*
  ipcMain.handle('assets:list', async () => {
    const files = (await readdir(assets, { recursive: true }).catch(() => [] as string[])).filter((f) => IMG_FILE.test(f))
    const found = await Promise.all(files.map(async (f) => {
      const st = await stat(join(assets, f)).catch(() => null)
      return st?.isFile() ? [{ url: assetUrl(join(assets, f)), name: basename(f), mtime: st.mtimeMs }] : []
    }))
    return found.flat().sort((a, b) => b.mtime - a.mtime).slice(0, 60)
  })

  // Kopie als eigenes Deck unter ~/Deckwerk/<titel>/deck.json speichern (Formate: Quadrat, Story …); das offene Deck bleibt
  // Vorlagen-Galerie (Canva „Vorlagen“): kuratierte Decks aus examples/, Bildpfade aufgelöst; geöffnet wird immer eine Kopie
  ipcMain.handle('templates:list', () =>
    ['foto', 'canva-look', 'quartal', 'strategie', 'flyer'].flatMap((name) => {
      const file = join(app.getAppPath(), 'examples', `${name}.json`)
      try { return [readDeck(file)] } catch { return [] }
    }))
  ipcMain.handle('deck:saveCopy', async (_, copy: Deck) => {
    const file = join(freeDir(copy.title), 'deck.json')
    await writeFile(file, JSON.stringify(copy, null, 2))
    return file
  })
  // Versionsverlauf: die Stände aus snapshot() des offenen Decks, neueste zuerst; wiederhergestellt wird über deck:openPath (restore())
  const versionsDir = () => (path ? join(dirname(path), 'versions') : null)
  ipcMain.handle('versions:list', async () => {
    const dir = versionsDir()
    if (!dir) return []
    const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.json'))
    const found = await Promise.all(names.map(async (name) => {
      const file = join(dir, name)
      try {
        const d = readDeck(file)
        // Dateiname aus snapshot(): Ortszeit „2026-10-07T14-03-05“; fremde Namen → mtime
        const m = name.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/)
        const at = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : (await stat(file)).mtimeMs
        return { file, at, slides: d.slides.length, title: d.title }
      } catch { return null }
    }))
    return found.filter((x) => x !== null).sort((a, b) => b.at - a.at)
  })
  // Vertrauensgrenze: der Pfad kommt aus dem Renderer und muss genau im versions-Ordner des offenen Decks liegen
  ipcMain.handle('versions:read', async (_, f: string) => {
    const dir = versionsDir()
    const real = dir && typeof f === 'string' ? await realpath(f).catch(() => null) : null
    if (!dir || !real || !real.endsWith('.json') || dirname(real) !== (await realpath(dir).catch(() => null))) throw new Error('Diese Version gehört nicht zum offenen Deck.')
    return readDeck(real, dirname(dirname(real))) // Bildpfade relativ zum Deck-Ordner wie nach dem Wiederherstellen
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

  // Einrichtung: KI-Zugang prüfen und Deckwerk als MCP-Server in Claude Code, Codex und Vibe eintragen (für alle Projekte).
  // Status aus deren Konfigurationsdateien lesen, weil z. B. `claude mcp get` den Server testweise startet und zu lange braucht.
  // Start-Befehl für die Agenten: das Skript im Projekt (baut bei Bedarf neu), sonst Electron direkt mit dem App-Ordner
  // (z. B. wenn die App aus einer Kopie ohne scripts/ läuft); gepackte App (macOS): das Programm selbst, ohne app.asar-Pfad.
  // x11: printToPDF hängt unter Wayland.
  const script = join(app.getAppPath(), 'scripts', 'deckwerk.sh')
  // Linux-Paket: als AppImage liegt process.execPath in einem temporären Mount, deshalb $APPIMAGE; entpackt (install.sh)
  // AppRun, das die Sandbox nur ohne User-Namespaces abschaltet. Die Plattform-Flags wählt ein sh-Aufruf beim Start
  // (Vibe und Codex starten ohne DISPLAY, dann headless); derselbe Aufruf steht in scripts/install.sh.
  const appRun = join(dirname(process.execPath), 'AppRun')
  const pkgCmd = process.platform === 'linux'
    ? { command: '/bin/sh', args: ['-c', 'if [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then exec "$0" --ozone-platform=x11 --mcp; else exec "$0" --ozone-platform=headless --disable-gpu --mcp; fi', process.env.APPIMAGE ?? (existsSync(appRun) ? appRun : process.execPath)] }
    : { command: process.execPath, args: ['--mcp'] }
  const mcpCmd = app.isPackaged ? pkgCmd
    : existsSync(script) ? { command: script, args: ['--mcp'] }
    // Vibe und Codex starten den Server ohne DISPLAY: unter Linux headless statt x11 (x11 bräche dann ab)
    : { command: process.execPath, args: [app.getAppPath(), ...(process.platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu'] : []), '--mcp'] }
  ipcMain.handle('setup:done', async () => { await mkdir(dirname(setupFile), { recursive: true }); await writeFile(setupFile, '') })
  const config: Record<Cli, string> = {
    claude: join(homedir(), '.claude.json'),
    codex: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'),
    vibe: join(process.env.VIBE_HOME ?? join(homedir(), '.vibe'), 'config.toml'),
  }
  // Skill (skills/deckwerk/SKILL.md) für Claude Code und Codex, beide lesen dasselbe Format; Vibe kennt keine Skills.
  // Eingerichtet heißt dort: MCP-Eintrag und Skill in genau der Fassung dieser App (nach Updates erneut einrichten)
  const skillFile = (cli: Cli) => cli === 'vibe' ? null : join(cli === 'claude' ? join(homedir(), '.claude') : dirname(config.codex), 'skills', 'deckwerk', 'SKILL.md')
  const skill = () => readFileSync(join(app.getAppPath(), 'skills', 'deckwerk', 'SKILL.md'), 'utf8')
  const skillOk = (cli: Cli) => { const f = skillFile(cli); try { return !f || readFileSync(f, 'utf8') === skill() } catch { return false } }
  // Eingetragen heißt: ein deckwerk-Eintrag mit genau unserem Start-Befehl samt letztem Argument (ein alter Pfad zählt
  // nicht; beim AppImage ist der Befehl immer /bin/sh, der Pfad steht im letzten Argument)
  const registered = (cli: Cli): boolean => {
    try {
      const text = readFileSync(config[cli], 'utf8')
      if (cli === 'claude') {
        const e = JSON.parse(text).mcpServers?.deckwerk
        return e?.command === mcpCmd.command && JSON.stringify(e.args ?? []) === JSON.stringify(mcpCmd.args)
      }
      const sec = tomlSection(text, cli === 'codex' ? '[mcp_servers.deckwerk]\n' : '[[mcp_servers]]\nname = "deckwerk"\n')
      return sec.includes(`command = ${JSON.stringify(mcpCmd.command)}`) && sec.includes(JSON.stringify(mcpCmd.args.at(-1)))
    } catch { return false } // keine Datei = nicht eingerichtet
  }
  const cliArg = (cli: unknown): Cli => {
    if (!CLIS.includes(cli as Cli)) throw new Error(`Unbekanntes Werkzeug: ${String(cli)}`)
    return cli as Cli
  }
  // Angemeldet? Claude Code und Codex fragen; Vibe: Mistral-Key gefunden, sonst unbekannt (er kann im Schlüsselbund liegen)
  const loggedIn = async (cli: Cli): Promise<{ login: boolean | null; who?: string }> =>
    cli === 'vibe' ? { login: vibeKey() || null } : clis[cli] ? cliStatus(clis[cli]!, cli) : { login: null }
  ipcMain.handle('setup:status', async () => (detect(), {
    key: hasApiKey(),
    clis: await Promise.all(CLIS.map(async (c) => ({ id: c, name: CLI_NAME[c], found: !!clis[c], mcp: registered(c) && skillOk(c), ...await loggedIn(c) }))),
  }))

  // Konten (Einstellungen): eine Anmeldung zur Zeit, CLI oder Nextcloud; eine neue bricht die laufende ab.
  // url: Anmeldeseite zum erneuten Öffnen, code: reicht einen Code aus dem Browser an das CLI
  type Login = { ctrl: AbortController; url: string; code?: (c: string) => void }
  let login: Login | null = null
  const runLogin = async <T>(fn: (l: Login) => Promise<T>): Promise<T> => {
    login?.ctrl.abort()
    const l: Login = { ctrl: new AbortController(), url: '' }
    login = l
    try { return await fn(l) } finally { if (login === l) login = null }
  }
  const loginUrl = (l: Login, url: string, code: boolean) => { l.url = url; if (!win.isDestroyed()) win.webContents.send('account:url', { url, code }) }
  win.on('closed', () => login?.ctrl.abort()) // sonst hielte Codex seinen Port 1455 nach dem Beenden belegt
  const loginCli = (c: unknown): { cli: LoginCli; bin: string } => {
    const cli = cliArg(c)
    if (cli === 'vibe') throw new Error('Vibe hat keine Anmeldung, nur einen Mistral-Schlüssel.')
    detect()
    const bin = clis[cli]
    if (!bin) throw new Error(`${CLI_NAME[cli]} ist nicht installiert.`)
    return { cli, bin }
  }
  ipcMain.handle('account:login', (_, c: unknown) => {
    const { cli, bin } = loginCli(c)
    return runLogin(async (l) => {
      const r = cliLogin(bin, cli, (e) => loginUrl(l, e.url, e.code), l.ctrl.signal)
      l.code = r.code
      await r.done
    })
  })
  ipcMain.handle('account:code', (_, c: unknown) => {
    if (typeof c !== 'string' || !c.trim() || c.length > 2000) throw new Error('Den Code aus dem Browser vollständig einfügen.')
    if (!login?.code) throw new Error('Gerade läuft keine Anmeldung, die einen Code erwartet.')
    login.code(c)
  })
  ipcMain.handle('account:cancel', () => { login?.ctrl.abort(); login = null })
  ipcMain.handle('account:open', () => {
    if (!login?.url || !/^https?:\/\//i.test(login.url)) throw new Error('Gerade läuft keine Anmeldung.')
    return shell.openExternal(login.url)
  })
  ipcMain.handle('account:logout', (_, c: unknown) => {
    const { cli, bin } = loginCli(c)
    return cliLogout(bin, cli)
  })
  ipcMain.handle('account:vibeKey', (_, k: unknown) => setVibeKey(k as string | null)) // prüft Typ und Länge selbst
  ipcMain.handle('sync:nextcloud', async (_, server: unknown) => {
    if (typeof server !== 'string' || !server.trim() || server.length > 500) throw new Error('Die Adresse deiner Nextcloud eingeben, z. B. cloud.example.de.')
    const s = await runLogin((l) => nextcloudLogin(server, {
      signal: l.ctrl.signal,
      open: (url) => { loginUrl(l, url, false); shell.openExternal(url).catch(() => {}) }, // klappt das nicht: Seite über account:url bzw. account:open
    }))
    return saveSync(s)
  })
  // Modell-Dropdown: Claude (Key oder Claude Code), Vibe mit den Modellen aus seiner config.toml (die aktive zuerst),
  // Codex mit den sichtbaren Modellen seines Katalogs. Ohne Liste bleibt die Voreinstellung des CLI („vibe:“, „codex:“).
  const vibeModels = (): ChatModels['vibe'] => {
    let text = ''
    try { text = readFileSync(config.vibe, 'utf8') } catch { /* noch nie gestartet */ }
    const active = /^active_model\s*=\s*"([^"]+)"/m.exec(text)?.[1]
    const list = text.split(/^\[\[models\]\]\s*$/m).slice(1).map((b) => b.split(/^\[/m)[0]).flatMap((b) => {
      const alias = /^alias\s*=\s*"([^"]+)"/m.exec(b)?.[1] ?? /^name\s*=\s*"([^"]+)"/m.exec(b)?.[1]
      const provider = /^provider\s*=\s*"([^"]+)"/m.exec(b)?.[1]
      const hint = [provider === 'llamacpp' && 'läuft lokal auf diesem Rechner', alias === active && 'Voreinstellung in Vibe'].filter(Boolean).join(', ')
      return alias ? [{ id: `vibe:${alias}`, name: `Vibe · ${alias}`, hint: hint || undefined }] : []
    }).sort((a, b) => Number(b.id === `vibe:${active}`) - Number(a.id === `vibe:${active}`))
    return list.length ? list : [{ id: 'vibe:', name: 'Vibe', hint: 'Modell aus der Vibe-Einstellung' }]
  }
  let codexModels: Promise<ChatModels['codex']> | null = null
  const listCodex = (bin: string) => new Promise<ChatModels['codex']>((ok) => execFile(bin, ['debug', 'models'], { timeout: 20_000, maxBuffer: 20e6 }, (e, out) => {
    try {
      if (e) throw e
      const all = (JSON.parse(out).models as { slug: string; display_name?: string; description?: string; visibility?: string; priority?: number }[])
      const list = all.filter((m) => m.visibility === 'list').sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
      ok(list.map((m) => ({ id: `codex:${m.slug}`, name: `Codex · ${m.display_name ?? m.slug}` }))) // ohne die englische Katalogbeschreibung
    } catch { ok([{ id: 'codex:', name: 'Codex', hint: 'Modell aus der Codex-Einstellung' }]) }
  }))
  ipcMain.handle('chat:models', async (): Promise<ChatModels> => (detect(), {
    claude: hasApiKey() || !!clis.claude,
    vibe: clis.vibe ? vibeModels() : [],
    codex: clis.codex ? await (codexModels ??= listCodex(clis.codex)) : [],
  }))
  ipcMain.handle('setup:mcp', async (_, c: unknown = 'claude') => {
    const cli = cliArg(c)
    const bin = clis[cli]
    if (!bin) throw new Error(`${CLI_NAME[cli]} ist nicht installiert.`)
    const run = (args: string[]) => new Promise<void>((ok, fail) =>
      execFile(bin, args, { timeout: 60_000 }, (e, _out, err) => (e ? fail(new Error(err.trim() || e.message)) : ok())))
    const { command, args } = mcpCmd
    const [remove, add] = {
      claude: [['mcp', 'remove', '-s', 'user', 'deckwerk'], ['mcp', 'add', '-s', 'user', 'deckwerk', '--', command, ...args]],
      codex: [['mcp', 'remove', 'deckwerk'], ['mcp', 'add', 'deckwerk', '--', command, ...args]],
      // --arg=--mcp: mit Leerzeichen hielte Vibe „--mcp“ für eine eigene Option
      vibe: [['mcp', 'remove', 'deckwerk'], ['mcp', 'add', 'deckwerk', '--transport', 'stdio', '--command', command, ...args.map((a) => `--arg=${a}`),
        '--startup-timeout-sec', '90', '--tool-timeout-sec', '300']],
    }[cli]
    await run(remove).catch(() => {}) // alter Eintrag mit anderem Pfad
    await run(add)
    const f = skillFile(cli)
    if (f) { await mkdir(dirname(f), { recursive: true }); await writeFile(f, skill()) }
    // Electron braucht zum Starten länger als die 10 s, die Codex wartet, und Rendern länger als dessen Tool-Timeout;
    // `codex mcp add` kann beides nicht setzen
    if (cli === 'codex') {
      const text = await readFile(config.codex, 'utf8')
      const head = '[mcp_servers.deckwerk]\n'
      if (!tomlSection(text, head).includes('startup_timeout_sec'))
        await writeFile(config.codex, text.replace(head, `${head}startup_timeout_sec = 90\ntool_timeout_sec = 300\n`))
    }
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

function readDeck(file: string, dir = dirname(file)): Deck {
  const d = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(d?.slides) || !d.theme) throw new Error('Das ist keine gültige deck.json.')
  return localizeDeck(d, dir) // relative Bildpfade (Deck-Ordner mit assets/ weitergegeben) auflösen
}

// ~/Deckwerk/<titel-slug>, bei Kollision mit -2, -3 …
function freeDir(title: string): string {
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deck'
  let dir = join(HOME, slug)
  for (let i = 2; existsSync(dir); i++) dir = join(HOME, `${slug}-${i}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

// Inhalt eines TOML-Abschnitts ab seiner Kopfzeile bis zum nächsten Abschnitt (reicht, um unseren Eintrag zu erkennen)
function tomlSection(text: string, head: string): string {
  const i = text.indexOf(head)
  if (i < 0) return ''
  const rest = text.slice(i + head.length)
  const next = rest.search(/^\[/m)
  return next < 0 ? rest : rest.slice(0, next)
}
