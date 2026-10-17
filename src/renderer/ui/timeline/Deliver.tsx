// Ausgabe der Pro-Timeline: Auflösung, Bildrate, Codec, Lautheitsziel; optional Lautheit messen und mit dem Ziel vergleichen
import { useState } from 'react'
import { CODECS, RESOLUTIONS, TL, deliverOf, type Codec, type Deliver as DeliverSpec, type TimelineContent } from '../../../shared/timeline'
import { Select } from '../kit'

const FPS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]
const CODEC_NAME: Record<Codec, string> = { h264: 'H.264', 'h264-10': 'H.264 10 bit', prores: 'ProRes 422 HQ', dnxhr: 'DNxHR HQX' }
const LUFS: [number, string][] = [[-14, 'Streaming'], [-16, 'Podcast'], [-23, 'EBU R128 Rundfunk'], [-24, 'ATSC']]
const de = (v: number, d = 1) => (+v.toFixed(d)).toLocaleString('de-DE', { maximumFractionDigits: d }).replace('-', '−')

type Res = { i: number; tp: number; lra: number }

export function Deliver({ tl, onChange, onMeasure }: { tl: TimelineContent; onChange: (tl: TimelineContent) => void; onMeasure?: () => Promise<Res | null> }) {
  const d = deliverOf(tl)
  const [free, setFree] = useState(() => !LUFS.some(([v]) => v === d.lufs))
  const [res, setRes] = useState<Res | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = (p: Partial<DeliverSpec>) => onChange({ ...tl, deliver: { ...tl.deliver, ...p } })
  const fpsList = FPS.includes(d.fps) ? FPS : [...FPS, d.fps].sort((a, b) => a - b)

  const measure = async () => {
    if (!onMeasure) return
    setBusy(true); setErr(null)
    try {
      const r = await onMeasure()
      setRes(r)
      if (!r) setErr('Messung ohne Ergebnis')
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const off = res ? res.i - d.lufs : 0

  return (
    <section className="tl-deliver">
      <h3>Ausgabe</h3>
      <label className="tl-field">
        <span>Auflösung</span>
        <Select value={d.res} onChange={(e) => set({ res: +e.target.value as DeliverSpec['res'] })}>
          {RESOLUTIONS.map((r) => <option key={r} value={r}>{r === 2160 ? '2160p „4K“' : `${r}p`}</option>)}
        </Select>
      </label>
      <label className="tl-field">
        <span>Bildrate</span>
        <Select value={d.fps} onChange={(e) => set({ fps: +e.target.value })}>
          {fpsList.map((f) => <option key={f} value={f}>{`${de(f, 3)} fps`}</option>)}
        </Select>
      </label>
      <label className="tl-field">
        <span>Codec</span>
        <Select value={d.codec} onChange={(e) => set({ codec: e.target.value as Codec })}>
          {CODECS.map((c) => <option key={c} value={c}>{CODEC_NAME[c]}</option>)}
        </Select>
      </label>
      <label className="tl-field">
        <span>Lautheit</span>
        <Select value={free ? 'frei' : d.lufs} onChange={(e) => {
          if (e.target.value === 'frei') return setFree(true)
          setFree(false)
          set({ lufs: +e.target.value })
        }}>
          {LUFS.map(([v, n]) => <option key={v} value={v}>{`${de(v)} LUFS · ${n}`}</option>)}
          <option value="frei">Frei</option>
        </Select>
      </label>
      {free && (
        <label className="tl-field">
          <span>Ziel (LUFS)</span>
          <input type="number" min={TL.lufs.min} max={TL.lufs.max} step={0.5} value={d.lufs}
            onChange={(e) => { const v = e.currentTarget.valueAsNumber; if (Number.isFinite(v)) set({ lufs: Math.min(TL.lufs.max, Math.max(TL.lufs.min, v)) }) }} />
        </label>
      )}
      {onMeasure && (
        <div className="tl-measure">
          <button className="plain" disabled={busy} onClick={measure}>{busy ? 'Messe …' : 'Lautheit messen'}</button>
          {res && <p>{`${de(res.i)} LUFS · TP ${de(res.tp)} dBTP · LRA ${de(res.lra)} LU`}</p>}
          {res && <p className="tl-hint">{Math.abs(off) < 0.5 ? 'Trifft das Ziel' : `${de(Math.abs(off))} LU ${off > 0 ? 'lauter' : 'leiser'} als das Ziel (${de(d.lufs)} LUFS)`}</p>}
          {err && <p className="tl-err" role="status">{err}</p>}
        </div>
      )}
    </section>
  )
}
