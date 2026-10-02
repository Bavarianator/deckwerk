import { converter, formatHex, wcagContrast, clampChroma, interpolate } from 'culori'
import type { BrandKit, DecorId, ThemeRef, ThemeSpec, Tone } from './deck'
import { EXTRA_THEMES } from './themes-extra'

// embed: Dateistamm in assets/fonts (<embed>-Regular|Bold|Italic|BoldItalic.ttf); dieselbe TTF misst im Renderer und wird in die PPTX eingebettet.
export interface FontRef { css: string; pptx: string; embed?: string; serif?: boolean; single?: boolean; files?: { regular: string; bold?: string } } // files: eigene Schrift (asset://) // single: nur ein Schnitt (Titel in 400)
export interface Theme {
  id: string
  name: string
  dark: boolean
  c: {
    bg: string; surface: string; surface2: string; text: string; muted: string
    accent: string; accent2: string; onAccent: string; border: string; good: string; bad: string
    chart: string[]
    fill?: string // accent darkened/lightened until onAccent text on it passes WCAG AA (set by resolveTheme)
  }
  head: FontRef & { weight: number; tracking: number } // tracking in em
  body: FontRef
  radius: number
  decor: DecorId // Standard-Motiv, Folien können es überschreiben
  texture?: 'grain' // feine Körnung über dem Dekor
  tone?: Tone // gesetzt von withTone
  legacy?: boolean // alte Themes: laden weiter, werden aber nicht mehr angeboten
  headScale?: number // Titelgröße (display, statement, h1) relativ zur Skala; >1 = Plakat-Titel
  rule?: 'over' | 'under' // feine Linie über bzw. unter dem Folienkopf
  sectionTone?: Tone // Ton der Kapiteltrenner, Standard accent
  vivid?: boolean // kräftiger Farbgrund erlaubt (Stil mutig): calmBg greift nicht
  logo?: string
}

// Office fonts in the PPTX with metric-compatible twins for measuring → identical line breaks in PowerPoint.
// Premium fonts (OFL, scripts/fetch-fonts.ts) use the same TTF in both places and are embedded into the PPTX.
const FONT_LIST = {
  Arial: { css: 'Arimo', pptx: 'Arial' },
  Calibri: { css: 'Carlito', pptx: 'Calibri' },
  Georgia: { css: 'Gelasio', pptx: 'Georgia', serif: true },
  Fraunces: { css: 'Fraunces', pptx: 'Fraunces', embed: 'Fraunces', serif: true },
  Manrope: { css: 'Manrope', pptx: 'Manrope', embed: 'Manrope' },
  'Space Grotesk': { css: 'Space Grotesk', pptx: 'Space Grotesk', embed: 'SpaceGrotesk' },
  Inter: { css: 'Inter', pptx: 'Inter', embed: 'Inter' },
  'DM Serif Display': { css: 'DM Serif Display', pptx: 'DM Serif Display', embed: 'DMSerifDisplay', serif: true, single: true },
  'DM Sans': { css: 'DM Sans', pptx: 'DM Sans', embed: 'DMSans' },
  'Playfair Display': { css: 'Playfair Display', pptx: 'Playfair Display', embed: 'PlayfairDisplay', serif: true },
  'Source Sans 3': { css: 'Source Sans 3', pptx: 'Source Sans 3', embed: 'SourceSans3' },
  'Plus Jakarta Sans': { css: 'Plus Jakarta Sans', pptx: 'Plus Jakarta Sans', embed: 'PlusJakartaSans' },
  Lora: { css: 'Lora', pptx: 'Lora', embed: 'Lora', serif: true },
  'Instrument Serif': { css: 'Instrument Serif', pptx: 'Instrument Serif', embed: 'InstrumentSerif', serif: true, single: true },
  Archivo: { css: 'Archivo', pptx: 'Archivo', embed: 'Archivo' },
  'IBM Plex Sans': { css: 'IBM Plex Sans', pptx: 'IBM Plex Sans', embed: 'IBMPlexSans' },
  'IBM Plex Serif': { css: 'IBM Plex Serif', pptx: 'IBM Plex Serif', embed: 'IBMPlexSerif', serif: true },
  'Source Serif 4': { css: 'Source Serif 4', pptx: 'Source Serif 4', embed: 'SourceSerif4', serif: true },
} satisfies Record<string, FontRef>
export type FontName = keyof typeof FONT_LIST
export const FONTS: Record<FontName, FontRef> = FONT_LIST
export const FONT_NAMES = Object.keys(FONTS) as FontName[]

// Autofit steps per text role (px on the 1280x720 slide; 1px = 0.75pt). Step 0 = preferred size.
export const SCALE: Record<string, number[]> = {
  hero: [200, 170, 144, 120], // eine einzelne große Zahl (big-number)
  display: [76, 66, 58, 50],
  statement: [50, 44, 38, 33],
  h1: [42, 38, 34, 30],
  kpi: [72, 62, 54, 46],
  h2: [26, 24, 22, 20],
  h3: [22, 20, 18, 17],
  body: [24, 22, 20, 19],
  label: [19, 18, 17, 16],
  small: [17, 16, 15, 14],
  eyebrow: [14, 14, 13, 13],
  footer: [13, 13, 13, 13],
}
export const HEAD_ROLES = ['hero', 'display', 'statement', 'h1', 'kpi']

// Katalog-Themes nach Vorbildern guter Decks (Beratung, Keynote, Swiss Style, Editorial, Presentation Zen):
// flache Gründe, kein Dekor, eine Akzentfarbe, Zweitakzent neutral grau, kaum Radius.
const CORE_THEMES: Theme[] = [
  {
    id: 'beratung', name: 'Beratung', dark: false,
    c: {
      bg: '#FFFFFF', surface: '#F4F5F6', surface2: '#E9EBED', text: '#16202B', muted: '#5A6470',
      accent: '#0B5563', accent2: '#8A939C', onAccent: '#FFFFFF', border: '#DDE1E5', good: '#1E7A45', bad: '#B83227',
      chart: ['#0B5563', '#A3ABB3', '#C9CED3', '#5B7F8C', '#3E4C59'],
    },
    head: { ...FONTS['IBM Plex Sans'], weight: 700, tracking: -0.015 }, body: FONTS['IBM Plex Sans'], radius: 2, decor: 'none', rule: 'under',
  },
  {
    id: 'keynote', name: 'Keynote', dark: true,
    c: {
      bg: '#111113', surface: '#1B1B1E', surface2: '#252529', text: '#F5F5F7', muted: '#8E8E93',
      accent: '#3D9BFF', accent2: '#6E6E73', onAccent: '#0B0B0C', border: '#2C2C30', good: '#5BD08A', bad: '#FF6B5E',
      chart: ['#3D9BFF', '#6E6E73', '#A1A1A6', '#48484D', '#D1D1D6'],
    },
    head: { ...FONTS.Inter, weight: 700, tracking: -0.03 }, body: FONTS.Inter, radius: 4, decor: 'none', headScale: 1.22, sectionTone: 'normal',
  },
  {
    id: 'schweiz', name: 'Schweiz', dark: false,
    c: {
      bg: '#FAFAF8', surface: '#F0F0EE', surface2: '#E4E4E1', text: '#111111', muted: '#5C5C5C',
      accent: '#D7261E', accent2: '#8C8C8C', onAccent: '#FFFFFF', border: '#DADAD6', good: '#1E7A3C', bad: '#D7261E',
      chart: ['#D7261E', '#8C8C8C', '#BDBDBA', '#111111', '#5C5C5C'],
    },
    head: { ...FONTS.Archivo, weight: 700, tracking: -0.03 }, body: FONTS.Archivo, radius: 0, decor: 'none', headScale: 1.22, rule: 'over',
  },
  {
    id: 'redaktion', name: 'Redaktion', dark: false,
    c: {
      bg: '#FBFAF7', surface: '#F3F1EC', surface2: '#E8E5DE', text: '#1A1D24', muted: '#5E6168',
      accent: '#1F3A8A', accent2: '#9A9CA3', onAccent: '#FFFFFF', border: '#E0DDD5', good: '#2F6B3F', bad: '#A8321F',
      chart: ['#1F3A8A', '#A3A6AD', '#C8CAD0', '#5A6B99', '#3A3D45'],
    },
    head: { ...FONTS['Source Serif 4'], weight: 400, tracking: -0.012 }, body: FONTS['Source Sans 3'], radius: 2, decor: 'none', headScale: 1.22, rule: 'over', sectionTone: 'invert',
  },
  {
    id: 'zen', name: 'Zen', dark: true,
    c: {
      bg: '#1C1D1F', surface: '#242528', surface2: '#2D2F32', text: '#EDEBE6', muted: '#A09D96',
      accent: '#E3A857', accent2: '#7D7B76', onAccent: '#1C1D1F', border: '#35373A', good: '#8CC99A', bad: '#E88A7A',
      chart: ['#E3A857', '#7D7B76', '#B5B2AB', '#55575B', '#D8D5CE'],
    },
    head: { ...FONTS['IBM Plex Serif'], weight: 400, tracking: -0.012 }, body: FONTS['IBM Plex Sans'], radius: 0, decor: 'none', headScale: 1.22, sectionTone: 'normal',
  },
]

// Frühere Themes (Blobs, Glow, Verläufe): bestehende Decks laden weiter, neue bekommen sie nicht mehr angeboten.
const BASE_THEMES: Theme[] = [
  {
    id: 'corporate', name: 'Corporate Clean', dark: false,
    c: {
      bg: '#FFFFFF', surface: '#F3F6FB', surface2: '#E6ECF6', text: '#0E1A2B', muted: '#56667D',
      accent: '#1F5EFF', accent2: '#00A396', onAccent: '#FFFFFF', border: '#DCE3EE', good: '#12864A', bad: '#C9302C',
      chart: ['#1F5EFF', '#00A396', '#8A9AB5', '#F2A33A', '#8E6CF0'],
    },
    head: { ...FONTS.Arial, weight: 700, tracking: -0.02 }, body: FONTS.Calibri, radius: 14, decor: 'blobs',
  },
  {
    id: 'midnight', name: 'Midnight Pitch', dark: true,
    c: {
      bg: '#0A0F1E', surface: '#131A2E', surface2: '#1B2440', text: '#F3F6FF', muted: '#9AA6C4',
      accent: '#7C6CFF', accent2: '#2ED3E6', onAccent: '#FFFFFF', border: '#27314F', good: '#34D399', bad: '#F87171',
      chart: ['#7C6CFF', '#2ED3E6', '#F5B84B', '#F472B6', '#94A3B8'],
    },
    head: { ...FONTS.Arial, weight: 700, tracking: -0.025 }, body: FONTS.Calibri, radius: 18, decor: 'glow',
  },
  {
    id: 'editorial', name: 'Editorial Warm', dark: false,
    c: {
      bg: '#FAF7F2', surface: '#F1EBE1', surface2: '#E7DECF', text: '#1E1915', muted: '#675D54',
      accent: '#B0431A', accent2: '#2F6F63', onAccent: '#FFFFFF', border: '#E2D8C8', good: '#2F7D4F', bad: '#B3261E',
      chart: ['#B0431A', '#2F6F63', '#C9A227', '#7A6A5C', '#5B7FA6'],
    },
    head: { ...FONTS.Georgia, weight: 700, tracking: -0.01 }, body: FONTS.Calibri, radius: 6, decor: 'rings',
  },
]

export const THEMES: Theme[] = [...CORE_THEMES, ...[...BASE_THEMES, ...EXTRA_THEMES].map((t) => ({ ...t, legacy: true }))]
export const CATALOG_THEMES = THEMES.filter((t) => !t.legacy)

const oklch = converter('oklch')

// Darken (light bg) or lighten (dark bg) in OKLCH until the colour reaches the contrast target.
export function ensureContrast(color: string, bg: string, min: number): string {
  const c = oklch(color)
  if (!c) return color
  const step = wcagContrast(bg, '#000') > wcagContrast(bg, '#fff') ? -0.02 : 0.02
  let out = formatHex(c)!
  for (let i = 0; i < 50 && wcagContrast(out, bg) < min; i++) {
    c.l = Math.min(1, Math.max(0, c.l + step))
    out = formatHex(clampChroma(c, 'oklch'))!
  }
  return out
}

function withBrand(base: Theme, b?: BrandKit): Theme {
  if (!b) return base
  const accent = ensureContrast(b.primary, base.c.bg, 4.5)
  const accent2 = ensureContrast(b.secondary ?? base.c.accent2, base.c.bg, 3)
  const onAccent = wcagContrast('#FFFFFF', accent) >= 3 ? '#FFFFFF' : '#0B0B0B'
  return {
    ...base,
    id: `${base.id}+brand`,
    c: { ...base.c, accent, accent2, onAccent, chart: [accent, accent2, ...base.c.chart.slice(2)] },
    head: b.headFont && b.headFont in FONTS ? { ...base.head, ...FONTS[b.headFont as FontName] } : base.head,
    logo: b.logo,
  }
}

// Titelschrift mit passendem Gewicht und Laufweite (Einschnitt-Schriften nur 400)
const headRef = (f: FontRef, weight = 700) => ({ ...f, weight: f.single ? 400 : weight, tracking: f.serif ? -0.012 : -0.022 })

// Grund nur fast weiß oder fast schwarz und kaum bunt: mittlere, pastellige oder kräftige Gründe verraten Laien-Design sofort.
function calmBg(hex: string): string {
  const c = oklch(hex)
  if (!c) return hex
  const dark = c.l < 0.6
  return formatHex(clampChroma({ ...c, l: dark ? Math.min(c.l, 0.24) : Math.max(c.l, 0.955), c: Math.min(c.c ?? 0, dark ? 0.045 : 0.01) }, 'oklch'))!
}

// Stil mutig: kräftiger Grund bleibt in Farbton und Sättigung, verlässt aber das mittlere Helligkeitsband. Dort hielte weder
// weißer noch schwarzer Text (samt gedämpftem Sekundärtext) genug Kontrast.
function vividBg(hex: string): string {
  const c = oklch(hex)
  if (!c) return hex
  return formatHex(clampChroma({ ...c, l: c.l < 0.57 ? Math.min(c.l, 0.42) : Math.max(c.l, 0.74) }, 'oklch'))!
}

// Eigenes Theme aus wenigen Vorgaben (KI oder Nutzer): Flächen und Ränder als Mischung von Grund und Text, Akzente mit Mindestkontrast.
export function themeFromSpec(s: ThemeSpec): Theme {
  const bg = s.vivid ? vividBg(s.bg) : calmBg(s.bg)
  const dark = wcagContrast(bg, '#FFFFFF') > wcagContrast(bg, '#000000')
  const text = ensureContrast(s.text ?? mix(bg, dark ? '#FFFFFF' : mix('#000000', s.accent, 0.15), 0.92), bg, 10) // Schwarz mit einer Spur Akzent, nie reines #000
  const accent = ensureContrast(s.accent, bg, 3)
  const accent2 = ensureContrast(s.accent2 ?? mix(bg, text, 0.5), bg, 3) // ohne Vorgabe neutral: eine Akzentfarbe reicht
  const head = FONTS[s.headFont as FontName] ?? FONTS.Arial
  return {
    id: 'custom', name: s.name, dark,
    c: {
      bg, text, accent, accent2,
      surface: mix(bg, text, dark ? 0.07 : 0.045), surface2: mix(bg, text, dark ? 0.12 : 0.09), border: mix(bg, text, dark ? 0.17 : 0.12),
      muted: mix(bg, text, 0.62),
      onAccent: wcagContrast('#FFFFFF', accent) >= wcagContrast('#0B0B0B', accent) ? '#FFFFFF' : '#0B0B0B',
      good: dark ? '#5BD08A' : '#1E7A45', bad: dark ? '#F07A6B' : '#B83227',
      chart: [accent, mix(bg, text, 0.45), mix(bg, text, 0.28), accent2, mix(bg, text, 0.7)].map((c) => ensureContrast(c, bg, 2.5)), // grau + ein Akzent
    },
    head: headRef(head, s.titleWeight === 'regular' ? 400 : 700),
    body: FONTS[s.bodyFont as FontName] ?? FONTS.Calibri,
    radius: s.radius, decor: s.decor, texture: s.texture,
    headScale: s.titleSize === 'large' ? 1.22 : undefined,
    rule: s.rule === 'none' ? undefined : s.rule,
    sectionTone: s.sectionTone,
    vivid: s.vivid,
  }
}

// Base theme (+ brand kit), with every text colour pushed to WCAG AA on the surfaces it is used on.
// Kuratierte Schriftpaare [Titel, Text] für „Schriften mischen“
export const FONT_PAIRS: [FontName, FontName][] = [
  ['IBM Plex Sans', 'IBM Plex Sans'], ['Source Serif 4', 'Source Sans 3'], ['IBM Plex Serif', 'IBM Plex Sans'], ['Inter', 'Inter'],
  ['Archivo', 'Archivo'], ['Fraunces', 'DM Sans'], ['DM Serif Display', 'DM Sans'], ['Lora', 'Source Sans 3'],
  ['Playfair Display', 'Source Sans 3'], ['Manrope', 'Manrope'], ['Georgia', 'Calibri'], ['Arial', 'Calibri'],
]

// Farbvariante desselben Themes: 1 = Akzente getauscht, 2 = Hell/Dunkel getauscht, 3 = beides, 4/5 = Grund in Akzentfarbe getönt.
// Flächen, Ränder und Kontraste leitet themeFromSpec neu ab.
function shuffled(t: Theme, n: number): Theme {
  const v = ((n % 6) + 6) % 6
  if (!v) return t
  let { bg, text, accent, accent2 } = t.c
  if (v % 2) [accent, accent2] = [accent2, accent]
  if (v === 2 || v === 3) [bg, text] = [text, bg]
  if (v >= 4) bg = mix(bg, accent, t.dark ? 0.16 : 0.09)
  const s = themeFromSpec({ name: t.name, bg, text, accent, accent2, headFont: 'Arial', bodyFont: 'Calibri', radius: t.radius, decor: t.decor, texture: t.texture, vivid: t.vivid })
  return { ...t, dark: s.dark, c: s.c }
}

export function resolveTheme(ref: ThemeRef): Theme {
  let t = withBrand(ref.custom ? themeFromSpec(ref.custom) : THEMES.find((x) => x.id === ref.id) ?? THEMES[0], ref.brand)
  if (ref.shuffle) t = shuffled(t, ref.shuffle)
  const [hf, bf] = ref.fonts ?? []
  const cf = ref.customFont
  const font = (n?: string): FontRef | undefined =>
    n && cf && n === cf.family ? { css: n, pptx: n, files: { regular: cf.regular, bold: cf.bold }, single: !cf.bold } : n && n in FONTS ? FONTS[n as FontName] : undefined
  const hRef = font(hf), bRef = font(bf)
  if (hRef) t = { ...t, head: headRef(hRef, t.head.single ? 700 : t.head.weight) } // Gewicht des Designs behalten
  if (bRef) t = { ...t, body: bRef }
  const c = t.c
  return {
    ...t,
    c: {
      ...c,
      accent: ensureContrast(c.accent, c.surface, 4.6),
      fill: ensureContrast(c.accent, c.onAccent, 4.6),
      muted: ensureContrast(c.muted, c.surface2, 4.6),
      good: ensureContrast(c.good, c.surface, 4.6),
      bad: ensureContrast(c.bad, c.surface, 4.6),
    },
  }
}

// oklab statt oklch: fast unbunte Gründe haben einen zufälligen Farbton, in oklch kippten Tönungen dadurch ins Gelb-Oliv
export const mix = (a: string, b: string, t: number) => formatHex(interpolate([a, b], 'oklab')(t))!

// Duotone-Farben für Fotos [dunkel, hell], aus der Akzentfarbe (auf Akzentflächen aus deren Grund). Vorschau (CSS) und PPTX nutzen dieselben Werte.
export function duotoneOf(t: Theme): [string, string] {
  const base = t.tone === 'accent' ? t.c.bg : t.c.accent
  return [mix('#000000', base, 0.4), mix('#FFFFFF', base, 0.3)]
}

// Folien-Ton als abgeleitetes Theme (nach resolveTheme): Dekor, Chart-Farben in Vorschau und PPTX sowie CSS-Variablen folgen automatisch.
export function withTone(t: Theme, tone: Tone = 'normal'): Theme {
  const c = t.c
  if (tone === 'accent') {
    // Akzentflächen haben oft mittlere Helligkeit: dort wählt ensureContrast die falsche Richtung, deshalb von bg Richtung on mischen.
    // Karten weg von der Textfarbe abstufen (bei hellem Text dunkler), sonst sinkt ihr Kontrast unter den des Grundes
    const bg = c.fill!, on = c.onAccent, away = wcagContrast(on, '#FFFFFF') < wcagContrast(on, '#000000') ? '#000000' : '#FFFFFF'
    const surface = mix(bg, away, 0.12), surface2 = mix(bg, away, 0.2)
    const toward = (min: number) => [0.7, 0.75, 0.8, 0.85, 0.9, 0.95].map((k) => mix(bg, on, k)).find((m) => wcagContrast(m, bg) >= min) ?? on
    return {
      ...t, tone, dark: wcagContrast('#FFFFFF', bg) > wcagContrast('#000000', bg),
      c: {
        ...c, bg, surface, surface2, text: on, muted: toward(4.6),
        accent: on, onAccent: bg, fill: on, border: mix(bg, on, 0.3), // accent2 bleibt: Verlauf der Akzentfläche
        good: toward(4.6), bad: toward(4.6), // Grün/Rot auf Akzentfläche wirkt bunt: Vorzeichen und Pfeil tragen die Aussage
        chart: c.chart.map((x, i) => (i ? ensureContrast(x, bg, 3) : on)),
      },
    }
  }
  if (tone === 'invert') {
    const bg = c.text, text = c.bg, surface = mix(bg, text, 0.08), surface2 = mix(bg, text, 0.14)
    return {
      ...t, tone, dark: !t.dark,
      c: {
        ...c, bg, text, surface, surface2, border: mix(bg, text, 0.22),
        muted: ensureContrast(mix(bg, text, 0.65), surface2, 4.6),
        accent: ensureContrast(c.accent, surface, 4.6), accent2: ensureContrast(c.accent2, bg, 3),
        good: ensureContrast(c.good, surface, 4.6), bad: ensureContrast(c.bad, surface, 4.6),
        chart: c.chart.map((x) => ensureContrast(x, bg, 3)),
      },
    }
  }
  return t
}
