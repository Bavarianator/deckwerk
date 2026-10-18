// Theme-Editor (Spec aus Katalog-Theme, Ref zur Spec): npx esbuild scripts/check-theme-editor.ts --bundle --platform=node --format=esm --loader:.css=empty --outfile=${TMPDIR:-/tmp}/check-theme-editor.mjs && node ${TMPDIR:-/tmp}/check-theme-editor.mjs
import assert from 'node:assert/strict'
import { CATALOG_THEMES, ensureContrast, resolveTheme } from '../src/shared/themes'
import { guardNotes, refOf, specOf } from '../src/renderer/ui/ThemeEditor'

// Katalog-Theme ausgeklappt sieht als eigenes Theme gleich aus
for (const t of CATALOG_THEMES) {
  const a = resolveTheme({ id: t.id }), spec = specOf({ id: t.id }), b = resolveTheme(refOf({ id: t.id }, spec))
  for (const k of ['dark', 'radius', 'decor', 'rule', 'elements', 'headScale', 'sectionTone', 'vivid'] as const) assert.deepEqual(b[k], a[k], `${t.id}.${k}`)
  assert.equal(b.head.css, a.head.css, `${t.id} Titelschrift`)
  assert.equal(b.head.weight, a.head.weight, `${t.id} Titelgewicht`)
  assert.equal(b.body.css, a.body.css, `${t.id} Textschrift`)
  assert.equal(b.c.bg.toLowerCase(), a.c.bg.toLowerCase(), `${t.id} Grund`)
  assert.deepEqual(guardNotes(spec, b).filter((n) => n.startsWith('Grund')), [], `${t.id}: Grund bleibt`)
}
// Marke wird zur Spec, ihre Farben schlagen die Spec danach nicht mehr; Logo bleibt
const ref = { id: 'beratung', brand: { primary: '#C8102E', logo: 'asset://local/x.png' }, tune: { rule: 'over' as const, margin: 'generous' as const }, shuffle: 2 }
const spec = specOf(ref)
assert.equal(spec.rule, 'over')
const out = refOf(ref, { ...spec, accent: '#0B5563', rule: 'none' })
assert.equal(out.shuffle, undefined)
assert.deepEqual(out.tune, { margin: 'generous' }) // Editor-Schlüssel aus dem Feinschliff, Gestaltung bleibt
assert.equal(out.brand?.logo, 'asset://local/x.png')
assert.equal(resolveTheme(out).rule, undefined)
assert.equal(out.brand?.primary, '#0B5563') // Logo-Marke folgt dem Akzent der Spec
// Leitplanke: kräftiger Grund ohne Farbgrund wird gedämpft und gemeldet
const loud = { ...specOf({ id: 'beratung' }), bg: '#FF0000' }
assert.ok(guardNotes(loud, resolveTheme({ id: 'custom', custom: loud })).some((n) => n.startsWith('Grund gedämpft')))
console.log('check-theme-editor: ok')
// alle Farben und Körnung übersteht der Weg Katalog → Spec → Theme
for (const t of CATALOG_THEMES) {
  const a = resolveTheme({ id: t.id }), b = resolveTheme(refOf({ id: t.id }, specOf({ id: t.id })))
  // themeFromSpec hebt zu schwache Farben an (Text 10:1, Akzente 3:1): das ist die Leitplanke, kein Verlust
  for (const k of ['text', 'accent', 'accent2'] as const) assert.equal(b.c[k].toLowerCase(), ensureContrast(a.c[k], a.c.bg, k === 'text' ? 10 : 3).toLowerCase(), `${t.id}.c.${k}`)
  assert.equal(b.texture, a.texture, `${t.id}.texture`)
}
// eigene Schrift (Titel oder Text) bleibt über fonts erhalten und landet nicht im Spec (Schema kennt den Namen nicht)
const cf = { family: 'Meine Hausschrift', regular: 'asset://local/h.ttf' }
const own = { id: 'beratung', customFont: cf, fonts: ['', cf.family] as [string, string] }
const os = specOf(own)
assert.equal(os.bodyFont, cf.family)
const oref = refOf(own, os)
assert.deepEqual(oref.fonts, ['', cf.family])
assert.equal(oref.custom!.bodyFont, 'IBM Plex Sans')
assert.equal(resolveTheme(oref).body.css, cf.family)
// Name unter 2 Zeichen: der alte bleibt
assert.equal(refOf(oref, { ...os, name: 'x' }).custom!.name, oref.custom!.name)
console.log('check-theme-editor: Schriften, Name ok')
