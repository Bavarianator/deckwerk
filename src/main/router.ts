// Router zum Gesprächsstart: Haiku 5.5 wählt einmal die Module (Guide-Abschnitte, Layouts), die die Haupt-KI für diesen
// Auftrag braucht, und bei „Auto“ das Modell; Fehlendes lädt die Haupt-KI später selbst per read_guide. Läuft über den
// Plan des Nutzers (`claude -p`), mit eigenem Key über die API, sonst und bei jedem Fehler greift der Regel-Router.
// Codex und Vibe routen mit einem kleinen Modell desselben Anbieters (der Auftrag geht an keinen zweiten).
// Electron-frei wie tools.ts, damit check-router es unter Node prüft.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { ROUTER_MODEL, type Effort } from '../shared/models'
import { guideIndex, guideModules, ruleRoute, type Route, type RouteInput } from './guide-modules'

// codex/vibe: model = kleines Modell aus der Liste des CLI (ipc.ts, leer = Voreinstellung des CLI), legacy = Vibe kennt --legacy-harness
export type RouterVia = { kind: 'api'; apiKey: string } | { kind: 'claude'; bin: string } | { kind: 'codex'; bin: string; model: string }
  | { kind: 'vibe'; bin: string; model: string; legacy: boolean } | { kind: 'none' }
type Run = (args: string[], stdin: string) => Promise<string>

const MODEL = { opus: 'opus', sonnet: 'sonnet' } as const // Familien wie im Modell-Dropdown (shared/models.ts)
const EFFORTS: Effort[] = ['low', 'medium', 'high']
const SCHEMA = {
  type: 'object',
  properties: {
    modules: { type: 'array', items: { type: 'string' } },
    model: { type: 'string', enum: Object.keys(MODEL) },
    effort: { type: 'string', enum: EFFORTS },
    reason: { type: 'string' },
  },
  required: ['modules', 'reason'],
  additionalProperties: false,
}
// OpenAI verlangt im strikten Schema alle Felder als required; ohne „Auto“ braucht der Router dort kein model
const SCHEMA_CODEX = { type: 'object', properties: { modules: SCHEMA.properties.modules, reason: SCHEMA.properties.reason }, required: ['modules', 'reason'], additionalProperties: false }
const PROFILE = { slides: 'Präsentation (Folien)', social: 'Social Media (4:5, 1:1, 9:16)', doc: 'Dokument/Druck (A4, Visitenkarte)' }

function system(index: string, auto: boolean): string {
  return `Du bist der Router für Deckwerk, eine App, in der eine KI Präsentationen und Drucksachen aus einem festen Layout-Katalog baut und Videos schneidet. Du baust nichts selbst: Du wählst zum Gesprächsstart die Module aus dem Index, die die KI für DIESEN Auftrag braucht. Grundregeln, Arbeitsablauf und häufige Fehler hat sie immer; fehlt ihr später etwas, lädt sie es selbst nach.

${index}

## Regeln
- Nur IDs aus dem Index, genau so geschrieben.
- Großzügig bei Layouts, die zu Format und Anlass passen: lieber ein Layout zu viel als eines, das fehlt. Layouts mit „nur Format …“ nur in diesem Format.
- Immer das Gerüst zum Format: geruest plus geruest-praesentation, geruest-social, geruest-a4 oder geruest-visitenkarte.
- Neues Deck: gestaltung, abwechslung, stil, katalog-themes, katalog-ton; bei mehreren Folien oder Seiten auch storyline und rhythmus.
- Bestehendes Deck und kleine Änderung: wenige Module, nur was der Auftrag berührt.
- animation und katalog-animationen nur, wenn es um Bewegung, Übergänge oder Animation geht.
- ki-bilder nur bei ausdrücklichem Bildwunsch (KI-Bild, Illustration); fotos bei Fotos, Bildern, Logo, QR-Code.
- Zahlen, Daten, Diagramme: inhalt-layout und die passenden Datenlayouts (chart, kpi-grid, table, big-number).
- Texte ändern, übersetzen, kürzen, Notizen: text und deck-auftraege.
- Reiner Video-Auftrag (Video schneiden oder kürzen, Short, Reel, Stream-Highlights, Zusammenschnitt, Untertitel, MP4): nur video und layout:clip, bei Zwischentiteln layout:section und layout:statement; kein Gerüst, keine Gestaltung, keine Storyline. Präsentation mit Video: das Übliche plus video und layout:clip.
- reason: ein kurzer Satz auf Deutsch.
${auto
    ? '\n## Modell\nWähle auch model und effort: opus für neue Decks, Umbauten, Quellmaterial und anspruchsvolle Aufträge (effort high); sonnet für gezielte Änderungen an einem bestehenden Deck (effort medium, low für Tippfehler und Kleinigkeiten).'
    : 'model und effort weglassen.'}`
}

// Rund 6000 Zeichen: gekürzt wird nur angehängtes Quellmaterial in <quelle>, der Auftrag selbst nie
const QUELLE = /<quelle>([\s\S]*?)<\/quelle>/g
function clip(text: string, max = 6000): string {
  const blocks = [...text.matchAll(QUELLE)].map((m) => m[1].length)
  const over = text.length - max
  if (over <= 0 || !blocks.length) return text
  // ponytail: gleicher Anteil je Quelle, mindestens 300 Zeichen; reicht für die Modulwahl
  const each = Math.max(300, Math.floor((blocks.reduce((a, b) => a + b, 0) - over) / blocks.length))
  return text.replace(QUELLE, (all, q: string) => (q.length <= each ? all : `<quelle>${q.slice(0, each)} … (gekürzt)\n</quelle>`))
}

function message(input: RouteInput): string {
  const deck = input.hasDeck
    ? `bestehendes Deck, Format ${PROFILE[input.profile]}, Layouts im Deck: ${[...new Set(input.layoutsInDeck)].join(', ') || 'keine'}`
    : `neues Deck, Format ${PROFILE[input.profile]}`
  return `Deck: ${deck}\n\nAuftrag:\n${clip(input.text)}`
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<never>((_, no) => (t = setTimeout(() => no(new Error(`Zeitlimit ${ms / 1000} s`)), ms)))]).finally(() => clearTimeout(t))
}

// CLI in einem eigenen leeren Ordner (nicht im Repo, keine Projekt-Einstellungen; Vibe vertraut ihm per --trust, daher nicht
// das gemeinsame /tmp, in dem andere Nutzer eine .vibe/ oder AGENTS.md ablegen könnten). Prompt über stdin, nicht in `ps`.
let home: string | undefined
const routerDir = () => (home ??= mkdtempSync(join(tmpdir(), 'deckwerk-router-')))
const spawnRun = (name: string, bin: string, ms: number, env: NodeJS.ProcessEnv): Run => (args, stdin) =>
  new Promise((ok, fail) => {
    const child = spawn(bin, args, { cwd: routerDir(), timeout: ms, killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)))
    child.stdin.on('error', () => {}) // EPIPE, wenn das CLI vorher endet: zählt über den Exit-Code
    child.on('error', fail)
    child.on('close', (code, sig) => (code === 0 ? ok(out) : fail(new Error(`${name} beendet (${code ?? sig}): ${err.trim() || out.trim().slice(0, 300)}`))))
    child.stdin.end(stdin)
  })

// Aufruf von Claude Code: nur das Werkzeug für die strukturierte Antwort, keine Shell oder Dateien, keine Settings,
// Hooks, MCP-Server oder Skills des Nutzers, keine gespeicherte Sitzung. `--tools ""` hängt (variadisch), daher nie leer.
const claudeArgs = (prompt: string) => ['-p', '--model', ROUTER_MODEL, '--effort', 'high', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
  '--tools', 'StructuredOutput', '--setting-sources', '', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--system-prompt', prompt]

async function viaClaude(run: Run, prompt: string, text: string): Promise<unknown> {
  const out = JSON.parse(await run(claudeArgs(prompt), text)) as { is_error?: boolean; result?: string; subtype?: string; structured_output?: unknown }
  if (out.is_error || !out.structured_output) throw new Error(out.result || out.subtype || 'keine strukturierte Antwort')
  return out.structured_output
}

// Codex: kleines Modell, wenig Denken, Antwort nach Schema; keine Shell, keine Konfiguration des Nutzers, keine Sitzung.
// Das Schema liegt in einer Datei (einmal je App-Lauf); der Prompt steht vor dem Auftrag im stdin.
let schemaFile: string | undefined
const codexArgs = (model: string) => ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
  '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'hooks', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"',
  ...(model ? ['-m', model] : []), '-c', 'model_reasoning_effort="low"', '--output-schema',
  (schemaFile ??= (() => { const f = join(routerDir(), 'schema.json'); writeFileSync(f, JSON.stringify(SCHEMA_CODEX)); return f })()), '-']

async function viaCodex(run: Run, model: string, prompt: string, text: string): Promise<unknown> {
  let answer: string | undefined
  for (const line of (await run(codexArgs(model), `${prompt}\n\n---\n\n${text}`)).split('\n')) {
    let e: { type?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string }
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'item.completed' && e.item?.type === 'agent_message') answer = e.item.text
    if (e.type === 'turn.failed' || e.type === 'error') throw new Error(e.error?.message ?? e.message ?? e.type)
  }
  if (!answer) throw new Error('keine Antwort von Codex')
  return JSON.parse(answer)
}

// Vibe: kein Schema und kein Systemprompt per Schalter, daher JSON-Anweisung im Text; keine Werkzeuge (--enabled-tools mit
// einem Namen, den es nicht gibt), keine MCP-Server, eine Runde. Ohne Update-Prüfung, Telemetrie und Projektkontext und mit
// der alten Harness startet es in ~20 statt 30–60 s.
const vibeArgs = (legacy: boolean) => ['-p', ...(legacy ? ['--legacy-harness'] : []), '--output', 'json', '--max-turns', '1', '--enabled-tools', 'keine', '--trust']
const vibeEnv = (model: string) => ({ ...(model && { VIBE_ACTIVE_MODEL: model }), VIBE_MCP_SERVERS: '[]', VIBE_ENABLE_CONNECTORS: 'false', VIBE_ENABLE_UPDATE_CHECKS: 'false',
  VIBE_ENABLE_TELEMETRY: 'false', VIBE_INCLUDE_PROJECT_CONTEXT: 'false', VIBE_ENABLE_NOTIFICATIONS: 'false' })
const JSON_ONLY = '\n\nAntworte nur mit einem JSON-Objekt ohne weiteren Text: {"modules": ["…"], "reason": "…"}'

async function viaVibe(run: Run, legacy: boolean, prompt: string, text: string): Promise<unknown> {
  const msgs = JSON.parse(await run(vibeArgs(legacy), `${prompt}${JSON_ONLY}\n\n---\n\n${text}`)) as { role?: string; content?: string | { type?: string; text?: string }[] }[]
  const last = msgs.filter((m) => m.role === 'assistant').at(-1)?.content
  const reply = typeof last === 'string' ? last : (last ?? []).map((c) => c.text ?? '').join('')
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1) // ohne ```json-Zaun und Vorrede
  if (!json) throw new Error('keine JSON-Antwort von Vibe')
  return JSON.parse(json)
}

async function viaApi(client: Anthropic, prompt: string, text: string, ms: number): Promise<unknown> {
  const msg = await client.messages.create({
    model: ROUTER_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    system: prompt,
    messages: [{ role: 'user', content: text }],
  }, { timeout: ms, maxRetries: 0 })
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') throw new Error(`stop_reason ${msg.stop_reason}`)
  const block = msg.content.find((b) => b.type === 'text')
  if (!block) throw new Error('keine Textantwort')
  return JSON.parse(block.text)
}

// Antwort prüfen: unbekannte IDs fallen weg; Gerüst zum Format (aus ruleRoute) und die Layouts des Decks kommen immer dazu
function toRoute(raw: unknown, input: RouteInput, known: Set<string>, auto: boolean, source: Route['source']): Route {
  const r = (raw ?? {}) as { modules?: unknown; model?: unknown; effort?: unknown; reason?: unknown }
  if (!Array.isArray(r.modules)) throw new Error('Antwort ohne modules')
  const picked = r.modules.filter((id): id is string => typeof id === 'string' && known.has(id))
  if (!picked.length) throw new Error('keine bekannten Module')
  const always = [...ruleRoute(input).modules.filter((id) => id.startsWith('geruest')), ...input.layoutsInDeck.map((id) => `layout:${id}`).filter((id) => known.has(id))]
  // hasOwn: „constructor“ o. ä. darf nicht den Prototyp treffen
  const model = auto && typeof r.model === 'string' && Object.hasOwn(MODEL, r.model) ? MODEL[r.model as keyof typeof MODEL] : undefined
  const modules = [...new Set([...picked, ...always])]
  return {
    modules,
    ...(model && { model, ...(EFFORTS.includes(r.effort as Effort) && { effort: r.effort as Effort }) }),
    source,
    ...(typeof r.reason === 'string' && { reason: r.reason }),
    // reiner Video-Auftrag: Video-Schnitt gewählt und kein Gerüst (auch nicht von den Regeln) → schlanker Kernprompt
    ...(modules.includes('video') && !modules.some((id) => id.startsWith('geruest')) && { video: true as const }),
  }
}

export async function routeTask(
  input: RouteInput,
  via: RouterVia,
  opts: { auto?: boolean; timeoutMs?: number; run?: Run; client?: Anthropic } = {},
): Promise<Route> {
  if (via.kind === 'none') return ruleRoute(input)
  // Vibe startet in ~20 s, Codex ähnlich; Auto-Modellwahl gibt es nur für Claude
  const ms = opts.timeoutMs ?? (via.kind === 'vibe' || via.kind === 'codex' ? 60_000 : 30_000), auto = !!opts.auto && (via.kind === 'api' || via.kind === 'claude')
  try {
    const mods = guideModules(), known = new Set(mods.filter((m) => !m.always).map((m) => m.id))
    const prompt = system(guideIndex(mods), auto), text = message(input)
    const run = (bin: string, env: NodeJS.ProcessEnv) => opts.run ?? spawnRun(via.kind, bin, ms, env)
    const raw = await timeout(
      via.kind === 'claude'
        // ohne Telemetrie und Update-Prüfung startet claude -p in 3–6 statt 7–11 s
        ? viaClaude(run(via.bin, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }), prompt, text)
        : via.kind === 'codex' ? viaCodex(run(via.bin, {}), via.model, prompt, text)
        : via.kind === 'vibe' ? viaVibe(run(via.bin, vibeEnv(via.model)), via.legacy, prompt, text)
        : viaApi(opts.client ?? new Anthropic({ apiKey: via.apiKey }), prompt, text, ms),
      ms,
    )
    return toRoute(raw, input, known, auto, via.kind === 'codex' || via.kind === 'vibe' ? via.kind : 'haiku')
  } catch (e) {
    return { ...ruleRoute(input), reason: `Fallback: ${e instanceof Error ? e.message : String(e)}` }
  }
}
