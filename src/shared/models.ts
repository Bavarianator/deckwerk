// Modelle für den Chat (Auswahl im Composer) als Familien, damit die Auswahl ohne App-Update aktuell bleibt: Claude Code
// nimmt für den Alias immer das neueste Modell (--model opus), der API-Weg fragt die Models-API (DeckAgent.resolve).
// latest = bekannter Stand, falls die Models-API nicht antwortet oder das neue Modell die Anfrage ablehnt.
// API-Weg: fallback = serverseitiger Refusal-Fallback, updates = Notizen zwischen Tool-Aufrufen als Text (sonst leer),
// basicSearch = nur die einfache Websuche (Haiku kennt web_search_20260209/web_fetch nicht).
// Name = Klartext vorn (so wählt man), Familie dahinter
export const MODELS = [
  { id: 'opus', latest: 'claude-opus-5-5', name: 'Gründlich · Opus', hint: 'Für neue Decks, Design und große Umbauten', fallback: true, updates: true },
  { id: 'sonnet', latest: 'claude-sonnet-5-5', name: 'Schnell · Sonnet', hint: 'Für Änderungen an bestehenden Folien, deutlich schneller', fallback: true, updates: true },
  { id: 'fable', latest: 'claude-fable-5-1', name: 'Maximal · Fable', hint: 'Stärkstes Modell, deutlich langsamer und teurer', fallback: true, updates: true },
  { id: 'haiku', latest: 'claude-haiku-5-5', name: 'Sehr schnell · Haiku', hint: 'Nur für Kleinigkeiten wie Tippfehler', basicSearch: true },
] as const

export type ModelId = (typeof MODELS)[number]['id']
export const DEFAULT_MODEL: ModelId = 'opus'
// Auswahl von früher mit Version („claude-haiku-4-5“) zählt als ihre Familie, Unbekanntes als Standardmodell
export const modelOf = (id: unknown) => MODELS.find((m) => m.id === id || (typeof id === 'string' && id.startsWith(`claude-${m.id}-`))) ?? MODELS[0]
// Router zum Gesprächsstart (src/main/router.ts): wählt Module und bei „Auto“ das Modell; kein Chat-Modell
export const ROUTER_MODEL = 'claude-haiku-5-5'

// „Auto“ (Standard der App): Deckwerk wählt je Auftrag. Neue Decks, Quellmaterial und Umbauten brauchen Opus (Storyline,
// Design, viele Folien), gezielte Änderungen schafft Sonnet in einem Bruchteil der Zeit.
export const AUTO = 'auto'
export const AUTO_CHOICE = { id: AUTO, name: 'Auto', hint: 'Deckwerk wählt je Auftrag: gründlich für neue Decks, schnell für Änderungen' }
export type Effort = 'low' | 'medium' | 'high'
const BIG = /erstell|präsentation|neues deck|storyline|überarbeit|umbau|alle folien|jede folie|komplett|looks?\b|design|quelle|anhang/i
// ponytail: Stichwort-Heuristik; bei Fehlgriffen wählt der Nutzer das Modell von Hand
export function autoPick(text: string, hasDeck: boolean): { model: ModelId; effort: Effort; why: string } {
  if (!hasDeck || text.length > 600 || BIG.test(text)) return { model: 'opus', effort: 'high', why: hasDeck ? 'Umbau' : 'neues Deck' }
  return { model: 'sonnet', effort: 'medium', why: 'Änderung' }
}

// Das Modell-Dropdown wählt auch den Chat-Weg: Claude-Modelle (API-Key, sonst Claude Code) behalten ihre ID, damit eine
// gespeicherte Auswahl gültig bleibt; Vibe und Codex stehen als „vibe:<modell>“ bzw. „codex:<modell>“ darin.
export type OtherCli = 'vibe' | 'codex'
export const routeOf = (v: unknown): { cli: OtherCli; model: string } | null => {
  const m = typeof v === 'string' ? /^(vibe|codex):(.*)$/.exec(v) : null // leeres Modell = Voreinstellung des CLI
  return m ? { cli: m[1] as OtherCli, model: m[2] } : null
}
/** Was auf diesem Rechner geht: Claude (Key oder Claude Code) und die Modelle von Vibe und Codex (leer = nicht installiert) */
export interface ChatModels { claude: boolean; vibe: { id: string; name: string; hint?: string }[]; codex: { id: string; name: string; hint?: string }[] }
/** Gespeicherte Auswahl, wenn es sie hier gibt, sonst das erste verfügbare Modell (Claude vor Vibe vor Codex) */
export const pickAvailable = (v: string, c: ChatModels): string => {
  if (v.startsWith('claude-')) v = modelOf(v).id
  const ids = [...(c.claude ? [AUTO, ...MODELS.map((m) => m.id as string)] : []), ...c.vibe.map((m) => m.id), ...c.codex.map((m) => m.id)]
  return ids.includes(v) ? v : ids[0] ?? v
}
