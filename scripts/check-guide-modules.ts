// Guide-Module, Kernprompt und Regel-Router: npx esbuild scripts/check-guide-modules.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/check-guide-modules.mjs && node out/check-guide-modules.mjs
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LAYOUT_IDS } from '../src/shared/layouts'
import { corePrompt, fullPrompt, guideModules, modulesText, ruleRoute, type RouteInput } from '../src/main/guide-modules'

process.env.DECKWERK_HOME = mkdtempSync(join(tmpdir(), 'dw-guide-')) // ohne die echten Decks des Nutzers (recentLooks)
const mods = guideModules(), ids = new Set(mods.map((m) => m.id))
assert.equal(ids.size, mods.length, `doppelte IDs: ${mods.map((m) => m.id).filter((id, i, a) => a.indexOf(id) !== i)}`)
// Jede Überschrift gehört genau einem Modul, zusammen ergeben die Module den vollen Prompt (Guide, Katalog, Ablauf)
const heads = (s: string) => s.split('\n').filter((l) => /^#{1,3} /.test(l)).length
for (const m of mods) assert.equal(heads(m.text), 1, `${m.id}: genau eine Überschrift am Anfang`)
assert.equal(heads(fullPrompt()), mods.length)
const flat = (s: string) => s.replace(/\s+/g, ' ')
assert.equal(flat(mods.map((m) => m.text).join('\n\n')), flat(fullPrompt()), 'Module decken Guide und Katalog vollständig ab')
for (const id of LAYOUT_IDS) assert.ok(ids.has(`layout:${id}`), `layout:${id}`)
for (const id of ['grundregeln', 'storyline', 'geruest-praesentation', 'geruest-social', 'geruest-a4', 'geruest-visitenkarte', 'inhalt-layout', 'rhythmus', 'gestaltung', 'abwechslung', 'stil', 'fotos', 'ki-bilder', 'text', 'animation', 'ablauf', 'deck-auftraege', 'fehler', 'katalog-themes', 'katalog-ton', 'katalog-animationen'])
  assert.ok(ids.has(id), id)

const core = corePrompt()
assert.ok(core.length < 25000, `Kernprompt ${core.length} Zeichen`)
assert.equal(core, corePrompt(), 'Kernprompt stabil (Caching)')
assert.ok(core.includes('## 1. Grundregeln') && core.includes('- layout:kpi-grid – Kennzahlen – ') && core.includes('- gestaltung – ') && !core.includes('"maxLength"'))
assert.match(modulesText(['layout:kpi-grid']), /^### kpi-grid – [\s\S]*Schema: \{[\s\S]*"maxLength"/)
assert.match(modulesText(['text', 'storyline', 'gibts-nicht']), /^## 2\. Storyline[\s\S]*\n\n## 7\. Text/, 'feste Reihenfolge, Unbekanntes fällt weg')
assert.equal(modulesText(['gibts-nicht']), '')

const route = (text: string, o: Partial<RouteInput> = {}) => {
  const r = ruleRoute({ text, profile: 'slides', layoutsInDeck: [], hasDeck: false, ...o })
  assert.equal(r.source, 'regel')
  for (const id of r.modules) assert.ok(ids.has(id) && !mods.find((m) => m.id === id)!.always, `${text}: ${id}`)
  return new Set(r.modules)
}
let r = route('Mach mir eine Visitenkarte für unser Büro')
assert.ok(r.has('layout:business-card') && r.has('geruest-visitenkarte') && !r.has('layout:cover') && !r.has('layout:doc-text'))
assert.ok(route('Bitte die Folien dezent animieren', { layoutsInDeck: ['cover'], hasDeck: true }).has('animation'))
r = route('Telefonnummer ändern', { profile: 'doc', layoutsInDeck: ['business-card', 'kpi-grid'], hasDeck: true })
assert.ok(r.has('layout:kpi-grid') && r.has('layout:business-card') && !r.has('layout:letter'))
r = route('Pitch für unser Startup, 12 Folien')
assert.ok(r.has('geruest-praesentation') && r.has('gestaltung') && r.has('stil') && r.has('layout:cover') && !r.has('layout:flyer'))
r = route('Instagram-Karussell mit 5 Tipps')
assert.ok(r.has('geruest-social') && r.has('layout:big-number') && !r.has('layout:agenda') && !r.has('geruest-praesentation'))
r = route('Kurzes Briefing: Vortrag zur Strategie')
assert.ok(!r.has('geruest-a4') && r.has('geruest-praesentation'), 'Briefing ist kein Brief')
r = route('Seite 2 kürzen', { profile: 'doc', layoutsInDeck: ['doc-text'], hasDeck: true })
assert.ok(r.has('geruest-a4') && r.has('layout:offer') && r.has('text') && !r.has('gestaltung'))
assert.ok(route('Lebenslauf und Anschreiben für die Bewerbung').has('layout:cv'))

const size = (id: string) => mods.find((m) => m.id === id)!.text.length
console.log(`Guide-Module OK · ${mods.length} Module · Kernprompt ${core.length} · voll ${fullPrompt().length} · gestaltung ${size('gestaltung')} · stil ${size('stil')} · geruest-a4 ${size('geruest-a4')} · layout:kpi-grid ${size('layout:kpi-grid')} · layout:letter ${size('layout:letter')}`)
