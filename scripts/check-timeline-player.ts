// Pro-Timeline Wiedergabeplan: npx esbuild scripts/check-timeline-player.ts --bundle --platform=node --format=esm --loader:.css=empty --outfile=${TMPDIR:-/tmp}/check-timeline-player.mjs && node ${TMPDIR:-/tmp}/check-timeline-player.mjs
import assert from 'node:assert/strict'
import { xfades, type TimelineContent } from '../src/shared/timeline'
import { fadeRamps, plan } from '../src/renderer/ui/timeline/useTimelinePlayer'

const tl: TimelineContent = {
  tracks: [
    { id: 'v1', kind: 'video', clips: [{ id: 'c1', src: 'a.mp4', at: 0, in: 10, out: 14 }, { id: 'c2', src: 'b.mp4', at: 5, in: 0, out: 4, speed: 2 }] },
    { id: 'v2', kind: 'video', clips: [{ id: 'c3', src: 'c.mp4', at: 1, in: 0, out: 2 }] },
    { id: 'a1', kind: 'audio', clips: [{ id: 'c4', src: 'm.mp3', at: 0, in: 0, out: 9 }] },
    { id: 'a2', kind: 'audio', mute: true, clips: [{ id: 'c5', src: 'n.mp3', at: 0, in: 0, out: 9 }] },
  ],
}
assert.deepEqual(plan(tl, 1.5), [{ track: 0, clip: 'c1', src: 11.5, alpha: 1, gain: 1 }, { track: 1, clip: 'c3', src: 0.5, alpha: 1, gain: 1 }, { track: 2, clip: 'c4', src: 1.5, alpha: 1, gain: 1 }])
assert.deepEqual(plan(tl, 4.5), [{ track: 2, clip: 'c4', src: 4.5, alpha: 1, gain: 1 }], 'Lücke auf V1: nur Ton')
assert.deepEqual(plan(tl, 6), [{ track: 0, clip: 'c2', src: 2, alpha: 1, gain: 1 }, { track: 2, clip: 'c4', src: 6, alpha: 1, gain: 1 }], 'Tempo 2: Quellsekunde läuft doppelt')
assert.deepEqual(plan(tl, 9), [], 'Ende exklusiv')
assert.deepEqual(plan({ tracks: [{ ...tl.tracks[1], hide: true }] }, 1.5), [], 'ausgeblendete Spur fällt weg')
assert.deepEqual(plan({ tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'i1', src: '/x/logo.PNG', at: 0, in: 0, out: 3 }] }] }, 1), [], 'Bild-Clip spielt der Viewer als <img>')

// Blenden: Fade-in 2 s, bei 1 s halb; Überblendung 2 s um den Schnitt bei 4 (Fenster 3..5)
const xf: TimelineContent = { tracks: [{ id: 'v1', kind: 'video', clips: [
  { id: 'f', src: 'a.mp4', at: 0, in: 0, out: 4, fade: [2, 0] },
  { id: 't', src: 'b.mp4', at: 4, in: 0.5, out: 8, xfade: 2 },
] }] }
assert.deepEqual(plan(xf, 1), [{ track: 0, clip: 'f', src: 1, alpha: 0.5, gain: 0.5 }], 'Fade-in bei halber Zeit')
const w = plan(xf, 3.5) // k = 0,25
assert.deepEqual(w.map((x) => x.clip), ['f', 't'], 'im Fenster from und darüber to')
assert.deepEqual([w[0].alpha, w[0].gain], [1, 0.75], 'from deckend, Ton 1−k')
assert.deepEqual([w[1].alpha, w[1].gain], [0.25, 0.25], 'to mit k')
assert.equal(w[1].src, 0, 'to vor in, auf 0 geklemmt')
assert.equal(plan(xf, 4.5)[0].src, 4.5, 'from läuft über out hinaus')
assert.deepEqual(plan(xf, 5).map((x) => x.clip), ['t'], 'nach dem Fenster nur to')
const r = fadeRamps(xf.tracks[0].clips[0], xfades(xf.tracks[0]), 3)
assert.equal(r[0].gain, 1); assert.equal(r[r.length - 1].gain, 0, 'from-Ton endet am Fensterende bei 0')
assert.deepEqual(fadeRamps(tl.tracks[0].clips[0], [], 0), [], 'ohne Blenden keine Rampen')
console.log('check-timeline-player: ok')
