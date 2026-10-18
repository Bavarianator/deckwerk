// Pro-Timeline Medien (Wellenform, Proxy, R128): npx esbuild scripts/check-timeline-media.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-timeline-media.mjs && node ${TMPDIR:-/tmp}/check-timeline-media.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probe, runFfmpeg } from '../src/main/ffmpeg'
import { cachedPeaks, measureR128, needsProxy, peaks, proxy } from '../src/main/timeline-media'

const dir = await mkdtemp(join(tmpdir(), 'check-timeline-media-'))
try {
  // 1 kHz Sinus mit Spitze 0,1 = −20 dBFS, 3 s, danach 2 s Stille
  const tone = join(dir, 'tone.wav'), sine = join(dir, 'sine.wav')
  await runFfmpeg(['-f', 'lavfi', '-i', "aevalsrc='if(lt(t,3),0.1*sin(2*PI*1000*t),0)':s=48000:d=5", tone])
  await runFfmpeg(['-f', 'lavfi', '-i', "aevalsrc='0.1*sin(2*PI*1000*t)':s=48000:d=3", sine])

  const p = await peaks(tone)
  assert.ok(Math.abs(p.length - 500) <= 2, `peaks-Länge ${p.length}`)
  const loud = Math.min(...p.subarray(5, 295)), quiet = Math.max(...p.subarray(305))
  assert.ok(loud >= 24 && loud <= 27, `Sinus-Spitze ${loud} (0,1·255 ≈ 26)`)
  assert.equal(quiet, 0, 'Stille')

  // Zweiter Aufruf liest die Ablage: manipulierte Datei kommt zurück
  const cache = join(dir, 'cache')
  assert.deepEqual(await cachedPeaks(tone, cache), p)
  await writeFile(join(cache, 'peaks-100.u8'), Uint8Array.of(7, 7))
  assert.deepEqual([...(await cachedPeaks(tone, cache))], [7, 7])

  // Erwartung: Sinus-Effektivwert = Spitze − 3,01 dB = −23,01 dBFS; die K-Bewertung ist bei 1 kHz ≈ 0 dB, Mono zählt einfach → −23,0 LUFS
  const r = await measureR128(sine)
  assert.ok(Math.abs(r.i + 23) <= 1, `R128 ${r.i} LUFS`)
  assert.ok(Math.abs(r.offset) <= 1 && Math.abs(r.tp + 20) <= 1, JSON.stringify(r))

  assert.equal(needsProxy({ w: 1920, h: 1080 }), false)
  assert.equal(needsProxy({ w: 3840, h: 2160 }), true)
  assert.equal(needsProxy({ w: 1280, h: 720 }, 'prores (HQ)'), true)
  assert.equal(needsProxy({ w: 1920, h: 1080 }, 'hevc (Main 10), yuv420p10le'), true)
  assert.equal(needsProxy({ w: 1920, h: 1080 }, 'hevc (Main), yuv420p'), false)

  const src = join(dir, 'src.mp4'), out = join(dir, 'proxy.mp4')
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=s=1920x1080:d=2:r=25', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', src])
  const pct: number[] = []
  assert.equal(await proxy(src, out, (x) => pct.push(x)), out)
  const info = await probe(out)
  assert.equal(Math.min(info.w, info.h), 540)
  assert.equal(info.w, 960)
  assert.ok(info.audio && pct.length > 0)
  assert.ok(!existsSync(`${out}.${process.pid}.part`))
  assert.equal(await proxy(join(dir, 'fehlt.mp4'), out), out, 'vorhandener Proxy sofort zurück')

  console.log('check-timeline-media: ok')
} finally {
  await rm(dir, { recursive: true, force: true })
}
