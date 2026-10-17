// Schnittplatz der Pro-Timeline: Vorschau mit Seitenpanel (Schnitt · Farbe · Ton · Ausgabe) oben, Werkzeugleiste, Lineal und Spuren unten.
// Änderungen laufen über applyOps
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { TL, activeAt, clipEnd, deliverOf, newId, snapFrame, tlDuration, type TLTrack, type TimelineContent } from '../../../shared/timeline'
import { applyOps, lintTimeline, type TLOp } from '../../../shared/timeline-edit'
import { useTimelinePlayer } from './useTimelinePlayer'
import { Viewer } from './Viewer'
import { Ruler } from './Ruler'
import { Tracks } from './Tracks'
import { Inspector as InspectorRaw, TitleInspector as TitleInspectorRaw, prevOf } from './Inspector'
import { Deliver as DeliverRaw, type ExportRun } from './Deliver'
import { ColorPage as ColorPageRaw } from './ColorPage'
import { Mixer as MixerRaw } from './Mixer'
import { MediaPool as MediaPoolRaw } from './MediaPool'
import { probeMedia } from './media'
import './timeline.css'
import './timeline-panels.css'

const Inspector = memo(InspectorRaw), TitleInspector = memo(TitleInspectorRaw), Deliver = memo(DeliverRaw)
const ColorPage = memo(ColorPageRaw), Mixer = memo(MixerRaw), MediaPool = memo(MediaPoolRaw)

const PAGES = [['schnitt', 'Schnitt'], ['farbe', 'Farbe'], ['ton', 'Ton'], ['ausgabe', 'Ausgabe']] as const
type Page = (typeof PAGES)[number][0]
const KEYS: [string, string][] = [
  ['Leertaste / K', 'Abspielen, Anhalten'], ['J / L', '1 s zurück / vor'], ['← / →', '1 Bild zurück / vor'], ['B', 'Teilen am Abspielkopf'],
  ['Entf', 'Löschen (Lücke bleibt)'], ['⇧ Entf', 'Löschen und Lücke schließen'], ['T', 'Überblendung setzen oder entfernen'], ['N', 'Einrasten an/aus'],
  ['+ / −', 'Zoom'], ['1 – 4', 'Seite Schnitt, Farbe, Ton, Ausgabe'], ['?', 'Diese Liste'], ['Esc', 'Liste schließen'],
]
const XFADE_DEF = 1 // s, Überblendung per T oder Knopf
const TITLE_LEN = 3 // s, neuer Titel
type LoudApi = { timelineLoudness?: (tl: TimelineContent) => Promise<{ i: number; tp: number; lra: number } | null> }
const loudApi = () => (window as unknown as { api?: LoudApi }).api

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
  const [page, setPage] = useState<Page>('schnitt')
  const [selectedOv, setSelectedOv] = useState<number | null>(null)
  const [bypass, setBypass] = useState(false)
  const [help, setHelp] = useState(false)
  // Export hier statt in Deliver: überlebt den Seitenwechsel, ein zweiter Start wird abgewiesen
  const [exp, setExp] = useState<ExportRun>({ pct: null, files: [], err: null })
  const exporting = useRef(false)
  // Stand inkl. noch nicht gerenderter Commits: asynchrone Aufrufer (addMedia) bauen darauf auf
  const draftRef = useRef(draft)
  draftRef.current = draft

  const commit = (next: TimelineContent) => { draftRef.current = next; setDraft(next); onCommit(next) }
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
  // Clip und Titel schließen sich in der Auswahl aus
  const selectClip = (id: string | null) => { setSelected(id); if (id) setSelectedOv(null) }
  const selectOv = (i: number | null) => { setSelectedOv(i); if (i !== null) setSelected(null) }

  // Medien aus Pool oder Drop ab at nacheinander: gewünschte Spur, sonst erste freie Spur der Art, sonst neue Spur; ein Undo-Schritt
  const addMedia = async (srcs: string[], at: number, trackId: string | null) => {
    try {
      const probed = await Promise.all(srcs.map(probeMedia))
      if (base.current) throw new Error('Erst das Ziehen beenden, dann Medien hinzufügen')
      let cur = draftRef.current, t = snapFrame(at, fps) // nach await: aktueller Stand, nicht der beim Aufruf
      srcs.forEach((src, i) => {
        const duration = Math.max(TL.minLen, snapFrame(probed[i].duration, fps)), video = probed[i].video // aufs Bildraster wie addClip, sonst Überlappung am Raster
        const kind: TLTrack['kind'] = video ? 'video' : 'audio'
        const free = (tr: TLTrack) => tr.kind === kind && !tr.clips.some((c) => t < clipEnd(c) - 1e-6 && c.at < t + duration - 1e-6)
        const want = cur.tracks.find((tr) => tr.id === trackId)
        const dest = want && free(want) ? want : cur.tracks.find(free)
        const ops: TLOp[] = dest ? [] : [{ op: 'add_track', kind }]
        const id = dest?.id ?? newId(cur, kind === 'video' ? 'v' : 'a') // wie addTrack
        cur = applyOps(cur, [...ops, { op: 'add_clip', track: id, clip: { src, at: t, in: 0, out: duration } }], fps)
        t = snapFrame(t + duration, fps)
      })
      latest.current.commit(cur)
      setMsg(null)
    } catch (e) { setMsg((e as Error).message) }
  }
  const onBox = (clipId: string, box: [number, number, number], final: boolean) => {
    if (final && !base.current) return // Klick ohne Ziehen: nichts zu speichern
    const cur = latest.current.draft
    try {
      const next = applyOps(cur, [{ op: 'set', clip: clipId, patch: { box } }], fps)
      if (final) latest.current.panelCommit(next); else latest.current.onDraft(next)
    } catch { if (final) latest.current.panelCommit(cur) } // ungültig: letzten gültigen Stand speichern
  }

  // Exportiert das gespeicherte Deck (Commits gehen sofort an die App) als MP4
  const exportMp4 = async () => {
    if (exporting.current) return
    exporting.current = true
    setExp({ pct: 0, files: [], err: null })
    const off = window.api.onExportProgress((pct) => setExp((x) => ({ ...x, pct })))
    try { const files = await window.api.exportDeck('mp4'); setExp({ pct: null, files, err: null }) }
    catch (e) { setExp({ pct: null, files: [], err: (e as Error).message }) }
    finally { off(); exporting.current = false }
  }
  // Panels hängen nicht an t: memo mit stabilen Rückrufen, damit das Abspielen sie nicht 60×/s neu rendert
  const latest = useRef({ commit, onDraft, panelCommit, draft, t: player.t, addMedia, onBox, exportMp4 })
  latest.current = { commit, onDraft, panelCommit, draft, t: player.t, addMedia, onBox, exportMp4 }
  const stable = useMemo(() => ({
    commit: (next: TimelineContent) => latest.current.commit(next),
    inspector: (next: TimelineContent, final: boolean) => (final ? latest.current.panelCommit(next) : latest.current.onDraft(next)),
    selectOv: (i: number | null) => { setSelectedOv(i); if (i !== null) setSelected(null) },
    poolAdd: (src: string) => void latest.current.addMedia([src], latest.current.t, null),
    drop: (srcs: string[], trackId: string | null, at: number) => void latest.current.addMedia(srcs, at, trackId),
    box: (clipId: string, box: [number, number, number], final: boolean) => latest.current.onBox(clipId, box, final),
    exportMp4: () => void latest.current.exportMp4(),
    measure: () => loudApi()!.timelineLoudness!(latest.current.draft),
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

  // T: am gewählten Clip, sonst am Schnitt unter dem Abspielkopf (oberste Videospur zuerst); braucht einen direkt anschließenden Vorgänger
  const xfadeTarget = () => {
    for (const tr of [...draft.tracks].reverse()) {
      const c = selected ? tr.clips.find((x) => x.id === selected) : tr.clips.find((x) => Math.abs(x.at - player.t) <= Math.max(1 / fps, 8 / zoom))
      if (c && prevOf(tr, c)) return c
      if (c && selected) return null
    }
    return null
  }
  const xfadeClip = xfadeTarget()
  const toggleXfade = () => { if (xfadeClip) edit([{ op: 'set', clip: xfadeClip.id, patch: { xfade: xfadeClip.xfade ? undefined : XFADE_DEF } }]) }
  const splitClip = clipAtHead()
  const addTitle = () => {
    const ovs = draft.overlays ?? []
    if (ovs.length >= 60) return setMsg('Höchstens 60 Titel') // Schema-Grenze
    const start = Math.round(player.t * fps) / fps
    commit({ ...draft, overlays: [...ovs, { start, end: start + TITLE_LEN, text: 'Titel' }] })
    selectOv(ovs.length)
  }
  const removeOv = () => {
    if (selectedOv === null) return
    commit({ ...draft, overlays: (draft.overlays ?? []).filter((_, i) => i !== selectedOv) })
    setSelectedOv(null)
  }
  const del = (ripple: boolean) => {
    if (selected) { if (edit([{ op: ripple ? 'ripple_delete' : 'lift', clip: selected }])) setSelected(null) }
    else if (!ripple) removeOv()
  }

  const keys = useRef<(e: KeyboardEvent) => void>(() => {})
  keys.current = (e) => {
    if (help && e.key === 'Escape') { e.preventDefault(); setHelp(false); return }
    if (!keysFree(e)) return
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const go = (f: () => void) => { e.preventDefault(); f() }
    if (k === ' ' || k === 'k') go(player.toggle)
    else if (k === 'j' || k === 'l') go(() => player.seek(player.t + (k === 'j' ? -1 : 1)))
    else if (k === 'ArrowLeft' || k === 'ArrowRight') go(() => player.step(k === 'ArrowLeft' ? -1 : 1))
    else if (k >= '1' && k <= '4') go(() => setPage(PAGES[+k - 1][0]))
    else if (k === '?') go(() => setHelp((h) => !h))
    else if (base.current && (k === 'b' || k === 't' || k === 'Delete' || k === 'Backspace')) return // während des Ziehens kein Schnitt
    else if (k === 'b') go(() => { if (splitClip) edit([{ op: 'split', clip: splitClip, t: player.t }]) })
    else if (k === 't') go(toggleXfade)
    else if ((k === 'Delete' || k === 'Backspace') && (selected || selectedOv !== null)) go(() => del(e.shiftKey))
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
  const ovCount = draft.overlays?.length ?? 0
  useEffect(() => { if (selectedOv !== null && selectedOv >= ovCount) setSelectedOv(null) }, [selectedOv, ovCount])
  const lintList = useMemo(() => {
    const issues = lintTimeline(draft, fps)
    return issues.length > 0 && (
      <ul className="tl-lint">
        {issues.map((x, i) => (
          <li key={i} className={x.level === 'error' ? 'tl-err' : undefined} onClick={x.clip ? () => selectClip(x.clip!) : undefined}>{x.msg}</li>
        ))}
      </ul>
    )
  }, [draft, fps])
  const duration = tlDuration(draft)

  const firstVideo = draft.tracks.findIndex((tr) => tr.kind === 'video')

  return (
    <div className="tl-editor">
      <div className="tl-main">
        <Viewer tl={draft} player={player} aspect={aspect} selected={selected} onBox={stable.box} bypass={page === 'farbe' && bypass} />
      </div>
      <aside className="tl-side">
        <div className="tl-pages" role="tablist" aria-label="Seite">
          {PAGES.map(([id, name], i) => (
            <button key={id} className="plain" role="tab" id={`tl-tab-${id}`} aria-selected={page === id} aria-controls="tl-page" title={`${name} (${i + 1})`} onClick={() => setPage(id)}>{name}</button>
          ))}
        </div>
        <div className="tl-page" id="tl-page" role="tabpanel" aria-labelledby={`tl-tab-${page}`}>
          {page === 'schnitt' && <>
            {selectedOv !== null && selectedOv < ovCount
              ? <TitleInspector tl={draft} index={selectedOv} onChange={stable.inspector} onSelect={stable.selectOv} />
              : <Inspector tl={draft} clipId={selected} part="clip" onChange={stable.inspector} />}
            <MediaPool tl={draft} onAdd={stable.poolAdd} />
          </>}
          {page === 'farbe' && <ColorPage tl={draft} clipId={selected} video={player.videoFor(selTrack >= 0 ? selTrack : firstVideo)} onChange={stable.inspector} bypass={bypass} onBypass={setBypass} />}
          {page === 'ton' && <>
            <Mixer tl={draft} master={player.master} onChange={stable.inspector} />
            <Inspector tl={draft} clipId={selected} part="ton" onChange={stable.inspector} />
          </>}
          {page === 'ausgabe' && <>
            <Deliver tl={draft} onChange={stable.commit} onMeasure={loudApi()?.timelineLoudness ? stable.measure : undefined} exp={exp} onExport={stable.exportMp4} />
            {lintList}
          </>}
        </div>
      </aside>
      <div className="tl-lanes">
        <div className="tl-bar" role="toolbar" aria-label="Werkzeuge">
          <button className="plain" title="Am Abspielkopf teilen (B)" disabled={!splitClip} onClick={() => splitClip && edit([{ op: 'split', clip: splitClip, t: player.t }])}>Teilen</button>
          <button className="plain" title="Löschen, Lücke bleibt (Entf)" disabled={!selected && selectedOv === null} onClick={() => del(false)}>Löschen</button>
          <button className="plain" title="Löschen und Lücke schließen (⇧Entf)" disabled={!selected} onClick={() => del(true)}>Lücke schließen</button>
          <button className="plain" title="Überblendung am Schnitt setzen oder entfernen (T)" disabled={!xfadeClip} aria-pressed={!!xfadeClip?.xfade} onClick={toggleXfade}>Überblendung</button>
          <button className="plain" title="Titel am Abspielkopf einfügen" onClick={addTitle}>+ Titel</button>
          <span className="tl-bar-sep" />
          <button className="plain" aria-pressed={snapping} title="Einrasten (N)" onClick={() => setSnapping((s) => !s)}>Einrasten</button>
          <button className="plain" aria-label="Verkleinern (−)" title="Verkleinern (−)" onClick={() => zoomBy(1 / ZOOM.step)}>−</button>
          <button className="plain" aria-label="Vergrößern (+)" title="Vergrößern (+)" onClick={() => zoomBy(ZOOM.step)}>+</button>
          <button className="plain" aria-label="Tastenkürzel" title="Tastenkürzel (?)" aria-expanded={help} onClick={() => setHelp((h) => !h)}>?</button>
          {msg && <span className="tl-msg" role="status">{msg}</span>}
          {help && (
            <div className="tl-help" role="dialog" aria-modal="true" aria-label="Tastenkürzel">
              <dl>{KEYS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
            </div>
          )}
        </div>
        <div className="tl-scroll">
          <Ruler duration={duration} zoom={zoom} t={player.t} fps={fps} markers={draft.markers} onSeek={player.seek} />
          <Tracks tl={draft} t={player.t} zoom={zoom} fps={fps} snapping={snapping} selected={selected} onSelect={selectClip}
            onSeek={player.seek} onDraft={onDraft} onCommit={panelCommit} peaks={peaks} selectedOv={selectedOv} onSelectOv={selectOv} onDropMedia={stable.drop} />
        </div>
      </div>
    </div>
  )
}
