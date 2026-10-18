// Schema des Layouts timeline (Typen in timeline.ts). Kurze describe()-Texte: das ganze Schema geht in den KI-Prompt, Details stehen im Guide
import { z } from 'zod'
import { OVERLAY_ARTS, OVERLAY_POS } from './video'
import { CODECS, RESOLUTIONS, TL, clipEnd, type TimelineContent, type TLClip, type TLTrack } from './timeline'

const num = (r: { min: number; max: number }) => z.number().min(r.min).max(r.max)
const rgb = (r: { min: number; max: number }) => z.tuple([num(r), num(r), num(r)])
const t = z.number().min(0)

const tlClip = z.object({
  id: z.string().min(1).describe('eindeutige Clip-ID, z. B. c1'),
  src: z.string().describe('Quelldatei: asset://-Pfad oder absoluter Pfad'),
  at: t.describe('Lage auf der Zeitachse (s)'),
  in: t.describe('Quellsekunde Anfang'),
  out: t.describe('Quellsekunde Ende'),
  speed: num(TL.speed).optional().describe('Tempo, Standard 1'),
  volume: num(TL.volume).optional().describe('Pegel 0..2, Standard 1'),
  keys: z.array(z.tuple([t, num(TL.db)])).max(100).optional().describe('Pegel-Stützpunkte [Quellsekunde, dB]'),
  eq: z.object({ low: num(TL.eq).optional(), mid: num(TL.eq).optional(), high: num(TL.eq).optional() }).optional().describe('EQ in dB bei 100 Hz, 1 kHz, 8 kHz'),
  grade: z.object({
    lift: rgb(TL.lift).optional(), gamma: rgb(TL.gamma).optional(), gain: rgb(TL.gain).optional(),
    sat: num(TL.sat).optional(), temp: num(TL.temp).optional(),
  }).optional().describe('Farbe: lift/gamma/gain je [r, g, b], sat, temp'),
  mute: z.boolean().optional(),
  fit: z.enum(['crop', 'contain']).optional().describe('crop füllt das Bild (Standard), contain zeigt alles'),
  focus: z.number().min(0).max(1).optional().describe('horizontaler Bildmittelpunkt bei crop'),
  box: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0.05).max(1)]).optional().describe('Bild-in-Bild [x, y, Breite] als Anteile (V2+)'),
  fade: z.tuple([num(TL.fade), num(TL.fade)]).optional().describe('Ein-/Ausblenden [Anfang, Ende] in s'),
  xfade: num(TL.xfade).optional().describe('Überblendung vom Clip direkt davor (s), mittig über dem Schnitt'),
}).refine((c) => c.out >= c.in + TL.minLen, 'out muss nach in liegen')

const track = z.object({
  id: z.string().min(1).describe('Spur-ID, z. B. v1, a1'),
  kind: z.enum(['video', 'audio']),
  clips: z.array(tlClip).max(TL.clips),
  mute: z.boolean().optional(), hide: z.boolean().optional(),
  volume: num(TL.volume).optional(),
}).superRefine((tr, ctx) => {
  const cs = [...tr.clips].sort((a, b) => a.at - b.at)
  for (let i = 1; i < cs.length; i++)
    if (clipEnd(cs[i - 1]) > cs[i].at + 1e-3) ctx.addIssue({ code: 'custom', message: `Spur ${tr.id}: ${cs[i - 1].id} überlappt ${cs[i].id}` })
})

// Nur Text-Arten: Bilder und Videos liegen als Clips auf V2+
const overlay = z.object({
  start: t.describe('Timeline-Sekunde'),
  end: t,
  art: z.enum(OVERLAY_ARTS).optional().describe('wie beim Clip-Layout'),
  text: z.string().min(1).max(120).optional(),
  sub: z.string().min(1).max(60).optional(),
  items: z.array(z.string().min(1).max(40)).min(2).max(5).optional().describe('nur bei liste'),
  box: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0.02).max(1), z.number().min(0.02).max(1)]).optional().describe('nur bei verpixeln/markierung: [x, y, w, h]'),
  pos: z.enum(OVERLAY_POS).optional(),
  size: z.enum(['klein', 'mittel', 'gross']).optional(),
}).refine((o) => o.end > o.start + 0.3, 'end muss nach start liegen')
  .refine((o) => o.art === 'verpixeln' || o.art === 'markierung' ? !!o.box : o.art === 'liste' ? !!o.items : !!o.text, 'verpixeln/markierung brauchen box, liste items, sonst text')

export const timelineSchema = z.object({
  tracks: z.array(track).min(1).max(TL.tracks).describe('Spuren von unten nach oben'),
  overlays: z.array(overlay).max(60).optional().describe('Text-Einblendungen in Timeline-Sekunden'),
  subs: z.array(z.object({ start: t, end: t, text: z.string().min(1).max(200) })).max(2000).optional().describe('Untertitel in Timeline-Sekunden'),
  captions: z.enum(['wort', 'satz', 'aus']).optional().describe('Untertitel aus dem Transkript'),
  markers: z.array(z.object({ t, name: z.string().max(60) })).max(200).optional(),
  deliver: z.object({
    res: z.literal(RESOLUTIONS).describe('kurze Bildseite in px'),
    fps: num(TL.fps),
    codec: z.enum(CODECS),
    lufs: num(TL.lufs).describe('Lautheitsziel'),
  }).partial().optional().describe('Ausgabe; fehlende Felder = 1080, 30 fps, h264, −14 LUFS'),
}).superRefine((tl, ctx) => {
  const seen = new Set<string>()
  for (const c of tl.tracks.flatMap((tr) => tr.clips)) {
    if (seen.has(c.id)) ctx.addIssue({ code: 'custom', message: `Clip-ID ${c.id} doppelt` })
    seen.add(c.id)
  }
})

export type TimelineSchema = z.infer<typeof timelineSchema>
// Typ-Abgleich: Schema und TimelineContent müssen zusammenpassen, auch in Gegenrichtung (jedes Feld im Schema, sonst lehnt update_slide es ab)
const _t: TimelineContent = {} as TimelineSchema
const _k: [keyof TimelineContent] extends [keyof TimelineSchema] ? true : false = true
const _c: [keyof TLClip] extends [keyof TimelineSchema['tracks'][number]['clips'][number]] ? true : false = true
const _r: [keyof TLTrack] extends [keyof TimelineSchema['tracks'][number]] ? true : false = true
void _t, _k, _c, _r
