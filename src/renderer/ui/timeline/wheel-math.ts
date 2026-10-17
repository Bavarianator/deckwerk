// Farbrad ↔ RGB: Punkt (x, y) im Einheitskreis (y nach oben), R bei 0°, G bei 120°, B bei 240°. Master = Mittelwert der Kanäle
import type { RGB } from '../../../shared/timeline'

type Lim = { min: number; max: number }
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const PHI = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]
// Rand des Rads = Achtel des Wertebereichs als Abweichung je Kanal, sonst wird schon ein kleiner Zug zu grell
const span = (lim: Lim) => (lim.max - lim.min) / 8

/** Radpunkt + Master → Kanalwerte; Radius auf 1 und Kanäle auf die Grenzen geklemmt */
export function wheelToRgb(x: number, y: number, master: number, lim: Lim): RGB {
  const r = Math.hypot(x, y), k = r > 1 ? 1 / r : 1, m = clamp(master, lim.min, lim.max), s = span(lim)
  return PHI.map((p) => clamp(m + s * k * (x * Math.cos(p) + y * Math.sin(p)), lim.min, lim.max)) as RGB
}

/** Umkehrung: Kanalwerte → Radpunkt + Master (Σ cos²φ = 3/2, darum 2/3) */
export function rgbToWheel(rgb: RGB, lim: Lim): { x: number; y: number; master: number } {
  const v = rgb.map((c) => clamp(c, lim.min, lim.max)), m = (v[0] + v[1] + v[2]) / 3, s = span(lim)
  let x = 0, y = 0
  PHI.forEach((p, i) => { x += ((2 / 3) * (v[i] - m) * Math.cos(p)) / s; y += ((2 / 3) * (v[i] - m) * Math.sin(p)) / s })
  const r = Math.hypot(x, y)
  return r > 1 ? { x: x / r, y: y / r, master: m } : { x, y, master: m }
}
