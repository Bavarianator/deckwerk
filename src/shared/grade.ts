// Farbkorrektur der Pro-Timeline: dieselben Tabellen für Vorschau (SVG feComponentTransfer + feColorMatrix) und Export (ffmpeg lut1d + colorchannelmixer).
// Reihenfolge immer: erst Tabellen je Kanal (lift/gamma/gain/temp), dann Sättigungsmatrix. Eingang und Ausgang gamma-kodiertes sRGB.
import { TL, type Grade, type RGB } from './timeline'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const near = (a: number, b: number) => Math.abs(a - b) < 1e-4
const rgb = (v: RGB | undefined, d: number, lim: { min: number; max: number }) => [0, 1, 2].map((i) => clamp(v?.[i] ?? d, lim.min, lim.max))
const satOf = (sat?: number) => clamp(sat ?? 1, TL.sat.min, TL.sat.max)

export const isNeutral = (g?: Grade) => !g || (rgb(g.lift, 0, TL.lift).every((v) => near(v, 0)) && rgb(g.gamma, 1, TL.gamma).every((v) => near(v, 1))
  && rgb(g.gain, 1, TL.gain).every((v) => near(v, 1)) && near(satOf(g.sat), 1) && near(clamp(g.temp ?? 0, TL.temp.min, TL.temp.max), 0))

/** Je Kanal 256 Ausgangswerte: y = gain·(x + lift·(1−x)), geklemmt, dann ^(1/gamma). temp > 0 verstärkt Rot und dämpft Blau (< 0 umgekehrt) */
export function gradeTables(g?: Grade): [Uint8Array, Uint8Array, Uint8Array] {
  const lift = rgb(g?.lift, 0, TL.lift), gamma = rgb(g?.gamma, 1, TL.gamma), gain = rgb(g?.gain, 1, TL.gain)
  const temp = clamp(g?.temp ?? 0, TL.temp.min, TL.temp.max)
  const k = [1 + 0.1 * temp, 1, 1 - 0.1 * temp]
  return [0, 1, 2].map((c) => {
    const t = new Uint8Array(256)
    for (let i = 0; i < 256; i++) {
      const x = i / 255, y = clamp(gain[c] * k[c] * (x + lift[c] * (1 - x)), 0, 1)
      t[i] = Math.round(y ** (1 / gamma[c]) * 255)
    }
    return t
  }) as [Uint8Array, Uint8Array, Uint8Array]
}

/** Sättigung als 3×3-Matrix (zeilenweise): M = (1−s)·L + s·I mit Rec.709-Luma; passt zu feColorMatrix und colorchannelmixer */
export function satMatrix(sat = 1): number[] {
  const s = satOf(sat), L = [0.2126, 0.7152, 0.0722]
  return [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => (1 - s) * L[c] + (r === c ? s : 0)))
}

const fx = (v: number, d: number) => String(+v.toFixed(d))

/** ffmpeg-Filter für die Sättigung, null wenn neutral */
export function satFilter(sat?: number): string | null {
  if (near(satOf(sat), 1)) return null
  const m = satMatrix(sat), k = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb']
  return `colorchannelmixer=${k.map((n, i) => `${n}=${fx(m[i], 4)}`).join(':')}`
}

/** Inhalt einer .cube-Datei für ffmpeg lut1d */
export function cube1d(g?: Grade): string {
  const [r, gr, b] = gradeTables(g)
  const rows = Array.from({ length: 256 }, (_, i) => [r[i], gr[i], b[i]].map((v) => (v / 255).toFixed(6)).join(' '))
  return ['LUT_1D_SIZE 256', ...rows].join('\n') + '\n'
}

/** tableValues je Kanal für feComponentTransfer type=table */
export function svgTables(g?: Grade): { r: string; g: string; b: string } {
  const [r, gr, b] = gradeTables(g).map((t) => Array.from(t, (v) => (v / 255).toFixed(4)).join(' '))
  return { r, g: gr, b }
}

/** Tabellen und Sättigung in place auf RGBA-Pixel (Scopes im Renderer) */
export function applyTables(data: Uint8ClampedArray, t: ReturnType<typeof gradeTables>, sat?: number): void {
  const m = near(satOf(sat), 1) ? null : satMatrix(sat)
  for (let i = 0; i < data.length; i += 4) {
    const r = t[0][data[i]], g = t[1][data[i + 1]], b = t[2][data[i + 2]]
    if (!m) { data[i] = r; data[i + 1] = g; data[i + 2] = b; continue }
    data[i] = m[0] * r + m[1] * g + m[2] * b // Uint8ClampedArray rundet und klemmt
    data[i + 1] = m[3] * r + m[4] * g + m[5] * b
    data[i + 2] = m[6] * r + m[7] * g + m[8] * b
  }
}

// Zurückhaltende Annäherungen an LOOK_FILTER (video-fx.ts). Kontrast c um die Mitte: gain·(1+lift) = 1, gain·(1−lift) = c
const all = (v: number): RGB => [v, v, v]
export const GRADE_PRESETS: Record<string, Grade> = {
  neutral: {},
  warm: { temp: 0.5 },
  kuehl: { temp: -0.5 },
  kontrast: { lift: all(-0.057), gain: all(1.06), sat: 1.15 },
  matt: { lift: all(0.064), gain: all(0.94), sat: 0.85 },
  sw: { lift: all(-0.038), gain: all(1.04), sat: 0 },
}
