// Gesichter für den Zuschnitt (YuNet), opt-in mit DW_NET=1 (lädt Modell 230 KB und Testbild 1,1 MB, braucht ffmpeg): npx esbuild scripts/check-faces.ts --bundle --platform=node --format=esm --external:onnxruntime-node --outfile=node_modules/.cache/check-faces.mjs && DW_NET=1 DECKWERK_HOME=${TMPDIR:-/tmp}/check-faces-home node node_modules/.cache/check-faces.mjs
// Bündel unter node_modules/.cache, damit node das externe onnxruntime-node findet.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { download } from '../src/main/download'
import { autoFocus, detect, faceX, speakerFaces } from '../src/main/faces'
import { probe, rawFrames, runFfmpeg } from '../src/main/ffmpeg'

// Beispielbild aus opencv_zoo (MIT), fester Commit + Prüfsumme; eine Menschenmenge, das größte Gesicht liegt bei x ≈ 0,59
const SELFIE = 'https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/example_outputs/largest_selfie.jpg'
const SELFIE_SHA256 = 'ab8413ad9bb4f53068f4fb63c6747e5989991dd02241c923d5595b614ecf2bf6'
const enc = ['-r', '25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']

async function main() {
  if (process.env.DW_NET !== '1') return console.log('check-faces: übersprungen (DW_NET=1 lädt Modell und Testbild)')
  const base = process.env.TMPDIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'check-faces-'))
  try {
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
