// Schnitt-Operationen auf der Pro-Timeline: rein, immutabel (Eingabe bleibt unverändert), gemeinsam für UI und KI-Tools.
// Zeiten sind Timeline-Sekunden und werden auf Bilder (fps) gerundet; Fehler als deutsche Error-Meldung.
import { TL, clipEnd, clipLen, newId, snapFrame, speedOfClip, srcAt, tlAt, xfades, type TLClip, type TLTrack, type TimelineContent } from './timeline'

const EPS = 1e-6

function locate(tl: TimelineContent, clipId: string): { track: TLTrack; clip: TLClip; i: number } {
  for (const track of tl.tracks) {
    const i = track.clips.findIndex((c) => c.id === clipId)
    if (i >= 0) return { track, clip: track.clips[i], i }
  }
  throw new Error(`Clip ${clipId} nicht gefunden`)
}
const trackOf = (tl: TimelineContent, trackId: string) => {
  const t = tl.tracks.find((x) => x.id === trackId)
  if (!t) throw new Error(`Spur ${trackId} nicht gefunden`)
  return t
}
const sortClips = (t: TLTrack) => t.clips.sort((a, b) => a.at - b.at)
function assertFree(track: TLTrack, c: TLClip) {
  const hit = track.clips.find((o) => o.id !== c.id && c.at < clipEnd(o) - EPS && o.at < clipEnd(c) - EPS)
  if (hit) throw new Error(`Clip ${c.id} überlappt ${hit.id} auf Spur ${track.id}`)
}
// Clips derselben Spur ab Zeit from um d verschieben (ripple)
function shiftFrom(track: TLTrack, from: number, d: number, fps: number, except?: string) {
  for (const c of track.clips) if (c.id !== except && c.at >= from - EPS) c.at = snapFrame(Math.max(0, c.at + d), fps)
}

/** Teilt den Clip an Timeline-Zeit t; der zweite Teil bekommt eine neue ID, Pegel-Keys bleiben in ihrem Quellbereich */
export function split(tl: TimelineContent, clipId: string, t: number, fps = 30): TimelineContent {
  const out = structuredClone(tl)
  const { track, clip, i } = locate(out, clipId)
  t = snapFrame(t, fps)
  if (t < clip.at + TL.minLen - EPS || t > clipEnd(clip) - TL.minLen + EPS) throw new Error(`Schnitt bei ${t}s liegt nicht innerhalb von Clip ${clipId}`)
  const s = srcAt(clip, t)
  const b: TLClip = { ...structuredClone(clip), id: newId(out, 'c'), at: t, in: s }
  clip.out = s
  // Einblenden und Überblendung bleiben vorn, Ausblenden hinten
  delete b.xfade
  if (clip.fade) { b.fade = [0, clip.fade[1]]; clip.fade = [clip.fade[0], 0] }
  if (clip.keys) {
    b.keys = clip.keys.filter((k) => k[0] >= s)
    clip.keys = clip.keys.filter((k) => k[0] <= s)
  }
  track.clips.splice(i + 1, 0, b)
  return out
}

/** Zieht die In- oder Out-Kante auf Timeline-Zeit t. Ohne ripple: am Nachbarn und an Quellsekunde 0 geklemmt.
 *  Mit ripple bleibt der Clip-Anfang stehen und alle späteren Clips derselben Spur rücken um die Längenänderung mit */
export function trim(tl: TimelineContent, clipId: string, edge: 'in' | 'out', t: number, ripple = false, fps = 30): TimelineContent {
  const out = structuredClone(tl)
  const { track, clip } = locate(out, clipId)
  sortClips(track)
  const i = track.clips.indexOf(clip)
  const prev = track.clips[i - 1], next = track.clips[i + 1]
  const oldEnd = clipEnd(clip), oldLen = clipLen(clip)
  t = snapFrame(t, fps)
  if (edge === 'in') {
    const lo = Math.max(Math.ceil(tlAt(clip, 0) * fps - 1e-6) / fps, !ripple && prev ? clipEnd(prev) : -Infinity)
    t = Math.min(Math.max(t, lo), oldEnd - TL.minLen)
    clip.in = Math.max(0, srcAt(clip, t))
    if (!ripple) clip.at = t
  } else {
    t = Math.max(t, clip.at + TL.minLen)
    if (!ripple && next) t = Math.min(t, next.at)
    clip.out = srcAt(clip, t)
  }
  if (ripple) shiftFrom(track, oldEnd, clipLen(clip) - oldLen, fps, clip.id)
  return out
}

/** Verschiebt den Clip auf at (≥ 0), wahlweise auf eine andere Spur gleicher Art; wirft bei Überlappung */
export function move(tl: TimelineContent, clipId: string, at: number, trackId?: string, fps = 30): TimelineContent {
  if (at < 0) throw new Error('Startzeit darf nicht negativ sein')
  const out = structuredClone(tl)
  const { track, clip, i } = locate(out, clipId)
  const dest = trackId ? trackOf(out, trackId) : track
  if (dest.kind !== track.kind) throw new Error(`Clip ${clipId} passt nicht auf ${dest.kind === 'video' ? 'Videospur' : 'Audiospur'} ${dest.id}`)
  clip.at = snapFrame(at, fps)
  assertFree(dest, clip)
  if (dest !== track) {
    track.clips.splice(i, 1)
    dest.clips.push(clip)
  }
  sortClips(dest)
  return out
}

function remove(tl: TimelineContent, clipId: string, ripple: boolean, fps: number): TimelineContent {
  const out = structuredClone(tl)
  const { track, clip, i } = locate(out, clipId)
  track.clips.splice(i, 1)
  if (ripple) shiftFrom(track, clipEnd(clip), -clipLen(clip), fps)
  return out
}
/** Entfernt den Clip, die Lücke bleibt */
export const lift = (tl: TimelineContent, clipId: string, fps = 30) => remove(tl, clipId, false, fps)
/** Entfernt den Clip, spätere Clips derselben Spur rücken nach */
export const rippleDelete = (tl: TimelineContent, clipId: string, fps = 30) => remove(tl, clipId, true, fps)

export function addClip(tl: TimelineContent, trackId: string, clip: Omit<TLClip, 'id'> & { id?: string }, fps = 30): TimelineContent {
  const out = structuredClone(tl)
  const track = trackOf(out, trackId)
  const taken = clip.id && out.tracks.some((t) => t.id === clip.id || t.clips.some((c) => c.id === clip.id))
  const c: TLClip = { ...structuredClone(clip), id: clip.id && !taken ? clip.id : newId(out, 'c'), at: snapFrame(Math.max(0, clip.at), fps) }
  assertFree(track, c)
  track.clips.push(c)
  sortClips(track)
  return out
}

/** Neue leere Spur; Spuren liegen von unten nach oben, eine neue Videospur also ganz oben (am Ende) */
export function addTrack(tl: TimelineContent, kind: TLTrack['kind']): TimelineContent {
  if (tl.tracks.length >= TL.tracks) throw new Error(`Höchstens ${TL.tracks} Spuren`)
  const out = structuredClone(tl)
  out.tracks.push({ id: newId(out, kind === 'video' ? 'v' : 'a'), kind, clips: [] })
  return out
}

export function setClip(tl: TimelineContent, clipId: string, patch: Partial<Omit<TLClip, 'id'>>, fps = 30): TimelineContent {
  const out = structuredClone(tl)
  const { track, clip } = locate(out, clipId)
  Object.assign(clip, structuredClone(patch), { id: clipId })
  if (patch.at !== undefined) {
    if (patch.at < 0) throw new Error('Startzeit darf nicht negativ sein')
    clip.at = snapFrame(patch.at, fps)
  }
  assertFree(track, clip)
  sortClips(track)
  return out
}

/** Einrastziele: alle Clip-Kanten (außer vom gezogenen Clip), Marker und extra (z. B. Abspielkopf), sortiert */
export function snapTargets(tl: TimelineContent, exceptClipId?: string, extra: number[] = []): number[] {
  const ts = [...extra, ...(tl.markers ?? []).map((m) => m.t)]
  for (const t of tl.tracks) for (const c of t.clips) if (c.id !== exceptClipId) ts.push(c.at, clipEnd(c))
  return [...new Set(ts)].sort((a, b) => a - b)
}
/** Nächstes Ziel innerhalb von tol, sonst t */
export function snap(t: number, targets: number[], tol: number): number {
  let best = t, d = tol
  for (const x of targets) if (Math.abs(x - t) <= d) (best = x), (d = Math.abs(x - t))
  return best
}

export type TLOp =
  | { op: 'split'; clip: string; t: number }
  | { op: 'trim'; clip: string; edge: 'in' | 'out'; t: number; ripple?: boolean }
  | { op: 'move'; clip: string; at: number; track?: string }
  | { op: 'lift'; clip: string }
  | { op: 'ripple_delete'; clip: string }
  | { op: 'add_clip'; track: string; clip: Omit<TLClip, 'id'> & { id?: string } }
  | { op: 'add_track'; kind: TLTrack['kind'] }
  | { op: 'set'; clip: string; patch: Partial<Omit<TLClip, 'id'>> }

function applyOp(tl: TimelineContent, o: TLOp, fps: number): TimelineContent {
  switch (o.op) {
    case 'split': return split(tl, o.clip, o.t, fps)
    case 'trim': return trim(tl, o.clip, o.edge, o.t, o.ripple, fps)
    case 'move': return move(tl, o.clip, o.at, o.track, fps)
    case 'lift': return lift(tl, o.clip, fps)
    case 'ripple_delete': return rippleDelete(tl, o.clip, fps)
    case 'add_clip': return addClip(tl, o.track, o.clip, fps)
    case 'add_track': return addTrack(tl, o.kind)
    case 'set': return setClip(tl, o.clip, o.patch, fps)
    default: throw new Error(`Unbekannte Operation ${(o as { op: string }).op}`)
  }
}
/** Wendet die Operationen nacheinander an; ein Fehler nennt die Nummer der Op (ab 1) */
export function applyOps(tl: TimelineContent, ops: TLOp[], fps = 30): TimelineContent {
  return ops.reduce((cur, o, i) => {
    try {
      return applyOp(cur, o, fps)
    } catch (e) {
      throw new Error(`Op ${i + 1} (${o.op}): ${(e as Error).message}`)
    }
  }, tl)
}

export interface TLIssue { level: 'error' | 'warn'; msg: string; clip?: string }
export function lintTimeline(tl: TimelineContent, fps = 30): TLIssue[] {
  const res: TLIssue[] = []
  const all = tl.tracks.flatMap((t) => t.clips)
  if (tl.tracks.length > TL.tracks) res.push({ level: 'error', msg: `${tl.tracks.length} Spuren, höchstens ${TL.tracks}` })
  if (all.length > TL.clips) res.push({ level: 'error', msg: `${all.length} Clips, höchstens ${TL.clips}` })
  const seen = new Set<string>()
  for (const id of [...tl.tracks.map((t) => t.id), ...all.map((c) => c.id)]) {
    if (seen.has(id)) res.push({ level: 'error', msg: `ID ${id} doppelt`, clip: id })
    seen.add(id)
  }
  for (const t of tl.tracks) {
    const cs = [...t.clips].sort((a, b) => a.at - b.at)
    cs.forEach((c, i) => {
      if (c.in < 0) res.push({ level: 'error', msg: `Clip ${c.id}: in vor Quellsekunde 0`, clip: c.id })
      if (c.out <= c.in) res.push({ level: 'error', msg: `Clip ${c.id}: out muss nach in liegen`, clip: c.id })
      else if (clipLen(c) < 2 / fps - EPS) res.push({ level: 'warn', msg: `Clip ${c.id} ist kürzer als 2 Bilder`, clip: c.id })
      if (c.fade && c.fade[0] + c.fade[1] > clipLen(c) + EPS) res.push({ level: 'warn', msg: `Clip ${c.id}: Ein- und Ausblenden sind zusammen länger als der Clip`, clip: c.id })
      const n = cs[i + 1]
      if (n && n.at < clipEnd(c) - EPS) res.push({ level: 'error', msg: `Clip ${c.id} überlappt ${n.id} auf Spur ${t.id}`, clip: c.id })
    })
    const xs = xfades(t)
    for (const c of cs) {
      if (!c.xfade) continue
      const x = xs.find((x) => x.to === c)
      if (!x) res.push({ level: 'warn', msg: `Clip ${c.id}: Überblendung ohne direkt anschließenden Clip davor, sie fällt weg`, clip: c.id })
      else if (c.in < (c.at - x.a) * speedOfClip(c) - EPS) res.push({ level: 'warn', msg: `Clip ${c.id}: vor in fehlen ${+((c.at - x.a) * speedOfClip(c) - c.in).toFixed(2)} s Material für die Überblendung, der Anfang steht kurz still`, clip: c.id })
    }
  }
  const v1 = tl.tracks.find((t) => t.kind === 'video')
  if (!v1) res.push({ level: 'warn', msg: 'Keine Videospur' })
  else {
    let end = 0
    for (const c of [...v1.clips].sort((a, b) => a.at - b.at)) {
      if (c.at > end + EPS) res.push({ level: 'warn', msg: `Lücke auf ${v1.id} von ${+end.toFixed(3)}s bis ${+c.at.toFixed(3)}s (Schwarzbild)`, clip: c.id })
      end = Math.max(end, clipEnd(c))
    }
  }
  return res
}
