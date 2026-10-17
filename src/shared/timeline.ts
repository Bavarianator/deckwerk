// Pro-Timeline (Layout timeline): mehrere Spuren, mehrere Quellen, Farbe, Ton und Ausgabe je Folie. Zeiten in Sekunden.
// Timeline-Zeit = Lage auf der Zeitachse (at), Quellzeit = Sekunde im Quellvideo (in/out, keys). Gemeinsam für Export, Vorschau und KI-Tools.
import type { Overlay, Captions } from './video'

export type RGB = [r: number, g: number, b: number]
// lift hebt die Schatten (−0,5..0,5), gamma die Mitten (0,5..2, > 1 heller), gain die Lichter (0,5..2); sat Sättigung (0 = s/w, 1 = neutral, 2);
// temp Farbtemperatur (−1 kühl .. 1 warm). Fehlt ein Feld = neutral
export interface Grade { lift?: RGB; gamma?: RGB; gain?: RGB; sat?: number; temp?: number }
// EQ in dB (−12..12) bei festen Frequenzen: low 100 Hz (Kuhschwanz), mid 1 kHz (Glocke), high 8 kHz (Kuhschwanz)
export interface Eq { low?: number; mid?: number; high?: number }
// Ein Clip auf einer Spur: Quelle src von in bis out (Quellsekunden) liegt ab at auf der Zeitachse, Länge (out−in)/speed.
// volume 0..2 (1 = Original), keys: Pegel-Stützpunkte [Quellsekunde, dB], dazwischen linear; mute: Ton des Clips aus.
// fit: crop füllt das Bild (focus = horizontaler Mittelpunkt 0..1), contain zeigt alles mit Rand. box: Bild-in-Bild [x, y, w] als Anteile des Bildes (V2+)
// fade: Ein- und Ausblenden [Anfang, Ende] in s (Bild und Ton; V1 aus/zu Schwarz, V2+ auf die Spuren darunter).
// xfade: Überblendung vom direkt anschließenden Clip davor auf derselben Spur (s), mittig über dem Schnitt; braucht Material vor in und nach dessen out
export interface TLClip { id: string; src: string; at: number; in: number; out: number; speed?: number; volume?: number; keys?: [src: number, db: number][]; eq?: Eq; grade?: Grade; mute?: boolean; fit?: 'crop' | 'contain'; focus?: number; box?: [x: number, y: number, w: number]; fade?: [fadeIn: number, fadeOut: number]; xfade?: number }
// Spuren von unten nach oben: höhere Videospuren liegen über tieferen. Audiospuren tragen Musik und Sprechertext (src = Audio- oder Videodatei)
export interface TLTrack { id: string; kind: 'video' | 'audio'; clips: TLClip[]; mute?: boolean; hide?: boolean; volume?: number }
export interface Sub { start: number; end: number; text: string } // Untertitel in Timeline-Sekunden
export interface Marker { t: number; name: string }
export const CODECS = ['h264', 'h264-10', 'prores', 'dnxhr'] as const
export type Codec = (typeof CODECS)[number]
export const RESOLUTIONS = [720, 1080, 1440, 2160] as const // kurze Bildseite
// Ausgabe: res = kurze Seite in px (Seitenverhältnis aus dem Folienformat), fps frei (23.976, 25, 29.97, 30, 50, 59.94, 60 …), lufs Lautheitsziel
export interface Deliver { res: (typeof RESOLUTIONS)[number]; fps: number; codec: Codec; lufs: number }
// overlays: Text-Einblendungen wie am Clip (video.ts), aber in Timeline-Sekunden; Bilder und Videos liegen als Clips auf V2+
export interface TimelineContent { tracks: TLTrack[]; overlays?: Overlay[]; subs?: Sub[]; captions?: Captions; markers?: Marker[]; deliver?: Partial<Deliver> }

export const DELIVER: Deliver = { res: 1080, fps: 30, codec: 'h264', lufs: -14 }
export const TL = {
  speed: { min: 0.25, max: 4 },
  volume: { min: 0, max: 2 },
  db: { min: -60, max: 12 }, // Pegel-Keyframes
  eq: { min: -12, max: 12 },
  lift: { min: -0.5, max: 0.5 },
  gamma: { min: 0.5, max: 2 },
  gain: { min: 0.5, max: 2 },
  sat: { min: 0, max: 2 },
  temp: { min: -1, max: 1 },
  lufs: { min: -30, max: -9 },
  fade: { min: 0, max: 10 }, // Ein-/Ausblenden (s)
  xfade: { min: 0, max: 5 }, // Überblendung (s)
  fps: { min: 10, max: 120 },
  minLen: 1 / 30, // kürzester Clip (s)
  tracks: 12, // Spuren je Timeline
  clips: 400, // Clips je Timeline
}
export const EQ_HZ = { low: 100, mid: 1000, high: 8000 }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const speedOfClip = (c: Pick<TLClip, 'speed'>) => clamp(c.speed ?? 1, TL.speed.min, TL.speed.max)
/** Länge eines Clips auf der Zeitachse (s) */
export const clipLen = (c: Pick<TLClip, 'in' | 'out' | 'speed'>) => Math.max(0, c.out - c.in) / speedOfClip(c)
export const clipEnd = (c: Pick<TLClip, 'at' | 'in' | 'out' | 'speed'>) => c.at + clipLen(c)
/** Länge der ganzen Timeline: Ende des spätesten Clips */
export const tlDuration = (tl: Pick<TimelineContent, 'tracks'>) => tl.tracks.reduce((m, t) => t.clips.reduce((n, c) => Math.max(n, clipEnd(c)), m), 0)
/** Quellsekunde eines Clips zur Timeline-Zeit t (nicht geklemmt) */
export const srcAt = (c: Pick<TLClip, 'at' | 'in' | 'speed'>, t: number) => c.in + (t - c.at) * speedOfClip(c)
/** Timeline-Zeit zu einer Quellsekunde s des Clips */
export const tlAt = (c: Pick<TLClip, 'at' | 'in' | 'speed'>, s: number) => c.at + (s - c.in) / speedOfClip(c)
export const deliverOf = (tl: Pick<TimelineContent, 'deliver'>): Deliver => ({ ...DELIVER, ...tl.deliver })

/** Auf das nächste Bild runden (Timeline-Zeit), damit Schnitte in Vorschau, Export und XML auf denselben Frame fallen */
export const snapFrame = (t: number, fps: number) => Math.round(t * fps) / fps
/** Bildrate als ffmpeg-Argument: NTSC-Raten (23.976, 29.97, 59.94 …) exakt als N*1000/1001 */
export function fpsArg(fps: number): string {
  const n = Math.round(fps)
  return Math.abs(fps - (n * 1000) / 1001) < 0.005 && Math.abs(fps - n) > 0.005 ? `${n * 1000}/1001` : String(+fps.toFixed(3))
}

export interface Active { track: TLTrack; clip: TLClip; index: number; src: number }
/** Sichtbare/hörbare Clips zur Zeit t, von unten nach oben (je Spur höchstens einer); ausgeblendete bzw. stumme Spuren fallen weg */
export function activeAt(tl: Pick<TimelineContent, 'tracks'>, t: number, kind?: TLTrack['kind']): Active[] {
  const out: Active[] = []
  tl.tracks.forEach((track, index) => {
    if (kind && track.kind !== kind) return
    if (track.kind === 'video' ? track.hide : track.mute) return
    const clip = track.clips.findLast((c) => t >= c.at - 1e-6 && t < clipEnd(c) - 1e-6) // Toleranz: Gleitkomma-Reste an Schnitten zeigen sonst den Vorgänger
    if (clip) out.push({ track, clip, index, src: srcAt(clip, t) })
  })
  return out
}
/** Alle Schnittpunkte (Clip-Anfänge und -Enden über alle Spuren) samt 0 und Ende, sortiert, ohne Dubletten */
export function cutPoints(tl: Pick<TimelineContent, 'tracks'>): number[] {
  const ts = [0, tlDuration(tl)]
  for (const t of tl.tracks) for (const c of t.clips) ts.push(c.at, clipEnd(c))
  const s = [...new Set(ts.map((x) => Math.round(x * 1e4) / 1e4))].sort((a, b) => a - b)
  return s
}
/** Neue, in der Timeline eindeutige ID mit Präfix (c = Clip, v/a = Spur) */
export function newId(tl: Pick<TimelineContent, 'tracks'>, prefix: string): string {
  const used = new Set(tl.tracks.flatMap((t) => [t.id, ...t.clips.map((c) => c.id)]))
  for (let i = 1; ; i++) if (!used.has(prefix + i)) return prefix + i
}

/** Faktor 0..1 aus fade (linear) zur Timeline-Zeit t: Deckkraft im Bild, Pegel im Ton */
export function fadeGain(c: Pick<TLClip, 'at' | 'in' | 'out' | 'speed' | 'fade'>, t: number): number {
  const [fi, fo] = c.fade ?? [0, 0], end = clipEnd(c)
  return Math.max(0, Math.min(1, fi > 0 ? (t - c.at) / fi : 1, fo > 0 ? (end - t) / fo : 1))
}
// Überblendung auf einer Spur: from läuft bis b weiter, to beginnt schon bei a (a < to.at < b, mittig über dem Schnitt)
export interface XFade { from: TLClip; to: TLClip; a: number; b: number }
const XF_GAP = 1e-3 // s: so dicht müssen Ende und Anfang beieinander liegen
/** Alle Überblendungen einer Spur; Länge höchstens die halbe Länge beider Clips, ohne direkten Vorgänger keine */
export function xfades(track: Pick<TLTrack, 'clips'>): XFade[] {
  const cs = [...track.clips].sort((a, b) => a.at - b.at), out: XFade[] = []
  for (let i = 1; i < cs.length; i++) {
    const to = cs[i], from = cs[i - 1]
    if (!(to.xfade && to.xfade > 0) || Math.abs(clipEnd(from) - to.at) > XF_GAP) continue
    const d = Math.min(to.xfade, TL.xfade.max, clipLen(from), clipLen(to))
    out.push({ from, to, a: to.at - d / 2, b: to.at + d / 2 })
  }
  return out
}
/** Überblendung der Spur zur Zeit t und Fortschritt k (0 = nur from, 1 = nur to) */
export function xfadeAt(track: Pick<TLTrack, 'clips'>, t: number): (XFade & { k: number }) | undefined {
  const x = xfades(track).find((x) => t >= x.a && t < x.b)
  return x && { ...x, k: (t - x.a) / (x.b - x.a) }
}
