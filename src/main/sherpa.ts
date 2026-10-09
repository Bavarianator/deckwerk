// Spracherkennung lokal und offline mit sherpa-onnx (Apache-2.0): NVIDIA Parakeet-TDT-0.6B-v3 int8 (CC-BY-4.0, 25 Sprachen,
// Satzzeichen, Token-Zeitstempel) hinter Silero-VAD. Standard vor Whisper (transcribe.ts bleibt Fallback).
// Dazu Audio-Ereignisse (CED-mini, Apache-2.0) für Stream-Highlights und Sprechertrennung (pyannote-segmentation-3.0, MIT,
// + 3D-Speaker CAM++, Apache-2.0) für den Zuschnitt auf den aktiven Sprecher. Modellwahl und Messungen in sherpa-worker.ts.
// sherpa läuft im Kindprozess sherpa-worker: Es bringt eine eigene libonnxruntime mit, die neben onnxruntime-node
// (Freisteller, YuNet) im selben Prozess kollidieren kann, und das Modell (~1,3 GB RAM) blockiert so nie den Main-Prozess.
// Ohne Electron, damit der Selbsttest unter Node läuft (scripts/check-sherpa.ts).
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { setPriority } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Segment } from '../shared/video'
import { download } from './download'

export const PARAKEET_LANGS: readonly string[] = ['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk']

// fester Commit + Prüfsummen (wie transcribe.ts): ein nachträglich verändertes Modell landet nie im nativen ONNX-Parser
const PARAKEET = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/'
const VAD = 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/'
const CED = 'https://huggingface.co/k2-fsa/sherpa-onnx-ced-mini-audio-tagging-2024-04-19/resolve/4da6df50dc47b25f91074b5ef7df4c1cc0dd7d4d/'
const SEG = 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/'
const EMB = 'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf/'
type Kind = 'asr' | 'tag' | 'diar'
type File = [dir: string, url: string, sha256: string, bytes: number]
const FILES: Record<Kind, File[]> = {
  asr: [
    ['parakeet-v3', PARAKEET + 'encoder.int8.onnx', 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247', 652184281],
    ['parakeet-v3', PARAKEET + 'decoder.int8.onnx', '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e', 11845275],
    ['parakeet-v3', PARAKEET + 'joiner.int8.onnx', '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3', 6355277],
    ['parakeet-v3', PARAKEET + 'tokens.txt', 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d', 93939],
    ['silero-vad', VAD + 'silero_vad.onnx', 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28', 1807522],
  ],
  tag: [
    ['ced-mini', CED + 'model.int8.onnx', 'ff29f39f9fbe637f72535160e9d006d61d872fdab0fce838672265b9b38cf946', 10451715],
    ['ced-mini', CED + 'class_labels_indices.csv', 'cdd1049833c4b86127c2773ac0d14a2754b6a6d0d1798002ed5c66e699708429', 14675],
  ],
  diar: [
    ['diarization', SEG + 'model.int8.onnx', 'd582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d', 1540506],
    ['diarization', EMB + '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx', 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2', 28281164],
  ],
}
const local = (models: string, [dir, url]: File) => join(models, dir, basename(url))

let queue: Promise<unknown> = Promise.resolve() // nacheinander, sonst schrieben zwei Aufrufe dieselbe .part-Datei

/** Lädt fehlende Modelle nach modelsDir (asr: Parakeet ~670 MB + Silero-VAD 2 MB, tag: 10 MB, diar: 30 MB).
 *  onProgress 0–100 über alle fehlenden Dateien. */
export async function ensureModels(kind: Kind, modelsDir: string, onProgress: (pct: number) => void = () => {}): Promise<void> {
  const run = queue.then(async () => {
    const missing = FILES[kind].filter((f) => !existsSync(local(modelsDir, f)))
    const total = missing.reduce((s, f) => s + f[3], 0)
    let done = 0
    for (const f of missing) {
      await mkdir(dirname(local(modelsDir, f)), { recursive: true })
      await download(f[1], f[2], local(modelsDir, f), (pct) => onProgress(Math.floor(((done + (f[3] * pct) / 100) / total) * 100)))
      done += f[3]
    }
  })
  queue = run.catch(() => {})
  return run
}

// Gemessen 09.10. auf AMD A4-9125 (2 Kerne, eine FPU), 90 s deutsche Sprache, Rechner durch andere Prozesse belastet
// (Last 5–8), abwechselnd je 2 Läufe: 1 Thread RTF 2,33/2,42 (CPU-Zeit je Audiosekunde 0,77/0,74), 2 Threads RTF
// 1,74/1,23 (CPU 1,10/1,16), Spitze 1,32 bzw. 1,37 GB VmHWM. Ohne Last geschätzt RTF 0,75 gegen ~0,57; Modell laden unter Last
// 15–35 s. Die geteilte FPU kostet ~40 % mehr Rechenzeit, 2 Threads sind trotzdem schneller. Ausnahme: Bei Last ~10 und
// nice 10 (check-sherpa) war 2 langsamer (RTF 4,5 gegen 3,3), weil ein verdrängter Thread den anderen warten lässt.
const THREADS = 2
const IDLE = 60_000 // danach endet der Worker und gibt das Modell (~1,3 GB) frei
const STALL = 10 * 60_000 // so lange keine Nachricht bei offenem Auftrag: Worker hängt und blockierte sonst alle folgenden

// Schutz vor dem OOM-Killer (wie transcribe.ts), bevor ein Modell in den Worker kommt: asr ~1,3 GB Spitze, tag/diar je < 0,1 GB.
// MemAvailable statt os.freemem(): zählt den freigebbaren Datei-Cache mit. macOS lagert aus statt zu beenden, dort nicht sperren.
const NEED_GB: Record<string, number> = { asr: 1.5, tag: 0.6, diar: 0.6 }
function memCheck(op: string) {
  if (process.platform !== 'linux') return
  let gb: number
  try { gb = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1]) / 1024 ** 2 } catch { return }
  if (gb < NEED_GB[op]) throw new Error(`Zu wenig freier Arbeitsspeicher für die Audio-Analyse (${gb.toFixed(1)} GB frei, nötig ca. ${NEED_GB[op].toLocaleString('de')} GB). Andere Programme schließen und erneut versuchen.`)
}

type Reply = { id: number; progress?: number; result?: unknown; error?: string }
let child: ChildProcess | null = null, seq = 0, idle: NodeJS.Timeout | undefined, stall: NodeJS.Timeout | undefined
let loaded = new Set<string>() // Ops, deren Modell der laufende Worker schon geladen hat: dafür keine erneute Speicherprüfung
const calls = new Map<number, { c: ChildProcess; resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (pct: number) => void; pct: number }>()

function fail(c: ChildProcess, why: string, code?: string) {
  if (child === c) child = null
  for (const [id, call] of calls) if (call.c === c) { // nur die eigenen: ein schon neu gestarteter Worker arbeitet weiter
    calls.delete(id)
    call.reject(Object.assign(new Error(`Audio-Analyse abgebrochen: Der Hintergrundprozess wurde beendet (${why}). Bitte erneut versuchen.`), code ? { code } : {}))
  }
}

/** Nach jedem Auftrag und jeder Nachricht: Leerlauf-Ende bzw. Stillstands-Wache neu stellen. Im Leerlauf hält der Worker
 *  den Elternprozess nicht am Leben (Selbsttests unter Node enden sofort). */
function watch() {
  clearTimeout(idle)
  clearTimeout(stall)
  const c = child
  if (!c) return
  if (calls.size) {
    c.ref(); c.channel?.ref()
    stall = setTimeout(() => { fail(c, 'keine Rückmeldung seit 10 min'); c.kill('SIGKILL') }, STALL)
  } else {
    c.unref(); c.channel?.unref()
    idle = setTimeout(stopWorker, IDLE).unref()
  }
}

function worker(): ChildProcess {
  if (child) return child
  // Im Electron-Bundle liegt sherpa-worker.js neben diesem Chunk in out/main/ (CJS); Selbsttests geben ihr esbuild-Bündel an.
  // Bibliothekspfade sind nicht nötig: sherpa-onnx.node findet libonnxruntime über RUNPATH $ORIGIN (macOS @loader_path).
  // stdout auf stderr: im MCP-Modus ist stdout der Protokollkanal
  const c = fork(process.env.DECKWERK_SHERPA_WORKER ?? join(__dirname, 'sherpa-worker.js'), [], { serialization: 'advanced', stdio: ['ignore', 2, 2, 'ipc'] })
  if (c.pid) try { setPriority(c.pid, 10) } catch {} // UI hat auf 2 Kernen Vorrang
  // Bei Speichernot soll der Kernel den Worker beenden, nicht App oder MCP-Server (Abbruch meldet fail(), Engine macht weiter)
  if (c.pid && process.platform === 'linux') try { writeFileSync(`/proc/${c.pid}/oom_score_adj`, '800') } catch {}
  loaded = new Set()
  let worked = false // erstes Ergebnis geliefert
  c.on('message', ({ id, progress, result, error }: Reply) => {
    if (c === child) watch()
    const call = calls.get(id)
    if (!call) return
    if (progress !== undefined) { // Worker meldet auch gleiche Werte (Lebenszeichen), der Aufrufer bekommt nur steigende
      if (progress > call.pct) try { call.onProgress?.((call.pct = progress)) } catch {} // Fehler beim Aufrufer bricht den Auftrag nicht ab
      return
    }
    calls.delete(id)
    if (error !== undefined) call.reject(new Error(error))
    else { worked = true; call.resolve(result) }
    if (c === child) watch()
  })
  // Stirbt der Worker vor seinem ersten Ergebnis (Addon/Prebuild lädt nicht, Plattform ohne Prebuild, Absturz oder OOM beim
  // ersten Modell-Laden), ist sherpa hier nicht nutzbar: code SHERPA_UNAVAILABLE, die Engine nimmt dann Whisper. Spätere
  // Abbrüche und absichtliches Beenden sind Laufzeitfehler.
  const died = (why: string) => { fail(c, why, worked || c.killed ? undefined : 'SHERPA_UNAVAILABLE'); watch() }
  c.on('exit', (code, signal) => died(signal === 'SIGKILL' ? 'vermutlich zu wenig Arbeitsspeicher' : signal ?? `Code ${code}`))
  c.on('error', (e) => { died(e.message); c.kill() }) // Start- oder Sendefehler
  return (child = c)
}

function call<T>(op: string, args: unknown, onProgress?: (pct: number) => void): Promise<T> {
  if (!child || !loaded.has(op)) memCheck(op)
  const id = ++seq, c = worker()
  loaded.add(op)
  return new Promise<T>((resolve, reject) => {
    calls.set(id, { c, resolve: resolve as (v: unknown) => void, reject, onProgress, pct: -1 })
    watch()
    c.send({ id, op, args })
  })
}

/** Beendet den Worker sofort (offene Aufrufe schlagen fehl). */
export function stopWorker(): void {
  clearTimeout(idle)
  clearTimeout(stall)
  child?.kill()
  child = null
}

/** Transkript aus 16 kHz mono f32: Silero-VAD teilt in Sprachstücke, Parakeet erkennt sie. Segmente = Sätze mit echten
 *  Wortzeiten (s, + offset). onProgress 0–100 über die Erkennung; fehlende Modelle lädt ensureModels vorher ohne Fortschritt. */
export async function asr(pcm: Float32Array, o: { models: string; offset?: number; onProgress?: (pct: number) => void }): Promise<Segment[]> {
  await ensureModels('asr', o.models)
  const threads = Number(process.env.DECKWERK_SHERPA_THREADS) || THREADS // Stellschraube für Messungen
  return call<Segment[]>('asr', { pcm, models: o.models, offset: o.offset ?? 0, threads }, o.onProgress)
}

/** Audio-Ereignisse für Stream-Highlights und Musik für den Clip-Lint aus 16 kHz mono f32: je Sekunde (Länge ceil(pcm.length / 16000))
 *  die höchste Wahrscheinlichkeit 0–1, events für Lachen, Jubel, Applaus, Schreien, Rufen oder Menge, music für Musik,
 *  Hintergrundmusik, Videospielmusik, Gesang oder Instrument (CED-mini, ein Durchlauf, Fensterung im Worker). */
export async function tag(pcm: Float32Array, o: { models: string; onProgress?: (pct: number) => void }): Promise<{ events: number[]; music: number[] }> {
  await ensureModels('tag', o.models)
  return call('tag', { pcm, models: o.models }, o.onProgress)
}

/** Sprechertrennung aus 16 kHz mono f32: Turns in s (+ offset), Sprecher 0-basiert in der Reihenfolge ihres ersten Auftretens.
 *  Die Sprecherzahl entscheidet eine Ähnlichkeitsschwelle. Turns unter 0,5 s hängen am Nachbarn. */
export async function diarize(pcm: Float32Array, o: { models: string; offset?: number; onProgress?: (pct: number) => void }): Promise<{ start: number; end: number; speaker: number }[]> {
  await ensureModels('diar', o.models)
  return call('diar', { pcm, models: o.models, offset: o.offset ?? 0 }, o.onProgress)
}
