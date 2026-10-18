// Edition und Identität der App: Deckwerk und Deckwerk Pro sind ein Code, die Edition kommt zur Build-Zeit aus
// DW_EDITION (electron-vite define __DW_EDITION__); esbuild-Skripte ohne define lesen DW_EDITION zur Laufzeit.
// Name, Datenordner ~/<home>, appData-Ordner, MCP-Server und Skill <id>, Update-Repo, Link-Schema <scheme>://. Nur Strings, damit auch der Renderer sie importieren kann.
declare const __DW_EDITION__: string | undefined
const ed = typeof __DW_EDITION__ !== 'undefined' ? __DW_EDITION__ : (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.DW_EDITION
export const EDITION: 'deckwerk' | 'pro' = ed === 'pro' ? 'pro' : 'deckwerk'
export const APP = EDITION === 'pro'
  ? { name: 'Deckwerk Pro', id: 'deckwerk-pro', home: 'DeckwerkPro', repo: 'Bavarianator/deckwerk-pro', scheme: 'deckwerk-pro', pro: true }
  : { name: 'Deckwerk', id: 'deckwerk', home: 'Deckwerk', repo: 'Bavarianator/deckwerk', scheme: 'deckwerk', pro: false }
