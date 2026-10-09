// CLI-Weg (claude, codex, vibe): Kernprompt statt vollem Prompt, Router-Module nur in der ersten Nachricht: npx esbuild scripts/check-cli-prompt.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=${TMPDIR:-/tmp}/check-cli-prompt.mjs && node ${TMPDIR:-/tmp}/check-cli-prompt.mjs
import assert from 'node:assert/strict'
import { DEFAULT_MODEL } from '../src/shared/models'
import { CLIS, firstMessage, invocation } from '../src/main/claude-agent'
import { corePrompt, fullPrompt, modulesText, type Route } from '../src/main/guide-modules'

const MAX_ARG = 131072 // Linux: MAX_ARG_STRLEN, darüber scheitert spawn mit E2BIG
const m = { file: '/x/mcp.json', url: 'http://127.0.0.1:1/mcp', token: 't' }
const route: Route = { modules: ['animation', 'layout:chart'], source: 'regel' }
const core = corePrompt(), lead = firstMessage('Hallo', route)
assert.ok(fullPrompt().length > core.length, 'Kernprompt kürzer als der volle Prompt')

// Form wie im API-Weg: <leitfaden>…</leitfaden>, Leerzeile, Nutzertext
assert.equal(firstMessage('Hallo'), 'Hallo', 'ohne Route nur der Nutzertext')
assert.equal(firstMessage('Hallo', { ...route, modules: [] }), 'Hallo', 'ohne Module nur der Nutzertext')
assert.match(lead, /^<leitfaden>\n[\s\S]+\n<\/leitfaden>\n\nHallo$/)
assert.ok(lead.includes(modulesText(route.modules)), 'Modultexte im Leitfaden')
assert.ok(lead.includes('Für diesen Auftrag ausgewählt (Router): animation, layout:chart. Weitere Module mit read_guide.'))

for (const cli of CLIS) {
  const model = cli === 'claude' ? DEFAULT_MODEL : ''
  const first = invocation(cli, m, null, model, 'Hallo', false, 'high', route)
  const next = invocation(cli, m, 'sitzung', model, 'Weiter', false, 'high', route)
  for (const r of [first, next]) for (const a of r.args) assert.ok(Buffer.byteLength(a) < MAX_ARG, `${cli}: Argument mit ${a.length} Zeichen`)
  assert.ok(!first.args.concat(next.args).some((a) => a.includes(fullPrompt())), `${cli}: kein voller Prompt im Argument`)
  if (cli === 'vibe') {
    // Vibe kennt keinen Systemprompt per Schalter: Kernprompt nur vor der ersten Nachricht
    assert.ok(first.stdin.startsWith(core), 'vibe: Kernprompt vor der ersten Nachricht')
    assert.ok(first.stdin.endsWith(lead), 'vibe: Leitfaden und Nutzertext in der ersten Nachricht')
  } else {
    for (const r of [first, next]) assert.ok(r.args.some((a) => a.includes(core) || a.includes(JSON.stringify(core))), `${cli}: Kernprompt im Argument`)
    assert.equal(first.stdin, lead, `${cli}: Leitfaden in der ersten Nachricht`)
  }
  assert.equal(next.stdin, 'Weiter', `${cli}: Folgenachricht ohne Leitfaden und Prompt`)
}
console.log('check-cli-prompt: ok')
