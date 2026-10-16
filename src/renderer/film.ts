// Feature „Animation“: eine Szene Frame für Frame wie bei Remotion. filmPrepare legt alle Animationen der Folie pausiert an
// (dieselben wie beim Präsentieren, prepare()), seek(t) setzt sie auf die Szenenzeit t (s); ein Takt ist ein Klick-Schritt.
// Nur im Film: Kamerafahrt (slide.camera), Mauszeiger mit Klick-Welle und Zoom (.dw-cursor), hochzählende Zahlen (big-number,
// kpi-grid), Tippen in Layout-Elementen (data-anim="typewriter"), Videos je Frame gespult und Bildschirm-Zoom (data-zooms).
// Nutzer: Film-Host (main.tsx → render.ts renderFilm) und der Player der App.
import type { Deck } from '../shared/deck'
import { buildOf } from '../shared/layouts'
import { sceneTimeline, zoomAt, type ScreenZoom } from '../shared/film'
import { prepare } from './ui/PresentScreen'

const SOFT = 'cubic-bezier(.65,0,.35,1)' // weich an- und auslaufend
const CAMERA_MS = 800, CURSOR_MS = 700, RIPPLE_MS = 450, COUNT_MS = 1200, SEEK_TIMEOUT = 2000

export interface FilmScene {
  steps: number[] // Länge jedes Takts in s (Ende seiner letzten Animation, inkl. Verzögerung)
  endless: boolean // Atmen, Foto-Zoom oder Video: das Bild ändert sich bis zum Szenenende
  words: number // Wörter auf der Folie (Lesezeit ohne Stimme)
  setBeats(beats: number[]): void // Beginn jedes Takts in s (sceneTimeline)
  seek(t: number): Promise<void>
  dispose(): void
}

// Mauszeiger (Layout screen): x/y = Anteile 0..1 seines offsetParent; die Lage setzt film.ts über left/top in %
interface CursorMove { step: number; x: number; y: number; click?: boolean; zoom?: number }
type Box = [x: number, y: number, w: number, h: number]

// Tippen in Layout-Elementen: jeder Buchstabe eines Textknotens in ein .dw-part, umgebende Spans (Syntaxfarben) bleiben
function splitLetters(el: HTMLElement) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const n of nodes) n.replaceWith(...[...n.data].map((c) => Object.assign(document.createElement('span'), { className: 'dw-part', textContent: c })))
}

// Zahl samt Format: „1.234,5“ (Tausenderpunkt, Dezimalkomma), „3.5“, „1,234,567“. Ein einzelner Punkt vor genau 3 Ziffern ist Tausender.
function parseNum(s: string) {
  const dots = s.split('.').length - 1, commas = s.split(',').length - 1
  let point = '', group = ''
  if (dots && commas) [point, group] = s.lastIndexOf(',') > s.lastIndexOf('.') ? [',', '.'] : ['.', ',']
  else if (commas) commas > 1 ? (group = ',') : (point = ',')
  else if (dots) dots > 1 || /\.\d{3}$/.test(s) ? (group = '.') : (point = '.')
  const plain = group ? s.replaceAll(group, '') : s
  const [int, frac = ''] = point ? plain.split(point) : [plain]
  return { value: Number(`${int}.${frac || 0}`), dec: frac.length, point, group }
}
const formatNum = (v: number, n: ReturnType<typeof parseNum>) => {
  const [int, frac] = v.toFixed(n.dec).split('.')
  return (n.group ? int.replace(/\B(?=(\d{3})+$)/g, n.group) : int) + (frac ? n.point + frac : '')
}
// Der eine Textknoten mit genau einer Zahl, nicht an Buchstaben („24/7“, „30–45“, „Q3“ zählen nicht hoch)
function numberNode(el: HTMLElement) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const hits: { node: Text; m: RegExpMatchArray[] }[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text, m = [...node.data.matchAll(/\d+(?:[.,]\d+)*/g)]
    if (m.length) hits.push({ node, m })
  }
  if (hits.length !== 1 || hits[0].m.length !== 1) return
  const { node } = hits[0], at = hits[0].m[0].index!, raw = hits[0].m[0][0]
  if (/\p{L}/u.test((node.data[at - 1] ?? '') + (node.data[at + raw.length] ?? ''))) return
  return { node, text: node.data, at, raw }
}

const targetOf = (a: Animation) => (a.effect as KeyframeEffect | null)?.target as HTMLElement | null | undefined
// Lage von el in px innerhalb von root ohne Transforms (Aufbau-Animationen skalieren den Container anfangs)
function offsetIn(el: HTMLElement, root: HTMLElement) {
  let x = 0, y = 0
  for (let n: HTMLElement | null = el; n && n !== root; n = n.offsetParent as HTMLElement | null) (x += n.offsetLeft), (y += n.offsetTop)
  return { x, y }
}
// Kamera auf box: Vergrößerung so, dass die Box ganz sichtbar bleibt, Ausschnitt um ihre Mitte, an den Folienrand geklemmt
function camera(b?: Box): Keyframe {
  if (!b) return { scale: '1', translate: '0% 0%' }
  const s = Math.min(8, Math.max(1, Math.min(1 / b[2], 1 / b[3]))) // Box ≈ 0 → höchstens 8×
  const at = (p: number, len: number) => Math.min(1 - 1 / s, Math.max(0, p + len / 2 - 0.5 / s)) // linke/obere Kante des Ausschnitts
  return { scale: `${s}`, translate: `${-at(b[0], b[2]) * s * 100}% ${-at(b[1], b[3]) * s * 100}%` }
}
const videoSpan = (v: HTMLVideoElement) => ({ from: Number(v.dataset.from) || 0, to: v.dataset.to ? Number(v.dataset.to) : Infinity })

export function filmPrepare(root: HTMLElement, deck: Deck, index: number): FilmScene {
  const slide = deck.slides[index]
  const preset = buildOf(deck, index)
  root.querySelectorAll<HTMLElement>('[data-anim="typewriter"]').forEach((el) => el.querySelector('.dw-part') || splitLetters(el))
  const words = root.innerText.split(/\s+/).filter(Boolean).length
  const steps = prepare(root, preset, 'click', new Set(), slide.items)
  const add = (k: number, a: Animation) => {
    while (steps.length <= k) steps.push([]) // Takte nur für Kamera oder Mauszeiger
    a.pause()
    steps[k].push(a)
  }
  const styles = new Map<HTMLElement, string>() // eigene Inline-Stile, dispose stellt sie wieder her
  const style = (el: HTMLElement, css: Partial<CSSStyleDeclaration>) => { if (!styles.has(el)) styles.set(el, el.style.cssText); Object.assign(el.style, css) }
  const extras: HTMLElement[] = []

  // Zähler: läuft mit der Aufbau-Animation der Zahl (sonst 1,2 s ab Takt 0). Träger ist eine wirkungslose Animation, deren
  // Fortschritt seek in den Text schreibt; so gilt dieselbe Zeitachse wie für alles andere.
  const counters = [...root.querySelectorAll<HTMLElement>('.bign-value, .kpis .kpi-value')].flatMap((el) => {
    const hit = numberNode(el)
    if (!hit) return []
    const touches = (a: Animation) => { const t = targetOf(a); return !!t && t !== root && (t === el || el.contains(t) || t.contains(el)) }
    const k = steps.findIndex((s) => s.some(touches))
    const own = k < 0 ? [] : steps[k].filter(touches)
    const start = own.length ? Math.min(...own.map((a) => Number(a.effect!.getTiming().delay ?? 0))) : 0
    const end = own.length ? Math.max(...own.map((a) => Number(a.effect!.getComputedTiming().endTime))) : COUNT_MS
    const carrier = el.animate([], { duration: Math.max(1, end - start), delay: start, easing: 'ease-out', fill: 'both' })
    add(Math.max(0, k), carrier)
    return [{ ...hit, num: parseNum(hit.raw), carrier }]
  })

  // Mauszeiger: Fahrt je Ziel ab Beginn seines Takts, Klick-Welle danach; zoom fährt die Kamera mit und vergrößert um den Zielpunkt
  const shots = new Map<number, { box?: Box; ms: number }>() // Kamera je Takt
  for (const cur of root.querySelectorAll<HTMLElement>('.dw-cursor[data-moves]')) {
    const box = cur.offsetParent as HTMLElement | null
    if (!box) continue
    const o = offsetIn(box, root)
    let zoomed = false
    for (const m of (JSON.parse(cur.dataset.moves!) as CursorMove[]).sort((a, b) => a.step - b.step)) {
      const at = { left: `${m.x * 100}%`, top: `${m.y * 100}%` }, ms = m.step > 0 ? CURSOR_MS : 0
      // ab Takt 1 ohne Startwert: die Fahrt beginnt dort, wo das vorige Ziel den Zeiger gelassen hat
      add(m.step, cur.animate(m.step > 0 ? [at] : [at, at], { duration: ms, easing: SOFT, fill: m.step > 0 ? 'forwards' : 'both' }))
      if (m.click) {
        const wave = document.createElement('span')
        cur.before(wave) // unter dem Zeiger
        wave.style.cssText = `position:absolute;left:${at.left};top:${at.top};width:48px;height:48px;margin:-24px 0 0 -24px;border-radius:50%;border:3px solid var(--accent);opacity:0;pointer-events:none`
        extras.push(wave)
        add(m.step, wave.animate([{ opacity: 0.9, scale: '0.3' }, { opacity: 0, scale: '1.6' }], { duration: RIPPLE_MS, delay: ms, easing: 'ease-out' }))
      }
      if (m.zoom && m.zoom > 1) {
        const qx = (o.x + m.x * box.offsetWidth) / root.offsetWidth, qy = (o.y + m.y * box.offsetHeight) / root.offsetHeight, z = m.zoom
        shots.set(m.step, { box: [qx * (1 - 1 / z), qy * (1 - 1 / z), 1 / z, 1 / z], ms }) // Zielpunkt bleibt beim Zoomen stehen
        zoomed = true
      } else if (zoomed) {
        shots.set(m.step, { ms })
        zoomed = false
      }
    }
  }
  for (const c of slide.camera ?? []) shots.set(c.step, { box: c.box, ms: CAMERA_MS }) // slide.camera gewinnt im selben Takt
  if (shots.size) {
    style(root, { transformOrigin: '0 0' })
    let from = camera()
    for (const [step, c] of [...shots].sort((a, b) => a[0] - b[0])) {
      const to = camera(c.box)
      add(step, root.animate([from, to], { duration: c.ms, easing: SOFT, fill: 'forwards' })) // forwards: vor dem Takt gilt die vorige Fahrt
      from = to
    }
  }

  const videos = [...root.querySelectorAll('video')], broken = new Set<HTMLVideoElement>()
  videos.forEach((v) => v.pause())
  const zooms = [...root.querySelectorAll<HTMLElement>('[data-zooms]')].map((el) => {
    style(el, { transformOrigin: '0 0' })
    return { el, zooms: JSON.parse(el.dataset.zooms!) as ScreenZoom[], video: el.querySelector('video') }
  })
  const inSteps = new Set(steps.flat())
  const others = root.getAnimations({ subtree: true }).filter((a) => !inSteps.has(a)) // Atmen, Foto-Zoom, CSS-Animationen
  others.forEach((a) => a.pause())

  const end = (as: Animation[]) => Math.max(0, ...as.map((a) => Number(a.effect?.getComputedTiming().endTime ?? 0))) / 1000
  const scene = { steps: steps.map(end), endless: preset === 'photo' || videos.length > 0 || !!root.querySelector('[data-anim="breathe"]'), words }
  let beats = sceneTimeline({ ...scene, lead: 0 }).beats // bis setBeats: Zeitplan ohne Stimme
  return {
    ...scene,
    setBeats: (b) => void (beats = b),
    async seek(t) {
      steps.forEach((as, k) => as.forEach((a) => (a.currentTime = (t - (beats[k] ?? 1e6)) * 1000))) // negativ = Takt noch nicht begonnen
      others.forEach((a) => (a.currentTime = t * 1000))
      for (const c of counters) {
        const p = c.carrier.effect?.getComputedTiming().progress ?? 0
        c.node.data = c.text.slice(0, c.at) + formatNum(c.num.value * p, c.num) + c.text.slice(c.at + c.raw.length)
      }
      await Promise.all(videos.map((v) => {
        // defekt oder nicht ladbar: seeked käme nie, jeder Frame wartete sonst SEEK_TIMEOUT
        if (v.error || v.readyState === 0) return void (broken.has(v) || (broken.add(v), console.warn(`[film] Video lädt nicht, bleibt stehen: ${v.currentSrc || v.src}`)))
        const { from, to } = videoSpan(v), at = Math.min(from + t, to, v.duration || Infinity) // am Ende steht to
        if (Math.abs(v.currentTime - at) < 1e-3) return
        return new Promise<void>((done) => {
          const timer = setTimeout(finish, SEEK_TIMEOUT)
          function finish() { clearTimeout(timer); v.removeEventListener('seeked', finish); done() }
          v.addEventListener('seeked', finish)
          v.currentTime = at
        })
      }))
      for (const z of zooms) {
        const { from, to } = z.video ? videoSpan(z.video) : { from: 0, to: Infinity }
        const { s, x, y } = zoomAt(z.zooms, Math.min(from + t, to)) // Zoom-Zeiten in Videosekunden
        Object.assign(z.el.style, { scale: `${s}`, translate: `${(0.5 - x * s) * 100}% ${(0.5 - y * s) * 100}%` })
      }
    },
    dispose() {
      root.getAnimations({ subtree: true }).forEach((a) => a.cancel())
      counters.forEach((c) => (c.node.data = c.text))
      extras.forEach((e) => e.remove())
      styles.forEach((css, el) => (el.style.cssText = css))
    },
  }
}
