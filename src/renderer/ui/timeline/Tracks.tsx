// Spuren der Pro-Timeline: Spurköpfe links (V oben, A darunter), Clips als flache Balken mit Wellenform.
// Ziehen: Mitte verschiebt (auch auf andere Spur gleicher Art), Kanten trimmen, Alt an der Kante = ripple, Griffe oben an den Ecken setzen die Blenden.
// Jeder Zieh-Stand geht vom Stand bei pointerdown aus. Darüber die Titel-Spur (Text-Einblendungen, ziehbar) und Untertitel (nur Anzeige); Medien lassen sich auf die Spuren ziehen
import { memo, useCallback, useRef, useState, type DragEvent as RDragEvent, type PointerEvent as RPointerEvent } from 'react'
import { TL, clipLen, tlDuration, xfades, type TLClip, type TLTrack, type TimelineContent } from '../../../shared/timeline'
import type { Overlay } from '../../../shared/video'
import { applyOps } from '../../../shared/timeline-edit'
import { dragOps, fadeDrag, modeAt, ovDrag, rows, trackAtRow, wave, type DragMode } from './drag'
import { MEDIA_MIME, srcFromDrop } from './media'
import { PAD_S } from './Ruler'

const DRAG_PX = 3 // erst ab dieser Bewegung ziehen, sonst ist es ein Klick
const nameOf = (src: string) => src.split(/[\\/]/).pop()?.replace(/[?#].*$/, '') || src

const ovName = (o: Overlay) => o.text || (o.image || o.video ? nameOf(o.image || o.video!) : o.art) || 'Einblendung'

export function Tracks({ tl, t, zoom, fps, snapping, selected, onSelect, onSeek, onDraft, onCommit, peaks, selectedOv, onSelectOv, onDropMedia }: {
  tl: TimelineContent; t: number; zoom: number; fps: number; snapping: boolean; selected: string | null
  onSelect: (id: string | null) => void; onSeek: (t: number) => void; onDraft: (tl: TimelineContent) => void; onCommit: (tl: TimelineContent) => void
  peaks: (src: string) => Uint8Array | undefined
  selectedOv: number | null; onSelectOv: (i: number | null) => void; onDropMedia: (srcs: string[], trackId: string | null, at: number) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [drop, setDrop] = useState<{ track: string | null; at: number } | null>(null)
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
    onSelectOv(null)
    const r = e.currentTarget.getBoundingClientRect()
    const fade = (e.target as HTMLElement).dataset.fade as 'in' | 'out' | undefined
    const mode: DragMode = modeAt(e.clientX - r.left, r.width)
    const base = tl
    if (fade) return follow(e, (dx) => applyOps(base, [fadeDrag(clip, fade, dx / zoom)], fps))
    // Zeilen-Lagen beim Start messen: der Clip wandert beim Spurwechsel in eine andere Zeile (neues Element), darum Fenster-Listener statt Capture
    const tops = [...(box.current?.querySelectorAll<HTMLElement>('.tl-row[data-track]') ?? [])].map((el) => el.getBoundingClientRect())
    follow(e, (dx, ev) => {
      let row = tops.findIndex((b) => ev.clientY >= b.top && ev.clientY < b.bottom)
      if (row < 0) row = ev.clientY < (tops[0]?.top ?? 0) ? 0 : tops.length - 1
      const dest = mode === 'move' ? trackAtRow(list, row, track.kind, track.id) : undefined
      return applyOps(base, dragOps(base, { clip, mode, dt: dx / zoom, track: dest !== track.id ? dest : undefined, ripple: mode !== 'move' && ev.altKey, snapping, zoom, t }), fps)
    })
  }

  const grabOv = (e: RPointerEvent<HTMLDivElement>, i: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    onSelect(null)
    onSelectOv(i)
    const r = e.currentTarget.getBoundingClientRect()
    const mode = modeAt(e.clientX - r.left, r.width), base = tl
    follow(e, (dx) => ovDrag(base, { i, mode, dt: dx / zoom, snapping, zoom, t, fps }))
  }

  /** Zieh-Vorgang ab DRAG_PX: step(dx, ev) liefert den Stand zum Versatz in px (Fehler = letzter gültiger Stand bleibt), Ende committet */
  const follow = (e: RPointerEvent, step: (dx: number, ev: PointerEvent) => TimelineContent) => {
    const base = tl, x0 = e.clientX, y0 = e.clientY
    let last = base, moved = false
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_PX) return
      moved = true
      try {
        last = step(ev.clientX - x0, ev)
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
  const grabRef = useRef({ grab, grabOv })
  grabRef.current = { grab, grabOv }
  const onDown = useCallback((e: RPointerEvent<HTMLDivElement>, c: TLClip) => grabRef.current.grab(e, c), [])
  const onDownOv = useCallback((e: RPointerEvent<HTMLDivElement>, i: number) => grabRef.current.grabOv(e, i), [])

  const empty = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    onSelect(null)
    onSelectOv(null)
    onSeek(Math.max(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / zoom))
  }

  // Medien-Drop: Zeit an der Maus (Lanes beginnen alle an derselben x-Lage), Spur unter der Maus, Titel-Spur oder leer = null
  const dropAt = (e: RDragEvent) => {
    const lane = box.current?.querySelector('.tl-lane')?.getBoundingClientRect()
    const row = (e.target as HTMLElement).closest<HTMLElement>('.tl-row[data-track]')
    return { track: row?.dataset.track ?? null, at: Math.max(0, (e.clientX - (lane?.left ?? 0)) / zoom) }
  }
  const dragOver = (e: RDragEvent) => {
    if (!e.dataTransfer.types.includes(MEDIA_MIME) && !e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const d = dropAt(e)
    if (d.track !== drop?.track || Math.abs(d.at - (drop?.at ?? -1)) * zoom >= 1) setDrop(d)
  }
  const dropIt = (e: RDragEvent) => {
    e.preventDefault() // sonst navigiert Chromium zu unbrauchbaren Dateien
    setDrop(null)
    const srcs = srcFromDrop(e.dataTransfer)
    if (!srcs.length) return
    const d = dropAt(e)
    onDropMedia(srcs, d.track, d.at)
  }
  const leave = (e: RDragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null) }
  const ovs = tl.overlays ?? []

  return (
    <div className="tl-tracks" ref={box} style={{ width: `calc(var(--tl-head) + ${w}px)` }} onDragOver={dragOver} onDragLeave={leave} onDrop={dropIt}>
      <div className="tl-row tl-titles">
        <div className="tl-track-head"><b>Titel</b></div>
        <div className="tl-lane" style={{ width: w }} onPointerDown={empty}>
          {ovs.map((o, i) => <Ov key={i} o={o} i={i} on={i === selectedOv} zoom={zoom} onDown={onDownOv} />)}
        </div>
      </div>
      {!!tl.subs?.length && (
        <div className="tl-row tl-subs">
          <div className="tl-track-head"><b>Untertitel</b></div>
          <div className="tl-lane" style={{ width: w }} onPointerDown={empty}>
            {tl.subs.map((s, i) => <span key={i} className="tl-subbar" style={{ left: s.start * zoom, width: Math.max(2, (s.end - s.start) * zoom) }} title={s.text}>{s.text}</span>)}
          </div>
        </div>
      )}
      {list.map(({ track, label }) => {
        const off = track.kind === 'video' ? track.hide : track.mute
        return (
          <div key={track.id} data-track={track.id} className={`tl-row ${track.kind}${off ? ' off' : ''}${drop?.track === track.id ? ' drop' : ''}`}>
            <div className="tl-track-head">
              <b>{label}</b>
              {track.kind === 'video'
                ? <button className="plain" aria-pressed={!!track.hide} title={track.hide ? 'Spur einblenden' : 'Spur ausblenden'} onClick={() => setTrack(track.id, { hide: !track.hide })}>{track.hide ? 'Aus' : 'Bild'}</button>
                : <button className="plain" aria-pressed={!!track.mute} title={track.mute ? 'Ton an' : 'Stumm'} onClick={() => setTrack(track.id, { mute: !track.mute })}>{track.mute ? 'Stumm' : 'Ton'}</button>}
            </div>
            <div className="tl-lane" style={{ width: w }} onPointerDown={empty}>
              {track.clips.map((c) => <Clip key={c.id} c={c} on={c.id === selected} zoom={zoom} p={peaks(c.src)} onDown={onDown} />)}
              {xfades(track).map((x) => (
                <div key={x.to.id} className={`tl-xf${x.to.id === selected ? ' on' : ''}`} style={{ left: x.a * zoom, width: Math.max(4, (x.b - x.a) * zoom) }}
                  title={`Überblendung ${(x.b - x.a).toFixed(2).replace('.', ',')} s`} />
              ))}
            </div>
          </div>
        )
      })}
      <div className="tl-add">
        <button className="plain" disabled={tl.tracks.length >= TL.tracks} onClick={() => add('video')}>+ Spur Video</button>
        <button className="plain" disabled={tl.tracks.length >= TL.tracks} onClick={() => add('audio')}>+ Spur Audio</button>
      </div>
      {drop && <div className="tl-drop" style={{ left: `calc(var(--tl-head) + ${drop.at * zoom}px)` }} />}
      <div className="tl-playhead" style={{ left: `calc(var(--tl-head) + ${t * zoom}px)` }} />
    </div>
  )
}

// Memoisiert: der Abspielkopf (t) ändert sich jedes Bild, Balken und Wellenform nur bei Clip, Zoom, Auswahl oder Peaks
const Clip = memo(function Clip({ c, on, zoom, p, onDown }: { c: TLClip; on: boolean; zoom: number; p?: Uint8Array; onDown: (e: RPointerEvent<HTMLDivElement>, c: TLClip) => void }) {
  const cw = Math.max(2, clipLen(c) * zoom)
  const v = p ? wave(p, c, Math.min(2000, cw / 2)) : []
  const [fi, fo] = (c.fade ?? [0, 0]).map((x) => Math.min(cw, x * zoom))
  return (
    <div className={`tl-clip${on ? ' on' : ''}${c.mute ? ' muted' : ''}`} style={{ left: c.at * zoom, width: cw }}
      title={`${nameOf(c.src)} · ${clipLen(c).toFixed(2).replace('.', ',')} s`} onPointerDown={(e) => onDown(e, c)}>
      {v.length > 0 && (
        <svg className="tl-wave" viewBox={`0 0 ${v.length} 1`} preserveAspectRatio="none" aria-hidden>
          <path d={`M0 1${v.map((y, i) => `V${(1 - y).toFixed(3)}H${i + 1}`).join('')}V1Z`} />
        </svg>
      )}
      {(fi > 0 || fo > 0) && (
        <svg className="tl-fade" viewBox={`0 0 ${cw} 1`} preserveAspectRatio="none" aria-hidden>
          <path d={`M0 0H${fi}L0 1Z M${cw} 0H${cw - fo}L${cw} 1Z`} />
        </svg>
      )}
      <span className="tl-clip-name">{nameOf(c.src)}</span>
      <i className="tl-edge l" aria-hidden />
      <i className="tl-edge r" aria-hidden />
      {/* Blenden-Griffe oben, an der Blendenlänge; die Trimmzone darunter bleibt */}
      <i className="tl-fade-grip" data-fade="in" style={{ left: fi }} title="Einblenden: nach innen ziehen" />
      <i className="tl-fade-grip" data-fade="out" style={{ left: cw - fo }} title="Ausblenden: nach innen ziehen" />
    </div>
  )
})

// Text-Einblendung auf der Titel-Spur; memoisiert wie Clip
const Ov = memo(function Ov({ o, i, on, zoom, onDown }: { o: Overlay; i: number; on: boolean; zoom: number; onDown: (e: RPointerEvent<HTMLDivElement>, i: number) => void }) {
  return (
    <div className={`tl-clip tl-ovbar${on ? ' on' : ''}`} style={{ left: o.start * zoom, width: Math.max(2, (o.end - o.start) * zoom) }}
      title={`${ovName(o)} · ${(o.end - o.start).toFixed(2).replace('.', ',')} s`} onPointerDown={(e) => onDown(e, i)}>
      <span className="tl-clip-name">{ovName(o)}</span>
      <i className="tl-edge l" aria-hidden />
      <i className="tl-edge r" aria-hidden />
    </div>
  )
})
