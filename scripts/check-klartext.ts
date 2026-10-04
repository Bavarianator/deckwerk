// npx esbuild scripts/check-klartext.ts --bundle --platform=node --format=esm --outfile=/tmp/check-klartext.mjs && node /tmp/check-klartext.mjs
import assert from 'node:assert/strict'
import { klartext } from '../src/shared/klartext'

const fall = (fehler: string, erwartet: RegExp | null) => {
  const text = klartext(fehler)
  if (erwartet === null) assert.equal(text, null, fehler)
  else assert.match(text ?? '', erwartet, fehler)
}

fall('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', /Guthaben/)
fall('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', /API-Schlüssel/)
fall('Claude Code beendet (Code 1): Invalid API key · Please run /login', /Claude Code ist nicht angemeldet/)
fall('Not logged in · Please run /login', /Claude Code ist nicht angemeldet/)
fall('Codex ist nicht angemeldet. Einmal im Terminal `codex login` ausführen.', /codex login/)
fall('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', /überlastet/)
fall('429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit', /Warte kurz/)
fall('Claude AI usage limit reached|1759600000', /Limit deines Abos/)
fall('TypeError: fetch failed', /Internetverbindung/)
fall('getaddrinfo ENOTFOUND api.anthropic.com', /Internetverbindung/)
fall('Anfrage abgelehnt', null)
fall('Antwort abgeschnitten (max_tokens). Bitte „weiter“ senden.', null)
console.log('klartext: alle Fälle ok')
