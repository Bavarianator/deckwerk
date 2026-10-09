// Kindprozess für sherpa-onnx, gestartet von sherpa.ts per fork (Gründe dort). Nachrichten {id, op, args} →
// {id, progress} | {id, result} | {id, error}. Weitere Ops kommen in OPS dazu.
import { join } from 'node:path'
import type { Segment, Word } from '../shared/video'

// sherpa-onnx-node bringt keine Typen mit; nur das Benutzte
interface Result { text: string; tokens: string[]; timestamps: number[]; durations?: number[] }
interface Stream { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void }
interface Recognizer { createStream(): Stream; decodeAsync(s: Stream): Promise<Result> }
interface Vad { acceptWaveform(s: Float32Array): void; isEmpty(): boolean; front(external: boolean): { start: number; samples: Float32Array }; pop(): void; flush(): void }
const sherpa: {
  OfflineRecognizer: { createAsync(config: object): Promise<Recognizer> }
  Vad: new (config: object, bufferSeconds: number) => Vad
} = require('sherpa-onnx-node')

const SR = 16000, WINDOW = 512, MAX = 30 * SR, GAP = 2 * SR

let rec: { key: string; r: Promise<Recognizer> } | null = null
function recognizer(models: string, threads: number): Promise<Recognizer> {
  const key = `${models}|${threads}`, dir = join(models, 'parakeet-v3')
  if (rec?.key !== key) rec = {
    key,
    r: sherpa.OfflineRecognizer.createAsync({
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

/** Segmente = Sätze (Bruch nach . ! ? …). */
function sentences(ws: Word[]): Segment[] {
  const out: Segment[] = []
  let cur: Word[] = []
  const flush = () => { if (cur.length) out.push({ start: cur[0].start, end: cur.at(-1)!.end, text: cur.map((w) => w.w).join(' '), words: cur }); cur = [] }
  for (const w of ws) { cur.push(w); if (/[.!?…]$/.test(w.w)) flush() }
  flush()
  return out
}

interface AsrArgs { pcm: Float32Array; models: string; offset: number; threads: number }
async function asr({ pcm, models, offset, threads }: AsrArgs, progress: (pct: number) => void): Promise<Segment[]> {
  const r = await recognizer(models, threads)
  // Vorträge/Streams: Pausen ab 0,4 s sind Schnittstellen, einzelne Sprachstücke höchstens 20 s (danach sucht Silero die
  // nächste kurze Pause). Folgestücke mit Pausen bis 2 s erkennt Parakeet gemeinsam (bis 30 s): Einzeln setzte es an jeder
  // Pause einen Punkt („Ask not. What your country …“) und verlor den Satzzusammenhang.
  const vad = new sherpa.Vad({
    sileroVad: { model: join(models, 'silero-vad', 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.4, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: WINDOW },
    sampleRate: SR, numThreads: 1, debug: 0,
  }, 60)
  const out: Segment[] = []
  let cur: [number, number] | null = null, shown = -1 // gesammeltes Stück pcm[a, b)
  const decode = async ([a, b]: [number, number]) => {
    const s = r.createStream()
    s.acceptWaveform({ samples: pcm.subarray(a, b), sampleRate: SR })
    out.push(...sentences(words(await r.decodeAsync(s), offset + a / SR, offset + b / SR)))
    const pct = Math.floor((b / pcm.length) * 99)
    if (pct > shown) progress((shown = pct))
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

const OPS: Record<string, (args: never, progress: (pct: number) => void) => Promise<unknown>> = { asr }

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
