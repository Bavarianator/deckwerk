// Freie Elemente (Slide.items): Schema für KI-Tools und Fabriken für die Canvas. Positionen in px auf 1280x720.
import { z } from 'zod'
import { DASHES, FORMATS, ITEM_ANIMS, LINE_ENDS, MASKS, SHAPES, TEXT_EFFECTS, sizeOf, type ChartSpec, type Deck, type FormatId, type Item, type Size } from './deck'
import { FONT_NAMES } from './themes'

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)
export const itemSchema = z.object({
  id: z.string().max(40).optional().describe('weglassen = neu; vorhandene ID = dieses Element ersetzen'),
  kind: z.enum(['text', 'shape', 'image', 'icon', 'chart', 'video', 'audio', 'qr', 'graphic']).describe('qr: text = URL; graphic: handgezeichnete Deko (graphic = Name), Farbe über color'),
  group: z.string().max(40).optional().describe('gleiche ID = Gruppe (zusammen verschieben/skalieren)'),
  x: z.number().min(-1280).max(2560), y: z.number().min(-720).max(1440),
  w: z.number().min(1).max(3000), h: z.number().min(0).max(3000).describe('Text: wird aus dem Inhalt berechnet, trotzdem angeben'),
  rot: z.number().min(-360).max(360).optional(),
  opacity: z.number().min(0).max(1).optional(),
  locked: z.boolean().optional(),
  anim: z.enum(ITEM_ANIMS).optional().describe('Auftritt beim Präsentieren, je ein Klick'),
  text: z.string().max(600).optional(),
  font: z.enum(['head', 'body', ...FONT_NAMES]).optional().describe('head/body = Theme-Schrift'),
  size: z.number().min(8).max(400).optional().describe('Schriftgröße in px (1 px = 0,75 pt)'),
  color: hex.optional().describe('Text- oder Iconfarbe; weglassen = Theme'),
  bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(), upper: z.boolean().optional(),
  effect: z.enum(TEXT_EFFECTS).optional().describe('Texteffekt: shadow, lift (weicher Schatten), hollow (nur Kontur), neon (Leuchten)'), effectColor: hex.optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  lineHeight: z.number().min(0.7).max(3).optional(), spacing: z.number().min(-0.1).max(0.5).optional(),
  shape: z.enum(SHAPES).optional(),
  lineStart: z.enum(LINE_ENDS).optional(), lineEnd: z.enum(LINE_ENDS).optional().describe('Linienenden der Form line: arrow = offene Spitze, triangle = gefüllt, dot = Punkt'),
  dash: z.enum(DASHES).optional().describe('Strichart von Linie oder Umriss'),
  fill: hex.optional(), fill2: hex.optional().describe('Verlauf zu dieser Farbe (Rechteck/Ellipse)'),
  stroke: hex.optional(), strokeW: z.number().min(0).max(40).optional(),
  radius: z.number().min(0).max(400).optional(), shadow: z.boolean().optional(),
  src: z.string().optional().describe('asset://-Pfad aus find_images'),
  look: z.enum(['natural', 'duotone', 'mono']).optional(), mask: z.enum(MASKS).optional().describe('Bildrahmen (Form)'),
  adjust: z.object({ bright: z.number().min(-100).max(100).optional(), contrast: z.number().min(-100).max(100).optional(), sat: z.number().min(-100).max(100).optional(), blur: z.number().min(0).max(100).optional() }).optional().describe('Bildanpassung in Prozent'), round: z.boolean().optional(), flipX: z.boolean().optional(),
  crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) }).optional().describe('Bildausschnitt in Anteilen; w/h des Elements sollte zum Ausschnitt passen'),
  poster: z.string().optional(), autoplay: z.boolean().optional(), loop: z.boolean().optional(), muted: z.boolean().optional(),
  icon: z.string().max(40).optional().describe('lucide-Name in kebab-case'),
  graphic: z.string().max(20).optional().describe('Deko-Grafik: squiggle, swoosh, scribble, arrow, burst, waves, sparkle, blob (siehe GRAPHICS)'),
  spec: z.object({
    type: z.enum(['bar', 'hbar', 'stacked', 'waterfall', 'line', 'donut']),
    categories: z.array(z.string()).min(1).max(24),
    series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })).min(1).max(6),
    unit: z.string().max(12).optional(),
  }).optional(),
})

// Handgezeichnete Deko wie Canvas Sticker-Grafiken: Pfade im 100×100-Raster, Farbe = currentColor.
// Im Export werden sie wie Icons als Bild gerastert (measure.ts svgOf → PNG).
export const GRAPHICS: Record<string, { name: string; d: string; fill?: boolean }> = {
  squiggle: { name: 'Kringel', d: 'M2 50 Q14 18 26 50 T50 50 T74 50 T98 50' },
  swoosh: { name: 'Unterstreichung', d: 'M3 68 Q50 28 97 56' },
  scribble: { name: 'Kreis-Markierung', d: 'M62 8 C20 2 2 30 8 60 C14 92 70 98 90 70 C104 46 86 12 46 12' },
  arrow: { name: 'Pfeil geschwungen', d: 'M8 82 C28 22 68 18 90 42 M90 42 L70 38 M90 42 L86 22' },
  burst: { name: 'Strahlen', d: 'M50 4 V22 M50 78 V96 M4 50 H22 M78 50 H96 M18 18 L30 30 M70 70 L82 82 M82 18 L70 30 M18 82 L30 70' },
  waves: { name: 'Wellen', d: 'M2 30 Q26 10 50 30 T98 30 M2 62 Q26 42 50 62 T98 62' },
  sparkle: { name: 'Funkeln', d: 'M50 0 C54 40 60 46 100 50 C60 54 54 60 50 100 C46 60 40 54 0 50 C40 46 46 40 50 0 Z', fill: true },
  blob: { name: 'Klecks', d: 'M52 6 C78 4 98 26 94 52 C90 80 66 98 40 92 C14 86 2 62 8 38 C14 16 30 8 52 6 Z', fill: true },
}

export const newId = () => Math.random().toString(36).slice(2, 10)

// Mitte der Folie, Größe wie in Canva üblich
const at = (w: number, h: number) => ({ id: newId(), x: Math.round((1280 - w) / 2), y: Math.round((720 - h) / 2), w, h })

export const TEXT_PRESETS = {
  heading: { label: 'Überschrift', size: 64, bold: true, font: 'head', w: 760 },
  subheading: { label: 'Zwischenüberschrift', size: 36, bold: true, font: 'head', w: 620 },
  body: { label: 'Fließtext', size: 22, bold: false, font: 'body', w: 520 },
} as const

export const newText = (p: keyof typeof TEXT_PRESETS): Item => {
  const t = TEXT_PRESETS[p]
  return { ...at(t.w, Math.round(t.size * 1.2)), kind: 'text', text: t.label, size: t.size, bold: t.bold, font: t.font, align: 'left' }
}
export const newShape = (shape: Item['shape'], fill: string): Item =>
  shape === 'line' ? { ...at(400, 20), kind: 'shape', shape, stroke: fill, strokeW: 4 } : { ...at(280, 280), kind: 'shape', shape, fill }
export const newIcon = (icon: string, color: string): Item => ({ ...at(160, 160), kind: 'icon', icon, color })
export const newGraphic = (graphic: string, color: string): Item => ({ ...at(240, GRAPHICS[graphic]?.fill ? 240 : 120), kind: 'graphic', graphic, color })
export const newQr = (): Item => ({ ...at(200, 200), kind: 'qr', text: 'https://example.com' })
export const newMedia = (kind: 'video' | 'audio', src: string, ratio = 16 / 9, poster?: string): Item =>
  kind === 'audio' ? { ...at(120, 120), kind, src } : { ...at(Math.round(360 * Math.min(ratio, 2.2)), 360), kind, src, poster, muted: true }
export const newImage = (src: string, ratio = 1.5): Item => ({ ...at(Math.round(420 * Math.min(ratio, 1.8)), 420), kind: 'image', src })
export const newChart = (type: ChartSpec['type']): Item => ({
  ...at(640, 380), kind: 'chart',
  spec: { type, categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Umsatz', values: [12, 18, 23, 31] }] },
})

// Tabellen-Text für den Diagramm-Editor: erste Zeile = Seriennamen, erste Spalte = Kategorien, Trenner Tab oder ;
export const specToCsv = (s: ChartSpec) =>
  [['', ...s.series.map((x) => x.name)], ...s.categories.map((c, i) => [c, ...s.series.map((x) => String(x.values[i] ?? 0).replace('.', ','))])].map((r) => r.join('; ')).join('\n')
export function csvToSpec(csv: string, base: ChartSpec): ChartSpec | null {
  const rows = csv.trim().split('\n').map((r) => r.split(/\t|;/).map((c) => c.trim()))
  if (rows.length < 2 || rows[0].length < 2) return null
  const names = rows[0].slice(1)
  const body = rows.slice(1).filter((r) => r[0])
  const num = (v?: string) => Number((v ?? '0').replace(/\./g, '').replace(',', '.')) || 0
  return { ...base, categories: body.map((r) => r[0]), series: names.map((name, j) => ({ name: name || `Reihe ${j + 1}`, values: body.map((r) => num(r[j + 1])) })) }
}

// ---------- Magic Resize: Deck in ein anderes Format bringen ----------
// Freie Elemente behalten ihre relative Lage (Mitte wandert mit), Größe und Schrift skalieren mit dem kleineren Faktor,
// damit nichts verzerrt. Layout-Inhalte ordnet die Engine im neuen Format selbst an (Autofit); Überläufe meldet der Lint.
export function resizeDeck(deck: Deck, format: FormatId | Size): Deck {
  const to = typeof format === 'string' ? { w: FORMATS[format].w, h: FORMATS[format].h } : format
  const from = sizeOf(deck)
  const sx = to.w / from.w, sy = to.h / from.h, k = Math.min(sx, sy)
  const r = (v: number) => Math.round(v * 100) / 100
  const fit = (it: Item): Item => {
    const w = it.w * k, h = it.h * k
    const out: Item = { ...it, x: r((it.x + it.w / 2) * sx - w / 2), y: r((it.y + it.h / 2) * sy - h / 2), w: r(w), h: r(h) }
    if (it.size) out.size = r(it.size * k)
    if (it.strokeW) out.strokeW = r(it.strokeW * k)
    if (it.radius) out.radius = r(it.radius * k)
    return out
  }
  // Gruppen bewegen sich als Ganzes: gemeinsamer Mittelpunkt statt je Element
  const groupFit = (items: Item[]): Item[] => {
    const out = items.map(fit)
    const groups = new Set(items.flatMap((it) => (it.group ? [it.group] : [])))
    for (const g of groups) {
      const idx = items.flatMap((it, i) => (it.group === g ? [i] : []))
      const x = Math.min(...idx.map((i) => items[i].x)), y = Math.min(...idx.map((i) => items[i].y))
      const a = { cx: (x + Math.max(...idx.map((i) => items[i].x + items[i].w))) / 2, cy: (y + Math.max(...idx.map((i) => items[i].y + items[i].h))) / 2 }
      for (const i of idx) { // relative Lage innerhalb der Gruppe mit k, Gruppenmitte mit sx/sy
        out[i].x = r(a.cx * sx + (items[i].x + items[i].w / 2 - a.cx) * k - out[i].w / 2)
        out[i].y = r(a.cy * sy + (items[i].y + items[i].h / 2 - a.cy) * k - out[i].h / 2)
      }
    }
    return out
  }
  return { ...deck, size: to.w === 1280 && to.h === 720 ? undefined : to, slides: deck.slides.map((s) => (s.items?.length ? { ...s, items: groupFit(s.items) } : s)) }
}

// Selbstprüfung: npx esbuild src/shared/items.ts --bundle --platform=node | DW_ITEMS_SELFTEST=1 node
if (typeof process !== 'undefined' && process.env.DW_ITEMS_SELFTEST) {
  const spec = newChart('bar').spec!
  const back = csvToSpec(specToCsv(spec), spec)!
  if (JSON.stringify(back.series) !== JSON.stringify(spec.series) || back.categories.join() !== spec.categories.join()) throw new Error('csv roundtrip')
  if (csvToSpec('x;A\nQ1;1.234,5', spec)!.series[0].values[0] !== 1234.5) throw new Error('de number')
  const d = resizeDeck({ title: 't', theme: { id: 'x' }, transition: 'none', mode: 'click', slides: [{ id: 's', layout: 'blank', content: {}, items: [{ ...newShape('rect', '#000000'), x: 1180, y: 620, w: 100, h: 100 }] }] }, '1:1')
  const it = d.slides[0].items![0]
  if (d.size?.w !== 1080 || it.w !== 84.38 || Math.abs(it.x + it.w / 2 - 1230 * (1080 / 1280)) > 0.1 || Math.abs(it.y + it.h / 2 - 670 * 1.5) > 0.1) throw new Error('resize ' + JSON.stringify(it))
  if (resizeDeck(d, '16:9').size !== undefined) throw new Error('resize back')
  console.log('items ok')
}
