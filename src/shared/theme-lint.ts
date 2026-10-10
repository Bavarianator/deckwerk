// Theme-Lint: prüft eigene Themes, bevor sie gerendert werden, auf das, was generierte Designs verrät, und auf das, was
// später im Satz scheitert. Rein rechnerisch (OKLCH, CIEDE2000), ohne DOM. Inhalts-Regeln bleiben in lint.ts.
// error = mit konkreter Korrektur ablehnen (mit override: nur Warnung), warn = nachschärfen, info = Hinweis.
import { converter, differenceCiede2000, wcagContrast } from 'culori'
import type { ThemeSpec, TitleSize } from './deck'
import { fontInfo, suggestFont, type FontCat } from './font-catalog'

export interface ThemeIssue { level: 'error' | 'warn' | 'info'; rule: string; message: string }

const oklch = converter('oklch')
const ok = (hex: string) => { const c = oklch(hex); return { l: c?.l ?? 0, c: c?.c ?? 0, h: c?.h ?? 0 } }
const de = differenceCiede2000()
const dist = (a: string, b: string) => de(a, b)

// Paletten, an denen man generierte Decks erkennt: Akzent per CIEDE2000, Grund über Tönung (bei Fast-Weiß trennt der
// Farbabstand nicht: Creme und neutrales Grau liegen beide ~3 vom Klischee). bg fehlt = gilt für jeden Grund.
type Lch = { l: number; c: number; h: number }
const CLICHES: { name: string; bg?: (b: Lch) => boolean; accent: string; level: 'error' | 'warn' }[] = [
  { name: 'Creme + Terrakotta', bg: (b) => b.l >= 0.9 && b.c > 0.008 && b.h >= 50 && b.h <= 110, accent: '#C4552D', level: 'error' },
  { name: 'Schwarz + Säuregrün', bg: (b) => b.l <= 0.3, accent: '#C6FF00', level: 'error' },
  { name: 'Navy + Gold', bg: (b) => b.l <= 0.35 && b.c > 0.03 && b.h >= 230 && b.h <= 275, accent: '#C9A227', level: 'error' },
  { name: 'Slate + Cyan (Tailwind)', bg: (b) => b.l <= 0.35 && b.c > 0.02 && b.h >= 235 && b.h <= 285, accent: '#22D3EE', level: 'error' },
  { name: 'Tailwind-Indigo', accent: '#6366F1', level: 'error' },
  { name: 'KI-Violett', accent: '#7C3AED', level: 'error' },
  { name: 'Office-Blau', accent: '#4472C4', level: 'warn' },
  { name: 'Bootstrap-Blau', accent: '#0D6EFD', level: 'warn' },
  { name: 'SaaS-Mint', accent: '#10B981', level: 'warn' },
]

const SANS: FontCat[] = ['grotesk', 'humanist', 'geometric']

// brand: vom Brand-Kit des Nutzers vorgegeben (Akzent, Schriften) – das ist Markenvorgabe und wird nicht gelintet
export function lintTheme(s: ThemeSpec, opts: { override?: boolean; brand?: { accent?: boolean; headFont?: boolean; bodyFont?: boolean } } = {}): ThemeIssue[] {
  const out: ThemeIssue[] = []
  const add = (level: ThemeIssue['level'], rule: string, message: string) => out.push({ level: level === 'error' && opts.override ? 'warn' : level, rule, message })
  const bg = ok(s.bg), acc = ok(s.accent)

  // Grund: sehr hell und fast neutral oder sehr dunkel. Mitteltöne tragen keinen Text, Creme/Pastell wirkt generiert.
  // vivid (Stil mutig) will genau so einen kräftigen Farbgrund; den Textkontrast sichert dort die Engine.
  if (s.vivid) { /* keine Grund-Regeln */ }
  else if (bg.l > 0.25 && bg.l < 0.94) add('error', 'bg-mid', `Grund ${s.bg} ist ein Mittelton (OKLCH L ${bg.l.toFixed(2)}). Hell: L ≥ 0.94 (z. B. #FAFAF8), dunkel: L ≤ 0.25 (z. B. #121214).`)
  // gemessen: gute Off-Whites C ≤ 0.0055 (#FAFAF8, #F3F2EF), warmes Papier ~0.011, Creme/Eisblau/Mint/Lavendel ab 0.014
  else if (bg.l >= 0.94 && bg.c > 0.013) add('error', 'bg-tint', `Grund ${s.bg} ist Creme/Pastell (Chroma ${bg.c.toFixed(3)}). Fast neutral bleiben (C ≤ 0.006, z. B. #FAFAF8, #F3F2EF); Wärme über einen Hauch Gelb.`)
  else if (bg.l >= 0.94 && bg.c > 0.008) add('warn', 'bg-tint', `Grund ${s.bg} ist merklich getönt (Chroma ${bg.c.toFixed(3)}), wie Papier. Gewollt? Sonst neutraler (C ≤ 0.006).`)
  else if (bg.l <= 0.25 && bg.c > 0.05) add('warn', 'bg-tint', `Dunkler Grund ${s.bg} ist stark gefärbt (Chroma ${bg.c.toFixed(3)}), das wirkt schnell wie ein App-Theme. Fast-Schwarz mit leichtem Farbstich ist edler.`)

  const brand = opts.brand ?? {}
  // Akzent: kräftig, aber nicht Neon
  if (brand.accent) { /* Markenfarbe */ }
  else if (acc.c > 0.26) add('error', 'neon', `Akzent ${s.accent} ist Neon (Chroma ${acc.c.toFixed(2)}). Unter 0.2 bleiben; Wirkung kommt aus der Seltenheit, nicht der Sättigung.`)
  else if (acc.c > 0.22) add('warn', 'neon', `Akzent ${s.accent} ist sehr gesättigt (Chroma ${acc.c.toFixed(2)}). 0.08–0.18 wirkt hochwertiger.`)
  if (!brand.accent && wcagContrast(s.accent, s.bg) < 3) add('info', 'accent-contrast', `Akzent ${s.accent} hat nur ${wcagContrast(s.accent, s.bg).toFixed(1)}:1 auf dem Grund; die Engine dunkelt/hellt ihn ab. Für große Flächen field nutzen.`)
  if (s.text && wcagContrast(s.text, s.bg) < 8) add('info', 'text-contrast', `Text ${s.text} hat ${wcagContrast(s.text, s.bg).toFixed(1)}:1; die Engine hebt ihn auf 8:1 an.`)
  if (s.field && dist(s.field, s.accent) < 8) add('warn', 'field', `field ${s.field} ist fast gleich dem Akzent – weglassen (Standard = Akzent) oder als eigene Stimme wählen.`)

  // Klischee-Paletten, dazu die Farbfamilien drumherum (Säuregrün auf Dunkel, Lila-Blau)
  for (const c of CLICHES)
    if (!brand.accent && dist(s.accent, c.accent) <= 12 && (!c.bg || c.bg(bg)))
      add(c.level, 'cliche', `${c.name} ist eine typische Palette generierter Decks. Akzent aus dem Stoff des Themas ableiten.`)
  const cliche = () => out.some((i) => i.rule === 'cliche')
  if (!brand.accent && bg.l < 0.4 && acc.c > 0.15 && acc.h >= 115 && acc.h <= 135 && !cliche()) add('error', 'cliche', `Säuregrün ${s.accent} auf dunklem Grund ist eine typische Palette generierter Decks. Akzent aus dem Stoff des Themas ableiten.`)
  if (!brand.accent && acc.c > 0.12 && acc.h >= 265 && acc.h <= 305 && !cliche()) add('warn', 'cliche', `Violett-Akzent ${s.accent}: Lila-Blau gilt als KI-Look. Nur mit Grund (Marke, Thema).`)

  // Schriften
  const head = fontInfo(s.headFont), body = fontInfo(s.bodyFont)
  for (const [name, info, given] of [[s.headFont, head, brand.headFont], [s.bodyFont, body, brand.bodyFont]] as const) {
    if (given) continue
    if (!info) { add('error', 'font-unknown', `Schrift „${name}“ ist nicht im Katalog${suggestFont(name) ? ` – meintest du „${suggestFont(name)}“?` : '.'}`); continue }
    if (info.flag === 'slop') add('error', 'font', `${info.family} ist Standard generierter Designs. Nur auf ausdrücklichen Wunsch (override).`)
    else if (info.flag === 'common') add('info', 'font-common', `${info.family} ist sehr verbreitet – gut, wenn Neutralität gewollt ist; eigenständiger wirkt eine weniger bekannte Familie.`)
  }
  if (!brand.bodyFont && body && body.role === 'head') add('error', 'pairing', `${body.family} ist eine Titelschrift, als Text unleserlich. Textschrift mit role both/body wählen.`)
  if (!brand.headFont && !brand.bodyFont && head && body && head.family !== body.family) {
    if (head.cat === 'display-serif' && body.cat === 'display-serif') add('error', 'pairing', 'Zwei Display-Serifen: eine für Titel, für Text eine ruhige Serif oder Grotesk.')
    else if (SANS.includes(head.cat) && SANS.includes(body.cat) && head.family.split(' ')[0] !== body.family.split(' ')[0]) add('warn', 'pairing', `Zwei verschiedene serifenlose (${head.family} + ${body.family}) wirken wie ein Versehen. Besser eine Familie in zwei Gewichten oder Kontrast (Serif + Grotesk).`)
  }
  if (!brand.headFont && head && s.headWeight && s.headWeight !== 400 && s.headWeight !== 700 && !head.weights.includes(s.headWeight))
    add('info', 'weight', `${head.family} hat kein Gewicht ${s.headWeight}; verfügbar: ${head.weights.join(', ')}. Die Engine nimmt das nächste.`)

  // Satz: Kombinationen, bei denen Titel überlaufen oder zerfasern
  if (s.titleSize === 'huge' && s.measure === 'narrow') add('error', 'overflow', 'titleSize huge mit measure narrow: Titel mit 80 Zeichen brechen dreizeilig. Eines von beiden lockern.')
  if (s.radius > 6) add('warn', 'radius', `radius ${s.radius}: runde Ecken über 6 px wirken schnell nach Vorlage.`)
  if (s.decor !== 'none') add('warn', 'decor', `decor ${s.decor}: Motive nur auf ausdrücklichen Wunsch; Eigenständigkeit kommt über signature.`)
  if (s.texture) add('warn', 'decor', 'texture nur auf Wunsch.')
  if (s.accent2 && s.chart !== 'duo') add('info', 'accent2', 'accent2 ist nur mit chart: "duo" sichtbar; sonst weglassen.')
  return out
}

// Vergleich der Vorschläge: Richtungen sollen sich auf mindestens zwei von neun Achsen unterscheiden
export interface LookAxes {
  name: string; dark: boolean; headFont: string; accent: string; headWeight?: number; titleSize?: TitleSize
  field?: boolean; signature?: string; space?: string; heroTone?: string
}
export const axesOf = (s: ThemeSpec): LookAxes => ({
  name: s.name, dark: ok(s.bg).l < 0.5, headFont: s.headFont, accent: s.accent, headWeight: s.headWeight, titleSize: s.titleSize,
  field: !!s.field && dist(s.field, s.accent) >= 8, signature: s.signature?.kind, space: [s.margin, s.measure].filter((v) => v && v !== 'standard').join('+') || undefined, heroTone: s.heroTone,
})
const weightClass = (w = 700) => (w <= 300 ? 0 : w <= 500 ? 1 : 2)
// Farbstrategie: unbunter Akzent (Tinte) ist eine eigene Klasse, sonst Farbtonabstand > 40°
const hueDiffers = (a: string, b: string) => {
  const x = ok(a), y = ok(b)
  if ((x.c < 0.04) !== (y.c < 0.04)) return true
  if (x.c < 0.04) return false
  const d = Math.abs(x.h - y.h)
  return Math.min(d, 360 - d) > 40
}
export function lintLooks(looks: LookAxes[]): ThemeIssue[] {
  const out: ThemeIssue[] = []
  for (let i = 0; i < looks.length; i++) for (let j = i + 1; j < looks.length; j++) {
    const a = looks[i], b = looks[j]
    const axes = [a.dark !== b.dark, fontInfo(a.headFont)?.cat !== fontInfo(b.headFont)?.cat, hueDiffers(a.accent, b.accent),
      weightClass(a.headWeight) !== weightClass(b.headWeight), (a.titleSize ?? 'normal') !== (b.titleSize ?? 'normal'), !!a.field !== !!b.field,
      (a.signature ?? 'none') !== (b.signature ?? 'none'), a.space !== b.space, (a.heroTone ?? 'normal') !== (b.heroTone ?? 'normal')].filter(Boolean).length
    if (axes < 2) out.push({ level: 'warn', rule: 'similar', message: `„${a.name}“ und „${b.name}“ sind zu ähnlich (${axes} von 9 Achsen verschieden). Schriftgenre, Hell/Dunkel, Farbstrategie oder Raum variieren.` })
  }
  return out
}
