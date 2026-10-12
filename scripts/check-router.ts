// Router ohne Netz (claude -p und API gemockt): npx esbuild scripts/check-router.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/check-router.mjs && node out/check-router.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Anthropic from '@anthropic-ai/sdk'
import type { RouteInput } from '../src/main/guide-modules'
import { routeTask } from '../src/main/router'

process.env.DECKWERK_HOME = mkdtempSync(join(tmpdir(), 'dw-router-')) // ohne die echten Decks des Nutzers (recentLooks)
const neu: RouteInput = { text: 'Pitch für unser Start-up, 10 Folien', profile: 'slides', layoutsInDeck: [], hasDeck: false }
const deck: RouteInput = { text: 'Animationen ruhiger machen', profile: 'slides', layoutsInDeck: ['kpi-grid', 'chart', 'kpi-grid'], hasDeck: true }
const claude = { kind: 'claude', bin: '/x/claude' } as const
const answer = (structured_output: unknown, extra = {}) => JSON.stringify({ type: 'result', is_error: false, duration_ms: 1, total_cost_usd: 0.001, structured_output, ...extra })

// claude -p: Argumente exakt, Prompt über stdin, structured_output geparst
let seen: { args: string[]; stdin: string } | undefined
let r = await routeTask(deck, claude, {
  run: async (args, stdin) => {
    seen = { args, stdin }
    return answer({ modules: ['animation', 'katalog-animationen', 'gibts-nicht', 'grundregeln', 42], reason: 'Bewegung' })
  },
})
const a = seen!.args, schema = JSON.parse(a[a.indexOf('--json-schema') + 1])
assert.deepEqual(a.slice(0, 7), ['-p', '--model', 'claude-haiku-5-5', '--effort', 'high', '--output-format', 'json'])
assert.deepEqual(a.slice(9, 18), ['--tools', 'StructuredOutput', '--setting-sources', '', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands', '--system-prompt', a[17]])
assert.equal(a.length, 18)
assert.equal(schema.additionalProperties, false)
assert.deepEqual(schema.required, ['modules', 'reason'])
assert.ok(a[17].includes('- layout:kpi-grid – ') && a[17].includes('Router für Deckwerk') && a[17].includes('model und effort weglassen'))
assert.ok(seen!.stdin.includes('Animationen ruhiger machen') && seen!.stdin.includes('bestehendes Deck') && seen!.stdin.includes('kpi-grid, chart'))
// unbekannte IDs und Kernmodule fallen weg, Deck-Layouts und Gerüst kommen dazu, ohne auto kein Modell
assert.equal(r.source, 'haiku')
assert.equal(r.reason, 'Bewegung')
assert.deepEqual(r.modules, ['animation', 'katalog-animationen', 'geruest', 'geruest-praesentation', 'layout:kpi-grid', 'layout:chart'])
assert.equal(r.model, undefined)
assert.equal(r.effort, undefined)

// auto: opus/sonnet → Modell-ID, effort mit; ohne gültiges model kein Modell
r = await routeTask(neu, claude, { auto: true, run: async (args) => (assert.ok(args.at(-1)!.includes('opus für neue Decks')), answer({ modules: ['storyline'], model: 'opus', effort: 'high', reason: 'neu' })) })
assert.deepEqual([r.model, r.effort], ['claude-opus-5-5', 'high'])
assert.ok(r.modules.includes('storyline') && r.modules.includes('geruest-praesentation'))
r = await routeTask(deck, claude, { auto: true, run: async () => answer({ modules: ['animation'], model: 'sonnet', effort: 'low', reason: 'klein' }) })
assert.deepEqual([r.model, r.effort], ['claude-sonnet-5-5', 'low'])
r = await routeTask(deck, claude, { auto: true, run: async () => answer({ modules: ['animation'], model: 'gpt', effort: 'max', reason: '?' }) })
assert.deepEqual([r.model, r.effort, r.source], [undefined, undefined, 'haiku'])
for (const model of ['constructor', 'toString', '__proto__']) {
  r = await routeTask(deck, claude, { auto: true, run: async () => answer({ modules: ['animation'], model, effort: 'high', reason: '?' }) })
  assert.deepEqual([r.model, r.effort], [undefined, undefined], model)
}
r = await routeTask(deck, claude, { run: async () => answer({ modules: ['animation'], model: 'opus', reason: 'x' }) })
assert.equal(r.model, undefined, 'Modell nur bei auto')

// Format: Visitenkarte bekommt ihr Gerüst, auch wenn Haiku es vergisst
r = await routeTask({ text: 'Visitenkarte', profile: 'doc', layoutsInDeck: [], hasDeck: false }, claude, { run: async () => answer({ modules: ['layout:business-card'], reason: 'x' }) })
assert.ok(r.modules.includes('geruest-visitenkarte') && !r.modules.includes('geruest-a4'))

// Fehler aller Art → Regel-Router mit „Fallback: …“
const fallback = async (run: (args: string[], stdin: string) => Promise<string>, why: RegExp, timeoutMs?: number) => {
  const f = await routeTask(deck, claude, { run, timeoutMs })
  assert.equal(f.source, 'regel')
  assert.match(f.reason!, /^Fallback: /)
  assert.match(f.reason!, why)
  assert.ok(f.modules.includes('animation') && f.modules.includes('layout:chart'))
}
await fallback(async () => { throw new Error('claude beendet (1): nicht angemeldet') }, /nicht angemeldet/)
await fallback(() => new Promise(() => {}), /Zeitlimit/, 50)
await fallback(async () => answer(null, { is_error: true, result: 'Rate limit' }), /Rate limit/)
await fallback(async () => 'kein json', /JSON/)
await fallback(async () => answer({ modules: ['gibts-nicht'], reason: 'x' }), /keine bekannten Module/)
await fallback(async () => answer({ reason: 'x' }), /ohne modules/)
assert.equal((await routeTask(deck, { kind: 'none' })).source, 'regel')

// Echter spawn mit Fake-claude: cwd = eigener leerer Ordner, stdin kommt an, Exit-Code ≠ 0 und Zeitlimit → Fallback, Kind wirklich beendet
const bin = mkdtempSync(join(tmpdir(), 'dw-router-bin-'))
const fake = (name: string, body: string) => (writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }), { kind: 'claude', bin: join(bin, name) } as const)
r = await routeTask(deck, fake('ok', `pwd -P > "${bin}/pwd"\ncat > "${bin}/stdin"\necho '${answer({ modules: ['animation'], reason: 'fake' })}'`), { timeoutMs: 5000 })
assert.deepEqual([r.source, r.reason], ['haiku', 'fake'])
const cwd = readFileSync(join(bin, 'pwd'), 'utf8').trim()
assert.ok(cwd.startsWith(join(realpathSync(tmpdir()), 'deckwerk-router-')) && readdirSync(cwd).every((f) => f === 'schema.json'), cwd)
assert.ok(readFileSync(join(bin, 'stdin'), 'utf8').includes('Auftrag:\nAnimationen ruhiger machen'))
r = await routeTask(deck, fake('fail', 'echo kaputt >&2\nexit 3'), { timeoutMs: 5000 })
assert.deepEqual([r.source, r.reason], ['regel', 'Fallback: claude beendet (3): kaputt'])
const t0 = Date.now()
r = await routeTask(deck, fake('hang', `echo $$ > "${bin}/pid"\nexec sleep 60`), { timeoutMs: 300 })
assert.equal(r.source, 'regel')
assert.match(r.reason!, /^Fallback: (Zeitlimit|claude beendet \(SIGKILL\))/)
assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`)
const pid = Number(readFileSync(join(bin, 'pid'), 'utf8'))
const alive = () => { try { return process.kill(pid, 0) } catch { return false } }
for (let i = 0; alive() && i < 20; i++) await new Promise((ok) => setTimeout(ok, 50))
assert.ok(!alive(), `Kind ${pid} läuft noch`)

// Quellmaterial wird gekürzt, der Auftrag nie
const auftrag = `Mach daraus ein Chef-Update. ${'Wichtig! '.repeat(50)}`
await routeTask({ ...neu, text: `${auftrag}\n<quelle>\n${'Q'.repeat(20000)}\n</quelle>` }, claude, {
  run: async (_a, stdin) => {
    assert.ok(stdin.includes(auftrag) && stdin.includes('(gekürzt)') && stdin.length < 7000, `stdin ${stdin.length}`)
    return answer({ modules: ['storyline'], reason: 'x' })
  },
})
const lang = 'x'.repeat(9000)
await routeTask({ ...neu, text: lang }, claude, { run: async (_a, stdin) => (assert.ok(stdin.includes(lang)), answer({ modules: ['storyline'], reason: 'x' })) })

// API: Haiku 5.5, effort high, json_schema; Text-Block als JSON; refusal und max_tokens → Fallback
const api = { kind: 'api', apiKey: 'sk-test' } as const
let req: Anthropic.MessageCreateParamsNonStreaming | undefined
const client = (reply: Partial<Anthropic.Message>) => ({ messages: { create: async (p: typeof req) => ((req = p), { stop_reason: 'end_turn', content: [], ...reply }) } }) as unknown as Anthropic
r = await routeTask(neu, api, { auto: true, client: client({ content: [{ type: 'text', text: JSON.stringify({ modules: ['storyline', 'layout:cover'], model: 'sonnet', effort: 'medium', reason: 'api' }) }] as Anthropic.ContentBlock[] }) })
assert.equal(req!.model, 'claude-haiku-5-5')
assert.equal(req!.output_config!.effort, 'high')
assert.equal(req!.output_config!.format!.type, 'json_schema')
assert.equal((req!.output_config!.format!.schema as { additionalProperties: boolean }).additionalProperties, false)
assert.ok(typeof req!.system === 'string' && req!.system.includes('opus für neue Decks'))
assert.deepEqual([r.source, r.model, r.effort, r.reason], ['haiku', 'claude-sonnet-5-5', 'medium', 'api'])
assert.ok(r.modules.includes('layout:cover') && r.modules.includes('geruest-praesentation'))
for (const stop_reason of ['refusal', 'max_tokens'] as const) {
  r = await routeTask(neu, api, { client: client({ stop_reason, content: [{ type: 'text', text: '{"modules":["storyline"],"reason":"x"}' }] as Anthropic.ContentBlock[] }) })
  assert.deepEqual([r.source, r.reason], ['regel', `Fallback: stop_reason ${stop_reason}`])
}
r = await routeTask(neu, api, { client: { messages: { create: async () => { throw new Error('401') } } } as unknown as Anthropic })
assert.deepEqual([r.source, r.reason], ['regel', 'Fallback: 401'])

// Codex: kleines Modell, Schema-Datei, keine Shell und keine Konfiguration des Nutzers; Antwort aus dem JSONL-Strom
const codex = { kind: 'codex', bin: '/x/codex', model: 'gpt-5.6-luna' } as const
const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join('\n')
seen = undefined
r = await routeTask(deck, codex, {
  auto: true,
  run: async (args, stdin) => {
    seen = { args, stdin }
    return jsonl({ type: 'thread.started', thread_id: 't' }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ modules: ['animation', 'gibts-nicht'], reason: 'codex' }) } }, { type: 'turn.completed' })
  },
})
{
  const a = seen!.args
  assert.deepEqual(a.slice(0, 6), ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules'])
  for (const f of ['shell_tool', 'unified_exec', 'hooks']) assert.equal(a[a.indexOf(f) - 1], '--disable', f)
  assert.ok(a.includes('sandbox_mode="read-only"') && a.includes('approval_policy="never"') && a.at(-1) === '-')
  assert.equal(a[a.indexOf('-m') + 1], 'gpt-5.6-luna')
  const s = JSON.parse(readFileSync(a[a.indexOf('--output-schema') + 1], 'utf8'))
  assert.deepEqual([s.required, s.additionalProperties, Object.keys(s.properties)], [['modules', 'reason'], false, ['modules', 'reason']], 'striktes Schema: alle Felder required')
  assert.ok(seen!.stdin.startsWith('Du bist der Router') && seen!.stdin.includes('Auftrag:\nAnimationen ruhiger machen') && seen!.stdin.includes('model und effort weglassen'))
  assert.ok(a.every((x) => x.length < 1000), 'Prompt nicht in den Argumenten')
}
assert.deepEqual([r.source, r.reason, r.model], ['codex', 'codex', undefined], 'kein Auto-Modell für Codex')
assert.ok(r.modules.includes('animation') && r.modules.includes('layout:chart') && !r.modules.includes('gibts-nicht'))
assert.ok(!(await routeTask(deck, { ...codex, model: '' }, { run: async (args) => (assert.ok(!args.includes('-m')), jsonl({ type: 'item.completed', item: { type: 'agent_message', text: '{"modules":["text"],"reason":"x"}' } })) })).reason?.startsWith('Fallback'))
r = await routeTask(deck, codex, { run: async () => jsonl({ type: 'turn.failed', error: { message: 'nicht angemeldet' } }) })
assert.deepEqual([r.source, r.reason], ['regel', 'Fallback: nicht angemeldet'])
r = await routeTask(deck, codex, { run: async () => jsonl({ type: 'turn.completed' }) })
assert.deepEqual([r.source, r.reason], ['regel', 'Fallback: keine Antwort von Codex'])

// Vibe: Modell per Umgebung, keine Werkzeuge und MCP-Server, JSON aus der letzten Antwort (auch mit Zaun und Vorrede)
const vibe = { kind: 'vibe', bin: '/x/vibe', model: 'devstral-small', legacy: true } as const
const vibeOut = (text: unknown) => JSON.stringify([{ role: 'user', content: [{ type: 'text', text: 'x' }] }, { role: 'assistant', content: [{ type: 'text', text }] }])
seen = undefined
r = await routeTask({ text: 'Schneide mein Video zu einem Short', profile: 'slides', layoutsInDeck: [], hasDeck: false }, vibe, {
  run: async (args, stdin) => ((seen = { args, stdin }), vibeOut('Gern:\n```json\n{"modules": ["video", "layout:clip"], "reason": "Video"}\n```')),
})
assert.deepEqual(seen!.args, ['-p', '--legacy-harness', '--output', 'json', '--max-turns', '1', '--enabled-tools', 'keine', '--trust'])
assert.ok(seen!.stdin.includes('Antworte nur mit einem JSON-Objekt') && seen!.stdin.includes('Reiner Video-Auftrag'))
assert.deepEqual([r.source, r.modules, r.video], ['vibe', ['video', 'layout:clip'], true], 'reiner Video-Auftrag ohne Gerüst')
r = await routeTask(deck, vibe, { run: async () => vibeOut('Weiß ich nicht.') })
assert.deepEqual([r.source, r.reason], ['regel', 'Fallback: keine JSON-Antwort von Vibe'])
// echter spawn: Umgebung kommt an (Modell, MCP-Server leer, ohne Telemetrie), ohne Modell bleibt die Voreinstellung
const fakeVibe = (model: string) => ({ ...vibe, legacy: false, model, bin: fake(`vibe${model}`, `env > "${bin}/env"\ncat > /dev/null\necho '${vibeOut('{"modules":["text"],"reason":"env"}')}'`).bin })
r = await routeTask(deck, fakeVibe('devstral-small'), { timeoutMs: 5000 })
let env = readFileSync(join(bin, 'env'), 'utf8')
assert.deepEqual([r.source, r.reason], ['vibe', 'env'])
for (const v of ['VIBE_ACTIVE_MODEL=devstral-small', 'VIBE_MCP_SERVERS=[]', 'VIBE_ENABLE_TELEMETRY=false', 'VIBE_ENABLE_UPDATE_CHECKS=false', 'VIBE_INCLUDE_PROJECT_CONTEXT=false']) assert.ok(env.includes(v), v)
await routeTask(deck, fakeVibe(''), { timeoutMs: 5000 })
env = readFileSync(join(bin, 'env'), 'utf8')
assert.ok(!env.includes('VIBE_ACTIVE_MODEL=') || env.includes(`VIBE_ACTIVE_MODEL=${process.env.VIBE_ACTIVE_MODEL ?? ''}\n`))

// Haiku: Video-Auftrag mit Gerüst (z. B. Präsentation mit Video) ist kein reiner Video-Auftrag
r = await routeTask(neu, claude, { run: async () => answer({ modules: ['video', 'layout:clip'], reason: 'x' }) })
assert.equal(r.video, undefined)

console.log('check-router: ok')
