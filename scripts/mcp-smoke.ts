// MCP-Server gegen Mock-Engine über einen In-Memory-Transport: Tools gelistet, Fehler als isError, Bilder, save/open.
// Aufruf: npx esbuild scripts/mcp-smoke.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/mcp-smoke.mjs && node out/mcp-smoke.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildSystemPrompt, type Engine } from '../src/main/agent'
import { createMcpServer, guideParts } from '../src/main/mcp'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const engine: Engine = {
  measure: async (_d, idx = []) => idx.map(() => ({ els: [], fit: { ok: true, head: 0, body: 0, overflow: [] } })),
  renderPng: async (_d, idx) => idx.map(() => PNG),
  renderOverview: async () => PNG,
  lint: async () => [],
  exportDeck: async (_d, f, out) => [`${out}/deck.${f}`],
}

const home = mkdtempSync(join(tmpdir(), 'deckwerk-mcp-'))
process.env.DECKWERK_OFFLINE = '1' // Katalogschriften nie aus dem Netz (webfonts.ts)
const [a, b] = InMemoryTransport.createLinkedPair()
await createMcpServer(engine, { home }).connect(a)
const client = new Client({ name: 'smoke', version: '0' })
await client.connect(b)

assert.match(client.getInstructions() ?? '', /### kpi-grid/)
assert.match((client.getInstructions() ?? '').slice(0, 2000), /read_guide/, 'Claude Code kürzt auf ~2.000 Zeichen: Hinweis auf read_guide muss vorn stehen')
const listed = (await client.listTools()).tools
const names = listed.map((t) => t.name).sort()
// ohne readOnlyHint führt Claude Code Aufrufe nacheinander aus (4 KI-Bilder dauerten so über 6 min)
assert.equal(listed.find((t) => t.name === 'generate_image')?.annotations?.readOnlyHint, true)
assert.equal(listed.find((t) => t.name === 'add_slides')?.annotations?.readOnlyHint, undefined, 'Deck-Änderungen bleiben seriell')
assert.equal(names.length, 27)
assert.ok(names.includes('add_slides') && names.includes('save_deck'))
// read_guide in Teilen unter Claude Codes Token-Grenze, zusammen der volle Systemprompt
const parts = guideParts()
assert.ok(parts.length > 1 && parts.every((p) => p.length <= 20000), `Teile: ${parts.map((p) => p.length)}`)
assert.equal(parts.join('\n'), buildSystemPrompt())
// reine Video-Aufträge: nur §11 und der Katalog-Eintrag clip
const vg = ((await client.callTool({ name: 'read_guide', arguments: { topic: 'video' } })) as { content: { text: string }[] }).content[0].text
assert.ok(vg.startsWith('## 11. Video') && vg.includes('\n### clip ') && !vg.includes('## 1.') && vg.length < 20000, vg.slice(0, 200))

type Res = { content: { type: string; text?: string }[]; isError?: boolean }
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<Res>

let r = await call('add_slides', { slides: [{ layout: 'cover', content: { title: 'Okay' } }] })
assert.equal(r.isError, true); assert.match(r.content[0].text!, /create_deck/)
r = await call('create_deck', { title: 'MCP Test' }); assert.notEqual(r.isError, true)
r = await call('add_slides', { slides: [{ layout: 'cover', content: { title: 'Okay' } }, { layout: 'closing', content: { title: 'Danke' } }] })
assert.match(r.content[0].text!, /Folie 1 \(s[0-9a-f]{4}, cover\): OK/)
r = await call('add_slides', { slides: [{ layout: 'agenda', content: { title: 'Agenda', items: [] } }] })
assert.equal(r.isError, true); assert.match(r.content[0].text!, /items/)
r = await call('add_slides', { slides: [{ layout: 'nope', content: {} }] })
assert.equal(r.isError, true, 'Schema-Fehler des Tool-Inputs kommt als isError')
const deck = JSON.parse((await call('get_deck')).content[0].text!)
assert.equal(deck.slides.length, 2)
r = await call('render_slides', { ids: [deck.slides[0].id] })
assert.equal(r.content[1].type, 'image')
r = await call('save_deck'); assert.match(r.content[0].text!, /mcp-test\/deck\.json/)
r = await call('create_deck', { title: 'Leer' })
// Ein neues Deck bekommt beim Speichern einen eigenen Ordner und überschreibt das zuvor gespeicherte nicht
r = await call('save_deck'); assert.match(r.content[0].text!, /\/leer\/deck\.json/)
assert.equal(JSON.parse(readFileSync(join(home, 'mcp-test/deck.json'), 'utf8')).slides.length, 2)
r = await call('open_deck', { path: 'mcp-test/deck.json' }); assert.match(r.content[0].text!, /2 Folien/)
assert.match((await call('export_deck', { format: 'pdf' })).content[0].text!, /deck\.pdf/)
r = await call('transcribe_video', { video: '/x/talk.mp4' }) // Mock-Engine ohne video
assert.equal(r.isError, true); assert.match(r.content[0].text!, /nur in der Deckwerk-App und im MCP-Server/)
await client.close()
console.log(`MCP OK · ${names.length} Tools · ${home}`)
