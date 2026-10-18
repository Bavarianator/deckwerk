// Farbseite (wie „Color“ in Resolve, vereinfacht): drei Farbräder, Sättigung, Temperatur, Looks, Vorher/Nachher, Scopes
import { useState } from 'react'
import { TL, type Grade, type RGB, type TimelineContent } from '../../../shared/timeline'
import { applyOps, type TLOp } from '../../../shared/timeline-edit'
import { GRADE_PRESETS, isNeutral } from '../../../shared/grade'
import { Select } from '../kit'
import { ColorWheel, Slider } from './ColorWheel'
import { Scopes } from './Scopes'
import { isStill } from './useTimelinePlayer'
import './color.css'

const PRESET_NAME: Record<string, string> = { neutral: 'Neutral', warm: 'Warm', kuehl: 'Kühl', kontrast: 'Kontrast', matt: 'Matt', sw: 'Schwarzweiß' }
const copy = (g?: Grade) => (isNeutral(g) ? undefined : structuredClone(g))

export function ColorPage(p: { tl: TimelineContent; clipId: string | null; video: HTMLVideoElement | null; onChange: (tl: TimelineContent, final: boolean) => void; bypass: boolean; onBypass: (b: boolean) => void }) {
  const [mode, setMode] = useState<'waveform' | 'histogram'>('waveform')
  const [err, setErr] = useState('')
  const track = p.tl.tracks.find((t) => t.kind === 'video' && t.clips.some((c) => c.id === p.clipId))
  const clip = track?.clips.find((c) => c.id === p.clipId)
  const g: Grade = clip?.grade ?? {}
  const scopes = (
    <div className="tl-color-scopes">
      <div className="tl-seg">
        <button aria-pressed={mode === 'waveform'} onClick={() => setMode('waveform')}>Waveform</button>
        <button aria-pressed={mode === 'histogram'} onClick={() => setMode('histogram')}>Histogramm</button>
      </div>
      <Scopes video={p.video} grade={p.bypass ? undefined : clip?.grade} sat={p.bypass ? undefined : g.sat} mode={mode} />
    </div>
  )
  if (!track || !clip) return <section className="tl-color"><p className="tl-hint">Videoclip in der Zeitleiste auswählen, um die Farbe einzustellen.</p>{scopes}</section>

  const run = (ops: TLOp[], final: boolean) => {
    try { p.onChange(applyOps(p.tl, ops), final); setErr('') } catch (e) { setErr(`Farbe nicht übernommen: ${(e as Error).message}`) }
  }
  const setG = (patch: Partial<Grade>, f: boolean) => run([{ op: 'set', clip: clip.id, patch: { grade: { ...g, ...patch } } }], f)
  const preset = Object.keys(GRADE_PRESETS).find((k) => JSON.stringify(GRADE_PRESETS[k]) === JSON.stringify(g)) ?? ''
  const others = p.tl.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips).filter((c) => c.id !== clip.id && !isStill(c.src))
  const prev = [...track.clips].sort((a, b) => a.at - b.at).filter((c) => c.at < clip.at).pop()
  const wheel = (label: string, k: 'lift' | 'gamma' | 'gain', n: number) => (
    <ColorWheel label={label} v={g[k] ?? [n, n, n]} lim={TL[k]} neutral={n} onSet={(v: RGB, f) => setG({ [k]: v }, f)} />
  )

  return (
    <section className="tl-color">
      <div className="tl-color-bar">
        <label className="tl-field">
          <span>Look</span>
          <Select value={preset} onChange={(e) => e.target.value && run([{ op: 'set', clip: clip.id, patch: { grade: copy(GRADE_PRESETS[e.target.value]) } }], true)}>
            <option value="">Eigener</option>
            {Object.keys(GRADE_PRESETS).map((k) => <option key={k} value={k}>{PRESET_NAME[k] ?? k}</option>)}
          </Select>
        </label>
        <button className="plain" aria-pressed={p.bypass} onClick={() => p.onBypass(!p.bypass)}>{p.bypass ? 'Vorher' : 'Nachher'}</button>
        <button className="plain" disabled={!clip.grade} onClick={() => run([{ op: 'set', clip: clip.id, patch: { grade: undefined } }], true)}>Zurücksetzen</button>
      </div>
      <div className="tl-color-wheels">
        {wheel('Lift', 'lift', 0)}
        {wheel('Gamma', 'gamma', 1)}
        {wheel('Gain', 'gain', 1)}
      </div>
      <Slider label="Sättigung" value={g.sat ?? 1} min={TL.sat.min} max={TL.sat.max} step={0.01} onSet={(v, f) => setG({ sat: v }, f)} />
      <Slider label="Temperatur" value={g.temp ?? 0} min={TL.temp.min} max={TL.temp.max} step={0.01} onSet={(v, f) => setG({ temp: v }, f)} />
      <div className="tl-color-bar">
        <button className="plain" disabled={!others.length} onClick={() => run(others.map((c) => ({ op: 'set', clip: c.id, patch: { grade: copy(clip.grade) } })), true)}>Auf alle Videoclips übertragen</button>
        <button className="plain" disabled={!prev} onClick={() => prev && run([{ op: 'set', clip: clip.id, patch: { grade: copy(prev.grade) } }], true)}>Vom vorigen Clip übernehmen</button>
      </div>
      {err && <p className="tl-hint tl-color-err" role="alert">{err}</p>}
      {scopes}
    </section>
  )
}
