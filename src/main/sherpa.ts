// Spracherkennung lokal und offline mit sherpa-onnx (Apache-2.0): Parakeet Ultra int8 (moondream, Feinabstimmung von NVIDIA
// Parakeet-TDT-0.6B-v3, CC-BY-4.0, 25 Sprachen,
// Satzzeichen, Token-Zeitstempel) hinter Silero-VAD. Standard vor Whisper (transcribe.ts bleibt Fallback).
// Dazu Audio-Ereignisse (CED-mini, Apache-2.0) für Stream-Highlights und Sprechertrennung (pyannote-segmentation-3.0, MIT,
// + 3D-Speaker CAM++, Apache-2.0) für den Zuschnitt auf den aktiven Sprecher. Modellwahl und Messungen in sherpa-worker.ts.
// sherpa läuft im Kindprozess sherpa-worker: Es bringt eine eigene libonnxruntime mit, die neben onnxruntime-node
// (Freisteller, YuNet) im selben Prozess kollidieren kann, und das Modell (~1,3 GB RAM) blockiert so nie den Main-Prozess.
// Ohne Electron, damit der Selbsttest unter Node läuft (scripts/check-sherpa.ts).
import { execFile, execFileSync, fork, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { setPriority } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { VoiceId } from '../shared/deck'
import { APP } from '../shared/app-id'
import type { Segment } from '../shared/video'
import { download } from './download'
import { ensurePhone } from './phone'

export const PARAKEET_LANGS: readonly string[] = ['bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv', 'ru', 'uk']

// fester Commit + Prüfsummen (wie transcribe.ts): ein nachträglich verändertes Modell landet nie im nativen ONNX-Parser
// Parakeet Ultra gibt es nur als Hugging-Face-Checkpoint: selbst umgewandelt (scripts/convert-parakeet-ultra.py, Workflow modelle.yml) und als
// Vorabversion-Release abgelegt. Gleiche Architektur und Tokenizer wie v3, laut moondream FLEURS (25 Sprachen) 9,55 % statt 11,62 % WER, gleich schnell.
const PARAKEET = 'https://github.com/Bavarianator/deckwerk/releases/download/parakeet-ultra-1/'
const VAD = 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/'
const CED = 'https://huggingface.co/k2-fsa/sherpa-onnx-ced-mini-audio-tagging-2024-04-19/resolve/4da6df50dc47b25f91074b5ef7df4c1cc0dd7d4d/'
const SEG = 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/'
const EMB = 'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/0743f301363dec56491a490f6d6cbc9d67f9a3bf/'
const FC_DE = 'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-transducer-stt_de_fastconformer_hybrid_large_pc-int8/resolve/df32693bc4328136c455af24035a5ee1ec708df0/'

// Erkennungsmodelle (beide nemo_transducer, gleiche Dateinamen). Standard Parakeet. „Deutsch schnell“ = NVIDIA
// stt_de_fastconformer_hybrid_large_pc int8 (CC-BY-4.0, 115 M Parameter, nur Deutsch, Satzzeichen und Großschreibung, Token-
// Zeitstempel ohne Dauer). Gemessen 15.10. an 2 min deutscher Sprache: Galaxy S20+ (4 Threads) RTF 0,117 gegen 0,039, A4-9125
// (2 Threads, Last) ~0,8 gegen 0,19. Parakeet ist klar genauer; FC-DE verhört sich öfter („abzielen“ statt „abziehen“), schreibt
// teils alt („muß“) und Zahlen als Wörter („achtundzwanzig Zentimeter“). Daher nur für sehr lange deutsche Videos und schwache PCs.
// Verworfen: Meta Omnilingual-300M (kleingeschrieben, ohne Satzzeichen, langsamer).
export type AsrModel = 'parakeet' | 'de-schnell'
export const ASR_DIR: Record<AsrModel, string> = { parakeet: 'parakeet-ultra', 'de-schnell': 'fc-de' }
/** Gewähltes Modell unter appData/<APP.id> (gemeinsam für App, Entwicklung und MCP-Server wie phone-off): Inhalt „de-schnell“, sonst Parakeet */
export const asrModelFile = (appData: string) => join(appData, APP.id, 'asr-model')
export function asrModelOf(appData: string): AsrModel {
  try { return readFileSync(asrModelFile(appData), 'utf8').trim() === 'de-schnell' ? 'de-schnell' : 'parakeet' } catch { return 'parakeet' }
}

type Kind = AsrModel | 'tag' | 'diar'
type File = [dir: string, url: string, sha256: string, bytes: number]
const SILERO: File = ['silero-vad', VAD + 'silero_vad.onnx', 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28', 1807522]
const FILES: Record<Kind, File[]> = {
  parakeet: [
    ['parakeet-ultra', PARAKEET + 'encoder.int8.onnx', '435dc88bd15024d607d3b20829946a5b32deac4485ae1eb7860481b89fb9de02', 652282395],
    ['parakeet-ultra', PARAKEET + 'decoder.int8.onnx', '1fab98fe6c12aded87d2da66272cc9e148d0a0044ce3850a12fe56302ec4a922', 11845274],
    ['parakeet-ultra', PARAKEET + 'joiner.int8.onnx', '8a71aaccfdba3d451775507a889afd2257d2e754463fd81095a8c8f290f924c2', 6355277],
    ['parakeet-ultra', PARAKEET + 'tokens.txt', 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d', 93939],
    SILERO,
  ],
  'de-schnell': [
    ['fc-de', FC_DE + 'encoder.int8.onnx', '10fbb959c36c461afb02ea87c109119eb001f30e91a130663bd6d5bbcba74ba9', 131114014],
    ['fc-de', FC_DE + 'decoder.int8.onnx', '4633a4b0a3f21f7ace4df02e772f5b5e63d45f84a71ee1e2660998fc4beb46ad', 3955863],
    ['fc-de', FC_DE + 'joiner.int8.onnx', '80f493f2885f6ccbd9cf9c20f4b6c616c2eb6dae48df6a5d4a0653354f7fe66b', 1408183],
    ['fc-de', FC_DE + 'tokens.txt', 'abb1136142604d6d1766ad5060bd4f4b1048d7a096cd094b2d40eec3e666be9f', 10686],
    SILERO,
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

// Sprecherstimme (Feature Animation, voice.ts): Piper-VITS medium über sherpa-onnx OfflineTts, je Stimme ein Archiv (Modell, tokens.txt,
// espeak-ng-data) aus dem Release tts-models von k2-fsa/sherpa-onnx. Lizenzen laut MODEL_CARD im Archiv:
// de = Thorsten (Datensatz Thorsten-Voice, CC0), en = Norman (LibriVox, gemeinfrei, von Grund auf trainiert).
// Verworfen: Lessac (Blizzard-2013-Lizenz, nur nicht-kommerziell).
const TTS_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/'
export const TTS: Record<VoiceId, [name: string, sha256: string, bytes: number]> = {
  de: ['vits-piper-de_DE-thorsten-medium', '50487d9c95fdf2191f31d2588569381063ba1591dcd4c7d4bdd30f12b2191714', 67214254],
  en: ['vits-piper-en_US-norman-medium', '1f32065d480abe9abc7c7f91442125d0b34c1cc065d1e600466cac408eabf3b8', 67203672],
}
const ttsModel = (voice: VoiceId) => `${TTS[voice][0].replace('vits-piper-', '')}.onnx`

let queue: Promise<unknown> = Promise.resolve() // nacheinander, sonst schrieben zwei Aufrufe dieselbe .part-Datei

/** Lädt fehlende Modelle nach modelsDir (parakeet ~670 MB bzw. de-schnell ~137 MB, je + Silero-VAD 2 MB, tag: 10 MB, diar: 30 MB).
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
    if (kind === 'parakeet') await rm(join(modelsDir, 'parakeet-v3'), { recursive: true, force: true }) // Vorgänger (bis v0.2.4), ~670 MB
  })
  queue = run.catch(() => {})
  return run
}

/** Lädt die Stimme nach <models>/tts-<voice> (Archiv je ~67 MB, entpackt ~125 MB). Entpackt in einen Temp-Ordner daneben und
 *  benennt erst den fertigen Ordner um: Ein Abbruch hinterlässt kein halbes Modell. */
export async function ensureVoice(voice: VoiceId, models: string, onProgress: (pct: number) => void = () => {}): Promise<string> {
  const [name, sha] = TTS[voice], dir = join(models, `tts-${voice}`)
  const run = queue.then(async () => {
    if (existsSync(join(dir, ttsModel(voice)))) return
    await rm(dir, { recursive: true, force: true }) // andere, früher gepinnte Stimme
    await mkdir(models, { recursive: true })
    const tmp = await mkdtemp(join(models, '.tts-'))
    try {
      await download(TTS_URL + name + '.tar.bz2', sha, join(tmp, 'voice.tar.bz2'), onProgress)
      await promisify(execFile)('tar', ['-xf', join(tmp, 'voice.tar.bz2'), '-C', tmp])
        .catch((e) => { throw new Error(`Stimme entpacken fehlgeschlagen (bzip2 fehlt?): ${e.message}`) })
      // App und MCP-Server können gleichzeitig laden: liegt die Stimme schon da, gewinnt der andere Prozess
      await rename(join(tmp, name), dir).catch((e) => { if (!['ENOTEMPTY', 'EEXIST'].includes(e.code) || !existsSync(join(dir, ttsModel(voice)))) throw e })
    } finally {
      await rm(tmp, { recursive: true, force: true }) // samt Archiv
    }
  })
  queue = run.catch(() => {})
  await run
  return dir
}

// Gemessen 09.10. auf AMD A4-9125 (2 Kerne, eine FPU), 90 s deutsche Sprache, Rechner durch andere Prozesse belastet
// (Last 5–8), abwechselnd je 2 Läufe: 1 Thread RTF 2,33/2,42 (CPU-Zeit je Audiosekunde 0,77/0,74), 2 Threads RTF
// 1,74/1,23 (CPU 1,10/1,16), Spitze 1,32 bzw. 1,37 GB VmHWM. Ohne Last geschätzt RTF 0,75 gegen ~0,57; Modell laden unter Last
// 15–35 s. Die geteilte FPU kostet ~40 % mehr Rechenzeit, 2 Threads sind trotzdem schneller. Ausnahme: Bei Last ~10 und
// nice 10 (check-sherpa) war 2 langsamer (RTF 4,5 gegen 3,3), weil ein verdrängter Thread den anderen warten lässt.
// macOS: ein Thread je Leistungskern (Apple Silicon M1–M4 4, Pro/Max 6–12, höchstens 8), mit 2 blieb dort mindestens die
// Hälfte der Leistungskerne ungenutzt. Effizienzkerne nicht mitzählen: ONNX wartet je Schicht auf den langsamsten
// Thread. Intel-Macs ohne perflevel0: 4.
let threadCount: number | undefined
function defaultThreads(): number {
  if (process.platform !== 'darwin') return 2
  try { return Math.min(8, Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8' })) || 4) } catch { return 4 }
}
const IDLE = 60_000 // danach endet der Worker und gibt das Modell (~1,3 GB) frei
const STALL = 10 * 60_000 // so lange keine Nachricht bei offenem Auftrag: Worker hängt und blockierte sonst alle folgenden

// Schutz vor dem OOM-Killer (wie transcribe.ts), bevor ein Modell in den Worker kommt: asr ~1,3 GB Spitze, tag/diar je < 0,1 GB.
// MemAvailable statt os.freemem(): zählt den freigebbaren Datei-Cache mit. macOS lagert aus statt zu beenden, dort nicht sperren.
const NEED_GB: Record<string, number> = { asr: 1.5, 'asr-phone': 0.3, tag: 0.6, diar: 0.6, tts: 0.5 } // asr-phone: nur Silero-VAD hier
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

/** Transkript aus 16 kHz mono f32: Silero-VAD teilt in Sprachstücke, model (Standard Parakeet) erkennt sie. Segmente = Sätze mit echten
 *  Wortzeiten (s, + offset). onProgress 0–100 über die Erkennung; fehlende Modelle lädt ensureModels vorher ohne Fortschritt. */
export async function asr(pcm: Float32Array, o: { models: string; offset?: number; onProgress?: (pct: number) => void; phone?: string; model?: AsrModel }): Promise<Segment[]> {
  const model = o.model ?? 'parakeet', dir = ASR_DIR[model]
  await ensureModels(model, o.models)
  // phone: Seriennummer eines Handys (phone.ts), das erkennt; geht dort etwas schief, rechnet der PC wie ohne Handy
  if (o.phone) try {
    await ensurePhone(o.phone, o.models, dir)
    return await call<Segment[]>('asr-phone', { pcm, models: o.models, offset: o.offset ?? 0, threads: 1, phone: o.phone, dir }, o.onProgress)
  } catch (e) { console.warn('[sherpa] Handy nicht nutzbar, Erkennung auf dem PC:', (e as Error).message) }
  const threads = Number(process.env.DECKWERK_SHERPA_THREADS) || (threadCount ??= defaultThreads()) // Stellschraube für Messungen
  return call<Segment[]>('asr', { pcm, models: o.models, offset: o.offset ?? 0, threads, dir }, o.onProgress)
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

/** Sprecherstimme: je Satz mono f32 bei sampleRate der Stimme (Piper 22 050 Hz), Sprecher 0, speed 1 = normal. Lädt die Stimme vorher, falls sie fehlt.
 *  onProgress: 0–30 Download der Stimme (fehlt nichts, springt er gleich auf 30), 30–100 Synthese. */
export async function tts(sentences: string[], o: { voice: VoiceId; speed: number; models: string; onProgress?: (pct: number) => void }): Promise<{ samples: Float32Array[]; sampleRate: number }> {
  const dir = await ensureVoice(o.voice, o.models, (p) => o.onProgress?.(Math.floor(p * 0.3)))
  return call('tts', { sentences, speed: o.speed, dir, model: ttsModel(o.voice) }, (p) => o.onProgress?.(30 + Math.floor(p * 0.7)))
}
