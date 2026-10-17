// Vorschau der Pro-Timeline: Videospuren übereinander (Elemente aus dem Player), Farbe per SVG-Filter, ruhige Text-Ebene, Transport
import { useLayoutEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react'
import { activeAt, deliverOf, type Grade, type TimelineContent } from '../../../shared/timeline'
import { isNeutral, satMatrix, svgTables } from '../../../shared/grade'
import { ovPos } from '../../../shared/video'
import { isStill, type TimelinePlayer } from './useTimelinePlayer'
import { clipUrl } from '../clipPlayer'

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

export function Viewer({ tl, player, aspect, selected }: { tl: TimelineContent; player: TimelinePlayer; aspect: number; selected: string | null }) {
  const { t, playing } = player
  const fps = deliverOf(tl).fps
  const layers = useRef<(HTMLDivElement | null)[]>([])
  const active = new Map(activeAt(tl, t, 'video').map((a) => [a.index, a.clip]))
  const graded = [...active.values()].filter((c) => c.grade && !isNeutral(c.grade))

  // Elemente des Players gehören nicht React: nach jedem Render ins passende Fach hängen und je Clip ausrichten
  useLayoutEffect(() => {
    tl.tracks.forEach((track, i) => {
      const box = layers.current[i], el = player.videoFor(i)
      if (!box || !el) return
      if (box.firstChild !== el) box.replaceChildren(el)
      const c = active.get(i)
      el.style.visibility = c && !isStill(c.src) ? '' : 'hidden'
      if (!c) return
      el.style.objectFit = c.fit === 'contain' ? 'contain' : 'cover'
      el.style.objectPosition = `${(c.focus ?? 0.5) * 100}% 50%`
      el.style.filter = c.grade && !isNeutral(c.grade) ? `url(#${filterId(c.id)})` : ''
    })
  })

  const ovs = (tl.overlays ?? []).filter((o) => t >= o.start && t < o.end && (o.text || o.sub || o.items?.length))
  const sub = tl.subs?.find((s) => t >= s.start && t < s.end)
  return (
    <div className="tl-viewer">
      <div className="tl-screen" style={{ aspectRatio: aspect }} onClick={player.toggle}>
        {tl.tracks.map((track, i) => {
          if (track.kind !== 'video') return null
          const c = active.get(i), b = c?.box
          const fit = { objectFit: c?.fit === 'contain' ? 'contain' : 'cover', objectPosition: `${(c?.focus ?? 0.5) * 100}% 50%`, filter: c?.grade && !isNeutral(c.grade) ? `url(#${filterId(c.id)})` : undefined } as const
          return (
            <div key={track.id} className={`tl-layer${b ? ' tl-box' : ''}${c && c.id === selected ? ' tl-on' : ''}`}
              style={{ visibility: c ? 'visible' : 'hidden', ...(b && { left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${b[2] * 100}%`, height: `${b[2] * 100}%` }) }}>
              <div ref={(el) => { layers.current[i] = el }} className="tl-slot" />
              {c && isStill(c.src) && <img src={clipUrl(c.src)} alt="" style={fit} />}
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
