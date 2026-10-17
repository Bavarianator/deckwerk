// Selbstprüfung: npx esbuild src/shared/podcast.ts --bundle --platform=node | DW_PODCAST_SELFTEST=1 node
// Podcast-Schnitt: Datenmodell und Zeitrechnung, gemeinsam für Engine (src/main/podcast.ts), KI-Tools und Deckvid. Zeiten in Sekunden.
// Eine Episode hängt als deck.podcast am Deck: Titel, Musik (deck.music), Speichern, Versionen und Sync kommen vom Deck.
// Zwei Zeitachsen: Quellzeit (alle Spuren laufen gleichzeitig ab 0) und geschnittene Zeit (ohne die cuts). Gespeichert wird immer Quellzeit.
import { z } from 'zod'

export interface PodTrack { src: string; name?: string; gain?: number; mute?: boolean } // src: asset://-Pfad oder absoluter Pfad; gain in dB (−12…12)
export type CutWhy = 'pause' | 'fuell' | 'versprecher' | 'hand'
export interface Cut { start: number; end: number; why?: CutWhy } // entfernter Bereich in Quellzeit
export interface Sfx { src: string; at: number; gain?: number } // Soundeffekt/Jingle ab Quellsekunde at, gain in dB
export interface Chapter { at: number; title: string } // Kapitelmarke in Quellzeit
export type PodTon = 'original' | 'klar' | 'stark' // klar = Sprachkette (Standard), stark = dazu kräftiger entrauschen
export interface Episode {
  duration: number // Quelllänge = längste Spur (setzt create_episode)
  tracks: PodTrack[]
  cuts: Cut[]
  sfx?: Sfx[]
  intro?: string; outro?: string // Jingle-Dateien vor bzw. nach der Sprache, kurz überblendet
  chapters?: Chapter[]
  ton?: PodTon
}
export type Span = [start: number, end: number]

export const POD_TON: PodTon[] = ['original', 'klar', 'stark']
export const CUT_WHY: CutWhy[] = ['pause', 'fuell', 'versprecher', 'hand']
export const LUFS = -16 // Podcast-Ziel (Apple/Spotify-Sprache); Video bleibt bei −14

const src = z.string().min(1).describe('asset://-Pfad aus dem Anhang oder absoluter Dateipfad (Audio oder Video)')
export const cutSchema = z.object({ start: z.number().min(0), end: z.number().min(0), why: z.enum(['pause', 'fuell', 'versprecher', 'hand']).optional() })
export const episodeSchema = z.object({
  duration: z.number().positive(),
  tracks: z.array(z.object({ src, name: z.string().max(40).optional(), gain: z.number().min(-12).max(12).optional(), mute: z.boolean().optional() })).min(1).max(4),
  cuts: z.array(cutSchema).max(5000),
  sfx: z.array(z.object({ src, at: z.number().min(0), gain: z.number().min(-24).max(12).optional() })).max(200).optional(),
  intro: src.optional(), outro: src.optional(),
  chapters: z.array(z.object({ at: z.number().min(0), title: z.string().min(1).max(80) })).max(100).optional(),
  ton: z.enum(['original', 'klar', 'stark']).optional(),
}) satisfies z.ZodType<Episode>

/** Schnitte sortiert, auf 0…duration begrenzt, überlappende und angrenzende zusammengelegt (why vom ersten). Leere fallen weg. */
export function normCuts(cuts: Cut[], duration: number): Cut[] {
  const out: Cut[] = []
  for (const c of [...cuts].map((c) => ({ ...c, start: Math.max(0, c.start), end: Math.min(duration, c.end) })).filter((c) => c.end > c.start).sort((a, b) => a.start - b.start)) {
    const l = out[out.length - 1]
    if (l && c.start <= l.end + 1e-3) l.end = Math.max(l.end, c.end)
    else out.push(c)
  }
  return out
}

/** Was stehen bleibt, in Quellzeit. */
export function keepRanges(cuts: Cut[], duration: number): Span[] {
  const out: Span[] = []
  let t = 0
  for (const c of normCuts(cuts, duration)) { if (c.start > t) out.push([t, c.start]); t = c.end }
  if (t < duration) out.push([t, duration])
  return out
}

export const editedLength = (cuts: Cut[], duration: number) => keepRanges(cuts, duration).reduce((s, [a, b]) => s + b - a, 0)
export const inCut = (t: number, cuts: Cut[]) => cuts.some((c) => t > c.start + 1e-3 && t < c.end - 1e-3)

/** Quellzeit → geschnittene Zeit. Liegt t in einem Schnitt, zählt der Anfang des Schnitts. */
export function toEdited(t: number, cuts: Cut[], duration: number): number {
  let out = 0
  for (const [a, b] of keepRanges(cuts, duration)) { if (t <= a) break; out += Math.min(t, b) - a }
  return out
}

/** Geschnittene Zeit → Quellzeit (Abspielen in der Vorschau, Klick in die Wellenform). */
export function toSource(e: number, cuts: Cut[], duration: number): number {
  let rest = Math.max(0, e)
  const ks = keepRanges(cuts, duration)
  for (const [a, b] of ks) { if (rest <= b - a) return a + rest; rest -= b - a }
  return ks.length ? ks[ks.length - 1][1] : 0
}

/** Ein Schnitt von Hand über Wörter: Kanten, die in einem Wort liegen, auf dessen Rand legen (Start auf den Wortanfang, Ende aufs Wortende), damit nie ein halbes Wort bleibt. */
export function snapCut(c: Cut, words: { start: number; end: number }[]): Cut {
  const hit = (t: number) => words.find((w) => t > w.start && t < w.end)
  return { ...c, start: hit(c.start)?.start ?? c.start, end: hit(c.end)?.end ?? c.end }
}

if (typeof process !== 'undefined' && process.env.DW_PODCAST_SELFTEST) {
  const eq = (got: unknown, want: unknown, what: string) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: ${JSON.stringify(got)}`) }
  const cuts: Cut[] = [{ start: 5, end: 7 }, { start: 2, end: 3, why: 'pause' }, { start: 6, end: 8 }, { start: 12, end: 15 }]
  eq(normCuts(cuts, 14), [{ start: 2, end: 3, why: 'pause' }, { start: 5, end: 8 }, { start: 12, end: 14 }], 'normCuts')
  eq(keepRanges(cuts, 14), [[0, 2], [3, 5], [8, 12]], 'keepRanges')
  eq(editedLength(cuts, 14), 8, 'editedLength')
  eq([0, 2.5, 4, 6, 10, 13].map((t) => toEdited(t, cuts, 14)), [0, 2, 3, 4, 6, 8], 'toEdited')
  eq([0, 2, 3, 4, 6, 8, 99].map((e) => toSource(e, cuts, 14)), [0, 2, 4, 5, 10, 12, 12], 'toSource')
  eq(keepRanges([], 10), [[0, 10]], 'ohne Schnitte')
  eq(inCut(6, cuts), true, 'inCut')
  eq(inCut(5, cuts), false, 'inCut Rand')
  eq(snapCut({ start: 1.2, end: 2.1 }, [{ start: 1, end: 1.5 }, { start: 2, end: 2.4 }]), { start: 1, end: 2.4 }, 'snapCut')
  eq(episodeSchema.safeParse({ duration: 10, tracks: [{ src: '/a.wav' }], cuts: [] }).success, true, 'Schema')
  console.log('podcast ok')
}
