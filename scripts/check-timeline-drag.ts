// Pro-Timeline Ziehen-Mathe: npx esbuild scripts/check-timeline-drag.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-timeline-drag.mjs && node ${TMPDIR:-/tmp}/check-timeline-drag.mjs
import assert from 'node:assert/strict'
import { dragOps, fadeDrag, fmtTick, modeAt, ovDrag, rows, ticks, trackAtRow, wave } from '../src/renderer/ui/timeline/drag'
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

// Blenden-Griffe: nach innen ziehen, Grenze 0..min(TL.fade.max, Clip-Länge)
assert.deepEqual(fadeDrag(c2, 'in', 1.5), { op: 'set', clip: 'c2', patch: { fade: [1.5, 0] } })
assert.deepEqual(fadeDrag(c2, 'out', -1), { op: 'set', clip: 'c2', patch: { fade: [0, 1] } }, 'Ende: nach links = länger')
assert.deepEqual(fadeDrag(c2, 'out', 2).patch, { fade: [0, 0] }, 'nicht unter 0')
assert.deepEqual(fadeDrag(c2, 'in', 9).patch, { fade: [4, 0] }, 'höchstens Clip-Länge')
const long = { id: 'x', src: 'l.mp4', at: 0, in: 0, out: 60, fade: [2, 3] as [number, number] }
assert.deepEqual(fadeDrag(long, 'in', 30).patch, { fade: [10, 3] }, 'höchstens TL.fade.max')
assert.deepEqual(fadeDrag(long, 'out', 0.5).patch, { fade: [2, 2.5] }, 'vom Stand bei pointerdown')
assert.deepEqual(applyOps(tl, [fadeDrag(c2, 'in', 1)]).tracks[0].clips[1].fade, [1, 0])

// Text-Einblendungen: verschieben, trimmen, Mindestlänge, Bilder, Einrasten
const ot: TimelineContent = { ...tl, overlays: [{ start: 1, end: 3, text: 'Hallo' }, { start: 20, end: 22, text: 'B' }] }
const ob = { i: 0, snapping: false, zoom: 100, t: 0, fps: 30 }
assert.deepEqual(ovDrag(ot, { ...ob, mode: 'move', dt: 1.5 }).overlays![0], { start: 2.5, end: 4.5, text: 'Hallo' })
assert.deepEqual(ovDrag(ot, { ...ob, mode: 'move', dt: -5 }).overlays![0], { start: 0, end: 2, text: 'Hallo' }, 'nicht vor 0')
assert.equal(ovDrag(ot, { ...ob, mode: 'move', dt: 0.011 }).overlays![0].start, 1, 'auf Bilder gerundet')
assert.equal(ovDrag(ot, { ...ob, mode: 'out', dt: 1 }).overlays![0].end, 4)
assert.equal(ovDrag(ot, { ...ob, mode: 'in', dt: -0.5 }).overlays![0].start, 0.5)
const shortIn = ovDrag(ot, { ...ob, mode: 'in', dt: 5 }).overlays![0], shortOut = ovDrag(ot, { ...ob, mode: 'out', dt: -5 }).overlays![0]
assert.ok(shortIn.end > shortIn.start + 0.3 && shortIn.end === 3, JSON.stringify(shortIn))
assert.ok(shortOut.end > shortOut.start + 0.3 && shortOut.start === 1, JSON.stringify(shortOut))
assert.equal(ovDrag(ot, { ...ob, mode: 'in', dt: -5 }).overlays![0].start, 0, 'Anfang nicht vor 0')
assert.deepEqual(ovDrag(ot, { ...ob, snapping: true, mode: 'move', dt: 2.96 }).overlays![0], { start: 4, end: 6, text: 'Hallo' }, 'Anfang 3.96 rastet am Ende von c1 (4)')
assert.equal(ovDrag(ot, { ...ob, snapping: true, t: 5, mode: 'out', dt: 1.95 }).overlays![0].end, 5, 'Ende rastet am Abspielkopf')
assert.equal(ot.overlays![0].start, 1, 'Eingabe unverändert')
assert.equal(ovDrag(ot, { ...ob, i: 5, mode: 'move', dt: 1 }), ot, 'unbekannter Index: unverändert')

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
