// Chat ohne API-Key: `claude -p` (Claude Code mit dem Abo-Login des Nutzers) bekommt die Deck-Tools über einen lokalen
// MCP-Server (HTTP auf 127.0.0.1, Bearer-Token) im Main-Prozess. Gleiche Schnittstelle wie DeckAgent.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Deck } from '../shared/deck'
import { DEFAULT_MODEL } from '../shared/models'
import { buildSystemPrompt, withEvents, type DeckAgentOptions } from './agent'
import { serveTools } from './mcp'
import { buildTools, type ToolDef } from './tools'

// ~/.local/bin fehlt im PATH, wenn die App über den Desktop-Eintrag startet
export function findClaude(): string | null {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local/bin'), join(homedir(), '.claude/local')]
  return dirs.map((d) => join(d, 'claude')).find((p) => existsSync(p)) ?? null
}

let current: ToolDef[] = [] // Tools des gerade laufenden Gesprächs
let config: Promise<string> | null = null // Pfad der --mcp-config-Datei

// Ein HTTP-Server pro App-Lauf, zustandslos (neuer McpServer pro Anfrage). Token in einer 0600-Datei statt auf der
// Kommandozeile, damit er nicht in `ps` steht; ohne Token kommt kein anderer Prozess und keine Webseite an die Tools.
function serve(): Promise<string> {
  config ??= new Promise((ok, fail) => {
    const token = randomBytes(24).toString('hex')
    const http = createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end()
      const server = new McpServer({ name: 'deckwerk', version: '0.1.0' })
      serveTools(server, current)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => void server.close())
      try {
        await server.connect(transport)
        await transport.handleRequest(req, res)
      } catch (e) {
        if (!res.headersSent) res.writeHead(500).end(String(e))
      }
    })
    http.on('error', fail)
    http.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`
      const file = join(mkdtempSync(join(tmpdir(), 'deckwerk-')), 'mcp.json')
      writeFileSync(file, JSON.stringify({ mcpServers: { deckwerk: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 })
      ok(file)
    })
  })
  return config
}

export class ClaudeAgent {
  deck: Deck | null
  model: string // pro Nachricht umschaltbar, Claude Code nimmt es per --model
  private tools: ToolDef[]
  private session: string | null = null // --resume: Gesprächsverlauf liegt bei Claude Code
  private child: ChildProcess | null = null
  private aborted = false

  constructor(private claude: string, private opts: DeckAgentOptions) {
    this.deck = opts.deck ?? null
    this.model = opts.model ?? DEFAULT_MODEL
    this.tools = buildTools({
      engine: opts.engine,
      getDeck: () => this.deck,
      setDeck: (deck) => { this.deck = deck; opts.onEvent({ type: 'deck', deck }) },
      assetDir: opts.assetDir ?? join(homedir(), 'Deckwerk/assets'),
      outDir: opts.outDir ?? join(homedir(), 'Deckwerk/out'),
      unsplashKey: opts.unsplashKey ?? process.env.UNSPLASH_ACCESS_KEY,
      ask: (q) => opts.onEvent({ type: 'ask', ...q }),
      storyline: (slides) => opts.onEvent({ type: 'storyline', slides }),
      choice: (c) => opts.onEvent({ type: 'choice', ...c }),
    }).map((t) => withEvents(t, opts.onEvent))
  }

  async send(userText: string): Promise<void> {
    const emit = this.opts.onEvent
    this.aborted = false
    try {
      const mcpConfig = await serve()
      current = this.tools
      const cwd = join(homedir(), 'Deckwerk') // Sitzungen tauchen in Claude Code unter ~/Deckwerk auf
      mkdirSync(cwd, { recursive: true })
      // --setting-sources "": keine Hooks/Plugins aus den Settings des Nutzers, Login bleibt (--safe-mode würde auch unseren
      // MCP-Server abschalten, --bare den Abo-Login). --tools: nur Deck-Tools plus Web-Recherche.
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--setting-sources', '', '--disable-slash-commands',
        '--mcp-config', mcpConfig, '--strict-mcp-config', '--tools', 'WebSearch,WebFetch', '--allowedTools', 'mcp__deckwerk,WebSearch,WebFetch',
        '--system-prompt', buildSystemPrompt(), '--model', this.model, ...(this.session ? ['--resume', this.session] : [])]
      const child = (this.child = spawn(this.claude, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }))
      child.stdin.end(userText) // Prompt über stdin: kein Flag-Parsing von Nutzertext
      let stderr = ''
      let result = false
      child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
      let web: string | null = null
      for await (const line of createInterface({ input: child.stdout })) {
        const m = parse(line)
        if (m?.session_id) this.session = m.session_id
        // WebSearch/WebFetch sind eingebaute Tools, nicht über den MCP-Server: Status-Chip aus dem Stream
        const b = m?.type === 'stream_event' && m.event?.type === 'content_block_start' ? m.event.content_block : undefined
        if (b?.type === 'tool_use' && WEB[b.name!]) emit({ type: 'tool', name: (web = WEB[b.name!]), status: 'start' })
        if (m?.type === 'user' && web) { emit({ type: 'tool', name: web, status: 'done' }); web = null }
        if (m?.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') emit({ type: 'text', delta: m.event.delta.text })
        if (m?.type === 'result') {
          result = true
          if (m.is_error && !this.aborted) emit({ type: 'error', message: m.result || (m.errors ?? []).join('\n') || `Claude Code: ${m.subtype}` })
        }
      }
      const code = await new Promise<number | null>((r) => (child.exitCode !== null ? r(child.exitCode) : child.once('close', r)))
      if (!result && !this.aborted) emit({ type: 'error', message: `Claude Code beendet (Code ${code}): ${stderr.trim() || 'keine Ausgabe'}` })
    } catch (e) {
      emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.child = null
      emit({ type: 'done' })
    }
  }

  abort(): void {
    this.aborted = true
    this.child?.kill('SIGINT')
  }

  setDeck(deck: Deck): void { this.deck = deck }
}

type StreamMsg = {
  type?: string; subtype?: string; session_id?: string; is_error?: boolean; result?: string; errors?: string[]
  event?: { type?: string; delta?: { type?: string; text: string }; content_block?: { type?: string; name?: string } }
}
const WEB: Record<string, string> = { WebSearch: 'web_search', WebFetch: 'web_fetch' }
function parse(line: string): StreamMsg | null {
  try { return JSON.parse(line) } catch { return null }
}
