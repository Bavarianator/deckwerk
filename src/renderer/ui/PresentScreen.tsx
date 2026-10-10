// Präsentationsmodus: Vollbild, Builds per Web Animations API mit denselben Presets wie der PPTX-Export.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { itemSteps, morphNames, morphText, showOf, sizeOf, transitionOf, transitionSpeedOf, type AnimDir, type AnimSpeed, type BuildPreset, type Deck, type Item, type ItemAnim, type MorphEl, type Transition } from '../../shared/deck'
import { fmtSec, speakSec } from '../../shared/handout'
import { LAYOUTS, buildOf, type LayoutId } from '../../shared/layouts'
import type { Ink } from '../../preload'
import { QrCode, SlideView } from '../slide'
import { chaptersOf, titleOf } from './story'

const DUR = 400
const EASE = 'cubic-bezier(.2,.7,.2,1)'
const SOFT = 'cubic-bezier(.65,0,.35,1)' // Schieben: weich an- und auslaufend
// Systemeinstellung „Bewegung reduzieren“: nur Überblenden, kein Zoom, keine Bewegung
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches
// translate/scale statt transform, damit eigene Transforms der Layouts erhalten bleiben
const POP: Keyframe[] = [{ opacity: 0, scale: '.5' }, { opacity: 1, scale: '1.06', offset: 0.7 }, { opacity: 1, scale: '1' }]
const KF: Record<Exclude<BuildPreset, 'none'>, Keyframe[]> = {
  fade: [{ opacity: 0 }, { opacity: 1 }],
  list: [{ opacity: 0, translate: '0 12px', filter: 'blur(6px)' }, { opacity: 1, translate: '0 0', filter: 'blur(0)' }],
  stagger: [{ opacity: 0, translate: '0 14px', filter: 'blur(8px)' }, { opacity: 1, translate: '0 0', filter: 'blur(0)' }],
  wipe: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
  'zoom-kpi': [{ opacity: 0, scale: '.6' }, { opacity: 1, scale: '1' }],
  pan: [{ opacity: 0, translate: '-40px 0' }, { opacity: 1, translate: '0 0' }],
  pop: POP,
  words: [{ opacity: 0 }, { opacity: 1 }], // Flächen und Bilder; Text läuft Wort für Wort (prepareBuilds)
  photo: [{ opacity: 0 }, { opacity: 1 }], // Text und Flächen blenden ein, Fotos zoomen (photoZoom)
}

// Canva „Foto-Zoom“: randlose und halbseitige Fotos zoomen über 12 s langsam auf 108 % (beschnitten von Folie bzw. .media).
// Läuft ab Folienbeginn ohne Klick; PowerPoint: Betonung „Vergrößern“ (export-pptx.ts)
const photoZoom = (root: HTMLElement) =>
  root.querySelectorAll<HTMLElement>('.backdrop [data-pptx="img"], .media [data-pptx="img"]').forEach((el) =>
    el.animate([{ scale: '1' }, { scale: '1.08' }], { duration: 12000, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'forwards' }))

// Richtung = Bewegungsrichtung wie die Pfeile in Canva; Versatz des Startpunkts bzw. Startausschnitt beim Wischen
const offset = (dir: AnimDir, d: string) => ({ right: `-${d} 0`, left: `${d} 0`, up: `0 ${d}`, down: `0 -${d}` })[dir]
const WIPE_FROM: Record<AnimDir, string> = { right: 'inset(0 100% 0 0)', left: 'inset(0 0 0 100%)', up: 'inset(100% 0 0 0)', down: 'inset(0 0 100% 0)' }
const SPEED: Record<AnimSpeed, number> = { slow: 1.6, fast: 0.6 }

// Canva-Element-Animationen, Gegenstücke in PowerPoint: export-pptx.ts ITEM_FX. typewriter/ascend laufen über die
// Buchstaben bzw. Wörter (.dw-part, im Präsentationsmodus von slide.tsx erzeugt), Abstand wie p:iterate in animations.ts
const ITEM_MOTION: Record<Exclude<ItemAnim, 'none'>, { kf: Keyframe[]; ms: number; easing?: string }> = {
  fade: { kf: KF.fade, ms: 500 },
  float: { kf: KF.stagger, ms: 500 },
  pan: { kf: KF.pan, ms: 500 },
  drift: { kf: [{ opacity: 0, translate: '-90px 0' }, { opacity: 1, translate: '0 0' }], ms: 1200, easing: 'cubic-bezier(.25,.6,.3,1)' },
  pop: { kf: POP, ms: 450 },
  zoom: { kf: KF['zoom-kpi'], ms: 500 },
  tumble: { kf: [{ opacity: 0, rotate: '-90deg', scale: '.6' }, { opacity: 1, rotate: '0deg', scale: '1' }], ms: 700 },
  stomp: { kf: [{ opacity: 0, scale: '1.6' }, { opacity: 1, scale: '.97', offset: 0.75 }, { opacity: 1, scale: '1' }], ms: 500 },
  // steigt hinter einer gedachten Linie (der eigenen Unterkante) auf: Ausschnitt bleibt auf der Endposition stehen
  baseline: { kf: [{ translate: '0 100%', clipPath: 'inset(-100% 0 100% 0)' }, { translate: '0 0', clipPath: 'inset(0 0 0 0)' }], ms: 600 },
  wipe: { kf: KF.wipe, ms: 500 },
  typewriter: { kf: [{ opacity: 0 }, { opacity: 1 }], ms: 1 },
  ascend: { kf: [{ opacity: 0, translate: '0 .5em' }, { opacity: 1, translate: '0 0' }], ms: 400 },
  breathe: { kf: [{ scale: '1' }, { scale: '1.04' }], ms: 1200 },
}
const GAP = { typewriter: 45, ascend: 120 }
const motionOf = (anim: Exclude<ItemAnim, 'none'>, dir?: AnimDir): Keyframe[] => {
  const move = (d: AnimDir, by: string): Keyframe[] => [{ opacity: 0, translate: offset(d, by) }, { opacity: 1, translate: '0 0' }]
  if (anim === 'float') return move(dir ?? 'up', '24px')
  if (anim === 'pan') return move(dir ?? 'right', '40px')
  if (anim === 'drift') return move(dir ?? 'right', '90px')
  if (anim === 'wipe') return [{ clipPath: WIPE_FROM[dir ?? 'right'] }, { clipPath: 'inset(0 0 0 0)' }]
  return ITEM_MOTION[anim].kf
}

// Ein Element auftreten lassen (Präsentieren und Vorschau im Editor). Liefert die Animationen, pausiert nichts.
// Richtung und Tempo kommen aus data-anim-dir/-speed, die Vorschau reicht sie direkt (der State ist noch nicht gerendert).
export function animateItem(el: HTMLElement, anim: ItemAnim, delay = 0, dir = el.dataset.animDir as AnimDir | undefined, speed = el.dataset.animSpeed as AnimSpeed | undefined): Animation[] {
  if (anim === 'none') return []
  const m = ITEM_MOTION[anim], f = speed ? SPEED[speed] : 1, kf = motionOf(anim, dir)
  if (anim === 'breathe') return [el.animate(kf, { duration: m.ms * f, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' })]
  const parts = anim === 'typewriter' || anim === 'ascend' ? [...el.querySelectorAll<HTMLElement>('.dw-part')] : []
  if (!parts.length) return [el.animate(m.ms > 1 ? kf : KF.fade, { duration: Math.max(m.ms, 500) * f, delay, easing: m.easing ?? EASE, fill: 'both' })]
  return parts.map((p, k) => p.animate(kf, { duration: m.ms * f, delay: delay + k * GAP[anim as keyof typeof GAP] * f, easing: EASE, fill: 'both' }))
}

// Übergänge wie in PowerPoint (animations.ts): neue Folie wird aufgedeckt oder hereingeschoben, push schiebt die alte mit
// hinaus. d = Richtung (1 vorwärts, −1 rückwärts). Morph läuft getrennt (nameSlots); hier wird es zum Überblenden.
export function playTransition(t: Transition, d: number, incoming: HTMLElement, outgoing?: HTMLElement | null, speed?: AnimSpeed): Animation {
  const frames: Partial<Record<Transition, Keyframe[]>> = {
    fade: [{ opacity: 0 }, { opacity: 1 }], dissolve: [{ opacity: 0, filter: 'blur(6px)' }, { opacity: 1, filter: 'blur(0)' }],
    push: [{ translate: `0 ${100 * d}%` }, { translate: '0 0' }], cover: [{ translate: `${100 * d}% 0` }, { translate: '0 0' }],
    wipe: [{ clipPath: d > 0 ? 'inset(0 100% 0 0)' : 'inset(0 0 0 100%)' }, { clipPath: 'inset(0 0 0 0)' }],
    split: [{ clipPath: 'inset(0 50%)' }, { clipPath: 'inset(0 0%)' }],
    circle: [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(75% at 50% 50%)' }],
    zoom: [{ scale: '0.96', opacity: 0 }, { scale: '1', opacity: 1 }],
    slide: [{ translate: `${100 * d}% 0` }, { translate: '0 0' }], stack: [{ translate: `${100 * d}% 0` }, { translate: '0 0' }],
  }
  if (still()) return incoming.animate(frames.fade!, { duration: DUR, easing: EASE })
  const f = speed ? SPEED[speed] : 1
  const opts = t === 'push' || t === 'slide' || t === 'cover' || t === 'stack' ? { duration: 550 * f, easing: SOFT } : { duration: DUR * f, easing: EASE }
  if (t === 'push') outgoing?.animate([{ translate: '0 0' }, { translate: `0 ${-100 * d}%` }], { ...opts, fill: 'forwards' })
  if (t === 'slide') outgoing?.animate([{ translate: '0 0' }, { translate: `${-100 * d}% 0` }], { ...opts, fill: 'forwards' })
  if (t === 'stack') outgoing?.animate([{ scale: '1', opacity: 1 }, { scale: '.9', opacity: 0.4 }], { ...opts, fill: 'forwards' }) // alte Folie tritt zurück
  if (t === 'color') {
    // Farbwischen: eine Fläche in der Akzentfarbe zieht über die Folie, dahinter wechselt sie
    const band = incoming.parentElement!.appendChild(document.createElement('div'))
    band.style.cssText = `position:absolute;inset:0;z-index:2;background:${getComputedStyle(incoming.querySelector('.slide') ?? incoming).getPropertyValue('--accent') || '#16161a'}`
    const [from, to] = d > 0 ? ['inset(0 100% 0 0)', 'inset(0 0 0 100%)'] : ['inset(0 0 0 100%)', 'inset(0 100% 0 0)']
    const long = { duration: DUR * 2 * f, easing: 'cubic-bezier(.6,0,.4,1)' }
    band.animate([{ clipPath: from }, { clipPath: 'inset(0 0 0 0)', offset: 0.5 }, { clipPath: to }], long).finished.finally(() => band.remove())
    return incoming.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 0.5 }, { opacity: 1 }], long)
  }
  return incoming.animate(frames[t] ?? frames.fade!, opts)
}

const presetOf = (deck: Deck, i: number): BuildPreset => buildOf(deck, i)
const inkPos = (e: { clientX: number; clientY: number; currentTarget: Element }): [number, number] => {
  const r = e.currentTarget.getBoundingClientRect()
  return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
}

// Legt pausierte Animationen an (fill: both → Elemente sind sofort versteckt) und liefert die Schritte. Der erste läuft
// von selbst (Layout-Aufbau, außer Liste per Klick), jeder weitere per Klick.
// keep = Slots, die per Morph schon von der vorigen Folie herübergewandert sind: die treten nicht noch einmal auf.
function prepare(root: HTMLElement, preset: BuildPreset, mode: Deck['mode'], keep: Set<string>, items?: Item[]): Animation[][] {
  const { steps: builds, chain } = prepareBuilds(root, preset, mode, keep)
  const steps = preset !== 'none' && !(preset === 'list' && mode === 'click') ? builds : [[], ...builds]
  const [joined, ...clicks] = prepareItems(root, mode, keep, items, steps.at(-1)!, chain)
  steps.at(-1)!.push(...joined) // mit/nach vorherigem: hängt am letzten Aufbau-Schritt
  return [...steps, ...clicks]
}

// Morph wie in PowerPoint/Keynote: zugeordnete Elemente (morphNames: gleicher Text/Bild, sonst gleicher Slot) bekommen auf
// beiden Folien denselben view-transition-name; Chromium animiert Lage, Größe und Inhalt, der Rest blendet über.
// Liefert die Namen dieser Folie (für den nächsten Schritt) und die Slots, die von prev herübergewandert sind.
// Text wandert in natürlicher Größe und wächst nach dem Verhältnis der Schriftgrößen (app.css .dw-text): Textboxen sind oft
// spaltenbreit, ein Strecken auf die neue Boxbreite verzerrt sonst die Schrift.
type Named = MorphEl & { fs?: number }
function nameSlots(root: HTMLElement, prev?: Named[]): { list: Named[]; came: Set<string> } {
  const r = root.getBoundingClientRect()
  const seen = new Set<string>()
  const els = [...root.querySelectorAll<HTMLElement>('[data-pptx][data-slot]')].filter((el) => {
    const b = el.getBoundingClientRect()
    // Namen müssen eindeutig sein (sonst bricht der Übergang ab); Randabfallendes bliebe beim Wandern ungeschnitten
    if (seen.has(el.dataset.slot!) || b.left < r.left - 1 || b.top < r.top - 1 || b.right > r.right + 1 || b.bottom > r.bottom + 1) return false
    return seen.add(el.dataset.slot!)
  })
  const own = els.map((el) => {
    const css = el.dataset.pptx === 'text' ? getComputedStyle(el) : undefined
    el.style.setProperty('view-transition-class', css ? (css.textAlign === 'center' ? 'dw-text dw-center' : 'dw-text') : 'none')
    return { slot: el.dataset.slot!, key: css ? morphText(el.innerText) : el.dataset.src && `img:${el.dataset.src}`, fs: css && parseFloat(css.fontSize) }
  })
  const names = prev ? morphNames(prev, own) : own.map((e) => e.slot)
  const before = new Map(prev?.map((e) => [e.slot, e.fs]))
  els.forEach((el, k) => (el.style.viewTransitionName = `dw-${CSS.escape(names[k])}`))
  const grow = own.flatMap((e, k) => {
    const from = before.get(names[k])
    return from && e.fs ? [`::view-transition-old(dw-${CSS.escape(names[k])}),::view-transition-new(dw-${CSS.escape(names[k])}){--dw-r:${e.fs / from}}`] : []
  })
  const style = document.getElementById('dw-morph') ?? document.head.appendChild(Object.assign(document.createElement('style'), { id: 'dw-morph' }))
  style.textContent = grow.join('\n')
  return { list: own.map((e, k) => ({ ...e, slot: names[k] })), came: new Set(own.filter((_, k) => before.has(names[k])).map((e) => e.slot)) }
}

// Freie Elemente mit Auftritt nach Start und Verzögerung (itemSteps, wie im PPTX-Export). Schritt 0 hängt an prev an,
// dessen letzte Kette bei chain ms beginnt. Atmen läuft sofort und ohne Ende mit, ist also kein Schritt (finish() auf
// einer endlosen Animation würfe).
function prepareItems(root: HTMLElement, mode: Deck['mode'], keep: Set<string>, items: Item[] | undefined, prev: Animation[], chain: number): Animation[][] {
  const els = [...root.querySelectorAll<HTMLElement>('[data-anim]')].filter((el) => !keep.has(el.dataset.slot!))
  els.filter((el) => el.dataset.anim === 'breathe').forEach((el) => animateItem(el, 'breathe'))
  const runs = els.filter((el) => el.dataset.anim !== 'breathe').map((el) => {
    const as = animateItem(el, el.dataset.anim as ItemAnim)
    as.forEach((a) => a.pause())
    return { as, it: items?.find((x) => x.id === el.dataset.item) }
  })
  const end = (as: Animation[]) => Math.max(0, ...as.map((a) => Number(a.effect?.getComputedTiming().endTime ?? 0)))
  return itemSteps(runs.map(({ as, it }) => ({ start: it?.animStart, delay: it?.animDelay, ms: end(as) })), mode, end(prev), chain).map((step) =>
    step.flatMap(({ k, at }) => runs[k].as.map((a) => {
      a.effect?.updateTiming({ delay: at + Number(a.effect.getTiming().delay ?? 0) })
      return a
    })))
}

// chain = Beginn der letzten Kette wie in der PPTX (stepsFor): wipe, words und Liste ohne Klick bauen Gruppe für Gruppe
// in eigenen Ketten auf, die übrigen in einer; dort setzt „Zugleich“ eines freien Elements an
function prepareBuilds(root: HTMLElement, preset: BuildPreset, mode: Deck['mode'], keep: Set<string>): { steps: Animation[][]; chain: number } {
  if (preset === 'none') return { steps: [], chain: 0 }
  if (still()) preset = 'fade'
  if (preset === 'photo') photoZoom(root)
  const groups = new Map<number, HTMLElement[]>()
  for (const el of root.querySelectorAll<HTMLElement>('[data-build]')) {
    if (keep.has(el.dataset.slot!)) continue
    const n = Number(el.dataset.build)
    groups.set(n, [...(groups.get(n) ?? []), el])
  }
  const sorted = [...groups.entries()].sort((a, b) => a[0] - b[0])
  if (preset === 'words') {
    // Canva „Aufstieg“: Text Wort für Wort (.dw-part aus slide.tsx), Gruppen nacheinander, Flächen blenden mit ein
    let t = 0, chain = 0
    const all = sorted.flatMap(([, els]) => {
      const start = (chain = t)
      const as = els.flatMap((el) => (el.querySelector('.dw-part') ? animateItem(el, 'ascend', start) : [el.animate(KF.fade, { duration: DUR, delay: start, easing: EASE, fill: 'both' })]))
      t = Math.max(start + DUR, ...as.map((a) => Number(a.effect?.getTiming().delay ?? 0) + 400))
      return as
    })
    all.forEach((a) => a.pause())
    return { steps: [all], chain }
  }
  const perClick = preset === 'list' && mode === 'click'
  const steps = sorted.map(([, els], gi) =>
    els.map((el) => {
      const delay = perClick || preset === 'fade' || preset === 'photo' ? 0 : gi * 150
      const a = el.animate(KF[preset], { duration: DUR, delay, easing: EASE, fill: 'both' })
      a.pause()
      return a
    }))
  const chain = !perClick && (preset === 'wipe' || preset === 'list') ? Math.max(0, sorted.length - 1) * 150 : 0
  return { steps: perClick ? steps : [steps.flat()], chain }
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
export function PresentScreen({ deck: all, start: at, onExit, mode = 'solo' }: { deck: Deck; start: number; onExit: () => void; mode?: 'solo' | 'presenter' | 'audience' }) {
  // Ausgeblendete Folien gibt es hier nicht: Indizes (auch zum Publikum und Handy) zählen nur sichtbare Folien
  const { deck, start } = useMemo(() => showOf(all, at), [all, at])
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
  const morph = useRef<{ old: Named[]; done: Promise<unknown> } | null>(null)
  const last = deck.slides.length - 1

  const move = (i: number) => {
    if (i < 0 || i > last || i === view.i) return
    const dir = i > view.i ? 1 : -1
    // Übergang der Grenze zwischen beiden Folien, rückwärts gespiegelt
    if (transitionOf(deck, Math.max(i, view.i)) === 'morph' && document.startViewTransition && inRef.current) {
      const sp = transitionSpeedOf(deck, Math.max(i, view.i))
      document.documentElement.style.setProperty('--dw-morph', `${700 * (sp ? SPEED[sp] : 1)}ms`) // Dauer in app.css
      const old = nameSlots(inRef.current).list
      const vt = document.startViewTransition(() => flushSync(() => setView({ i, from: null, dir })))
      morph.current = { old, done: vt.finished }
      return
    }
    setView({ i, from: view.i, dir })
  }
  const step = () => {
    const s = pending.current.shift()
    if (s) s.forEach((a) => a.play())
    else move(view.i + 1)
  }
  // Referent: jeden Schritt ans Publikumsfenster schicken; beide Fenster rechnen denselben Ablauf
  // Pause (Canva „Blur“): Folie unscharf und abgedunkelt; jedes Weiter/Zurück hebt sie auf
  const [paused, setPaused] = useState(false)
  const pause = (on: boolean) => { setPaused(on); if (mode === 'presenter') void window.api.presentCmd({ type: 'pause', on }) }
  const go = (i: number) => { setJump(''); if (paused) pause(false); move(i); if (mode === 'presenter') void window.api.presentCmd({ type: 'go', i }) }
  const next = () => { setJump(''); if (paused) pause(false); step(); if (mode === 'presenter') void window.api.presentCmd({ type: 'next' }) }
  // Zahl + Enter springt zur Folie; die Ziffern verfallen nach 2 s
  const [jump, setJump] = useState('')
  useEffect(() => { if (!jump) return; const t = setTimeout(() => setJump(''), 2000); return () => clearTimeout(t) }, [jump])
  // Laserpointer und Stift (Canva „Zeichnen“): L / D schalten um, E löscht; nur Anzeige, nichts landet im Deck
  const [tool, setTool] = useState<'laser' | 'pen' | null>(null)
  const [ink, setInk] = useState<Ink>({ laser: null, strokes: [] })
  const share = (n: Ink) => { setInk(n); if (mode === 'presenter') void window.api.presentCmd({ type: 'ink', ink: n }) }
  useEffect(() => { if (mode !== 'audience') share({ laser: null, strokes: [] }) }, [view.i])
  const prev = () => go(view.i - 1)
  const remote = useRef({ step, move, next, prev })
  remote.current = { step, move, next, prev }
  // Handy als Fernbedienung: Weiter/Zurück wie Tasten, die Seite zeigt Folie und Notizen
  const [phone, setPhone] = useState<{ url?: string; error?: string } | null>(null)
  useEffect(() => {
    if (mode === 'audience') return
    const off = window.api.onRemote((c) => (c === 'next' ? remote.current.next() : remote.current.prev()))
    return () => { off(); void window.api.remoteStop() }
  }, [])
  useEffect(() => {
    if (mode !== 'audience') void window.api.remoteState({ i: view.i, n: last + 1, title: titleOf(deck, view.i), notes: deck.slides[view.i].notes ?? '' })
  }, [view.i])
  useEffect(() => {
    if (mode !== 'audience') return
    return window.api.onPresent((c) => {
      if (c === 'ended') return
      if (c.type === 'pause') setPaused(c.on)
      else if (c.type === 'next') remote.current.step()
      else if (c.type === 'ink') setInk(c.ink)
      else remote.current.move(c.i)
    })
  }, [])

  useLayoutEffect(() => {
    const root = inRef.current!
    const m = morph.current
    morph.current = null
    const keep = m ? nameSlots(root, m.old).came : new Set<string>()
    const steps = prepare(root, presetOf(deck, view.i), deck.mode, keep, deck.slides[view.i].items)
    if (view.dir < 0) {
      steps.flat().forEach((a) => a.finish()) // rückwärts: Folie fertig aufgebaut zeigen
      pending.current = []
    } else pending.current = steps
    const auto = pending.current.shift() // erster Schritt läuft von selbst (prepare)
    const begin = () => {
      auto?.forEach((a) => a.play())
      if (deck.mode === 'auto') pending.current.splice(0).flat().forEach((a) => a.play()) // Selbstlauf: auch freie Elemente ohne Klick
    }

    if (m) return void m.done.then(begin) // Aufbau erst, wenn die Elemente angekommen sind
    const t = transitionOf(deck, Math.max(view.i, view.from ?? 0))
    if (view.from === null || t === 'none') {
      setView((v) => ({ ...v, from: null }))
      return begin()
    }
    const anim = playTransition(t, view.dir, root, outRef.current, transitionSpeedOf(deck, Math.max(view.i, view.from ?? 0)))
    anim.finished.then(() => { setView((v) => ({ ...v, from: null })); begin() }, () => {})
  }, [view.i])

  useEffect(() => {
    if (mode === 'audience') return
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) setJump((jump + e.key).slice(-4))
      else if (e.key === 'Enter' && jump) { go(Math.min(Math.max(Number(jump), 1), last + 1) - 1); setJump('') }
      else if (e.key.toLowerCase() === 'b') pause(!paused)
      else if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(e.key)) next()
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) go(view.i - 1)
      else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(last)
      else if (e.key === 'Escape') onExit()
      else if (e.key.toLowerCase() === 'p') setPv(!pv)
      else if (e.key.toLowerCase() === 'l') { setTool(tool === 'laser' ? null : 'laser'); share({ ...ink, laser: null }) }
      else if (e.key.toLowerCase() === 'd') setTool(tool === 'pen' ? null : 'pen')
      else if (e.key.toLowerCase() === 'e') share({ laser: null, strokes: [] })
      else return
      if (!/^\d$/.test(e.key)) setJump('')
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

  // Verlinktes freies Element: #N springt zur Folie, Webadressen öffnet der Main-Prozess im Browser (setWindowOpenHandler)
  const follow = (e: React.MouseEvent) => {
    const el = mode !== 'audience' ? (e.target as HTMLElement).closest<HTMLElement>('[data-link]') : null
    const link = el?.dataset.link
    // noch nicht aufgetretenes Element (Animation wartet auf den Klick): Klick blättert normal weiter
    if (!el || !link || getComputedStyle(el).opacity === '0') return
    const n = link.match(/^#(\d+)$/)
    if (n && (+n[1] < 1 || +n[1] > all.slides.length)) return
    e.stopPropagation() // kein zusätzliches Weiterblättern
    if (n) go(showOf(all, +n[1] - 1).start) // #N zählt wie PPTX und Lint alle Folien, hier fehlen die ausgeblendeten
    else if (/^(https?:\/\/|mailto:)/.test(link)) window.open(link)
  }

  const stage = (
    <div className="present-stage" onClick={follow} style={{ width: w, height: w / ratio, filter: paused && !pv ? 'blur(24px) brightness(.55)' : 'none', transition: still() ? 'none' : 'filter .5s ease' }}>
      {view.from !== null && (
        <div ref={outRef} className="present-layer"><SlideView deck={deck} index={view.from} width={w} live /></div>
      )}
      <div ref={inRef} key={view.i} className="present-layer"><SlideView deck={deck} index={view.i} width={w} live /></div>
      <svg
        className={`present-ink ${tool ?? ''}`} viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden
        onClick={(e) => tool && e.stopPropagation()} // mit Werkzeug kein Weiterblättern per Klick
        onPointerDown={(e) => { if (tool !== 'pen') return; e.currentTarget.setPointerCapture(e.pointerId); share({ ...ink, strokes: [...ink.strokes, [inkPos(e)]] }) }}
        onPointerMove={(e) => {
          if (tool === 'laser') share({ ...ink, laser: inkPos(e) })
          else if (tool === 'pen' && e.buttons) share({ ...ink, strokes: [...ink.strokes.slice(0, -1), [...(ink.strokes.at(-1) ?? []), inkPos(e)]] })
        }}
        onPointerLeave={() => tool === 'laser' && share({ ...ink, laser: null })}
      >
        {ink.strokes.map((s, i) => <polyline key={i} points={s.map((p) => p.join(',')).join(' ')} vectorEffect="non-scaling-stroke" />)}
      </svg>
      {ink.laser && <div className="present-laser" style={{ left: `${ink.laser[0] * 100}%`, top: `${ink.laser[1] * 100}%` }} />}
    </div>
  )

  if (mode === 'audience') return <div className="present">{stage}</div>
  const hud = jump && (
    <div role="status" style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 10, padding: '6px 14px', borderRadius: 8, background: 'rgba(0,0,0,.6)', color: '#fff', font: '600 18px system-ui, sans-serif' }}>Folie {jump}</div>
  )
  if (!pv)
    return <div className="present" onClick={next} onContextMenu={(e) => { e.preventDefault(); go(view.i - 1) }}>{stage}{hud}</div>

  const notes = deck.slides[view.i].notes?.trim()
  const plan = deck.slides.reduce((t, s) => t + speakSec(s.notes), 0)
  return (
    <div className="pv">
      <div className="pv-top">
        <div className="pv-l">
          <button className="pill" onClick={onExit}>Beenden</button>
          <button className="pill" aria-expanded={!!phone} onClick={() => {
            if (phone) return setPhone(null)
            setPhone({})
            window.api.remoteStart().then((url) => setPhone({ url }), (e: Error) => setPhone({ error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))
          }}>Handy als Fernbedienung</button>
          {phone && (
            <div className="pv-phone material" role="dialog" aria-label="Handy als Fernbedienung">
              {phone.url ? <QrCode text={phone.url} slot="" color="#16161a" bg="#fff" className="pv-qr" /> : <p>{phone.error ?? 'Starte …'}</p>}
              <p>Mit der Handy-Kamera scannen. Handy und Rechner müssen im selben WLAN sein.</p>
            </div>
          )}
        </div>
        <div className="pv-meta">{paused && <span title="B oder Weiter/Zurück hebt die Pause auf"><b>Pausiert</b></span>}<span>Folie {view.i + 1} von {last + 1}</span>{plan > 0 && <span title="Geschätzte Sprechzeit laut Notizen">Plan ≈ {fmtSec(plan)}</span>}<Clock /></div>
      </div>
      <div className="pv-now" onClick={next}>{stage}</div>
      {hud}
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
        <div className="pv-foot"><b>{titleOf(deck, view.i)}</b><span>Leertaste oder → weiter · ← zurück · L Laser · D Zeichnen · E löschen · B Pause · Zahl+Enter Sprung · P Ansicht · Esc beendet</span></div>
      </div>
    </div>
  )
}
