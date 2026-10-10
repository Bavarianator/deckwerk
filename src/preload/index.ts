import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrandKit, CustomFont, Deck, PrintOptions, ThemeRef } from '../shared/deck'
import type { ChatModels } from '../shared/models'
import type { AgentEvent } from '../main/agent'
import type { SyncStatus } from '../main/sync'
import type { Signals, Highlight } from '../shared/highlights'
import type { Transcript } from '../shared/video'

export type { SyncStatus }

/** Agenten-CLI, über das der Chat ohne API-Key läuft und in das sich Deckwerk als MCP-Server einträgt */
export type ChatCli = 'claude' | 'codex' | 'vibe'
/** login: angemeldet, null = unbekannt (Vibe: Mistral-Key gefunden = true); who: Konto, z. B. „name@mail.de · Max“ */
export interface CliStatus { id: ChatCli; name: string; found: boolean; mcp: boolean; login: boolean | null; who?: string }
/** CLIs mit Browser-Anmeldung */
export type LoginCli = 'claude' | 'codex'
/** Anmeldung läuft: Seite im Browser (öffnet sich von selbst); code = der Dienst kann im Browser einen Code zeigen, den loginCode weitergibt */
export interface LoginEvent { url: string; code: boolean }
export type ImageProvider = 'mammouth' | 'openai' | 'codex'
/** KI-Bilder und Fotosuche: woher die Keys kommen (app = in Deckwerk gespeichert, env = Umgebungsvariable), nie die Keys selbst */
export interface ImageStatus { mammouth: 'app' | 'env' | null; openai: 'app' | 'env' | null; unsplash: 'app' | 'env' | null; provider: ImageProvider | null; model: string }
/** Über Deckwerk: Versionen und der Ordner mit Decks, Bildern, brand.json und hausstil.md */
export interface AppInfo { version: string; electron: string; chrome: string; node: string; platform: string; home: string }
/** canInstall: die fertige Linux-App kann sich selbst ersetzen; sonst gilt `deckwerk update` im Terminal bzw. git */
export interface UpdateInfo { current: string; latest: string; newer: boolean; canInstall: boolean }
/** hasKey: irgendein KI-Zugang (API-Key oder ein Agenten-CLI) */
export interface AppState { deck: Deck | null; path: string | null; hasKey: boolean; setupDone: boolean }
/** Steuerbefehl vom Referenten an das Publikumsfenster */
export type PresentCmd = { type: 'next' } | { type: 'go'; i: number } | { type: 'ink'; ink: Ink } | { type: 'pause'; on: boolean }
/** Laserpunkt und Stiftstriche über der Folie, Koordinaten 0–1 (gleich auf jedem Bildschirm) */
export interface Ink { laser: [number, number] | null; strokes: [number, number][][] }

// Main lädt Engine und IPC erst nach dem Fenster; bis registerIpc steht, Aufrufe kurz später wiederholen
const invoke = (channel: string, ...args: unknown[]): Promise<any> =>
  ipcRenderer.invoke(channel, ...args).catch((e: Error) =>
    /No handler registered/.test(e.message) ? new Promise((r) => setTimeout(r, 50)).then(() => invoke(channel, ...args)) : Promise.reject(e),
  )

const api = {
  state: (): Promise<AppState> => invoke('state'),
  /** Lokale Änderung (Edit, Inspector, Undo) an Main und Agent melden */
  setDeck: (deck: Deck): Promise<void> => invoke('deck:set', deck),
  newDeck: (): Promise<void> => invoke('deck:new'),
  /** null = Dialog abgebrochen */
  open: (): Promise<AppState | null> => invoke('deck:open'),
  /** wie open, aber ohne Dialog */
  openPath: (path: string): Promise<AppState> => invoke('deck:openPath', path),
  /** Versionsverlauf des offenen Decks, neueste zuerst (at in ms); leer, solange es nicht gespeichert ist */
  versions: (): Promise<{ file: string; at: number; slides: number; title: string }[]> => invoke('versions:list'),
  /** Version nur zum Ansehen; wiederherstellen = openPath(file) */
  readVersion: (file: string): Promise<Deck> => invoke('versions:read', file),
  /** Kopie als neues Deck unter ~/Deckwerk speichern, liefert den Pfad */
  saveCopy: (deck: Deck): Promise<string> => invoke('deck:saveCopy', deck),
  /** Publikumsfenster auf dem zweiten Bildschirm; false = nur ein Bildschirm */
  presentOpen: (deck: Deck, start: number): Promise<boolean> => invoke('present:open', deck, start),
  presentDeck: (): Promise<{ deck: Deck; start: number } | null> => invoke('present:deck'),
  presentCmd: (cmd: PresentCmd): Promise<void> => invoke('present:cmd', cmd),
  presentClose: (): Promise<void> => invoke('present:close'),
  /** Handy-Fernbedienung starten → URL mit Token (für den QR-Code) */
  remoteStart: (): Promise<string> => invoke('remote:start'),
  remoteStop: (): Promise<void> => invoke('remote:stop'),
  /** aktuelle Folie und Notizen für die Handy-Seite */
  remoteState: (s: { i: number; n: number; title: string; notes: string }): Promise<void> => invoke('remote:state', s),
  /** Deck, das von außen kam (Doppelklick auf eine deck.json, während Deckwerk schon läuft) */
  onDeckOpened(cb: (s: AppState) => void): () => void {
    const h = (_: unknown, s: AppState) => cb(s)
    ipcRenderer.on('deck:opened', h)
    return () => void ipcRenderer.off('deck:opened', h)
  },
  /** Der Cloud-Sync hat das offene Deck mit der Fassung eines anderen Geräts ersetzt */
  onDeckSynced(cb: (d: Deck) => void): () => void {
    const h = (_: unknown, d: Deck) => cb(d)
    ipcRenderer.on('deck:synced', h)
    return () => void ipcRenderer.off('deck:synced', h)
  },
  onRemote(cb: (c: 'next' | 'prev') => void): () => void {
    const h = (_: unknown, c: 'next' | 'prev') => cb(c)
    ipcRenderer.on('present:remote', h)
    return () => void ipcRenderer.off('present:remote', h)
  },
  onPresent(cb: (e: PresentCmd | 'ended') => void): () => void {
    const h = (_: unknown, c: PresentCmd) => cb(c)
    const end = () => cb('ended')
    ipcRenderer.on('present:cmd', h)
    ipcRenderer.on('present:ended', end)
    return () => { ipcRenderer.off('present:cmd', h); ipcRenderer.off('present:ended', end) }
  },
  /** Vorlagen für den Startbildschirm; zum Bearbeiten per saveCopy kopieren */
  templates: (): Promise<Deck[]> => invoke('templates:list'),
  /** zuletzt geänderte Decks unter ~/Deckwerk, neueste zuerst */
  recent: (limit?: number): Promise<{ path: string; title: string; mtime: number; deck: Deck }[]> => invoke('decks:recent', limit),
  /** speichert nach ~/Deckwerk/<name>/deck.json, liefert den Pfad */
  save: (): Promise<string> => invoke('deck:save'),
  /** Cache-Daten eines Videos (asset://-URL oder Pfad), rechnet nie; null = kein erlaubtes Video */
  videoCached: (src: string): Promise<{ signals: Signals | null; highlights: Highlight[]; transcript: Transcript | null; duration: number | null } | null> => invoke('video:cached', src),
  /** Lange Video-Jobs im Main (Import, Highlights, Transkript, Export) mit Fortschritt */
  jobs: (): Promise<{ key: string; name: string; pct: number; done: boolean }[]> => invoke('jobs:list'),
  /** print = PDF für die Druckerei (Endformat + Beschnitt), nur mit print-Optionen sinnvoll */
  /** alle erzeugten Dateien (bei 'clips' mehrere) */
  exportDeck: (format: 'pptx' | 'docx' | 'pdf' | 'png' | 'zip' | 'md' | 'print' | 'mp4' | 'clips', print?: PrintOptions): Promise<string[]> => invoke('deck:export', format, print),
  /** Fortschritt eines Video-Exports in % */
  onExportProgress(cb: (pct: number) => void): () => void {
    const h = (_: unknown, pct: number) => cb(pct)
    ipcRenderer.on('export:progress', h)
    return () => void ipcRenderer.off('export:progress', h)
  },
  /** resolved, wenn der Agent fertig ist; Fortschritt kommt über onEvent */
  send: (text: string, model?: string): Promise<void> => invoke('agent:send', text, model),
  abort: (): Promise<void> => invoke('agent:abort'),
  onEvent(cb: (e: AgentEvent) => void): () => void {
    const h = (_: unknown, e: AgentEvent) => cb(e)
    ipcRenderer.on('agent:event', h)
    return () => void ipcRenderer.off('agent:event', h)
  },
  /** prüft den Key bei Anthropic und speichert ihn; „ungeprüft“ = ohne Verbindung gespeichert */
  setApiKey: (key: string): Promise<'geprüft' | 'ungeprüft'> => invoke('key:set', key),
  /** gespeicherten Anthropic-Key löschen (ANTHROPIC_API_KEY aus der Umgebung bleibt) */
  clearApiKey: (): Promise<void> => invoke('key:clear'),
  /** feste Hilfe-Links der Einrichtung im Browser öffnen */
  openHilfe: (id: 'api-keys' | 'claude' | 'node' | 'mistral' | 'openai' | 'unsplash'): Promise<void> => invoke('hilfe:open', id),
  /** Konten: Browser-Anmeldung in Claude Code bzw. Codex; löst auf, wenn sie fertig ist. Eine Anmeldung zur Zeit (auch Nextcloud). */
  login: (cli: LoginCli): Promise<void> => invoke('account:login', cli),
  /** Code aus dem Browser an die laufende Anmeldung (Claude, falls der Rückweg zur App nicht klappt) */
  loginCode: (code: string): Promise<void> => invoke('account:code', code),
  /** laufende Anmeldung abbrechen (CLI oder Nextcloud); die wartende login-/nextcloudLogin-Promise wird abgelehnt */
  loginCancel: (): Promise<void> => invoke('account:cancel'),
  /** Anmeldeseite der laufenden Anmeldung erneut im Browser öffnen */
  loginOpen: (): Promise<void> => invoke('account:open'),
  onLogin(cb: (e: LoginEvent) => void): () => void {
    const h = (_: unknown, e: LoginEvent) => cb(e)
    ipcRenderer.on('account:url', h)
    return () => void ipcRenderer.off('account:url', h)
  },
  logout: (cli: LoginCli): Promise<void> => invoke('account:logout', cli),
  /** Mistral-Key für Vibe in ~/.vibe/.env speichern; null löscht ihn dort */
  setVibeKey: (key: string | null): Promise<void> => invoke('account:vibeKey', key),
  /** liefert asset://local/<absoluter Pfad> oder null */
  pickImage: (): Promise<string | null> => invoke('image:pick'),
  /** Bild aus der System-Zwischenablage als PNG unter ~/Deckwerk/assets speichern; null = keins drin */
  pasteImage: (): Promise<string | null> => invoke('image:paste'),
  /** Fotos suchen: eigene Bilder unter ~/Deckwerk/assets, sonst Unsplash (Key in Einstellungen → Bilder oder UNSPLASH_ACCESS_KEY) */
  findImages: (query: string): Promise<{ urls: string[]; note?: string }> => invoke('image:find', query),
  /** Bild per KI erzeugen (Anbieter aus Einstellungen → Bilder), Datei unter ~/Deckwerk/assets → asset://-URL; dauert 20–120 s */
  generateImage: (prompt: string, orientation: 'landscape' | 'portrait' | 'square'): Promise<string> => invoke('image:generate', prompt, orientation),
  /** die neuesten eigenen Bilder unter ~/Deckwerk/assets (auch Unterordner), neu → alt, höchstens 60 */
  listAssets: (): Promise<{ url: string; name: string; mtime: number }[]> => invoke('assets:list'),
  /** Hintergrund entfernen (nativ im Main-Prozess) → asset://-URL eines PNG mit Transparenz */
  removeBg: (src: string): Promise<string> => invoke('image:removeBg', src),
  /** Fortschritt des einmaligen Modell-Downloads in % */
  onBgProgress(cb: (pct: number) => void): () => void {
    const h = (_: unknown, pct: number) => cb(pct)
    ipcRenderer.on('bg:progress', h)
    return () => void ipcRenderer.off('bg:progress', h)
  },
  /** Video- oder Audiodatei wählen → asset://-URL oder null */
  pickMedia: (kind: 'video' | 'audio'): Promise<string | null> => invoke('media:pick', kind),
  /** TTF wählen (Regular, optional Bold); Familienname aus der Datei; null = abgebrochen */
  pickFont: (): Promise<CustomFont | null> => invoke('font:pick'),
  /** Katalogschriften des Decks laden (Cache ~/Deckwerk/fonts, offline gebündelter Ersatz) → Theme mit fontFiles; notes z. B. „Newsreader geladen“ */
  ensureFonts: (deck: Deck): Promise<{ theme: ThemeRef; notes: string[] }> => invoke('font:ensure', deck),
  /** data-URL (PNG/JPEG/WebP) unter ~/Deckwerk/assets speichern → asset://-URL */
  saveAsset: (dataUrl: string, name: string): Promise<string> => invoke('asset:save', dataUrl, name),
  /** Text aus TXT/MD/CSV/DOCX/PPTX/PDF lesen; ohne Pfad per Dialog, null = abgebrochen */
  readSource: (paths?: string[]): Promise<{ srcs: { name: string; text: string; cut: boolean }[]; errors: string[] } | null> => invoke('source:read', paths),
  /** Brand-Kit des Nutzers (~/Deckwerk/brand.json), das jedes neue Deck per KI bekommt; null = keines gespeichert */
  getBrand: (): Promise<BrandKit | null> => invoke('brand:get'),
  setBrand: (b: BrandKit): Promise<void> => invoke('brand:set', b),
  /** Standard-Brand-Kit löschen (brand.json); bestehende Decks behalten ihres */
  clearBrand: (): Promise<void> => invoke('brand:clear'),
  /** ~/Deckwerk/hausstil.md im Standard-Editor öffnen (legt sie bei Bedarf an) */
  openStyle: (): Promise<void> => invoke('style:open'),
  /** Hausstil lesen ('' = keiner) und ganz ersetzen */
  getStyle: (): Promise<string> => invoke('style:get'),
  setStyle: (text: string): Promise<void> => invoke('style:set', text),
  /** Über Deckwerk; openHome öffnet den Deckwerk-Ordner im Dateimanager */
  appInfo: (): Promise<AppInfo> => invoke('app:info'),
  openHome: (): Promise<void> => invoke('app:openHome'),
  /** Nach einer neueren Version suchen (nur auf Knopfdruck); installUpdate ersetzt die App und startet sie neu */
  checkUpdate: (): Promise<UpdateInfo> => invoke('update:check'),
  installUpdate: (): Promise<void> => invoke('update:install'),
  /** Rechtschreibprüfung (Deutsch/Englisch) an/aus; gilt sofort und bleibt gespeichert */
  spellcheck: (): Promise<boolean> => invoke('spellcheck:get'),
  setSpellcheck: (on: boolean): Promise<void> => invoke('spellcheck:set', on),
  /** Einrichtung: KI-Zugang und Deckwerk-MCP in Claude Code, Codex und Vibe */
  setupStatus: (): Promise<{ key: boolean; clis: CliStatus[] }> => invoke('setup:status'),
  setupMcp: (cli: ChatCli): Promise<void> => invoke('setup:mcp', cli),
  /** Einträge fürs Modell-Dropdown: Claude, Vibe, Codex (je nachdem, was installiert ist) */
  chatModels: (): Promise<ChatModels> => invoke('chat:models'),
  /** Einrichtung abgeschlossen oder übersprungen: erscheint nicht mehr von selbst */
  setupDone: (): Promise<void> => invoke('setup:done'),
  /** startet den MCP-Server wie die Agenten-CLIs und liefert die Anzahl seiner Werkzeuge */
  setupMcpTest: (): Promise<number> => invoke('setup:mcpTest'),
  /** KI-Bilder und Fotosuche: Keys (Mammouth, OpenAI, Unsplash), bevorzugter Anbieter, Modell; null oder '' löscht ein Feld */
  imageSettings: (): Promise<ImageStatus> => invoke('imageSettings:get'),
  setImageSettings: (patch: { mammouth?: string | null; openai?: string | null; unsplash?: string | null; provider?: ImageProvider | null; model?: string | null }): Promise<ImageStatus> => invoke('imageSettings:set', patch),
  /** Cloud-Sync: Zustand, Einstellungen setzen (pass '' = unverändert, null = Sync aus), Lauf starten, Verbindung testen */
  syncStatus: (): Promise<SyncStatus> => invoke('sync:get'),
  setSync: (s: { url: string; user: string; pass: string } | null): Promise<SyncStatus> => invoke('sync:set', s),
  syncRun: (): Promise<SyncStatus> => invoke('sync:run'),
  syncTest: (s: { url: string; user: string; pass: string }): Promise<void> => invoke('sync:test', s),
  /** Nextcloud-Anmeldung im Browser (Login Flow v2): legt ein App-Passwort an, speichert den Zugang und gleicht ab.
   * Seite kommt auch über onLogin, Abbruch über loginCancel. */
  nextcloudLogin: (server: string): Promise<SyncStatus> => invoke('sync:nextcloud', server),
  /** Cloud über einen Sync-Ordner (Dropbox, OneDrive, Google Drive, iCloud …): Deckwerk spiegelt nach <ordner>/Deckwerk.
   * setSyncFolder prüft den Ordner, speichert und gleicht ab; der Zugang hat dann url file:///… und keinen Nutzer. */
  setSyncFolder: (path: string): Promise<SyncStatus> => invoke('sync:folder', path),
  /** vorhandene übliche Sync-Ordner der folder-Anbieter aus src/shared/clouds.ts (id = Anbieter) */
  cloudFolders: (): Promise<{ id: string; path: string }[]> => invoke('cloud:folders'),
  /** Ordner wählen (Dialog, startet bei start); null = abgebrochen */
  pickCloudFolder: (start?: string): Promise<string | null> => invoke('cloud:pickFolder', start),
  /** Hilfeseite eines Anbieters aus CLOUDS (z. B. App-Passwort anlegen) im Browser öffnen */
  cloudHelp: (id: string): Promise<void> => invoke('cloud:help', id),
  onSync(cb: (s: SyncStatus) => void): () => void {
    const h = (_: unknown, s: SyncStatus) => cb(s)
    ipcRenderer.on('sync:status', h)
    return () => void ipcRenderer.off('sync:status', h)
  },
  /** absoluter Pfad einer per Drag & Drop abgelegten Datei */
  pathOf: (file: File): string => webUtils.getPathForFile(file),
}

export type Api = typeof api

declare global {
  interface Window { api: Api }
}

contextBridge.exposeInMainWorld('api', api)
