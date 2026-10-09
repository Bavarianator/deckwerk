// Schneiden: Feinschliff an den Ausschnitten einer Clip-Folie, nachdem die KI sie gesetzt hat.
// Bewusst schlicht: Anfang/Ende ziehen oder an der Abspielposition setzen, teilen, löschen, Bildausschnitt. Hook und Untertitel gibt es nur im MP4.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pause, Play, Plus, Scissors, Trash2 } from 'lucide-react'
import type { Size } from '../../shared/deck'
import { MAX_PARTS, partsLength, type ClipContent, type Part } from '../../shared/video'
import { ClipVideo, Strip, useClipPlayer } from './clipPlayer'
import { confirmDialog } from './kit'

const MIN = 0.3 // kürzester Ausschnitt; das Schema verlangt end > start + 0.2
const MAX = MAX_PARTS // Schema: höchstens so viele Ausschnitte je Clip-Folie
const r2 = (s: number) => Math.round(s * 100) / 100
const fl = (s: number) => Math.floor(s * 100) / 100 // Enden abrunden, damit sie nicht hinter das Videoende ragen
const clock = (s: number) => { const d = Math.round(s * 10); return `${Math.floor(d / 600)}:${String(Math.floor(d / 10) % 60).padStart(2, '0')},${d % 10}` }
const secs = (s: number) => `${s.toFixed(1).replace('.', ',')} s`

interface Props { content: ClipContent; size: Size; disabled: boolean; onApply: (parts: Part[]) => void; onClose: () => void }

export function ClipCutter({ content, size, disabled, onApply, onClose }: Props) {
  const [parts, setParts] = useState<Part[]>(content.parts)
  const [sel, setSel] = useState(0)
  const [dur, setDur] = useState(0) // 0 = Metadaten noch nicht da
  const [mode, setMode] = useState<'free' | 'clip'>('free') // free = Quelle durchlaufen, clip = Schnittfassung mit Sprüngen
  const [bad, setBad] = useState(false) // Chromium spielt den Codec nicht (HEVC, ProRes …)
  const [wide, setWide] = useState(false) // Quelle breiter als das Format → Bildausschnitt wählbar
  const video = useRef<HTMLVideoElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const pl = useClipPlayer(video, parts)
  const t = pl.src, play = pl.playing ? mode : null
  const top = useRef(Math.max(0, ...content.parts.map((x) => x.end))) // ohne Metadaten gilt das größte ursprüngliche Ende als Grenze, sie wächst nicht mit
  const end = dur || top.current
  const p = parts[Math.min(sel, parts.length - 1)]
  const changed = JSON.stringify(parts) !== JSON.stringify(content.parts)

  useLayoutEffect(() => box.current?.focus(), [])

  const seek = (s: number) => pl.seekSource(Math.max(0, Math.min(end, s)))
  const stop = pl.pause
  const patch = (i: number, q: Partial<Part>) => setParts((l) => l.map((x, j) => (j === i ? { ...x, ...q } : x)))
  // Anfang/Ende mit Mindestlänge und in den Grenzen der Quelle
  const setEdge = (i: number, edge: 'start' | 'end', s: number) => {
    const x = parts[i]
    if (!Number.isFinite(s)) return
    patch(i, edge === 'start' ? { start: r2(Math.max(0, Math.min(s, x.end - MIN))) } : { end: Math.max(x.start + MIN, fl(Math.min(end, s))) }) // Mindestlänge vor Videoende: KI-Zeiten können dahinter liegen
  }
  // Anfang/Ende an der Abspielposition nur, wenn sie im Ausschnitt liegt: sonst würde er still auf die Mindestlänge schrumpfen
  const canStart = t <= p.end - MIN, canEnd = t >= p.start + MIN
  const canSplit = parts.length < MAX && t >= p.start + MIN && t <= p.end - MIN
  const split = () => {
    if (!canSplit) return
    setParts((l) => [...l.slice(0, sel), { ...p, end: r2(t) }, { ...p, start: r2(t) }, ...l.slice(sel + 1)])
    setSel(sel + 1)
  }
  const remove = () => {
    if (parts.length < 2) return
    setParts((l) => l.filter((_, j) => j !== sel))
    setSel(Math.max(0, sel - 1))
  }
  const canAdd = parts.length < MAX && end - t >= MIN
  const add = () => {
    if (!canAdd) return
    setParts((l) => [...l.slice(0, sel + 1), { start: r2(t), end: fl(Math.min(end, t + 5)) }, ...l.slice(sel + 1)])
    setSel(sel + 1)
  }
  const toggle = () => {
    if (!video.current || bad) return
    if (play) return stop()
    setMode('free')
    pl.playSource()
  }
  // Schnittfassung ab dem gewählten Ausschnitt; davor die letzten 2 s des vorigen, damit man den Schnitt hört
  const playClip = () => {
    if (!video.current || bad) return
    if (play) stop()
    const i = Math.max(0, sel - 1)
    pl.seekClip(Math.max(partsLength(parts.slice(0, i)), partsLength(parts.slice(0, sel)) - 2)) // im vorigen Ausschnitt max(Anfang, Ende − 2 s)
    setSel(i)
    setMode('clip')
    pl.play()
  }
  // In der Schnittfassung folgt die Auswahl dem laufenden Ausschnitt
  useEffect(() => { if (play === 'clip' && pl.part >= 0) setSel(pl.part) }, [play, pl.part])

  const close = async () => {
    if (!changed || await confirmDialog({ title: 'Schnitt verwerfen?', text: 'Deine Änderungen an den Ausschnitten gehen verloren.', ok: 'Verwerfen', danger: true })) onClose()
  }

  // Auf window in der Capture-Phase: nach „Teilen“ (Button wird disabled) liegt der Fokus auf body, ein Dialog-Handler griffe nicht mehr und App.tsx blätterte die Folie weg
  const onKey = (e: KeyboardEvent) => {
    if (document.querySelector('dialog[open]')) return // Rückfrage „Verwerfen?“ bedient sich selbst
    const el = e.target as HTMLElement
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && e.key !== 'Escape') return
    e.stopPropagation() // App und Stage sollen nicht blättern, rückgängig machen oder Elemente verschieben
    const btn = !!el.closest('button'), k = e.key.toLowerCase()
    if (e.key === 'Escape') void close()
    else if ((e.ctrlKey && !e.getModifierState('AltGraph')) || e.metaKey) return // [ ] sind auf deutschen Tastaturen AltGr+8/9 bzw. Option+5/6
    else if (e.key === ' ' && !btn) toggle()
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') seek(t + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 0.1))
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') setSel(Math.max(0, Math.min(parts.length - 1, sel + (e.key === 'ArrowUp' ? -1 : 1))))
    else if ((k === 'i' || e.key === '[') && canStart) setEdge(sel, 'start', t)
    else if ((k === 'o' || e.key === ']') && canEnd) setEdge(sel, 'end', t)
    else if (k === 's') split()
    else if (e.key === 'Delete' && !btn) remove()
    else return
    e.preventDefault()
  }
  const onKeyRef = useRef(onKey)
  onKeyRef.current = onKey
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKeyRef.current(e)
    addEventListener('keydown', h, true)
    return () => removeEventListener('keydown', h, true)
  }, [])

  // Detail-Zeitleiste: gewählter Ausschnitt mit etwas Rand. Beim Ziehen fest, sonst läuft die Leiste unter dem Griff weg.
  const around = (x: Part) => { const pad = Math.max(2, (x.end - x.start) * 0.25); return { from: Math.max(0, x.start - pad), to: Math.min(Math.max(end, x.end), x.end + pad) } }
  const [win, setWin] = useState(() => around(p))
  const dragging = useRef(false)
  const [settled, setSettled] = useState(0) // nach dem Ziehen neu ausrichten
  useEffect(() => { if (!dragging.current) setWin(around(p)) }, [sel, p.start, p.end, end, settled])

  return createPortal(
    <div className="look cut" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Clip schneiden">
      <header className="top">
        <div className="top-l"><button className="plain tint" onClick={() => void close()}>Abbrechen</button></div>
        <b>Schneiden</b>
        <div className="top-r"><button className="pill tint" disabled={!changed || disabled} title={disabled ? 'Die KI arbeitet gerade am Deck' : undefined} onClick={() => { onApply(parts); onClose() }}>Übernehmen</button></div>
      </header>
      <div className="cut-body">
        <div className="cut-player" style={{ aspectRatio: `${size.w} / ${size.h}` }}>
          <ClipVideo video={content.video} aspect={size.w / size.h} focus={p.focus} still={t} videoRef={video} onBad={() => setBad(true)} onClick={toggle}
            onMeta={(v) => {
              if (Number.isFinite(v.duration)) setDur(v.duration)
              setWide(v.videoWidth / v.videoHeight > size.w / size.h + 0.01)
            }} />
          {bad && <p className="cut-bad">Die Vorschau kann dieses Video nicht abspielen (etwa HEVC oder ProRes). Die Zeiten lassen sich trotzdem als Zahlen anpassen.</p>}
        </div>

        <div className="cut-transport">
          <button className="btn" onClick={toggle} disabled={bad} title="Quelle abspielen (Leertaste)">{play === 'free' ? <Pause size={14} /> : <Play size={14} />} Quelle</button>
          <button className="btn" onClick={play === 'clip' ? stop : playClip} disabled={bad} title="Schnittfassung ab dem gewählten Ausschnitt, mit 2 s davor">{play === 'clip' ? <Pause size={14} /> : <Play size={14} />} Clip</button>
          <span className="cut-time">{clock(t)}</span>
          <span className="cut-sum">Clip {secs(partsLength(parts))} · {parts.length} {parts.length === 1 ? 'Ausschnitt' : 'Ausschnitte'}</span>
        </div>

        <Strip label="Ganzes Video" from={0} to={end} parts={parts} head={t} onSeek={seek} handles={{ sel, onSel: setSel }} />
        <Strip label={`Ausschnitt ${sel + 1}`} from={win.from} to={win.to} parts={parts} head={t} onSeek={seek} handles={{
          sel, onSel: setSel,
          onEdge: (edge, s) => { dragging.current = true; setEdge(sel, edge, s); seek(s) },
          onDragEnd: () => { dragging.current = false; setSettled((n) => n + 1) },
        }} />

        <div className="cut-parts" role="group" aria-label="Ausschnitte in Abspielreihenfolge">
          {parts.map((x, i) => (
            <button key={i} className={i === sel ? 'on' : ''} onClick={() => { setSel(i); seek(x.start) }}>
              <b>{i + 1}</b> {clock(x.start)}–{clock(x.end)} <span>{secs(x.end - x.start)}</span>
            </button>
          ))}
        </div>

        <div className="cut-edit">
          <label className="field"><span>Anfang</span>
            <span className="num"><input key={`s${sel}-${p.start}`} type="number" step="0.1" min={0} defaultValue={p.start}
              onBlur={(e) => { setEdge(sel, 'start', e.currentTarget.valueAsNumber); e.currentTarget.value = String(p.start) }} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} /><em>s</em></span>
          </label>
          <button className="btn" onClick={() => setEdge(sel, 'start', t)} disabled={!canStart} title="Anfang auf die Abspielposition (I oder [)">Anfang hier</button>
          <label className="field"><span>Ende</span>
            <span className="num"><input key={`e${sel}-${p.end}`} type="number" step="0.1" min={0} defaultValue={p.end}
              onBlur={(e) => { setEdge(sel, 'end', e.currentTarget.valueAsNumber); e.currentTarget.value = String(p.end) }} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} /><em>s</em></span>
          </label>
          <button className="btn" onClick={() => setEdge(sel, 'end', t)} disabled={!canEnd} title="Ende auf die Abspielposition (O oder ])">Ende hier</button>
          <span className="cut-gap" />
          <button className="btn" onClick={split} disabled={!canSplit} title="An der Abspielposition teilen (S)"><Scissors size={14} /> Teilen</button>
          <button className="btn" onClick={add} disabled={!canAdd} title="Neuer Ausschnitt ab der Abspielposition, nach dem gewählten"><Plus size={14} /> Neu</button>
          <button className="btn" onClick={remove} disabled={parts.length < 2} title="Ausschnitt löschen (Entf)"><Trash2 size={14} /> Löschen</button>
        </div>
        {wide && (
          <label className="field cut-focus"><span>Bildausschnitt</span>
            <input type="range" min={0} max={1} step={0.01} value={p.focus ?? 0.5} onChange={(e) => patch(sel, { focus: r2(e.currentTarget.valueAsNumber) })} aria-label="Bildausschnitt von links nach rechts" />
          </label>
        )}
        <p className="look-hint">Leertaste abspielen · ← → 0,1 s (mit Umschalt 1 s) · I / O oder [ ] Anfang und Ende · S teilen · Entf löschen · ↑ ↓ Ausschnitt wählen · Hook und Untertitel siehst du erst im MP4</p>
      </div>
    </div>,
    document.body,
  )
}
