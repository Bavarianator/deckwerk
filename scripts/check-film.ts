// Zeitachse, Sprechertext und Zoom des Features „Animation“: npx esbuild scripts/check-film.ts --bundle --platform=node --format=esm --outfile=out/check-film.mjs && node out/check-film.mjs
import assert from 'node:assert/strict'
import { estimateVoice, GAP, HOLD, MIN_SCENE, PAUSE, sceneTimeline, TAIL, voiceChunks, voiceTiming, zoomAt } from '../src/shared/film'

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`)

// Sprechertext: Takte an [klick], Sätze an Satzzeichen, Abkürzungen trennen nicht
assert.deepEqual(voiceChunks('Hallo Welt. Wie geht es? [klick] Zweiter Takt, z. B. Kunden. Ende!'), [['Hallo Welt.', 'Wie geht es?'], ['Zweiter Takt, z. B. Kunden.', 'Ende!']])
assert.deepEqual(voiceChunks('[KLICK] Nur der zweite.'), [[], ['Nur der zweite.']])
assert.deepEqual(voiceChunks(''), [[]])
assert.deepEqual(voiceChunks('Version 2.5 ist da. 3 Gründe.'), [['Version 2.5 ist da.', '3 Gründe.']])
assert.deepEqual(voiceChunks('Er wurde am 3. Mai 1. Platz. Super!'), [['Er wurde am 3. Mai 1. Platz.', 'Super!']])
assert.deepEqual(voiceChunks('Er sagte „Hallo.“ Dann ging er.'), [['Er sagte „Hallo.“', 'Dann ging er.']])

// Stimme: Sätze mit Pausen, Takt 1 nach einer längeren Atempause, Wörter im Satz
const v = voiceTiming([['A b.', 'C.'], ['D e f.']], [[1, 0.5], [2]])
near(v.beats[0], 0)
near(v.beats[1], 1 + PAUSE.sentence + 0.5 + PAUSE.beat)
near(v.total, v.beats[1] + 2)
assert.equal(v.cues.length, 3)
assert.deepEqual(v.cues[0].words.map((w) => w.w), ['A', 'b.'])
near(v.cues[0].words.at(-1)!.end, 1)
const empty = voiceTiming([[], ['X.']], [[], [1]])
assert.deepEqual(empty.beats, [0, 0])
near(empty.total, 1)
assert.ok(estimateVoice('Ein Satz mit etwas Text. [klick] Noch einer.').beats[1] > 1)

// Szene ohne Stimme: Takte nach Ende des vorigen + GAP, Halten danach, Mindestdauer
const a = sceneTimeline({ steps: [0.5, 0.4], words: 0, lead: 0 })
assert.deepEqual(a.beats, [0, 0.5 + GAP])
near(a.hold, 0.5 + GAP + 0.4)
near(a.dur, Math.max(a.hold + HOLD, MIN_SCENE))
// Lesezeit: viele Wörter verlängern die Szene ohne Stimme
assert.ok(sceneTimeline({ steps: [0.5], words: 30, lead: 0 }).dur >= 11)
// Mit Stimme und Vorlauf: Takte an den Markern, Länge nach der Stimme, Stimme wird nie abgeschnitten
const b = sceneTimeline({ steps: [0.5, 0.5, 0.5], voice: { beats: [0, 3], total: 5, cues: [] }, duration: 2, words: 50, lead: 0.5 })
near(b.beats[0], 0.5)
near(b.beats[1], 3.5)
near(b.beats[2], 3.5 + 0.5 + GAP) // mehr Schritte als Marker: verkettet
near(b.dur, 0.5 + 5 + TAIL)
near(b.hold, b.beats[2] + 0.5)
// Mehr Marker als Schritte: zusätzliche Takte (für Kamera), endlose Animation hält nie
const c = sceneTimeline({ steps: [0.4], voice: { beats: [0, 1, 2], total: 3, cues: [] }, words: 0, lead: 0, endless: true })
assert.deepEqual(c.beats, [0, 1, 2])
near(c.hold, c.dur)
// Vorlauf ohne Stimme verschiebt alle Takte; [klick] am Textanfang: Takt 1 zur selben Zeit wie Takt 0
assert.deepEqual(sceneTimeline({ steps: [0.5, 0.5], words: 0, lead: 0.5 }).beats, [0.5, 0.5 + 0.5 + GAP])
const lead0 = estimateVoice('[klick] Erst jetzt.')
assert.deepEqual(sceneTimeline({ steps: [0, 0.5], voice: lead0, words: 0, lead: 0 }).beats, [0, 0])
// Wunschlänge gilt, wenn sie länger ist
near(sceneTimeline({ steps: [0.5], words: 0, lead: 0, duration: 9 }).dur, 9)

// Zoom: vorher ganz, im Zeitraum voll, Zielpunkt geklemmt, Ein-/Ausfahren weich
assert.deepEqual(zoomAt([], 3), { s: 1, x: 0.5, y: 0.5 })
const z = [{ start: 2, end: 4, x: 0.9, y: 0.5, scale: 2 }]
assert.deepEqual(zoomAt(z, 0), { s: 1, x: 0.5, y: 0.5 })
const full = zoomAt(z, 3)
near(full.s, 2)
near(full.x, 0.7) // Zielpunkt 0,9 bleibt stehen: Ausschnitt 0,45–0,95
near(full.y, 0.5)
near(zoomAt(z, 1.7).s, 1.5) // halb eingefahren: smooth(0,5) = 0,5
near(zoomAt(z, 2).s, 2) // Kanten zählen voll
near(zoomAt(z, 4).s, 2)
near(zoomAt([{ start: 0, end: 9, x: 0.05, y: 0.95, scale: 2 }], 1).x, 0.275) // Zielpunkt am Rand: Ausschnitt beginnt bei 0,025, bleibt im Bild
near(zoomAt([{ start: 0, end: 9, x: 0.05, y: 0.95, scale: 2 }], 1).y, 0.725)
// Zwei Zooms dicht hintereinander: kein Sprung, die Kamera fährt direkt hinüber
const pair = [{ start: 1, end: 4, x: 0.1, y: 0.5, scale: 3 }, { start: 4.3, end: 6, x: 0.9, y: 0.5, scale: 3 }]
let last = zoomAt(pair, 3.9)
for (let t = 3.91; t <= 4.4; t += 0.01) { const v = zoomAt(pair, t); assert.ok(Math.abs(v.x - last.x) < 0.05 && v.s > 2.9, `Sprung bei ${t}`); last = v }
near(zoomAt(pair, 5).x, 0.9 + (0.5 - 0.9) / 3)
// überlappend: der zuletzt begonnene gilt
near(zoomAt([{ start: 0, end: 5, x: 0.2, y: 0.5 }, { start: 2, end: 3, x: 0.8, y: 0.5 }], 2.5).x, 0.8 + (0.5 - 0.8) / 2)
near(zoomAt(z, 4.6).s, 1)
// Zielpunkt bleibt stehen: bei x = 0,6 und s = 2 liegt 0,6 im Ausschnitt an derselben relativen Stelle
const fix = zoomAt([{ start: 0, end: 9, x: 0.6, y: 0.4 }], 1)
near((0.6 - (fix.x - 0.5 / fix.s)) * fix.s, 0.6)
near((0.4 - (fix.y - 0.5 / fix.s)) * fix.s, 0.4)

console.log('check-film: ok')
