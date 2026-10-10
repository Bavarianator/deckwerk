// Rechnungen hinter Engine.video (engine.ts): Chunk-Planung des Transkripts, Sprecherzuordnung, Chat je Sekunde.
// Ohne Electron und ohne I/O, damit der Selbsttest sie unter Node prüft (scripts/check-engine-video.ts). Zeiten in Sekunden.
import type { Segment } from '../shared/video'

export type Turn = { start: number; end: number; speaker: number }
export const CHUNK = 300 // Transkript-Raster; je Chunk eine Cache-Datei
const LEAD = 2, SEG_MAX = 30 // Vorlauf vor dem Chunk; ein Sprachstück (und damit ein Segment) ist höchstens 30 s lang

/** Erkennung, die lang verlangt (undefined = jede): fremde Sprachen Whisper; ist sherpa nicht nutzbar (whisperOnly), genügt auch
 *  gecachtes Whisper, sonst rechnete jeder Aufruf es neu. */
export function engineFor(lang: string | undefined, parakeetLangs: readonly string[], whisperOnly: boolean): 'parakeet' | 'whisper' | undefined {
  if (!lang) return undefined
  return !parakeetLangs.includes(lang.toLowerCase().split(/[-_]/)[0]) ? 'whisper' : whisperOnly ? undefined : 'parakeet'
}

/** Gelesener Tonbereich für Chunk k: 2 s Vorlauf, 30 s Überhang (ein Segment, das kurz vor dem Ende beginnt, wird ganz erkannt), an die Videolänge geklemmt. */
export const chunkWindow = (k: number, duration: number) => {
  const from = Math.max(0, k * CHUNK - LEAD)
  return { from, dur: Math.min(k * CHUNK + CHUNK + SEG_MAX, duration) - from }
}

/** Stücke der Länge size, deren Inhalt in die Bereiche reichen kann, aufsteigend. Transkript: ein Segment ab bis zu 30 s (back) vor dem Bereich ragt hinein, daher dessen Chunk mit. */
export function chunksIn(ranges: [number, number][], duration: number, size = CHUNK, back = SEG_MAX): number[] {
  const ks = new Set<number>()
  for (const [from, to] of ranges)
    for (let k = Math.floor(Math.max(0, from - back) / size); k * size < Math.min(to, duration); k++) ks.add(k)
  return [...ks].sort((a, b) => a - b)
}

/** Segmente, die in Chunk k beginnen: Vor- und Überhang erkennen dieselben Segmente doppelt, jedes zählt nur in seinem Chunk. */
export const inChunk = (segs: Segment[], k: number) => segs.filter((s) => s.start >= k * CHUNK && s.start < (k + 1) * CHUNK)

/** Segmente aller Chunks nach Start; ein Segment, das zu mehr als der Hälfte in einem schon übernommenen liegt, fällt weg
 *  (an der Naht setzt die VAD im zweiten Chunk leicht anders an, dasselbe Gesagte beginnt dann knapp hinter der Grenze). */
export function mergeSegments(segs: Segment[]): Segment[] {
  const out: Segment[] = []
  for (const s of [...segs].sort((a, b) => a.start - b.start)) {
    let dup = false
    for (let j = out.length - 1; j >= 0 && !dup && out[j].start > s.start - SEG_MAX; j--)
      dup = Math.min(s.end, out[j].end) - Math.max(s.start, out[j].start) > (s.end - s.start) / 2
    if (!dup) out.push(s)
  }
  return out
}

/** Transkribierte Bereiche aus den vorhandenen Chunks, Nachbarn verbunden. */
export function coveredOf(ks: number[], duration: number): [number, number][] {
  const out: [number, number][] = []
  for (const k of [...ks].sort((a, b) => a - b)) {
    const a = k * CHUNK, b = Math.min((k + 1) * CHUNK, duration), last = out.at(-1)
    if (last && last[1] >= a) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** speaker je Segment = Sprecher mit der größten zeitlichen Überlappung; ohne Überlappung bleibt es leer. */
export function withSpeakers(segs: Segment[], turns: Turn[]): Segment[] {
  return segs.map((s) => {
    const talk = new Map<number, number>()
    for (const t of turns) {
      const o = Math.min(s.end, t.end) - Math.max(s.start, t.start)
      if (o > 0) talk.set(t.speaker, (talk.get(t.speaker) ?? 0) + o)
    }
    const best = [...talk].sort((a, b) => b[1] - a[1])[0]
    return best ? { ...s, speaker: best[0] } : s
  })
}

/** Chat-Aufzeichnung (ytdlp.ts: [{ t, w }]) → Gewicht je Sekunde, n Sekunden lang. Kaputte Einträge fallen weg (Datei von der Platte). */
export function chatPerSecond(chat: unknown[], n: number): number[] {
  const out = new Array<number>(n).fill(0)
  for (const x of chat) {
    const { t, w } = (x ?? {}) as { t?: unknown; w?: unknown }
    if (typeof t === 'number' && typeof w === 'number' && Number.isFinite(w) && t >= 0 && t < n) out[Math.floor(t)] += w
  }
  return out
}

/** Bereiche für die Ereignis-Erkennung: Sekunden über Median + 6 dB, je ±5 s, verbunden. Leise Stellen spart der Tagger. */
export function loudRanges(loud: number[]): [number, number][] {
  const s = [...loud].sort((a, b) => a - b), med = s[s.length >> 1] ?? -100
  const out: [number, number][] = []
  loud.forEach((v, i) => {
    if (!(v > med + 6)) return
    const a = Math.max(0, i - 5), b = Math.min(loud.length, i + 6), last = out.at(-1)
    if (last && last[1] >= a) last[1] = b
    else out.push([a, b])
  })
  return out
}
