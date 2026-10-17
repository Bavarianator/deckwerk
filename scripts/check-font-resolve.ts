// Katalogschriften im Theme (fontRef, ThemeRef.fontFiles): npx esbuild scripts/check-font-resolve.ts --bundle --platform=node --outfile=out/check-font-resolve.cjs && node out/check-font-resolve.cjs
import { deepStrictEqual as eq, ok } from 'node:assert'
import { createHash } from 'node:crypto'
import type { ThemeSpec } from '../src/shared/deck'
import { FONT_CATALOG } from '../src/shared/font-catalog'
import { FONTS, FONT_NAMES, THEMES, fontRef, resolveTheme, themeFromSpec } from '../src/shared/themes'

const url = (f: string) => `asset://local/fonts/${f.replace(/\s+/g, '')}.ttf`
const files = (...fams: string[]) => Object.fromEntries(fams.map((f) => [f, { regular: url(f), bold: url(`${f}-Bold`), italic: url(`${f}-Italic`) }]))

// Jeder Katalog-Ersatz ist gebündelt; gebündelte Namen bleiben, wie sie sind (auch mit fremden Dateieinträgen)
for (const i of FONT_CATALOG) ok(i.fallback in FONTS, `${i.family}: Ersatz ${i.fallback} nicht gebündelt`)
for (const n of FONT_NAMES) { eq(fontRef(n), FONTS[n]); eq(fontRef(n, files(n)), FONTS[n]) }
eq(fontRef(undefined), undefined)
eq(fontRef('Gibt es nicht'), undefined)
eq(fontRef('toString'), undefined)

// Katalogname ohne Dateien → Ersatz (deterministisch), mit Dateien → eigener Name, alle Schnitte, Ersatz als CSS-Rückfall
eq(fontRef('Newsreader'), FONTS.Georgia)
eq(fontRef('Inter Tight', files('Newsreader')), FONTS.Inter)
const nr = fontRef('Newsreader', files('Newsreader'))!
eq(nr, { css: 'Newsreader', pptx: 'Newsreader', files: files('Newsreader').Newsreader, serif: true, single: false, fallback: 'Gelasio' })
eq(fontRef('newsreader ', files('Newsreader'))?.pptx, 'Newsreader') // Schreibweise wie im Katalog
eq(fontRef('Anton', { Anton: { regular: url('Anton') } })?.single, true) // ohne Bold: Titel in 400
eq(fontRef('Spectral', { Spectral: { regular: '' } }), FONTS.Georgia) // ohne Regular kein brauchbarer Schnitt

// Eigenes Design, Marke und Schriftpaar lösen über dieselbe Funktion auf
const spec: ThemeSpec = { name: 't', bg: '#FFFFFF', accent: '#1F3A8A', headFont: 'Newsreader', bodyFont: 'Inter Tight', radius: 0, decor: 'none' }
eq(themeFromSpec(spec).head.css, 'Gelasio')
eq(themeFromSpec(spec).body, FONTS.Inter)
const ff = files('Newsreader', 'Inter Tight', 'Spectral')
eq([themeFromSpec(spec, ff).head.pptx, themeFromSpec(spec, ff).head.tracking, themeFromSpec(spec, ff).body.pptx], ['Newsreader', -0.012, 'Inter Tight'])
eq(resolveTheme({ id: 'custom', custom: spec, fontFiles: ff }).head.files, ff.Newsreader)
eq(resolveTheme({ id: 'custom', custom: spec }).head.pptx, 'Georgia')
eq(resolveTheme({ id: 'beratung', brand: { primary: '#0B5563', headFont: 'Spectral', bodyFont: 'Inter Tight' }, fontFiles: ff }).body.pptx, 'Inter Tight')
const branded = resolveTheme({ id: 'beratung', brand: { primary: '#0B5563', headFont: 'Spectral' }, fontFiles: ff }).head
eq([branded.pptx, branded.weight, branded.embed], ['Spectral', 700, undefined]) // Gewicht des Themes, kein embed der alten Schrift
eq(resolveTheme({ id: 'redaktion', brand: { primary: '#0B5563', headFont: 'Arial' } }).head.embed, undefined)
eq(resolveTheme({ id: 'beratung', brand: { primary: '#0B5563', headFont: 'Anton' }, fontFiles: { Anton: { regular: url('Anton') } } }).head.weight, 400)
eq(resolveTheme({ id: 'beratung', fonts: ['Spectral', 'Newsreader'], fontFiles: ff }).head.pptx, 'Spectral')
eq(resolveTheme({ id: 'beratung', fonts: ['Spectral', 'Newsreader'] }).body, FONTS.Georgia)

// Titelgewicht als Instanz-Familie, wenn geladen (tune vor custom); sonst wie bisher geklemmt
const semi = { ...ff, 'Inter SemiBold': { regular: url('Inter SemiBold') }, 'Newsreader Medium': { regular: url('Newsreader Medium') } }
const inst = resolveTheme({ id: 'custom', custom: { ...spec, headFont: 'Inter', headWeight: 600 }, fontFiles: semi }).head
eq([inst.css, inst.pptx, inst.weight, inst.files, inst.fallback], ['Inter SemiBold', 'Inter SemiBold', 400, semi['Inter SemiBold'], 'Inter'])
eq(resolveTheme({ id: 'custom', custom: { ...spec, headFont: 'Inter', headWeight: 600 } }).head.pptx, 'Inter')
eq(resolveTheme({ id: 'custom', custom: { ...spec, headFont: 'Inter', headWeight: 600 } }).head.weight, 700)
eq(resolveTheme({ id: 'custom', custom: { ...spec, headFont: 'Inter', headWeight: 600 }, tune: { headWeight: 700 }, fontFiles: semi }).head.pptx, 'Inter')
eq(resolveTheme({ id: 'custom', custom: spec, tune: { headWeight: 500 }, fontFiles: semi }).head.pptx, 'Newsreader Medium')
eq(resolveTheme({ id: 'keynote', tune: { headWeight: 600 }, fontFiles: semi }).head.pptx, 'Inter SemiBold') // auch gebündelte Familien
eq(resolveTheme({ id: 'redaktion', tune: { headWeight: 600 }, fontFiles: semi }).head.weight, 700) // Source Serif 4 SemiBold fehlt

// Katalog-Themes und gebündelte Schriften ohne fontFiles exakt wie vor den Katalogschriften (Prüfsumme des alten Stands)
const refs = THEMES.flatMap((t) => [{ id: t.id }, { id: t.id, shuffle: 3 }, { id: t.id, brand: { primary: '#0B5563' } }, { id: t.id, fonts: ['Lora', 'Inter'] as [string, string] }, { id: t.id, tune: { headWeight: 600 as const } }])
const old: ThemeSpec = { name: 't', bg: '#FFFFFF', accent: '#1F3A8A', headFont: 'Fraunces', bodyFont: 'Inter', radius: 0, decor: 'none', headWeight: 600 }
const sum = createHash('sha256').update(JSON.stringify([refs.map(resolveTheme), themeFromSpec(old), resolveTheme({ id: 'custom', custom: old })])).digest('hex').slice(0, 16)
eq(sum, '536b8087b6608ba2')
// fremde Dateieinträge ändern ein Theme mit gebündelten Schriften nicht
for (const r of refs) eq(resolveTheme({ ...r, fontFiles: ff }), resolveTheme(r), r.id)
console.log('font-resolve ok')
