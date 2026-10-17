// Inspector der Pro-Timeline für den ausgewählten Clip: Clip, Farbe, Ton. Regler melden live (final = false) und beim Loslassen (final = true)
import { useEffect, useRef, useState } from 'react'
import { EQ_HZ, TL, type Eq, type Grade, type RGB, type TLClip, type TimelineContent } from '../../../shared/timeline'
import { applyOps } from '../../../shared/timeline-edit'
import { GRADE_PRESETS } from '../../../shared/grade'
import { Select } from '../kit'

type Patch = Partial<Omit<TLClip, 'id'>>
const num = (v: number, d = 2) => (+v.toFixed(d)).toString().replace('.', ',').replace('-', '−')
const PRESET_NAME: Record<string, string> = { neutral: 'Neutral', warm: 'Warm', kuehl: 'Kühl', kontrast: 'Kontrast', matt: 'Matt', sw: 'Schwarzweiß' }
const hz = (n: number) => (n >= 1000 ? `${n / 1000} kHz` : `${n} Hz`)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Range-Regler: onInput live, natives change (Loslassen, Tastatur) final. React-onChange feuert bei range schon bei jeder Bewegung
function Slider({ label, value, min, max, step, fmt, onSet }: { label: string; value: number; min: number; max: number; step: number; fmt?: (v: number) => string; onSet: (v: number, final: boolean) => void }) {
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

// Zahlenfeld mit eigenem Text: übernimmt erst bei Blur oder Enter, damit Klemmen und Sortieren nicht beim Tippen springen
function NumField({ label, step, value, onCommit }: { label: string; step: number; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const done = () => { const v = parseFloat(text.replace(',', '.')); if (Number.isFinite(v) && v !== value) onCommit(v); setText(String(value)) }
  return <input type="number" aria-label={label} step={step} value={text} onChange={(e) => setText(e.currentTarget.value)} onBlur={done} onKeyDown={(e) => e.key === 'Enter' && done()} />
}

const avg = (v: RGB) => (v[0] + v[1] + v[2]) / 3
// Master verschiebt alle Kanäle gemeinsam, Abstände zwischen R/G/B bleiben
function Wheel({ label, v, lim, onSet }: { label: string; v: RGB; lim: { min: number; max: number }; onSet: (v: RGB, final: boolean) => void }) {
  const m = avg(v)
  const start = useRef<RGB | null>(null) // Stand bei Ziehbeginn: Delta von dort, sonst driften die Abstände am Anschlag
  const master = (x: number, f: boolean) => {
    const b = (start.current ??= v), m0 = avg(b)
    onSet(b.map((c) => clamp(c + x - m0, lim.min, lim.max)) as RGB, f)
    if (f) start.current = null
  }
  return (
    <div className="tl-wheel">
      <Slider label={label} value={+m.toFixed(3)} min={lim.min} max={lim.max} step={0.01} onSet={master} />
      <details>
        <summary>R G B</summary>
        {(['R', 'G', 'B'] as const).map((n, i) => (
          <Slider key={n} label={n} value={v[i]} min={lim.min} max={lim.max} step={0.01} onSet={(x, f) => onSet(v.map((c, j) => (j === i ? x : c)) as RGB, f)} />
        ))}
      </details>
    </div>
  )
}

export function Inspector({ tl, clipId, onChange }: { tl: TimelineContent; clipId: string | null; onChange: (tl: TimelineContent, final: boolean) => void }) {
  const ti = clipId ? tl.tracks.findIndex((x) => x.clips.some((c) => c.id === clipId)) : -1
  if (!clipId || ti < 0) return <section className="tl-insp"><p className="tl-hint">Clip in der Zeitleiste auswählen, um Tempo, Farbe und Ton einzustellen.</p></section>
  const track = tl.tracks[ti], clip = track.clips.find((c) => c.id === clipId)!
  const video = track.kind === 'video'
  const upper = video && tl.tracks.findIndex((x) => x.kind === 'video') !== ti // V2+

  const set = (patch: Patch, final: boolean) => {
    try { onChange(applyOps(tl, [{ op: 'set', clip: clipId, patch }]), final) } catch { if (final) onChange(tl, true) } // z. B. Überlappung durch Tempo: letzten gültigen Stand speichern
  }
  const g: Grade = clip.grade ?? {}
  const setG = (p: Partial<Grade>, f: boolean) => set({ grade: { ...g, ...p } }, f)
  const eq: Eq = clip.eq ?? {}
  const preset = Object.keys(GRADE_PRESETS).find((k) => JSON.stringify(GRADE_PRESETS[k]) === JSON.stringify(g)) ?? ''
  const box = clip.box ?? [0, 0, 1]
  const keys = clip.keys ?? []
  const setKeys = (k: [number, number][]) => set({ keys: [...k].sort((a, b) => a[0] - b[0]) }, true)

  return (
    <section className="tl-insp">
      <h3>Clip</h3>
      <Slider label="Tempo" value={clip.speed ?? 1} min={TL.speed.min} max={TL.speed.max} step={0.05} fmt={(v) => `${num(v)}×`} onSet={(v, f) => set({ speed: v }, f)} />
      <Slider label="Lautstärke" value={clip.volume ?? 1} min={TL.volume.min} max={TL.volume.max} step={0.01} fmt={(v) => `${Math.round(v * 100)} %`} onSet={(v, f) => set({ volume: v }, f)} />
      <label className="tl-check"><input type="checkbox" checked={!!clip.mute} onChange={(e) => set({ mute: e.currentTarget.checked }, true)} /> Stumm</label>
      {video && <>
        <label className="tl-field">
          <span>Bild</span>
          <Select value={clip.fit ?? 'crop'} onChange={(e) => set({ fit: e.target.value as 'crop' | 'contain' }, true)}>
            <option value="crop">Füllen (beschneiden)</option>
            <option value="contain">Ganz zeigen</option>
          </Select>
        </label>
        {(clip.fit ?? 'crop') === 'crop' && <Slider label="Mittelpunkt" value={clip.focus ?? 0.5} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)} %`} onSet={(v, f) => set({ focus: v }, f)} />}
      </>}
      {upper && <>
        {(['x', 'y', 'Breite'] as const).map((n, i) => (
          <Slider key={n} label={n === 'Breite' ? n : `Lage ${n}`} value={box[i]} min={i === 2 ? 0.05 : 0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)} %`}
            onSet={(v, f) => set({ box: box.map((c, j) => (j === i ? v : c)) as [number, number, number] }, f)} />
        ))}
        {clip.box && <button className="plain" onClick={() => set({ box: undefined }, true)}>Vollbild</button>}
      </>}

      {video && <>
        <h3>Farbe</h3>
        <label className="tl-field">
          <span>Look</span>
          <Select value={preset} onChange={(e) => e.target.value && set({ grade: structuredClone(GRADE_PRESETS[e.target.value]) }, true)}>
            {!preset && <option value="">Eigene</option>}
            {Object.keys(GRADE_PRESETS).map((k) => <option key={k} value={k}>{PRESET_NAME[k] ?? k}</option>)}
          </Select>
        </label>
        <Wheel label="Lift" v={g.lift ?? [0, 0, 0]} lim={TL.lift} onSet={(v, f) => setG({ lift: v }, f)} />
        <Wheel label="Gamma" v={g.gamma ?? [1, 1, 1]} lim={TL.gamma} onSet={(v, f) => setG({ gamma: v }, f)} />
        <Wheel label="Gain" v={g.gain ?? [1, 1, 1]} lim={TL.gain} onSet={(v, f) => setG({ gain: v }, f)} />
        <Slider label="Sättigung" value={g.sat ?? 1} min={TL.sat.min} max={TL.sat.max} step={0.01} onSet={(v, f) => setG({ sat: v }, f)} />
        <Slider label="Temperatur" value={g.temp ?? 0} min={TL.temp.min} max={TL.temp.max} step={0.01} onSet={(v, f) => setG({ temp: v }, f)} />
        <button className="plain" disabled={!clip.grade} onClick={() => set({ grade: undefined }, true)}>Zurücksetzen</button>
      </>}

      <h3>Ton</h3>
      {(['low', 'mid', 'high'] as const).map((k) => (
        <Slider key={k} label={`${{ low: 'Tiefen', mid: 'Mitten', high: 'Höhen' }[k]} ${hz(EQ_HZ[k])}`} value={eq[k] ?? 0} min={TL.eq.min} max={TL.eq.max} step={0.5}
          fmt={(v) => `${num(v, 1)} dB`} onSet={(v, f) => set({ eq: { ...eq, [k]: v } }, f)} />
      ))}
      <div className="tl-keys">
        <span>Pegel-Keyframes (Quellsekunde, dB)</span>
        {keys.map(([s, db], i) => (
          <div key={i} className="tl-key">
            <NumField label="Quellsekunde" step={0.1} value={s} onCommit={(v) => setKeys(keys.map((k, j) => (j === i ? [clamp(v, clip.in, clip.out), k[1]] : k)))} />
            <NumField label="dB" step={0.5} value={db} onCommit={(v) => setKeys(keys.map((k, j) => (j === i ? [k[0], clamp(v, TL.db.min, TL.db.max)] : k)))} />
            <button className="plain" aria-label="Keyframe entfernen" onClick={() => set({ keys: keys.filter((_, j) => j !== i) }, true)}>Entfernen</button>
          </div>
        ))}
        <button className="plain" onClick={() => setKeys([...keys, [keys.length ? Math.min(clip.out, keys[keys.length - 1][0] + 1) : clip.in, 0]])}>+ Keyframe</button>
      </div>
    </section>
  )
}
