// Operationen auf freien Elementen (Slide.items), geteilt von Canvas, Inspector und Kontextmenü.
import type { Item } from '../../shared/deck'
import { newId } from '../../shared/items'

export interface Geo { x: number; y: number; w: number; h: number; rot: number }

// Wahre Box aus der Canvas (Text-Höhe ergibt sich aus dem Inhalt); ohne Canvas die gespeicherten Werte
export function geoOf(it: Item): Geo {
  const el = document.querySelector<HTMLElement>(`.stage-slide [data-item="${CSS.escape(it.id)}"]`)
  return el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, rot: it.rot ?? 0 } : { x: it.x, y: it.y, w: it.w, h: it.h, rot: it.rot ?? 0 }
}

export const removeItems = (items: Item[], ids: string[]) => items.filter((it) => !ids.includes(it.id) || it.locked)

// Kopien bekommen neue IDs, Gruppen werden zu neuen Gruppen (nicht Teil des Originals)
export const cloneItems = (src: Item[], offset = 20): Item[] => {
  const groups = new Map<string, string>()
  return src.map((it) => ({
    ...structuredClone(it), id: newId(), x: it.x + offset, y: it.y + offset, locked: false,
    group: it.group && (groups.get(it.group) ?? groups.set(it.group, newId()).get(it.group)),
  }))
}

// ---------- Gruppen ----------
// Auswahl um alle Mitglieder der berührten Gruppen erweitern
export const withGroups = (items: Item[], ids: string[]) => {
  const gs = new Set(items.filter((it) => ids.includes(it.id) && it.group).map((it) => it.group))
  return items.filter((it) => ids.includes(it.id) || (it.group && gs.has(it.group))).map((it) => it.id)
}
export const groupItems = (items: Item[], ids: string[]) => {
  if (ids.length < 2) return items
  const g = newId()
  return items.map((it) => (ids.includes(it.id) ? { ...it, group: g } : it))
}
export const ungroupItems = (items: Item[], ids: string[]) => items.map((it) => (ids.includes(it.id) && it.group ? { ...it, group: undefined } : it))
// genau eine vollständige Gruppe gewählt?
export const isGroup = (items: Item[], ids: string[]) => {
  const g = items.find((it) => it.id === ids[0])?.group
  return !!g && ids.length > 1 && items.filter((it) => it.group === g).every((it) => ids.includes(it.id)) && ids.every((id) => items.find((it) => it.id === id)?.group === g)
}

// ---------- Zuschnitt ----------
// Ausschnitt, der dem bisherigen „cover, mittig“ entspricht (r = Bild-, R = Boxseitenverhältnis)
export const coverCrop = (r: number, R: number) => (r > R ? { x: (1 - R / r) / 2, y: 0, w: R / r, h: 1 } : { x: 0, y: (1 - r / R) / 2, w: 1, h: r / R })

export type Order = 'forward' | 'backward' | 'front' | 'back'
export function reorder(items: Item[], ids: string[], how: Order): Item[] {
  const sel = items.filter((it) => ids.includes(it.id))
  const rest = items.filter((it) => !ids.includes(it.id))
  if (how === 'front') return [...rest, ...sel]
  if (how === 'back') return [...sel, ...rest]
  // eine Ebene: Auswahl hinter das nächste (bzw. vor das vorige) nicht gewählte Element schieben, fremde Gruppen als Ganzes
  const idx = items.findIndex((it) => ids.includes(it.id))
  const last = items.findLastIndex((it) => ids.includes(it.id))
  const anchor = how === 'forward' ? items.slice(last + 1).find((it) => !ids.includes(it.id)) : items.slice(0, idx).findLast((it) => !ids.includes(it.id))
  return anchor ? moveNextTo(items, ids, anchor.id, how === 'forward') : items
}
// Auswahl direkt vor (above) bzw. hinter das Element anchor legen (Ebenen-Panel, reorder). Liegt anchor in einer Gruppe,
// zu der die Auswahl nicht gehört, zählt deren Rand: fremde Elemente landen nie zwischen Gruppenmitgliedern
export function moveNextTo(items: Item[], ids: string[], anchor: string, above: boolean): Item[] {
  const rest = items.filter((it) => !ids.includes(it.id))
  const g = rest.find((it) => it.id === anchor)?.group
  const edge = g && !items.some((it) => ids.includes(it.id) && it.group === g)
  const i = edge ? (above ? rest.findLastIndex((it) => it.group === g) : rest.findIndex((it) => it.group === g)) : rest.findIndex((it) => it.id === anchor)
  if (i < 0) return items
  const at = i + (above ? 1 : 0)
  return [...rest.slice(0, at), ...items.filter((it) => ids.includes(it.id)), ...rest.slice(at)]
}

export type Align = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
// Eine Auswahl richtet sich an der Folie aus, mehrere aneinander (an der gemeinsamen Box)
export function align(items: Item[], ids: string[], how: Align, size = { w: 1280, h: 720 }): Item[] {
  const sel = items.filter((it) => ids.includes(it.id) && !it.locked)
  if (!sel.length) return items
  const g = new Map(sel.map((it) => [it.id, geoOf(it)]))
  const all = [...g.values()]
  if (isGroup(items, ids)) { // Gruppe als Ganzes an der Folie ausrichten
    const x = Math.min(...all.map((b) => b.x)), y = Math.min(...all.map((b) => b.y))
    const bw = Math.max(...all.map((b) => b.x + b.w)) - x, bh = Math.max(...all.map((b) => b.y + b.h)) - y
    const d = { left: [-x, 0], hcenter: [(size.w - bw) / 2 - x, 0], right: [size.w - bw - x, 0], top: [0, -y], vcenter: [0, (size.h - bh) / 2 - y], bottom: [0, size.h - bh - y] }[how]
    return items.map((it) => (g.has(it.id) ? { ...it, x: Math.round(it.x + d[0]), y: Math.round(it.y + d[1]) } : it))
  }
  const frame = sel.length === 1 ? { x: 0, y: 0, ...size } : (() => {
    const x = Math.min(...all.map((b) => b.x)), y = Math.min(...all.map((b) => b.y))
    return { x, y, w: Math.max(...all.map((b) => b.x + b.w)) - x, h: Math.max(...all.map((b) => b.y + b.h)) - y }
  })()
  return items.map((it) => {
    const b = g.get(it.id)
    if (!b) return it
    const pos = {
      left: { x: frame.x }, hcenter: { x: frame.x + (frame.w - b.w) / 2 }, right: { x: frame.x + frame.w - b.w },
      top: { y: frame.y }, vcenter: { y: frame.y + (frame.h - b.h) / 2 }, bottom: { y: frame.y + frame.h - b.h },
    }[how]
    return { ...it, ...Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, Math.round(v)])) }
  })
}

// Gleiche Abstände zwischen drei oder mehr Elementen
export function distribute(items: Item[], ids: string[], axis: 'x' | 'y'): Item[] {
  const sel = items.filter((it) => ids.includes(it.id) && !it.locked).map((it) => ({ it, b: geoOf(it) }))
  if (sel.length < 3) return items
  const size = axis === 'x' ? 'w' : 'h'
  sel.sort((a, b) => a.b[axis] - b.b[axis])
  const start = sel[0].b[axis], end = sel.at(-1)!.b[axis] + sel.at(-1)!.b[size]
  const gap = (end - start - sel.reduce((n, s) => n + s.b[size], 0)) / (sel.length - 1)
  const pos = new Map<string, number>()
  let cur = start
  for (const s of sel) { pos.set(s.it.id, Math.round(cur)); cur += s.b[size] + gap }
  return items.map((it) => (pos.has(it.id) ? { ...it, [axis]: pos.get(it.id) } : it))
}

// Zwischenablage für Elemente und kopierten Stil, auch über Folien hinweg (Kontextmenü, Inspector und Kürzel teilen sie)
export const clip: { items: Item[]; style: Partial<Item> | null } = { items: [], style: null }

// „Stil übertragen“: Aussehen ohne Inhalt und Position
const STYLE_KEYS = ['font', 'size', 'color', 'bold', 'italic', 'underline', 'upper', 'align', 'lineHeight', 'spacing', 'effect', 'effectColor',
  'fill', 'fill2', 'gradAngle', 'stroke', 'strokeW', 'dash', 'radius', 'shadow', 'opacity', 'look', 'mask', 'adjust'] as const satisfies readonly (keyof Item)[]
export const copyStyle = (it: Item) => { clip.style = Object.fromEntries(STYLE_KEYS.filter((k) => it[k] !== undefined).map((k) => [k, it[k]])) }
export const pasteStyle = (items: Item[], ids: string[]): Item[] => {
  const s = clip.style
  return s ? items.map((it) => (ids.includes(it.id) ? { ...it, ...Object.fromEntries(STYLE_KEYS.map((k) => [k, s[k]])) } : it)) : items
}

// asset://-URL wie ipc.ts (pathToFileURL-Kodierung pro Pfadsegment)
export const assetOf = (path: string) => `asset://local${path.split('/').map(encodeURIComponent).join('/')}`

export const imageRatio = (src: string) => new Promise<number>((resolve) => {
  const img = new Image()
  img.onload = () => resolve(img.naturalWidth / img.naturalHeight || 1.5)
  img.onerror = () => resolve(1.5)
  img.src = src
})
