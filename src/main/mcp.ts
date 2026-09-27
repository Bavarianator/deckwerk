// MCP-Server für Claude Code / Claude Desktop: dieselben Tools wie der DeckAgent (tools.ts) plus
// get/save/open_deck. Läuft im Electron-Main-Prozess (`electron . --mcp`), weil die Engine Chromium braucht.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { Deck } from '../shared/deck'
import { buildSystemPrompt, type Engine } from './agent'
import { buildTools, mimeOf, type ToolDef, type ToolOutput } from './tools'

export interface McpOptions {
  deck?: Deck
  home?: string // Deck-Ordner, default ~/Deckwerk (Tests)
  onDeck?: (deck: Deck) => void // z. B. Live-Vorschau im App-Fenster
}

export function createMcpServer(engine: Engine, opts: McpOptions = {}): McpServer {
  const home = opts.home ?? join(homedir(), 'Deckwerk')
  let deck: Deck | null = opts.deck ?? null
  let path: string | null = null // …/deck.json, null = noch nie gespeichert
  const outDir = () => (path ? dirname(path) : join(home, 'out'))

  const server = new McpServer({ name: 'deckwerk', version: '0.1.0' }, { instructions: buildSystemPrompt() })

  const tools: ToolDef[] = [
    ...buildTools({
      engine,
      getDeck: () => deck,
      setDeck: (d) => { deck = d; opts.onDeck?.(d) },
      assetDir: join(home, 'assets'),
      outDir: outDir(),
      unsplashKey: process.env.UNSPLASH_ACCESS_KEY, // ponytail: Wert beim Start; nach save_deck exportiert export_deck weiter nach ~/Deckwerk/out
    }),
    {
      name: 'get_deck',
      description: 'Aktuelles Deck als JSON (IDs, Layouts, Inhalte) – zum Nachsehen, was gerade drin ist.',
      inputSchema: z.object({}),
      async run() {
        if (!deck) return { text: 'Noch kein Deck. Erst create_deck oder open_deck.' }
        return { text: JSON.stringify({ path, ...deck }, null, 1) }
      },
    },
    {
      name: 'save_deck',
      description: 'Deck als deck.json speichern (~/Deckwerk/<titel>/deck.json, danach immer dorthin). Die App kann die Datei öffnen.',
      inputSchema: z.object({ name: z.string().max(60).optional().describe('Ordnername statt Titel-Slug') }),
      async run(i: { name?: string }) {
        if (!deck) throw new Error('Es gibt noch kein Deck zum Speichern.')
        path ??= join(await freeDir(home, i.name ?? deck.title), 'deck.json')
        await writeFile(path, JSON.stringify(deck, null, 2))
        return { text: `Gespeichert: ${path}` }
      },
    },
    {
      name: 'open_deck',
      description: 'Vorhandene deck.json laden und weiterbearbeiten.',
      inputSchema: z.object({ path: z.string().describe('Pfad zur deck.json (absolut oder relativ zu ~/Deckwerk)') }),
      async run(i: { path: string }) {
        const file = resolve(home, i.path)
        const d = JSON.parse(await readFile(file, 'utf8'))
        if (!Array.isArray(d?.slides) || !d.theme) throw new Error(`${file} ist keine gültige deck.json.`)
        deck = d
        path = file
        opts.onDeck?.(d)
        return { text: `Geladen: "${d.title}", ${d.slides.length} Folien (${d.slides.map((s: Deck['slides'][number]) => `${s.id}:${s.layout}`).join(', ')})` }
      },
    },
  ]

  serveTools(server, tools)
  return server
}

// auch für den App-Chat über Claude Code (claude-agent.ts)
export function serveTools(server: McpServer, tools: ToolDef[]): void {
  for (const t of tools) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema as z.ZodObject }, async (args) => {
      try {
        return toResult(await t.run(args))
      } catch (e) {
        return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }
      }
    })
  }
}

function toResult(out: ToolOutput): CallToolResult {
  return {
    content: [
      { type: 'text', text: out.text },
      ...(out.images ?? []).map((b) => ({ type: 'image' as const, data: b.toString('base64'), mimeType: mimeOf(b) })),
    ],
  }
}

// <home>/<slug>, bei Kollision -2, -3 … (wie ipc.ts, dort mit Electron-Dialogen verwoben)
async function freeDir(home: string, title: string): Promise<string> {
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'deck'
  let dir = join(home, slug)
  for (let i = 2; existsSync(dir); i++) dir = join(home, `${slug}-${i}`)
  await mkdir(dir, { recursive: true })
  return dir
}

// Einstieg für `electron . --mcp`: stdio gehört dem Protokoll, alles Logging nach stderr.
export async function startMcp(engine: Engine, opts: McpOptions = {}): Promise<void> {
  console.log = console.error
  const server = createMcpServer(engine, { home: process.env.DECKWERK_HOME, ...opts }) // DECKWERK_HOME: Tests
  const transport = new StdioServerTransport()
  transport.onclose = () => process.exit(0)
  process.stdin.on('end', () => process.exit(0)) // Client weg (Claude Code beendet) → keine verwaisten Electron-Prozesse
  await server.connect(transport)
}
