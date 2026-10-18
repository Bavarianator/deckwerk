// Pro-Timeline Schnitt-Operationen: npx esbuild scripts/check-timeline-edit.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-timeline-edit.mjs && node ${TMPDIR:-/tmp}/check-timeline-edit.mjs
import assert from 'node:assert/strict'
import { clipEnd, clipLen, srcAt, tlDuration, type TimelineContent } from '../src/shared/timeline'
import { addClip, addTrack, applyOps, lift, lintTimeline, move, rippleDelete, setClip, snap, snapTargets, split, trim } from '../src/shared/timeline-edit'

const tl: TimelineContent = {
  tracks: [
    { id: 'v1', kind: 'video', clips: [{ id: 'c1', src: 'a.mp4', at: 0, in: 10, out: 14, keys: [[10, 0], [12, -6], [13, -3]] }, { id: 'c2', src: 'b.mp4', at: 4, in: 0, out: 4, speed: 2 }, { id: 'c5', src: 'b.mp4', at: 8, in: 5, out: 7 }] },
    { id: 'v2', kind: 'video', clips: [{ id: 'c3', src: 'c.mp4', at: 4, in: 0, out: 2 }] },
    { id: 'a1', kind: 'audio', clips: [{ id: 'c4', src: 'm.mp3', at: 0, in: 0, out: 9 }] },
  ],
  markers: [{ t: 6.5, name: 'Drop' }],
}
const orig = structuredClone(tl)
const ids = (t: TimelineContent, i: number) => t.tracks[i].clips.map((c) => [c.id, c.at])

// split: Gesamtlänge und Quellkontinuität bleiben
const s = split(tl, 'c1', 2.5)
const [a, b] = s.tracks[0].clips
assert.equal(b.id, 'c6')
assert.equal(clipLen(a) + clipLen(b), 4)
assert.equal(a.out, b.in)
assert.equal(clipEnd(a), b.at)
assert.equal(srcAt(b, 3), 13)
assert.deepEqual(a.keys, [[10, 0], [12, -6]])
assert.deepEqual(b.keys, [[13, -3]])
assert.throws(() => split(tl, 'c1', 0), /nicht innerhalb/)
assert.throws(() => split(tl, 'c1', 4), /nicht innerhalb/)

// trim ohne ripple: am Nachbarn und an Quellsekunde 0 geklemmt
assert.equal(clipEnd(trim(tl, 'c1', 'out', 6).tracks[0].clips[0]), 4)
const ti = trim(tl, 'c2', 'in', 1).tracks[0].clips[1]
assert.deepEqual([ti.at, ti.in, clipEnd(ti)], [4, 0, 6], 'c2 hat keine Quelle vor 0, Nachbar c1 endet bei 4')
const t5 = trim(tl, 'c5', 'in', 5).tracks[0].clips[2]
assert.deepEqual([t5.at, t5.in], [6, 3], 'In-Kante zieht Quelle mit, am Nachbarn c2 geklemmt')
// ripple trim: Lücke schließt sich, nur dieselbe Spur rückt
const rt = trim(tl, 'c1', 'out', 3, true)
assert.deepEqual(ids(rt, 0), [['c1', 0], ['c2', 3], ['c5', 7]])
assert.deepEqual(rt.tracks[1].clips[0].at, 4)
assert.deepEqual(rt.tracks[2].clips[0].at, 0)
const ri = trim(tl, 'c5', 'in', 9, true).tracks[0].clips[2]
assert.deepEqual([ri.at, ri.in, ri.out], [8, 6, 7], 'ripple an der In-Kante: Anfang bleibt stehen')

// ripple delete und lift
const rd = rippleDelete(tl, 'c2')
assert.deepEqual(ids(rd, 0), [['c1', 0], ['c5', 6]])
assert.equal(rd.tracks[1].clips[0].at, 4)
assert.deepEqual(ids(lift(tl, 'c2'), 0), [['c1', 0], ['c5', 8]])

// move
assert.throws(() => move(tl, 'c3', 3, 'v1'), /überlappt/)
assert.throws(() => move(tl, 'c3', 0, 'a1'), /passt nicht/)
assert.throws(() => move(tl, 'c3', -1), /negativ/)
const mv = move(tl, 'c3', 10.01, 'v1')
assert.deepEqual(ids(mv, 0).at(-1), ['c3', 10])
assert.equal(mv.tracks[1].clips.length, 0)

// add/set
const at = addTrack(tl, 'video')
assert.deepEqual([at.tracks.length, at.tracks[3].id, at.tracks[3].kind], [4, 'v3', 'video'])
assert.equal(addTrack(tl, 'audio').tracks[3].id, 'a2')
const ac = addClip(tl, 'v2', { id: 'c1', src: 'x.mp4', at: 0, in: 0, out: 1 })
assert.deepEqual(ids(ac, 1), [['c6', 0], ['c3', 4]], 'vergebene ID wird ersetzt')
assert.throws(() => addClip(tl, 'v2', { src: 'x.mp4', at: 3, in: 0, out: 2 }), /überlappt/)
assert.equal(setClip(tl, 'c3', { volume: 0.5 }).tracks[1].clips[0].volume, 0.5)
assert.throws(() => setClip(tl, 'c2', { at: 3 }), /überlappt/)

// snap
const tg = snapTargets(tl, 'c3', [5.2])
assert.ok(tg.includes(6.5) && tg.includes(5.2) && tg.includes(6) && tg.includes(9))
assert.equal(snap(6.42, tg, 0.1), 6.5)
assert.equal(snap(7.3, tg, 0.1), 7.3)

// applyOps
const ap = applyOps(tl, [{ op: 'split', clip: 'c4', t: 3 }, { op: 'ripple_delete', clip: 'c4' }, { op: 'add_track', kind: 'audio' }])
assert.deepEqual(ids(ap, 2), [['c6', 0]])
assert.equal(tlDuration(ap), 10)
assert.throws(() => applyOps(tl, [{ op: 'lift', clip: 'c1' }, { op: 'lift', clip: 'c3' }, { op: 'trim', clip: 'c1', edge: 'in', t: 1 }]), /^Error: Op 3 \(trim\): Clip c1 nicht gefunden/)

// lint
assert.deepEqual(lintTimeline(tl).map((i) => i.msg), ['Lücke auf v1 von 6s bis 8s (Schwarzbild)'])
const bad: TimelineContent = {
  tracks: [
    { id: 'v1', kind: 'video', clips: [{ id: 'x', src: 'a', at: 1, in: 0, out: 2 }, { id: 'y', src: 'a', at: 2, in: 0, out: 2 }, { id: 'z', src: 'a', at: 4, in: -1, out: -1 }] },
    { id: 'a1', kind: 'audio', clips: [{ id: 'x', src: 'a', at: 0, in: 0, out: 0.04 }] },
  ],
}
const msgs = lintTimeline(bad).map((i) => `${i.level}: ${i.msg}`)
assert.ok(msgs.includes('error: Clip x überlappt y auf Spur v1'), msgs.join('\n'))
assert.ok(msgs.includes('error: ID x doppelt'))
assert.ok(msgs.includes('error: Clip z: out muss nach in liegen'))
assert.ok(msgs.includes('error: Clip z: in vor Quellsekunde 0'))
assert.ok(msgs.includes('warn: Clip x ist kürzer als 2 Bilder'))
assert.ok(msgs.some((m) => m.startsWith('warn: Lücke auf v1 von 0s bis 1s')))
assert.deepEqual(lintTimeline({ tracks: [] }).map((i) => i.msg), ['Keine Videospur'])

assert.deepEqual(tl, orig, 'Eingabe unverändert')
// split: Einblenden und Überblendung vorn, Ausblenden hinten
const sf = split({ tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c1', src: 'a', at: 0, in: 0, out: 4, fade: [1, 1], xfade: 0.5 }] }] }, 'c1', 2)
assert.deepEqual(sf.tracks[0].clips.map((c) => [c.fade, c.xfade]), [[[1, 0], 0.5], [[0, 1], undefined]])
// Lint: Überblendung ohne Vorgänger, zu wenig Material vor in
const xl = lintTimeline({ tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'c1', src: 'a', at: 0, in: 0, out: 2, xfade: 1 }, { id: 'c2', src: 'a', at: 2, in: 0, out: 2, xfade: 1 }] }] })
assert.ok(xl.some((x) => x.clip === 'c1' && /ohne direkt/.test(x.msg)))
assert.ok(xl.some((x) => x.clip === 'c2' && /fehlen 0.5 s/.test(x.msg)))
console.log('check-timeline-edit: ok')
