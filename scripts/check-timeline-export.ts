// Pro-Timeline Export: npx esbuild scripts/check-timeline-export.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-timeline-export.mjs && node ${TMPDIR:-/tmp}/check-timeline-export.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportTimeline } from '../src/main/export-timeline'
import { ffmpegBin, probe, run, runFfmpeg } from '../src/main/ffmpeg'
import { measureR128 } from '../src/main/timeline-media'
import { gradeTables } from '../src/shared/grade'
import { tlDuration, type Codec, type TimelineContent } from '../src/shared/timeline'

const dir = await mkdtemp(join(tmpdir(), 'check-timeline-export-'))
try {
  const bunt = join(dir, 'bunt.mp4'), grau = join(dir, 'grau.mp4'), ton = join(dir, 'ton.wav')
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=s=320x180:d=2:r=25', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', bunt])
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=0x606060:s=320x180:d=2:r=25', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', grau]) // ohne Ton
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=f=1000:d=2:sample_rate=48000', ton])
  const gain = 1.5
  const tl = (codec: Codec): TimelineContent => ({
    deliver: { res: 720, fps: 25, codec, lufs: -16 },
    tracks: [
      { id: 'v1', kind: 'video', clips: [{ id: 'c1', src: 'grau.mp4', at: 0, in: 0, out: 1, grade: { gain: [gain, gain, gain] } }, { id: 'c2', src: 'bunt.mp4', at: 1, in: 0, out: 2, speed: 2 }] },
      { id: 'v2', kind: 'video', clips: [{ id: 'c3', src: 'bunt.mp4', at: 0.4, in: 0, out: 1, box: [0.6, 0.6, 0.3] }] },
      { id: 'a1', kind: 'audio', clips: [{ id: 'c4', src: 'ton.wav', at: 0, in: 0, out: 2, eq: { low: 3, high: -3 }, keys: [[0, -6], [2, 0]] }] },
    ],
    overlays: [{ start: 0, end: 1, text: 'Hallo' } as never],
    subs: [{ start: 0, end: 1, text: 'Hallo' }],
  })
  const encoders = (await run(await ffmpegBin(), ['-hide_banner', '-encoders'])).out.toString()
  // Erwartung für das gegradete Grau oben links (außerhalb der Box), nach gradeTables
  const want = gradeTables({ gain: [gain, gain, gain] })[0][0x60]
  for (const codec of ['h264', 'prores'] as const) {
    if (codec === 'prores' && !/\sprores_ks\s/.test(encoders)) { console.log('check-timeline-export: prores übersprungen (prores_ks fehlt)'); continue }
    const t = tl(codec), out = join(dir, `out-${codec}`), steps: number[] = []
    const r = await exportTimeline(t, { out, aspect: 16 / 9, resolve: (s) => join(dir, s), work: join(dir, `work-${codec}`), onProgress: (f) => steps.push(f) })
    const file = `${out}.${codec === 'h264' ? 'mp4' : 'mov'}`
    assert.deepEqual(r.files, [file, `${out}.xml`, `${out}.srt`])
    assert.ok(r.files.every((f) => existsSync(f)), 'Dateien da')
    assert.ok(!existsSync(join(dir, `work-${codec}`)), 'work aufgeräumt')
    assert.ok(r.warnings.some((w) => /Stufe 2/.test(w)))
    assert.ok(steps.at(-1) === 1 && steps.every((f, i) => f >= 0 && f <= 1 && (!i || f >= steps[i - 1] - 1e-9)), `Fortschritt ${steps}`)
    const info = await probe(file)
    assert.ok(info.audio && info.w === 1280 && info.h === 720, JSON.stringify(info))
    assert.ok(Math.abs(info.duration - tlDuration(t)) <= 1 / 25 + 1e-3, `Dauer ${info.duration}`)
    const lufs = (await measureR128(file)).i
    assert.ok(Math.abs(lufs - -16) <= 1 && Math.abs(r.lufs.after - -16) <= 1, `LUFS ${lufs} (${JSON.stringify(r.lufs)})`)
    const px = (await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-ss', '0.2', '-i', file, '-frames:v', '1', '-vf', 'crop=320:180:0:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])).out
    assert.equal(px.length, 320 * 180 * 3)
    const mean = px.reduce((s, v) => s + v, 0) / px.length
    assert.ok(Math.abs(mean - want) <= 6, `Bildmittel ${mean.toFixed(1)}, erwartet ${want}`)
    console.log(`${codec}: Dauer ${info.duration} s, LUFS vorher ${r.lufs.before} nachher ${r.lufs.after} Datei ${lufs}, Grau ${mean.toFixed(1)} (soll ${want})`)
  }
  console.log('check-timeline-export: ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
