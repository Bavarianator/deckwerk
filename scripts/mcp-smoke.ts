// MCP-Server gegen Mock-Engine über einen In-Memory-Transport: Tools gelistet, Fehler als isError, Bilder, save/open.
// Aufruf: npx esbuild scripts/mcp-smoke.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/mcp-smoke.mjs && node out/mcp-smoke.mjs
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Engine } from '../src/main/agent'
import { createMcpServer } from '../src/main/mcp'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const engine: Engine = {
  measure: async (_d, idx = []) => idx.map(() => ({ els: [], fit: { ok: true, head: 0, body: 0, overflow: [] } })),
  renderPng: async (_d, idx) => idx.map(() => PNG),
  renderOverview: async () => PNG,
  lint: async () => [],
  exportDeck: async (_d, f, out) => [`${out}/deck.${f}`],
}

const home = mkdtempSync(join(tmpdir(), 'deckwerk-mcp-'))
const [a, b] = InMemoryTransport.createLinkedPair()
await createMcpServer(engine, { home }).connect(a)
const client = new Client({ name: 'smoke', version: '0' })
await client.connect(b)

assert.match(client.getInstructions() ?? '', /### kpi-grid/)
const names = (await client.listTools()).tools.map((t) => t.name).sort()
assert.equal(names.length, 18)
assert.ok(names.includes('add_slides') && names.includes('save_deck'))

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
r = await call('open_deck', { path: 'mcp-test/deck.json' }); assert.match(r.content[0].text!, /2 Folien/)
assert.match((await call('export_deck', { format: 'pdf' })).content[0].text!, /deck\.pdf/)
await client.close()
console.log(`MCP OK · ${names.length} Tools · ${home}`)
