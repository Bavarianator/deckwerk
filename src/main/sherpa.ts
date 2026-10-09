// Spracherkennung lokal und offline mit sherpa-onnx (Apache-2.0): NVIDIA Parakeet-TDT-0.6B-v3 int8 (CC-BY-4.0, 25 Sprachen,
// Satzzeichen, Token-Zeitstempel) hinter Silero-VAD. Standard vor Whisper (transcribe.ts bleibt Fallback).
// sherpa läuft im Kindprozess sherpa-worker: Es bringt eine eigene libonnxruntime mit, die neben onnxruntime-node
// (Freisteller, YuNet) im selben Prozess kollidieren kann, und das Modell (~1,3 GB RAM) blockiert so nie den Main-Prozess.
// Ohne Electron, damit der Selbsttest unter Node läuft (scripts/check-sherpa.ts).
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { setPriority } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Segment } from '../shared/video'
import { download } from './download'

export const PARAKEET_LANGS: readonly string[] = ['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk']

// fester Commit + Prüfsummen (wie transcribe.ts): ein nachträglich verändertes Modell landet nie im nativen ONNX-Parser
const PARAKEET = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/'
const VAD = 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/'
type File = [dir: string, url: string, sha256: string, bytes: number]
const FILES: Record<'asr', File[]> = {
  asr: [
    ['parakeet-v3', PARAKEET + 'encoder.int8.onnx', 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247', 652184281],
    ['parakeet-v3', PARAKEET + 'decoder.int8.onnx', '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e', 11845275],
    ['parakeet-v3', PARAKEET + 'joiner.int8.onnx', '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3', 6355277],
    ['parakeet-v3', PARAKEET + 'tokens.txt', 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d', 93939],
    ['silero-vad', VAD + 'silero_vad.onnx', 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28', 1807522],
  ],
}
const local = (models: string, [dir, url]: File) => join(models, dir, basename(url))

let queue: Promise<unknown> = Promise.resolve() // nacheinander, sonst schrieben zwei Aufrufe dieselbe .part-Datei

/** Lädt fehlende Modelle (Parakeet ~670 MB, Silero-VAD 2 MB) nach modelsDir. onProgress 0–100 über alle fehlenden Dateien. */
export async function ensureModels(kind: 'asr', modelsDir: string, onProgress: (pct: number) => void = () => {}): Promise<void> {
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

type Reply = { id: number; progress?: number; result?: unknown; error?: string }
let child: ChildProcess | null = null, seq = 0, idle: NodeJS.Timeout | undefined
const calls = new Map<number, { c: ChildProcess; resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (pct: number) => void }>()

function worker(): ChildProcess {
  if (child) return child
  // Im Electron-Bundle liegt sherpa-worker.js neben diesem Chunk in out/main/ (CJS); Selbsttests geben ihr esbuild-Bündel an.
  // Bibliothekspfade sind nicht nötig: sherpa-onnx.node findet libonnxruntime über RUNPATH $ORIGIN (macOS @loader_path).
  // stdout auf stderr: im MCP-Modus ist stdout der Protokollkanal
  const c = fork(process.env.DECKWERK_SHERPA_WORKER ?? join(__dirname, 'sherpa-worker.js'), [], { serialization: 'advanced', stdio: ['ignore', 2, 2, 'ipc'] })
  if (c.pid) try { setPriority(c.pid, 10) } catch {} // UI hat auf 2 Kernen Vorrang
  c.on('message', ({ id, progress, result, error }: Reply) => {
    const call = calls.get(id)
    if (!call) return
    if (progress !== undefined) return call.onProgress?.(progress)
    calls.delete(id)
    if (error !== undefined) call.reject(new Error(error))
    else call.resolve(result)
    if (!calls.size) idle = setTimeout(stopWorker, IDLE)
  })
  const fail = (why: string) => {
    if (child === c) child = null
    for (const [id, call] of calls) if (call.c === c) { // nur die eigenen: ein schon neu gestarteter Worker arbeitet weiter
      calls.delete(id)
      call.reject(new Error(`Spracherkennung abgebrochen: Der Hintergrundprozess wurde beendet (${why}). Bitte erneut versuchen.`))
    }
  }
  c.on('exit', (code, signal) => fail(signal === 'SIGKILL' ? 'vermutlich zu wenig Arbeitsspeicher' : signal ?? `Code ${code}`))
  c.on('error', (e) => { fail(e.message); c.kill() }) // Start- oder Sendefehler
  return (child = c)
}

function call<T>(op: string, args: unknown, onProgress?: (pct: number) => void): Promise<T> {
  clearTimeout(idle)
  const id = ++seq, c = worker()
  return new Promise<T>((resolve, reject) => {
    calls.set(id, { c, resolve: resolve as (v: unknown) => void, reject, onProgress })
    c.send({ id, op, args })
  })
}

/** Beendet den Worker sofort (offene Aufrufe schlagen fehl). */
export function stopWorker(): void {
  clearTimeout(idle)
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
