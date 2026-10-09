// Video-Schnitt unter Node (ffmpeg, Zuschnitt, Untertitel, Clip-Szene): npx esbuild scripts/check-video.ts --bundle --platform=node --format=esm --external:./render --external:./export-pptx --external:electron --outfile=${TMPDIR:-/tmp}/check-video.mjs && DECKWERK_HOME=${TMPDIR:-/tmp}/check-video-home node ${TMPDIR:-/tmp}/check-video.mjs
// Die externen Pfade sind die Electron-Teile, die export-video.ts erst in exportVideo lädt. Ohne ffmpeg im PATH wird ffmpeg-static geladen (~30 MB).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assSubs, encodeClip, padParts, seamless } from '../src/main/export-video'
import { ffmpegBin, frames, loudness, pcm16k, probe, rawFrames, runFfmpeg, silences } from '../src/main/ffmpeg'
import { MIN_PAUSE, PAD, clipWords, cropRect, cues, estimateWords, partsLength, tighten, type Transcript } from '../src/shared/video'

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} statt ${b} ± ${tol}`)
// Kleinster Pegel (RMS in 10-ms-Fenstern, 16 kHz) in ±50 ms um t, relativ zum Pegel bei ref: zeigt Fades an Schnitten
function dip(pcm: Float32Array, t: number, ref: number) {
  const rms = (s: number) => Math.sqrt(pcm.subarray(s, s + 160).reduce((q, x) => q + x * x, 0) / 160)
  let min = Infinity
  for (let s = Math.round((t - 0.05) * 16000); s < (t + 0.05) * 16000; s += 40) min = Math.min(min, rms(s))
  return min / rms(Math.round(ref * 16000))
}

async function main() {
  const base = process.env.TMPDIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'check-video-'))
  try {
    console.log('ffmpeg:', await ffmpegBin())

    // Testvideo: 12 s, 1280×720, Sinuston; dazu eine gedrehte Kopie (Handy hochkant)
    const src = join(dir, 'quelle.mp4'), rot = join(dir, 'gedreht.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src])
    const info = await probe(src)
    near(info.duration, 12, 0.1, 'Dauer')
    assert.deepEqual([info.w, info.h, info.audio], [1280, 720, true])
    await runFfmpeg(['-display_rotation', '90', '-i', src, '-c', 'copy', rot]).then(
      async () => { const r = await probe(rot); assert.deepEqual([r.w, r.h], [720, 1280], 'Drehung tauscht w und h') },
      () => console.log('  (Drehung übersprungen: ffmpeg kennt -display_rotation nicht)'),
    )
    await assert.rejects(probe(join(dir, 'fehlt.mp4')), /nicht lesbar/)

    // Standbilder und Ton für Whisper
    const jpgs = await frames(src, [1, 5])
    assert.equal(jpgs.length, 2)
    for (const j of jpgs) assert.ok(j[0] === 0xff && j[1] === 0xd8, 'JPEG-Marker FFD8')
    const jpgWidth = (j: Buffer) => j.readUInt16BE(j.indexOf(Buffer.from([0xff, 0xc0])) + 7) // SOF0: Höhe, dann Breite
    assert.equal(jpgWidth(jpgs[0]), 640)
    assert.equal(jpgWidth((await frames(src, [1], 1280))[0]), 1280)
    near((await pcm16k(src)).length, 12 * 16000, 1600, 'PCM-Länge')
    near((await pcm16k(src, 1, 1)).length, 16000, 160, 'PCM-Bereich (ss/t, vorab angelegter Puffer)')

    // rohe BGR-Bilder für den Gesichtsdetektor: 1280×720 → 640×360 oben links, darunter schwarz
    const [raw] = await rawFrames(src, [2], 640)
    assert.equal(raw.length, 640 * 640 * 3)
    assert.ok(raw.subarray(0, 640 * 360 * 3).some((b) => b > 40), 'Bild oben vorhanden')
    assert.ok(raw.subarray(640 * 360 * 3).every((b) => b <= 1), 'untere Zeilen ab y=360 schwarz')
    assert.equal((await rawFrames(src, [1, 3], 320)).length, 2)

    // Pegel je Sekunde: Sinus (Standardamplitude 0,125) ≈ −21 dBFS, Stille −100, ohne Ton −100 in Videolänge
    const lvl = (n: string, a: string[], d: number) => runFfmpeg(['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=10:duration=${d}`, ...a, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', ...(a.length ? ['-c:a', 'aac'] : []), join(dir, n)]).then(() => join(dir, n))
    const lauter = await loudness(await lvl('sinus.mp4', ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3'], 3))
    assert.equal(lauter.length, 3, JSON.stringify(lauter)); lauter.forEach((v, i) => near(v, -21, 1, `Sinus-Pegel ${i}`))
    let pct = -1
    const leise = await loudness(await lvl('leise.mp4', ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=2'], 2), (p) => { assert.ok(p > pct && p <= 100); pct = p })
    assert.deepEqual(leise, [-100, -100]); assert.ok(pct >= 0, 'Fortschritt gemeldet')
    const ohne = await loudness(await lvl('ohne-ton.mp4', [], 3))
    assert.deepEqual(ohne, [-100, -100, -100])

    // video.ts: Zuschnitt 16:9 → 9:16
    const out = { w: 1080, h: 1920 }
    assert.deepEqual(cropRect(info, out, 0), { x: 0, y: 0, w: 406, h: 720 })
    assert.deepEqual(cropRect(info, out, 0.5), { x: 437, y: 0, w: 406, h: 720 })
    assert.deepEqual(cropRect(info, out, 1), { x: 874, y: 0, w: 406, h: 720 })

    // Wörter auf der Clip-Zeitachse (geschätzt aus dem Text), Häppchen
    const tr: Transcript = { duration: 12, lang: 'de', segments: [{ start: 1, end: 4, text: 'eins zwei drei' }, { start: 6, end: 8, text: 'vier fünf' }] }
    const parts = [{ start: 1, end: 4 }, { start: 6, end: 8 }]
    const words = clipWords(tr, parts)
    assert.deepEqual(words.map((w) => [w.w, +w.start.toFixed(2), +w.end.toFixed(2)]), [['eins', 0, 1], ['zwei', 1, 2], ['drei', 2, 3], ['vier', 3, 4], ['fünf', 4, 5]])
    assert.deepEqual(cues(words, 'wort').map((c) => c.words.length), [3, 2])
    assert.deepEqual(cues(words, 'satz').map((c) => c.words.length), [5])

    // Puffer an den Schnitten: angrenzende parts überlappen nicht, Videoende begrenzt
    assert.deepEqual(padParts([{ start: 1, end: 4 }, { start: 4, end: 6 }], 12).map((p) => [p.start, p.end]), [[1 - PAD, 4], [4, 6 + PAD]])
    assert.deepEqual(padParts([{ start: 10, end: 12 }], 12).map((p) => [p.start, p.end]), [[10 - PAD, 12]])
    // kleine Lücke (0,3 s < 2·PAD): beide Puffer treffen sich in der Mitte, der Schnitt läuft nahtlos weiter, dort kein Fade
    const gap = padParts([{ start: 2, end: 5 }, { start: 5.3, end: 8 }], 12)
    near(gap[0].end, 5.15, 1e-9, 'Lücke Ende'); near(gap[1].start, 5.15, 1e-9, 'Lücke Anfang')
    assert.deepEqual(seamless(gap), [false, true])
    assert.deepEqual(seamless(padParts(parts, 12)), [false, false])

    // Pausen kürzen: part an der Stille geteilt (focus bleibt), reine Stille bleibt; nach padParts bleiben 2·PAD Pause, nichts doppelt sich
    const quiet: [number, number][] = [[3, 4.5], [9.5, 11]]
    assert.deepEqual(tighten([{ start: 1, end: 10, focus: 0.3 }], quiet), [{ start: 1, end: 3, focus: 0.3 }, { start: 4.5, end: 9.5, focus: 0.3 }])
    assert.deepEqual(tighten([{ start: 3.2, end: 4.4 }], quiet), [{ start: 3.2, end: 4.4 }])
    assert.deepEqual(tighten([{ start: 1, end: 10 }], [[9.5, 11], [3, 4.5]]), tighten([{ start: 1, end: 10 }], quiet), 'Reihenfolge der Stillen egal')
    const kurz = padParts(tighten([{ start: 1, end: 10 }], quiet), 12)
    assert.ok(kurz[0].end <= kurz[1].start, 'gepolsterte Teile überlappen nicht')
    near(kurz[1].start - kurz[0].end, 1.5 - 2 * PAD, 1e-9, 'gekürzte Pause')
    near(partsLength(kurz), 2 + 5 + 4 * PAD, 1e-9, 'Länge gekürzt')
    // Wortzeiten überspringen die Stille, kein Wort fällt mit der Pause weg
    const seg = { start: 1, end: 6, text: 'eins zwei drei vier' }
    for (const w of estimateWords(seg, [[2.5, 4.5]])) assert.ok((w.start + w.end) / 2 < 2.5 || (w.start + w.end) / 2 > 4.5, `${w.w} mitten in der Pause`)
    assert.equal(clipWords({ duration: 12, lang: 'de', segments: [seg] }, padParts(tighten([{ start: 1, end: 6 }], [[2.5, 4.5]]), 12), [[2.5, 4.5]]).length, 4)

    // ASS: Hook, ein Dialogue je Wortzustand, Escaping, Farbe &HBBGGRR&
    const ass = assSubs({ size: out, font: 'Archivo', bold: true, accent: '#FF8800', hook: 'Warum {das} \\N klappt', hookDur: 4, cues: cues(words, 'wort'), mode: 'wort' })
    assert.ok(ass.includes('Dialogue: 0,0:00:00.00,0:00:04.00,Hook,,0,0,0,,Warum \\{das\\} ＼N klappt'), ass)
    assert.equal(ass.match(/^Dialogue: .*,Cap,/gm)?.length, 5)
    assert.ok(ass.includes('{\\c&H0088FF&}zwei{\\r}'), 'aktuelles Wort in Akzentfarbe')
    assert.ok(/^Style: Hook,Archivo,\d+,&H00FFFFFF/m.test(ass))
    const satz = assSubs({ size: out, font: 'Archivo', bold: true, accent: '#0B5563', hookDur: 4, cues: cues(words, 'satz'), mode: 'satz' })
    assert.equal(satz.match(/^Dialogue:/gm)?.length, 1, 'ohne Hook nur der Satz')

    // Clip-Szene: 2 parts, Fake-Transkript, 9:16
    const clip = join(dir, 'clip.mp4')
    const font = { name: 'Archivo', files: [readFileSync(resolve('assets/fonts/Archivo-Bold.ttf'))], bold: true }
    let last = -1
    const dur = await encodeClip({ file: src, parts, hook: 'Zwei Ausschnitte, ein Clip', captions: 'wort', transcript: tr, size: out, font, accent: '#FF8800', loudnorm: true }, clip, dir, (p) => { assert.ok(p >= 0 && p <= 100); last = p })
    const c = await probe(clip)
    near(c.duration, partsLength(padParts(parts, 12)), 0.4, 'Clip-Länge')
    near(dur, 5 + 4 * PAD, 0.01, 'gemeldete Länge')
    assert.deepEqual([c.w, c.h, c.audio], [1080, 1920, true])
    assert.ok(last >= 90, `Fortschritt endet bei ${last}`)
    assert.ok(existsSync(join(dir, 'fonts', 'font-0.ttf')), 'Schrift im Unterordner fonts (libass lädt alles in fontsdir)')
    const faded = dip(await pcm16k(clip), 3.3, 1.5)
    assert.ok(faded < 0.5, `Fade am Schnitt mit Lücke fehlt (Pegel ${faded.toFixed(2)})`)

    // Nahtloser Schnitt: kein Pegelloch mitten im Satz
    const nahtlos = join(dir, 'nahtlos.mp4')
    near(await encodeClip({ file: src, parts: [{ start: 2, end: 5 }, { start: 5.3, end: 8 }], captions: 'aus', transcript: null, size: out, font, accent: '#FF8800' }, nahtlos, dir), 6.3, 0.01, 'Länge nahtlos')
    const smooth = dip(await pcm16k(nahtlos), 3.3, 1.5)
    assert.ok(smooth > 0.8, `Pegelsenke am nahtlosen Schnitt (Pegel ${smooth.toFixed(2)})`)
    await assert.rejects(encodeClip({ file: src, parts: [], captions: 'aus', transcript: null, size: out, font, accent: '#FF8800' }, nahtlos, dir), /keine Ausschnitte/)
    await assert.rejects(encodeClip({ file: src, parts: [{ start: 3, end: 3 }], captions: 'aus', transcript: null, size: out, font, accent: '#FF8800' }, nahtlos, dir), /Ausschnitt 1 endet nicht/)
    if (process.env.KEEP) await runFfmpeg(['-ss', '0.5', '-i', clip, '-frames:v', '1', resolve(process.env.KEEP)]) // Sichtprüfung: KEEP=bild.png

    // Pausen kürzen am echten Ton: 2 s Stille bei 4–6 s, part 1–10 → 9 s − 2 s + 2·PAD Restpause + 2·PAD Rand
    const pause = join(dir, 'pause.mp4'), pauseClip = join(dir, 'pause-clip.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,4,6),0,0.5*sin(2*PI*440*t))':s=48000:d=12", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', pause])
    const still = await silences(pause, 1, 10, MIN_PAUSE)
    assert.equal(still.length, 1, JSON.stringify(still)); near(still[0][0], 4, 0.05, 'Stille Anfang'); near(still[0][1], 6, 0.05, 'Stille Ende')
    const tr2: Transcript = { duration: 12, lang: 'de', segments: [{ start: 1, end: 10, text: 'eins zwei drei vier fünf sechs' }] }
    near(await encodeClip({ file: pause, parts: [{ start: 1, end: 10 }], captions: 'wort', transcript: tr2, size: out, font, accent: '#FF8800', pauses: 'kurz' }, pauseClip, dir), 7 + 4 * PAD, 0.06, 'Länge mit kurzen Pausen')
    near((await probe(pauseClip)).duration, 7 + 4 * PAD, 0.4, 'Clip-Länge mit kurzen Pausen')
    assert.deepEqual(await silences(pauseClip, 0, 7 + 4 * PAD, 0.5), [], 'keine lange Pause mehr im Clip')
    near(await encodeClip({ file: pause, parts: [{ start: 1, end: 10 }], captions: 'aus', transcript: null, size: out, font, accent: '#FF8800', pauses: 'lassen' }, pauseClip, dir), 9 + 2 * PAD, 0.01, 'lassen kürzt nichts')

    // ohne Ton und ohne Untertitel: anullsrc, kein ass-Filter
    const stumm = join(dir, 'stumm.mp4'), stummClip = join(dir, 'stumm-clip.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', stumm])
    assert.equal((await probe(stumm)).audio, false)
    await encodeClip({ file: stumm, parts: [{ start: 0.5, end: 2 }], captions: 'aus', transcript: null, size: { w: 1080, h: 1080 }, font, accent: '#FF8800', pauses: 'kurz' }, stummClip, dir) // ohne Ton: kurz misst nichts
    const s = await probe(stummClip)
    assert.deepEqual([s.w, s.h, s.audio], [1080, 1080, true])
    await assert.rejects(encodeClip({ file: stumm, parts: [{ start: 5, end: 6 }], captions: 'aus', transcript: null, size: out, font, accent: '#000000' }, stummClip, dir), /nur 4\.0 s lang/)

    console.log('check-video: alles grün')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
