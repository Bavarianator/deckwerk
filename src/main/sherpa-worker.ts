// Kindprozess für sherpa-onnx, gestartet von sherpa.ts per fork (Gründe dort). Nachrichten {id, op, args} →
// {id, progress} | {id, result} | {id, error}. Weitere Ops kommen in OPS dazu.
import { join } from 'node:path'
import type { Segment, Word } from '../shared/video'

// sherpa-onnx-node bringt keine Typen mit; nur das Benutzte
interface Result { text: string; tokens: string[]; timestamps: number[]; durations?: number[] }
interface Stream { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void }
interface Recognizer { createStream(): Stream; decodeAsync(s: Stream): Promise<Result> }
interface Vad { acceptWaveform(s: Float32Array): void; isEmpty(): boolean; front(external: boolean): { start: number; samples: Float32Array }; pop(): void; flush(): void }
interface Tagger { createStream(): Stream; compute(s: Stream): { index: number; prob: number }[] }
interface Turn { start: number; end: number; speaker: number }
interface Diarizer { handle: unknown; setConfig(c: { clustering: { numClusters: number; threshold: number } }): void }
interface Sherpa {
  OfflineRecognizer: { createAsync(config: object): Promise<Recognizer> }
  Vad: new (config: object, bufferSeconds: number) => Vad
  AudioTagging: new (config: object) => Tagger
  OfflineSpeakerDiarization: new (config: object) => Diarizer
}
let lib: Sherpa | undefined
const sherpa = (): Sherpa => (lib ??= require('sherpa-onnx-node')) // erst bei Bedarf: check-sherpa importiert sentences() ohne Addon

const SR = 16000, WINDOW = 512, MAX = 30 * SR, GAP = 2 * SR

let rec: { key: string; r: Promise<Recognizer> } | null = null
function recognizer(models: string, threads: number): Promise<Recognizer> {
  const key = `${models}|${threads}`, dir = join(models, 'parakeet-v3')
  if (rec?.key !== key) rec = {
    key,
    r: sherpa().OfflineRecognizer.createAsync({
      featConfig: { sampleRate: SR, featureDim: 80 }, // featureDim nimmt sherpa bei NeMo aus den Modell-Metadaten (128)
      modelConfig: {
        transducer: { encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), joiner: join(dir, 'joiner.int8.onnx') },
        tokens: join(dir, 'tokens.txt'), numThreads: threads, provider: 'cpu', modelType: 'nemo_transducer', debug: 0,
      },
    }).catch((e) => { rec = null; throw e }),
  }
  return rec.r
}

const at = (s: number) => Math.round(s * 100) / 100

/** Wörter aus den SentencePiece-Token: ▁ bzw. Leerzeichen beginnt ein Wort, Satzzeichen hängen am vorigen. t0 = Start des Stücks in s. */
function words(r: Result, t0: number, t1: number): Word[] {
  const out: Word[] = []
  let gap = true // Ziffern stehen nur ohne ▁ im Vokabular und folgen einem einzelnen ▁ („vom“ „▁“ „2“ „9“)
  r.tokens.forEach((tok, i) => {
    const start = t0 + r.timestamps[i], end = Math.min(t1, start + (r.durations?.[i] ?? 0))
    const piece = tok.replace(/▁/g, ' '), t = piece.trim()
    if (/^\s/.test(piece)) gap = true
    if (!t) return
    const last = out.at(-1)
    if (gap || !last) out.push({ w: t, start, end })
    else { last.w += t; if (/[\p{L}\p{N}]/u.test(t)) last.end = Math.max(last.end, end) } // Satzzeichen verlängern das Wort nicht
    gap = false
  })
  for (let i = 0; i < out.length; i++) { // ohne Token-Dauer (kein TDT) bis zum Folgewort, nie darüber hinaus
    const next = out[i + 1]?.start ?? t1
    if (out[i].end <= out[i].start) out[i].end = out[i].start + 0.3
    out[i].end = at(Math.min(out[i].end, next))
    out[i].start = at(out[i].start)
  }
  return out
}

// Bekannte Abkürzungen, auch über Wörter verteilt („z. B.“ = „z.“ + „B.“); „Plan B.“ oder „the U.S.“ beenden den Satz
const ABBR = /^(?:z\.B|d\.h|u\.a|i\.d\.R|u\.U|v\.a|z\.T|o\.ä|usw|bzw|ca|Dr|Nr|Prof|Hr|Fr|St|Str|vgl|ggf|evtl|inkl|zzgl|bspw|sog|Mio|Mrd|Mr|Mrs|Ms|vs|Abs|Tel)\.$/iu
const MONTH = /^(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\P{L}*$/u

/** Punkt an ws[i] beendet keinen Satz: Abkürzung oder Ordinalzahl vor kleinem Wort bzw. Monat („am 3. Oktober“, nicht „Wir waren 25.“). */
function noEnd(ws: Word[], i: number): boolean {
  const next = ws[i + 1]?.w ?? ''
  if (/^\d{1,3}\.$/.test(ws[i].w)) return /^\p{Ll}/u.test(next) || MONTH.test(next)
  for (let a = Math.max(0, i - 2); a <= i; a++) for (let b = i; b <= Math.min(ws.length - 1, a + 2); b++) {
    if (ABBR.test(ws.slice(a, b + 1).map((w) => w.w).join(''))) return true
  }
  return false
}

/** Segmente = Sätze (Bruch nach . ! ? …). */
export function sentences(ws: Word[]): Segment[] {
  const out: Segment[] = []
  let cur: Word[] = []
  const flush = () => { if (cur.length) out.push({ start: cur[0].start, end: cur.at(-1)!.end, text: cur.map((w) => w.w).join(' '), words: cur }); cur = [] }
  ws.forEach((w, i) => { cur.push(w); if (/[!?…]$/.test(w.w) || (w.w.endsWith('.') && !noEnd(ws, i))) flush() })
  flush()
  return out
}

interface AsrArgs { pcm: Float32Array; models: string; offset: number; threads: number }
async function asr({ pcm, models, offset, threads }: AsrArgs, progress: (pct: number) => void): Promise<Segment[]> {
  const r = await recognizer(models, threads)
  // Vorträge/Streams: Pausen ab 0,4 s sind Schnittstellen, einzelne Sprachstücke höchstens 20 s (danach sucht Silero die
  // nächste kurze Pause). Folgestücke mit Pausen bis 2 s erkennt Parakeet gemeinsam (bis 30 s): Einzeln setzte es an jeder
  // Pause einen Punkt („Ask not. What your country …“) und verlor den Satzzusammenhang.
  const vad = new (sherpa().Vad)({
    sileroVad: { model: join(models, 'silero-vad', 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: WINDOW },
    sampleRate: SR, numThreads: 1, debug: 0,
  }, 60)
  const out: Segment[] = []
  let cur: [number, number] | null = null // gesammeltes Stück pcm[a, b)
  const decode = async ([a, b]: [number, number]) => {
    const s = r.createStream()
    s.acceptWaveform({ samples: pcm.subarray(a, b), sampleRate: SR })
    out.push(...sentences(words(await r.decodeAsync(s), offset + a / SR, offset + b / SR)))
    progress(Math.floor((b / pcm.length) * 99)) // auch unverändert: Lebenszeichen für die Stillstands-Wache in sherpa.ts
  }
  const drain = async () => {
    while (!vad.isEmpty()) {
      const { start, samples } = vad.front(false) // false: Electron verbietet externe Puffer
      vad.pop()
      const end = start + samples.length
      if (cur && (end - cur[0] > MAX || start - cur[1] > GAP)) { await decode(cur); cur = null }
      cur = [cur?.[0] ?? start, end]
    }
  }
  for (let i = 0; i < pcm.length; i += WINDOW) { vad.acceptWaveform(pcm.subarray(i, i + WINDOW)); await drain() }
  vad.flush()
  await drain()
  if (cur) await decode(cur)
  progress(100)
  return out
}

// Audio-Ereignisse, Indizes aus class_labels_indices.csv: Shout 8, Yell 11, Screaming 14, Laughter 16, Giggle 18, Snicker 19,
// Belly laugh 20, „Chuckle, chortle“ 21, Cheering 66, Applause 67, Crowd 69. Snicker zusätzlich: Lachen von Publikum und
// Einzelnen ordnet CED-mini meist dort ein (gemessen 0,4–0,7, Laughter selbst nur 0,1–0,4).
const EVENTS = new Set([8, 11, 14, 16, 18, 19, 20, 21, 66, 67, 69])
// Musik (Copyright-Strikes in Clips): Singing 27, Music 137, Musical instrument 138, Background music 267, Video game music 272
const MUSIC = new Set([27, 137, 138, 267, 272])
// CED ist auf 10-s-Clips trainiert, erkennt Lachen und Applaus aber auch in 2-s-Fenstern; die Rechenzeit hängt kaum an der
// Fensterlänge, nur an der Überlappung (4 s mit Schritt 2 s kostet das Doppelte, ohne bessere Werte). Gemessen 09.10. auf
// AMD A4-9125: 1 Thread 0,022 s CPU je Audiosekunde, RTF 0,023 ohne Last (8 h Stream ≈ 11 min) bzw. 0,087 bei Last 8–9
// (≈ 42 min); 2 Threads verdoppeln die CPU-Zeit und sind auch ohne Last langsamer (RTF 0,028).
const TAG_WIN = 2 * SR

let ced: { key: string; t: Tagger } | null = null
async function tag({ pcm, models }: { pcm: Float32Array; models: string }, progress: (pct: number) => void): Promise<{ events: number[]; music: number[] }> {
  const dir = join(models, 'ced-mini')
  if (ced?.key !== models) ced = { key: models, t: new (sherpa().AudioTagging)({ model: { ced: join(dir, 'model.int8.onnx'), numThreads: 1, debug: 0 }, labels: join(dir, 'class_labels_indices.csv'), topK: 527 }) }
  const events: number[] = [], music: number[] = []
  for (let a = 0; a < pcm.length; a += TAG_WIN) {
    const w = new Float32Array(TAG_WIN) // letztes Stück mit Stille auf 2 s auffüllen: unter ~0,2 s bricht CED den Prozess ab
    w.set(pcm.subarray(a, a + TAG_WIN))
    const s = ced.t.createStream()
    s.acceptWaveform({ samples: w, sampleRate: SR })
    const r = ced.t.compute(s), max = (c: Set<number>) => at(Math.max(0, ...r.filter((e) => c.has(e.index)).map((e) => e.prob)))
    const e = max(EVENTS), m = max(MUSIC)
    for (let i = a; i < Math.min(pcm.length, a + TAG_WIN); i += SR) { events.push(e); music.push(m) } // je angefangene Sekunde ein Wert
    progress(Math.floor((a / pcm.length) * 99))
    if (a % (200 * TAG_WIN) === 199 * TAG_WIN) await new Promise(setImmediate) // Streams haben kein free(): Finalizer brauchen die Ereignisschleife
  }
  progress(100)
  return { events, music }
}

// Sprechertrennung: pyannote-segmentation-3.0 (10-s-Fenster) findet Turns, 3D-Speaker CAM++ (zh/en) bettet sie ein.
// Gemessen 09.10. (A4-9125, wenig Last) an JFK + Deutsch (42 s und 132 s) und zwei englischen Zwei-Sprecher-Aufnahmen:
// Fensterschritt 0,5 statt 0,1 rechnet 4,5-mal schneller (CPU 0,12 statt 0,57 s je Audiosekunde, RTF ~0,12; 1 h ≈ 7 min)
// bei gleichen Wechseln. Mit Schwelle 0,5 (Standard) zerfällt ein Sprecher über 2 min in mehrere; richtig in allen vier
// Proben ist CAM++ bei 0,7–0,8, TitaNet-small (CPU 0,10, ~15 % schneller) nur genau bei 0,8 – daher CAM++ mit 0,75.
// 2 Threads verdoppeln die CPU-Zeit ohne schneller zu sein.
const DIAR_SHIFT = 0.5, DIAR_THRESHOLD = 0.75, MIN_TURN = 0.5
let diarizer: { key: string; d: Diarizer } | null = null
interface DiarArgs { pcm: Float32Array; models: string; offset: number }
async function diar({ pcm, models, offset }: DiarArgs, progress: (pct: number) => void): Promise<Turn[]> {
  const dir = join(models, 'diarization')
  if (diarizer?.key !== models) diarizer = {
    key: models,
    d: new (sherpa().OfflineSpeakerDiarization)({
      segmentation: { pyannote: { model: join(dir, 'model.int8.onnx'), windowShiftRatio: DIAR_SHIFT }, numThreads: 1, debug: 0 },
      embedding: { model: join(dir, '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'), numThreads: 1, debug: 0 },
      clustering: { numClusters: -1, threshold: DIAR_THRESHOLD },
    }),
  }
  // processAsync statt process: rechnet im Thread-Pool und meldet je Sprecher-Einbettung Fortschritt (Lebenszeichen)
  const addon: { offlineSpeakerDiarizationProcessAsync(h: unknown, pcm: Float32Array, cb: (done: number, total: number) => void): Promise<Turn[]> } = require('sherpa-onnx-node/addon.js')
  const raw = await addon.offlineSpeakerDiarizationProcessAsync(diarizer.d.handle, pcm, (done, total) => progress(Math.floor((done / total) * 99)))
  const out: Turn[] = []
  for (const t of raw) { // nach Start sortiert; Turns unter 0,5 s (Zwischenrufe, „mhm“) hängen am Vorgänger
    const prev = out.at(-1)
    if (prev && (t.end - t.start < MIN_TURN || (t.speaker === prev.speaker && t.start - prev.end < MIN_TURN))) prev.end = Math.max(prev.end, t.end)
    else out.push({ ...t })
  }
  if (out.length > 1 && out[0].end - out[0].start < MIN_TURN) out[1].start = out.shift()!.start // kurzer erster Turn: am Nachfolger
  const ids = new Map<number, number>() // Sprecher in der Reihenfolge ihres ersten Auftretens
  for (const t of out) if (!ids.has(t.speaker)) ids.set(t.speaker, ids.size)
  progress(100)
  return out.map((t) => ({ start: at(t.start + offset), end: at(t.end + offset), speaker: ids.get(t.speaker)! }))
}

const OPS: Record<string, (args: never, progress: (pct: number) => void) => Promise<unknown>> = { asr, tag, diar }

let busy: Promise<unknown> = Promise.resolve() // ein Auftrag nach dem anderen: ein Modell, ein Satz Kerne
process.on('message', ({ id, op, args }: { id: number; op: string; args: never }) => {
  busy = busy.then(async () => {
    try {
      if (!OPS[op]) throw new Error(`Unbekannte Operation ${op}`)
      process.send!({ id, result: await OPS[op](args, (progress) => process.send!({ id, progress })) })
    } catch (e) { process.send!({ id, error: e instanceof Error ? e.message : String(e) }) }
  })
})
process.on('disconnect', () => process.exit()) // Main-Prozess weg: Modell nicht verwaist im RAM lassen
