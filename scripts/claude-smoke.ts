// App-Chat über Claude Code gegen eine Mock-Engine: echter `claude -p`, lokaler HTTP-MCP-Server, UI-Events, --resume, Abbruch.
// Braucht den Claude-Code-Login und kostet drei kleine Anfragen. Aufruf: npm run smoke:claude
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, Engine } from '../src/main/agent'
import { ClaudeAgent, findClaude } from '../src/main/claude-agent'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const engine: Engine = {
  measure: async (_d, idx = []) => idx.map(() => ({ els: [], fit: { ok: true, head: 0, body: 0, overflow: [] } })),
  renderPng: async (_d, idx) => idx.map(() => PNG),
  renderOverview: async () => PNG,
  lint: async () => [],
  exportDeck: async (_d, f, out) => [`${out}/deck.${f}`],
}

const claude = findClaude()
assert.ok(claude, 'claude nicht gefunden (PATH, ~/.local/bin)')
const tmp = mkdtempSync(join(tmpdir(), 'deckwerk-claude-'))
let events: AgentEvent[] = []
const agent = new ClaudeAgent(claude, { engine, onEvent: (e) => events.push(e), outDir: tmp, assetDir: tmp })
const text = () => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
const errors = () => events.flatMap((e) => (e.type === 'error' ? [e.message] : []))

let t0 = Date.now()
await agent.send('Lege mit create_deck ein Deck mit dem Titel "Smoke" an und füge mit add_slides eine cover-Folie mit dem Titel "Hallo Welt" hinzu. Keine Rückfragen, nichts prüfen, nichts rendern.')
console.log(`${Date.now() - t0} ms · ${events.filter((e) => e.type === 'tool').map((e) => e.type === 'tool' && `${e.name}:${e.status}`).join(' ')}`)
assert.deepEqual(errors(), [])
assert.equal(agent.deck?.title, 'Smoke')
assert.equal(agent.deck?.slides.length, 1)
assert.ok(events.some((e) => e.type === 'tool' && e.name === 'add_slides' && e.status === 'done'), 'Tool-Chip')
assert.ok(events.some((e) => e.type === 'deck'), 'Deck-Event für die Live-Vorschau')
assert.equal(events.at(-1)?.type, 'done')

events = []
t0 = Date.now()
await agent.send('Welchen Titel hat die Folie, die du eben angelegt hast? Antworte nur mit dem Titel, ohne Tools.')
console.log(`${Date.now() - t0} ms · ${JSON.stringify(text())}`)
assert.deepEqual(errors(), [])
assert.match(text(), /Hallo Welt/, 'Folgenachricht kennt den Verlauf (--resume)')

events = []
const p = agent.send('Schreibe einen Aufsatz mit 2000 Wörtern über Folienlayouts.')
setTimeout(() => agent.abort(), 4000)
await p
assert.deepEqual(errors(), [], 'Abbruch ist kein Fehler')
assert.equal(events.at(-1)?.type, 'done')
console.log('Claude-Code-Chat OK')
process.exit(0) // der MCP-HTTP-Server hält den Prozess sonst offen
