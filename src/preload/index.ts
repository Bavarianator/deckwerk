import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CustomFont, Deck } from '../shared/deck'
import type { ChatModels } from '../shared/models'
import type { AgentEvent } from '../main/agent'

/** Agenten-CLI, über das der Chat ohne API-Key läuft und in das sich Deckwerk als MCP-Server einträgt */
export type ChatCli = 'claude' | 'codex' | 'vibe'
/** login: angemeldet (nur Codex prüfbar), null = unbekannt */
export interface CliStatus { id: ChatCli; name: string; found: boolean; mcp: boolean; login: boolean | null }
/** hasKey: irgendein KI-Zugang (API-Key oder ein Agenten-CLI) */
export interface AppState { deck: Deck | null; path: string | null; hasKey: boolean; setupDone: boolean }
/** Steuerbefehl vom Referenten an das Publikumsfenster */
export type PresentCmd = { type: 'next' } | { type: 'go'; i: number } | { type: 'ink'; ink: Ink }
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
  exportDeck: (format: 'pptx' | 'pdf' | 'png' | 'md'): Promise<string> => invoke('deck:export', format),
  /** resolved, wenn der Agent fertig ist; Fortschritt kommt über onEvent */
  send: (text: string, model?: string): Promise<void> => invoke('agent:send', text, model),
  abort: (): Promise<void> => invoke('agent:abort'),
  onEvent(cb: (e: AgentEvent) => void): () => void {
    const h = (_: unknown, e: AgentEvent) => cb(e)
    ipcRenderer.on('agent:event', h)
    return () => void ipcRenderer.off('agent:event', h)
  },
  setApiKey: (key: string): Promise<void> => invoke('key:set', key),
  /** liefert asset://local/<absoluter Pfad> oder null */
  pickImage: (): Promise<string | null> => invoke('image:pick'),
  /** Bild aus der System-Zwischenablage als PNG unter ~/Deckwerk/assets speichern; null = keins drin */
  pasteImage: (): Promise<string | null> => invoke('image:paste'),
  /** Fotos suchen: eigene Bilder unter ~/Deckwerk/assets, sonst Unsplash (wenn UNSPLASH_ACCESS_KEY gesetzt) */
  findImages: (query: string): Promise<{ urls: string[]; note?: string }> => invoke('image:find', query),
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
  /** data-URL (PNG/JPEG/WebP) unter ~/Deckwerk/assets speichern → asset://-URL */
  saveAsset: (dataUrl: string, name: string): Promise<string> => invoke('asset:save', dataUrl, name),
  /** Text aus TXT/MD/CSV/DOCX/PPTX/PDF lesen; ohne Pfad per Dialog, null = abgebrochen */
  readSource: (path?: string): Promise<{ name: string; text: string; cut: boolean } | null> => invoke('source:read', path),
  /** ~/Deckwerk/hausstil.md im Standard-Editor öffnen (legt sie bei Bedarf an) */
  openStyle: (): Promise<void> => invoke('style:open'),
  /** Einrichtung: KI-Zugang und Deckwerk-MCP in Claude Code, Codex und Vibe */
  setupStatus: (): Promise<{ key: boolean; clis: CliStatus[] }> => invoke('setup:status'),
  setupMcp: (cli: ChatCli): Promise<void> => invoke('setup:mcp', cli),
  /** Einträge fürs Modell-Dropdown: Claude, Vibe, Codex (je nachdem, was installiert ist) */
  chatModels: (): Promise<ChatModels> => invoke('chat:models'),
  /** Einrichtung abgeschlossen oder übersprungen: erscheint nicht mehr von selbst */
  setupDone: (): Promise<void> => invoke('setup:done'),
  /** startet den MCP-Server wie die Agenten-CLIs und liefert die Anzahl seiner Werkzeuge */
  setupMcpTest: (): Promise<number> => invoke('setup:mcpTest'),
  /** absoluter Pfad einer per Drag & Drop abgelegten Datei */
  pathOf: (file: File): string => webUtils.getPathForFile(file),
}

export type Api = typeof api

declare global {
  interface Window { api: Api }
}

contextBridge.exposeInMainWorld('api', api)
