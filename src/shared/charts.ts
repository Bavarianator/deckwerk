// Gemeinsame Diagramm-Logik für Vorschau (Chart.js) und PPTX-Export, damit beide gleich aussehen:
// Fokusfarbe, Wasserfall-Zerlegung, Zahlenformat und die automatisch berechnete Annotation.
import type { ChartSpec } from './deck'
import { mix, type Theme } from './themes'

// Seriennamen des Wasserfalls. pptx-post.ts erkennt die Serien daran (Basis unsichtbar, Formate mit Vorzeichen).
export const WF = { base: 'Basis (unsichtbar)', up: 'Anstieg', down: 'Rückgang', total: 'Summe' } as const

// Werte direkt an Balken statt Wertachse + Gitter; bei sehr vielen Balken zurück zur Achse (sonst Zahlensalat).
export const valueLabels = (spec: ChartSpec) => spec.type !== 'line' && spec.type !== 'donut' && spec.categories.length * spec.series.length <= 20

export const decimals = (spec: ChartSpec) => (spec.series.some((s) => s.values.some((v) => !Number.isInteger(v))) ? 1 : 0)
export const fmt = (v: number, dec = 1) => v.toLocaleString('de-DE', { minimumFractionDigits: dec, maximumFractionDigits: dec })

// Fokus: Die Serie bzw. Kategorie aus `highlight` bekommt die Akzentfarbe, alles andere Grau (Knaflic).
// perPoint nur bei genau einer Serie (eine Farbe pro Balken), sonst eine Farbe pro Serie.
export function chartColors(spec: ChartSpec, t: Theme): { perSeries: string[]; perPoint?: string[] } {
  const grey = (k: number) => mix(t.c.bg, t.c.muted, 0.55 - 0.12 * (k % 3))
  const h = spec.highlight
  const si = h ? spec.series.findIndex((s) => s.name === h) : -1
  const ci = h ? spec.categories.indexOf(h) : -1
  if (si >= 0) {
    let k = 0
    return { perSeries: spec.series.map((_, i) => (i === si ? t.c.chart[0] : grey(k++))) }
  }
  if (ci >= 0 && (spec.series.length === 1 || spec.type === 'donut')) // Balken einheitlich grau, Donut-Stücke abgestuft
    return { perSeries: [t.c.chart[0]], perPoint: spec.categories.map((_, i) => (i === ci ? t.c.chart[0] : grey(spec.type === 'donut' ? i : 0))) }
  return { perSeries: spec.series.map((_, i) => t.c.chart[i % t.c.chart.length]) }
}

// Wasserfall: erster und letzter Wert sind Summen, dazwischen Veränderungen mit Vorzeichen.
// Gestapelt aus unsichtbarer Basis + Anstieg + Rückgang + Summe (editierbar in PowerPoint, kein chartEx).
// ponytail: Laufsumme unter 0 wird nicht gesondert behandelt; bei Bedarf Basis/Balken über die Nulllinie splitten.
export function waterfall(values: number[]) {
  const w = { base: [] as number[], up: [] as number[], down: [] as number[], total: [] as number[] }
  let run = 0
  values.forEach((v, i) => {
    if (i === 0 || i === values.length - 1) {
      w.base.push(0), w.up.push(0), w.down.push(0), w.total.push(v)
      run = v
    } else if (v >= 0) {
      w.base.push(run), w.up.push(v), w.down.push(0), w.total.push(0)
      run += v
    } else {
      run += v
      w.base.push(run), w.up.push(0), w.down.push(-v), w.total.push(0)
    }
  })
  return w
}

// Automatische Annotation vom ersten zum letzten Wert der Fokus-Serie. Aus den Daten gerechnet, nie von der KI geschrieben.
export function annotation(spec: ChartSpec): string | undefined {
  if (!spec.annotate || spec.type === 'donut' || spec.type === 'waterfall') return
  const s = spec.series.find((x) => x.name === spec.highlight) ?? spec.series[0]
  const n = s.values.length - 1
  const a = s.values[0], b = s.values[n]
  if (n < 1 || a === undefined || b === undefined) return
  const span = `${spec.categories[0]}–${spec.categories[n]}`
  const signed = (x: number, dec: number) => `${x < 0 ? '−' : '+'}${fmt(Math.abs(x), dec)}`
  if (spec.annotate === 'cagr') return a > 0 && b > 0 ? `CAGR ${span}: ${signed((Math.pow(b / a, 1 / n) - 1) * 100, 1)} %` : undefined
  const unit = spec.unit === '%' ? ' Pp.' : spec.unit ? ` ${spec.unit}` : ''
  const rel = spec.unit !== '%' && a !== 0 ? ` (${signed(((b - a) / Math.abs(a)) * 100, 0)} %)` : ''
  return `${span}: ${signed(b - a, decimals(spec))}${unit}${rel}`
}

// Lesbare Beschriftungsfarbe auf einer Füllfarbe (für Werte in gestapelten Balken).
export function readableOn(fill: string): string {
  const n = parseInt(fill.replace('#', ''), 16)
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const l = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
  return l > 0.36 ? '#161616' : '#FFFFFF'
}
