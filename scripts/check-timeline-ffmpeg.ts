// Pro-Timeline ffmpeg-Argumente: npx esbuild scripts/check-timeline-ffmpeg.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-timeline-ffmpeg.mjs && node ${TMPDIR:-/tmp}/check-timeline-ffmpeg.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DELIVER, type Deliver, type TimelineContent } from '../src/shared/timeline'
import { audioArgs, audioCodec, encodeArgs, estimate, keyExpr, sections, size, videoArgs } from '../src/main/timeline-ffmpeg'
import { ffmpegBin, probe, run } from '../src/main/ffmpeg'
import { satFilter } from '../src/shared/grade'

assert.deepEqual(size({ res: 1080 }, 16 / 9), { w: 1920, h: 1080 })
assert.deepEqual(size({ res: 1080 }, 9 / 16), { w: 1080, h: 1920 })
assert.deepEqual(size({ res: 720 }, 1), { w: 720, h: 720 })

const dir = await mkdtemp(join(tmpdir(), "tl ff'"))
const vid = join(dir, 'testsrc.mp4'), sine = join(dir, 'sine.wav'), logo = join(dir, 'logo.png')
// V1 voll 0–2 (stumm), V2 Bild-in-Bild 0,5–1 mit speed 2, A1 Sinus 0–2 mit Keys, ausgeblendete V3 und stumme A2 fallen weg
const tl: TimelineContent = { tracks: [
  { id: 'v1', kind: 'video', clips: [{ id: 'c1', src: vid, at: 0, in: 0, out: 2, mute: true, focus: 0.3 }] },
  { id: 'v2', kind: 'video', clips: [{ id: 'c2', src: vid, at: 0.5, in: 0.5, out: 1.5, speed: 2, fit: 'contain', box: [0.6, 0.6, 0.3], grade: { sat: 0.5 } }] },
  { id: 'v3', kind: 'video', hide: true, mute: true, clips: [{ id: 'c3', src: vid, at: 0, in: 0, out: 2 }] },
  { id: 'a1', kind: 'audio', volume: 0.5, clips: [{ id: 'c4', src: sine, at: 0, in: 0, out: 2, keys: [[0.5, 0], [1.5, -20]], eq: { low: 3, high: -2 } }] },
  { id: 'a2', kind: 'audio', mute: true, clips: [{ id: 'c5', src: sine, at: 0, in: 0, out: 2 }] },
  { id: 'v4', kind: 'video', clips: [{ id: 'c6', src: logo, at: 1, in: 0, out: 1, box: [0.05, 0.05, 0.2] }] }, // Standbild: kein Ton
] }
const secs = sections(tl)
const ids = (xs: { clip: { id: string } }[]) => xs.map((x) => x.clip.id)
assert.deepEqual(secs.map((s) => [s.start, s.end]), [[0, 0.5], [0.5, 1], [1, 2]])
assert.deepEqual(secs.map((s) => ids(s.video)), [['c1'], ['c1', 'c2'], ['c1', 'c6']])
assert.deepEqual(secs.map((s) => ids(s.audio)), [['c4'], ['c2', 'c4'], ['c4']])
assert.equal(secs[1].video[1].src, 0.5)
assert.equal(secs[2].video[0].src, 1)

// keyExpr mit kleiner JS-Auswertung: Keys bei Quelle 0,5 s (0 dB) und 1,5 s (−20 dB); im Abschnitt ab 1 s ist t = Timeline − 1
const evalExpr = (e: string, t: number) => new Function('t', 'pow', 'max', 'lt', 'if_', `return ${e.replace(/\\,/g, ',').replace(/\bif\(/g, 'if_(')}`)(t, Math.pow, Math.max, (a: number, b: number) => +(a < b), (c: number, a: number, b: number) => (c ? a : b))
const c4 = tl.tracks[3].clips[0], db = (t: number) => 20 * Math.log10(evalExpr(keyExpr(c4.keys!, c4, 1), t))
assert.ok(!/[^\\],/.test(keyExpr(c4.keys!, c4, 1)), 'Kommas escapt')
for (const [t, want] of [[-1, 0], [-0.5, 0], [0, -10], [0.5, -20], [1, -20]]) assert.ok(Math.abs(db(t) - want) < 1e-6, `keyExpr t=${t}: ${db(t)} statt ${want}`)
const fast = { at: 2, in: 0, speed: 2 } // Quelle 0→2 s Timeline, 2→3 s
assert.ok(Math.abs(20 * Math.log10(evalExpr(keyExpr([[0, 0], [2, -12]], fast, 2), 0.5)) + 6) < 1e-6)

const deliver: Deliver = { ...DELIVER, res: 720, fps: 29.97 }
const lut = join(dir, 'lut.cube')
await writeFile(lut, 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n')
const va = videoArgs(secs[1], deliver, 16 / 9, (c) => (c.id === 'c2' ? lut : null), (s) => (s === undefined ? null : `hue=s=${s}`))
const graph = va[va.indexOf('-filter_complex') + 1]
assert.ok(graph.includes('fps=30000/1001') && va.some((a) => a.includes('r=30000/1001')), 'fpsArg in den Argumenten')
assert.ok(graph.includes('setpts=(PTS-STARTPTS)/2') && graph.includes('hue=s=0.5') && graph.includes('format=rgb24,lut1d=file=') && graph.endsWith('[vout]'))
assert.deepEqual(va.slice(0, 6), ['-ss', '0.5', '-t', '0.5', '-i', vid])
assert.deepEqual(va.slice(6, 12), ['-ss', '0.5', '-t', '1', '-i', vid])
const aa = audioArgs(secs[1])
assert.ok(aa.join(' ').includes('volume=0.5') && aa.join(' ').includes('lowshelf=f=100:g=3') && aa.join(' ').includes('amix=inputs=2:normalize=0'))
assert.ok(!aa.join(' ').includes('equalizer'))
assert.deepEqual(encodeArgs({ ...deliver, codec: 'prores' }).ext, 'mov')
assert.deepEqual(audioCodec({ ...deliver, codec: 'dnxhr' }), ['-c:a', 'pcm_s24le'])
assert.ok(encodeArgs(deliver).args.join(' ').includes('-r 30000/1001'))
const pr = videoArgs(secs[1], { ...deliver, codec: 'prores' }, 16 / 9, () => lut, satFilter), prg = pr[pr.indexOf('-filter_complex') + 1]
assert.ok(pr.some((a) => a.endsWith(',format=yuv422p10le')) && prg.includes('format=gbrp10le,lut1d') && prg.includes(':format=yuv422p10[vout]'), '10 bit bei prores')
assert.ok(!graph.includes(':format='), 'h264 ohne overlay-format')
const img = videoArgs(secs[2], deliver, 16 / 9, () => null, () => null)
assert.deepEqual(img.slice(6, 14), ['-loop', '1', '-framerate', '30000/1001', '-t', '1', '-i', logo])
assert.ok(Math.abs(20 * Math.log10(evalExpr(keyExpr([[0, -100], [1, 0]], { at: 0, in: 0 }, 0), 0)) + 60) < 1e-6, 'dB auf TL.db geklemmt')
assert.ok(estimate(tl, DELIVER) > 0)

// Echt mit ffmpeg, falls erreichbar: jeder Abschnitt hat die geplante Länge (±1 Bild)
let bin: string | null = null
try { bin = await ffmpegBin() } catch (e) { console.warn('check-timeline-ffmpeg: ffmpeg fehlt, echter Lauf übersprungen:', (e as Error).message) }
if (bin) {
  const ff = async (args: string[]) => { const r = await run(bin!, ['-hide_banner', '-nostdin', '-y', ...args]); assert.equal(r.code, 0, r.err.slice(-2000)) }
  await ff(['-f', 'lavfi', '-i', 'testsrc=d=2:s=640x360:r=30', '-pix_fmt', 'yuv420p', vid])
  await ff(['-f', 'lavfi', '-i', 'sine=f=440:d=2', sine])
  await ff(['-f', 'lavfi', '-i', 'testsrc=s=200x200', '-frames:v', '1', logo])
  // eine Datei mit Ton für den nicht stummen Bild-in-Bild-Clip c2
  await ff(['-f', 'lavfi', '-i', 'testsrc=d=2:s=640x360:r=30', '-f', 'lavfi', '-i', 'sine=f=220:d=2', '-pix_fmt', 'yuv420p', '-shortest', join(dir, 'av.mp4')])
  tl.tracks[1].clips[0].src = join(dir, 'av.mp4')
  const fr = 1001 / 30000
  // Dauer aus `ffmpeg -i` (wie probe, das aber eine Videospur verlangt); ffmpeg-static hat kein ffprobe
  const dur = async (f: string) => { const [, h, m, x] = /Duration: (\d+):(\d+):([\d.]+)/.exec((await run(bin!, ['-hide_banner', '-i', f])).err)!; return +h * 3600 + +m * 60 + +x }
  for (const [k, s] of sections(tl).entries()) {
    const out = join(dir, `v${k}.${encodeArgs(deliver).ext}`), aout = join(dir, `a${k}.wav`)
    await ff([...videoArgs(s, deliver, 16 / 9, (c) => (c.id === 'c2' ? lut : null), satFilter), ...encodeArgs(deliver).args, out])
    await ff([...audioArgs(s), '-c:a', 'pcm_s16le', aout])
    const v = await probe(out), a = { duration: await dur(aout) }, len = s.end - s.start
    assert.ok(Math.abs(v.duration - len) <= fr + 0.011, `Video ${k}: ${v.duration} statt ${len}`)
    assert.ok(Math.abs(a.duration - len) <= fr + 0.011, `Ton ${k}: ${a.duration} statt ${len}`)
    assert.deepEqual([v.w, v.h], [1280, 720])
  }
  // prores 10 bit läuft durch und bleibt 10 bit
  const pro = join(dir, 'pro.mov'), pd = { ...deliver, codec: 'prores' as const }
  await ff([...videoArgs(sections(tl)[1], pd, 16 / 9, () => lut, satFilter), ...encodeArgs(pd).args, pro])
  assert.match((await run(bin, ['-hide_banner', '-i', pro])).err, /yuv422p10le/)
  const silent = join(dir, 'still.wav')
  await ff([...audioArgs({ start: 0, end: 0.7, video: [], audio: [] }), '-c:a', 'pcm_s16le', silent])
  assert.ok(Math.abs((await dur(silent)) - 0.7) < 0.02)
}
await rm(dir, { recursive: true, force: true })
console.log('check-timeline-ffmpeg: ok')
