// Selbstprüfung: npx esbuild src/shared/podcast.ts --bundle --platform=node | DW_PODCAST_SELFTEST=1 node
// Podcast-Schnitt: Datenmodell und Zeitrechnung, gemeinsam für Engine (src/main/podcast.ts), KI-Tools und Deckvid. Zeiten in Sekunden.
// Eine Episode hängt als deck.podcast am Deck: Titel, Musik (deck.music), Speichern, Versionen und Sync kommen vom Deck.
// Zwei Zeitachsen: Quellzeit (alle Spuren laufen gleichzeitig ab 0) und geschnittene Zeit (ohne die cuts). Gespeichert wird immer Quellzeit.
import { z } from 'zod'
import type { Deck } from './deck'
import { FILLERS, PAD, type ClipContent, type Transcript } from './video'
import { retakes } from './retakes'

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
export const LUFS = -16
const MIN_CUT = 0.2 // s: kürzere automatische Pausenschnitte lohnen nicht // Podcast-Ziel (Apple/Spotify-Sprache); Video bleibt bei −14

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
    // Hand-Schnitt gewinnt: sonst rechnete das nächste clean ihn als Pause weg
    if (l && c.start <= l.end + 1e-3) { l.end = Math.max(l.end, c.end); if (l.why && l.why !== 'hand' && (!c.why || c.why === 'hand')) l.why = 'hand' }
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

// Echte Wortzeiten aller Sprecher, nach Start sortiert; geschätzte sind zum Schneiden zu ungenau
interface SWord { w: string; start: number; end: number; speaker?: number }
const realWords = (t: Transcript): SWord[] => t.segments.flatMap((s) => (s.words ?? []).map((w) => ({ ...w, speaker: s.speaker }))).sort((a, b) => a.start - b.start)
// Gemeinsame Zeitachse: ein Schnitt trifft alle Spuren, also nie, solange ein anderer Sprecher redet
const otherTalks = (ws: SWord[], a: number, b: number, speaker?: number) => ws.some((w) => w.speaker !== speaker && w.end > a && w.start < b)

export interface AutoClean { pauses?: number; fillers?: boolean; retakes?: boolean } // pauses: längste erlaubte Pause in s

/** Neue Schnittliste: Schnitte von Hand bleiben, automatische (Pausen, Füllwörter, Versprecher) werden aus o neu berechnet. quiet = Stillen der gemischten Sprache. */
/** Füllwort (FILLERS); „um“ nur im Englischen, im Deutschen ist es meist Präposition (wie fillerQuiet in video.ts). */
export const isFiller = (w: string, lang: string) => FILLERS.test(w) && (lang.startsWith('en') || !/^um$/i.test(w.replace(/[\p{P}\s]/gu, '')))

/** Transkripte je Spur zu einem: Sprecher = Spurnummer (je Mikrofon eine Person). Eine Spur bleibt, wie sie ist (dort trennt speakers die Sprecher). */
export function mergeTracks(ts: (Transcript | null)[]): Transcript | null {
  const ok = ts.map((t, k) => [t, k] as const).filter((x): x is readonly [Transcript, number] => !!x[0])
  if (!ok.length) return null
  if (ts.length === 1) return ok[0][0]
  return {
    duration: Math.max(...ok.map(([t]) => t.duration)), lang: ok[0][0].lang,
    segments: ok.flatMap(([t, k]) => t.segments.map((s) => ({ ...s, speaker: k }))).sort((a, b) => a.start - b.start),
  }
}

export function autoCuts(ep: Episode, t: Transcript | null, quiet: Span[], o: AutoClean): Cut[] {
  const out: Cut[] = ep.cuts.filter((c) => !c.why || c.why === 'hand')
  const ws = t ? realWords(t) : []
  if (o.pauses !== undefined) {
    const p = Math.max(0, o.pauses)
    for (const [a, b] of quiet) {
      if (b - a <= p) continue
      let start = a + p / 2, end = b - p / 2 // kürzen, nicht entfernen: Atempause bleibt
      // leise Wortenden (silencedetect hört sie nicht) bleiben ganz: der Schnitt weicht den Wörtern aus
      for (const w of ws) if (w.end > start && w.start < end) { if (w.start + w.end < start + end) start = w.end; else end = w.start }
      if (end - start >= MIN_CUT) out.push({ start, end, why: 'pause' }) // kürzere brächten nur eine Naht
    }
  }
  if (t && o.fillers) {
    ws.forEach((w, i) => {
      if (!isFiller(w.w, t.lang) || otherTalks(ws, w.start, w.end, w.speaker)) return
      // Rand höchstens PAD und nie ins Nachbarwort (gleich welcher Sprecher)
      const prev = Math.max(-Infinity, ...ws.filter((v, j) => j !== i && v.end <= w.start).map((v) => v.end))
      const next = Math.min(Infinity, ...ws.filter((v, j) => j !== i && v.start >= w.end).map((v) => v.start))
      out.push({ start: Math.max(w.start - PAD, prev), end: Math.min(w.end + PAD, next), why: 'fuell' })
    })
  }
  if (t && o.retakes) {
    for (const r of retakes(t)) {
      const sp = ws.find((w) => w.start >= r.drop[0] - 1e-3)?.speaker
      if (!otherTalks(ws, r.drop[0], r.drop[1], sp)) out.push({ start: r.drop[0], end: r.drop[1], why: 'versprecher' })
    }
  }
  return normCuts(out, ep.duration)
}

export interface PodIssue { level: 'error' | 'warn' | 'info'; rule: string; msg: string; at?: number } // at in Quellzeit

/** Zeit für Meldungen und Zusammenfassung: m:ss bzw. h:mm:ss */
const clock = (s: number) => {
  const r = Math.round(Math.max(0, s)), h = Math.floor(r / 3600), m = Math.floor((r % 3600) / 60), sec = String(r % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

const SNAP = 0.05 // s Toleranz an Wortkanten wie im Clip-Lint
const CHAPTER_MIN = 30 // s geschnittene Zeit je Kapitel
const LONG_PAUSE = 3 // s

export function lintEpisode(ep: Episode, t: Transcript | null): PodIssue[] {
  const out: PodIssue[] = []
  const cuts = normCuts(ep.cuts, ep.duration)
  const len = editedLength(cuts, ep.duration)
  const ws = t ? realWords(t) : []
  for (const c of cuts) for (const e of [c.start, c.end]) {
    if (e <= 0 || e >= ep.duration) continue
    const w = ws.find((w) => e > w.start + SNAP && e < w.end - SNAP)
    if (w) out.push({ level: 'warn', rule: 'schnitt-wort', at: e, msg: `Schnitt bei ${clock(e)} trennt das Wort „${w.w.trim()}“ – Kante an den Wortrand legen (snapCut).` })
  }
  for (const s of ep.sfx ?? []) if (inCut(s.at, cuts)) out.push({ level: 'warn', rule: 'sfx-im-schnitt', at: s.at, msg: `Soundeffekt bei ${clock(s.at)} liegt in einem Schnitt und fällt weg – verschieben oder löschen.` })
  const chapters = [...(ep.chapters ?? [])].sort((a, b) => a.at - b.at)
  for (const c of chapters) if (inCut(c.at, cuts)) out.push({ level: 'warn', rule: 'kapitel-im-schnitt', at: c.at, msg: `Kapitel „${c.title}“ (${clock(c.at)}) liegt in einem Schnitt – an den Anfang des folgenden Satzes legen.` })
  if (len < ep.duration * 0.5) out.push({ level: 'warn', rule: 'zu-kurz', msg: `Schnitt sehr aggressiv: von ${clock(ep.duration)} bleiben nur ${clock(len)} – Pausen weniger stark kürzen oder Schnitte prüfen.` })
  chapters.forEach((c, i) => {
    const from = toEdited(c.at, cuts, ep.duration), to = i + 1 < chapters.length ? toEdited(chapters[i + 1].at, cuts, ep.duration) : len
    if (to - from < CHAPTER_MIN) out.push({ level: 'info', rule: 'kapitel-kurz', at: c.at, msg: `Kapitel „${c.title}“ ist nur ${Math.round(to - from)} s lang – mit dem Nachbarkapitel zusammenlegen.` })
  })
  if (chapters.length && !chapters.some((c) => toEdited(c.at, cuts, ep.duration) <= 1)) out.push({ level: 'info', rule: 'kapitel-start', at: chapters[0].at, msg: 'Das erste Kapitel sollte bei 0:00 beginnen – ein Kapitel an den Anfang setzen.' })
  if (!t) out.push({ level: 'info', rule: 'ohne-transkript', msg: 'Kein Transkript – erst transcribe_video, sonst keine Füllwörter/Kapitel-Vorschläge.' })
  let end = ws.length ? ws[0].end : 0
  for (const w of ws.slice(1)) {
    if (w.start - end > LONG_PAUSE && toEdited(w.start, cuts, ep.duration) - toEdited(end, cuts, ep.duration) > LONG_PAUSE)
      out.push({ level: 'info', rule: 'pause-lang', at: end, msg: `Bei ${clock(end)} bleibt eine Stille über ${LONG_PAUSE} s – kürzen, wenn sie nicht gewollt ist.` })
    end = Math.max(end, w.end)
  }
  const n = ep.sfx?.length ?? 0
  if (n > Math.max(1, len / 60)) out.push({ level: 'warn', rule: 'sfx-viele', msg: `${n} Soundeffekte auf ${clock(len)} – höchstens einer je Minute, Effekte sparsam einsetzen.` })
  return out
}

/** „Als Podcast“: Video-Deck → Episode. Alle Clip-Folien müssen dieselbe Quelle haben; was keine Folie zeigt, wird geschnitten. */
export function deckToEpisode(deck: Deck, duration: number): Episode {
  const clips = deck.slides.filter((s) => s.layout === 'clip').map((s) => s.content as ClipContent)
  if (!clips.length) throw new Error('Als Podcast geht nur mit Clip-Folien; das Deck hat keine.')
  const srcs = [...new Set(clips.map((c) => c.video))]
  if (srcs.length > 1) throw new Error(`Als Podcast geht nur mit einer Quelle; das Deck nutzt ${srcs.length} Videos. Erst auf ein Video beschränken.`)
  const keep = normCuts(clips.flatMap((c) => c.parts), duration) // Vereinigung aller parts
  const cuts: Cut[] = []
  let at = 0
  for (const k of keep) { if (k.start > at) cuts.push({ start: at, end: k.start, why: 'hand' }); at = k.end }
  if (at < duration) cuts.push({ start: at, end: duration, why: 'hand' })
  const chapters = clips.flatMap((c, i) => (c.parts.length ? [{ at: c.parts[0].start, title: c.hook?.trim() || `Teil ${i + 1}` }] : []))
  // Clip-Soundeffekte: at zählt im fertigen Clip, hier in Quellzeit über die parts der Folie
  const sfx = clips.flatMap((c) => (c.sfx ?? []).flatMap((f) => {
    let t = f.at
    for (const p of c.parts) { if (t < p.end - p.start) return [{ ...f, at: p.start + t }]; t -= p.end - p.start }
    return []
  }))
  return { duration, tracks: [{ src: srcs[0] }], cuts, chapters, ...(sfx.length ? { sfx } : {}), ton: clips.some((c) => c.ton === 'klar') ? 'klar' : 'original' }
}

/** Eine Zeile für Tool-Antworten und UI. */
export function episodeSummary(ep: Episode): string {
  const cuts = normCuts(ep.cuts, ep.duration)
  const len = editedLength(cuts, ep.duration)
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  const by = (why: CutWhy) => cuts.filter((c) => (c.why ?? 'hand') === why).length
  const kinds = ([['pause', 'Pause', 'Pausen'], ['fuell', 'Füllwort', 'Füllwörter'], ['versprecher', 'Versprecher', 'Versprecher'], ['hand', 'von Hand', 'von Hand']] as const)
    .map(([w, one, many]) => [by(w), one, many] as const).filter(([k]) => k).map(([k, one, many]) => n(k, one, many))
  const jingles = [ep.intro && 'Intro', ep.outro && 'Outro'].filter(Boolean).join(', ')
  return [
    `Länge ${clock(ep.duration)} → ${clock(len)} (−${clock(ep.duration - len)})`,
    cuts.length ? `${n(cuts.length, 'Schnitt', 'Schnitte')}: ${kinds.join(', ')}` : 'keine Schnitte',
    n(ep.tracks.length, 'Spur', 'Spuren'),
    ep.chapters?.length && n(ep.chapters.length, 'Kapitel', 'Kapitel'),
    ep.sfx?.length && n(ep.sfx.length, 'Soundeffekt', 'Soundeffekte'),
    jingles,
  ].filter(Boolean).join(' · ')
}

if (typeof process !== 'undefined' && process.env.DW_PODCAST_SELFTEST) {
  const eq = (got: unknown, want: unknown, what: string) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: ${JSON.stringify(got)}`) }
  const cuts: Cut[] = [{ start: 5, end: 7 }, { start: 2, end: 3, why: 'pause' }, { start: 6, end: 8 }, { start: 12, end: 15 }]
  eq(normCuts(cuts, 14), [{ start: 2, end: 3, why: 'pause' }, { start: 5, end: 8 }, { start: 12, end: 14 }], 'normCuts')
  eq(normCuts([{ start: 1, end: 3, why: 'pause' }, { start: 2, end: 4, why: 'hand' }], 9), [{ start: 1, end: 4, why: 'hand' }], 'normCuts Hand gewinnt')
  { // Pausenschnitt weicht einem leisen Wortende aus
    const t: Transcript = { duration: 10, lang: 'de', segments: [{ start: 0, end: 3, text: 'eins zwei', words: [{ w: 'eins', start: 0, end: 1 }, { w: 'zwei', start: 1.2, end: 3 }] }] }
    eq(autoCuts({ duration: 10, tracks: [{ src: '/a.wav' }], cuts: [] }, t, [[2, 6]], { pauses: 0.6 }), [{ start: 3, end: 5.7, why: 'pause' }], 'Pause weicht Wort aus')
  }
  eq(deckToEpisode({ slides: [{ layout: 'clip', content: { video: '/v.mp4', parts: [{ start: 2, end: 12 }, { start: 40, end: 50 }], sfx: [{ src: '/p.wav', at: 3 }, { src: '/p.wav', at: 15 }] } }] } as unknown as Deck, 60).sfx,
    [{ src: '/p.wav', at: 5 }, { src: '/p.wav', at: 45 }], 'deckToEpisode sfx')
  eq(keepRanges(cuts, 14), [[0, 2], [3, 5], [8, 12]], 'keepRanges')
  eq(editedLength(cuts, 14), 8, 'editedLength')
  eq([0, 2.5, 4, 6, 10, 13].map((t) => toEdited(t, cuts, 14)), [0, 2, 3, 4, 6, 8], 'toEdited')
  eq([0, 2, 3, 4, 6, 8, 99].map((e) => toSource(e, cuts, 14)), [0, 2, 4, 5, 10, 12, 12], 'toSource')
  eq(keepRanges([], 10), [[0, 10]], 'ohne Schnitte')
  eq(inCut(6, cuts), true, 'inCut')
  eq(inCut(5, cuts), false, 'inCut Rand')
  eq(snapCut({ start: 1.2, end: 2.1 }, [{ start: 1, end: 1.5 }, { start: 2, end: 2.4 }]), { start: 1, end: 2.4 }, 'snapCut')
  eq(episodeSchema.safeParse({ duration: 10, tracks: [{ src: '/a.wav' }], cuts: [] }).success, true, 'Schema')
  // autoCuts: Wörter je 0,3 s; Sprecher 0 sagt „äh“ bei 2, Sprecher 1 redet bei 6 über das „ähm“ von Sprecher 0
  const W = (w: string, start: number, end = start + 0.3) => ({ w, start, end })
  const tr: Transcript = { duration: 20, lang: 'de', segments: [
    { start: 0, end: 7, text: '', speaker: 0, words: [W(' Hallo', 1.5, 1.9), W(' äh', 2, 2.3), W(' Welt', 2.35), W(' um', 4), W(' ähm', 6)] },
    { start: 5.9, end: 6.5, text: '', speaker: 1, words: [W(' Genau', 5.9, 6.5)] },
    { start: 8, end: 9, text: 'äh geschätzt', speaker: 0 }, // ohne words: nie schneiden
  ] }
  const ep: Episode = { duration: 20, tracks: [{ src: '/a.wav' }, { src: '/b.wav' }], cuts: [{ start: 15, end: 16, why: 'hand' }, { start: 17, end: 17.5 }, { start: 10, end: 11, why: 'pause' }] }
  eq(autoCuts(ep, tr, [[10, 12]], { pauses: 0.6 }), [{ start: 10.3, end: 11.7, why: 'pause' }, { start: 15, end: 16, why: 'hand' }, { start: 17, end: 17.5 }], 'autoCuts Pause gekürzt, Hand bleibt')
  eq(autoCuts(ep, tr, [[10, 10.5]], { pauses: 0.6 }).length, 2, 'kurze Pause bleibt, alte Auto-Schnitte weg')
  eq(autoCuts(ep, tr, [], { fillers: true }).filter((c) => c.why === 'fuell'), [{ start: 1.9, end: 2.35, why: 'fuell' }], 'Füllwort bis an die Nachbarwörter, ähm unter anderem Sprecher bleibt, um deutsch bleibt')
  eq(autoCuts(ep, { ...tr, lang: 'en' }, [], { fillers: true }).filter((c) => c.why === 'fuell').length, 2, 'um englisch')
  eq(autoCuts(ep, null, [], { fillers: true, retakes: true }).length, 2, 'ohne Transkript nur Hand')
  const rt: Transcript = { duration: 20, lang: 'de', segments: [{ start: 0, end: 3, text: '', words: [W(' Ich', 0), W(' ich', 0.4), W(' gehe', 0.8)] }] }
  eq(autoCuts({ ...ep, cuts: [] }, rt, [], { retakes: true }), [{ start: 0, end: 0.4, why: 'versprecher' }], 'Versprecher')

  // lintEpisode
  const rules = (e: Episode, tt: Transcript | null) => lintEpisode(e, tt).map((i) => i.rule)
  const base: Episode = { duration: 600, tracks: [{ src: '/a.wav' }], cuts: [] }
  eq(rules(base, tr), [], 'Lint sauber')
  eq(rules({ ...base, cuts: [{ start: 1.7, end: 2.5 }] }, tr), ['schnitt-wort', 'schnitt-wort'], 'schnitt-wort')
  eq(rules({ ...base, cuts: [{ start: 100, end: 110 }], sfx: [{ src: '/s.wav', at: 105 }] }, tr), ['sfx-im-schnitt'], 'sfx-im-schnitt')
  eq(rules({ ...base, cuts: [{ start: 100, end: 110 }], chapters: [{ at: 0, title: 'A' }, { at: 105, title: 'B' }] }, tr), ['kapitel-im-schnitt'], 'kapitel-im-schnitt')
  eq(rules({ ...base, cuts: [{ start: 100, end: 500 }] }, tr), ['zu-kurz'], 'zu-kurz')
  eq(rules({ ...base, chapters: [{ at: 0, title: 'A' }, { at: 580, title: 'B' }] }, tr), ['kapitel-kurz'], 'kapitel-kurz')
  eq(rules({ ...base, chapters: [{ at: 60, title: 'A' }] }, tr), ['kapitel-start'], 'kapitel-start')
  eq(rules({ ...base, cuts: [{ start: 0, end: 30 }], chapters: [{ at: 30, title: 'A' }] }, tr), [], 'Kapitel am geschnittenen Anfang')
  eq(rules(base, null), ['ohne-transkript'], 'ohne-transkript')
  const gap: Transcript = { duration: 20, lang: 'de', segments: [{ start: 0, end: 9, text: '', words: [W(' a', 0), W(' b', 5), W(' c', 9)] }] }
  eq(lintEpisode(base, gap).map((i) => [i.rule, i.at]), [['pause-lang', 0.3], ['pause-lang', 5.3]], 'pause-lang')
  eq(rules({ ...base, cuts: [{ start: 1, end: 4.5 }] }, gap), ['pause-lang'], 'pause-lang geschnitten')
  eq(rules({ ...base, duration: 120, sfx: [1, 2, 3].map((at) => ({ src: '/s.wav', at })) }, tr), ['sfx-viele'], 'sfx-viele')

  // deckToEpisode
  const slide = (content: unknown) => ({ id: 'x', layout: 'clip', content })
  const deck = { title: 'V', theme: { id: 'x' }, transition: 'none', mode: 'click', slides: [
    slide({ video: '/v.mp4', parts: [{ start: 10, end: 20 }, { start: 30, end: 40 }], hook: 'Anfang', ton: 'klar' }),
    { id: 'y', layout: 'cover', content: {} },
    slide({ video: '/v.mp4', parts: [{ start: 35, end: 50 }] }),
  ] } as unknown as Deck
  eq(deckToEpisode(deck, 60), { duration: 60, tracks: [{ src: '/v.mp4' }], cuts: [{ start: 0, end: 10, why: 'hand' }, { start: 20, end: 30, why: 'hand' }, { start: 50, end: 60, why: 'hand' }],
    chapters: [{ at: 10, title: 'Anfang' }, { at: 35, title: 'Teil 2' }], ton: 'klar' }, 'deckToEpisode')
  let err = ''
  try { deckToEpisode({ ...deck, slides: [...deck.slides, slide({ video: '/w.mp4', parts: [] })] } as Deck, 60) } catch (e) { err = (e as Error).message }
  eq(err.startsWith('Als Podcast geht nur mit einer Quelle'), true, 'mehrere Quellen')

  // episodeSummary
  eq(episodeSummary({ duration: 2530, tracks: [{ src: '/a' }, { src: '/b' }], cuts: [{ start: 0, end: 300, why: 'pause' }, { start: 400, end: 428, why: 'fuell' }, { start: 500, end: 600 }],
    chapters: [{ at: 0, title: 'A' }], sfx: [{ src: '/s', at: 1 }, { src: '/s', at: 2 }], intro: '/i', outro: '/o' }),
  'Länge 42:10 → 35:02 (−7:08) · 3 Schnitte: 1 Pause, 1 Füllwort, 1 von Hand · 2 Spuren · 1 Kapitel · 2 Soundeffekte · Intro, Outro', 'episodeSummary')
  eq(episodeSummary({ duration: 3700, tracks: [{ src: '/a' }], cuts: [] }), 'Länge 1:01:40 → 1:01:40 (−0:00) · keine Schnitte · 1 Spur', 'episodeSummary leer')
  console.log('podcast ok')
}
