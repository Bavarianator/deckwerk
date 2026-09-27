// Theme-Lint-Selbsttest: Anti-Beispiele werden abgelehnt, die Referenz-Themes bestehen, Vorschläge werden verglichen.
// Aufruf: npm run check:theme-lint
import assert from 'node:assert/strict'
import type { ThemeSpec } from '../src/shared/deck'
import { axesOf, lintLooks, lintTheme } from '../src/shared/theme-lint'
import { THEME_REFS } from '../src/shared/theme-refs'

const spec = (bg: string, accent: string, more: Partial<ThemeSpec> = {}): ThemeSpec => ({ name: 'Test', bg, accent, headFont: 'Newsreader', bodyFont: 'Public Sans', radius: 0, decor: 'none', ...more })
const errors = (s: ThemeSpec, override = false) => lintTheme(s, { override }).filter((i) => i.level === 'error').map((i) => i.rule)

const ANTI: [string, ThemeSpec, string][] = [
  ['Lila-Blau', spec('#FFFFFF', '#6366F1'), 'cliche'],
  ['Creme + Terrakotta', spec('#F6F1E7', '#C4552D'), 'bg-tint'],
  ['Schwarz + Säuregrün', spec('#0B0B0B', '#C6FF00'), 'cliche'],
  ['Navy + Gold', spec('#0B1B34', '#C9A227'), 'cliche'],
  ['Slate + Cyan', spec('#0F172A', '#22D3EE'), 'cliche'],
  ['Pastell-Lavendel', spec('#EDE9FE', '#5B21B6'), 'bg-tint'],
  ['Mittelgrau', spec('#8A8A8A', '#111111'), 'bg-mid'],
]
for (const [name, s, rule] of ANTI) assert.ok(errors(s).includes(rule), `${name}: erwartet ${rule}, bekommen ${JSON.stringify(lintTheme(s))}`)

for (const { direction, spec: s } of THEME_REFS) {
  const issues = lintTheme(s)
  assert.deepEqual(issues.filter((i) => i.level === 'error'), [], `${direction}: ${JSON.stringify(issues)}`)
  for (const i of issues.filter((x) => x.level === 'warn')) console.log(`  ! ${direction} [${i.rule}] ${i.message}`)
}
assert.deepEqual(lintLooks(THEME_REFS.map((r) => axesOf(r.spec))).map((i) => i.message), [], 'Referenzen sollen sich deutlich unterscheiden')

// Schriften: Slop nur mit override, Tippfehler mit Vorschlag, Titelschrift nicht als Text
assert.ok(errors(spec('#FFFFFF', '#0B6E4F', { headFont: 'Space Grotesk' })).includes('font'))
assert.deepEqual(errors(spec('#FFFFFF', '#0B6E4F', { headFont: 'Space Grotesk' }), true), [])
assert.match(lintTheme(spec('#FFFFFF', '#0B6E4F', { headFont: 'Inter tigth' }))[0].message, /Inter Tight/)
assert.ok(errors(spec('#FFFFFF', '#0B6E4F', { bodyFont: 'Anton' })).includes('pairing'))
assert.ok(errors(spec('#FFFFFF', '#0B6E4F', { titleSize: 'huge', measure: 'narrow' })).includes('overflow'))

// Zwei fast gleiche Vorschläge fallen auf
const a = spec('#FFFFFF', '#0B6E4F', { name: 'A' }), b = spec('#FDFDFB', '#0E7A57', { name: 'B' })
assert.equal(lintLooks([axesOf(a), axesOf(b)]).length, 1)
console.log(`theme-lint ok · ${ANTI.length} Anti-Beispiele erkannt · ${THEME_REFS.length} Referenzen fehlerfrei`)
