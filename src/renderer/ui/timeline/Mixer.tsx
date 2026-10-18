// Mixer der Ton-Seite: je Spur ein Kanalzug (Name, Fader, Stumm) und ein Master-Pegelmesser
import { useEffect, useRef } from 'react'
import { TL, type TimelineContent } from '../../../shared/timeline'
import { rows } from './drag'
import './mixer.css'

/** Faktor (1 = 0 dB) → Anzeige in dB; 0 = −∞ */
export function dbText(v: number): string {
  if (v <= 0.001) return '−∞'
  const d = Math.round(20 * Math.log10(v) * 10) / 10 || 0 // || 0 macht aus −0 eine 0
  return `${d > 0 ? '+' : ''}${d.toFixed(1).replace('.', ',').replace('-', '−')} dB`
}

const METER_MIN = -60 // dBFS am unteren Rand der Anzeige

// Fader: onInput live, natives change (Loslassen, Tastatur) final; Doppelklick = 0 dB
function Fader({ value, label, onSet }: { value: number; label: string; onSet: (v: number, final: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const cb = useRef(onSet)
  cb.current = onSet
  const finRef = useRef<(v: number) => void>(() => {})
  const last = useRef<number | null>(null) // letzter gemeldeter Final-Wert: Doppelklick löst sonst mehrere change aus
  const fin = (v: number, force = false) => { if (force || v !== last.current) { last.current = v; cb.current(v, true) } }
  finRef.current = (v) => fin(v)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fin = () => finRef.current(+el.value)
    el.addEventListener('change', fin)
    return () => el.removeEventListener('change', fin)
  }, [])
  return <input ref={ref} className="mx-fader" type="range" aria-label={`Lautstärke ${label}`} min={TL.volume.min} max={TL.volume.max} step={0.01} value={value}
    onInput={(e) => onSet(+e.currentTarget.value, false)} onChange={() => {}} onDoubleClick={() => fin(1, true)} />
}

// Master-Pegel: rAF nur mit master, Balken direkt per Style
function MasterMeter({ master }: { master: AudioNode | null }) {
  const bar = useRef<HTMLDivElement>(null)
  const txt = useRef<HTMLOutputElement>(null)
  useEffect(() => {
    if (!master) return
    // eigener Analyser, damit er im Cleanup wieder vom master getrennt wird
    const an = (master.context as AudioContext).createAnalyser()
    an.fftSize = 2048
    master.connect(an)
    const buf = new Float32Array(an.fftSize)
    const read = () => {
      an.getFloatTimeDomainData(buf)
      let pk = 0
      for (const x of buf) pk = Math.max(pk, Math.abs(x))
      return 20 * Math.log10(Math.max(pk, 1e-5))
    }
    let raf = 0
    const tick = () => {
      const db = read()
      if (bar.current) bar.current.style.height = `${Math.max(0, Math.min(1, (db - METER_MIN) / -METER_MIN)) * 100}%`
      if (txt.current) txt.current.textContent = db <= -99 ? '−∞' : `${db.toFixed(0).replace('-', '−')} dB`
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); try { master.disconnect(an) } catch { /* schon getrennt */ }; if (bar.current) bar.current.style.height = '0%' }
  }, [master])
  return (
    <div className="mx-strip mx-master">
      <span className="mx-name">Master</span>
      <div className="mx-meter" role="meter" aria-label="Master-Pegel"><div ref={bar} className="mx-bar" /></div>
      <output ref={txt} className="mx-db">−∞</output>
    </div>
  )
}

export function Mixer(p: { tl: TimelineContent; master: AudioNode | null; onChange: (tl: TimelineContent, final: boolean) => void }) {
  const patch = (id: string, change: { volume?: number; mute?: boolean }, final: boolean) => {
    const tl = structuredClone(p.tl)
    const t = tl.tracks.find((x) => x.id === id)
    if (!t) return
    Object.assign(t, change)
    p.onChange(tl, final)
  }
  return (
    <div className="mx">
      {rows(p.tl.tracks).map(({ track, label }) => (
        <div key={track.id} className={`mx-strip${track.mute ? ' off' : ''}`}>
          <span className="mx-name">{label}</span>
          <Fader value={track.volume ?? 1} label={label} onSet={(v, f) => patch(track.id, { volume: v }, f)} />
          <output className="mx-db">{dbText(track.volume ?? 1)}</output>
          {/* mute nimmt im Export auch bei Videospuren den Ton der Spur weg (timeline-ffmpeg sections) */}
          <button type="button" className="mx-mute" aria-pressed={!!track.mute} title={track.kind === 'video' ? 'Ton der Spur stumm' : 'Spur stumm'}
            onClick={() => patch(track.id, { mute: !track.mute || undefined }, true)}>{track.kind === 'video' ? 'Ton aus' : 'Stumm'}</button>
        </div>
      ))}
      <MasterMeter master={p.master} />
    </div>
  )
}
