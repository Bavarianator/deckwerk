// Modelle für den Chat (Auswahl im Composer). Gilt für API-Key und Claude Code (--model).
// API-Weg: fallback = serverseitiger Refusal-Fallback, updates = Notizen zwischen Tool-Aufrufen als Text (sonst leer),
// legacyThinking = kein adaptive thinking, kein effort (Haiku 4.5).
export const MODELS = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', hint: 'Standard: stark und zügig', fallback: true, updates: true },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', hint: 'Stärkstes Modell, langsamer und teurer', fallback: true, updates: true },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', hint: 'Schneller und günstiger' },
  { id: 'claude-haiku-4-5', name: 'Haiku 4.5', hint: 'Am schnellsten, für kleine Änderungen', legacyThinking: true },
] as const

export type ModelId = (typeof MODELS)[number]['id']
export const DEFAULT_MODEL: ModelId = 'claude-opus-5-5'
export const modelOf = (id: unknown) => MODELS.find((m) => m.id === id) ?? MODELS[0]

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
  const ids = [...(c.claude ? MODELS.map((m) => m.id as string) : []), ...c.vibe.map((m) => m.id), ...c.codex.map((m) => m.id)]
  return ids.includes(v) ? v : ids[0] ?? v
}
