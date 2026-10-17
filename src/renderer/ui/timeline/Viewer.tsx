// Vorschau der Pro-Timeline: Videospuren übereinander (Elemente aus dem Player, Deckkraft der Blenden), Farbe per SVG-Filter, Bild-in-Bild ziehen, ruhige Text-Ebene, Transport
import { useLayoutEffect, useRef, type PointerEvent as PE } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { deliverOf, type Grade, type TLClip, type TimelineContent } from '../../../shared/timeline'
import { isNeutral, satMatrix, svgTables } from '../../../shared/grade'
import { ovPos } from '../../../shared/video'
import { isStill, mixAt, type TimelinePlayer } from './useTimelinePlayer'
import { clipUrl } from '../clipPlayer'
import './viewer.css'

/** Zeitcode hh:mm:ss:ff (non-drop, Bilder zur gerundeten Rate) */
export function timecode(t: number, fps: number): string {
  const n = Math.max(1, Math.round(fps)), total = Math.round(Math.max(0, t) * fps), s = Math.floor(total / n)
  const p = (v: number) => String(v).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(total % n)}`
}

const filterId = (clipId: string) => `tl-g-${clipId.replace(/[^\w-]/g, '_')}`
// Tabellen kosten 768 Zahlen je Clip: nicht in jedem Bild neu rechnen, solange das Grade-Objekt gleich bleibt
const tables = new WeakMap<Grade, { t: ReturnType<typeof svgTables>; m: string }>()
function gradeDef(g: Grade) {
  let hit = tables.get(g)
  if (!hit) {
    const s = satMatrix(g.sat)
    const m = [0, 1, 2].map((r) => `${s[r * 3]} ${s[r * 3 + 1]} ${s[r * 3 + 2]} 0 0`).join(' ') + ' 0 0 0 1 0' // 3×3 → 4×5
    hit = { t: svgTables(g), m }
    tables.set(g, hit)
  }
  return hit
}

type Box = NonNullable<TLClip['box']>
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const boxStyle = (b: Box) => ({ left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${b[2] * 100}%`, height: `${b[2] * 100}%` })

// onBox: Bild-in-Bild im Bild ziehen (live final=false, beim Loslassen true); bypass: Vorher/Nachher, alle Ebenen ohne Farbfilter
export function Viewer({ tl, player, aspect, selected, onBox, bypass }: {
  tl: TimelineContent; player: TimelinePlayer; aspect: number; selected: string | null
  onBox?: (clipId: string, box: Box, final: boolean) => void; bypass?: boolean
}) {
  const { t, playing } = player
  const fps = deliverOf(tl).fps
  const slots = useRef(new Map<string, HTMLDivElement>())
  const drag = useRef<{ id: string; b: Box; x: number; y: number; w: number; h: number; size: boolean; last: Box | null } | null>(null)
  const items = mixAt(tl, t, 'video') // je Spur der Clip, im Überblend-Fenster from und darüber to
  const graded = bypass ? [] : items.map((x) => x.clip).filter((c) => c.grade && !isNeutral(c.grade))
  const filterOf = (c: TLClip) => (!bypass && c.grade && !isNeutral(c.grade) ? `url(#${filterId(c.id)})` : '')

  // Elemente des Players gehören nicht React: nach jedem Render ins Fach ihres Clips hängen und ausrichten
  useLayoutEffect(() => {
    for (const x of items) {
      const c = x.clip, slot = slots.current.get(c.id), el = player.elFor(x.track, c.id)
      if (!slot || !el || isStill(c.src)) continue
      if (slot.firstChild !== el) slot.replaceChildren(el)
      el.style.visibility = ''
      el.style.objectFit = c.fit === 'contain' ? 'contain' : 'cover'
      el.style.objectPosition = `${(c.focus ?? 0.5) * 100}% 50%`
      el.style.filter = filterOf(c)
    }
  })

  const bottom = tl.tracks.findIndex((tr) => tr.kind === 'video')
  const pip = onBox ? items.find((x) => x.clip.id === selected && x.track !== bottom) : undefined
  const pipBox: Box = pip?.clip.box ?? [0, 0, 1]
  const onDown = (e: PE<HTMLDivElement>) => {
    e.stopPropagation()
    if (!pip || e.button !== 0) return
    if (playing) player.pause() // sonst kann der Clip unter dem Zeiger verschwinden und das Final fehlt
    const r = e.currentTarget.parentElement!.getBoundingClientRect()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { id: pip.clip.id, b: pipBox, x: e.clientX, y: e.clientY, w: r.width, h: r.height, size: !!(e.target as HTMLElement).dataset.size, last: null }
  }
  const onMove = (e: PE) => {
    const d = drag.current
    if (!d || (!d.last && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3)) return // kleiner Ruck ist noch kein Ziehen
    const dx = (e.clientX - d.x) / d.w, dy = (e.clientY - d.y) / d.h, [bx, by, bw] = d.b
    // wie im Export: Größe = w × Breite und w × Höhe, also ganz im Bild
    d.last = d.size ? [bx, by, clamp(bw + dx, 0.05, 1 - Math.max(bx, by))] : [clamp(bx + dx, 0, 1 - bw), clamp(by + dy, 0, 1 - bw), bw]
    onBox?.(d.id, d.last, false)
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (d?.last) onBox?.(d.id, d.last, true)
  }

  const ovs = (tl.overlays ?? []).filter((o) => t >= o.start && t < o.end && (o.text || o.sub || o.items?.length))
  const sub = tl.subs?.find((s) => t >= s.start && t < s.end)
  return (
    <div className="tl-viewer">
      <div className="tl-screen" style={{ aspectRatio: aspect }} onClick={player.toggle}>
        {items.map((x) => {
          const c = x.clip, b = c.box
          const fit = { objectFit: c.fit === 'contain' ? 'contain' : 'cover', objectPosition: `${(c.focus ?? 0.5) * 100}% 50%`, filter: filterOf(c) || undefined } as const
          return (
            <div key={c.id} className={`tl-layer${b ? ' tl-box' : ''}${c.id === selected ? ' tl-on' : ''}`}
              style={{ opacity: x.alpha < 1 ? x.alpha : undefined, ...(b && boxStyle(b)) }}>
              <div ref={(el) => { if (el) slots.current.set(c.id, el); else slots.current.delete(c.id) }} className="tl-slot" />
              {isStill(c.src) && <img src={clipUrl(c.src)} alt="" style={fit} />}
            </div>
          )
        })}
        {ovs.map((o, i) => (
          <div key={i} className={`tl-ov tl-ov-${ovPos(o)}`}>
            {o.text && <b>{o.text}</b>}
            {o.sub && <span>{o.sub}</span>}
            {o.items?.map((x, k) => <span key={k}>{x}</span>)}
          </div>
        ))}
        {sub && <p className="tl-sub">{sub.text}</p>}
        {pip && (
          <div className="tl-pip" style={boxStyle(pipBox)} onClick={(e) => e.stopPropagation()}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            <i data-size="1" title="Größe ziehen" />
          </div>
        )}
        <svg width={0} height={0} className="tl-defs" aria-hidden>
          {graded.map((c) => {
            const d = gradeDef(c.grade!)
            return (
              <filter key={c.id} id={filterId(c.id)} colorInterpolationFilters="sRGB">
                <feComponentTransfer>
                  <feFuncR type="table" tableValues={d.t.r} />
                  <feFuncG type="table" tableValues={d.t.g} />
                  <feFuncB type="table" tableValues={d.t.b} />
                </feComponentTransfer>
                <feColorMatrix type="matrix" values={d.m} />
              </filter>
            )
          })}
        </svg>
      </div>
      <div className="tl-transport">
        <button className="plain" aria-label="Bild zurück (←)" title="Bild zurück (←)" onClick={() => player.step(-1)}><ChevronLeft size={16} /></button>
        <button className="round" aria-label={playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)'} onClick={player.toggle}>
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
        </button>
        <button className="plain" aria-label="Bild vor (→)" title="Bild vor (→)" onClick={() => player.step(1)}><ChevronRight size={16} /></button>
        <span className="tl-tc">{timecode(t, fps)}</span>
      </div>
    </div>
  )
}
