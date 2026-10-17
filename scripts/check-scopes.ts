// Pro-Timeline Scopes und Pegel-Rampen: npx esbuild scripts/check-scopes.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-scopes.mjs && node ${TMPDIR:-/tmp}/check-scopes.mjs
import assert from 'node:assert/strict'
import { histogram, waveform } from '../src/renderer/ui/timeline/scope-math'
import { gainAt, keysToRamps } from '../src/renderer/ui/timeline/audioGraph'
import type { TLClip } from '../src/shared/timeline'

// Graukeil 256×1: Spalte c hat genau einen Treffer bei Luma c
const ramp = new Uint8ClampedArray(256 * 4)
for (let i = 0; i < 256; i++) ramp.set([i, i, i, 255], i * 4)
const wf = waveform(ramp, 256, 1)
assert.equal(wf.length, 256 * 256)
for (let c = 0; c < 256; c++) for (let v = 0; v < 256; v++) assert.equal(wf[c * 256 + v], v === c ? 1 : 0, `Spalte ${c}, Luma ${v}`)
assert.equal(waveform(ramp, 256, 1, 4)[3 * 256 + 255], 1, 'weniger Spalten fassen zusammen')

// Einfarbbild: je Kanal ein Peak
const one = new Uint8ClampedArray(10 * 4)
for (let i = 0; i < 10; i++) one.set([200, 50, 10, 255], i * 4)
const h = histogram(one)
const peaks = (a: Uint32Array) => [...a.keys()].filter((k) => a[k])
assert.deepEqual(peaks(h.r), [200]); assert.equal(h.r[200], 10)
assert.deepEqual(peaks(h.g), [50]); assert.deepEqual(peaks(h.b), [10])
assert.deepEqual(peaks(h.y), [Math.round(0.2126 * 200 + 0.7152 * 50 + 0.0722 * 10)])

// Keys [Quellsekunde, dB] an Clip at=5, in=10, speed=2 → Timeline 5 (0 dB) und 6 (−20 dB)
const clip: TLClip = { id: 'c1', src: 'a.mp4', at: 5, in: 10, out: 14, speed: 2, keys: [[12, -20], [10, 0]] }
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`)
const r0 = keysToRamps(clip, 0)
assert.deepEqual(r0.map((r) => r.t), [0, 5, 6])
near(r0[1].gain, 1); near(r0[2].gain, 0.1)
const r1 = keysToRamps(clip, 5.5) // mitten drin: −10 dB, nur der spätere Key bleibt
assert.deepEqual(r1.map((r) => r.t), [0, 0.5])
near(r1[0].gain, 10 ** -0.5); near(r1[1].gain, 0.1)
const r2 = keysToRamps(clip, 7) // nach dem letzten Key: dessen Wert
assert.equal(r2.length, 1); near(r2[0].gain, 0.1)
assert.deepEqual(keysToRamps({ ...clip, keys: undefined }, 0), [])
// Kurvenmitte linear in dB wie keyExpr im Export: [[0,−6],[10,−60]] → bei 5 s −33 dB
const mid = keysToRamps({ id: 'c2', src: 'a.mp4', at: 0, in: 0, out: 10, keys: [[0, -6], [10, -60]] }, 0)
near(20 * Math.log10(gainAt(mid, 5)), -33)
near(gainAt(mid, -1), mid[0].gain); near(gainAt(mid, 20), 10 ** -3)
near(20 * Math.log10(gainAt(r0, 5.5)), -10)
console.log('check-scopes: ok')
