// Modelle für den Chat (Auswahl im Composer). Gilt für API-Key und Claude Code (--model).
// API-Weg: fallback = serverseitiger Refusal-Fallback, updates = Notizen zwischen Tool-Aufrufen als Text (sonst leer),
// legacyThinking = kein adaptive thinking, kein effort (Haiku 4.5).
// Name = Klartext vorn (so wählt man), Modell dahinter
export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Gründlich · Opus 5.5', hint: 'Für neue Decks, Design und große Umbauten', fallback: true, updates: true },
  { id: 'claude-sonnet-5-5', name: 'Schnell · Sonnet 5.5', hint: 'Für Änderungen an bestehenden Folien, deutlich schneller', fallback: true, updates: true },
  { id: 'claude-fable-5-1', name: 'Maximal · Fable 5.1', hint: 'Stärkstes Modell, deutlich langsamer und teurer', fallback: true, updates: true },
  { id: 'claude-haiku-4-5', name: 'Sehr schnell · Haiku 4.5', hint: 'Nur für Kleinigkeiten wie Tippfehler', legacyThinking: true },
] as const

export type ModelId = (typeof MODELS)[number]['id']
export const DEFAULT_MODEL: ModelId = 'claude-opus-5-5'
export const modelOf = (id: unknown) => MODELS.find((m) => m.id === id) ?? MODELS[0]

// „Auto“ (Standard der App): Deckwerk wählt je Auftrag. Neue Decks, Quellmaterial und Umbauten brauchen Opus (Storyline,
// Design, viele Folien), gezielte Änderungen schafft Sonnet in einem Bruchteil der Zeit.
export const AUTO = 'auto'
export const AUTO_CHOICE = { id: AUTO, name: 'Auto', hint: 'Deckwerk wählt je Auftrag: gründlich für neue Decks, schnell für Änderungen' }
export type Effort = 'low' | 'medium' | 'high'
const BIG = /erstell|präsentation|neues deck|storyline|überarbeit|umbau|alle folien|jede folie|komplett|looks?\b|design|quelle|anhang/i
// ponytail: Stichwort-Heuristik; bei Fehlgriffen wählt der Nutzer das Modell von Hand
export function autoPick(text: string, hasDeck: boolean): { model: ModelId; effort: Effort; why: string } {
  if (!hasDeck || text.length > 600 || BIG.test(text)) return { model: 'claude-opus-5-5', effort: 'high', why: hasDeck ? 'Umbau' : 'neues Deck' }
  return { model: 'claude-sonnet-5-5', effort: 'medium', why: 'Änderung' }
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
  const ids = [...(c.claude ? [AUTO, ...MODELS.map((m) => m.id as string)] : []), ...c.vibe.map((m) => m.id), ...c.codex.map((m) => m.id)]
  return ids.includes(v) ? v : ids[0] ?? v
}
