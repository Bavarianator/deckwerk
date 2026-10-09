// Engine.video ohne Electron (Chunk-Planung, Naht ohne Doppelung, Entdopplung, covered, Sprecher, Chat): npx esbuild scripts/check-engine-video.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-engine-video.mjs && node ${TMPDIR:-/tmp}/check-engine-video.mjs
import { deepStrictEqual as eq, ok } from 'node:assert'
import type { Segment } from '../src/shared/video'
import { CHUNK, chatPerSecond, chunkWindow, chunksIn, coveredOf, engineFor, inChunk, loudRanges, mergeSegments, withSpeakers } from '../src/main/video-cache'

// Chunk-Planung: ganzes Video, Bereich mitten im Chunk, Bereich kurz nach einer Grenze (Segment davor ragt hinein), Ende geklemmt
eq(chunksIn([[0, 1000]], 1000), [0, 1, 2, 3])
eq(chunksIn([[650, 700]], 1000), [2])
eq(chunksIn([[610, 650]], 1000), [1, 2])
eq(chunksIn([[850, 5000]], 1000), [2, 3])
eq(chunksIn([[100, 200], [1000, 1100]], 4000), [0, 3])
eq(chunksIn([[0, 1000]], 0), [])
// Sprecher-Stücke à 30 min ohne Rückblick: nur die berührten
eq(chunksIn([[1790, 1850]], 7200, 1800, 0), [0, 1])
eq(chunksIn([[1810, 1850]], 7200, 1800, 0), [1])
eq(chunksIn([[0, 7200]], 5000, 1800, 0), [0, 1, 2])
const have = new Set([0, 2]), missing = chunksIn([[0, 1000]], 1000).filter((k) => !have.has(k))
eq(missing, [1, 3])

// Lesefenster: 2 s Vorlauf, 30 s Überhang, nie über das Video hinaus
eq(chunkWindow(0, 1000), { from: 0, dur: 330 })
eq(chunkWindow(1, 1000), { from: 298, dur: 332 })
eq(chunkWindow(3, 1000), { from: 898, dur: 102 })
eq(chunkWindow(0, 42), { from: 0, dur: 42 })

// Naht: Chunk 0 liest bis 330 s, Chunk 1 ab 298 s; beide erkennen die Segmente um 300 s gleich → jedes genau einmal, keine Lücke
const seg = (start: number, end: number): Segment => ({ start, end, text: `${start}` })
const seam = [seg(290, 296), seg(299.5, 306), seg(306.2, 318), seg(320, 329)]
const c0 = [seg(5, 10), ...seam], c1 = [...seam, seg(400, 410)]
const all = [...inChunk(c0, 0), ...inChunk(c1, 1)].map((s) => s.start)
eq(all, [5, 290, 299.5, 306.2, 320, 400])
eq(mergeSegments([...inChunk(c0, 0), ...inChunk(c1, 1)]).length, 6)

// Naht mit leicht verschobener VAD: Chunk 1 setzt dasselbe Gesagte 0,7 s später an (Start ≥ 300) → beide Chunks behalten es, mergeSegments nur einmal
const s0 = [seg(290, 296), seg(299.5, 306), seg(306.2, 318)], s1 = [seg(300.2, 306.1), seg(306.3, 318), seg(320, 329)]
const merged = mergeSegments([...inChunk(s0, 0), ...inChunk(s1, 1)])
eq(merged.map((s) => s.start), [290, 299.5, 306.3, 320]) // 306,2 gehört zu Chunk 1, dort erkannt als 306,3
// echte Nachbarn mit kleiner Überlappung bleiben beide
eq(mergeSegments([seg(10, 20), seg(19, 30)]).length, 2)
eq(inChunk([seg(300, 301)], 0), [])
eq(inChunk([seg(300, 301)], 1).length, 1)

// covered: Nachbarn verbunden, letzter Chunk an die Länge geklemmt
eq(coveredOf([0, 1, 3], 1000), [[0, 600], [900, 1000]])
eq(coveredOf([2], 650), [[600, 650]])
eq(coveredOf([], 650), [])

// Sprecher: größte Überlappung gewinnt, ohne Überlappung leer
const turns = [{ start: 0, end: 4, speaker: 0 }, { start: 4, end: 10, speaker: 1 }, { start: 10, end: 11, speaker: 0 }]
const sp = withSpeakers([seg(2, 7), seg(9.5, 11.5), seg(20, 21)], turns)
eq(sp.map((s) => s.speaker), [1, 0, undefined])
ok(!('speaker' in sp[2]))

// Chat je Sekunde: Summe der Gewichte, außerhalb verworfen
eq(chatPerSecond([{ t: 0.2, w: 1 }, { t: 0.9, w: 2 }, { t: 3.5, w: 1 }, { t: 9, w: 5 }, { t: -1, w: 1 }, null, { t: '2', w: 1 }, { t: 2 }], 5), [3, 0, 0, 1, 0])

// Laute Stellen ±5 s, verbunden
const loud = new Array(60).fill(-30)
loud[20] = loud[24] = -20
loud[50] = -10
eq(loudRanges(loud), [[15, 30], [45, 56]])
eq(loudRanges(new Array(10).fill(-100)), [])

// Erkennung nach Sprache: Parakeet-Sprache → Parakeet, fremde → Whisper, ohne Sprache jede; sherpa unbrauchbar → gecachtes Whisper passt
const pl = ['de', 'en']
eq([engineFor(undefined, pl, false), engineFor('de-DE', pl, false), engineFor('ja', pl, false)], [undefined, 'parakeet', 'whisper'])
eq([engineFor('de', pl, true), engineFor('ja', pl, true), engineFor(undefined, pl, true)], [undefined, 'whisper', undefined])

ok(CHUNK === 300)
console.log('engine-video ok')
