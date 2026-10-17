// Pro-Timeline Wiedergabeplan: npx esbuild scripts/check-timeline-player.ts --bundle --platform=node --format=esm --loader:.css=empty --outfile=${TMPDIR:-/tmp}/check-timeline-player.mjs && node ${TMPDIR:-/tmp}/check-timeline-player.mjs
import assert from 'node:assert/strict'
import type { TimelineContent } from '../src/shared/timeline'
import { plan } from '../src/renderer/ui/timeline/useTimelinePlayer'

const tl: TimelineContent = {
  tracks: [
    { id: 'v1', kind: 'video', clips: [{ id: 'c1', src: 'a.mp4', at: 0, in: 10, out: 14 }, { id: 'c2', src: 'b.mp4', at: 5, in: 0, out: 4, speed: 2 }] },
    { id: 'v2', kind: 'video', clips: [{ id: 'c3', src: 'c.mp4', at: 1, in: 0, out: 2 }] },
    { id: 'a1', kind: 'audio', clips: [{ id: 'c4', src: 'm.mp3', at: 0, in: 0, out: 9 }] },
    { id: 'a2', kind: 'audio', mute: true, clips: [{ id: 'c5', src: 'n.mp3', at: 0, in: 0, out: 9 }] },
  ],
}
assert.deepEqual(plan(tl, 1.5), [{ track: 0, clip: 'c1', src: 11.5 }, { track: 1, clip: 'c3', src: 0.5 }, { track: 2, clip: 'c4', src: 1.5 }])
assert.deepEqual(plan(tl, 4.5), [{ track: 2, clip: 'c4', src: 4.5 }], 'Lücke auf V1: nur Ton')
assert.deepEqual(plan(tl, 6), [{ track: 0, clip: 'c2', src: 2 }, { track: 2, clip: 'c4', src: 6 }], 'Tempo 2: Quellsekunde läuft doppelt')
assert.deepEqual(plan(tl, 9), [], 'Ende exklusiv')
assert.deepEqual(plan({ tracks: [{ ...tl.tracks[1], hide: true }] }, 1.5), [], 'ausgeblendete Spur fällt weg')
assert.deepEqual(plan({ tracks: [{ id: 'v1', kind: 'video', clips: [{ id: 'i1', src: '/x/logo.PNG', at: 0, in: 0, out: 3 }] }] }, 1), [], 'Bild-Clip spielt der Viewer als <img>')
console.log('check-timeline-player: ok')
