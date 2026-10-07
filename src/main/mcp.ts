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

// Claude Code nimmt Tool-Ergebnisse nur bis zu einer Token-Grenze an (61.000 Zeichen am Stück waren zu viel): Teile an Abschnittsgrenzen
export function guideParts(max = 20000): string[] {
  const parts = ['']
  for (const block of buildSystemPrompt().split(/\n(?=##+ )/)) {
    if (parts.at(-1) && parts.at(-1)!.length + block.length > max) parts.push('')
    parts[parts.length - 1] += (parts.at(-1) ? '\n' : '') + block
  }
  return parts
}

// Claude Code kürzt Server-Anweisungen auf rund 2.000 Zeichen: das Wesentliche zuerst, der volle Guide per read_guide
const INTRO = `# Deckwerk: Präsentationen aus einem Layout-Katalog
Du wählst Layouts und füllst ihre Felder; Positionen, Schriftgrößen und Farben setzt die Engine. Setze nie Koordinaten.

**Kommen diese Anweisungen bei dir gekürzt an, lies zuerst \`read_guide\` (alle Teile: part 1, 2, …).** Er enthält den Design-Guide und den Layout-Katalog mit allen Feldnamen; ohne ihn rätst du Felder und Gestaltung.

Ablauf: Briefing klären → Storyline als Liste der Titel → \`propose_looks\` oder direkt \`create_deck\` mit eigenem Design → \`add_slides\` in Batches von 4–6 Folien, Rückmeldungen (Autofit, Lint) sofort beheben → \`render_overview\` und \`lint_deck\`, schwächste Folien verbessern → \`save_deck\`.

Kernregeln:
- Eine Botschaft pro Folie; die Titel allein erzählen die Geschichte. Datenfolien: Aussage als Satz (max. ~80 Zeichen); Bühnenfolien (statement, big-number, photo) kurz, auch ein Wort oder eine Frage.
- Zurückhaltung statt Deko: keine Karten-Raster, keine Icons als Schmuck, keine Verläufe oder Sticker. Hierarchie über Größe und Weißraum, eine Akzentfarbe.
- Auf 4 Inhaltsfolien mindestens eine luftige Folie (statement, big-number, photo).
- Höchstens ~40 Wörter pro Folie, Details in die Speaker Notes.
- Stil (\`style\` in create_deck) nach Anlass wählen: mutig für Vortrag, Schule, Event, Kampagne; sachlich für Chef-Update, Antrag, Bericht. Neue Decks im Designtyp nicht wie die letzten (Guide §6 „Abwechslung“).`

export function createMcpServer(engine: Engine, opts: McpOptions = {}): McpServer {
  const home = opts.home ?? join(homedir(), 'Deckwerk')
  let deck: Deck | null = opts.deck ?? null
  let path: string | null = null // …/deck.json, null = noch nie gespeichert
  const outDir = () => (path ? dirname(path) : join(home, 'out'))

  const server = new McpServer({ name: 'deckwerk', version: '0.1.0' }, { instructions: `${INTRO}\n\n${buildSystemPrompt()}` })

  const tools: ToolDef[] = [
    ...buildTools({
      engine,
      getDeck: () => deck,
      setDeck: (d) => { deck = d; opts.onDeck?.(d) },
      assetDir: join(home, 'assets'),
      outDir: outDir(),
      unsplashKey: process.env.UNSPLASH_ACCESS_KEY, // ponytail: Wert beim Start; nach save_deck exportiert export_deck weiter nach ~/Deckwerk/out
    }).map((t) =>
      // Neues Deck = neuer Ordner: sonst überschreibt save_deck das zuvor gespeicherte Deck
      t.name === 'create_deck' ? { ...t, run: async (i: unknown) => { const out = await t.run(i); path = null; return out } } : t,
    ),
    {
      name: 'read_guide',
      description: 'Vollständiger Design-Guide (Storyline, Layout-Wahl, Gestaltung, Text, Animation) und Layout-Katalog mit allen Feldnamen je Layout, in Teilen. Zu Beginn alle Teile lesen, wenn die Server-Anweisungen gekürzt ankommen.',
      inputSchema: z.object({ part: z.number().int().min(1).default(1).describe('Teil 1, 2, … – die Antwort nennt die Anzahl') }),
      async run(i: { part: number }) {
        const parts = guideParts()
        const k = Math.min(i.part, parts.length)
        return { text: `Teil ${k} von ${parts.length}\n\n${parts[k - 1]}${k < parts.length ? `\n\nWeiter: read_guide mit part ${k + 1}.` : ''}` }
      },
    },
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
      description: 'Deck als deck.json speichern (~/Deckwerk/<titel>/deck.json, danach dorthin; ein neues Deck per create_deck bekommt beim Speichern einen eigenen Ordner). Die App kann die Datei öffnen.',
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
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema as z.ZodObject, ...(t.readOnly && { annotations: { readOnlyHint: true } }) }, async (args) => {
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
