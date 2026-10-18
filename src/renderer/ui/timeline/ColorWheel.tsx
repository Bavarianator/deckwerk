// Farbrad für Lift/Gamma/Gain: Punkt ziehen = Farbverschiebung, Regler darunter = Master, Doppelklick = zurück
import { useEffect, useRef } from 'react'
import type { RGB } from '../../../shared/timeline'
import { rgbToWheel, wheelToRgb } from './wheel-math'

type Lim = { min: number; max: number }
const num = (v: number) => String(+v.toFixed(2)).replace('.', ',')

// Range-Regler: onInput live, natives change (Loslassen, Tastatur) final, wie im Inspector
export function Slider({ label, value, min, max, step, fmt, onSet }: { label: string; value: number; min: number; max: number; step: number; fmt?: (v: number) => string; onSet: (v: number, final: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const cb = useRef(onSet)
  cb.current = onSet
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fin = () => cb.current(+el.value, true)
    el.addEventListener('change', fin)
    return () => el.removeEventListener('change', fin)
  }, [])
  return (
    <label className="tl-field">
      <span>{label}</span>
      <input ref={ref} type="range" min={min} max={max} step={step} value={value} onInput={(e) => onSet(+e.currentTarget.value, false)} onChange={() => {}} />
      <output>{fmt ? fmt(value) : num(value)}</output>
    </label>
  )
}

const STEP = 0.05 // Tastaturschritt im Einheitskreis

export function ColorWheel({ label, v, lim, neutral, onSet }: { label: string; v: RGB; lim: Lim; neutral: number; onSet: (v: RGB, final: boolean) => void }) {
  const w = rgbToWheel(v, lim)
  // Stand bei Ziehbeginn einfrieren: das Klemmen je Kanal ließe Master und Punkt sonst während des Zugs wandern
  const drag = useRef<{ x: number; y: number; master: number } | null>(null)
  const last = useRef<RGB | null>(null) // letzter Live-Wert, beim Loslassen final; reiner Klick schreibt nichts
  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const nv = wheelToRgb(((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2, drag.current!.master, lim)
    last.current = nv
    onSet(nv, false)
  }
  const up = () => { if (last.current) onSet(last.current, true); last.current = drag.current = null }
  const slide = useRef<{ x: number; y: number } | null>(null)
  const master = (m: number, f: boolean) => {
    const s = (slide.current ??= { x: w.x, y: w.y })
    onSet(wheelToRgb(s.x, s.y, m, lim), f)
    if (f) slide.current = null
  }
  const key = (e: React.KeyboardEvent) => {
    const d = { ArrowRight: [STEP, 0], ArrowLeft: [-STEP, 0], ArrowUp: [0, STEP], ArrowDown: [0, -STEP] }[e.key]
    if (e.key === 'Home') { e.preventDefault(); onSet(wheelToRgb(0, 0, w.master, lim), true) }
    if (!d) return
    e.preventDefault()
    onSet(wheelToRgb(w.x + d[0], w.y + d[1], w.master, lim), true)
  }
  return (
    <div className="tl-cwheel">
      <div className="tl-cwheel-disc" role="slider" tabIndex={0} aria-label={`${label}-Farbrad`}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.hypot(w.x, w.y) * 100)}
        aria-valuetext={`R ${num(v[0])}, G ${num(v[1])}, B ${num(v[2])}`}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = w; last.current = null }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && drag.current && at(e)}
        onPointerUp={up} onPointerCancel={up} onKeyDown={key}
        onDoubleClick={() => { last.current = drag.current = null; onSet([neutral, neutral, neutral], true) }}>
        <i style={{ left: `${50 + w.x * 50}%`, top: `${50 - w.y * 50}%` }} />
      </div>
      <b>{label}</b>
      <Slider label="Master" value={+w.master.toFixed(3)} min={lim.min} max={lim.max} step={0.01}
        onSet={master} />
    </div>
  )
}
