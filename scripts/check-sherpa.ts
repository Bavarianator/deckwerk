// sherpa-onnx lokal, opt-in mit DW_NET=1 (lädt einmalig ~670 MB nach $DECKWERK_HOME/models bzw. ~/.cache/deckwerk-check/models, braucht ffmpeg): npx esbuild scripts/check-sherpa.ts --bundle --packages=external --platform=node --format=esm --outfile=node_modules/.cache/check-sherpa.mjs && npx esbuild src/main/sherpa-worker.ts --bundle --packages=external --platform=node --format=cjs --outfile=node_modules/.cache/sherpa-worker.cjs && DW_NET=1 node node_modules/.cache/check-sherpa.mjs
import { ok } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { asr, ensureModels, stopWorker } from '../src/main/sherpa'
import type { Segment } from '../src/shared/video'

if (process.env.DW_NET !== '1') { console.log('check-sherpa: übersprungen (DW_NET=1 lädt Modelle und Samples)'); process.exit(0) }
process.env.DECKWERK_SHERPA_WORKER ??= fileURLToPath(new URL('./sherpa-worker.cjs', import.meta.url)) // Worker-Bündel daneben

const models = join(process.env.DECKWERK_HOME ?? join(homedir(), '.cache', 'deckwerk-check'), 'models') // nicht /tmp: dort oft tmpfs im RAM
// Englisch: JFK aus whisper.cpp (gemeinfrei). Deutsch: „Gesprochene Definition freier Software“, Wikimedia Commons, CC BY-SA 3.0 de.
const JFK = ['https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav', '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e']
const FREI = ['https://upload.wikimedia.org/wikipedia/commons/6/61/Gesprochene_Definition_freier_Software.ogg', '57f8101daf8e401935601f56f1bc8b5917e51ba7fdffa73c13f33ca6dec377d8']

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
const worker = () => { // Spitzen-RSS (GB) und CPU-Zeit (s) des Worker-Kindprozesses, nur Linux
  const kids = `/proc/self/task/${process.pid}/children`
  const pid = existsSync(kids) ? readFileSync(kids, 'utf8').trim().split(/\s+/).at(-1) : ''
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
console.log('check-sherpa: ok')
