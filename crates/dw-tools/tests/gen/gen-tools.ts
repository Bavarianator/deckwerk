// for e in deckwerk pro; do npx esbuild crates/dw-tools/tests/gen/gen-tools.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=target/dw-tools-gen/gen.mjs --log-level=warning && DW_EDITION=$e node target/dw-tools-gen/gen.mjs; done
// Fixtures für dw-tools (aus dem Repo-Wurzelverzeichnis ausführen, je Edition einmal):
// - tests/fixtures/tools-<edition>.json: Werkzeuge, wie ein MCP-Client sie heute sieht (tools/list des TS-Servers), und die Namen aus buildTools
// - data/catalog.json (nur in der Pro-Runde, Obermenge): Layout-Katalog mit JSON-Schema und Beispielinhalt, Icon-Namen
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { APP } from '../../../../src/shared/app-id'
import type { Engine } from '../../../../src/main/agent'
import { createMcpServer } from '../../../../src/main/mcp'
import { buildTools, ICON_NAMES } from '../../../../src/main/tools'
import { LAYOUTS, PRO_LAYOUT_IDS } from '../../../../src/shared/layouts'

const ROOT = process.cwd()
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const engine: Engine = {
  measure: async (_d, idx = []) => idx.map(() => ({ els: [], fit: { ok: true, head: 0, body: 0, overflow: [] } })),
  renderPng: async (_d, idx) => idx.map(() => PNG),
  renderOverview: async () => PNG,
  lint: async () => [],
  exportDeck: async (_d, f, out) => [`${out}/deck.${f}`],
}
process.env.DECKWERK_OFFLINE = '1'
const home = mkdtempSync(join(tmpdir(), 'dw-tools-gen-'))
const ctx = { engine, getDeck: () => null, setDeck: () => {}, assetDir: '/nonexistent', outDir: '/nonexistent' }
const agent = buildTools(ctx).map((t) => t.name)
const chat = buildTools({ ...ctx, ask: () => {}, storyline: () => {} }).map((t) => t.name)

const [a, b] = InMemoryTransport.createLinkedPair()
await createMcpServer(engine, { home }).connect(a)
const client = new Client({ name: 'gen', version: '0' })
await client.connect(b)
const mcp = (await client.listTools()).tools
const instructions = client.getInstructions() ?? ''
const intro = instructions.split('\n\n# ')[0] // INTRO vor dem Kernprompt
writeFileSync(join(ROOT, `crates/dw-tools/tests/fixtures/tools-${APP.pro ? 'pro' : 'deckwerk'}.json`), JSON.stringify({ agent, chat, mcp, intro }, null, 1) + '\n')

if (APP.pro) {
  const layouts = Object.values(LAYOUTS).map((L) => {
    const { $schema: _, ...schema } = z.toJSONSchema(L.schema) as Record<string, unknown>
    return { id: L.id, name: L.name, when: L.when, variants: L.variants, frames: L.frames, sizes: (L as { sizes?: string[] }).sizes, defaultBuild: L.defaultBuild, pro: PRO_LAYOUT_IDS.includes(L.id) || undefined, schema, typ: L.samples.typ }
  })
  mkdirSync(join(ROOT, 'crates/dw-tools/data'), { recursive: true })
  writeFileSync(join(ROOT, 'crates/dw-tools/data/catalog.json'), JSON.stringify({ layouts, icons: ICON_NAMES }) + '\n')
}
console.log(`${APP.pro ? 'pro' : 'deckwerk'}: ${agent.length} Tools, Chat ${chat.length}, MCP ${mcp.length}, Intro ${intro.length} Zeichen`)
process.exit(0)
