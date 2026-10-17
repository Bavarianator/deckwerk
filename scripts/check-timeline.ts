// Pro-Timeline Zeitachse: npx esbuild scripts/check-timeline.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-timeline.mjs && node ${TMPDIR:-/tmp}/check-timeline.mjs
import assert from 'node:assert/strict'
import { activeAt, clipLen, cutPoints, fpsArg, newId, snapFrame, srcAt, tlAt, tlDuration, type TimelineContent } from '../src/shared/timeline'

const tl: TimelineContent = {
  tracks: [
    { id: 'v1', kind: 'video', clips: [{ id: 'c1', src: 'a.mp4', at: 0, in: 10, out: 14 }, { id: 'c2', src: 'b.mp4', at: 5, in: 0, out: 4, speed: 2 }] },
    { id: 'v2', kind: 'video', clips: [{ id: 'c3', src: 'c.mp4', at: 1, in: 0, out: 2 }] },
    { id: 'a1', kind: 'audio', clips: [{ id: 'c4', src: 'm.mp3', at: 0, in: 0, out: 9 }] },
  ],
}
assert.equal(clipLen({ in: 0, out: 4, speed: 2 }), 2)
assert.equal(clipLen({ in: 0, out: 4, speed: 100 }), 1, 'Tempo auf 4 geklemmt')
assert.equal(tlDuration(tl), 9)
assert.equal(srcAt(tl.tracks[0].clips[1], 6), 2)
assert.equal(tlAt(tl.tracks[0].clips[1], 2), 6)
// Lücke auf V1 bei 4.5: nur Audio
assert.deepEqual(activeAt(tl, 4.5).map((a) => a.clip.id), ['c4'])
assert.deepEqual(activeAt(tl, 1.5).map((a) => a.clip.id), ['c1', 'c3', 'c4'])
assert.deepEqual(activeAt(tl, 1.5, 'video').map((a) => a.clip.id), ['c1', 'c3'])
assert.deepEqual(activeAt({ tracks: [{ ...tl.tracks[1], hide: true }] }, 1.5), [])
assert.equal(activeAt(tl, 4).length, 1, 'Ende exklusiv')
assert.deepEqual(cutPoints(tl), [0, 1, 3, 4, 5, 7, 9])
assert.equal(fpsArg(29.97), '30000/1001')
assert.equal(fpsArg(23.976), '24000/1001')
assert.equal(fpsArg(59.94), '60000/1001')
assert.equal(fpsArg(25), '25')
assert.equal(fpsArg(30), '30')
assert.equal(snapFrame(1.01, 30), 1)
assert.equal(snapFrame(1.02, 30), 31 / 30)
assert.equal(newId(tl, 'c'), 'c5')
assert.equal(newId(tl, 'v'), 'v3')
console.log('check-timeline: ok')
