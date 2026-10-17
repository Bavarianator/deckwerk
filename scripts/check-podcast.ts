// Podcast-Export unter Node (Graph, mp3/m4a, Lautheit, Kapitel, Soundeffekte, Wellenform, Clip-sfx): npx esbuild scripts/check-podcast.ts --bundle --platform=node --format=esm --external:./render --external:./export-pptx --external:electron --outfile=$HOME/.cache/deckwerk-e2e/podcast/check-podcast.mjs && DECKWERK_HOME=$HOME/.cache/deckwerk-e2e/podcast/home node $HOME/.cache/deckwerk-e2e/podcast/check-podcast.mjs
// Testmaterial per ffmpeg lavfi unter ~/.cache/deckwerk-e2e/podcast (nicht /tmp: tmpfs).
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Deck } from '../src/shared/deck'
import { editedLength, type Episode } from '../src/shared/podcast'
import { encodeClip } from '../src/main/export-video'
import { ffmpegBin, probe, run, runFfmpeg } from '../src/main/ffmpeg'
import { buildGraph, peaks, previewMix, renderEpisode } from '../src/main/podcast'

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} statt ${b} ± ${tol}`)
const gen = (out: string, lavfi: string, af = 'anull') => runFfmpeg(['-f', 'lavfi', '-i', lavfi, '-af', af, '-ar', '48000', '-ac', '2', out])
const err = async (args: string[]) => (await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', ...args])).err
const lufs = async (f: string) => Number([...(await err(['-i', f, '-af', 'ebur128', '-f', 'null', '-'])).matchAll(/I:\s+(-?[\d.]+) LUFS/g)].pop()?.[1])
// Pegel (dB) des Pieps (2 kHz, Bandpass) zwischen a und b Sekunden
async function beep(f: string, a: number, b: number) {
  const { out } = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-ss', String(a), '-t', String(b - a), '-i', f, '-af', 'bandpass=f=2000:width_type=q:w=8', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'])
  const x = new Float32Array(out.buffer, out.byteOffset, out.length >> 2)
  return 10 * Math.log10(x.reduce((q, v) => q + v * v, 0) / Math.max(1, x.length) + 1e-12)
}

async function main() {
  const dir = join(homedir(), '.cache', 'deckwerk-e2e', 'podcast')
  mkdirSync(dir, { recursive: true })
  console.log('ffmpeg:', await ffmpegBin())
  const [a, b, piep, intro, musik] = ['a.wav', 'b.wav', 'piep.wav', 'intro.wav', 'musik.wav'].map((f) => join(dir, f))
  // „Sprache“: 3 s Ton, 1 s Stille (A) bzw. versetzt (B)
  await gen(a, 'sine=f=200:d=20', "volume='if(lt(mod(t,4),3),0.5,0)':eval=frame")
  await gen(b, 'sine=f=300:d=20', "volume='if(lt(mod(t+2,4),3),0.3,0)':eval=frame")
  await gen(piep, 'sine=f=2000:d=0.3', 'volume=0.5')
  await gen(intro, 'sine=f=600:d=2', 'volume=0.3')
  await gen(musik, 'sine=f=440:d=5', 'volume=0.2')

  const info = await probe(a)
  assert.equal(info.w, 0, 'probe .wav: w = 0')
  assert.equal(info.h, 0, 'probe .wav: h = 0')
  assert.ok(info.audio, 'probe .wav: Ton')
  near(info.duration, 20, 0.05, 'probe .wav: Länge')
  console.log('  probe Audio ok')

  const ep: Episode = {
    duration: 20, tracks: [{ src: a }, { src: b, gain: -3 }, { src: a, mute: true }],
    cuts: [{ start: 3, end: 4 }, { start: 7, end: 8 }, { start: 15, end: 16.5 }],
    sfx: [{ src: piep, at: 10 }], intro, chapters: [{ at: 0, title: 'Anfang' }, { at: 7.5, title: 'Mitte; zwei=drei' }],
  }
  const len = editedLength(ep.cuts, ep.duration) // 16,5
  // Graph: Eingänge in Reihenfolge Spuren (ohne stumme), Intro, sfx; Musik danach
  {
    const g = buildGraph(ep, { introDur: 2, music: { volume: 0.25 } })
    assert.deepEqual(g.inputs, [a, b, intro, piep], 'Eingänge')
    assert.match(g.graph, /amix=inputs=2:normalize=0:duration=longest\[mix\]/, 'Spuren gemischt')
    assert.match(g.graph, /volume=-3dB\[tr1\]/, 'gain')
    assert.match(g.graph, /\[mix\]asplit=2\[g0\]\[g1\];\n\[g0\]atrim=start=0.000:end=7.000,asplit=2\[k0\]\[k1\]/, '4 Bereiche in 2 Fenstern')
    assert.equal((g.graph.match(/afade=t=in:d=0.01/g) ?? []).length, 3, 'Blende an jeder Naht (ein)')
    assert.match(g.graph, /afftdn=nr=12/, 'klar ist Standard')
    assert.match(g.graph, /\[2:a\].*\[intro\];\[intro\]\[sp\]acrossfade=d=1\[wi\]/, 'Intro überblendet')
    assert.match(g.graph, /adelay=9000\|9000/, 'Piep bei toEdited(10) + 1 = 9 s')
    assert.match(g.graph, /\[4:a\]aformat.*sidechaincompress/, 'Musik als Eingang 4')
    assert.match(g.graph, /\[pre\]$/, 'endet mit [pre]')
    assert.match(buildGraph({ ...ep, ton: 'stark' }, { introDur: 2 }).graph, /afftdn=nr=20/, 'stark')
    assert.doesNotMatch(buildGraph({ ...ep, ton: 'original' }, { introDur: 2 }).graph, /afftdn/, 'original')
    assert.throws(() => buildGraph(ep, {}), /Intro ohne Länge/)
    assert.throws(() => buildGraph({ ...ep, tracks: [{ src: a, mute: true }] }, { introDur: 2 }), /stumm/)
    const inCutFx = buildGraph({ ...ep, sfx: [{ src: piep, at: 3.5 }, { src: piep, at: 10 }] }, { introDur: 2 })
    assert.deepEqual(inCutFx.inputs, [a, b, intro, piep], 'sfx im Schnitt fällt weg')
    assert.equal((inCutFx.graph.match(/adelay=/g) ?? []).length, 1, 'nur ein sfx gemischt')
    const rand = buildGraph({ duration: 20, tracks: [{ src: a }], cuts: [{ start: 0, end: 1 }, { start: 19, end: 20 }] }, {}).graph
    assert.match(rand, /atrim=start=1\.000:end=19\.000,asetpts=PTS-STARTPTS,afade=t=in:d=0\.01,afade=t=out:st=17\.990:d=0\.01\[s0\]/, 'Blende auch am Rand, wenn dort geschnitten')
    const many = buildGraph({ duration: 15000, tracks: [{ src: a }], cuts: Array.from({ length: 5000 }, (_, i) => ({ start: i * 3 + 1, end: i * 3 + 1.5 })) }, {})
    assert.ok(many.graph.length > 128 * 1024, `5000 Schnitte: Graph ${many.graph.length} Zeichen, gehört in eine Datei`)
    console.log('  buildGraph ok')
  }

  const deck = { title: 'Test-Folge', slides: [], podcast: ep, music: { src: musik, volume: 0.2 } } as unknown as Deck
  for (const format of ['mp3', 'm4a'] as const) {
    const base = join(dir, `folge-${format}`)
    let last = -1
    const files = await renderEpisode(format === 'mp3' ? deck : { ...deck, music: undefined }, format, base, (p) => { assert.ok(p >= last); last = p })
    assert.deepEqual(files, [`${base}.${format}`, `${base}.chapters.json`], 'Pfade')
    assert.equal(last, 100, 'Fortschritt bis 100')
    near((await probe(files[0])).duration, 2 - 1 + len, 0.1, `${format}: Länge`)
    near(await lufs(files[0]), -16, 1, `${format}: Lautheit`)
    const e = await err(['-i', files[0]])
    assert.match(e, /Chapter #0:1: start 7\.0+, end 17\.5/, `${format}: Kapitel 2 (in Schnitt → Schnittanfang 7 s)`)
    assert.match(e, /title\s+: Mitte; zwei=drei/, `${format}: Kapiteltitel`)
    assert.match(e, /title\s+: Test-Folge/, `${format}: Titel`)
    const ch = JSON.parse(readFileSync(files[1], 'utf8'))
    assert.deepEqual(ch, { version: '1.2.0', chapters: [{ startTime: 0, title: 'Anfang' }, { startTime: 7, title: 'Mitte; zwei=drei' }] }, 'chapters.json')
    const [on, off] = [await beep(files[0], 9.02, 9.28), await beep(files[0], 9.6, 9.9)]
    assert.ok(on - off > 15, `${format}: Piep bei 9 s (${on.toFixed(1)} dB gegen ${off.toFixed(1)} dB daneben)`)
    console.log(`  ${format} ok (Piep ${on.toFixed(1)} dB / ${off.toFixed(1)} dB, ${(await lufs(files[0])).toFixed(1)} LUFS)`)
  }
  // ohne Kapitel keine chapters.json; viele Schnitte (Graph in Datei)
  {
    const cuts = Array.from({ length: 300 }, (_, i) => ({ start: i * 0.06 + 0.02, end: i * 0.06 + 0.04 }))
    const files = await renderEpisode({ ...deck, music: undefined, podcast: { duration: 20, tracks: [{ src: a }], cuts, ton: 'original' } } as Deck, 'm4a', join(dir, 'viele'))
    assert.equal(files.length, 1, 'ohne Kapitel nur die Audiodatei')
    near((await probe(files[0])).duration, editedLength(cuts, 20), 0.1, '300 Schnitte: Länge')
    console.log('  300 Schnitte ok')
  }

  const pk = await peaks(a)
  assert.equal(pk.rate, 50)
  near(pk.data.length, 1000, 2, 'peaks: 50 Werte/s')
  near(pk.duration, 20, 0.05, 'peaks: Länge')
  assert.ok(pk.data[50] > 0.05 && pk.data[175] < 0.01, `peaks: Ton ${pk.data[50]}, Stille ${pk.data[175]}`)
  assert.deepEqual(await peaks(a), pk, 'peaks: Cache')
  console.log('  peaks ok')

  assert.equal(await previewMix({ ...deck, podcast: { ...ep, tracks: [{ src: a }, { src: b, mute: true }] } } as Deck), a, 'previewMix: eine Spur = Original')
  const mix = await previewMix(deck)
  assert.ok(mix.endsWith('.ogg') && existsSync(mix), 'previewMix: gemischt')
  near((await probe(mix)).duration, 20, 0.1, 'previewMix: ungeschnitten')
  console.log('  previewMix ok')

  // Clip mit Soundeffekt: at in Clipzeit
  {
    const src = join(dir, 'clip-src.mp4'), out = join(dir, 'clip.mp4')
    await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=5', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src])
    const job = { file: src, parts: [{ start: 0.5, end: 4.5 }], captions: 'aus' as const, transcript: null, size: { w: 320, h: 180 }, font: { name: 'Archivo', files: [], bold: true }, accent: '#FF8800', sfx: [{ file: piep, at: 2 }] }
    await encodeClip(job, out, dir)
    const [on, off] = [await beep(out, 2.02, 2.28), await beep(out, 1, 1.3)]
    assert.ok(on - off > 15, `Clip-sfx bei 2 s (${on.toFixed(1)} dB gegen ${off.toFixed(1)} dB)`)
    console.log('  Clip-sfx ok')
  }
  console.log('check-podcast ok')
}

main().catch((e) => { console.error(e); process.exit(1) })
