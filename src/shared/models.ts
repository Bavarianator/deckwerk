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
