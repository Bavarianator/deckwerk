// Präsentationsmodus: Vollbild, Builds per Web Animations API mit denselben Presets wie der PPTX-Export.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { sizeOf, type BuildPreset, type Deck } from '../../shared/deck'
import { fmtSec, speakSec } from '../../shared/handout'
import { LAYOUTS, buildOf, type LayoutId } from '../../shared/layouts'
import { SlideView } from '../slide'
import { chaptersOf, titleOf } from './story'

const DUR = 400
const EASE = 'cubic-bezier(.2,.7,.2,1)'
// translate/scale statt transform, damit eigene Transforms der Layouts erhalten bleiben
const KF: Record<Exclude<BuildPreset, 'none'>, Keyframe[]> = {
  fade: [{ opacity: 0 }, { opacity: 1 }],
  list: [{ opacity: 0, translate: '0 12px' }, { opacity: 1, translate: '0 0' }],
  stagger: [{ opacity: 0, translate: '0 24px' }, { opacity: 1, translate: '0 0' }],
  wipe: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
  'zoom-kpi': [{ opacity: 0, scale: '.6' }, { opacity: 1, scale: '1' }],
}

const presetOf = (deck: Deck, i: number): BuildPreset => buildOf(deck, i)

// Legt pausierte Animationen an (fill: both → Elemente sind sofort versteckt) und liefert die Klick-Schritte.
function prepare(root: HTMLElement, preset: BuildPreset, mode: Deck['mode']): Animation[][] {
  return [...prepareBuilds(root, preset, mode), ...prepareItems(root, mode)]
}

// Freie Elemente mit Auftritt: je ein Klick (Selbstlauf: nacheinander, alles in einem Schritt)
const ITEM_KF: Record<string, Keyframe[]> = { fade: KF.fade, float: KF.stagger, zoom: KF['zoom-kpi'], wipe: KF.wipe }
function prepareItems(root: HTMLElement, mode: Deck['mode']): Animation[][] {
  const steps = [...root.querySelectorAll<HTMLElement>('[data-anim]')].map((el, i) => {
    const a = el.animate(ITEM_KF[el.dataset.anim!] ?? KF.fade, { duration: 500, delay: mode === 'click' ? 0 : i * 500, easing: EASE, fill: 'both' })
    a.pause()
    return [a]
  })
  return mode === 'click' || !steps.length ? steps : [steps.flat()]
}

function prepareBuilds(root: HTMLElement, preset: BuildPreset, mode: Deck['mode']): Animation[][] {
  if (preset === 'none') return []
  const groups = new Map<number, HTMLElement[]>()
  for (const el of root.querySelectorAll<HTMLElement>('[data-build]')) {
    const n = Number(el.dataset.build)
    groups.set(n, [...(groups.get(n) ?? []), el])
  }
  const perClick = preset === 'list' && mode === 'click'
  const steps = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, els], gi) =>
    els.map((el) => {
      const delay = perClick || preset === 'fade' ? 0 : gi * 150
      const a = el.animate(KF[preset], { duration: DUR, delay, easing: EASE, fill: 'both' })
      a.pause()
      return a
    }))
  return perClick ? steps : [steps.flat()]
}

// Referentenansicht: Folie links, rechts „Als Nächstes“ und Notizen, unten die Kapitel als Fortschritt
const PV_SIDE = 480 // rechte Spalte + Abstände
const PV_ROWS = 290 // Kopfzeile, Kapitelleiste, Abstände
const stageWidth = (pv: boolean, r = 16 / 9) => (pv ? Math.min(innerWidth - PV_SIDE, (innerHeight - PV_ROWS) * r) : Math.min(innerWidth, innerHeight * r)) // r = Seitenverhältnis des Formats
const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`

function Clock() {
  const [t0] = useState(Date.now)
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  return (
    <>
      <div className="pv-clock"><b>{mmss(now - t0)}</b><span>vergangen</span></div>
      <span>{new Date(now).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</span>
    </>
  )
}

// mode: solo = ein Bildschirm (P schaltet die Referentenansicht um); presenter = Referent, spiegelt jeden Schritt
// an das Publikumsfenster; audience = Publikum auf dem zweiten Bildschirm, gesteuert nur vom Referenten
export function PresentScreen({ deck, start, onExit, mode = 'solo' }: { deck: Deck; start: number; onExit: () => void; mode?: 'solo' | 'presenter' | 'audience' }) {
  const [view, setView] = useState({ i: start, from: null as number | null, dir: 1 })
  const [pv, setPv] = useState(mode === 'presenter')
  const [noteSize, setNoteSize] = useState(() => { try { return Number(localStorage.getItem('dw.noteSize')) || 23 } catch { return 23 } })
  useEffect(() => { try { localStorage.setItem('dw.noteSize', String(noteSize)) } catch { /* nur für diese Sitzung */ } }, [noteSize])
  const ratio = sizeOf(deck).w / sizeOf(deck).h
  const [w, setW] = useState(() => stageWidth(false, ratio))
  useEffect(() => setW(stageWidth(pv, ratio)), [pv])
  const inRef = useRef<HTMLDivElement>(null)
  const outRef = useRef<HTMLDivElement>(null)
  const pending = useRef<Animation[][]>([])
  const last = deck.slides.length - 1

  const move = (i: number) => {
    if (i < 0 || i > last || i === view.i) return
    setView({ i, from: view.i, dir: i > view.i ? 1 : -1 })
  }
  const step = () => {
    const s = pending.current.shift()
    if (s) s.forEach((a) => a.play())
    else move(view.i + 1)
  }
  // Referent: jeden Schritt ans Publikumsfenster schicken; beide Fenster rechnen denselben Ablauf
  const go = (i: number) => { move(i); if (mode === 'presenter') void window.api.presentCmd({ type: 'go', i }) }
  const next = () => { step(); if (mode === 'presenter') void window.api.presentCmd({ type: 'next' }) }
  const remote = useRef({ step, move })
  remote.current = { step, move }
  useEffect(() => {
    if (mode !== 'audience') return
    return window.api.onPresent((c) => { if (c === 'ended') return; if (c.type === 'next') remote.current.step(); else remote.current.move(c.i) })
  }, [])

  useLayoutEffect(() => {
    const root = inRef.current!
    const steps = prepare(root, presetOf(deck, view.i), deck.mode)
    if (view.dir < 0) {
      steps.flat().forEach((a) => a.finish()) // rückwärts: Folie fertig aufgebaut zeigen
      pending.current = []
    } else pending.current = steps
    const builds = presetOf(deck, view.i) !== 'none' // erster Schritt = Layout-Aufbau, läuft von selbst (außer Liste per Klick)
    const auto = view.dir > 0 && builds && !(presetOf(deck, view.i) === 'list' && deck.mode === 'click') ? pending.current.shift() : undefined
    const begin = () => {
      auto?.forEach((a) => a.play())
      if (deck.mode === 'auto') pending.current.splice(0).flat().forEach((a) => a.play()) // Selbstlauf: auch freie Elemente ohne Klick
    }

    const t = deck.transition === 'morph' ? 'fade' : deck.transition // ponytail: Morph im App-Modus als Fade, echtes Morph nur in PowerPoint
    if (view.from === null || t === 'none') {
      setView((v) => ({ ...v, from: null }))
      return begin()
    }
    const opts = { duration: DUR, easing: EASE }
    // Vorschau der PowerPoint-Übergänge (animations.ts): neue Folie wird aufgedeckt oder hereingeschoben
    const d = view.dir
    const frames: Record<string, Keyframe[]> = {
      fade: [{ opacity: 0 }, { opacity: 1 }], dissolve: [{ opacity: 0, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0)' }],
      push: [{ translate: `0 ${100 * d}%` }, { translate: '0 0' }], cover: [{ translate: `${100 * d}% 0` }, { translate: '0 0' }],
      wipe: [{ clipPath: d > 0 ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)' }, { clipPath: 'inset(0 0 0 0)' }],
      split: [{ clipPath: 'inset(0 50%)' }, { clipPath: 'inset(0 0%)' }],
      circle: [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }],
      zoom: [{ scale: '0.6', opacity: 0 }, { scale: '1', opacity: 1 }],
    }
    const anim = root.animate(frames[t] ?? frames.fade, opts)
    if (t === 'push') outRef.current?.animate([{ translate: '0 0' }, { translate: `0 ${-100 * view.dir}%` }], { ...opts, fill: 'forwards' })
    anim.finished.then(() => { setView((v) => ({ ...v, from: null })); begin() }, () => {})
  }, [view.i])

  useEffect(() => {
    if (mode === 'audience') return
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(e.key)) next()
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) go(view.i - 1)
      else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(last)
      else if (e.key === 'Escape') onExit()
      else if (e.key.toLowerCase() === 'p') setPv(!pv)
      else return
      e.preventDefault()
    }
    const onResize = () => setW(stageWidth(pv, ratio))
    addEventListener('keydown', onKey)
    addEventListener('resize', onResize)
    return () => { removeEventListener('keydown', onKey); removeEventListener('resize', onResize) }
  })

  useEffect(() => {
    if (mode === 'audience') return // das Publikumsfenster ist schon Vollbild
    const onFs = () => { if (!document.fullscreenElement) onExit() }
    document.documentElement.requestFullscreen?.().then(() => document.addEventListener('fullscreenchange', onFs), () => {})
    return () => {
      document.removeEventListener('fullscreenchange', onFs)
      if (document.fullscreenElement) void document.exitFullscreen()
    }
  }, [])

  const stage = (
    <div className="present-stage" style={{ width: w, height: w / ratio }}>
      {view.from !== null && (
        <div ref={outRef} className="present-layer"><SlideView deck={deck} index={view.from} width={w} live /></div>
      )}
      <div ref={inRef} key={view.i} className="present-layer"><SlideView deck={deck} index={view.i} width={w} live /></div>
    </div>
  )

  if (mode === 'audience') return <div className="present">{stage}</div>
  if (!pv)
    return <div className="present" onClick={next} onContextMenu={(e) => { e.preventDefault(); go(view.i - 1) }}>{stage}</div>

  const notes = deck.slides[view.i].notes?.trim()
  const plan = deck.slides.reduce((t, s) => t + speakSec(s.notes), 0)
  return (
    <div className="pv">
      <div className="pv-top">
        <button className="pill" onClick={onExit}>Beenden</button>
        <div className="pv-meta"><span>Folie {view.i + 1} von {last + 1}</span>{plan > 0 && <span title="Geschätzte Sprechzeit laut Notizen">Plan ≈ {fmtSec(plan)}</span>}<Clock /></div>
      </div>
      <div className="pv-now" onClick={next}>{stage}</div>
      <aside className="pv-side">
        <h3>Als Nächstes</h3>
        {view.i < last
          ? <div className="pv-next"><SlideView deck={deck} index={view.i + 1} width={352} /></div>
          : <div className="pv-next end" style={{ '--ratio': `${sizeOf(deck).w} / ${sizeOf(deck).h}` } as CSSProperties}>Ende der Präsentation</div>}
        <h3>
          Notizen
          <span className="pv-size">
            <button aria-label="Notizen kleiner" onClick={() => setNoteSize(Math.max(14, noteSize - 3))}>A−</button>
            <button aria-label="Notizen größer" onClick={() => setNoteSize(Math.min(44, noteSize + 3))}>A+</button>
          </span>
        </h3>
        <p className="pv-notes" style={{ fontSize: noteSize }}>{notes || 'Keine Notizen zu dieser Folie.'}</p>
      </aside>
      <div className="pv-story" aria-label="Storyline">
        <div className="pv-chapters">
          {chaptersOf(deck).map((c) => (
            <div key={c.from} className={`pv-chapter ${view.i >= c.from && view.i <= c.to ? 'now' : ''}`} style={{ flexGrow: c.to - c.from + 1 }}>
              {c.title}
              <div className="pv-bars">
                {Array.from({ length: c.to - c.from + 1 }, (_, k) => c.from + k).map((i) => <span key={i} className={i < view.i ? 'done' : i === view.i ? 'now' : ''} />)}
              </div>
            </div>
          ))}
        </div>
        <div className="pv-foot"><b>{titleOf(deck, view.i)}</b><span>Leertaste oder → weiter · ← zurück · P Ansicht · Esc beendet</span></div>
      </div>
    </div>
  )
}
