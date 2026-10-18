// Fixtures für die Differenztests (vom Repo-Stamm, bündelt über build.mjs): node crates/dw-theme/tests/gen/build.mjs
import { writeFileSync } from 'node:fs'
import { HEAD_ROLES, SCALE, THEMES, resolveTheme, withTone, type Theme } from '../../../../src/shared/themes'
// @ts-expect-error themeVars exportiert erst das Plugin in build.mjs
import { themeVars } from '../../../../src/renderer/slide'
import { THEME_REFS } from '../../../../src/shared/theme-refs'
import type { BrandKit, ThemeRef, ThemeSpec } from '../../../../src/shared/deck'

const BRAND: BrandKit = { primary: '#E4007C', secondary: '#00A0B0', logo: 'asset://local/logo.png', logoDark: 'asset://local/logo-dark.png', headFont: 'Fraunces', bodyFont: 'Inter' }
const BRAND3: BrandKit = { primary: '#0055AA', headFont: 'Archivo Black', bodyFont: 'DM Sans' } // Einschnitt-Titelschrift
const BRAND2: BrandKit = { primary: '#FFD400', headFont: 'Work Sans', logo: 'asset://local/l.png' }
// eigene Designs aus examples/*.json
const SPECS: [string, ThemeSpec][] = [
  ['agenten', { name: 'Terminal', bg: '#14161B', accent: '#7A86FF', headFont: 'IBM Plex Sans', bodyFont: 'IBM Plex Sans', radius: 2, decor: 'none', titleSize: 'large', titleWeight: 'bold', rule: 'under', sectionTone: 'invert', labelFont: 'mono' }],
  ['formate', { name: 'Testbild Studio', bg: '#F7F4EE', text: '#1B1D22', accent: '#0A7B83', accent2: '#FF5A36', headFont: 'DM Serif Display', bodyFont: 'Inter', radius: 8, decor: 'grid' }],
  ['vortrag', { name: 'Bühnenlicht', bg: '#121214', accent: '#E8B04A', headFont: 'Source Serif 4', bodyFont: 'Inter', radius: 0, decor: 'none', titleSize: 'large', titleWeight: 'regular', rule: 'none', sectionTone: 'normal' }],
  ['mittel', { name: 'Mittelgrau', bg: '#7A8C99', accent: '#FF3300', headFont: 'Lora', bodyFont: 'Calibri', radius: 4, decor: 'dots', chart: 'tonal' }],
  ['kraeftig', { name: 'Kräftig', bg: '#2244CC', accent: '#FFCC00', headFont: 'Archivo Black', bodyFont: 'Archivo', radius: 0, decor: 'none', vivid: true, chart: 'duo', elements: 'plain' }],
  ...THEME_REFS.map((r) => [`ref-${r.direction}`, r.spec] as [string, ThemeSpec]),
]
const ff = (fam: string, bold = true) => ({ regular: `asset://local/${fam}-R.ttf`, ...(bold && { bold: `asset://local/${fam}-B.ttf` }) })

const cases: [string, ThemeRef][] = []
for (const t of THEMES) cases.push([t.id, { id: t.id }], [`${t.id}+brand`, { id: t.id, brand: BRAND }])
for (const [n, s] of SPECS) cases.push([`custom-${n}`, { id: 'custom', custom: s }], [`custom-${n}+brand2`, { id: 'custom', custom: s, brand: BRAND2 }])
for (const id of ['beratung', 'keynote', 'atelier', 'plakat']) for (let n = -1; n <= 6; n++) cases.push([`${id}~${n}`, { id, shuffle: n }])
cases.push(
  ['unbekannt', { id: 'gibtsnicht' }],
  ['redaktion+brand~3', { id: 'redaktion', brand: BRAND, shuffle: 3 }],
  ['fonts', { id: 'zen', fonts: ['DM Serif Display', 'Source Sans 3'] }],
  ['fonts-katalog', { id: 'beratung', fonts: ['Bodoni Moda', 'Newsreader'], fontFiles: { 'Bodoni Moda': ff('Bodoni'), Newsreader: ff('News', false) } }],
  ['customFont', { id: 'schweiz', fonts: ['Meine', 'Meine'], customFont: { family: 'Meine', regular: 'asset://local/m.ttf' } }],
  ['tune', { id: 'beratung', tune: { titleSize: 'huge', headWeight: 500, headTracking: -0.09, leading: 'open', labels: 'caps', labelFont: 'mono', margin: 'asymmetric', measure: 'narrow', rule: 'none', elements: 'plain', signature: { kind: 'edge', side: 'left', size: 30, color: 'field' }, heroTone: 'invert', field: '#E4007C', chart: 'tonal', images: 'duotone' } }],
  ['tune-brand', { id: 'midnight', brand: BRAND, tune: { chart: 'duo', field: '#00A0B0', headTracking: 0.05 } }],
  ['ref-instanz', { id: 'custom', custom: THEME_REFS[0].spec, fontFiles: { 'Schibsted Grotesk': ff('Schibsted'), 'Schibsted Grotesk ExtraBold': ff('SchibstedXB', false) } }],
  ['tune-instanz-800', { id: 'keynote', fonts: ['Inter Tight', 'Inter'], tune: { headWeight: 800 }, fontFiles: { 'Inter Tight': ff('IT'), 'Inter Tight ExtraBold': ff('ITXB', false) } }],
  ['ref-ma-300', { id: 'custom', custom: THEME_REFS[3].spec, fontFiles: { Spectral: ff('Sp'), 'Spectral Light': ff('SpL', false) } }],
  ['custom~2', { id: 'custom', custom: SPECS[0][1], shuffle: 2 }],
  ['custom~5+brand', { id: 'custom', custom: SPECS[1][1], shuffle: 5, brand: BRAND }],
  ['custom+tune', { id: 'custom', custom: SPECS[2][1], tune: { rule: 'over', titleSize: 'normal', labelFont: 'body', signature: { kind: 'rule', length: 'full', size: 3, color: 'accent' } } }],
  ['custom+customFont', { id: 'custom', custom: SPECS[0][1], fonts: ['Meine', 'Inter'], customFont: { family: 'Meine', regular: 'asset://local/m.ttf', bold: 'asset://local/mb.ttf' } }],
  ['tune-large', { id: 'beratung', tune: { titleSize: 'large', rule: 'over', signature: { kind: 'rule' } } }],
  ['tune-normal', { id: 'keynote', tune: { titleSize: 'normal', headTracking: 0.05 } }],
  ['tune-labelbody', { id: 'magazin', tune: { labelFont: 'body', signature: { kind: 'passepartout' } } }],
  ['tune-passepartout', { id: 'schweiz', tune: { margin: 'generous', signature: { kind: 'passepartout', size: 0.2, color: 'accent' }, leading: 'tight', measure: 'wide' } }],
  ['tune-edge-top', { id: 'zen', tune: { signature: { kind: 'edge', side: 'top' }, labels: 'caps' } }],
  ['tune-sig-none', { id: 'redaktion', tune: { signature: { kind: 'none' }, margin: 'standard' } }],
  ['brand-single', { id: 'beratung', brand: BRAND3 }],
  ['brand-single-dark', { id: 'keynote', brand: BRAND3, fonts: ['DM Serif Display', 'Inter'] }],
  ['keynote+brand~2', { id: 'keynote', brand: BRAND, shuffle: 2 }],
  ['keynote+brand~1', { id: 'keynote', brand: BRAND, shuffle: 1 }],
  ['beratung+brand~3', { id: 'beratung', brand: BRAND, shuffle: 3 }],
  ['field+brand', { id: 'beratung', brand: BRAND, tune: { field: '#FFD400' } }],
  ['ref-field+brand', { id: 'custom', custom: THEME_REFS[0].spec, brand: BRAND }],
  ['shuffle-bruch', { id: 'beratung', shuffle: 1.5 }],
  ['shuffle-bruch2', { id: 'midnight', shuffle: 7.25 }],
  ['unvollständig-min', { id: 'custom', custom: { bg: '#F0EEE8', accent: '#335577' } as ThemeSpec }],
  ['unvollständig-dunkel', { id: 'custom', custom: { name: 'Halb', bg: '#101820', accent: '#E07A5F', headFont: 'Inter Tight', titleSize: 'huge' } as ThemeSpec }],
  ['tune-teilweise', { id: 'atelier', tune: { margin: 'generous' } }],
  ['tune-instanz', { id: 'keynote', fonts: ['Inter Tight', 'Inter'], tune: { headWeight: 600 }, fontFiles: { 'Inter Tight': ff('IT'), 'Inter Tight SemiBold': ff('ITSB', false) } }],
)

const out = cases.map(([name, ref]) => {
  const theme = resolveTheme(ref)
  return { name, ref, theme, accent: withTone(theme, 'accent'), invert: withTone(theme, 'invert') }
})
// themeVars (slide.tsx) je Fall und Format; Töne für die 20 Themes
const SIZES = [{ w: 1280, h: 720 }, { w: 1080, h: 1350 }, { w: 794, h: 1123 }]
const vars = (t: Theme, size: { w: number; h: number }) => Object.fromEntries(Object.entries(themeVars(t, size)).map(([k, v]) => [k, String(v)]))
const tokens = [
  ...out.flatMap((c) => SIZES.map((size) => ({ name: c.name, tone: 'normal', ...size, vars: vars(c.theme, size) }))),
  ...out.slice(0, 2 * THEMES.length).flatMap((c) => (['accent', 'invert'] as const).map((tone) => ({ name: c.name, tone, ...SIZES[0], vars: vars(c[tone], SIZES[0]) }))),
]
writeFileSync('crates/dw-theme/tests/fixtures/tokens.json', JSON.stringify(tokens) + '\n')
// fs-Tabelle wie applySteps (measure.ts)
const FORMATS: [string, number][] = [['slides', 1280], ['social', 1080], ['social', 1080 * 0.6], ['doc', 794], ['doc', 1123], ['doc', 321]]
const fs = FORMATS.map(([profile, w]) => {
  const k = profile === 'social' ? w / 750 : profile === 'doc' ? Math.min(0.65, w / 1221) : 1
  const rows: Record<string, number[][]> = {}
  for (const [role, steps] of Object.entries(SCALE))
    rows[role] = [0, 1, 2, 3].map((head) => [0, 1, 2, 3].map((body) => Math.max(Math.round(steps[HEAD_ROLES.includes(role) ? head : body] * k), k < 1 ? 12 : 0)))
  return { profile, w, k, rows }
})
writeFileSync('crates/dw-theme/tests/fixtures/resolved.json', JSON.stringify({ cases: out, fs }, null, 1) + '\n')
console.log(`${out.length} Fälle, ${tokens.length} Token-Sätze, ${fs.length} fs-Formate`)
