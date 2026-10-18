// Brand-Kit: Auflösung im Theme und brand.json als Standard für create_deck: npx esbuild scripts/check-brand.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/check-brand.mjs && node out/check-brand.mjs
import { APP } from '../src/shared/app-id'
import { deepStrictEqual as eq, ok } from 'node:assert'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Deck } from '../src/shared/deck'
import { FONTS, THEMES, resolveTheme } from '../src/shared/themes'

// Theme: bodyFont ersetzt die Textschrift, logoDark gilt nur auf dunklem Grund
const dark = THEMES.find((t) => t.dark)!, light = THEMES.find((t) => !t.dark)!
const brand = { primary: '#0B5563', logo: 'asset://local/hell.png', logoDark: 'asset://local/dunkel.png', bodyFont: 'Georgia' }
eq(resolveTheme({ id: light.id, brand }).logo, 'asset://local/hell.png')
eq(resolveTheme({ id: dark.id, brand }).logo, 'asset://local/dunkel.png')
eq(resolveTheme({ id: dark.id, brand: { ...brand, logoDark: undefined } }).logo, 'asset://local/hell.png')
eq(resolveTheme({ id: light.id, brand }).body, FONTS.Georgia)

// brand.json im (Test-)Home: create_deck ohne brand nimmt sie, brand: null lässt sie weg
process.env.DECKWERK_HOME = mkdtempSync(join(tmpdir(), 'dw-brand-'))
const { buildTools, defaultBrand, saveBrand } = await import('../src/main/tools')
const { brandFile, setClient } = await import('../src/main/clients')
eq(defaultBrand(), undefined)
let deck: Deck | null = null
const engine = { measure: async () => [], renderPng: async () => [], renderOverview: async () => Buffer.alloc(0), lint: async () => [], exportDeck: async () => [] }
const tools = buildTools({ engine: engine as never, getDeck: () => deck, setDeck: (d) => { deck = d }, assetDir: '/nonexistent', outDir: '/tmp/out' })
const create = (input: unknown) => { const t = tools.find((x) => x.name === 'create_deck')!; return t.run(t.inputSchema.parse(input)) }

await create({ title: 'ohne Datei' })
eq(deck!.theme.brand, undefined)
saveBrand({ primary: '#112233', secondary: '#445566', bodyFont: 'Georgia' })
await create({ title: 'mit Datei' })
eq(deck!.theme.brand, { primary: '#112233', secondary: '#445566', bodyFont: 'Georgia' })
await create({ title: 'ausdrücklich ohne', brand: null })
eq(deck!.theme.brand, undefined)
await create({ title: 'eigene Marke', brand: { primary: '#AABBCC' } })
eq(deck!.theme.brand, { primary: '#AABBCC' })
writeFileSync(brandFile(), '{kaputt')
eq(defaultBrand(), undefined) // kaputte Datei bricht create_deck nicht
if (APP.pro) {
// Kunde aktiv: saveBrand schreibt nach kunden/<Name>/brand.json, defaultBrand und create_deck lesen von dort; ohne Kunde wieder die eigene
saveBrand({ primary: '#112233' })
setClient('Acme')
eq(defaultBrand(), undefined) // kein Rückfall auf die eigene Marke
saveBrand({ primary: '#AA0000' })
eq(JSON.parse(readFileSync(join(process.env.DECKWERK_HOME, 'kunden', 'Acme', 'brand.json'), 'utf8')), { primary: '#AA0000' })
await create({ title: 'für Acme' })
eq(deck!.theme.brand, { primary: '#AA0000' })
setClient(null)
eq(defaultBrand(), { primary: '#112233' })
}
ok(true)
// Schriften: Familienname lesbar (PowerPoint/Word ordnen eingebettete Schriften darüber zu), fontFamilyOf lässt die Datei unverändert
const { fontFamilyOf } = await import('../src/main/embed-fonts')
for (const f of readdirSync('assets/fonts').filter((f) => f.endsWith('.ttf'))) {
  const ttf = readFileSync(join('assets/fonts', f)), before = Buffer.from(ttf), family = fontFamilyOf(ttf)
  ok(/^[\x20-\x7e]+$/.test(family), `${f}: Familienname „${family}“`)
  ok(ttf.equals(before), `${f}: fontFamilyOf verändert die Schrift`)
}
console.log('check-brand: ok')
