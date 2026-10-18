// Lineal der Pro-Timeline: Teilung passend zum Zoom (px/s), Marker, Abspielkopf. Klicken/Ziehen setzt die Abspielposition.
// Links ein Leerfeld in Breite der Spurköpfe (--tl-head), damit Lineal und Spuren im gemeinsamen Scrollbereich übereinanderliegen
import { useRef, type PointerEvent as RPointerEvent } from 'react'
import type { Marker } from '../../../shared/timeline'
import { fmtTick, ticks } from './drag'

export const PAD_S = 10 // Luft hinter dem letzten Clip (s), gleich in Tracks

export function Ruler({ duration, zoom, t, fps, markers, onSeek }: { duration: number; zoom: number; t: number; fps: number; markers?: Marker[]; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const span = duration + PAD_S, w = span * zoom
  const { major, minor } = ticks(zoom, fps)
  const at = (e: { clientX: number }) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.max(0, Math.min(duration, (e.clientX - r.left) / zoom))
  }
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    onSeek(at(e))
    el.onpointermove = (ev) => onSeek(at(ev))
    el.onpointerup = el.onpointercancel = () => { el.onpointermove = el.onpointerup = el.onpointercancel = null }
  }
  // Teilstriche als ein Pfad je Stärke; Beschriftung nur an der großen Teilung
  let small = '', big = ''
  const labels: { x: number; s: string }[] = []
  const n = Math.floor(span / minor + 1e-6)
  for (let i = 0; i <= n; i++) {
    const s = i * minor, x = +(s * zoom).toFixed(1)
    const isMajor = Math.abs(s / major - Math.round(s / major)) < 1e-6
    if (isMajor) { big += `M${x} 10V22`; labels.push({ x, s: fmtTick(s, fps, major < 1) }) }
    else small += `M${x} 16V22`
  }
  return (
    <div className="tl-ruler" style={{ width: `calc(var(--tl-head) + ${w}px)` }}>
      <div className="tl-ruler-head" />
      <div className="tl-ruler-body" ref={ref} style={{ width: w }} onPointerDown={down}>
        <svg className="tl-ruler-ticks" width={w} height={22} aria-hidden>
          <path className="tl-tick-minor" d={small} />
          <path className="tl-tick-major" d={big} />
        </svg>
        {labels.map((l) => <span key={l.x} className="tl-ruler-label" style={{ left: l.x }}>{l.s}</span>)}
        {markers?.map((m, i) => (
          <div key={i} className="tl-marker" style={{ left: m.t * zoom }} title={`${m.name} · ${fmtTick(m.t, fps, false)}`}>
            <span>{m.name}</span>
          </div>
        ))}
        <div className="tl-ruler-playhead" style={{ left: t * zoom }} />
      </div>
    </div>
  )
}
