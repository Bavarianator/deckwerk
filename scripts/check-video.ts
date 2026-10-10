// Video-Schnitt unter Node (ffmpeg, Zuschnitt, Untertitel, Clip-Szene): npx esbuild scripts/check-video.ts --bundle --platform=node --format=esm --external:./render --external:./export-pptx --external:electron --outfile=${TMPDIR:-/tmp}/check-video.mjs && DECKWERK_HOME=${TMPDIR:-/tmp}/check-video-home node ${TMPDIR:-/tmp}/check-video.mjs
// Die externen Pfade sind die Electron-Teile, die export-video.ts erst in exportVideo lädt. Ohne ffmpeg im PATH wird ffmpeg-static geladen (~30 MB).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assSubs, clipSegs, encodeClip, encodeCover, encodeStill, exportVideo, finish, padParts, seamless, snapParts } from '../src/main/export-video'
import { cropFilter, zoomCrop } from '../src/main/video-fx'
import type { Deck } from '../src/shared/deck'
import { contactSheet, ffmpegBin, frames, loudness, pcm16k, probe, rawFrames, run, runFfmpeg, scenes, silences } from '../src/main/ffmpeg'
import { MIN_PAUSE, PAD, STILL, clipWords, cropRect, cues, estimateWords, followParts, outSize, partsLength, snapToScenes, tighten, zoomOf, cutIndex, type Transcript } from '../src/shared/video'

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} statt ${b} ± ${tol}`)
// Kleinster Pegel (RMS in 10-ms-Fenstern, 16 kHz) in ±50 ms um t, relativ zum Pegel bei ref: zeigt Fades an Schnitten
function dip(pcm: Float32Array, t: number, ref: number) {
  const rms = (s: number) => Math.sqrt(pcm.subarray(s, s + 160).reduce((q, x) => q + x * x, 0) / 160)
  let min = Infinity
  for (let s = Math.round((t - 0.05) * 16000); s < (t + 0.05) * 16000; s += 40) min = Math.min(min, rms(s))
  return min / rms(Math.round(ref * 16000))
}
// Mittlere Helligkeit (0–255) eines Ausschnitts aus rawFrames (BGR, side×side)
function luma(raw: Buffer, side: number, x0: number, y0: number, x1: number, y1: number) {
  let sum = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += raw[(y * side + x) * 3] + raw[(y * side + x) * 3 + 1] + raw[(y * side + x) * 3 + 2]
  return sum / 3 / ((x1 - x0) * (y1 - y0))
}
// RMS-Pegel in dB zwischen a und b (s) eines 16-kHz-PCM
const dbOf = (pcm: Float32Array, a: number, b: number) => { const x = pcm.subarray(a * 16000, b * 16000); return 10 * Math.log10(x.reduce((q, v) => q + v * v, 0) / x.length) }

async function main() {
  const base = process.env.TMPDIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'check-video-'))
  try {
    console.log('ffmpeg:', await ffmpegBin())

    // Titelbild: Standbild in Ausgabegröße, Hook eingebrannt (ruhig und lebendig, ohne Einblendung), ohne Hook kein Text; Zeit außerhalb des Videos wird begrenzt
    {
      const grau = join(dir, 'cover-src.mp4'), size = { w: 360, h: 640 } // kleiner scheitert boxblur (Chroma-Radius)
      await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=gray:size=1280x720:rate=30:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', grau])
      const job = { file: grau, parts: [{ start: 0.2, end: 1.8, focus: 0.3 }], captions: 'aus' as const, transcript: null, size, font: { name: 'Archivo', files: [readFileSync(resolve('assets/fonts/Archivo-Bold.ttf'))], bold: true }, accent: '#FF8800' }
      // Grauwerte der oberen 40 % (Hook sitzt oben links): Spannweite
      const spread = async (f: string) => {
        const { out } = await run(await ffmpegBin(), ['-i', f, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])
        assert.equal(out.length, size.w * size.h, 'Ausgabegröße')
        const top = out.subarray(0, size.w * Math.round(size.h * 0.4))
        return Math.max(...top) - Math.min(...top)
      }
      for (const [n, x, t] of [['ohne', {}, 99], ['ruhig', { hook: 'Hook hier' }, 1], ['lebendig', { hook: 'Hook hier', style: 'lebendig' as const }, undefined], ['blur', { hook: 'Hook', fit: 'blur' as const }, 0.5]] as const) {
        const jpg = join(dir, `cover-${n}.jpg`)
        await encodeCover({ ...job, ...x }, t, jpg, dir)
        const sp = await spread(jpg) // prüft auch die Größe (probe verlangt eine Dauer, ein JPEG hat keine)
        if (n === 'ohne') assert.ok(sp < 12, `ohne Hook Text im Bild (Spannweite ${sp})`)
        else if (n !== 'blur') assert.ok(sp > 100, `${n}: Hook fehlt (Spannweite ${sp})`)
      }
      console.log('  Titelbild ok')
    }
    if (process.env.DW_ONLY_COVER) return

    // Ton klar: Sprach-Ersatz (Klang-Bursts 0–1, 2–3 … s) über Rosa Rauschen; die Sprachkette senkt das Rauschen in den Pausen, original bleibt unverändert.
    // Lautheit in zwei Durchgängen: integriert −14 LUFS
    {
      const src = join(dir, 'ton-src.mkv'), size = { w: 320, h: 180 }
      await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=10', '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,2),1),0.05*(sin(2*PI*180*t)+0.5*sin(2*PI*360*t)+0.3*sin(2*PI*1200*t))*(0.6+0.4*sin(2*PI*4*t)),0)':s=48000:d=10",
        '-f', 'lavfi', '-i', 'anoisesrc=c=pink:a=0.01:r=48000:d=10', '-filter_complex', '[1:a][2:a]amix=inputs=2:normalize=0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', src])
      const job = { file: src, parts: [{ start: 0, end: 10 }], captions: 'aus' as const, transcript: null, size, font: { name: 'Archivo', files: [], bold: true }, accent: '#FF8800' }
      const seg = async (n: string, ton?: 'klar' | 'original') => (await clipSegs({ ...job, ton }, `ton-${n}`, dir, { preset: 'ultrafast' }))[0]
      const [ohne, orig, klar] = [await seg('ohne'), await seg('original', 'original'), await seg('klar', 'klar')]
      const [po, pk] = [await pcm16k(orig.file), await pcm16k(klar.file)]
      assert.ok(Buffer.from((await pcm16k(ohne.file)).buffer).equals(Buffer.from(po.buffer)), 'ton original weicht von ohne ton ab')
      near((await probe(klar.file)).duration, (await probe(orig.file)).duration, 0.02, 'Länge mit ton klar')
      // Versatz: afftdn verzögert um 25 ms, die Kette gleicht das aus. Sauberer 300-Hz-Burst ab 2 s (ohne Rauschen, damit der Schwellwert nicht an der Pegeländerung hängt): Anfang gleich (≤ 1 ms)
      const burst = join(dir, 'ton-burst.mkv')
      await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4', '-f', 'lavfi', '-i', "aevalsrc='if(gte(t,2),0.3*sin(2*PI*300*(t-2)),0)':s=48000:d=4", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-ac', '2', burst])
      const onset = async (ton?: 'klar') => {
        const p = await pcm16k((await clipSegs({ ...job, file: burst, parts: [{ start: 0, end: 4 }], ton }, `burst-${ton ?? 'orig'}`, dir, { preset: 'ultrafast' }))[0].file)
        return p.findIndex((x) => Math.abs(x) > 0.02) / 16000
      }
      const [ao, ak] = [await onset(), await onset('klar')]
      console.log(`  Burst-Anfang: original ${ao.toFixed(4)} s, klar ${ak.toFixed(4)} s`)
      near(ak, ao, 0.001, 'Versatz mit ton klar')
      const pause = (p: Float32Array) => Math.max(...[1.3, 3.3, 5.3, 7.3].map((t) => dbOf(p, t, t + 0.5))), rede = (p: Float32Array) => dbOf(p, 4.2, 4.8)
      console.log(`  Ton klar: Rauschen in Pausen ${pause(po).toFixed(1)} → ${pause(pk).toFixed(1)} dB, Sprache ${rede(po).toFixed(1)} → ${rede(pk).toFixed(1)} dB`)
      assert.ok(pause(pk) <= pause(po) - 4, 'ton klar senkt das Rauschen in Pausen kaum')
      assert.ok(rede(pk) >= rede(po) - 3, 'ton klar dämpft die Sprache zu stark')
      const mp4 = join(dir, 'ton-klar.mp4')
      await finish([klar], mp4, dir, { loudnorm: true })
      const { err } = await run(await ffmpegBin(), ['-hide_banner', '-nostats', '-i', mp4, '-af', 'ebur128', '-f', 'null', '-'])
      const lufs = Number([...err.matchAll(/\bI:\s+(-?[\d.]+) LUFS/g)].at(-1)?.[1])
      console.log(`  Lautheit (2 Durchgänge): ${lufs} LUFS`)
      near(lufs, -14, 1, 'integrierte Lautheit')
    }
    if (process.env.DW_ONLY_TON) return

    // Szenengrenzen: harte Bildwechsel finden (scdet), Kanten knapp davor/dahinter darauflegen, Polster nie darüber – sonst blitzt die Nachbarszene auf
    {
      const lavfi = async (out: string, ins: string[], graph?: string) => runFfmpeg([...ins.flatMap((i) => ['-f', 'lavfi', '-i', i]), ...(graph ? ['-filter_complex', graph] : []), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out])
      const hart = join(dir, 'hart.mp4'), hart2 = join(dir, 'hart2.mp4'), ruhig = join(dir, 'ruhig.mp4'), wackel = join(dir, 'wackel.mp4')
      await lavfi(hart, ['color=red:size=320x180:rate=30:duration=2', 'testsrc2=size=320x180:rate=30:duration=2', 'color=blue:size=320x180:rate=30:duration=2'], '[0:v][1:v][2:v]concat=n=3:v=1:a=0')
      // Schnitt zwischen ähnlichen Bildern (zwei Ausschnitte desselben Musters), schwächster gemessener Fall
      await lavfi(hart2, ['testsrc2=size=1280x720:rate=30:duration=2,crop=640:360:300:200', 'testsrc2=size=1280x720:rate=30:duration=2,crop=640:360:380:240'], '[0:v][1:v]concat=n=2:v=1:a=0')
      await lavfi(ruhig, ['testsrc=size=320x180:rate=30:duration=6'])
      await lavfi(wackel, ["testsrc2=size=1280x720:rate=30:duration=4,crop=640:360:x='300+80*sin(t*25)':y='200+50*cos(t*19)'"]) // heftige Handkamera
      const cuts = await scenes(hart, 0.5, 5.5)
      assert.equal(cuts.length, 2, `Bildwechsel ${cuts}`)
      near(cuts[0], 2, 1 / 30, 'Wechsel rot → Testbild')
      near(cuts[1], 4, 1 / 30, 'Wechsel Testbild → blau')
      const sim = await scenes(hart2, 0, 4)
      assert.equal(sim.length, 1, `ähnliche Bilder ${sim}`)
      near(sim[0], 2, 1 / 30, 'Wechsel zwischen ähnlichen Bildern')
      assert.deepEqual(await scenes(ruhig, 0, 6), [], 'ruhiges Video')
      assert.deepEqual(await scenes(wackel, 0, 4), [], 'Wackeln ist kein Bildwechsel')

      // snapToScenes: Start bis 0,3 s vor, Ende bis 0,3 s nach dem Wechsel; focus bleibt
      assert.deepEqual(snapToScenes([{ start: 1.8, end: 3, focus: 0.3 }, { start: 3.5, end: 4.2 }], [2, 4]), { parts: [{ start: 2, end: 3, focus: 0.3 }, { start: 3.5, end: 4 }], moved: 2 })
      assert.equal(snapToScenes([{ start: 1.6, end: 3 }], [2]).moved, 0, 'weiter als 0,3 s: bleibt')
      const word = (start: number, end: number): Transcript => ({ duration: 6, lang: 'de', segments: [{ start, end, text: 'x', words: [{ w: ' x', start, end }] }] })
      assert.equal(snapToScenes([{ start: 1.8, end: 3 }], [2], word(1.85, 2.3)).moved, 0, 'Wechsel mitten im Wort')
      assert.equal(snapToScenes([{ start: 1.8, end: 3 }], [2], word(1.82, 1.95)).moved, 0, 'Wort fiele weg')
      assert.equal(snapToScenes([{ start: 1.8, end: 3 }], [2], word(2.5, 2.9)).moved, 1, 'Wort hinter dem Wechsel stört nicht')
      assert.equal(snapToScenes([{ start: 1.8, end: 3 }], [2], { duration: 6, lang: 'de', segments: [{ start: 1.8, end: 2.5, text: 'geschätzt' }] }).moved, 1, 'ohne echte Wortzeiten verschieben')
      assert.equal(snapToScenes([{ start: 0, end: 2.1 }, { start: 2.1, end: 5 }], [1.9, 2.2]).moved, 0, 'nahtlos: nie anfassen')
      assert.equal(snapToScenes([{ start: 1.8, end: 2.3 }], [2]).moved, 0, 'Teil fiele unter 0,5 s')

      // padParts: Polster endet am Wechsel
      assert.deepEqual(padParts([{ start: 2, end: 4 }], 12, [2, 4.1]).map((p) => [p.start, p.end]), [[2, 4.1]])
      assert.deepEqual(padParts([{ start: 2, end: 4 }], 12, [1.9, 4.2]).map((p) => [p.start, p.end]), [[1.9, 4 + PAD]])

      // Ganze Kette im Export: ohne cuts blitzen rot und blau auf, mit cuts kein einziges einfarbiges Bild
      const flat = async (file: string) => {
        const { out } = await run(await ffmpegBin(), ['-i', file, '-vf', 'scale=8:8', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
        let n = 0
        for (let f = 0; f + 192 <= out.length; f += 192) if (out.subarray(f, f + 192).every((v, k) => Math.abs(v - out[f + (k % 3)]) < 12)) n++
        return n
      }
      const job = { file: hart, hook: undefined, captions: 'aus' as const, transcript: null, size: { w: 320, h: 180 }, font: { name: 'Archivo', files: [], bold: true }, accent: '#FF8800' }
      const raw = [{ start: 1.8, end: 4.2 }], snapped = snapToScenes(raw, cuts)
      assert.ok((await flat((await clipSegs({ ...job, parts: raw }, 'blitz', dir, { preset: 'ultrafast' }))[0].file)) > 0, 'Gegenprobe: ohne cuts blitzt es')
      const clean = await clipSegs({ ...job, parts: snapped.parts, cuts }, 'sauber', dir, { preset: 'ultrafast' })
      assert.equal(await flat(clean[0].file), 0, 'Blitzbild im Export')
      near(clean[0].dur, 2, 0.05, 'Länge zwischen den Wechseln')
      console.log(`  Szenengrenzen ok (Wechsel ${cuts.map((c) => c.toFixed(3))}, ähnlich ${sim.map((c) => c.toFixed(3))})`)
    }
    if (process.env.DW_ONLY_SCENES) return

    // Schnitte nie mitten im Wort: Start vor das Wort, Ende hinter das Wort (höchstens 0,4 s); ohne echte Wortzeiten unverändert
    const sw = (w: string, start: number, end: number) => ({ w, start, end })
    const snapTr: Transcript = { duration: 12, lang: 'de', segments: [{ start: 1, end: 5, text: 'a b c', words: [sw(' eins', 1, 1.8), sw(' zwei', 1.9, 2.6), sw(' drei', 4, 4.6)] }] }
    const sn = snapParts([{ start: 1.3, end: 4.3, focus: 0.3 }, { start: 8, end: 9 }], snapTr)
    assert.equal(sn.moved, 2)
    assert.deepEqual(sn.parts, [{ start: 1, end: 4.6, focus: 0.3 }, { start: 8, end: 9 }])
    assert.equal(snapParts([{ start: 2.3, end: 4.3 }], snapTr).parts[0].start, 1.9)
    assert.deepEqual(snapParts([{ start: 1.5, end: 4.3 }], null), { parts: [{ start: 1.5, end: 4.3 }], moved: 0 })
    assert.equal(snapParts([{ start: 1.5, end: 4.3 }], { duration: 12, lang: 'de', segments: [{ start: 1, end: 5, text: 'eins zwei drei' }] }).moved, 0, 'ohne words geschätzt: unverändert')
    if (process.env.DW_ONLY_SNAP) return

    // Clip-Stil: ruhig (ohne style) Byte für Byte wie vor 'lebendig', lebendig mit Pop, Hook-Einblendung, Balken je Gruppe, Zoom an jedem zweiten Schnitt
    {
      const ws = clipWords({ duration: 12, lang: 'de', segments: [{ start: 1, end: 4, text: 'eins zwei drei' }, { start: 6, end: 8, text: 'vier fünf' }] }, [{ start: 1, end: 4 }, { start: 6, end: 8 }])
      const sub = (mode: 'wort' | 'satz', x: object = {}) => assSubs({ size: { w: 1080, h: 1920 }, font: 'Archivo', bold: true, accent: '#FF8800', hook: 'Warum das klappt', hookDur: 4, cues: cues(ws, mode), mode, ...x })
      const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
      assert.equal(sha(sub('wort')), '43d26050f6b4cc6c', 'ruhig/wort unverändert')
      assert.equal(sha(sub('satz')), '3265eea221f79b63', 'ruhig/satz unverändert')
      assert.equal(sub('wort', { style: 'ruhig', bar: { off: 0, dur: 5, total: 5 } }), sub('wort'), 'style ruhig = ohne style')
      const live = sub('wort', { style: 'lebendig', bar: { off: 5, dur: 5, total: 20 } })
      assert.ok(live.includes('{\\c&H0088FF&\\fscx108\\fscy108\\t(0,120,\\fscx100\\fscy100)}zwei{\\r}'), live)
      assert.equal(live.match(/\\t\(0,120,/g)?.length, 5, 'Pop je Wortzustand')
      assert.ok(live.includes(',HookBox,,0,0,0,,{\\fad(200,200)}Warum das klappt'), live)
      assert.ok(/^Style: HookBox,Archivo,\d+,&H00FFFFFF,&H00FFFFFF,&H59000000,&H80000000,-1,0,0,0,100,100,0,0,3,13,0,/m.test(live), live)
      const bars = live.match(/^Dialogue: .*,Bar,.*$/gm) ?? []
      assert.equal(bars.length, 1, 'ein Balken je Gruppe')
      assert.ok(bars[0].includes('0:00:00.00,0:00:05.00') && bars[0].includes('\\pos(0,1908)\\clip(0,0,270,1920)\\t(\\clip(0,0,540,1920))\\p1}m 0 0 l 1080 0 1080 12 0 12'), bars[0])
      assert.ok(!sub('satz', { style: 'lebendig' }).includes('\\fscx108'), 'satz ohne Pop')
      // Zuschnitt: part 0 wie bisher, part 1 um 1,08 enger um denselben Mittelpunkt
      const c = cropRect({ w: 1280, h: 720 }, { w: 1080, h: 1920 }, 0.5)
      assert.equal(cropFilter(c, { w: 1080, h: 1920 }, zoomOf('lebendig', 0)), 'crop=406:720:437:0,scale=1080:1920')
      assert.equal(cropFilter(c, { w: 1080, h: 1920 }, zoomOf(undefined, 1)), 'crop=406:720:437:0,scale=1080:1920')
      const z = zoomCrop(c, zoomOf('lebendig', 1))
      // Zoom wechselt nur an echten Schnitten: nahtlos anschließende parts (follow) behalten den Zoom
      assert.deepEqual([0, 1, 2, 3].map((i) => cutIndex([{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 6, end: 8 }, { start: 9, end: 10 }], i)), [0, 0, 1, 2])
      assert.ok(z.w < c.w && z.h < c.h && Math.abs(z.x + z.w / 2 - (c.x + c.w / 2)) <= 1 && Math.abs(z.y + z.h / 2 - (c.y + c.h / 2)) <= 1, JSON.stringify(z))
      // ffmpeg nimmt Filtergraph und ASS an: 4-s-Quelle, zwei parts, Hook, Balken
      const fxSrc = join(dir, 'fx.mp4')
      await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fxSrc])
      const fxFont = { name: 'Archivo', files: [readFileSync(resolve('assets/fonts/Archivo-Bold.ttf'))], bold: true }
      const fxSegs = await clipSegs({ file: fxSrc, parts: [{ start: 0.3, end: 1.5 }, { start: 2, end: 3.5 }], hook: 'Hook', captions: 'aus', transcript: null, size: { w: 180, h: 320 }, font: fxFont, accent: '#FF8800', style: 'lebendig' }, 'fx', dir, { preset: 'ultrafast' })
      near((await probe(fxSegs[0].file)).duration, fxSegs[0].dur, 0.1, 'lebendig: Länge')
      assert.ok(readFileSync(join(dir, 'fx-01.ass'), 'utf8').includes(',Bar,'), 'Balken auch ohne Untertitel')
      console.log('  Clip-Stil ok')
    }
    if (process.env.DW_ONLY_FX) return

    // Kontaktabzug: 9:16 aus 16:9, zwei parts, 3×3 Kacheln
    const sheetSrc = join(dir, 'abzug.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', sheetSrc])
    const tSheet = Date.now()
    const sheetParts = [{ start: 1, end: 4 }, { start: 8, end: 11.95, focus: 0.3 }]
    for (const fit of ['crop', 'blur'] as const) {
      const sheet = await contactSheet(sheetSrc, sheetParts, { size: { w: 1080, h: 1920 }, fit })
      const jpg = join(dir, `abzug-${fit}.jpg`)
      writeFileSync(jpg, sheet.jpg)
      const meta = await probe(jpg).catch(() => null) // Standbild: Dauer egal, Maße zählen
      assert.ok(meta, 'Kontaktabzug lesbar')
      near(meta!.w, 720, 2, 'Kontaktabzug Breite')
      near(meta!.h, 3 * ((240 * 16) / 9), 2, 'Kontaktabzug Höhe')
      assert.equal(sheet.times.length, 9)
      sheet.times.forEach((t, i) => {
        assert.ok(i === 0 || t > sheet.times[i - 1], 'times monoton')
        assert.ok(sheetParts.some((p) => t >= p.start && t <= p.end + 1e-6), `Zeit ${t} in einem part`)
      })
    }
    console.log(`  Kontaktabzug ok (${Date.now() - tSheet} ms für 2 × 9 Kacheln)`)
    if (process.env.DW_ONLY_SHEET) return

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
    // Dauer aus dem Container ist fremd: ffconcat mit duration 200000 s (55 h) meldet sich, statt riesige Arrays anzulegen
    writeFileSync(join(dir, 'lang.ffconcat'), "ffconcat version 1.0\nfile 'quelle.mp4'\nduration 200000\n")
    await assert.rejects(probe(join(dir, 'lang.ffconcat')), /länger als 48 Stunden/)

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
    // Ausgabegröße: 1,5-fach, längere Seite höchstens 3840 px, Seitenverhältnis bleibt
    assert.deepEqual(outSize({ w: 720, h: 1280 }), out)
    assert.deepEqual(outSize({ w: 50000, h: 50000 }), { w: 3840, h: 3840 })
    assert.deepEqual(outSize({ w: 3000, h: 1000 }), { w: 3840, h: 1280 })

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
    // einzelnes \r: für libass ein Zeilenumbruch, darf keine eigene Dialogue-Zeile einschleusen
    const cr = assSubs({ size: out, font: 'Archivo', bold: true, accent: '#FF8800', hook: 'a\rDialogue: 0,0:00:00.00,9:00:00.00,Hook,,0,0,0,,x\r\nb\nc', hookDur: 4, cues: [], mode: 'wort' })
    assert.ok(!cr.includes('\r') && cr.includes(',,a\\NDialogue: 0,0:00:00.00,9:00:00.00,Hook,,0,0,0,,x\\Nb\\Nc'), cr)
    assert.equal(cr.match(/^Dialogue:/gm)?.length, 1, 'eingeschleuste Zeile')
    // Lage nach Format: Querformat kleiner und tief (7 %), 9:16 über der Plattform-Leiste (33 %), 4:5 bei 12 %. Felder: [2] Größe, [21] MarginV
    const styles = (size: { w: number; h: number }) => {
      const a = assSubs({ size, font: 'Archivo', bold: true, accent: '#FF8800', hook: 'Hook', hookDur: 4, cues: [], mode: 'wort' }).split('\n')
      return ['Hook', 'Cap'].map((n) => a.find((l) => l.startsWith(`Style: ${n},`))!.split(',').map(Number))
    }
    const [[hookQuer, quer], [hookHoch, hoch], [, vier]] = [{ w: 1920, h: 1080 }, out, { w: 1080, h: 1350 }].map(styles)
    assert.ok(quer[2] < hoch[2] && hookQuer[2] < hookHoch[2], `Querformat kleiner: ${quer[2]}/${hoch[2]}, Hook ${hookQuer[2]}/${hookHoch[2]}`)
    near(quer[21], 76, 1, 'MarginV quer'); near(hoch[21], 634, 1, 'MarginV 9:16'); near(vier[21], 162, 1, 'MarginV 4:5')
    near(hoch[19], 0.08 * 1080, 0.5, 'seitlich 8 % Rand')

    // Zuschnitt folgt dem Sprecher: Wechsel bei 5 s, der kurze Turn 5–5,8 gehört zum selben Sprecher wie 5,8–12; part mit focus bleibt
    const X = new Map([[0, 0.25], [1, 0.75]])
    assert.deepEqual(followParts([{ start: 0, end: 12 }, { start: 20, end: 25, focus: 0.5 }], [{ start: 0, end: 5, speaker: 0 }, { start: 5, end: 5.8, speaker: 1 }, { start: 5.8, end: 12, speaker: 1 }], X),
      [{ start: 0, end: 5, focus: 0.25 }, { start: 5, end: 12, focus: 0.75 }, { start: 20, end: 25, focus: 0.5 }])
    // kurzer Einwurf zählt zum Vorgänger, kurzes Stück am part-Anfang zum Nachfolger, unbekannter Sprecher zum Nachbarn, ohne Turns unverändert
    assert.deepEqual(followParts([{ start: 0, end: 12 }], [{ start: 0, end: 5, speaker: 0 }, { start: 5, end: 5.8, speaker: 1 }, { start: 5.8, end: 12, speaker: 0 }], X), [{ start: 0, end: 12, focus: 0.25 }])
    assert.deepEqual(followParts([{ start: 4.5, end: 12 }], [{ start: 0, end: 5, speaker: 0 }, { start: 5, end: 12, speaker: 1 }], X), [{ start: 4.5, end: 12, focus: 0.75 }])
    assert.deepEqual(followParts([{ start: 0, end: 12 }], [{ start: 0, end: 6, speaker: 2 }, { start: 6, end: 12, speaker: 1 }], X), [{ start: 0, end: 12, focus: 0.75 }])
    assert.deepEqual(followParts([{ start: 0, end: 4 }], [], X), [{ start: 0, end: 4 }])

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

    // Viele Schnitte: 45 parts am Stück, 1 s Stille alle 4 s → rund 70 Teilstücke in mehreren Gruppen; Nähte ohne Lücke, Bild und Ton gleich lang
    const lang = join(dir, 'lang.mkv'), langClip = join(dir, 'lang.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=120', '-f', 'lavfi', '-i', "aevalsrc='if(gte(mod(t,4),3),0,0.5*sin(2*PI*440*t))':s=48000:d=120", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', lang])
    const many = Array.from({ length: 45 }, (_, k) => ({ start: 2.5 * k, end: 2.5 * (k + 1) }))
    // erwartet: je part die Stillen ab MIN_PAUSE innerhalb des parts (silencedetect sieht nur den part)
    const ideal = many.flatMap((p) => Array.from({ length: 30 }, (_, j): [number, number] => [Math.max(p.start, 4 * j + 3), Math.min(p.end, 4 * j + 4)]).filter(([a, b]) => b - a >= MIN_PAUSE))
    const t0 = Date.now()
    const lenLang = await encodeClip({ file: lang, parts: many, captions: 'aus', transcript: null, size: { w: 640, h: 360 }, font, accent: '#FF8800', pauses: 'kurz' }, langClip, dir)
    console.log(`  45 parts: ${lenLang.toFixed(1)} s in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    near(lenLang, partsLength(padParts(tighten(many, ideal), 120)), 0.1, 'Länge bei 45 parts')
    assert.ok(existsSync(join(dir, 'lang-03.mkv')), 'mindestens drei Gruppen')
    near((await probe(langClip)).duration, lenLang, 0.1, 'Ausgabe-Dauer')
    const streamDur = async (sel: string) => Number((await run('ffprobe', ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=duration', '-of', 'csv=p=0', langClip])).out.toString())
    await Promise.all([streamDur('v:0'), streamDur('a:0')]).then(
      ([v, a]) => { near(v, lenLang, 0.1, 'Videospur'); assert.ok(Math.abs(v - a) < 0.05, `Bild ${v} s, Ton ${a} s`) },
      () => console.log('  (Spurlängen übersprungen: kein ffprobe)'),
    )
    // Stille Stellen (10-ms-Fenster): nur die gekürzten Pausen (≥ 2·PAD), keine kurzen Löcher an Nähten
    const lp = await pcm16k(langClip), holes: number[] = []
    let quietRuns = 0, from = -1
    for (let s = 800; s + 160 < lp.length - 800; s += 160) {
      const silent = Math.sqrt(lp.subarray(s, s + 160).reduce((q, x) => q + x * x, 0) / 160) < 0.02
      if (silent && from < 0) from = s
      if (!silent && from >= 0) { quietRuns++; if (s - from < 0.2 * 16000) holes.push(+(from / 16000).toFixed(2)); from = -1 }
    }
    assert.ok(quietRuns >= 20, `nur ${quietRuns} Restpausen`)
    assert.deepEqual(holes, [], 'Lücken im Ton bei (s)')

    // fit blur: 16:9 in 9:16 ganz sichtbar, Grund oben und unten unscharf, abgedunkelt, aber nicht schwarz
    const blurClip = join(dir, 'blur.mp4')
    await encodeClip({ file: src, parts: [{ start: 1, end: 2 }], captions: 'aus', transcript: null, size: out, font, accent: '#FF8800', fit: 'blur' }, blurClip, dir)
    const bl = await probe(blurClip)
    assert.deepEqual([bl.w, bl.h], [1080, 1920])
    const [bimg] = await rawFrames(blurClip, [0.5], 640) // 360×640 links, Bild 360×203 bei y≈219
    for (const [what, y0, y1] of [['oben', 20, 180], ['Mitte', 290, 350], ['unten', 460, 620]] as const) {
      const v = luma(bimg, 640, 10, y0, 350, y1)
      assert.ok(v > 15, `blur ${what} schwarz (${v.toFixed(1)})`)
    }

    // Übergang: Standbild blendet ab, der Clip danach blendet aus Schwarz ein; beide lassen sich ohne Neukodieren verbinden
    const grau = join(dir, 'grau.png'), blende = join(dir, 'blende.mp4'), small = { w: 640, h: 360 }
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=gray:s=640x360', '-frames:v', '1', grau])
    const standbild = await encodeStill(grau, join(dir, 'still.mkv'), dir, { preset: 'veryfast', fadeOut: true })
    const zwei = await clipSegs({ file: src, parts: [{ start: 2, end: 5 }], captions: 'aus', transcript: null, size: small, font, accent: '#FF8800' }, 'blende', dir, { preset: 'veryfast', fadeIn: true })
    await finish([standbild, ...zwei], blende, dir, { loudnorm: true })
    near((await probe(blende)).duration, STILL + 3 + PAD * 2, 0.1, 'Länge mit Übergang')
    await runFfmpeg(['-v', 'error', '-xerror', '-i', blende, '-f', 'null', '-']) // dekodiert ohne Fehler über die Naht
    const hell = async (t: number) => luma((await rawFrames(blende, [t], 320))[0], 320, 0, 0, 320, 180)
    const [vorher, ab, ein, danach] = [await hell(1), await hell(STILL - 0.05), await hell(STILL + 0.02), await hell(STILL + 0.5)]
    assert.ok(ab < vorher * 0.5, `Abblende fehlt (${ab.toFixed(1)} von ${vorher.toFixed(1)})`)
    assert.ok(ein < danach * 0.5, `Einblende fehlt (${ein.toFixed(1)} statt deutlich unter ${danach.toFixed(1)})`)

    // Musik weicht der Sprache: leise Sprache wie vom Handy (440 Hz, −31 dBFS RMS) 0–3 und 7–10 s, Musik 2000 Hz aus 5 s in Schleife; Pegel der Musik per Bandpass.
    // Pausenfenster bis 12 s: dort muss die Musik noch laufen (sidechaincompress verwarf sonst je nach Scheduling das Ende)
    const rede = join(dir, 'rede.mkv'), musik = join(dir, 'musik.wav'), mix = join(dir, 'musik.mp4'), band = join(dir, 'band.wav')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=14', '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,7),3),0.04*sin(2*PI*440*t),0)':s=48000:d=14", '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', rede])
    await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=2000:sample_rate=48000:duration=5', musik])
    const redeSegs = await clipSegs({ file: rede, parts: [{ start: 0, end: 14 }], captions: 'aus', transcript: null, size: { w: 320, h: 180 }, font, accent: '#FF8800' }, 'rede', dir, { preset: 'veryfast' })
    await finish(redeSegs, mix, dir, { music: { file: musik, volume: 0.5 } }) // ohne loudnorm: nur das Ducking zählt
    near((await probe(mix)).duration, 14, 0.1, 'Länge mit Musik')
    await runFfmpeg(['-i', mix, '-af', 'bandpass=f=2000:width_type=q:w=5,bandpass=f=2000:width_type=q:w=5', band])
    const bp = await pcm16k(band)
    const unter = Math.max(dbOf(bp, 1.5, 2.5), dbOf(bp, 8.5, 9.5)), frei = Math.min(dbOf(bp, 4.5, 6.5), dbOf(bp, 11.5, 12))
    console.log(`  Musik: ${frei.toFixed(1)} dB in Pausen, ${unter.toFixed(1)} dB unter Sprache`)
    assert.ok(frei - unter >= 8, `Musik nur ${(frei - unter).toFixed(1)} dB leiser unter der Sprache`)

    // ohne Ton und ohne Untertitel: anullsrc, kein ass-Filter
    const stumm = join(dir, 'stumm.mp4'), stummClip = join(dir, 'stumm-clip.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', stumm])
    assert.equal((await probe(stumm)).audio, false)
    await encodeClip({ file: stumm, parts: [{ start: 0.5, end: 2 }], captions: 'aus', transcript: null, size: { w: 1080, h: 1080 }, font, accent: '#FF8800', pauses: 'kurz' }, stummClip, dir) // ohne Ton: kurz misst nichts
    const s = await probe(stummClip)
    assert.deepEqual([s.w, s.h, s.audio], [1080, 1080, true])
    await assert.rejects(encodeClip({ file: stumm, parts: [{ start: 5, end: 6 }], captions: 'aus', transcript: null, size: out, font, accent: '#000000' }, stummClip, dir), /nur 4\.0 s lang/)
    // Musik ohne Tonspur oder fehlend: deutsche Meldung vor dem Encoden (scheitert vor allen Electron-Teilen)
    const deck = { title: 'Musik', theme: { id: 'beratung' }, transition: 'none', mode: 'click', slides: [{ layout: 'clip', content: { video: src, parts: [{ start: 1, end: 2 }] } }] } as unknown as Deck
    await assert.rejects(exportVideo(deck, join(dir, 'x'), 'mp4', async () => null, undefined, { music: { file: stumm } }), /Die Musikdatei .*stumm\.mp4 hat keine Tonspur\./)
    await assert.rejects(exportVideo(deck, join(dir, 'x'), 'clips', async () => null, undefined, { music: { file: join(dir, 'fehlt.mp3') } }), /Die Musikdatei .*fehlt\.mp3 fehlt\./)

    // Obergrenzen vor dem Encoden: höchstens MAX_PARTS Ausschnitte (nahtlose Stücke zählen nicht extra), Material höchstens 6 h
    const clipDeck = (parts: { start: number; end: number }[]) => ({ ...deck, slides: [{ layout: 'clip', content: { video: src, parts } }] }) as unknown as Deck
    const viele = clipDeck(Array.from({ length: 101 }, (_, k) => ({ start: k * 0.1, end: k * 0.1 + 0.05 })))
    await assert.rejects(exportVideo(viele, join(dir, 'x'), 'clips', async () => null), /101 Ausschnitte, höchstens 100/)
    await assert.rejects(exportVideo(clipDeck(Array.from({ length: 101 }, (_, k) => ({ start: k * 0.1, end: k * 0.1 + 0.1 })).concat({ start: 13, end: 7 * 3600 })), join(dir, 'x'), 'clips', async () => null), /7\.0 h lang, ein Video-Export geht bis 6 h/)
    // Reste abgestürzter Exporte: Job-Ordner älter als 6 h fällt weg, ein frischer bleibt
    const alt = join(dir, '.video-tmp-alt'), neu = join(dir, '.video-tmp-neu')
    mkdirSync(alt); mkdirSync(neu)
    utimesSync(alt, new Date(Date.now() - 7 * 3600e3), new Date(Date.now() - 7 * 3600e3))
    // Exporte nacheinander: B scheitert sofort an der Prüfung, wartet aber, bis A (Musik per ffmpeg anspielen) fertig ist
    const order: string[] = []
    await Promise.all([
      assert.rejects(exportVideo(deck, join(dir, 'x'), 'mp4', async () => null, undefined, { music: { file: stumm } }).finally(() => order.push('a')), /keine Tonspur/),
      assert.rejects(exportVideo(viele, join(dir, 'x'), 'clips', async () => null).finally(() => order.push('b')), /101 Ausschnitte/),
    ])
    assert.deepEqual(order, ['a', 'b'], 'zwei Exporte gleichzeitig')
    assert.ok(!existsSync(alt) && existsSync(neu), 'alter Job-Ordner weg, frischer bleibt')

    console.log('check-video: alles grün')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
