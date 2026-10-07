// Technische Fehler aus API, Claude Code, Codex und Vibe → ein Satz, mit dem auch Laien etwas anfangen können.
// Unbekanntes bleibt wörtlich stehen. Selbsttest: scripts/check-klartext.ts
const REGELN: [RegExp, string][] = [
  [/credit balance is too low|insufficient.?(credit|balance|quota)|billing/i, 'Dein Guthaben beim KI-Anbieter ist aufgebraucht. Lade es dort auf oder wähle in der Einrichtung einen anderen Zugang.'],
  [/not logged in|please run \/login|\/login|oauth token (has )?expired|login required/i, 'Claude Code ist nicht angemeldet. Öffne ein Terminal, gib claude ein und melde dich im Browser an.'],
  [/codex ist nicht angemeldet/i, 'Codex ist nicht angemeldet. Öffne ein Terminal, gib codex login ein und melde dich im Browser an.'],
  [/invalid x-api-key|invalid api key|authentication_error|\b401\b|unauthorized/i, 'Der KI-Zugang wurde abgelehnt. Prüf in der Einrichtung unter „KI-Zugang“ deinen API-Schlüssel oder melde dich neu an.'],
  [/usage limit|limit reached|rate.?limit|\b429\b|too many requests/i, 'Für den Moment sind zu viele Anfragen gelaufen, oder das Limit deines Abos ist erreicht. Warte kurz und versuch es noch einmal.'],
  [/overloaded|\b529\b|\b503\b|service unavailable/i, 'Die KI ist gerade überlastet. Versuch es in einer Minute noch einmal.'],
  [/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|getaddrinfo|network ?error/i, 'Keine Verbindung zur KI. Prüf deine Internetverbindung.'],
]

/** Klartext für eine Fehlermeldung; null, wenn keine Regel passt */
export function klartext(fehler: string): string | null {
  return REGELN.find(([re]) => re.test(fehler))?.[1] ?? null
}
