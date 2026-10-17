// Film-Export in Electron (Stimme, Untertitel, Überblendung, Entdopplung, Vorschau-Frames, ausgeblendete Folie, Handy-Rückfall, Alt-Weg): npx electron-vite build && npx esbuild scripts/check-film-export.ts --bundle --platform=node --format=cjs --external:electron --external:onnxruntime-node --external:sherpa-onnx-node --loader:.md=text --log-level=warning --outfile=out/main/check-film-export.cjs && DECKWERK_HOME=${TMPDIR:-/tmp}/check-film-export ./node_modules/.bin/electron out/main/check-film-export.cjs --ozone-platform=x11
// Stimme aus $DW_MODELS (Standard ~/.cache/deckwerk-check/models/tts-de), per Symlink nach $DECKWERK_HOME/models; Bündel in out/main wegen ../renderer und sherpa-worker.js
// Handy: Standard „Handy aus“ (Einstellung im eigenen appData); DW_PHONE=1 kodiert auf dem per USB verbundenen Handy (ffmpeg dafür aus $DW_MODELS/android)
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { createEngine } from '../src/main/engine'
import { exportFilm, planScene } from '../src/main/export-film'
import { phoneFault, type Phone } from '../src/main/export-video'
import { phoneMarker } from '../src/main/phone'
import { closeHosts, renderFilm } from '../src/main/render'
import { synthesize } from '../src/main/voice'
import { visibleSlides, type Deck, type Item } from '../src/shared/deck'
import { voiceChunks } from '../src/shared/film'

const home = process.env.DECKWERK_HOME ?? join(process.env.TMPDIR ?? '/tmp', 'check-film-export')
const out = join(home, 'exports')
rmSync(out, { recursive: true, force: true })
mkdirSync(join(home, 'models'), { recursive: true })
const models = join(home, 'models'), cached = process.env.DW_MODELS ?? join(homedir(), '.cache/deckwerk-check/models')
for (const m of ['tts-de', 'android']) if (!existsSync(join(models, m)) && existsSync(join(cached, m))) symlinkSync(join(cached, m), join(models, m))
// Einstellung „Handy aus“ als Marker in einem eigenen appData, die echte Einstellung bleibt unberührt
const PHONE = !!process.env.DW_PHONE
app.setPath('appData', join(home, 'appdata'))
mkdirSync(join(home, 'appdata', 'deckwerk'), { recursive: true })
if (PHONE) rmSync(phoneMarker(app.getPath('appData')), { force: true })
else writeFileSync(phoneMarker(app.getPath('appData')), '')
// Untertitel-Schrift (subFont) liegt unter <App-Pfad>/assets/fonts; der App-Pfad ist hier out/main
if (!existsSync(join(app.getAppPath(), 'assets'))) symlinkSync(join(__dirname, '../../assets'), join(app.getAppPath(), 'assets'))

// Bildschirmaufnahme mit Ton für die screen-Szene: 6 s Testbild und Sinuston, im Film läuft der Ausschnitt 1–4 s
const rec = join(home, 'assets', 'aufnahme.mp4')
mkdirSync(join(home, 'assets'), { recursive: true })
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', rec])

const text = (id: string, t: string, x: number, y: number, extra: Partial<Item>): Item => ({ id, kind: 'text', text: t, x, y, w: 400, h: 120, size: 96, bold: true, color: '#FF00FF', ...extra })
const VOICE = 'Erste Szene. [klick] Jetzt kommt das Element.'
const deck: Deck = {
  title: 'Film-Export-Test', theme: { id: 'beratung' }, transition: 'none', mode: 'click', film: { voice: 'de', captions: 'satz' },
  // h0 ausgeblendet: s1 ist die erste Szene, ihr fade gilt nicht (kein Vorlauf); s3 nur Takt-Marker, ohne Stimme
  slides: [
    { id: 'h0', layout: 'statement', hidden: true, content: { text: 'Ausgeblendet' } },
    { id: 's1', layout: 'statement', build: 'fade', transition: 'fade', content: { text: 'Ein kurzer Satz' }, voice: VOICE, items: [text('pop', 'POP', 760, 420, { anim: 'pop', animStart: 'click' })] },
    { id: 's2', layout: 'big-number', build: 'zoom-kpi', transition: 'fade', tone: 'invert', content: { value: '1.234', label: 'Kunden im Quartal' }, voice: 'Zweite Szene.' },
    { id: 's3', layout: 'statement', content: { text: 'Ohne Stimme' }, voice: '[klick]' },
    // Bild bleibt hier leer (asset:// gibt es nur in der App, das Spulen prüft check-frames); geprüft werden Länge und Originalton
    { id: 's4', layout: 'screen', content: { video: rec, from: 1, to: 4, frame: 'ohne' } },
  ],
}

const ffprobe = (file: string, entries: string) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'default=nw=1', file]).toString()
const grayAt = (file: string, t: number) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'])
const grayPng = (png: Buffer) => execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { input: png })
const diff = (a: Buffer, b: Buffer) => a.reduce((n, v, k) => n + (Math.abs(v - b[k]) > 40 ? 1 : 0), 0) // geänderte Pixel
const top = (b: Buffer) => b.subarray(0, 320 * 140) // ohne die eingebrannten Untertitel
const volume = (file: string, from: number, len: number) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(len), '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).stderr.toString()
  const db = (k: string) => { const m = new RegExp(`${k}: (-?[\\d.]+|-inf) dB`).exec(r)?.[1]; return m === '-inf' ? -Infinity : Number(m) }
  return { mean: db('mean_volume'), max: db('max_volume') }
}
// Ton- und Bildspur gleich lang (Zwischenstände, Nähte, Endschritt)
const streamsEqual = (file: string) => {
  const d = [...ffprobe(file, 'stream=codec_type,duration').matchAll(/codec_type=(\w+)\nduration=([\d.]+)/g)].map((m) => [m[1], Number(m[2])] as const)
  const vd = d.find(([k]) => k === 'video')![1], ad = d.find(([k]) => k === 'audio')![1]
  assert.ok(Math.abs(vd - ad) <= 0.05, `${file}: Bild ${vd} s, Ton ${ad} s`)
}

async function main() {
  const engine = createEngine()

  // 1) Export zweimal zugleich (Knopf und KI): der zweite hängt sich an denselben Lauf
  const p1: number[] = [], p2: number[] = [], t0 = Date.now()
  const [a, b] = await Promise.all([engine.exportDeck(deck, 'mp4', out, undefined, (p) => p1.push(p)), engine.exportDeck(deck, 'mp4', out, undefined, (p) => p2.push(p))])
  const secs = (Date.now() - t0) / 1000
  assert.equal(a, b, 'zweiter Aufruf bekommt dasselbe Ergebnis (videoRuns)')
  assert.ok(p2.length > 0 && p2.at(-1) === 100 && p1.at(-1) === 100, `Fortschritt an beide: ${p1.at(-1)} / ${p2.at(-1)}`)
  assert.ok(p1.every((v, k) => !k || v >= p1[k - 1]), 'Fortschritt steigt')
  const mp4 = a[0]
  assert.ok(mp4.endsWith('.mp4') && existsSync(mp4), `MP4 fehlt: ${a}`)
  // wer rechnet: mit Handy kodiert es (kein Rückfall), sonst meldet device den ausgeschalteten Weg
  const who = await engine.video!.device!('export')
  assert.equal(phoneFault.reason, '', `Handy-Export gescheitert: ${phoneFault.reason}`)
  assert.match(who, PHONE ? /^Handy \(/ : /ausgeschaltet/, `wer rechnet: ${who}`)

  // 2) Dauer = Summe der geplanten Szenen − eine Überblendung (Szene 2 blendet, Szene 3 harter Schnitt)
  const vis = { ...deck, slides: visibleSlides(deck) }, durs: number[] = [], media: (number | undefined)[] = []
  for (const [i, sl] of vis.slides.entries()) {
    const voice = voiceChunks(sl.voice ?? '').flat().length ? await synthesize(sl.voice!, { voice: 'de', models: join(home, 'models'), cacheDir: join(home, 'assets', '.voice') }) : undefined // aus dem Cache des Exports
    await renderFilm(vis, i, { width: 640, plan: (scene) => { const p = planScene(vis, i, scene, voice?.timing); durs.push(Math.round(p.dur * 30) / 30); media.push(scene.media); return { beats: p.beats, times: [0] } } }, () => {})
  }
  // screen mit Video: die Szene läuft den ganzen Ausschnitt (3 s), nicht nur MIN_SCENE
  assert.ok(Math.abs((media[3] ?? 0) - 3) < 0.05 && durs[3] >= 2.95 && media[0] === undefined, `Videomaterial ${media[3]} s, Szene ${durs[3]} s`)
  const want = durs.reduce((s, d) => s + d, 0) - 0.5
  const got = Number(/duration=([\d.]+)/.exec(ffprobe(mp4, 'format=duration'))![1])
  assert.ok(Math.abs(got - want) <= 0.2, `Dauer ${got} s statt ${want.toFixed(2)} s (Szenen ${durs.map((d) => d.toFixed(2))})`)
  const v = ffprobe(mp4, 'stream=codec_type,width,height,r_frame_rate')
  assert.match(v, /width=1920\nheight=1080/)
  assert.match(v, /r_frame_rate=30\/1/)
  assert.match(v, /codec_type=audio/, 'Tonspur fehlt')
  streamsEqual(mp4)

  // 3) Stimme hörbar
  const vol = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', mp4, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).stderr.toString()
  const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(vol)?.[1])
  assert.ok(mean > -40, `mean_volume ${mean} dB`)
  // Szene 2 blendet ab durs[0] − 0,5 s über, ihre Stimme beginnt erst danach (Szene 1 ist da schon still: TAIL)
  const blend = volume(mp4, durs[0] - 0.45, 0.4), after = volume(mp4, durs[0] + 0.05, 1)
  assert.ok(blend.max < -50, `Ton während der Blende: max ${blend.max} dB`)
  assert.ok(after.max > -30, `Stimme von Szene 2 nach der Blende fehlt: max ${after.max} dB`)
  // Originalton der Aufnahme in der screen-Szene (harter Schnitt davor, ohne Stimme: Pegel 1)
  const s4 = durs[0] + durs[1] - 0.5 + durs[2], orig = volume(mp4, s4 + 0.3, 2)
  assert.ok(orig.mean > -35, `Originalton der Aufnahme fehlt: mean ${orig.mean} dB`)

  // Untertitel auf dunklem Kasten: die Zone unter „Erste Szene.“ ist auf der weißen Folie deutlich dunkler (Kontur allein: fast weiß)
  const g = grayAt(mp4, 0.5), zone: number[] = []
  for (let y = 157; y <= 167; y++) for (let x = 145; x <= 175; x++) zone.push(g[y * 320 + x])
  const zoneMean = zone.reduce((s, x) => s + x, 0) / zone.length
  assert.ok(zoneMean < 180, `Untertitel-Kasten fehlt: Grauwert ${zoneMean.toFixed(0)}`)

  // 4) SRT neben dem MP4
  const srtFile = mp4.replace(/\.mp4$/, '.srt')
  assert.ok(existsSync(srtFile) && readFileSync(srtFile, 'utf8').includes('Erste Szene'), 'SRT mit „Erste Szene“ fehlt')

  // 5) Zwei Zeitpunkte derselben Szene unterscheiden sich (Aufbau, Klick-Element); vor der Blende in Szene 2
  const d = diff(grayAt(mp4, 0.1), grayAt(mp4, durs[0] - 0.6))
  assert.ok(d > 300, `Szene 1 bei 0,1 s und am Ende fast gleich (${d} Pixel geändert)`)

  // 6) Vorschau-Frames mit derselben Zeitachse wie der Export, auch mit der ausgeblendeten Folie davor (Index im vollen Deck).
  // Vergleich bei 0,3 s: dort ist der Aufbau schon deutlich zu sehen, ein falscher Vorlauf (0,5 s) fiele auf
  const frames = await engine.renderFrames!(deck, 1, [0, 0.3, 1.5], 1920)
  assert.equal(frames.length, 3)
  assert.ok(frames.every((f) => f.png.subarray(1, 4).toString() === 'PNG'), 'PNG erwartet')
  assert.deepEqual(frames.map((f) => f.t), [0, 0.3, 1.5])
  assert.ok(!frames[0].png.equals(frames[2].png), 'Frames bei 0 und 1,5 s gleich')
  const ref = diff(top(grayAt(mp4, 0)), top(grayAt(mp4, 0.3))), same = diff(top(grayPng(frames[1].png)), top(grayAt(mp4, 0.3)))
  assert.ok(ref > 100 && same < ref / 4, `Vorschau bei 0,3 s weicht vom Export ab: ${same} Pixel (Aufbau 0–0,3 s: ${ref})`)
  assert.equal((await engine.renderFrames!(deck, 3, [0])).length, 1, 'Szene nur mit [klick]')

  // 7) Gegenprobe: Deck ohne film läuft über den alten Weg (Standbild STILL = 3 s)
  const old = await engine.exportDeck({ ...deck, title: 'Alt-Weg', film: undefined, slides: [deck.slides[3]] }, 'mp4', out)
  const oldDur = Number(/duration=([\d.]+)/.exec(ffprobe(old[0], 'format=duration'))![1])
  assert.ok(Math.abs(oldDur - 3) <= 0.1, `Alt-Weg: ${oldDur} s statt 3 s`)
  streamsEqual(old[0])
  await assert.rejects(engine.exportDeck(deck, 'clips', out), /Format mp4/)
  // 8) Handy nicht erreichbar (falscher serial): der PC kodiert weiter, der Grund steht in phoneFault
  const phone: Phone = { serial: 'FALSCH', models }, one = { ...vis, title: 'Rueckfall', slides: [vis.slides[2]] }
  const voiceOf = async () => undefined
  const [back] = await exportFilm(one, join(out, 'rueckfall'), { voiceOf, phone })
  const backDur = Number(/duration=([\d.]+)/.exec(ffprobe(back, 'format=duration'))![1])
  const reason: string = phoneFault.reason
  assert.ok(phone.failed && reason, `Rückfall nicht gemeldet: ${reason}`)
  assert.ok(Math.abs(backDur - durs[2]) <= 0.1, `Rückfall: ${backDur} s statt ${durs[2]} s`)
  streamsEqual(back)
  const left = readdirSync(out).filter((f) => f.startsWith('.video-tmp-'))
  assert.deepEqual(left, [], 'Job-Ordner übrig')

  console.log(`film-export ok – ${got.toFixed(2)} s (Plan ${want.toFixed(2)} s, Szenen ${durs.map((x) => x.toFixed(2)).join(' + ')} − 0,5), Pegel ${mean} dB, Export ${secs.toFixed(1)} s (${who}), Rückfall: ${reason.slice(0, 60)}, Szene 1 Anfang/Ende ${d} Pixel verschieden, Vorschau/Export ${same} Pixel (Aufbau ${ref}), Blende max ${blend.max} dB, Aufnahme ${orig.mean} dB, Kasten ${zoneMean.toFixed(0)}`)
}

app.whenReady().then(main).then(() => { closeHosts(); app.exit(0) }, (e) => { console.error(e); closeHosts(); app.exit(1) })
