// Pro-Timeline Ziehen-Mathe: npx esbuild scripts/check-timeline-drag.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-timeline-drag.mjs && node ${TMPDIR:-/tmp}/check-timeline-drag.mjs
import assert from 'node:assert/strict'
import { dragOps, fmtTick, modeAt, rows, ticks, trackAtRow, wave } from '../src/renderer/ui/timeline/drag'
import { applyOps } from '../src/shared/timeline-edit'
import type { TimelineContent } from '../src/shared/timeline'

// Kante oder Mitte
assert.equal(modeAt(2, 100), 'in')
assert.equal(modeAt(98, 100), 'out')
assert.equal(modeAt(50, 100), 'move')
assert.equal(modeAt(5, 12), 'move', 'schmaler Clip: Mitte bleibt greifbar')

const tl: TimelineContent = {
  tracks: [
    { id: 'v1', kind: 'video', clips: [{ id: 'c1', src: 'a.mp4', at: 0, in: 0, out: 4 }, { id: 'c2', src: 'b.mp4', at: 6, in: 0, out: 4 }] },
    { id: 'a1', kind: 'audio', clips: [{ id: 'c3', src: 'm.mp3', at: 0, in: 0, out: 10 }] },
    { id: 'v2', kind: 'video', clips: [] },
  ],
  markers: [{ t: 12, name: 'Ende' }],
}

// Anzeige: V2 oben, V1, dann A1
const r = rows(tl.tracks)
assert.deepEqual(r.map((x) => x.label), ['V2', 'V1', 'A1'])
assert.deepEqual(r.map((x) => x.track.id), ['v2', 'v1', 'a1'])
assert.equal(trackAtRow(r, 0, 'video', 'v1'), 'v2')
assert.equal(trackAtRow(r, 2, 'video', 'v1'), 'v1', 'Audiozeile ist kein Ziel für Video')
assert.equal(trackAtRow(r, 9, 'audio', 'a1'), 'a1', 'geklemmt')

const c2 = tl.tracks[0].clips[1]
const base = { snapping: false, zoom: 100, t: 0 }
// Verschieben ohne Einrasten
assert.deepEqual(dragOps(tl, { ...base, clip: c2, mode: 'move', dt: 1.5 }), [{ op: 'move', clip: 'c2', at: 7.5 }])
assert.deepEqual(dragOps(tl, { ...base, clip: c2, mode: 'move', dt: -20 })[0], { op: 'move', clip: 'c2', at: 0 }, 'nicht vor 0')
// Einrasten, Toleranz 8 px / 100 px/s = 0,08 s
assert.deepEqual(dragOps(tl, { ...base, snapping: true, clip: c2, mode: 'move', dt: 0.05 })[0], { op: 'move', clip: 'c2', at: 6 }, 'Ende 10.05 rastet am Ende von c3 (10)')
assert.deepEqual(dragOps(tl, { ...base, snapping: true, clip: c2, mode: 'move', dt: 2.04 })[0], { op: 'move', clip: 'c2', at: 8 }, 'Ende 12.04 rastet am Marker 12')
assert.deepEqual(dragOps(tl, { ...base, snapping: true, clip: c2, mode: 'move', dt: 1 })[0], { op: 'move', clip: 'c2', at: 7 }, 'außerhalb der Toleranz bleibt es')
// Spurwechsel
const toV2 = applyOps(tl, dragOps(tl, { ...base, clip: c2, mode: 'move', dt: 0, track: 'v2' }))
assert.equal(toV2.tracks[2].clips[0].id, 'c2')
// Trimmen, mit Ripple und Einrasten am Abspielkopf
assert.deepEqual(dragOps(tl, { ...base, clip: c2, mode: 'out', dt: -1 }), [{ op: 'trim', clip: 'c2', edge: 'out', t: 9 }])
assert.deepEqual(dragOps(tl, { ...base, clip: c2, mode: 'in', dt: 0.5, ripple: true }), [{ op: 'trim', clip: 'c2', edge: 'in', t: 6.5, ripple: true }])
assert.deepEqual(dragOps(tl, { ...base, snapping: true, t: 7, clip: c2, mode: 'in', dt: 0.97 })[0], { op: 'trim', clip: 'c2', edge: 'in', t: 7 })
// Nicht kumulativ: zweimal derselbe Versatz auf base ergibt dasselbe
const once = applyOps(tl, dragOps(tl, { ...base, clip: c2, mode: 'move', dt: 1 }))
assert.equal(once.tracks[0].clips[1].at, 7)
assert.equal(tl.tracks[0].clips[1].at, 6, 'Eingabe unverändert')
// Überlappung wirft (UI behält dann den letzten gültigen Stand)
assert.throws(() => applyOps(tl, dragOps(tl, { ...base, clip: c2, mode: 'move', dt: -4 })), /überlappt/)

// Lineal
const z = ticks(100, 30)
assert.ok(z.major * 100 >= 70 && z.minor * 100 >= 8 && z.minor <= z.major, JSON.stringify(z))
assert.equal(ticks(1000, 25).major, 2 / 25, 'stark gezoomt: 2 Bilder')
assert.ok(ticks(1, 30).major >= 60, 'weit weg: Minuten')
assert.equal(fmtTick(75, 30, false), '01:15')
assert.equal(fmtTick(1 + 5 / 30, 30, true), ':05')
assert.equal(fmtTick(2, 30, true), '00:02')
assert.equal(fmtTick(3725, 30, false), '1:02:05')

// Waveform-Ausschnitt: 100 Werte/s, in 1 s bis out 2 s
const p = new Uint8Array(300)
p.fill(255, 100, 150)
const w = wave(p, { in: 1, out: 2 }, 4)
assert.deepEqual(w, [1, 1, 0, 0])
assert.deepEqual(wave(p, { in: 5, out: 6 }, 3), [], 'jenseits der Peaks')

console.log('check-timeline-drag ok')
