// Gestaltungs-Tokens (applyTokens, ThemeRef.tune): npx esbuild scripts/check-theme-tokens.ts --bundle --platform=node --outfile=out/check-theme-tokens.cjs && node out/check-theme-tokens.cjs
import { deepStrictEqual as eq, ok } from 'node:assert'
import { converter, wcagContrast } from 'culori'
import type { ThemeSpec } from '../src/shared/deck'
import { THEMES, applyTokens, ensureContrast, marginsOf, resolveTheme, themeFromSpec, withTone } from '../src/shared/themes'

const oklch = converter('oklch')

// Ohne Tokens bleibt jedes Katalog-Theme, wie es ist (auch mit Farbvariante und Brand)
const none = { headWeight: undefined, chart: undefined, field: undefined, margin: undefined, signature: undefined }
for (const t of THEMES) {
  eq(applyTokens(t, {}), t)
  for (const extra of [{}, { shuffle: 2 }, { brand: { primary: '#0B5563' } }]) {
    eq(resolveTheme({ id: t.id, ...extra, tune: {} }), resolveTheme({ id: t.id, ...extra }), t.id)
    eq(resolveTheme({ id: t.id, ...extra, tune: none }), resolveTheme({ id: t.id, ...extra }), t.id)
  }
}

// Titelgewicht auf die vorhandenen Schnitte geklemmt (gebündelt 400/700, Einschnitt-Schriften nur 400), Laufweite auf −0,05 … +0,02
eq(resolveTheme({ id: 'beratung', tune: { headWeight: 300 } }).head.weight, 400)
eq(resolveTheme({ id: 'beratung', tune: { headWeight: 500 } }).head.weight, 400)
eq(resolveTheme({ id: 'redaktion', tune: { headWeight: 600 } }).head.weight, 700)
eq(resolveTheme({ id: 'redaktion', tune: { headWeight: 900 } }).head.weight, 700)
eq(resolveTheme({ id: 'plakat', tune: { headWeight: 900 } }).head.weight, 400) // Archivo Black: ein Schnitt
eq(resolveTheme({ id: 'beratung', tune: { headTracking: -0.2 } }).head.tracking, -0.05)
eq(resolveTheme({ id: 'beratung', tune: { headTracking: 0.5 } }).head.tracking, 0.02)
eq(resolveTheme({ id: 'beratung', tune: { headTracking: -0.03 } }).head.tracking, -0.03)
// headWeight schlägt titleWeight; Schriftwechsel über ref.fonts klemmt neu
const spec: ThemeSpec = { name: 't', bg: '#FFFFFF', accent: '#1F3A8A', headFont: 'Inter', bodyFont: 'Inter', radius: 0, decor: 'none', titleWeight: 'regular', headWeight: 800 }
eq(themeFromSpec(spec).head.weight, 700)
eq(resolveTheme({ id: 'custom', custom: spec, fonts: ['DM Serif Display', 'Inter'], tune: { headWeight: 700 } }).head.weight, 400)

// Alte Hebel als Tune über einem Katalog-Theme
eq(resolveTheme({ id: 'keynote', tune: { titleSize: 'normal' } }).headScale, undefined)
eq(resolveTheme({ id: 'beratung', tune: { titleSize: 'huge' } }).headScale, 1.45)
eq(resolveTheme({ id: 'beratung', tune: { rule: 'none' } }).rule, undefined)
eq(resolveTheme({ id: 'beratung', tune: { elements: 'plain', labelFont: 'mono' } }).elements, 'plain')
ok(resolveTheme({ id: 'beratung', tune: { labelFont: 'mono' } }).mono)

// Struktur-Tokens kommen im Theme an (Renderer setzt daraus CSS-Variablen und Klassen)
const s = resolveTheme({ id: 'schweiz', tune: { margin: 'asymmetric', measure: 'narrow', leading: 'open', labels: 'caps', heroTone: 'invert', images: 'mono', signature: { kind: 'edge', side: 'top' } } })
eq([s.margin, s.measure, s.leading, s.labels, s.heroTone, s.images, s.signature?.kind], ['asymmetric', 'narrow', 'open', 'caps', 'invert', 'mono', 'edge'])
// Tune schlägt die Tokens eines eigenen Designs
eq(resolveTheme({ id: 'custom', custom: { ...spec, margin: 'generous', heroTone: 'field' }, tune: { margin: 'standard' } }).margin, 'standard')

// Flächenfarbe: fill aus field, Text darauf mit Kontrast; Akzentflächen (Kapitel) nehmen sie
for (const id of ['beratung', 'keynote', 'zen']) {
  const t = resolveTheme({ id, tune: { field: '#F2C200' } }), base = resolveTheme({ id })
  ok(t.c.fill !== base.c.fill, id)
  ok(wcagContrast(t.c.onAccent, t.c.fill!) >= 4.5, `${id}: Text auf Fläche`)
  eq(withTone(t, 'accent').c.bg, t.c.fill)
  eq(t.c.accent, base.c.accent) // Akzent (Text, Linien) bleibt
}
// field überlebt die Farbvariante
ok(resolveTheme({ id: 'beratung', shuffle: 1, tune: { field: '#F2C200' } }).c.fill === resolveTheme({ id: 'beratung', tune: { field: '#F2C200' } }).c.fill)

// Diagrammfarben je Strategie, immer Kontrast ≥ 2,5 zum Grund
for (const id of ['beratung', 'keynote', 'redaktion', 'zen', 'plakat']) {
  const base = resolveTheme({ id })
  for (const chart of ['focus', 'duo', 'tonal'] as const) {
    const t = resolveTheme({ id, tune: { chart } })
    eq(t.c.chart.length, 5)
    for (const c of t.c.chart) ok(wcagContrast(c, t.c.bg) >= 2.5, `${id} ${chart} ${c}`)
  }
  const tonal = resolveTheme({ id, tune: { chart: 'tonal' } }).c.chart
  eq(new Set(tonal).size, 5, `${id}: Stufen unterscheidbar`)
  const hue = oklch(base.c.accent)!.h
  if (hue !== undefined && (oklch(base.c.accent)!.c ?? 0) > 0.05) for (const c of tonal.slice(1)) { const h = oklch(c)!.h; ok(h === undefined || Math.abs(((h - hue + 540) % 360) - 180) < 25, `${id}: Farbton bleibt (${c})`) }
  const duo = resolveTheme({ id, tune: { chart: 'duo' } })
  eq(duo.c.chart[1], ensureContrast(duo.c.accent2, duo.c.bg, 2.5)) // Zweitakzent an zweiter Stelle
}
// focus entspricht dem bisherigen Standard eigener Designs; tonal überlebt die Farbvariante
eq(themeFromSpec({ ...spec, chart: 'focus' }).c.chart, themeFromSpec(spec).c.chart)
ok(resolveTheme({ id: 'custom', custom: { ...spec, chart: 'tonal' }, shuffle: 2 }).c.chart.join() !== resolveTheme({ id: 'custom', custom: spec, shuffle: 2 }).c.chart.join())

// Brand ersetzt die Farben: Diagrammstrategie des Designs leitet ihre Familie aus der Brand-Farbe neu ab (nicht Mischfamilie)
const branded = resolveTheme({ id: 'custom', custom: { ...spec, chart: 'tonal' }, brand: { primary: '#0E7C3A' } })
const brandHue = oklch(branded.c.chart[0])!.h!
ok(Math.abs(brandHue - oklch('#0E7C3A')!.h!) < 10, 'erste Diagrammfarbe aus der Brand-Farbe')
for (const c of branded.c.chart) { const h = oklch(c)!.h; ok(h === undefined || Math.abs(((h - brandHue + 540) % 360) - 180) < 25, `Brand + tonal: ${c} in der Brand-Familie`) }
eq(branded.c.chart, applyTokens(branded, { chart: 'tonal' }).c.chart)

// Brand-Logo folgt dem Grund der Folie (heroTone invert/field, Farbvariante hell/dunkel)
const logos = { primary: '#0B5563', logo: 'asset://local/hell.png', logoDark: 'asset://local/dunkel.png' }
const hell = resolveTheme({ id: 'beratung', brand: logos })
eq(hell.logo, logos.logo)
eq(withTone(hell, 'invert').logo, logos.logoDark)
eq(withTone(withTone(hell, 'invert'), 'invert').logo, logos.logo)
eq(withTone(hell, 'accent').logo, withTone(hell, 'accent').dark ? logos.logoDark : logos.logo)
eq(resolveTheme({ id: 'beratung', brand: logos, shuffle: 2 }).logo, logos.logoDark)
eq(withTone(resolveTheme({ id: 'beratung', brand: { ...logos, logoDark: undefined } }), 'invert').logo, logos.logo)

// Ränder: Standard = bisherige Maße, schmale Formate halber Zuschlag
const wide = { w: 1280, h: 720 }, std = { l: 72, r: 72, t: 60, b: 72, foot: 24 }
eq(marginsOf(undefined, wide), std)
ok(marginsOf('asymmetric', wide).l > marginsOf('asymmetric', wide).r + 60)
ok(marginsOf('generous', wide).t > 60 && marginsOf('generous', wide).l > 100)
// Hoch- und Quadratformate behalten die Standardränder, schmale Querformate den halben Zuschlag
for (const size of [{ w: 794, h: 1123 }, { w: 1080, h: 1350 }, { w: 1080, h: 1080 }]) eq(marginsOf('generous', size), std)
eq(marginsOf('asymmetric', { w: 800, h: 450 }).l, 112)
eq(marginsOf('asymmetric', { w: 1123, h: 794 }).l, 152)
console.log('theme-tokens ok')
