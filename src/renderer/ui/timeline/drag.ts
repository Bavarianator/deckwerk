// Ziehen-Mathe der Pro-Timeline (rein, ohne DOM): px↔s, Kante unter dem Zeiger, Ziel-Spur, Ops aus einem Zieh-Vorgang, Lineal-Teilung, Waveform-Ausschnitt.
import { TL, clipEnd, clipLen, snapFrame, type TLClip, type TLTrack, type TimelineContent } from '../../../shared/timeline'
import { snap, snapTargets, type TLOp } from '../../../shared/timeline-edit'

export const GRIP = 6 // px Kantenbreite für trim
export const SNAP_PX = 8

export type DragMode = 'move' | 'in' | 'out'
/** Kante oder Mitte: x relativ zum Clip-Anfang in px, w = Clip-Breite in px. Schmale Clips behalten eine Mitte zum Verschieben */
export function modeAt(x: number, w: number, grip = GRIP): DragMode {
  const g = Math.min(grip, w / 3)
  return x < g ? 'in' : x > w - g ? 'out' : 'move'
}

export interface Row { track: TLTrack; index: number; label: string }
/** Anzeige von oben nach unten: oberste Videospur zuerst, dann A1, A2 … (tracks-Array geht von unten nach oben) */
export function rows(tracks: TLTrack[]): Row[] {
  const all = tracks.map((track, index) => ({ track, index }))
  const v = all.filter((r) => r.track.kind === 'video').map((r, i) => ({ ...r, label: `V${i + 1}` }))
  const a = all.filter((r) => r.track.kind === 'audio').map((r, i) => ({ ...r, label: `A${i + 1}` }))
  return [...v.reverse(), ...a]
}
/** Spur unter der Zeile row (Index in rows()); nur gleicher Art, sonst die Ausgangsspur */
export function trackAtRow(list: Row[], row: number, kind: TLTrack['kind'], fallback: string): string {
  const r = list[Math.max(0, Math.min(list.length - 1, row))]
  return r && r.track.kind === kind ? r.track.id : fallback
}

export interface Drag { clip: TLClip; mode: DragMode; dt: number; track?: string; ripple?: boolean; snapping: boolean; zoom: number; t: number }
/** Ops für den Zieh-Stand: dt = Versatz in s seit pointerdown, immer auf den Stand bei pointerdown angewendet */
export function dragOps(base: TimelineContent, d: Drag): TLOp[] {
  const c = d.clip
  const targets = d.snapping ? snapTargets(base, c.id, [d.t]) : []
  const tol = SNAP_PX / d.zoom
  const sn = (x: number) => (d.snapping ? snap(x, targets, tol) : x)
  if (d.mode === 'move') {
    const at = d.snapping ? snapSpan(Math.max(0, c.at + d.dt), clipLen(c), sn) : Math.max(0, c.at + d.dt)
    return [{ op: 'move', clip: c.id, at, ...(d.track && { track: d.track }) }]
  }
  const t = sn((d.mode === 'in' ? c.at : clipEnd(c)) + d.dt)
  return [{ op: 'trim', clip: c.id, edge: d.mode, t, ...(d.ripple && { ripple: true }) }]
}

/** Anfang oder Ende einer Spanne rastet ein, je nachdem was näher liegt; liefert den neuen Anfang (≥ 0) */
function snapSpan(at: number, len: number, sn: (x: number) => number): number {
  const s = sn(at), e = sn(at + len)
  const ds = Math.abs(s - at), de = Math.abs(e - at - len)
  if (s !== at && (e === at + len || ds <= de)) return s
  if (e !== at + len) return Math.max(0, e - len)
  return at
}

/** Blenden-Griff: dt = Versatz in s seit pointerdown; nach innen ziehen verlängert die Blende. Grenze 0..min(TL.fade.max, Clip-Länge) */
export function fadeDrag(c: TLClip, edge: 'in' | 'out', dt: number): Extract<TLOp, { op: 'set' }> {
  const [fi, fo] = c.fade ?? [0, 0]
  const max = Math.min(TL.fade.max, clipLen(c))
  const v = Math.round(Math.max(0, Math.min(max, (edge === 'in' ? fi + dt : fo - dt))) * 100) / 100
  return { op: 'set', clip: c.id, patch: { fade: edge === 'in' ? [v, fo] : [fi, v] } }
}

export interface OvDrag { i: number; mode: DragMode; dt: number; snapping: boolean; zoom: number; t: number; fps: number }
/** Text-Einblendung i verschieben (Mitte) oder trimmen (Kante), auf Bilder gerundet, Mindestlänge laut Schema (end > start + 0,3). Neuer Stand, base bleibt */
export function ovDrag(base: TimelineContent, d: OvDrag): TimelineContent {
  const o = base.overlays?.[d.i]
  if (!o) return base
  const targets = d.snapping ? snapTargets(base, undefined, [d.t]) : []
  const sn = (x: number) => (d.snapping ? snap(x, targets, SNAP_PX / d.zoom) : x)
  const min = (Math.floor(0.3 * d.fps) + 1) / d.fps // erstes Bild über 0,3 s
  const f = (x: number) => snapFrame(x, d.fps)
  let { start, end } = o
  if (d.mode === 'move') {
    start = f(snapSpan(Math.max(0, o.start + d.dt), o.end - o.start, sn))
    end = start + f(o.end - o.start)
  } else if (d.mode === 'in') start = Math.max(0, Math.min(f(sn(o.start + d.dt)), f(o.end) - min))
  else end = Math.max(f(sn(o.end + d.dt)), f(o.start) + min)
  const overlays = base.overlays!.slice()
  overlays[d.i] = { ...o, start: f(start), end: f(end) }
  return { ...base, overlays }
}

/** Lineal: große Teilung (beschriftet) und kleine Teilung in s, passend zu px/s. Kleine Teilung mind. ~8 px, Beschriftung mind. ~70 px */
export function ticks(zoom: number, fps: number): { major: number; minor: number } {
  const f = 1 / fps
  const steps = [f, 2 * f, 5 * f, 10 * f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
  const major = steps.find((s) => s * zoom >= 70) ?? 3600
  const minor = [...steps].reverse().find((s) => s < major && s * zoom >= 8 && Math.abs(major / s - Math.round(major / s)) < 1e-6) ?? major
  return { major, minor }
}
/** mm:ss, bei Bild-Teilung als :ff (Bild innerhalb der Sekunde), ab einer Stunde h:mm:ss */
export function fmtTick(s: number, fps: number, frames: boolean): string {
  const fr = Math.round(s * fps), sec = Math.floor(fr / fps + 1e-9), ff = fr - Math.round(sec * fps)
  if (frames && ff > 0) return `:${String(ff).padStart(2, '0')}`
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60
  const mm = `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return h ? `${h}:${mm}` : mm
}

/** Ausschnitt der Peaks (100 Werte/s Quellzeit) für den Clip, auf n Säulen verdichtet (Maximum je Säule), 0..1 */
export function wave(peaks: Uint8Array, c: Pick<TLClip, 'in' | 'out'>, n: number): number[] {
  const a = Math.max(0, Math.floor(c.in * 100)), b = Math.min(peaks.length, Math.ceil(c.out * 100))
  n = Math.max(1, Math.round(n))
  if (b <= a) return []
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const lo = a + Math.floor(((b - a) * i) / n), hi = Math.max(lo + 1, a + Math.floor(((b - a) * (i + 1)) / n))
    let m = 0
    for (let k = lo; k < hi && k < b; k++) m = Math.max(m, peaks[k])
    out.push(m / 255)
  }
  return out
}
