// Sprecherstimme für Film-Decks (Feature Animation): Sprechertext → WAV + Zeitplan je Satz und Takt (VoiceTiming aus shared/film.ts).
// Lokal und kostenlos über Piper (sherpa.ts tts). Ergebnis im Cache nach Hash: Player und Export bekommen dieselbe Tonspur ohne neue Synthese.
// Ohne Electron, damit der Selbsttest unter Node läuft (scripts/check-voice.ts).
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VoiceId } from '../shared/deck'
import { VOICE_SPEED, voiceChunks, voiceTiming, type VoiceTiming } from '../shared/film'
import { wav as wav16k } from './phone'
import { TTS, tts } from './sherpa'

// Abkürzungen buchstabiert espeak-ng (Phonemisierung in Piper) oder liest sie als Wort („Nr.“ → „Närr“, „ggf.“ → „gegen F“): ausschreiben.
// Geprüft 17.10. per Rückweg Thorsten → FC-DE-Erkennung. Richtig ohne Hilfe: 42 %, 5 €, &, 1.234,5, 3,5 und „KI“ (Großbuchstaben-Wort
// unter 4 Zeichen in einem kleingeschriebenen Satz buchstabiert espeak selbst). Nur für die Synthese, Untertitel zeigen den Originaltext.
// ponytail: nur die Abkürzungen, die voiceChunks (film.ts) kennt, plus z. B./d. h./u. a.; Englisch ohne Liste
const DE: [string, string][] = [
  ['z. B.', 'zum Beispiel'], ['d. h.', 'das heißt'], ['u. a.', 'unter anderem'], ['bzw.', 'beziehungsweise'], ['ca.', 'circa'], ['usw.', 'und so weiter'],
  ['etc.', 'et cetera'], ['vgl.', 'vergleiche'], ['Nr.', 'Nummer'], ['Dr.', 'Doktor'], ['Prof.', 'Professor'], ['inkl.', 'inklusive'],
  ['ggf.', 'gegebenenfalls'], ['evtl.', 'eventuell'], ['vs.', 'versus'], ['Mio.', 'Millionen'], ['Mrd.', 'Milliarden'], ['Tsd.', 'Tausend'],
]
const SAY: Record<VoiceId, [RegExp, string][]> = {
  de: DE.map(([a, to]) => [new RegExp(`(?<!\\p{L})${a.replace(/\./g, '\\.').replace(/ /g, '\\s?')}`, 'giu'), to]), // „z.B.“ wie „z. B.“
  en: [],
}
const say = (s: string, voice: VoiceId) => SAY[voice].reduce((t, [re, to]) => t.replace(re, to), s)
const CACHE_V = 1 // erhöhen, wenn sich SAY oder das Zusammensetzen der Tonspur ändert: alte Cache-Einträge gelten dann nicht mehr

/** Sprechertext → WAV (16 bit mono) und Zeitplan. Sätze aus voiceChunks (ohne [klick]), dazwischen die Pausen aus voiceTiming. */
export async function synthesize(text: string, o: { voice: VoiceId; speed?: number; models: string; cacheDir: string; onProgress?: (pct: number) => void }): Promise<{ wav: string; timing: VoiceTiming }> {
  const chunks = voiceChunks(text), sentences = chunks.flat()
  if (!sentences.length) throw new Error('Kein Sprechertext: Die Szene hat nichts, was die Stimme sprechen könnte.')
  const speed = Math.min(VOICE_SPEED.max, Math.max(VOICE_SPEED.min, o.speed ?? 1))
  const key = createHash('sha256').update(JSON.stringify([CACHE_V, o.voice, TTS[o.voice][1], speed, text])).digest('hex')
  const wav = join(o.cacheDir, `${key}.wav`), json = join(o.cacheDir, `${key}.json`)
  if (existsSync(wav) && existsSync(json)) return { wav, timing: JSON.parse(await readFile(json, 'utf8')) }

  const { samples, sampleRate: sr } = await tts(sentences.map((s) => say(s, o.voice)), { voice: o.voice, speed, models: o.models, onProgress: o.onProgress })
  let i = 0
  const durs = chunks.map((beat) => beat.map(() => samples[i++].length / sr))
  const timing = voiceTiming(chunks, durs)
  const pcm = new Float32Array(Math.round(timing.total * sr))
  // Rundung auf Samples: der letzte Satz kann um ein Sample über total hinausragen
  timing.cues.forEach((c, k) => pcm.set(samples[k].subarray(0, pcm.length - Math.round(c.start * sr)), Math.round(c.start * sr)))
  const buf = wav16k(pcm)
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28) // phone.wav schreibt 16 kHz in den Kopf, Piper liefert 22 050 Hz
  await mkdir(o.cacheDir, { recursive: true })
  // je Prozess über .tmp + rename: Player und Export lesen nie eine halbe Datei; json zuletzt, erst damit gilt der Eintrag als fertig
  for (const [f, data] of [[wav, buf], [json, JSON.stringify(timing)]] as const) {
    await writeFile(`${f}.${process.pid}.tmp`, data)
    await rename(`${f}.${process.pid}.tmp`, f)
  }
  return { wav, timing }
}
