// Farbrad-Mathematik der Farbseite: npx esbuild scripts/check-color-wheel.ts --bundle --platform=node --format=esm --log-level=warning --outfile=${TMPDIR:-/tmp}/check-color-wheel.mjs && node ${TMPDIR:-/tmp}/check-color-wheel.mjs
import { ok } from 'node:assert'
import { TL, type RGB } from '../src/shared/timeline'
import { rgbToWheel, wheelToRgb } from '../src/renderer/ui/timeline/wheel-math'

const near = (a: number[], b: number[], e = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < e)

// Mitte = neutral
ok(near(wheelToRgb(0, 0, 0, TL.lift), [0, 0, 0]))
ok(near(wheelToRgb(0, 0, 1, TL.gamma), [1, 1, 1]))
ok(near(wheelToRgb(0, 0, 1, TL.gain), [1, 1, 1]))

// Hin- und Rückweg
for (const [lim, m] of [[TL.lift, 0], [TL.gamma, 1], [TL.gain, 1.1], [TL.lift, 0.1]] as const)
  for (const [x, y] of [[0, 0], [0.3, -0.2], [-0.7, 0.5], [0, 1], [0.6, 0.8]]) {
    const v = wheelToRgb(x, y, m, lim), w = rgbToWheel(v, lim)
    ok(near([w.x, w.y, w.master], [x, y, m]), `Rückweg ${x},${y},${m}`)
    ok(near(wheelToRgb(w.x, w.y, w.master, lim), v))
  }
const g: RGB = [1.1, 0.95, 1.02], w = rgbToWheel(g, TL.gain)
ok(near(wheelToRgb(w.x, w.y, w.master, TL.gain), g), 'vorhandene Werte')

// Richtung Rot: R steigt, G und B fallen
const r = wheelToRgb(1, 0, 1, TL.gain)
ok(r[0] > 1 && r[1] < 1 && r[2] < 1 && Math.abs(r[1] - r[2]) < 1e-9)

// Klemmen
for (const lim of [TL.lift, TL.gamma, TL.gain])
  for (const v of [wheelToRgb(5, -3, 99, lim), wheelToRgb(-1, 0, -99, lim)]) ok(v.every((c) => c >= lim.min && c <= lim.max), 'Grenzen')
ok(near(wheelToRgb(3, 0, 0, TL.lift), wheelToRgb(1, 0, 0, TL.lift)), 'Radius ≤ 1')
const far = rgbToWheel([9, -9, 0], TL.lift)
ok(Math.hypot(far.x, far.y) <= 1 + 1e-9 && far.master >= TL.lift.min && far.master <= TL.lift.max)

console.log('ok')
