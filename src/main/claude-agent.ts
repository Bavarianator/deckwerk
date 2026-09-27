// Chat ohne API-Key über ein Agenten-CLI mit dem Login des Nutzers: Claude Code (`claude -p`), Codex (`codex exec`) oder
// Mistral Vibe (`vibe -p`). Jedes bekommt die Deck-Tools über einen lokalen MCP-Server (HTTP auf 127.0.0.1, Bearer-Token)
// im Main-Prozess und sonst nichts: keine Shell, keine Dateiwerkzeuge. Ein präpariertes Quelldokument kann so keine Befehle
// auf dem Rechner ausführen. Gleiche Schnittstelle wie DeckAgent.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

export type Cli = 'claude' | 'codex' | 'vibe'
export const CLIS: Cli[] = ['claude', 'codex', 'vibe']
export const CLI_NAME: Record<Cli, string> = { claude: 'Claude Code', codex: 'Codex', vibe: 'Vibe' }

// ~/.local/bin fehlt im PATH, wenn die App über den Desktop-Eintrag startet (Claude Code und Vibe installieren dorthin)
export function findCli(cli: Cli): string | null {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local/bin'), join(homedir(), '.claude/local')]
  return dirs.map((d) => join(d, cli)).find((p) => existsSync(p)) ?? null
}
export const findClaude = () => findCli('claude')

let current: ToolDef[] = [] // Tools des gerade laufenden Gesprächs
type Mcp = { file: string; url: string; token: string } // file: --mcp-config für Claude Code; Codex und Vibe bekommen url + token
let mcp: Promise<Mcp> | null = null

// Ein HTTP-Server pro App-Lauf, zustandslos (neuer McpServer pro Anfrage). Token nie auf der Kommandozeile, damit er nicht
// in `ps` steht: für Claude Code in einer 0600-Datei, für Codex und Vibe in einer Umgebungsvariable des Kindprozesses.
// Ohne Token kommt kein anderer Prozess und keine Webseite an die Tools.
function serve(): Promise<Mcp> {
  mcp ??= new Promise((ok, fail) => {
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
      const dir = mkdtempSync(join(tmpdir(), 'deckwerk-'))
      process.once('exit', () => rmSync(dir, { recursive: true, force: true })) // Token-Datei nicht in /tmp liegen lassen
      const file = join(dir, 'mcp.json')
      writeFileSync(file, JSON.stringify({ mcpServers: { deckwerk: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 })
      ok({ file, url, token })
    })
  })
  return mcp
}

const TOKEN_ENV = 'DECKWERK_MCP_TOKEN'

// Kennt dieses Programm den Schalter? (`--help` einmal je App-Lauf; ein CLI-Update ohne ihn darf den Chat nicht brechen)
const flags = new Map<string, Promise<string>>()
const hasFlag = async (bin: string, flag: string) => {
  if (!flags.has(bin)) flags.set(bin, new Promise((ok) => execFile(bin, ['--help'], { timeout: 20_000 }, (_e, out) => ok(String(out ?? '')))))
  return (await flags.get(bin)!).includes(flag)
}

// Aufruf je CLI. Alles, was die Werkzeuge einschränkt, steht hier; bei einer neuen CLI-Version zuerst das prüfen.
// model: Claude-Modell-ID bzw. Modell von Codex/Vibe (leer = deren Voreinstellung)
function invocation(cli: Cli, m: Mcp, session: string | null, model: string, text: string, legacy: boolean): { args: string[]; env: NodeJS.ProcessEnv; stdin: string } {
  if (cli === 'claude')
    // --setting-sources "": keine Hooks/Plugins aus den Settings des Nutzers, Login bleibt (--safe-mode würde auch unseren
    // MCP-Server abschalten, --bare den Abo-Login). --tools: nur Deck-Tools plus Web-Recherche.
    return { env: {}, stdin: text, args: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--setting-sources', '', '--disable-slash-commands',
      '--mcp-config', m.file, '--strict-mcp-config', '--tools', 'WebSearch,WebFetch', '--allowedTools', 'mcp__deckwerk,WebSearch,WebFetch',
      '--system-prompt', buildSystemPrompt(), '--model', model, ...(session ? ['--resume', session] : [])] }
  if (cli === 'codex')
    // --ignore-user-config: weder MCP-Server noch Profile des Nutzers, nur unser Server (der Login bleibt). Shell- und
    // Exec-Werkzeuge aus, Sandbox nur lesen, nie nachfragen. `exec resume` kennt --sandbox nicht, daher sandbox_mode per -c.
    return { env: { [TOKEN_ENV]: m.token }, stdin: text, args: ['exec', ...(session ? ['resume', session] : []), '--json', '--skip-git-repo-check',
      '--ignore-user-config', '--ignore-rules', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'hooks',
      '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', ...(model ? ['-c', `model=${JSON.stringify(model)}`] : []),
      '-c', `mcp_servers={deckwerk={url=${JSON.stringify(m.url)},bearer_token_env_var="${TOKEN_ENV}",tool_timeout_sec=300}}`,
      '-c', `developer_instructions=${JSON.stringify(buildSystemPrompt())}`, '-'] }
  // Vibe: VIBE_MCP_SERVERS ersetzt die MCP-Server des Nutzers durch unseren. --enabled-tools sperrt im -p-Modus alle anderen
  // Werkzeuge (Shell, Dateien); --auto-approve gilt nur für die freigegebenen. VIBE_* überschreibt Felder der Konfiguration,
  // hier das Modell. Einen eigenen Systemprompt nimmt Vibe nur aus VIBE_HOME (nicht aus dem Arbeitsordner), daher steht er
  // vor der ersten Nachricht. Die alte Harness bietet die MCP-Werkzeuge direkt an statt über eine Werkzeugsuche, das spart
  // Runden (gemessen 2:04 statt 2:35 min).
  return {
    env: { [TOKEN_ENV]: m.token, VIBE_ENABLE_CONNECTORS: 'false', ...(model && { VIBE_ACTIVE_MODEL: model }),
      VIBE_MCP_SERVERS: JSON.stringify([{ name: 'deckwerk', transport: 'streamable-http', url: m.url, api_key_env: TOKEN_ENV, tool_timeout_sec: 300 }]) },
    stdin: session ? text : `${buildSystemPrompt()}\n\n---\n\nAnfrage:\n${text}`,
    args: ['-p', ...(legacy ? ['--legacy-harness'] : []), '--output', 'streaming', '--enabled-tools', 'deckwerk_*', '--enabled-tools', 'web_search', '--enabled-tools', 'web_fetch',
      '--auto-approve', '--trust', ...(session ? ['--resume', session] : [])],
  }
}

export class CliAgent {
  deck: Deck | null
  model: string // Claude-Modell-ID bzw. Modell von Codex/Vibe, pro Nachricht umschaltbar (leer = deren Voreinstellung)
  private tools: ToolDef[]
  private session: string | null = null // Gesprächsverlauf liegt beim CLI (--resume bzw. exec resume)
  private seen = new Set<string>() // Vibe: IDs schon gezeigter Antworten; --resume spielt sie erneut aus (alte Harness mit neuer Zeit)
  private child: ChildProcess | null = null
  private aborted = false

  constructor(private cli: Cli, private bin: string, private opts: DeckAgentOptions) {
    this.deck = opts.deck ?? null
    this.model = opts.model ?? (cli === 'claude' ? DEFAULT_MODEL : '')
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
      const m = await serve()
      current = this.tools
      const cwd = join(homedir(), 'Deckwerk') // Sitzungen tauchen im jeweiligen CLI unter ~/Deckwerk auf
      mkdirSync(cwd, { recursive: true })
      const run = invocation(this.cli, m, this.session, this.model, userText, this.cli === 'vibe' && (await hasFlag(this.bin, '--legacy-harness')))
      const child = (this.child = spawn(this.bin, run.args, { cwd, env: { ...process.env, ...run.env }, stdio: ['pipe', 'pipe', 'pipe'] }))
      // Vibe und Codex denken oft minutenlang, bevor das erste Werkzeug läuft: Status zeigen, solange das CLI arbeitet
      if (this.cli !== 'claude') emit({ type: 'tool', name: 'cli_run', status: 'start', summary: `${CLI_NAME[this.cli]} braucht oft ein paar Minuten` })
      child.stdin.end(run.stdin) // Prompt über stdin: kein Flag-Parsing von Nutzertext, nicht in `ps`
      let stderr = ''
      child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
      const s = { result: false, lastError: '', said: false, web: null as string | null, seen: this.seen, since: Date.now() }
      for await (const line of createInterface({ input: child.stdout })) {
        const msg = parse(line)
        if (msg) this.handle(msg, s)
      }
      const code = await new Promise<number | null>((r) => (child.exitCode !== null ? r(child.exitCode) : child.once('close', r)))
      // Claude und Codex melden das Ende des Turns selbst, Vibe nur über den Exit-Code
      if (!s.result && !this.aborted && (this.cli !== 'vibe' || code !== 0))
        emit({ type: 'error', message: `${CLI_NAME[this.cli]} beendet (Code ${code}): ${s.lastError || stderr.trim() || 'keine Ausgabe'}` })
    } catch (e) {
      emit({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      this.child = null
      if (this.cli !== 'claude') emit({ type: 'tool', name: 'cli_run', status: 'done' })
      emit({ type: 'done' })
    }
  }

  // Eine JSON-Zeile des CLI in UI-Events übersetzen. Die Deck-Tools melden ihren Status selbst (withEvents).
  private handle(msg: Record<string, unknown>, s: { result: boolean; lastError: string; said: boolean; web: string | null; seen: Set<string>; since: number }): void {
    const emit = this.opts.onEvent
    const say = (t: string) => { if (t) { emit({ type: 'text', delta: (s.said ? '\n\n' : '') + t }); s.said = true } }
    if (this.cli === 'claude') {
      const c = msg as ClaudeMsg
      if (c.session_id) this.session = c.session_id
      // WebSearch/WebFetch sind eingebaute Tools, nicht über den MCP-Server: Status-Chip aus dem Stream
      const b = c.type === 'stream_event' && c.event?.type === 'content_block_start' ? c.event.content_block : undefined
      if (b?.type === 'tool_use' && WEB[b.name!]) emit({ type: 'tool', name: (s.web = WEB[b.name!]), status: 'start' })
      if (c.type === 'user' && s.web) { emit({ type: 'tool', name: s.web, status: 'done' }); s.web = null }
      if (c.type === 'stream_event' && c.event?.type === 'content_block_delta' && c.event.delta?.type === 'text_delta') emit({ type: 'text', delta: c.event.delta.text })
      if (c.type === 'result') {
        s.result = true
        if (c.is_error && !this.aborted) emit({ type: 'error', message: c.result || (c.errors ?? []).join('\n') || `Claude Code: ${c.subtype}` })
      }
    } else if (this.cli === 'codex') {
      const c = msg as CodexMsg
      if (c.type === 'thread.started' && c.thread_id) this.session = c.thread_id
      if (c.type === 'item.completed' && c.item?.type === 'agent_message') say(c.item.text ?? '')
      if (c.type === 'error' && c.message) s.lastError = c.message // „Reconnecting …“ u. ä.: zählt erst, wenn der Turn scheitert
      if (c.type === 'turn.completed') s.result = true
      if (c.type === 'turn.failed') {
        s.result = true
        const why = c.error?.message || s.lastError || 'Anfrage fehlgeschlagen'
        if (!this.aborted) emit({ type: 'error', message: /401|Unauthorized/.test(why) ? 'Codex ist nicht angemeldet. Einmal im Terminal `codex login` ausführen.' : `Codex: ${why}` })
      }
    } else {
      const v = msg as VibeMsg
      if (v.sessionId) this.session = v.sessionId
      // --resume spielt den bisherigen Verlauf erneut aus: nur Antworten aus dieser Anfrage zeigen
      if (v.type === 'message' && v.role === 'assistant' && v.generationStatus === 'completed' && v.id && !s.seen.has(v.id) && (v.createdAt ?? Infinity) >= s.since) {
        s.seen.add(v.id)
        say(typeof v.content === 'string' ? v.content : (v.content ?? []).map((p) => p.text ?? '').join(''))
      }
    }
  }

  abort(): void {
    this.aborted = true
    this.child?.kill('SIGINT')
  }

  setDeck(deck: Deck): void { this.deck = deck }
}

type ClaudeMsg = {
  type?: string; subtype?: string; session_id?: string; is_error?: boolean; result?: string; errors?: string[]
  event?: { type?: string; delta?: { type?: string; text: string }; content_block?: { type?: string; name?: string } }
}
type CodexMsg = { type?: string; thread_id?: string; message?: string; item?: { type?: string; text?: string }; error?: { message?: string } }
type VibeMsg = { type?: string; role?: string; id?: string; sessionId?: string; generationStatus?: string; createdAt?: number; content?: string | { type?: string; text?: string }[] }
const WEB: Record<string, string> = { WebSearch: 'web_search', WebFetch: 'web_fetch' }
function parse(line: string): Record<string, unknown> | null {
  try { return JSON.parse(line) } catch { return null }
}
