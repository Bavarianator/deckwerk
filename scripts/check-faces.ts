// Gesichter für den Zuschnitt (YuNet), opt-in mit DW_NET=1 (lädt Modell 230 KB und Testbild 1,1 MB, braucht ffmpeg); Kamerafahrt ohne Modell läuft immer, DW_ONLY_TRACK=1 nur sie: npx esbuild scripts/check-faces.ts --bundle --platform=node --format=esm --external:onnxruntime-node --outfile=node_modules/.cache/check-faces.mjs && DW_NET=1 DECKWERK_HOME=${TMPDIR:-/tmp}/check-faces-home node node_modules/.cache/check-faces.mjs
// Bündel unter node_modules/.cache, damit node das externe onnxruntime-node findet.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { download } from '../src/main/download'
import { MAX_SPEED, autoFocus, cameraPath, detect, faceX, speakerFaces } from '../src/main/faces'
import { probe, rawFrames, runFfmpeg } from '../src/main/ffmpeg'
import { cropFilter, zoomCrop } from '../src/main/video-fx'
import { cropRect } from '../src/shared/video'

// Beispielbild aus opencv_zoo (MIT), fester Commit + Prüfsumme; eine Menschenmenge, das größte Gesicht liegt bei x ≈ 0,59
const SELFIE = 'https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/example_outputs/largest_selfie.jpg'
const SELFIE_SHA256 = 'ab8413ad9bb4f53068f4fb63c6747e5989991dd02241c923d5595b614ecf2bf6'
const enc = ['-r', '25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']

// focus zur Zeit t aus Stützpunkten wie im Export: linear, davor/danach konstant, gleiche Zeit = Sprung
const focusAt = (keys: [number, number][], t: number) => {
  const k = keys.findLastIndex(([kt]) => kt <= t)
  if (k < 0 || k === keys.length - 1) return keys[Math.max(0, k)][1]
  const [ta, fa] = keys[k], [tb, fb] = keys[k + 1]
  return fa + ((fb - fa) * (t - ta)) / (tb - ta)
}

// Kamerafahrt ohne Modell: cameraPath (9:16 aus 16:9) und cropFilter mit track durch ffmpeg
async function checkTrack(dir: string) {
  const cw = 608 / 1920, at = (xs: (number | null)[]) => xs.map((x, i) => ({ t: i + 0.5, x }))
  // ruhige Person mit Zittern und einem Ausreißer: kein Schwenk
  const calm = at(Array.from({ length: 30 }, (_, i) => (i === 10 ? 0.95 : 0.6 + 0.02 * Math.sin(i))))
  assert.ok(cameraPath(calm, [], cw).length <= 1, `ruhig ${JSON.stringify(cameraPath(calm, [], cw))}`)
  // läuft von links nach rechts, langsam (20 s) und schneller als die Tempo-Grenze (5 s): monoton, Tempo ≤ MAX_SPEED, wenige Stützpunkte
  for (const secs of [20, 5]) {
    const keys = cameraPath(at(Array.from({ length: 24 }, (_, i) => 0.2 + 0.6 * Math.min(1, i / secs))), [], cw)
    assert.ok(keys.length > 1 && keys.length <= 20, `Gang ${secs} s: ${keys.length} Stützpunkte`)
    keys.slice(1).forEach(([t, f], i) => {
      const [t0, f0] = keys[i]
      assert.ok(f >= f0 && f - f0 <= MAX_SPEED * cw * (t - t0) + 1e-3, `Gang ${secs} s: ${JSON.stringify(keys)}`)
    })
    assert.ok(keys[keys.length - 1][1] > 0.7, `Gang ${secs} s: Kamera kommt an ${JSON.stringify(keys)}`)
  }
  // Bildwechsel bei 10 s: Sprung genau dort, davor und danach kein Schwenk; ohne cut schwenkt dieselbe Folge
  const shots = at(Array.from({ length: 20 }, (_, i) => (i < 10 ? 0.3 : 0.7)))
  const jump = cameraPath(shots, [10], cw)
  assert.ok(Math.abs(focusAt(jump, 9.999) - 0.3) < 1e-3 && focusAt(jump, 10) === 0.7, `cut ${JSON.stringify(jump)}`)
  assert.ok(jump.every(([t, f]) => f === (t < 10 ? 0.3 : t > 10 ? 0.7 : f)), `cut ${JSON.stringify(jump)}`)
  assert.ok(cameraPath(shots, [], cw).some(([, f]) => f > 0.31 && f < 0.69), 'ohne cut wird geschwenkt')
  // Lücken halten die Position, auch am Anfang
  assert.deepEqual(cameraPath(at([null, null, 0.7, 0.7, null, null, null, 0.7, null]), [], cw), [[0.5, 0.7]])

  // cropFilter: ohne track wie bisher, mit track fährt x; gezoomt mit gezoomter Breite/Höhe
  const src = { w: 1920, h: 1080 }, out = { w: 1080, h: 1920 }, c = cropRect(src, out, 0.5), z = zoomCrop(c, 1.08)
  const track = { src, keys: [[1.5, 0.2], [3.5, 0.8]] as [number, number][], start: 1 }
  assert.equal(cropFilter(c, out), 'crop=608:1080:656:0,scale=1080:1920')
  assert.ok(cropFilter(c, out, 1, track).startsWith("crop=608:1080:'") && cropFilter(c, out, 1, track).endsWith("':0:exact=1,scale=1080:1920"), cropFilter(c, out, 1, track))
  assert.ok(cropFilter(c, out, 1.08, track).startsWith(`crop=${z.w}:${z.h}:'`) && cropFilter(c, out, 1.08, track).endsWith(`':${z.y}:exact=1,scale=1080:1920`))
  // ffmpeg wie im Export (eigene Eingabe ab -ss 1, t = 0 bei Quellsekunde 1): Anfang = feste Ansicht bei 0,2, Ende = bei 0,8
  const bars = join(dir, 'balken.mp4'), x264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']
  await runFfmpeg(['-f', 'lavfi', '-i', 'smptehdbars=size=1920x1080:rate=30:duration=5', ...x264, bars])
  const cut = async (name: string, fit: string) => {
    const file = join(dir, name)
    await runFfmpeg(['-ss', '1', '-t', '3', '-i', bars, '-filter_complex', `[0:v]setpts=PTS-STARTPTS,fps=30,${fit},setsar=1[v]`, '-map', '[v]', ...x264, file])
    return file
  }
  const [a, mid, b] = await rawFrames(await cut('fahrt.mp4', cropFilter(c, out, 1, track)), [0.2, 1.5, 2.8])
  const [ra] = await rawFrames(await cut('links.mp4', cropFilter(cropRect(src, out, 0.2), out)), [0.2])
  const [rb] = await rawFrames(await cut('rechts.mp4', cropFilter(cropRect(src, out, 0.8), out)), [0.2])
  await cut('zoom.mp4', cropFilter(c, out, 1.08, track))
  const diff = (p: Buffer, q: Buffer) => p.reduce((s, v, i) => s + Math.abs(v - q[i]), 0) / p.length
  const d = [diff(a, ra), diff(b, rb), diff(a, b), diff(mid, ra), diff(mid, rb)].map((v) => Math.round(v * 10) / 10)
  console.log('Kamerafahrt ffmpeg: Abweichung Anfang, Ende, Anfang↔Ende, Mitte↔Anfang, Mitte↔Ende', d)
  assert.ok(d[0] < 3 && d[1] < 3 && d[2] > 15 && d[3] > 5 && d[4] > 5, `cropFilter mit track ${d}`)
  console.log('Kamerafahrt ok')
}

async function main() {
  const base = process.env.TMPDIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'check-faces-'))
  try {
    await checkTrack(dir)
    if (process.env.DW_ONLY_TRACK) return
    if (process.env.DW_NET !== '1') return console.log('check-faces: Modellteil übersprungen (DW_NET=1 lädt Modell und Testbild)')
    const jpg = join(dir, 'selfie.jpg'), selfie = join(dir, 'selfie.mp4'), black = join(dir, 'schwarz.mp4'), talk = join(dir, 'gespraech.mp4')
    await download(SELFIE, SELFIE_SHA256, jpg)
    await runFfmpeg(['-loop', '1', '-i', jpg, '-t', '2', ...enc, selfie])
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=black:s=1280x720:d=2', ...enc, black])

    // größtes Gesicht, Größe und Mundwinkel plausibel
    const info = await probe(selfie), frames = await rawFrames(selfie, [0.5, 1.5])
    let t0 = Date.now()
    const faces = await detect(frames[0], info)
    console.log(`detect: ${faces.length} Gesichter, erstes Bild ${Date.now() - t0} ms (mit Modell laden)`)
    t0 = Date.now()
    const xs = await faceX(frames, info)
    console.log(`faceX: ${Math.round((Date.now() - t0) / frames.length)} ms je Bild`, xs)
    for (const x of xs) assert.ok(x !== null && x > 0.5 && x < 0.8, `faceX ${x}`)
    assert.ok(faces.length >= 1)
    const big = faces.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b))
    assert.ok(big.w > 0.03 * info.w && big.w < 0.3 * info.w && big.h / big.w > 0.8 && big.h / big.w < 2, `Größe ${JSON.stringify(big)}`)
    const [mx1, my1, mx2, my2] = big.mouth
    assert.ok(big.x < mx1 && mx1 < mx2 && mx2 < big.x + big.w, `Mundwinkel x ${big.mouth}`)
    for (const y of [my1, my2]) assert.ok(y > big.y + big.h / 2 && y < big.y + big.h, `Mundwinkel y ${big.mouth}`)

    const binfo = await probe(black)
    assert.deepEqual(await faceX(await rawFrames(black, [1]), binfo), [null])

    // autoFocus: nur parts ohne focus; ohne Gesicht bleibt focus leer
    const parts = await autoFocus(selfie, [{ start: 0, end: 1 }, { start: 1, end: 2, focus: 0.2 }], info)
    assert.ok(parts[0].focus! > 0.5 && parts[0].focus! < 0.8, `autoFocus ${parts[0].focus}`)
    assert.equal(parts[1].focus, 0.2)
    assert.deepEqual(await autoFocus(black, [{ start: 0, end: 2 }], binfo), [{ start: 0, end: 2 }])
    const [late] = await autoFocus(selfie, [{ start: 1, end: 5 }], info) // end > Dauer: Zeiten geklemmt, kein Wurf
    assert.ok(late.focus! > 0.5 && late.focus! < 0.8, `autoFocus über das Ende ${late.focus}`)
    assert.ok(!late.track, 'ohne size keine Fahrt')
    // Kamerafahrt: Gesicht wandert in 8 s von links nach rechts durchs 16:9-Bild → track steigt; Bildwechsel bei 4 s → Sprung dort
    const walk = join(dir, 'gang.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'color=black:s=1280x720:r=25', '-loop', '1', '-i', jpg, '-t', '8', '-filter_complex',
      "[1]crop=220:248:1080:845,scale=440:496[f];[0][f]overlay=x='40+t*100':y=112", ...enc, walk])
    const winfo = await probe(walk), reel = { size: { w: 1080, h: 1920 } }
    const [g] = await autoFocus(walk, [{ start: 0, end: 8 }], winfo, reel)
    assert.ok(g.track && g.track.length > 1 && g.track.every(([, f], i) => !i || f >= g.track![i - 1][1]) && g.track.at(-1)![1] > 0.6, `Fahrt ${JSON.stringify(g)}`)
    const [h] = await autoFocus(walk, [{ start: 0, end: 8 }], winfo, { ...reel, cuts: [4, 9] })
    assert.equal(h.track?.filter(([t]) => t === 4).length, 2, `Sprung am cut ${JSON.stringify(h)}`)
    assert.ok(!(await autoFocus(selfie, [{ start: 0, end: 2 }], info, reel))[0].track, 'kurzer part: keine Fahrt')

    // Gespräch: dasselbe Gesicht links und gespiegelt rechts; Rauschen über dem Mund rechts in [2,4] s, links in [5,7] s
    const crop = 'crop=220:248:1080:845,scale=640:720,split[a][b];[b]hflip[c];[a][c]hstack'
    await runFfmpeg(['-loop', '1', '-i', jpg, '-t', '1', '-filter_complex', crop, ...enc, talk])
    const tinfo = await probe(talk)
    const pair = (await detect((await rawFrames(talk, [0.5]))[0], tinfo)).sort((a, b) => a.x - b.x)
    assert.equal(pair.length, 2, 'zwei Gesichter im Gespräch')
    const [L, R] = pair.map(({ mouth: [x1, y1, x2, y2] }) => { const w = Math.round(x2 - x1), h = Math.round(w / 2); return { x: Math.round(x1), y: Math.round((y1 + y2 - h) / 2), w, h } })
    const noise = (m: typeof L) => ['-f', 'lavfi', '-i', `color=gray:s=${m.w}x${m.h}:r=25,noise=alls=100:allf=t`]
    await runFfmpeg(['-loop', '1', '-i', jpg, ...noise(R), ...noise(L), '-t', '9', '-filter_complex',
      `[0]${crop}[v];[v][1]overlay=${R.x}:${R.y}:enable='between(t,2,4)'[w];[w][2]overlay=${L.x}:${L.y}:enable='between(t,5,7)'`, ...enc, talk])
    t0 = Date.now()
    const who = await speakerFaces(talk, [{ start: 2, end: 4, speaker: 0 }, { start: 5, end: 7, speaker: 1 }], await probe(talk))
    console.log(`speakerFaces: ${Date.now() - t0} ms`, who)
    assert.ok(who.get(0)! > 0.5, 'Sprecher 0 rechts')
    assert.ok(who.get(1)! < 0.5, 'Sprecher 1 links')
    assert.equal((await speakerFaces(black, [{ start: 0, end: 2, speaker: 0 }], binfo)).size, 0, 'ohne Gesicht fehlt der Sprecher')

    console.log('check-faces ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
