// Canvas: Folie in der Mitte (eingepasst oder gezoomt). Freie Elemente wie in Canva: klicken, ziehen, an Kanten und
// Mitten einrasten, skalieren, drehen, Mehrfachauswahl (Umschalt oder Rahmen aufziehen), Doppelklick bearbeitet Text,
// Rechtsklick öffnet das Kontextmenü, Dateien per Drag & Drop. Layout-Elemente anklicken → KI-Leiste.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPE } from 'react'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { sizeOf, type Box, type Deck, type Item, type Measured } from '../../shared/deck'
import { newImage, newMedia } from '../../shared/items'
import { videoPoster } from './media'
import { SlideView } from '../slide'
import type { Target } from './AskBar'
import { assetOf, clip, cloneItems, coverCrop, geoOf, groupItems, imageRatio, isGroup, removeItems, reorder, ungroupItems, withGroups, type Geo, type Order } from './itemOps'

interface Props {
  deck: Deck | null
  index: number
  busy: boolean
  sel: string[]
  onSel: (ids: string[]) => void
  onItems: (fn: (items: Item[]) => Item[], tag?: string) => void
  onEdit: (slot: string, text: string) => void
  onTarget: (t: Target | null) => void // gewähltes Element als Bezug für die KI-Leiste
}

const SNAP = 6 // Einrasten in Bildschirm-px
const clampZoom = (z: number) => Math.min(3, Math.max(0.25, z))
const SLOT_NAMES: Record<string, string> = {
  title: 'Titel', subtitle: 'Untertitel', eyebrow: 'Dachzeile', text: 'Text', items: 'Liste', value: 'Wert', label: 'Beschriftung',
  chart: 'Diagramm', image: 'Bild', quote: 'Zitat', author: 'Autor', delta: 'Veränderung', note: 'Hinweis', takeaway: 'Kernaussage',
}
const KIND_NAMES: Record<Item['kind'], string> = { text: 'Text', shape: 'Form', image: 'Bild', icon: 'Icon', chart: 'Diagramm', video: 'Video', audio: 'Audio', qr: 'QR-Code', graphic: 'Grafik' }
// „kpis.1.value“ → „kpis 2 · Wert“
const slotName = (slot: string) => slot.split('.').map((p) => (/^\d+$/.test(p) ? String(+p + 1) : SLOT_NAMES[p] ?? p)).join(' ').replace(/ (?=\D)/g, ' · ')
const tf = (rot: number, flip?: boolean) => [rot && `rotate(${rot}deg)`, flip && 'scaleX(-1)'].filter(Boolean).join(' ')
const rotV = (x: number, y: number, deg: number) => {
  const r = (deg * Math.PI) / 180
  return { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) }
}
const HANDLES: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]

type Drag =
  | { kind: 'move'; ids: string[]; start: Map<string, Geo>; x0: number; y0: number; moved: boolean; click?: string }
  | { kind: 'resize'; id: string; g: Geo; hx: number; hy: number; x0: number; y0: number; size?: number }
  | { kind: 'rotate'; id: string; g: Geo; cx: number; cy: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number; target: EventTarget; add: boolean }
  | { kind: 'gresize'; start: Map<string, Geo>; bb: Box; hx: number; hy: number; x0: number; y0: number } // Mehrfachauswahl/Gruppe skalieren
  | { kind: 'crop-pan'; x0: number; y0: number; full: Box }
  | { kind: 'crop-size'; hx: number; hy: number; x0: number; y0: number; box: Box }

export const Stage = memo(function Stage({ deck, index, busy, sel, onSel, onItems, onEdit, onTarget }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [zoom, setZoom] = useState<number | null>(null) // null = einpassen
  const [fit, setFit] = useState<{ index: number; fit: Measured['fit'] } | null>(null)
  const [slot, setSlot] = useState<string | null>(null)
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [geos, setGeos] = useState<Record<string, Geo>>({})
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] })
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<Drag | null>(null)
  const live = useRef<Record<string, Geo>>({}) // Geometrie während des Ziehens (State ist beim Loslassen evtl. noch nicht gerendert)
  const setLive = (g: Record<string, Geo>) => { live.current = g; setGeos(g) }
  // Zuschnitt-Modus: full = ganzes Bild, box = sichtbarer Ausschnitt (Folien-px)
  const [crop, setCrop] = useState<{ id: string; src: string; full: Box; box: Box } | null>(null)

  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(box.current!)
    return () => ro.disconnect()
  }, [])
  const { w: W, h: H } = sizeOf(deck) // Foliengröße (Format), 100 % Zoom
  const fitW = Math.floor(Math.min(size.w, (size.h * W) / H))
  const w = zoom ? Math.round(W * zoom) : fitW
  const k = w / W
  const fitRef = useRef(fitW)
  fitRef.current = fitW / W // eingepasster Zoom (für den Mausrad-Listener)

  // Strg/⌘ + Mausrad zoomt (nativer Listener, weil React-Wheel-Events passiv sind)
  useEffect(() => {
    const el = box.current!
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) => clampZoom((z ?? fitRef.current) * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const slide = deck?.slides[index]
  const items = slide?.items ?? []
  const byId = (id: string) => items.find((it) => it.id === id)

  useEffect(() => { setSlot(null); setEditing(null); setMenu(null); setCrop(null) }, [index])

  const itemEl = (id: string) => canvas.current?.querySelector<HTMLElement>(`.stage-slide [data-item="${CSS.escape(id)}"]`) ?? null
  // Auswahlrahmen folgen der echten Box im DOM (Text-Höhe ergibt sich aus dem Inhalt)
  useLayoutEffect(() => {
    const next: Record<string, Geo> = {}
    for (const id of sel) { const it = byId(id); if (it && itemEl(id)) next[id] = geoOf(it) }
    setGeos(next)
  }, [sel, deck, index, w, fit])

  // Rahmen des gewählten Layout-Elements (KI-Leiste); Element weg (KI hat umgebaut) → Auswahl weg
  useLayoutEffect(() => {
    if (!slot || !canvas.current) return setRect(null)
    const el = canvas.current.querySelector(`.stage-slide [data-slot="${CSS.escape(slot)}"]`)
    if (!el) return setSlot(null)
    const r = el.getBoundingClientRect()
    const c = canvas.current.getBoundingClientRect()
    setRect({ left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height })
  }, [slot, deck, index, w, fit])

  // Text bearbeiten: Fokus setzen und alles markieren
  useLayoutEffect(() => {
    const el = editing && itemEl(editing)
    if (!el) return
    el.focus()
    getSelection()?.selectAllChildren(el)
  }, [editing])

  const edit = useCallback((s: string, text: string) => {
    if (s.startsWith('items.')) setEditing(null)
    onEdit(s, text)
  }, [onEdit])

  const toSlide = (cx: number, cy: number) => {
    const r = canvas.current!.getBoundingClientRect()
    return { x: (cx - r.left) / k, y: (cy - r.top) / k }
  }

  // ---------- Zeiger: verschieben, skalieren, drehen, Rahmen aufziehen ----------

  const apply = (id: string, g: Geo, fontSize?: number) => {
    const el = itemEl(id), it = byId(id)
    if (!el || !it) return
    Object.assign(el.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, transform: tf(g.rot, it.kind === 'image' && it.flipX) })
    if (it.kind !== 'text') el.style.height = `${g.h}px`
    if (fontSize) el.style.fontSize = `${fontSize}px`
  }

  // Einrasten an Folienrand/-mitte und an Kanten/Mitten der anderen Elemente
  const snap = (b: { x: number; y: number; w: number; h: number }, skip: string[]) => {
    const others = items.filter((it) => !skip.includes(it.id)).map(geoOf)
    const xs = [0, W / 2, W, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])]
    const ys = [0, H / 2, H, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])]
    const best = (edges: number[], cands: number[]) => {
      let d = Infinity, line: number | null = null
      for (const e of edges) for (const c of cands) if (Math.abs(c - e) < Math.abs(d) && Math.abs(c - e) <= SNAP / k) (d = c - e), (line = c)
      return line === null ? { d: 0, line: [] } : { d, line: [line] }
    }
    const sx = best([b.x, b.x + b.w / 2, b.x + b.w], xs), sy = best([b.y, b.y + b.h / 2, b.y + b.h], ys)
    return { dx: sx.d, dy: sy.d, guides: { x: sx.line, y: sy.line } }
  }

  const onDown = (e: RPE<HTMLDivElement>) => {
    if (e.button !== 0 || busy) return
    setMenu(null)
    const target = e.target as HTMLElement
    const id = target.closest<HTMLElement>('[data-item]')?.dataset.item
    if (id && id === editing) return // Text wird bearbeitet: Cursor setzen, nicht ziehen
    if (editing) (document.activeElement as HTMLElement | null)?.blur()
    if (crop) return finishCrop(true) // Klick neben den Zuschnitt übernimmt ihn
    const p = toSlide(e.clientX, e.clientY)
    if (id) {
      e.preventDefault()
      const it = byId(id)
      let ids = sel
      const unit = withGroups(items, [id]) // Gruppen werden als Ganzes gewählt
      if (e.shiftKey) ids = sel.includes(id) ? sel.filter((x) => !unit.includes(x)) : [...new Set([...sel, ...unit])]
      else if (!sel.includes(id)) ids = unit
      onSel(ids)
      setSlot(null)
      if (it?.locked || !ids.includes(id)) return
      const start = new Map(ids.flatMap((x) => { const i = byId(x); return i && !i.locked ? [[x, geoOf(i)] as const] : [] }))
      drag.current = { kind: 'move', ids: [...start.keys()], start, x0: p.x, y0: p.y, moved: false, click: !e.shiftKey && sel.length > 1 ? id : undefined }
    } else if (target.closest('[contenteditable]')) return // Layout-Text: Cursor setzen und markieren wie gewohnt
    else drag.current = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, target, add: e.shiftKey }
    canvas.current!.setPointerCapture(e.pointerId)
  }

  const startGroupResize = (e: RPE, hx: number, hy: number) => {
    e.stopPropagation()
    e.preventDefault()
    const start = new Map(sel.flatMap((x) => { const i = byId(x); return i && !i.locked ? [[x, geoOf(i)] as const] : [] }))
    const all = [...start.values()]
    const x = Math.min(...all.map((g) => g.x)), y = Math.min(...all.map((g) => g.y))
    const bb = { x, y, w: Math.max(...all.map((g) => g.x + g.w)) - x, h: Math.max(...all.map((g) => g.y + g.h)) - y }
    const p = toSlide(e.clientX, e.clientY)
    drag.current = { kind: 'gresize', start, bb, hx, hy, x0: p.x, y0: p.y }
    canvas.current!.setPointerCapture(e.pointerId)
  }
  const startCropDrag = (e: RPE, hx = 0, hy = 0) => {
    e.stopPropagation()
    e.preventDefault()
    if (!crop) return
    const p = toSlide(e.clientX, e.clientY)
    drag.current = hx || hy ? { kind: 'crop-size', hx, hy, x0: p.x, y0: p.y, box: crop.box } : { kind: 'crop-pan', x0: p.x, y0: p.y, full: crop.full }
    canvas.current!.setPointerCapture(e.pointerId)
  }

  const startHandle = (e: RPE, kind: 'resize' | 'rotate', hx = 0, hy = 0) => {
    e.stopPropagation()
    e.preventDefault()
    const id = sel[0], it = byId(id)
    if (!it || it.locked) return
    const g = geoOf(it)
    const p = toSlide(e.clientX, e.clientY)
    drag.current = kind === 'resize'
      ? { kind, id, g, hx, hy, x0: p.x, y0: p.y, size: it.kind === 'text' ? it.size ?? 32 : undefined }
      : { kind, id, g, cx: g.x + g.w / 2, cy: g.y + g.h / 2 }
    canvas.current!.setPointerCapture(e.pointerId)
  }

  const onMove = (e: RPE<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const p = toSlide(e.clientX, e.clientY)
    if (d.kind === 'marquee') {
      d.x1 = p.x, d.y1 = p.y
      if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) * k > 4) setMarquee({ x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) })
      return
    }
    if (d.kind === 'crop-pan') { // Bild unter dem Ausschnitt verschieben, Ausschnitt bleibt innerhalb
      if (!crop) return
      const b = crop.box
      const x = Math.min(b.x, Math.max(b.x + b.w - d.full.w, d.full.x + p.x - d.x0))
      const y = Math.min(b.y, Math.max(b.y + b.h - d.full.h, d.full.y + p.y - d.y0))
      return setCrop({ ...crop, full: { ...d.full, x, y } })
    }
    if (d.kind === 'crop-size') { // Ausschnitt an den Griffen ändern, höchstens bis zum Bildrand
      if (!crop) return
      const f = crop.full, b0 = d.box, dx = p.x - d.x0, dy = p.y - d.y0
      let l = b0.x, t = b0.y, r = b0.x + b0.w, btm = b0.y + b0.h
      if (d.hx < 0) l = Math.min(r - 16, Math.max(f.x, l + dx))
      if (d.hx > 0) r = Math.max(l + 16, Math.min(f.x + f.w, r + dx))
      if (d.hy < 0) t = Math.min(btm - 16, Math.max(f.y, t + dy))
      if (d.hy > 0) btm = Math.max(t + 16, Math.min(f.y + f.h, btm + dy))
      return setCrop({ ...crop, box: { x: l, y: t, w: r - l, h: btm - t } })
    }
    if (d.kind === 'gresize') { // Auswahl gemeinsam skalieren; Ecken proportional (Umschalt: frei)
      const { bb, hx, hy } = d
      let fx = Math.max(0.05, (bb.w + hx * (p.x - d.x0)) / bb.w), fy = Math.max(0.05, (bb.h + hy * (p.y - d.y0)) / bb.h)
      if (!hx) fx = 1
      if (!hy) fy = 1
      const corner = hx !== 0 && hy !== 0
      if (corner && !e.shiftKey) fx = fy = Math.max(fx, fy)
      const ox = hx < 0 ? bb.x + bb.w * (1 - fx) : bb.x, oy = hy < 0 ? bb.y + bb.h * (1 - fy) : bb.y
      const next: Record<string, Geo> = {}
      for (const [id, g] of d.start) {
        next[id] = { x: Math.round(ox + (g.x - bb.x) * fx), y: Math.round(oy + (g.y - bb.y) * fy), w: Math.round(g.w * fx), h: Math.round(g.h * fy), rot: g.rot }
        const it = byId(id)
        apply(id, next[id], it?.kind === 'text' && fx === fy ? Math.max(6, Math.round((it.size ?? 32) * fx)) : undefined)
      }
      return setLive(next)
    }
    if (d.kind === 'move') {
      let dx = p.x - d.x0, dy = p.y - d.y0
      if (!d.moved && Math.hypot(dx, dy) * k < 3) return
      d.moved = true
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0) // Umschalt: nur waagrecht oder senkrecht
      const all = [...d.start.values()]
      const bx = Math.min(...all.map((g) => g.x)) + dx, by = Math.min(...all.map((g) => g.y)) + dy
      const bb = { x: bx, y: by, w: Math.max(...all.map((g) => g.x + g.w)) + dx - bx, h: Math.max(...all.map((g) => g.y + g.h)) + dy - by }
      const s = e.altKey ? { dx: 0, dy: 0, guides: { x: [], y: [] } } : snap(bb, d.ids) // Alt: ohne Einrasten
      dx += s.dx, dy += s.dy
      setGuides(s.guides)
      const next: Record<string, Geo> = {}
      for (const [id, g] of d.start) { next[id] = { ...g, x: Math.round(g.x + dx), y: Math.round(g.y + dy) }; apply(id, next[id]) }
      setLive(next)
    } else if (d.kind === 'resize') {
      const { g, hx, hy } = d
      const it = byId(d.id)!
      const l = rotV(p.x - d.x0, p.y - d.y0, -g.rot)
      let nw = Math.max(8, g.w + hx * l.x), nh = Math.max(8, g.h + hy * l.y)
      const corner = hx !== 0 && hy !== 0
      if (corner && (e.shiftKey !== (it.kind !== 'shape'))) { // Ecken: Bilder, Icons, Text proportional (Umschalt kehrt um)
        const f = Math.max(nw / g.w, nh / g.h)
        nw = g.w * f, nh = g.h * f
      }
      const c = rotV((hx * (nw - g.w)) / 2, (hy * (nh - g.h)) / 2, g.rot)
      const ng = { x: Math.round(g.x + g.w / 2 + c.x - nw / 2), y: Math.round(g.y + g.h / 2 + c.y - nh / 2), w: Math.round(nw), h: Math.round(nh), rot: g.rot }
      const font = d.size && corner ? Math.max(6, Math.round(d.size * (nw / g.w))) : undefined
      apply(d.id, ng, font)
      setLive({ [d.id]: ng })
    } else {
      let a = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI + 90
      a = e.shiftKey ? Math.round(a / 15) * 15 : Math.abs(a - Math.round(a / 90) * 90) < 4 ? Math.round(a / 90) * 90 : Math.round(a)
      a = ((a + 540) % 360) - 180
      const ng = { ...d.g, rot: a }
      apply(d.id, ng)
      setLive({ [d.id]: ng })
    }
  }

  const onUp = () => {
    const d = drag.current
    drag.current = null
    setGuides({ x: [], y: [] })
    if (!d || d.kind === 'crop-pan' || d.kind === 'crop-size') return
    if (d.kind === 'marquee') {
      setMarquee(null)
      const r = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) }
      if (r.w * k < 4 && r.h * k < 4) { // einfacher Klick auf Layout oder leere Fläche
        onSel([])
        const el = (d.target as HTMLElement).closest<HTMLElement>('.stage-slide [data-slot]:not([data-slot^="_"])')
        setSlot(el?.dataset.slot ?? null)
        return
      }
      const hit = items.filter((it) => !it.locked).filter((it) => {
        const g = geoOf(it)
        return g.x < r.x + r.w && g.x + g.w > r.x && g.y < r.y + r.h && g.y + g.h > r.y
      }).map((it) => it.id)
      const unit = withGroups(items, hit)
      onSel(d.add ? [...new Set([...sel, ...unit])] : unit)
      setSlot(null)
      return
    }
    if (d.kind === 'move' && !d.moved) return d.click && onSel([d.click])
    const next = live.current
    onItems((list) => list.map((it) => {
      const g = next[it.id]
      if (!g) return it
      const out: Item = { ...it, x: g.x, y: g.y, w: g.w, h: it.kind === 'text' ? it.h : g.h, rot: g.rot || undefined }
      if (d.kind === 'resize' && d.size && d.hx && d.hy) out.size = Math.max(6, Math.round(d.size * (g.w / d.g.w)))
      if (d.kind === 'gresize' && it.kind === 'text' && d.hx && d.hy) out.size = Math.max(6, Math.round((it.size ?? 32) * (g.w / d.start.get(it.id)!.w))) // Ecke: Schrift mit
      return out
    }))
  }

  // Element unter dem Zeiger (Klicks nach Pointer-Capture landen sonst beim Canvas)
  const itemAt = (x: number, y: number) => document.elementsFromPoint(x, y).map((el) => el.closest<HTMLElement>('.stage-slide [data-item]')).find(Boolean)?.dataset.item
  const onDbl = (e: React.MouseEvent) => {
    const id = itemAt(e.clientX, e.clientY)
    const it = id && byId(id)
    if (!it || it.locked || busy) return
    if (it.group && sel.length > 1) return onSel([it.id]) // in die Gruppe hinein: einzelnes Element wählen
    if (it.kind === 'text') { onSel([it.id]); setEditing(it.id) }
    else if (it.kind === 'image') startCrop(it.id)
  }

  // ---------- Zuschnitt ----------
  const startCrop = async (id: string) => {
    const it = byId(id)
    if (!it || it.kind !== 'image' || !it.src || it.rot) return // ponytail: Zuschnitt nur ungedreht; gedreht bräuchte lokale Koordinaten
    const c = it.crop ?? coverCrop(await imageRatio(it.src), it.w / it.h)
    const fw = it.w / c.w, fh = it.h / c.h
    onSel([id])
    setCrop({ id, src: it.src, box: { x: it.x, y: it.y, w: it.w, h: it.h }, full: { x: it.x - c.x * fw, y: it.y - c.y * fh, w: fw, h: fh } })
  }
  const finishCrop = (keep: boolean) => {
    const c = crop
    setCrop(null)
    if (!c || !keep) return
    const { box: b, full: f } = c
    const r = (v: number) => Math.round(v * 10000) / 10000
    onItems((l) => l.map((it) => (it.id === c.id
      ? { ...it, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h), crop: { x: r((b.x - f.x) / f.w), y: r((b.y - f.y) / f.h), w: r(b.w / f.w), h: r(b.h / f.h) } }
      : it)))
  }
  // Inspector-Knopf „Zuschneiden“
  useEffect(() => {
    const on = (e: Event) => void startCrop((e as CustomEvent<string>).detail)
    addEventListener('dw:crop', on)
    return () => removeEventListener('dw:crop', on)
  })

  // ---------- Tastatur, Zwischenablage, Kontextmenü ----------

  const add = useCallback((list: Item[]) => { onItems((all) => [...all, ...list]); onSel(list.map((it) => it.id)) }, [onItems, onSel])
  const act = useCallback((what: 'copy' | 'cut' | 'paste' | 'duplicate' | 'delete' | 'lock' | 'group' | 'ungroup' | Order) => {
    const chosen = items.filter((it) => sel.includes(it.id))
    setMenu(null)
    switch (what) {
      case 'copy': clip.items = structuredClone(chosen); break
      case 'cut': clip.items = structuredClone(chosen); onItems((l) => removeItems(l, sel)); onSel([]); break
      case 'paste':
        if (clip.items.length) { add(cloneItems(clip.items)); clip.items = cloneItems(clip.items, 0) } // nächstes Einfügen wieder versetzt
        else window.api.pasteImage().then(async (src) => src && add([newImage(src, await imageRatio(src))]))
        break
      case 'duplicate': add(cloneItems(chosen)); break
      case 'group': onItems((l) => groupItems(l, sel)); break
      case 'ungroup': onItems((l) => ungroupItems(l, sel)); break
      case 'delete': onItems((l) => removeItems(l, sel)); onSel([]); break
      case 'lock': { const on = !chosen.every((it) => it.locked); onItems((l) => l.map((it) => (sel.includes(it.id) ? { ...it, locked: on || undefined } : it))); break }
      default: onItems((l) => reorder(l, sel, what))
    }
  }, [items, sel, onItems, onSel, add])

  useEffect(() => {
    if (!slide) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('.kit-select, [role=listbox], dialog') || busy) return // Dropdowns und Dialoge bedienen ihre Tasten selbst
      const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase()
      if (crop) { // im Zuschnitt: Enter übernimmt, Esc verwirft, sonst nichts
        if (e.key === 'Enter' || e.key === 'Escape') finishCrop(e.key === 'Enter')
        e.preventDefault()
        e.stopImmediatePropagation()
        return
      }
      const has = sel.length > 0
      const step = e.shiftKey ? 10 : 1
      const nudge: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      if (has && nudge[e.key] && !mod) {
        const [dx, dy] = nudge[e.key]
        onItems((l) => l.map((it) => (sel.includes(it.id) && !it.locked ? { ...it, x: it.x + dx, y: it.y + dy } : it)), `nudge-${sel.join()}`)
      } else if (has && (e.key === 'Delete' || e.key === 'Backspace')) act('delete')
      else if (has && e.key === 'Escape') onSel([])
      else if (has && e.key === 'Enter' && sel.length === 1 && byId(sel[0])?.kind === 'text') setEditing(sel[0])
      else if (mod && key === 'a') onSel(items.filter((it) => !it.locked).map((it) => it.id))
      else if (mod && key === 'v') act('paste')
      else if (has && mod && key === 'c') act('copy')
      else if (has && mod && key === 'x') act('cut')
      else if (has && mod && key === 'd') act('duplicate')
      else if (has && mod && key === 'l') act('lock')
      else if (has && mod && key === 'g') act(e.shiftKey ? 'ungroup' : 'group')
      else if (has && mod && (e.key === ']' || e.key === '}')) act(e.shiftKey ? 'front' : 'forward')
      else if (has && mod && (e.key === '[' || e.key === '{')) act(e.shiftKey ? 'back' : 'backward')
      else return
      e.preventDefault()
      e.stopImmediatePropagation() // App soll Pfeiltasten nicht zum Blättern nutzen
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [slide, sel, items, busy, act, onItems, onSel, crop]) // eslint-disable-line react-hooks/exhaustive-deps

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault()
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-item]')?.dataset.item
    if (id && !sel.includes(id)) onSel([id])
    const r = canvas.current!.getBoundingClientRect()
    // im sichtbaren Bereich halten (Menü ca. 240 × 340 px)
    setMenu({ x: Math.max(0, Math.min(e.clientX - r.left, r.width - 240)), y: Math.max(0, Math.min(e.clientY - r.top, r.height - 340)) })
  }

  // Dateien aus dem Dateimanager oder Elemente aus dem Seitenpanel fallen lassen
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    if (busy || !slide) return
    const p = toSlide(e.clientX, e.clientY)
    const center = (it: Item): Item => ({ ...it, x: Math.round(p.x - it.w / 2), y: Math.round(p.y - it.h / 2) })
    const json = e.dataTransfer.getData('application/x-deckwerk-item')
    if (json) return add([center(JSON.parse(json))])
    const media = [...e.dataTransfer.files].filter((f) => /^(video|audio)\//.test(f.type))
    for (const f of media) {
      const src = assetOf(window.api.pathOf(f))
      const kind = f.type.startsWith('video/') ? 'video' : 'audio'
      const poster = kind === 'video' ? await videoPoster(src).catch(() => undefined) : undefined
      add([center(newMedia(kind, src, poster?.ratio, poster?.src))])
    }
    const imgs = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
    const made = await Promise.all(imgs.map(async (f, i) => {
      const src = assetOf(window.api.pathOf(f))
      const it = center(newImage(src, await imageRatio(src)))
      return { ...it, x: it.x + i * 24, y: it.y + i * 24 }
    }))
    if (made.length) add(made)
  }

  // Bezug für die KI-Leiste: gewähltes Layout-Element oder einzelnes freies Element
  const target = slot ?? (sel.length === 1 ? `items.${sel[0]}` : null)
  useEffect(() => {
    if (!slide || !target) return onTarget(null)
    const it = target.startsWith('items.') ? byId(target.slice(6)) : undefined
    const el = it ? itemEl(it.id) : canvas.current?.querySelector<HTMLElement>(`.stage-slide [data-slot="${CSS.escape(target)}"]`)
    const now = el ? el.innerText.trim().replace(/\s+/g, ' ').slice(0, 160) : ''
    const r = el?.getBoundingClientRect()
    onTarget({
      slot: target,
      rect: r && { left: r.left, top: r.top, width: r.width, height: r.height },
      label: `${it ? KIND_NAMES[it.kind] : slotName(target)} · Folie ${index + 1}`,
      context: it
        ? `Freies Element ${JSON.stringify(it)} auf Folie ${index + 1} (ID „${slide.id}“); ändern per update_slide.items (alle vorhandenen items mit IDs mitgeben)`
        : `Element „${target}“ auf Folie ${index + 1} (ID „${slide.id}“, Layout ${slide.layout})${now ? `, aktueller Inhalt: „${now}“` : ''}`,
    })
  }, [target, index, slide, w]) // eslint-disable-line react-hooks/exhaustive-deps

  const view = useMemo(
    () => deck && <SlideView deck={deck} index={index} width={w} editable={!busy} editing={editing ?? undefined} onEdit={edit} onFit={(f) => setFit({ index, fit: f })} />,
    [deck, index, w, busy, editing, edit],
  )

  const overflow = fit?.index === index && !fit.fit.ok ? fit.fit.overflow : []
  const h = Math.round((w * H) / W)

  return (
    <main className="stage" onKeyDown={(e) => e.key === 'Escape' && (setSlot(null), setMenu(null), (document.activeElement as HTMLElement | null)?.blur())}>
      <div className="stage-box" ref={box} onMouseDown={(e) => { if (!(e.target as HTMLElement).closest('.stage-canvas')) { setSlot(null); setMenu(null); onSel([]) } }}>
        {!deck?.slides.length ? (
          <div className="stage-empty">
            {busy ? <><LoaderCircle size={16} className="spin" /> Die KI plant die Storyline …</> : 'Noch keine Folien.'}
          </div>
        ) : (
          w > 0 && (
            <div
              className="stage-canvas" ref={canvas} style={{ width: w, height: h }}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
              onDoubleClick={onDbl} onContextMenu={onContext}
              onDragOver={(e) => e.preventDefault()} onDrop={onDrop}
            >
              <div className={`stage-slide ${busy ? 'busy' : ''}`} onFocus={(e) => {
                const el = (e.target as HTMLElement).closest<HTMLElement>('[data-slot]:not([data-slot^="_"]):not([data-item])')
                if (el) setSlot(el.dataset.slot ?? null)
              }}>
                {view}
              </div>
              {overflow.length > 0 && (
                <style>{overflow.map((o) => `.stage-slide [data-slot="${CSS.escape(o.slot)}"]{outline:2px solid var(--danger);outline-offset:2px}`).join('')}</style>
              )}
              {sel.map((id) => {
                const g = geos[id], it = byId(id)
                if (!g || !it) return null
                const single = sel.length === 1 && !it.locked && !editing && !crop
                const handles = it.kind === 'text' ? HANDLES.filter(([, hy], i) => hy === 0 || i % 2 === 0) : HANDLES
                return (
                  <div key={id} className={`item-sel ${it.locked ? 'locked' : ''} ${sel.length > 1 ? 'member' : ''}`} style={{ left: g.x * k, top: g.y * k, width: g.w * k, height: g.h * k, transform: g.rot ? `rotate(${g.rot}deg)` : undefined }}>
                    {single && handles.map(([hx, hy]) => (
                      <span key={`${hx}${hy}`} className={`item-h ${hx && hy ? 'corner' : hx ? 'side-x' : 'side-y'}`}
                        style={{ left: `${(hx + 1) * 50}%`, top: `${(hy + 1) * 50}%`, cursor: `${[['nwse', 'ns', 'nesw'], ['ew', '', 'ew'], ['nesw', 'ns', 'nwse']][hy + 1][hx + 1]}-resize` }}
                        onPointerDown={(e) => startHandle(e, 'resize', hx, hy)} />
                    ))}
                    {single && it.kind !== 'chart' && <span className="item-rot" title="Drehen (Umschalt: 15°-Schritte)" onPointerDown={(e) => startHandle(e, 'rotate')} />}
                    {single && drag.current?.kind === 'rotate' && <span className="item-badge">{g.rot}°</span>}
                    {single && drag.current?.kind === 'resize' && <span className="item-badge">{g.w} × {it.kind === 'text' ? '…' : g.h}</span>}
                  </div>
                )
              })}
              {(() => { // gemeinsamer Rahmen bei Mehrfachauswahl/Gruppe, mit Griffen zum gemeinsamen Skalieren
                const gs = sel.map((id) => geos[id]).filter(Boolean)
                if (sel.length < 2 || gs.length < 2 || crop || items.some((it) => sel.includes(it.id) && it.locked)) return null
                const x = Math.min(...gs.map((g) => g.x)), y = Math.min(...gs.map((g) => g.y))
                const bw = Math.max(...gs.map((g) => g.x + g.w)) - x, bh = Math.max(...gs.map((g) => g.y + g.h)) - y
                return (
                  <div className={`item-sel multi ${isGroup(items, sel) ? 'group' : ''}`} style={{ left: x * k, top: y * k, width: bw * k, height: bh * k }}>
                    {HANDLES.map(([hx, hy]) => (
                      <span key={`${hx}${hy}`} className={`item-h ${hx && hy ? 'corner' : hx ? 'side-x' : 'side-y'}`}
                        style={{ left: `${(hx + 1) * 50}%`, top: `${(hy + 1) * 50}%`, cursor: `${[['nwse', 'ns', 'nesw'], ['ew', '', 'ew'], ['nesw', 'ns', 'nwse']][hy + 1][hx + 1]}-resize` }}
                        onPointerDown={(e) => startGroupResize(e, hx, hy)} />
                    ))}
                    {isGroup(items, sel) && <span className="item-badge">Gruppe</span>}
                  </div>
                )
              })()}
              {crop && (
                <>
                  <style>{`.stage-slide [data-item="${CSS.escape(crop.id)}"]{visibility:hidden}`}</style>
                  <div className="crop-ghost" style={{ left: crop.full.x * k, top: crop.full.y * k, width: crop.full.w * k, height: crop.full.h * k, backgroundImage: `url("${crop.src}")` }} />
                  <div className="crop-box" onPointerDown={(e) => startCropDrag(e)} style={{
                    left: crop.box.x * k, top: crop.box.y * k, width: crop.box.w * k, height: crop.box.h * k, backgroundImage: `url("${crop.src}")`,
                    backgroundSize: `${crop.full.w * k}px ${crop.full.h * k}px`, backgroundPosition: `${(crop.full.x - crop.box.x) * k}px ${(crop.full.y - crop.box.y) * k}px`,
                  }}>
                    {HANDLES.map(([hx, hy]) => (
                      <span key={`${hx}${hy}`} className={`crop-h ${hx && hy ? 'corner' : hx ? 'side-x' : 'side-y'}`}
                        style={{ left: `${(hx + 1) * 50}%`, top: `${(hy + 1) * 50}%`, cursor: `${[['nwse', 'ns', 'nesw'], ['ew', '', 'ew'], ['nesw', 'ns', 'nwse']][hy + 1][hx + 1]}-resize` }}
                        onPointerDown={(e) => startCropDrag(e, hx, hy)} />
                    ))}
                  </div>
                  <div className="crop-bar" onPointerDown={(e) => e.stopPropagation()} style={{ left: crop.box.x * k, top: Math.min((crop.box.y + crop.box.h) * k + 10, h - 40) }}>
                    <button className="btn primary small" onClick={() => finishCrop(true)}>Fertig <kbd>Enter</kbd></button>
                    <button className="btn small" onClick={() => finishCrop(false)}>Abbrechen</button>
                    <button className="btn small" onClick={() => { setCrop(null); onItems((l) => l.map((it) => (it.id === crop.id ? { ...it, crop: undefined } : it))) }}>Zurücksetzen</button>
                  </div>
                </>
              )}
              {guides.x.map((x) => <div key={`gx${x}`} className="guide v" style={{ left: x * k }} />)}
              {guides.y.map((y) => <div key={`gy${y}`} className="guide h" style={{ top: y * k }} />)}
              {marquee && <div className="marquee" style={{ left: marquee.x * k, top: marquee.y * k, width: marquee.w * k, height: marquee.h * k }} />}
              {rect && slot && (
                <div className="stage-sel" style={rect}><span style={rect.top < 30 ? { top: 4, left: 4 } : undefined}>{slotName(slot)}</span></div>
              )}
              {menu && (
                <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
                  {sel.length > 0 && <>
                    <button onClick={() => act('copy')}>Kopieren <kbd>Strg+C</kbd></button>
                    <button onClick={() => act('cut')}>Ausschneiden <kbd>Strg+X</kbd></button>
                  </>}
                  <button onClick={() => act('paste')}>Einfügen <kbd>Strg+V</kbd></button>
                  {sel.length > 0 && <>
                    <button onClick={() => act('duplicate')}>Duplizieren <kbd>Strg+D</kbd></button>
                    {sel.length > 1 && !isGroup(items, sel) && <button onClick={() => act('group')}>Gruppieren <kbd>Strg+G</kbd></button>}
                    {items.some((it) => sel.includes(it.id) && it.group) && <button onClick={() => act('ungroup')}>Gruppierung aufheben <kbd>Strg+⇧+G</kbd></button>}
                    {sel.length === 1 && byId(sel[0])?.kind === 'image' && <button onClick={() => { setMenu(null); void startCrop(sel[0]) }}>Zuschneiden <kbd>Doppelklick</kbd></button>}
                    <hr />
                    <button onClick={() => act('front')}>Ganz nach vorne <kbd>Strg+⇧+]</kbd></button>
                    <button onClick={() => act('forward')}>Eine Ebene nach vorne <kbd>Strg+]</kbd></button>
                    <button onClick={() => act('backward')}>Eine Ebene nach hinten <kbd>Strg+[</kbd></button>
                    <button onClick={() => act('back')}>Ganz nach hinten <kbd>Strg+⇧+[</kbd></button>
                    <hr />
                    <button onClick={() => act('lock')}>{items.filter((it) => sel.includes(it.id)).every((it) => it.locked) ? 'Entsperren' : 'Sperren'} <kbd>Strg+L</kbd></button>
                    <button className="danger" onClick={() => act('delete')}>Löschen <kbd>Entf</kbd></button>
                  </>}
                </div>
              )}
            </div>
          )
        )}
      </div>
      {overflow.length > 0 && (
        <div className="stage-warn">
          <TriangleAlert size={14} /> Text passt nicht ({overflow.map((o) => slotName(o.slot)).join(', ')}). Kürzen oder Folie teilen.
        </div>
      )}
      {zoom !== null && ( // gezoomt per Strg + Mausrad: eine Pille führt zurück
        <button className="pill zoom-pill material" onClick={() => setZoom(null)} title="Einpassen">{Math.round(k * 100)} % · Einpassen</button>
      )}
    </main>
  )
})
