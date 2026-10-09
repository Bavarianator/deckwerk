// sherpa-onnx lokal, opt-in mit DW_NET=1 (lädt einmalig ~710 MB nach $DECKWERK_HOME/models bzw. ~/.cache/deckwerk-check/models, braucht ffmpeg): npx esbuild scripts/check-sherpa.ts --bundle --packages=external --platform=node --format=esm --outfile=node_modules/.cache/check-sherpa.mjs && npx esbuild src/main/sherpa-worker.ts --bundle --packages=external --platform=node --format=cjs --outfile=node_modules/.cache/sherpa-worker.cjs && DW_NET=1 node node_modules/.cache/check-sherpa.mjs
import { deepStrictEqual, ok } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asr, diarize, ensureModels, stopWorker, tag } from '../src/main/sherpa'
import { sentences } from '../src/main/sherpa-worker'
import { MUSIC } from '../src/shared/clip-lint'
import type { Segment } from '../src/shared/video'

// Satztrennung offline: Punkt nach Abkürzung oder Ordinalzahl beendet keinen Satz
const satz = (s: string) => sentences(s.split(' ').map((w, i) => ({ w, start: i, end: i + 0.5 }))).map((x) => x.text)
deepStrictEqual(satz('Wir treffen uns am 3. Oktober mit Dr. Meier, z. B. um ca. 10 Uhr bzw. später. Das war 2024. Nr. 5 kommt z.B. auch, d. h. i. d. R. am 1. und 2. Mai. Wir waren 25. Es gilt Plan B. Nimm Vitamin C. He lives in the U.S. Auf diese Art. Gut!'),
  ['Wir treffen uns am 3. Oktober mit Dr. Meier, z. B. um ca. 10 Uhr bzw. später.', 'Das war 2024.', 'Nr. 5 kommt z.B. auch, d. h. i. d. R. am 1. und 2. Mai.', 'Wir waren 25.', 'Es gilt Plan B.', 'Nimm Vitamin C.', 'He lives in the U.S.', 'Auf diese Art.', 'Gut!'])

if (process.env.DW_NET !== '1') { console.log('check-sherpa: übersprungen (DW_NET=1 lädt Modelle und Samples)'); process.exit(0) }
process.env.DECKWERK_SHERPA_WORKER ??= fileURLToPath(new URL('./sherpa-worker.cjs', import.meta.url)) // Worker-Bündel daneben

const models = join(process.env.DECKWERK_HOME ?? join(homedir(), '.cache', 'deckwerk-check'), 'models') // nicht /tmp: dort oft tmpfs im RAM
// Englisch: JFK aus whisper.cpp (gemeinfrei). Deutsch: „Gesprochene Definition freier Software“, Wikimedia Commons, CC BY-SA 3.0 de.
const JFK = ['https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav', '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e']
const FREI = ['https://upload.wikimedia.org/wikipedia/commons/6/61/Gesprochene_Definition_freier_Software.ogg', '57f8101daf8e401935601f56f1bc8b5917e51ba7fdffa73c13f33ca6dec377d8']
// Lachen: PLOS ONE 10.1371/journal.pone.0063441 S12 (CC BY 2.5, Stille bis 2 s). Applaus: „Applause i“ (gemeinfrei, abklingend ab 8 s).
const LACHEN = ['https://upload.wikimedia.org/wikipedia/commons/8/82/Different-Types-of-Laughter-Modulate-Connectivity-within-Distinct-Parts-of-the-Laughter-Perception-pone.0063441.s012.oga', '354a5d6eef42255114641bdf6a23f9f204723405b73db368e9c4b025f3d3bd94']
const APPLAUS = ['https://upload.wikimedia.org/wikipedia/commons/5/5b/Applause_i.ogg', '1029a5b6f301b063964d8cd1755cbc53238fdb548953de9e64a555cc9b90f7c1']
// Musik: Kevin MacLeod „Stratosphere“ (incompetech.com), Wikimedia Commons, CC BY 3.0 US; elektronisch, durchgehend ohne Pause
const MUSIK = ['https://upload.wikimedia.org/wikipedia/commons/7/76/Stratosphere%2C_%28MacLeod%2C_Kevin%29.oga', '6f693a53f02089a58e742945f276c752d2426e293b38436efd0d76acc0440290']

/** Sample laden, Prüfsumme prüfen, per ffmpeg → 16 kHz mono f32 (höchstens secs Sekunden). */
async function sample([url, sha]: string[], secs: number): Promise<Float32Array> {
  const res = await fetch(url, { headers: { 'user-agent': 'deckwerk-check/1.0' } })
  ok(res.ok, `Sample-Download fehlgeschlagen (${res.status}): ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  ok(createHash('sha256').update(buf).digest('hex') === sha, `Prüfsumme falsch: ${url}`)
  const ff = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-t', String(secs), '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], { input: buf, maxBuffer: 1 << 28 })
  ok(ff.status === 0, `ffmpeg: ${ff.stderr}`)
  return new Float32Array(ff.stdout.buffer, ff.stdout.byteOffset, ff.stdout.length / 4)
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-zäöüß ]+/g, '').replace(/\s+/g, ' ')
const kid = () => { const f = `/proc/self/task/${process.pid}/children`; return existsSync(f) ? readFileSync(f, 'utf8').trim().split(/\s+/).at(-1) : '' }
const worker = () => { // Spitzen-RSS (GB) und CPU-Zeit (s) des Worker-Kindprozesses, nur Linux
  const pid = kid()
  if (!pid) return { peak: NaN, cpu: NaN }
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ') // utime, stime: Felder 14, 15
  return { peak: Number(/VmHWM:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1]) / 1024 ** 2, cpu: (Number(stat[11]) + Number(stat[12])) / 100 }
}

async function run(pcm: Float32Array, label: string, offset = 0, fresh = false) {
  const pct: number[] = []
  const t0 = performance.now(), cpu0 = fresh ? 0 : worker().cpu // fresh: Worker startet erst in asr() (inkl. Modell laden)
  const segs: Segment[] = await asr(pcm, { models, offset, onProgress: (p) => pct.push(p) })
  const secs = (performance.now() - t0) / 1000, dur = pcm.length / 16000, { peak, cpu } = worker()
  ok(pct.at(-1) === 100 && pct.every((p, i) => !i || p > pct[i - 1]), `Fortschritt nicht monoton bis 100: ${pct}`)
  const words = segs.flatMap((s) => s.words ?? [])
  ok(segs.every((s) => s.text && s.words?.length && s.start === s.words[0].start && s.end === s.words.at(-1)!.end), 'Segment ohne Text/Wörter')
  ok(words.length >= 20, `${label}: nur ${words.length} Wörter`)
  words.forEach((w, i) => ok(w.start >= (i ? words[i - 1].end : offset) && w.end >= w.start && w.end <= offset + dur + 0.01, `${label}: Wortzeit nicht monoton/im Audio: ${JSON.stringify(w)}`))
  const text = segs.map((s) => s.text).join(' ')
  console.log(`${label}: ${segs.length} Sätze, ${words.length} Wörter, ${secs.toFixed(1)} s für ${dur.toFixed(1)} s Audio, RTF ${(secs / dur).toFixed(3)} (CPU ${((cpu - cpu0) / dur).toFixed(3)}), Worker-Spitze ${peak.toFixed(2)} GB\n  ${text}`)
  return { text: norm(text), segs, rtf: secs / dur, cpu: (cpu - cpu0) / dur, peak }
}

let last = -1
await ensureModels('asr', models, (p) => { if (p >= last + 10) console.log(`Modelle ${(last = p)} %`) })

// onnxruntime-node (Freisteller) im Elternprozess geladen: sherpa (eigene libonnxruntime) muss im Worker trotzdem laufen
const ort = await import('onnxruntime-node')
ok(ort.InferenceSession, 'onnxruntime-node nicht geladen')

const jfk = await sample(JFK, 30), frei = await sample(FREI, 90)
const rtf: string[] = []
for (const threads of ['1', '2']) {
  stopWorker() // frischer Worker: Modell-Ladezeit und Spitze je Einstellung
  process.env.DECKWERK_SHERPA_THREADS = threads
  const a = await run(jfk, `JFK inkl. Laden (${threads} Thr.)`, 5, true)
  ok(a.text.includes('ask not what your country can do for you'), 'JFK-Satz nicht erkannt')
  ok(a.segs[0].start >= 5, 'offset nicht angewandt')
  const b = await run(frei, `Deutsch (${threads} Thr.)`)
  ok(/software/.test(b.text) && /\bfrei/.test(b.text), 'deutsches Stichwort nicht erkannt')
  rtf.push(`${threads} Thread(s): RTF ${b.rtf.toFixed(3)} (CPU-Zeit/Audio ${b.cpu.toFixed(3)}), Spitze ${b.peak.toFixed(2)} GB`)
}
stopWorker()
console.log(rtf.join('\n'))

// Audio-Ereignisse: je Sekunde ein Wert; Lachen und Applaus ≥ 0,4, reine Sprache überwiegend < 0,2 und ohne Musik (clip-musik: ab 5 s ≥ MUSIC)
const mono = (p: number[]) => p.at(-1) === 100 && p.every((x, i) => !i || x > p[i - 1])
const lachen = await sample(LACHEN, 30), applaus = await sample(APPLAUS, 30)
for (const [pcm, label, from, to] of [[lachen, 'Lachen', 2, 7], [applaus, 'Applaus', 1, 7]] as const) {
  const pct: number[] = [], { events: v, music } = await tag(pcm, { models, onProgress: (p) => pct.push(p) })
  console.log(`tag ${label}: ${v.join(' ')}`)
  ok(v.length === Math.ceil(pcm.length / 16000) && music.length === v.length && mono(pct), `${label}: ${v.length}/${music.length} Werte, Fortschritt ${pct}`)
  ok(v.slice(from, to + 1).every((x) => x >= 0.4), `${label}: Sekunden ${from}–${to} nicht alle ≥ 0,4`)
}
for (const [pcm, label] of [[jfk, 'JFK'], [frei, 'Deutsch']] as const) {
  const t0 = performance.now(), cpu0 = worker().cpu, { events: v, music } = await tag(pcm, { models })
  const secs = (performance.now() - t0) / 1000, dur = pcm.length / 16000
  console.log(`tag ${label}: ${secs.toFixed(1)} s für ${dur.toFixed(1)} s, RTF ${(secs / dur).toFixed(3)} (CPU ${((worker().cpu - cpu0) / dur).toFixed(3)}), Werte ${v.join(' ')}, Musik ${music.join(' ')}`)
  ok(v.filter((x) => x < 0.2).length >= 0.8 * v.length, `${label}: Sprache als Ereignis gewertet`)
  ok(music.filter((x) => x >= MUSIC).length < 5, `${label}: Sprache als Musik gewertet`)
}
// Musik: rein und leise unter Sprache (−12 dB, wie Hintergrundmusik im Stream), je überwiegend ≥ MUSIC
const musik = await sample(MUSIK, 30), rms = (x: Float32Array) => Math.sqrt(x.reduce((s, y) => s + y * y, 0) / x.length)
const gain = (0.25 * rms(jfk)) / rms(musik), unter = Float32Array.from(jfk, (y, i) => y + gain * musik[i % musik.length])
for (const [pcm, label] of [[musik, 'Musik'], [unter, 'JFK mit Musik −12 dB']] as const) {
  const { music } = await tag(pcm, { models })
  console.log(`tag ${label}: Musik ${music.join(' ')}`)
  ok(music.filter((x) => x >= MUSIC).length >= 0.8 * music.length, `${label}: Musik nicht erkannt`)
}

// Sprechertrennung: JFK (englisch), 1 s Stille, deutscher Sprecher; Wechsel in der Naht (11–12 s)
const zwei = new Float32Array(jfk.length + 16000 + 30 * 16000)
zwei.set(jfk)
zwei.set(frei.subarray(0, 30 * 16000), jfk.length + 16000)
const naht = jfk.length / 16000 + 0.5, dur = zwei.length / 16000
await ensureModels('diar', models) // Download nicht in der Zeitmessung (der erste Lauf enthält das Laden der Modelle)
const pct: number[] = [], t0 = performance.now(), cpu0 = worker().cpu
const turns = await diarize(zwei, { models, offset: 5, onProgress: (p) => pct.push(p) })
const secs = (performance.now() - t0) / 1000
console.log(`diarize: ${secs.toFixed(1)} s für ${dur.toFixed(1)} s, RTF ${(secs / dur).toFixed(3)} (CPU ${((worker().cpu - cpu0) / dur).toFixed(3)})\n  ${turns.map((t) => `${t.start}–${t.end}:${t.speaker}`).join('  ')}`)
ok(mono(pct), `Fortschritt nicht monoton bis 100: ${pct}`)
ok(turns.every((t, i) => t.start >= 5 && t.end <= 5 + dur + 0.1 && t.end > t.start && (!i || t.start >= turns[i - 1].start)), 'Turns nicht sortiert/im Audio')
ok(new Set(turns.map((t) => t.speaker)).size === 2 && turns[0].speaker === 0, 'nicht genau 2 Sprecher')
const wechsel = [turns.findLast((t) => t.speaker === 0)!.end, turns.find((t) => t.speaker === 1)!.start].map((t) => t - 5)
ok(wechsel.every((t) => Math.abs(t - naht) <= 1.5), `Wechsel bei ${wechsel} statt um ${naht} s`)

// Fehlerarten: Worker mit Ergebnissen stirbt → Laufzeitfehler; stirbt vor seinem ersten Ergebnis oder startet gar nicht →
// SHERPA_UNAVAILABLE (Engine nimmt Whisper)
const err = (p: Promise<unknown>) => p.then(() => { throw new Error('kein Fehler') }, (e: Error & { code?: string }) => e)
let killed = false
const killOnce = () => { if (!killed) { killed = true; process.kill(Number(kid()), 'SIGKILL') } }
const e1 = await err(diarize(zwei, { models, onProgress: killOnce }))
ok(killed && e1.code === undefined && /Hintergrundprozess wurde beendet/.test(e1.message), `Laufzeitabbruch: ${e1.code} ${e1.message}`)
killed = false
const e0 = await err(diarize(zwei, { models, onProgress: killOnce })) // neuer Worker, Absturz im ersten Auftrag
ok(killed && e0.code === 'SHERPA_UNAVAILABLE', `Absturz im ersten Auftrag nicht als SHERPA_UNAVAILABLE: ${e0.code} ${e0.message}`)
stopWorker()
const echt = process.env.DECKWERK_SHERPA_WORKER
process.env.DECKWERK_SHERPA_WORKER = fileURLToPath(new URL('./gibt-es-nicht.cjs', import.meta.url))
console.log('Startfehler des Workers (erwartet):')
const e2 = await err(tag(lachen, { models }))
process.env.DECKWERK_SHERPA_WORKER = echt
ok(e2.code === 'SHERPA_UNAVAILABLE', `Startfehler nicht als SHERPA_UNAVAILABLE: ${e2.code} ${e2.message}`)
console.log('check-sherpa: ok')
