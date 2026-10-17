// Wellenform aus fertigen Peaks (Main rechnet sie, der Renderer dekodiert nie die ganze Datei), Cursor folgt dem übergebenen Medienelement.
// Bereiche: Schnitte (grau, durchgestrichen, Kanten ziehbar), Ausschnitte eines Clips, Highlights; Marken: Soundeffekte (Akzent) und Kapitel (Linie mit Titel).
import { memo, useEffect, useRef } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js'

export interface Peaks { duration: number; rate: number; data: number[] }
export interface WaveSpan { start: number; end: number; kind: 'cut' | 'part' | 'on' | 'mark'; title?: string; sel?: boolean }
export interface WaveMark { at: number; kind: 'sfx' | 'chapter'; title?: string }

interface Props {
  peaks: Peaks
  media: HTMLMediaElement | null // spielt die Quelle ab, deren Zeit die Wellenform zeigt
  spans?: WaveSpan[]
  marks?: WaveMark[]
  onSeek?: (s: number) => void
  onSpan?: (i: number, start: number, end: number) => void // Schnittkante gezogen (nur kind cut)
  onSpanClick?: (i: number) => void
  timeline?: boolean
  height?: number
  label: string
}

const MAX = 6000 // Werte je Wellenform: ein 8-h-Stream hätte sonst Hunderttausende
const thin = (d: number[]) => {
  if (d.length <= MAX) return d
  const k = d.length / MAX
  return Array.from({ length: MAX }, (_, i) => { let m = 0; for (let j = Math.floor(i * k); j < Math.floor((i + 1) * k); j++) m = Math.max(m, d[j]); return m })
}
// Farben aus den App-Variablen (hell/dunkel), gelesen beim Aufbau
const vars = (el: Element) => {
  const s = getComputedStyle(el), v = (n: string, d: string) => s.getPropertyValue(n).trim() || d
  return { accent: v('--accent', '#4f52d9'), text: v('--text', '#16161a'), muted: v('--muted', '#5e5e66'), faint: v('--faint', '#6e6e76'), border: v('--border-strong', 'rgb(22 22 26 / 0.14)') }
}
const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`

export const Waveform = memo(function Waveform({ peaks, media, spans = [], marks = [], onSeek, onSpan, onSpanClick, timeline, height = 72, label }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const ws = useRef<{ w: WaveSurfer; r: RegionsPlugin } | null>(null)
  const cb = useRef({ onSeek, onSpan, onSpanClick })
  cb.current = { onSeek, onSpan, onSpanClick }

  useEffect(() => {
    if (!box.current || !media) return
    const c = vars(box.current)
    const r = RegionsPlugin.create()
    const w = WaveSurfer.create({
      container: box.current, media, peaks: [thin(peaks.data)], duration: peaks.duration, height, normalize: true,
      waveColor: mix(c.muted, 55), progressColor: c.text, cursorColor: c.accent, cursorWidth: 2, barWidth: 2, barGap: 1, barRadius: 1,
      plugins: [r, ...(timeline ? [TimelinePlugin.create({ height: 16, style: { color: c.faint, fontSize: '10px' } })] : [])],
    })
    w.on('interaction', (t) => cb.current.onSeek?.(t))
    r.on('region-updated', (x) => { const i = Number(x.id.slice(1)); if (x.id[0] === 's') cb.current.onSpan?.(i, x.start, x.end) })
    r.on('region-clicked', (x) => { if (x.id[0] === 's') cb.current.onSpanClick?.(Number(x.id.slice(1))) })
    ws.current = { w, r }
    return () => { ws.current = null; w.destroy() }
  }, [media, peaks, height, timeline])

  // Bereiche und Marken neu setzen, wenn sie sich ändern (nach dem Ziehen kommt die gespeicherte Fassung zurück)
  const key = JSON.stringify([spans, marks])
  useEffect(() => {
    const x = ws.current
    if (!x || !box.current) return
    const c = vars(box.current)
    x.r.clearRegions()
    spans.forEach((s, i) => {
      const cut = s.kind === 'cut', edit = cut && !!onSpan
      const el = document.createElement('div')
      el.title = s.title ?? ''
      // Schnitt: grau mit Linie durch die Mitte; Auswahl kräftiger
      Object.assign(el.style, cut
        ? { position: 'absolute', left: '0', right: '0', top: '50%', height: '1px', background: s.sel ? c.accent : c.muted, pointerEvents: 'none' }
        : s.kind === 'mark' ? { position: 'absolute', inset: '0', borderLeft: `1px solid ${c.faint}`, pointerEvents: 'none' } : { display: 'none' })
      x.r.addRegion({
        id: `s${i}`, start: s.start, end: s.end, drag: false, resize: edit, content: el,
        color: cut ? mix(c.muted, s.sel ? 40 : 28) : s.kind === 'on' ? mix(c.accent, 22) : s.kind === 'part' ? mix(c.muted, 14) : 'transparent',
      })
    })
    marks.forEach((m, i) => {
      const el = document.createElement('div')
      el.textContent = m.kind === 'chapter' ? m.title ?? '' : ''
      el.title = m.title ?? (m.kind === 'sfx' ? 'Soundeffekt' : '')
      Object.assign(el.style, { padding: '0 4px', fontSize: '10.5px', lineHeight: '14px', color: c.muted, whiteSpace: 'nowrap', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis' })
      x.r.addRegion({ id: `m${i}`, start: m.at, drag: false, resize: false, content: el, color: m.kind === 'sfx' ? c.accent : c.border })
    })
  }, [key, media, peaks, height, timeline, !!onSpan])

  return <div className="dv-wave" ref={box} role="group" aria-label={label} />
})
