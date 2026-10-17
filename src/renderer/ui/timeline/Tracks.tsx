// Spuren der Pro-Timeline: Spurköpfe links (V oben, A darunter), Clips als flache Balken mit Wellenform.
// Ziehen: Mitte verschiebt (auch auf andere Spur gleicher Art), Kanten trimmen, Alt an der Kante = ripple. Jeder Zieh-Stand geht vom Stand bei pointerdown aus
import { memo, useCallback, useRef, type PointerEvent as RPointerEvent } from 'react'
import { TL, clipLen, tlDuration, type TLClip, type TLTrack, type TimelineContent } from '../../../shared/timeline'
import { applyOps } from '../../../shared/timeline-edit'
import { dragOps, modeAt, rows, trackAtRow, wave, type DragMode } from './drag'
import { PAD_S } from './Ruler'

const DRAG_PX = 3 // erst ab dieser Bewegung ziehen, sonst ist es ein Klick
const nameOf = (src: string) => src.split(/[\\/]/).pop()?.replace(/[?#].*$/, '') || src

export function Tracks({ tl, t, zoom, fps, snapping, selected, onSelect, onSeek, onDraft, onCommit, peaks }: {
  tl: TimelineContent; t: number; zoom: number; fps: number; snapping: boolean; selected: string | null
  onSelect: (id: string | null) => void; onSeek: (t: number) => void; onDraft: (tl: TimelineContent) => void; onCommit: (tl: TimelineContent) => void
  peaks: (src: string) => Uint8Array | undefined
}) {
  const box = useRef<HTMLDivElement>(null)
  const list = rows(tl.tracks)
  const w = (tlDuration(tl) + PAD_S) * zoom

  const setTrack = (id: string, patch: Partial<Pick<TLTrack, 'hide' | 'mute'>>) => {
    const next = structuredClone(tl)
    Object.assign(next.tracks.find((x) => x.id === id)!, patch)
    onCommit(next)
  }
  const add = (kind: TLTrack['kind']) => { try { onCommit(applyOps(tl, [{ op: 'add_track', kind }], fps)) } catch { /* Grenze erreicht, Knopf ist dann aus */ } }

  const grab = (e: RPointerEvent<HTMLDivElement>, clip: TLClip) => {
    const track = tl.tracks.find((x) => x.clips.some((c) => c.id === clip.id))
    if (e.button !== 0 || !track) return
    e.stopPropagation()
    e.preventDefault()
    onSelect(clip.id)
    const r = e.currentTarget.getBoundingClientRect()
    const mode: DragMode = modeAt(e.clientX - r.left, r.width)
    const base = tl, x0 = e.clientX, y0 = e.clientY
    // Zeilen-Lagen beim Start messen: der Clip wandert beim Spurwechsel in eine andere Zeile (neues Element), darum Fenster-Listener statt Capture
    const tops = [...(box.current?.querySelectorAll<HTMLElement>('.tl-row') ?? [])].map((el) => el.getBoundingClientRect())
    let last = base, moved = false
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_PX) return
      moved = true
      let row = tops.findIndex((b) => ev.clientY >= b.top && ev.clientY < b.bottom)
      if (row < 0) row = ev.clientY < (tops[0]?.top ?? 0) ? 0 : tops.length - 1
      const dest = mode === 'move' ? trackAtRow(list, row, track.kind, track.id) : undefined
      try {
        last = applyOps(base, dragOps(base, { clip, mode, dt: (ev.clientX - x0) / zoom, track: dest !== track.id ? dest : undefined, ripple: mode !== 'move' && ev.altKey, snapping, zoom, t }), fps)
        onDraft(last)
      } catch { /* Überlappung o. Ä.: letzter gültiger Stand bleibt */ }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (moved && last !== base) onCommit(last)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // Stabiler Griff für die memoisierten Clips: grab sieht trotzdem immer den aktuellen Stand
  const grabRef = useRef(grab)
  grabRef.current = grab
  const onDown = useCallback((e: RPointerEvent<HTMLDivElement>, c: TLClip) => grabRef.current(e, c), [])

  const empty = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    onSelect(null)
    onSeek(Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom))
  }

  return (
    <div className="tl-tracks" ref={box} style={{ width: `calc(var(--tl-head) + ${w}px)` }}>
      {list.map(({ track, label }) => {
        const off = track.kind === 'video' ? track.hide : track.mute
        return (
          <div key={track.id} className={`tl-row ${track.kind}${off ? ' off' : ''}`}>
            <div className="tl-track-head">
              <b>{label}</b>
              {track.kind === 'video'
                ? <button className="plain" aria-pressed={!!track.hide} title={track.hide ? 'Spur einblenden' : 'Spur ausblenden'} onClick={() => setTrack(track.id, { hide: !track.hide })}>{track.hide ? 'Aus' : 'Bild'}</button>
                : <button className="plain" aria-pressed={!!track.mute} title={track.mute ? 'Ton an' : 'Stumm'} onClick={() => setTrack(track.id, { mute: !track.mute })}>{track.mute ? 'Stumm' : 'Ton'}</button>}
            </div>
            <div className="tl-lane" style={{ width: w }} onPointerDown={empty}>
              {track.clips.map((c) => <Clip key={c.id} c={c} on={c.id === selected} zoom={zoom} p={peaks(c.src)} onDown={onDown} />)}
            </div>
          </div>
        )
      })}
      <div className="tl-add">
        <button className="plain" disabled={tl.tracks.length >= TL.tracks} onClick={() => add('video')}>+ Spur Video</button>
        <button className="plain" disabled={tl.tracks.length >= TL.tracks} onClick={() => add('audio')}>+ Spur Audio</button>
      </div>
      <div className="tl-playhead" style={{ left: `calc(var(--tl-head) + ${t * zoom}px)` }} />
    </div>
  )
}

// Memoisiert: der Abspielkopf (t) ändert sich jedes Bild, Balken und Wellenform nur bei Clip, Zoom, Auswahl oder Peaks
const Clip = memo(function Clip({ c, on, zoom, p, onDown }: { c: TLClip; on: boolean; zoom: number; p?: Uint8Array; onDown: (e: RPointerEvent<HTMLDivElement>, c: TLClip) => void }) {
  const cw = Math.max(2, clipLen(c) * zoom)
  const v = p ? wave(p, c, Math.min(2000, cw / 2)) : []
  return (
    <div className={`tl-clip${on ? ' on' : ''}${c.mute ? ' muted' : ''}`} style={{ left: c.at * zoom, width: cw }}
      title={`${nameOf(c.src)} · ${clipLen(c).toFixed(2).replace('.', ',')} s`} onPointerDown={(e) => onDown(e, c)}>
      {v.length > 0 && (
        <svg className="tl-wave" viewBox={`0 0 ${v.length} 1`} preserveAspectRatio="none" aria-hidden>
          <path d={`M0 1${v.map((y, i) => `V${(1 - y).toFixed(3)}H${i + 1}`).join('')}V1Z`} />
        </svg>
      )}
      <span className="tl-clip-name">{nameOf(c.src)}</span>
      <i className="tl-edge l" aria-hidden />
      <i className="tl-edge r" aria-hidden />
    </div>
  )
})
