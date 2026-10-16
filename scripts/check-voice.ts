// Sprecherstimme lokal (lädt einmalig je Stimme ~67 MB nach $DW_MODELS bzw. ~/.cache/deckwerk-check/models): npx esbuild scripts/check-voice.ts --bundle --packages=external --platform=node --format=esm --outfile=out/check-voice.mjs && npx esbuild src/main/sherpa-worker.ts --bundle --packages=external --platform=node --format=cjs --outfile=out/sherpa-worker.cjs && node out/check-voice.mjs
// DW_VOICE_CACHE setzt den Cache-Ordner (wird zu Beginn geleert)
import { ok, rejects } from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VoiceId } from '../src/shared/deck'
import { ensureVoice, stopWorker } from '../src/main/sherpa'
import { synthesize } from '../src/main/voice'

process.env.DECKWERK_SHERPA_WORKER ??= fileURLToPath(new URL('./sherpa-worker.cjs', import.meta.url)) // Worker-Bündel daneben
const models = process.env.DW_MODELS ?? join(homedir(), '.cache', 'deckwerk-check', 'models') // nicht /tmp: dort oft tmpfs im RAM
const cacheDir = process.env.DW_VOICE_CACHE ?? join(homedir(), '.cache', 'deckwerk-e2e', 'check-voice')
rmSync(cacheDir, { recursive: true, force: true })

async function run(voice: VoiceId, text: string, label: string) {
  await ensureVoice(voice, models) // Download nicht mitmessen
  const pcts: number[] = [], t0 = performance.now(), r = await synthesize(text, { voice, models, cacheDir, onProgress: (p) => pcts.push(p) })
  const secs = (performance.now() - t0) / 1000, b = readFileSync(r.wav), sr = b.readUInt32LE(24), len = (b.length - 44) / 2 / sr
  ok(b.toString('latin1', 0, 4) === 'RIFF' && b.readUInt16LE(34) === 16, 'kein 16-bit-WAV')
  ok(pcts.at(-1) === 100 && pcts.every((p, i) => !i || p >= pcts[i - 1]), `Fortschritt ${pcts}`)
  ok(Math.abs(len - r.timing.total) <= 0.05, `WAV ${len.toFixed(2)} s, Zeitplan ${r.timing.total.toFixed(2)} s`)
  console.log(`${voice} ${label}: ${len.toFixed(2)} s Audio in ${secs.toFixed(2)} s, RTF ${(secs / len).toFixed(2)}, Takte ${r.timing.beats.map((x) => x.toFixed(2)).join(' ')}`)
  return { ...r, len }
}

const de = 'Hallo Welt. Das ist ein Test. [klick] Zweiter Takt mit 42 % mehr Tempo.'
const a = await run('de', de, 'mit Modell laden')
ok(a.len > 1, 'WAV zu kurz')
ok(a.timing.beats.length === 2 && a.timing.beats[0] === 0 && a.timing.beats[1] > 0.5, `Takte ${a.timing.beats}`)
ok(a.timing.cues.length === 3, `${a.timing.cues.length} Sätze statt 3`)
// Platzierung: vor dem zweiten Satz Stille (PAUSE.sentence), danach Sprache
const w = readFileSync(a.wav), sr = w.readUInt32LE(24)
ok(sr === 22050, `Samplerate ${sr} statt 22050 (Piper medium)`)
const rms = (from: number, to: number) => {
  let s = 0, n = 0
  for (let i = Math.round(from * sr); i < Math.round(to * sr); i++, n++) s += (w.readInt16LE(44 + i * 2) / 32768) ** 2
  return Math.sqrt(s / n)
}
const c1 = a.timing.cues[1].start, still = rms(c1 - 0.2, c1 - 0.02), voiced = rms(c1, c1 + 0.4)
ok(still < 0.002 && voiced > 0.02, `Pause vor Satz 2: RMS ${still.toFixed(4)}, danach ${voiced.toFixed(4)}`)

const t0 = performance.now(), again = await synthesize(de, { voice: 'de', models, cacheDir }), ms = performance.now() - t0
ok(again.wav === a.wav && again.timing.total === a.timing.total, 'Cache liefert anderes Ergebnis')
ok(ms < 300, `Cache-Treffer dauerte ${ms.toFixed(0)} ms`)
console.log(`de aus dem Cache: ${ms.toFixed(0)} ms`)
await run('de', 'Jetzt ist das Modell geladen, also zählt nur noch die Synthese.', 'Modell geladen')

const e = await run('en', 'This is a short test.', 'mit Modell laden')
ok(e.len > 0.5 && e.timing.cues.length === 1, 'englische Stimme')

await rejects(synthesize(' [klick] ', { voice: 'de', models, cacheDir }), /Kein Sprechertext/)
stopWorker()
console.log('check-voice: ok')
