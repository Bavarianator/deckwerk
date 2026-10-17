// Pro-Video-Werkzeuge (Parser, Clip anhängen): npx esbuild scripts/check-video-tools.ts --bundle --platform=node --format=esm --loader:.css=empty --outfile=${TMPDIR:-/tmp}/check-video-tools.mjs && node ${TMPDIR:-/tmp}/check-video-tools.mjs
import assert from 'node:assert/strict'
import { appendClip, parseHits, parseVideo, runningPct } from '../src/renderer/ui/VideoTools'
import type { TimelineContent } from '../src/shared/timeline'

// Format wie search_transcript in tools.ts
const search = '2 Stellen zu „Preis“ in asset://local/home/a/v.mp4:\n1:01–1:06 · „Der Preis liegt bei 9 Euro.“ · from=61.2 to=66.8\n10:00–10:04 · „Preis, ja“ · from=600.0 to=604.1'
assert.deepEqual(parseHits(search), [
  { from: 61.2, to: 66.8, line: '1:01–1:06 · „Der Preis liegt bei 9 Euro.“' },
  { from: 600, to: 604.1, line: '10:00–10:04 · „Preis, ja“' },
])
// video_highlights: ganzzahlige Zeiten; „weiter mit from=…“ aus transcribe_video ist kein Treffer
assert.deepEqual(parseHits('1. 0:12–1:42 · Score 3,1 · Chat · from=12 to=102\n… weiter mit from=40.5 und to=90'), [{ from: 12, to: 102, line: '1. 0:12–1:42 · Score 3,1 · Chat' }])
assert.equal(parseVideo('Video: asset://local/home/a/b%20c.mp4\nTitel: X'), 'asset://local/home/a/b%20c.mp4')
assert.equal(parseVideo('Video: asset://local/x.mp4 · 1:00 · 1920×1080'), 'asset://local/x.mp4')
assert.equal(parseVideo('Keine Stelle'), null)
assert.equal(runningPct('Transkription läuft noch (37 %). Rufe dasselbe Tool gleich noch einmal …'), 37)
assert.equal(runningPct('Video: asset://local/x.mp4'), null)

const tl: TimelineContent = { tracks: [
  { id: 'v1', kind: 'video', clips: [{ id: 'c1', src: 'a.mp4', at: 0, in: 0, out: 10.01 }] },
  { id: 'v2', kind: 'video', clips: [] },
] }
const a = appendClip(tl, 'video', false, { src: 'a.mp4', in: 20, out: 25 }, 30)
assert.equal(a.tracks[0].clips[1].at, 301 / 30) // nach dem Vorgänger aufs nächste Bild gerundet, keine Überlappung
const b = appendClip(tl, 'video', true, { src: 'logo.png', in: 0, out: 5 }, 30)
assert.equal(b.tracks[1].clips[0].at, 0)
const c = appendClip(tl, 'audio', true, { src: 'm.mp3', in: 0, out: 30 }, 30)
assert.equal(c.tracks.length, 3)
assert.equal(c.tracks[2].kind, 'audio')
assert.equal(c.tracks[2].clips[0].src, 'm.mp3')
console.log('check-video-tools: ok')
