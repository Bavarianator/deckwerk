// Transkript mit Zeitmarken, lokal und offline: Whisper small von OpenAI (Gewichte MIT, Modellkarte Apache-2.0) als ONNX
// von https://huggingface.co/onnx-community/whisper-small über onnxruntime-node. Lädt beim ersten Einsatz ~510 MB nach
// <modelDir>/whisper-small. Ohne Electron, damit der Selbsttest unter Node läuft (scripts/check-transcribe.ts).
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { freemem } from 'node:os'
import { join } from 'node:path'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import type { Segment, Transcript } from '../shared/video'
import { download } from './download'

// fester Commit + Prüfsummen (wie bg-remove.ts): ein nachträglich verändertes Modell landet nie im nativen ONNX-Parser
const REPO = 'https://huggingface.co/onnx-community/whisper-small/resolve/36050c46d777d46dc4b5f43f6d90574fc38f8732/'
const FILES: [path: string, sha256: string, bytes: number][] = [
  ['onnx/encoder_model.onnx', 'b37cd6625dc36f9178ec7539a1876b9680ea26a910097e092be39dc766320c7b', 352825870], // fp32: der int8-Encoder erkennt spürbar schlechter
  ['onnx/decoder_model_merged_int8.onnx', 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9', 156750845],
  ['tokenizer.json', '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566', 2480466],
  ['generation_config.json', 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0', 3893], // suppress_tokens, Sprach-Token
]
const local = (dir: string, p: string) => join(dir, 'whisper-small', p.split('/').pop()!)

const SR = 16000, N_FFT = 400, HOP = 160, N_MELS = 80, FRAMES = 3000, BINS = N_FFT / 2 + 1
const SAMPLES = FRAMES * HOP // 30 s je Fenster
const MAX_TOKENS = 224, TS = 0.02 // Zeitstempel-Raster = 2 Mel-Frames

// DFT-Tabellen, periodisches Hann-Fenster und Slaney-Mel-Filter (librosa.filters.mel, norm='slaney', 0–8000 Hz)
const WIN = new Float64Array(N_FFT), COS = new Float64Array(BINS * N_FFT), SIN = new Float64Array(BINS * N_FFT), MEL = new Float64Array(N_MELS * BINS)
for (let n = 0; n < N_FFT; n++) WIN[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT)
for (let k = 0; k < BINS; k++)
  for (let n = 0; n < N_FFT; n++) {
    const a = (2 * Math.PI * ((k * n) % N_FFT)) / N_FFT
    COS[k * N_FFT + n] = Math.cos(a)
    SIN[k * N_FFT + n] = Math.sin(a)
  }
{
  const step = Math.log(6.4) / 27
  const toMel = (f: number) => (f < 1000 ? (3 * f) / 200 : 15 + Math.log(f / 1000) / step)
  const toHz = (m: number) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp(step * (m - 15)))
  const f = Array.from({ length: N_MELS + 2 }, (_, i) => toHz((toMel(SR / 2) * i) / (N_MELS + 1)))
  for (let m = 0; m < N_MELS; m++)
    for (let k = 0; k < BINS; k++) {
      const hz = (k * SR) / N_FFT
      const w = Math.max(0, Math.min((hz - f[m]) / (f[m + 1] - f[m]), (f[m + 2] - hz) / (f[m + 2] - f[m + 1])))
      MEL[m * BINS + k] = (2 * w) / (f[m + 2] - f[m])
    }
}

// GPT-2-Byte-BPE: jedes Byte steht im Vokabular als druckbares Zeichen; umkehren und als UTF-8 lesen
const BYTE = new Map<string, number>()
for (let b = 0, n = 0; b < 256; b++) BYTE.set(String.fromCharCode((b > 32 && b < 127) || (b > 160 && b !== 173) ? b : 256 + n++), b)
const utf8 = new TextDecoder()

/** Log-Mel wie WhisperFeatureExtractor: auf 30 s mit Nullen aufgefüllt, Reflect-Padding, |DFT|², log10, Dynamik 80 dB, (x+4)/4. */
function logMel(chunk: Float32Array): Float32Array {
  const P = N_FFT / 2, x = new Float64Array(SAMPLES + N_FFT)
  x.set(chunk, P)
  for (let i = 1; i <= P; i++) { x[P - i] = x[P + i]; x[P + SAMPLES - 1 + i] = x[P + SAMPLES - 1 - i] }
  const out = new Float32Array(N_MELS * FRAMES), fr = new Float64Array(N_FFT), pow = new Float64Array(BINS)
  let max = -Infinity
  for (let t = 0; t < FRAMES; t++) {
    for (let n = 0; n < N_FFT; n++) fr[n] = x[t * HOP + n] * WIN[n]
    for (let k = 0; k < BINS; k++) {
      let re = 0, im = 0
      for (let n = 0, o = k * N_FFT; n < N_FFT; n++) { re += fr[n] * COS[o + n]; im += fr[n] * SIN[o + n] }
      pow[k] = re * re + im * im
    }
    for (let m = 0; m < N_MELS; m++) {
      let s = 0
      for (let k = 0, o = m * BINS; k < BINS; k++) s += MEL[o + k] * pow[k]
      const v = Math.log10(Math.max(s, 1e-10))
      out[m * FRAMES + t] = v
      if (v > max) max = v
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], max - 8) + 4) / 4
  return out
}

interface Model {
  enc: InferenceSession; dec: InferenceSession; logits: string; cached: string[] // Ausgaben im Cache-Schritt: Logits + Decoder-Past
  vocab: string[]; langs: [code: string, id: number][]; suppress: number[]; beginSuppress: number[]
  sot: number; eot: number; transcribe: number; noSpeech: number; ts0: number
}
let model: Promise<Model> | null = null

function load(dir: string, onProgress: (pct: number) => void): Promise<Model> {
  return (model ??= (async () => {
    const missing = FILES.filter(([p]) => !existsSync(local(dir, p)))
    const total = missing.reduce((s, f) => s + f[2], 0)
    let done = 0
    if (missing.length) await mkdir(join(dir, 'whisper-small'), { recursive: true })
    for (const [p, sha, bytes] of missing) {
      await download(REPO + p, sha, local(dir, p), (pct) => onProgress(((done + (bytes * pct) / 100) / total) * 100))
      done += bytes
    }
    const tok = JSON.parse(await readFile(local(dir, 'tokenizer.json'), 'utf8'))
    const gen = JSON.parse(await readFile(local(dir, 'generation_config.json'), 'utf8'))
    const vocab: string[] = []
    for (const [s, i] of Object.entries(tok.model.vocab as Record<string, number>)) vocab[i] = s
    const special = new Map((tok.added_tokens as { content: string; id: number }[]).map((t) => [t.content, t.id]))
    const id = (s: string) => { const i = special.get(s); if (i === undefined) throw new Error(`Whisper-Tokenizer ohne ${s}`); return i }

    const ort = await import('onnxruntime-node')
    // Speicher sparen statt Tempo (wie bg-remove.ts): ohne Arena/Memory-Pattern werden Zwischenpuffer sofort freigegeben
    const opts = { executionProviders: ['cpu'], graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false, executionMode: 'sequential' } as const
    const enc = await ort.InferenceSession.create(local(dir, FILES[0][0]), opts)
    const dec = await ort.InferenceSession.create(local(dir, FILES[1][0]), opts)
    const logits = dec.outputNames.find((n) => !n.startsWith('present.'))!
    return {
      enc, dec, logits, cached: dec.outputNames.filter((n) => n === logits || n.includes('.decoder.')),
      vocab, langs: Object.entries(gen.lang_to_id as Record<string, number>).map(([k, i]): [string, number] => [k.slice(2, -2), i]),
      suppress: gen.suppress_tokens, beginSuppress: gen.begin_suppress_tokens,
      sot: id('<|startoftranscript|>'), eot: id('<|endoftext|>'), transcribe: id('<|transcribe|>'), noSpeech: id('<|nocaptions|>'), ts0: id('<|0.00|>'),
    }
  })().catch((e) => { model = null; throw e }))
}

function logSumExp(l: Float32Array, from = 0, to = l.length) {
  let max = -Infinity, s = 0
  for (let i = from; i < to; i++) if (l[i] > max) max = l[i]
  if (max === -Infinity) return max
  for (let i = from; i < to; i++) s += Math.exp(l[i] - max)
  return max + Math.log(s)
}

/** Nächstes Token (greedy) nach den Zeitstempel-Regeln von OpenAI-Whisper, vereinfacht. l wird dabei maskiert. */
function pick(l: Float32Array, seq: number[], m: Model): number {
  const { eot, sot, ts0 } = m, NO = -Infinity
  for (const i of m.suppress) l[i] = NO
  l.fill(NO, sot, ts0) // Sprach-, Aufgaben- und <|notimestamps|>-Token nie im Text
  if (!seq.length) {
    for (const i of m.beginSuppress) l[i] = NO
    l.fill(NO, 0, ts0) // jedes Fenster beginnt mit einem Zeitstempel …
    l.fill(NO, ts0 + 51) // … von höchstens 1,0 s (max_initial_timestamp_index 50)
  } else {
    const last = seq.at(-1)! >= ts0, pen = seq.length < 2 || seq.at(-2)! >= ts0
    // paarweise: nach einem Paar folgt Text oder Ende, nach einem einzelnen Zeitstempel der zweite oder das Ende
    if (last) { if (pen) l.fill(NO, ts0); else l.fill(NO, 0, eot) }
    const prev = seq.findLast((x) => x >= ts0)
    if (prev !== undefined) l.fill(NO, ts0, last && !pen ? prev : prev + 1) // monoton steigend, kein Segment ohne Länge
  }
  let best = 0, maxText = NO
  for (let i = 0; i < ts0; i++) if (l[i] > maxText) maxText = l[i]
  if (logSumExp(l, ts0) > maxText) l.fill(NO, 0, ts0) // Zeitstempel zusammen wahrscheinlicher als das beste Text-Token
  for (let i = 1; i < l.length; i++) if (l[i] > l[best]) best = i
  return best
}

/** Endet der Text mit demselben n-Gramm 5× hintereinander (Wiederholungsschleife), Index der 2. Wiederholung, sonst -1. */
function loopAt(t: number[]): number {
  for (let n = 1; n <= 10 && 5 * n <= t.length; n++) {
    let i = t.length - 4 * n
    while (i < t.length && t[i] === t[i - n]) i++
    if (i === t.length) return t.length - 4 * n
  }
  return -1
}

/** Whisper-Transkript aus 16 kHz mono f32. onProgress 0–100 (beim ersten Mal 0–30 Download, danach Erkennung). */
export async function transcribePcm(pcm: Float32Array, modelDir: string, onProgress: (pct: number) => void = () => {}): Promise<Transcript> {
  // Schutz vor dem OOM-Killer (wie bg-remove.ts): gemessen RSS+Swap ~0,8 GB für die geladenen Sessions (davon ~0,2 GB
  // vorgepackte Encoder-Gewichte) und ~1,5 GB Spitze im ersten Fenster (Encoder-Lauf, Cross-Attention-Cache 110 MB im JS).
  // Unter Linux beendet der Kernel sonst womöglich die ganze App; macOS zählt den Datei-Cache als belegt, dort nicht sperren.
  const need = model ? 1 : 1.8 // geladene Sessions belegen ihren Teil schon
  if (process.platform === 'linux' && freemem() < need * 1024 ** 3) throw new Error(`Zu wenig freier Arbeitsspeicher für die Spracherkennung (${(freemem() / 1024 ** 3).toFixed(1)} GB frei, nötig ca. ${need.toLocaleString('de')} GB). Andere Programme schließen und erneut versuchen.`)
  let shown = -1
  const report = (p: number) => { p = Math.floor(p); if (p > shown) onProgress((shown = p)) }
  report(0)
  const base = FILES.some(([p]) => !existsSync(local(modelDir, p))) ? 30 : 0
  const m = await load(modelDir, (p) => report((p * base) / 100))
  const ort = await import('onnxruntime-node')
  const { sot, eot, ts0 } = m
  const duration = pcm.length / SR, total = Math.ceil(pcm.length / HOP) // Mel-Frames des ganzen Audios
  const say = (ids: number[]) => utf8.decode(Uint8Array.from(ids.filter((i) => i < eot).flatMap((i) => [...m.vocab[i]].map((c) => BYTE.get(c)!))))
  const at = (s: number) => Math.round(Math.min(s, duration) * 100) / 100
  const empty: Record<string, Tensor> = {} // Past der Länge 0 für den ersten Schritt
  for (const x of m.dec.inputMetadata)
    if (x.name.startsWith('past_key_values.')) empty[x.name] = new ort.Tensor('float32', new Float32Array(0), (x.isTensor ? x.shape : []).map((d, i) => (i === 0 ? 1 : typeof d === 'number' ? d : 0)))

  const segments: Segment[] = []
  let seek = 0, lang = '', langId = 0
  while (seek < total) {
    const size = Math.min(FRAMES, total - seek), offset = (seek * HOP) / SR
    const mel = logMel(pcm.subarray(seek * HOP, (seek + size) * HOP))
    const hidden = (await m.enc.run({ [m.enc.inputNames[0]]: new ort.Tensor('float32', mel, [1, N_MELS, FRAMES]) }))[m.enc.outputNames[0]]
    const step = async (ids: number[], past: Record<string, Tensor> | null, fetch = past ? m.cached : m.dec.outputNames) => {
      const out = await m.dec.run({
        ...(past ?? empty), encoder_hidden_states: hidden,
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        use_cache_branch: new ort.Tensor('bool', [!!past], [1]),
      }, fetch) // im Cache-Schritt die ~110 MB Encoder-Past nicht erneut abholen
      const next = { ...past } // Encoder-Past aus dem ersten Schritt bleibt
      for (const [k, v] of Object.entries(out)) if (k.startsWith('present.')) next[k.replace('present.', 'past_key_values.')] = v
      const l = out[m.logits]
      return { rows: l.data as Float32Array, V: l.dims[2], past: next }
    }
    if (!lang) { // Sprache im ersten Fenster erkennen, dann festhalten
      const { rows } = await step([sot], null, [m.logits])
      ;[lang, langId] = m.langs.reduce((a, b) => (rows[b[1]] > rows[a[1]] ? b : a))
    }
    let { rows, V, past } = await step([sot, langId, m.transcribe], null)
    const noSpeech = Math.exp(rows[m.noSpeech] - logSumExp(rows.subarray(0, V)))
    const toks: number[] = [], text: number[] = [] // text: Positionen der Text-Token in toks
    let logprob = 0
    while (toks.length < MAX_TOKENS) {
      const l = rows.subarray(rows.length - V)
      const tok = pick(l, toks, m)
      logprob += l[tok] - logSumExp(l)
      if (tok === eot) break
      toks.push(tok)
      if (tok < eot) {
        text.push(toks.length - 1)
        const cut = loopAt(text.map((i) => toks[i]))
        if (cut >= 0) { toks.length = text[cut]; break }
      }
      ;({ rows, past } = await step([tok], past))
    }

    let advance = size
    // Stille: Whisper erfindet dort sonst Text („Untertitel im Auftrag des ZDF“); Schwellen wie OpenAI-Whisper
    if (!(noSpeech > 0.6 && logprob / (toks.length + 1) < -1)) {
      const add = (ids: number[], start: number, end: number) => {
        const t = say(ids).trim()
        if (t) segments.push({ start: at(start), end: at(end), text: t })
      }
      const isTs = (i: number) => toks[i] >= ts0
      const single = toks.length >= 2 && !isTs(toks.length - 2) && isTs(toks.length - 1) // endet mit einzelnem Zeitstempel
      const cuts: number[] = []
      for (let i = 1; i < toks.length; i++) if (isTs(i - 1) && isTs(i)) cuts.push(i)
      if (cuts.length) {
        if (single) cuts.push(toks.length)
        let from = 0
        for (const c of cuts) {
          const s = toks.slice(from, c)
          add(s, offset + (s[0] - ts0) * TS, offset + (s.at(-1)! - ts0) * TS)
          from = c
        }
        // ab dem letzten vollständigen Paar weiter; was danach kam, erkennt das nächste Fenster neu
        if (!single) advance = (toks[from - 1] - ts0) * 2 || size
      } else {
        const last = toks.findLast((t) => t >= ts0)
        add(toks, offset, offset + (last !== undefined && last > ts0 ? (last - ts0) * TS : size * HOP / SR))
      }
    }
    seek += advance
    report(base + ((100 - base) * Math.min(seek, total)) / total)
    await new Promise(setImmediate) // Main-Prozess zwischen den Fenstern reagieren lassen
  }
  report(100)
  return { duration, lang, segments }
}
