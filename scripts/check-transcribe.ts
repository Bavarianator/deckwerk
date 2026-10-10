// Whisper lokal, opt-in (lädt einmalig ~510 MB nach $DECKWERK_HOME/models bzw. ~/.cache/deckwerk-check/models): npx esbuild scripts/check-transcribe.ts --bundle --packages=external --platform=node --format=esm --outfile=node_modules/.cache/check-transcribe.mjs && node node_modules/.cache/check-transcribe.mjs
import { deepStrictEqual as eq, ok } from 'node:assert'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { transcribePcm } from '../src/main/transcribe'

// JFK-Sample aus whisper.cpp (gemeinfrei), fester Commit
const WAV = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/d1be6fde11ac6e0407606b4e42fe72d34add8037/samples/jfk.wav'
const models = join(process.env.DECKWERK_HOME ?? join(homedir(), '.cache', 'deckwerk-check'), 'models') // nicht /tmp: dort oft tmpfs im RAM
const SENTENCE = 'ask not what your country can do for you'

/** PCM-16-WAV, 16 kHz, mono → f32 */
function parseWav(b: Buffer): Float32Array {
  ok(b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE', 'kein WAV')
  let fmt: number[] = []
  for (let o = 12; o + 8 <= b.length; ) {
    const id = b.toString('ascii', o, o + 4), len = b.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = [b.readUInt16LE(o + 8), b.readUInt16LE(o + 10), b.readUInt32LE(o + 12), b.readUInt16LE(o + 22)]
    if (id === 'data') {
      eq(fmt, [1, 1, 16000, 16], 'erwartet PCM, mono, 16 kHz, 16 bit')
      const pcm = new Float32Array(len / 2)
      for (let i = 0; i < pcm.length; i++) pcm[i] = b.readInt16LE(o + 8 + 2 * i) / 32768
      return pcm
    }
    o += 8 + len + (len & 1)
  }
  throw new Error('WAV ohne data-Chunk')
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]+/g, '').replace(/\s+/g, ' ')
const peak = () => (Number(/VmHWM:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))?.[1] ?? 0) / 1024 ** 2).toFixed(2)

async function run(pcm: Float32Array, label: string) {
  const pct: number[] = []
  const t0 = performance.now()
  const t = await transcribePcm(pcm, models, (p) => pct.push(p))
  const secs = (performance.now() - t0) / 1000
  console.log(label, JSON.stringify(t, null, 1))
  console.log(`${label}: ${secs.toFixed(1)} s für ${t.duration.toFixed(1)} s Audio, Echtzeitfaktor ${(secs / t.duration).toFixed(2)}, Spitze ${peak()} GB RSS`)
  ok(pct[0] === 0 && pct.at(-1) === 100 && pct.every((p, i) => !i || p > pct[i - 1]), `Fortschritt nicht monoton 0…100: ${pct}`)
  let prev = 0
  for (const s of t.segments) {
    ok(s.start >= prev - 1e-9 && s.end >= s.start && s.end <= t.duration + 0.1, `Zeiten nicht aufsteigend/im Audio: ${JSON.stringify(s)}`)
    ok(s.text && s.text === s.text.trim(), 'leeres oder ungetrimmtes Segment')
    prev = s.end
  }
  return t
}

const res = await fetch(WAV)
ok(res.ok, `WAV-Download fehlgeschlagen (${res.status})`)
const pcm = parseWav(Buffer.from(await res.arrayBuffer()))

const a = await run(pcm, 'JFK')
eq(a.lang, 'en')
ok(norm(a.segments.map((s) => s.text).join(' ')).includes(SENTENCE), 'Satz nicht erkannt')
ok(a.duration < 11.1)

// Langform: 3× hintereinander (33 s) geht über die 30-s-Grenze
const pcm3 = new Float32Array(pcm.length * 3)
for (let k = 0; k < 3; k++) pcm3.set(pcm, k * pcm.length)
const b = await run(pcm3, 'JFK×3')
eq(b.lang, 'en')
eq(norm(b.segments.map((s) => s.text).join(' ')).split(SENTENCE).length - 1, 3, 'Satz nicht genau 3×')
const starts = b.segments.filter((s) => norm(s.text).includes('ask not')).map((s) => s.start)
eq(starts.length, 3, '„ask not“ nicht in 3 Segmenten')
starts.forEach((s, k) => ok(s >= k * a.duration - 1 && s <= k * a.duration + 8, `Wiederholung ${k + 1} beginnt bei ${s} s`))
console.log('check-transcribe: ok')
