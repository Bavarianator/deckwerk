// Clip-Folien → Timeline und Timeline-Schema: npx esbuild scripts/check-timeline-convert.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-timeline-convert.mjs && node ${TMPDIR:-/tmp}/check-timeline-convert.mjs
import assert from 'node:assert/strict'
import { fromClips } from '../src/shared/timeline-from-clips'
import { timelineSchema } from '../src/shared/layouts-timeline'
import { tlDuration } from '../src/shared/timeline'
import { freezeOf, partLen, type ClipContent } from '../src/shared/video'
import { GRADE_PRESETS } from '../src/shared/grade'

const a: ClipContent = {
  video: 'asset://a.mp4', look: 'warm', captions: 'satz',
  parts: [{ start: 0, end: 10, speed: 2 }, { start: 30, end: 40 }, { start: 15, end: 25, freeze: 1 }],
  overlays: [
    { start: 8, end: 17, text: 'Lücke' }, // Teil 1 (8–10) und Teil 3 (15–17), dazwischen Teil 2 → zwei Stücke
    { start: 8, end: 32, text: 'durchgehend', pos: 'oben' }, // Teil 1 und 2 stoßen aneinander → ein Stück, dazu Teil 3 ganz (samt Standbild-Bereich, der wegfällt)
    { start: 1, end: 5, image: 'asset://logo.png' },
  ],
}
const b: ClipContent = { video: 'asset://b.mp4', fit: 'blur', parts: [{ start: 5, end: 9, volume: 0.5, focus: 0.3 }], overlays: [{ start: 6, end: 8, art: 'bauchbinde', text: 'Name', sub: 'Rolle' }] }

const { tl, dropped } = fromClips([{ content: a }, { content: b }])
timelineSchema.parse(tl)
const clips = tl.tracks[0].clips
assert.equal(tl.tracks[0].id, 'v1')
assert.deepEqual(clips.map((c) => c.id), ['c1', 'c2', 'c3', 'c4'])
assert.deepEqual(clips.map((c) => c.at), [0, 5, 15, 25])
const sum = [...a.parts, ...b.parts].reduce((s, p) => s + partLen(p) - freezeOf(p), 0)
assert.ok(Math.abs(tlDuration(tl) - sum) < 1e-6 && sum === 29)
assert.equal(clips[0].speed, 2)
assert.deepEqual(clips[0].grade, GRADE_PRESETS.warm)
assert.equal(clips[3].fit, 'contain')
assert.equal(clips[3].volume, 0.5)
assert.equal(clips[3].grade, undefined)
assert.equal(tl.captions, 'satz')
assert.deepEqual(tl.overlays!.map((o) => [o.text, o.start, o.end]), [['Lücke', 4, 5], ['Lücke', 15, 17], ['durchgehend', 4, 7], ['durchgehend', 15, 25], ['Name', 26, 28]])
assert.equal(tl.overlays![4].sub, 'Rolle')
assert.ok(dropped.some((d) => d.includes('freeze')))
assert.ok(dropped.some((d) => d.includes('Bild-')))
assert.equal(new Set(dropped).size, dropped.length)

// Schema: Überlappung, doppelte IDs, out ≤ in
const over = structuredClone(tl); over.tracks[0].clips[1].at = 4
assert.throws(() => timelineSchema.parse(over), /c1 überlappt c2/)
const dup = structuredClone(tl); dup.tracks.push({ id: 'v2', kind: 'video', clips: [{ ...clips[0], at: 0 }] })
assert.throws(() => timelineSchema.parse(dup), /Clip-ID c1 doppelt/)
const rev = structuredClone(tl); rev.tracks[0].clips[0].out = 0
assert.throws(() => timelineSchema.parse(rev), /out muss nach in/)
timelineSchema.parse({ ...tl, deliver: { res: 2160, fps: 29.97, codec: 'prores', lufs: -16 } })
assert.throws(() => timelineSchema.parse({ ...tl, deliver: { res: 1000, fps: 30, codec: 'h264', lufs: -14 } }))

console.log('check-timeline-convert: ok', `(Schema-JSON ${JSON.stringify(z.toJSONSchema(timelineSchema, { unrepresentable: 'any' })).length} Zeichen)`)
import { z } from 'zod'
