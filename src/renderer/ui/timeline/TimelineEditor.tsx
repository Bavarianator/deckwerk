// Schnittplatz der Pro-Timeline: Vorschau mit Inspector und Scopes oben, Lineal und Spuren unten. Änderungen laufen über applyOps
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { activeAt, deliverOf, tlDuration, type TimelineContent } from '../../../shared/timeline'
import { applyOps, lintTimeline, type TLOp } from '../../../shared/timeline-edit'
import { useTimelinePlayer } from './useTimelinePlayer'
import { Viewer } from './Viewer'
import { Scopes as ScopesRaw } from './Scopes'
import { Ruler } from './Ruler'
import { Tracks } from './Tracks'
import { Inspector as InspectorRaw } from './Inspector'
import { Deliver as DeliverRaw } from './Deliver'
import './timeline.css'
import './timeline-panels.css'

const Scopes = memo(ScopesRaw), Inspector = memo(InspectorRaw), Deliver = memo(DeliverRaw)

const ZOOM = { def: 60, step: 1.25, min: 4, max: 1200 } // px je Sekunde

// Tasten nicht beim Tippen, nicht mit Modifikator (außer Shift) und nicht, solange ein Dialog oder Menü offen ist (wie Deckvid)
const keysFree = (e: KeyboardEvent) => {
  const t = e.target instanceof HTMLElement ? e.target : document.body // Ziel kann auch document/window sein
  const typing = t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)
  return !(e.ctrlKey || e.metaKey || e.altKey || typing || t.closest('[role=menu], [role=listbox]')
    || document.querySelector('[aria-modal="true"], dialog[open], .kit-menu, [role=menu]'))
}

type PeaksApi = { timelinePeaks?: (src: string) => Promise<Uint8Array | undefined> }

export function TimelineEditor({ content, onCommit, aspect, fps: fpsProp }: { content: TimelineContent; onCommit: (c: TimelineContent) => void; aspect: number; fps?: number }) {
  const [draft, setDraft] = useState(content)
  const [msg, setMsg] = useState<string | null>(null)
  // Offener Entwurf (Ziehen in Tracks/Inspector): base = content bei Beginn. Kommt währenddessen eine Änderung von außen (KI), gewinnt sie,
  // und das folgende Commit des veralteten Entwurfs wird verworfen
  const base = useRef<TimelineContent | null>(null)
  const contentRef = useRef(content)
  contentRef.current = content
  useEffect(() => {
    if (base.current) setMsg('Änderung von außen übernommen')
    setDraft(content)
  }, [content])
  const fps = fpsProp ?? deliverOf(draft).fps
  const player = useTimelinePlayer(draft, fps)
  const [selected, setSelected] = useState<string | null>(null)
  const [zoom, setZoom] = useState(ZOOM.def)
  const [snapping, setSnapping] = useState(true)
  const [scope, setScope] = useState<'waveform' | 'histogram'>('waveform')

  const commit = (next: TimelineContent) => { setDraft(next); onCommit(next) }
  const stale = () => !!base.current && base.current !== contentRef.current
  const onDraft = (next: TimelineContent) => { base.current ??= contentRef.current; if (!stale()) setDraft(next) }
  const panelCommit = (next: TimelineContent) => {
    const old = stale()
    base.current = null
    if (old) setDraft(contentRef.current) // Entwurf auf veraltetem Stand: verwerfen
    else commit(next)
  }
  const edit = (ops: TLOp[]) => {
    try { commit(applyOps(draft, ops, fps)); setMsg(null); return true } catch (e) { setMsg((e as Error).message); return false }
  }
  // Inspector/Deliver/Scopes/Lint hängen nicht an t: memo mit stabilen Rückrufen, damit das Abspielen sie nicht 60×/s neu rendert
  const latest = useRef({ commit, onDraft, panelCommit })
  latest.current = { commit, onDraft, panelCommit }
  const stable = useMemo(() => ({
    commit: (next: TimelineContent) => latest.current.commit(next),
    inspector: (next: TimelineContent, final: boolean) => (final ? latest.current.panelCommit(next) : latest.current.onDraft(next)),
  }), [])
  useEffect(() => {
    if (!msg) return
    const id = setTimeout(() => setMsg(null), 4000)
    return () => clearTimeout(id)
  }, [msg])

  // Pegelbilder: IPC timeline:peaks kommt in einer späteren Welle; bis dahin ohne (Tracks zeichnet dann keine Wellenform)
  const peakCache = useRef(new Map<string, Uint8Array | number>()) // Zahl = frühester neuer Versuch (ms), nach Fehler oder ohne Ergebnis
  const [, setPeaksGen] = useState(0)
  const peaks = (src: string) => {
    const c = peakCache.current, hit = c.get(src)
    if (hit instanceof Uint8Array) return hit
    if (hit !== undefined && performance.now() < hit) return undefined
    const api = (window as unknown as { api?: PeaksApi }).api
    if (!api?.timelinePeaks) return undefined
    const retry = () => c.set(src, performance.now() + 5000)
    retry() // läuft: nicht doppelt anfragen
    api.timelinePeaks(src).then((p) => { if (p) { c.set(src, p); setPeaksGen((g) => g + 1) } else retry() }, retry)
    return undefined
  }

  const zoomBy = (k: number) => setZoom((z) => Math.min(ZOOM.max, Math.max(ZOOM.min, z * k)))
  const clipAtHead = () => {
    const act = activeAt(draft, player.t)
    const sel = selected && act.find((a) => a.clip.id === selected)
    if (sel) return sel.clip.id
    const vids = act.filter((a) => a.track.kind === 'video')
    return (vids[vids.length - 1] ?? act[act.length - 1])?.clip.id ?? null
  }

  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  keys.current = (e) => {
    if (!keysFree(e)) return
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const go = (f: () => void) => { e.preventDefault(); f() }
    if (k === ' ' || k === 'k') go(player.toggle)
    else if (k === 'j' || k === 'l') go(() => player.seek(player.t + (k === 'j' ? -1 : 1)))
    else if (k === 'ArrowLeft' || k === 'ArrowRight') go(() => player.step(k === 'ArrowLeft' ? -1 : 1))
    else if (base.current && (k === 'b' || k === 'Delete' || k === 'Backspace')) return // während des Ziehens kein Schnitt
    else if (k === 'b') go(() => { const id = clipAtHead(); if (id) edit([{ op: 'split', clip: id, t: player.t }]) })
    else if ((k === 'Delete' || k === 'Backspace') && selected) go(() => { if (edit([{ op: e.shiftKey ? 'ripple_delete' : 'lift', clip: selected }])) setSelected(null) })
    else if (k === 'n') go(() => setSnapping((s) => !s))
    else if (k === '+' || k === '=') go(() => zoomBy(ZOOM.step))
    else if (k === '-') go(() => zoomBy(1 / ZOOM.step))
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  const selTrack = selected ? draft.tracks.findIndex((tr) => tr.clips.some((c) => c.id === selected)) : -1
  const selClip = selTrack >= 0 ? draft.tracks[selTrack].clips.find((c) => c.id === selected) : undefined
  // Auswahl verschwindet (Lift, Undo): nicht auf einen toten Clip zeigen
  useEffect(() => { if (selected && selTrack < 0) setSelected(null) }, [selected, selTrack])
  const lintList = useMemo(() => {
    const issues = lintTimeline(draft, fps)
    return issues.length > 0 && (
      <ul className="tl-lint">
        {issues.map((x, i) => (
          <li key={i} className={x.level === 'error' ? 'tl-err' : undefined} onClick={x.clip ? () => setSelected(x.clip!) : undefined}>{x.msg}</li>
        ))}
      </ul>
    )
  }, [draft, fps])
  const duration = tlDuration(draft)

  return (
    <div className="tl-editor">
      <div className="tl-main">
        <Viewer tl={draft} player={player} aspect={aspect} selected={selected} />
      </div>
      <aside className="tl-side">
        <Inspector tl={draft} clipId={selected} onChange={stable.inspector} />
        <section className="tl-scopes">
          <div className="tl-seg" role="group" aria-label="Scope">
            <button className="plain" aria-pressed={scope === 'waveform'} onClick={() => setScope('waveform')}>Waveform</button>
            <button className="plain" aria-pressed={scope === 'histogram'} onClick={() => setScope('histogram')}>Histogramm</button>
          </div>
          <Scopes video={selTrack >= 0 ? player.videoFor(selTrack) : player.videoFor(draft.tracks.findIndex((tr) => tr.kind === 'video'))} grade={selClip?.grade} sat={selClip?.grade?.sat} mode={scope} />
        </section>
        <Deliver tl={draft} onChange={stable.commit} />
        {lintList}
      </aside>
      <div className="tl-lanes">
        <div className="tl-bar">
          <button className="plain" aria-pressed={snapping} title="Einrasten (N)" onClick={() => setSnapping((s) => !s)}>Einrasten</button>
          <button className="plain" aria-label="Verkleinern (−)" title="Verkleinern (−)" onClick={() => zoomBy(1 / ZOOM.step)}>−</button>
          <button className="plain" aria-label="Vergrößern (+)" title="Vergrößern (+)" onClick={() => zoomBy(ZOOM.step)}>+</button>
          {msg && <span className="tl-msg" role="status">{msg}</span>}
        </div>
        <div className="tl-scroll">
          <Ruler duration={duration} zoom={zoom} t={player.t} fps={fps} markers={draft.markers} onSeek={player.seek} />
          <Tracks tl={draft} t={player.t} zoom={zoom} fps={fps} snapping={snapping} selected={selected} onSelect={setSelected}
            onSeek={player.seek} onDraft={onDraft} onCommit={panelCommit} peaks={peaks} />
        </div>
      </div>
    </div>
  )
}
