// Ebenen (Canva „Position → Ebenen“): freie Elemente der Folie, oberstes zuerst. slide.items wird in Array-Reihenfolge
// über das Layout gezeichnet, das letzte Element liegt vorne. Klick wählt, Umschalt+Klick ergänzt, Ziehen bzw. Alt+Pfeil
// ändert die Reihenfolge, das Schloss sperrt. Gruppen sind nur Markierungen (Item.group): Kopfzeile je zusammenhängendem Block.
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { ChartColumn, Film, Group, Image, LayoutTemplate, Lock, LockOpen, Music, QrCode, Shapes, Smile, Spline, Type, type LucideIcon } from 'lucide-react'
import type { Deck, Item } from '../../shared/deck'
import { GRAPHICS } from '../../shared/items'
import { LAYOUTS, type LayoutId } from '../../shared/layouts'
import { SHAPE_NAMES } from './Elements'
import { moveNextTo, reorder, withGroups } from './itemOps'
import './layers.css'

const KIND: Record<Item['kind'], [LucideIcon, string]> = {
  text: [Type, 'Text'], shape: [Shapes, 'Form'], image: [Image, 'Bild'], icon: [Smile, 'Icon'], chart: [ChartColumn, 'Diagramm'],
  video: [Film, 'Video'], audio: [Music, 'Audio'], qr: [QrCode, 'QR-Code'], graphic: [Spline, 'Grafik'],
}
// Text: erste Zeile ohne **fett** und [Link](url)
const nameOf = (it: Item) =>
  it.kind === 'text' ? it.text?.replace(/\*\*|\[([^\]]*)\]\([^)]*\)/g, '$1').trim().split('\n')[0] || 'Text'
  : it.kind === 'shape' ? SHAPE_NAMES[it.shape ?? 'rect'] ?? 'Form'
  : it.kind === 'graphic' ? GRAPHICS[it.graphic ?? '']?.name ?? 'Grafik'
  : KIND[it.kind][1]

interface Row { key: string; ids: string[]; anchor: string; icon: LucideIcon; label: string; head?: boolean; member?: boolean }
interface Props {
  deck: Deck
  index: number
  picked: string[]
  disabled: boolean
  onPick: (ids: string[]) => void
  onItems: (fn: (items: Item[]) => Item[], tag?: string) => void
}

export function LayersPanel({ deck, index, picked, disabled, onPick, onItems }: Props) {
  const slide = deck.slides[index]
  const items = slide?.items ?? []
  const order = [...items].reverse()
  const rows = order.flatMap((it, i): Row[] => {
    const row = { key: it.id, ids: [it.id], anchor: it.id, icon: KIND[it.kind][0], label: nameOf(it), member: !!it.group }
    if (!it.group || order[i - 1]?.group === it.group) return [row]
    // Kopfzeile wählt und zieht die ganze Gruppe; sie hat keine eigene Ebene, abgelegt wird vor ihrem obersten Mitglied
    return [{ key: `g-${it.id}`, ids: items.filter((x) => x.group === it.group).map((x) => x.id), anchor: it.id, icon: Group, label: 'Gruppe', head: true }, row]
  })
  const layout = slide && slide.layout !== 'blank' ? LAYOUTS[slide.layout as LayoutId]?.name ?? slide.layout : null
  const [drag, setDrag] = useState<string[] | null>(null)
  const [over, setOver] = useState<{ key: string; above: boolean } | null>(null)
  const list = useRef<HTMLUListElement>(null)

  // gewählte Zeile im Blick halten; nur die Liste scrollen, scrollIntoView zöge das ganze Panel mit
  useEffect(() => {
    const l = list.current, o = l?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!l || !o) return
    if (o.offsetTop < l.scrollTop) l.scrollTop = o.offsetTop
    else if (o.offsetTop + o.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = o.offsetTop + o.offsetHeight - l.clientHeight
  }, [picked])

  const edit = (fn: (l: Item[]) => Item[]) => { if (!disabled) onItems(fn) }
  const isLocked = (ids: string[]) => items.filter((it) => ids.includes(it.id)).every((it) => it.locked)
  const lock = (ids: string[]) => { const on = !isLocked(ids); edit((l) => l.map((it) => (ids.includes(it.id) ? { ...it, locked: on || undefined } : it))) }
  const click = (e: MouseEvent, ids: string[]) => {
    if (disabled) return
    const all = ids.every((id) => picked.includes(id))
    onPick(!e.shiftKey ? ids : all ? picked.filter((id) => !ids.includes(id)) : [...new Set([...picked, ...ids])])
  }
  // Pfeile überlässt die Bühne der Liste (Stage.tsx), Entf, Strg+C, Esc usw. wirken wie auf der Bühne; stopPropagation: sonst blättert die App
  const key = (e: KeyboardEvent) => {
    if (disabled || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    e.stopPropagation()
    const up = e.key === 'ArrowUp'
    if (e.altKey) { if (picked.length) edit((l) => reorder(l, withGroups(l, picked), up ? 'forward' : 'backward')); return }
    const at = up ? order.findIndex((it) => picked.includes(it.id)) : order.findLastIndex((it) => picked.includes(it.id))
    const next = order[at < 0 ? 0 : Math.max(0, Math.min(order.length - 1, at + (up ? -1 : 1)))]
    if (next) onPick([next.id])
  }
  // gewählte Zeilen ziehen gemeinsam; Gruppen immer ganz, sonst zerfiele der Block
  const start = (e: DragEvent, ids: string[]) => { setDrag(withGroups(items, ids.every((id) => picked.includes(id)) ? picked : ids)); e.dataTransfer.effectAllowed = 'move' }
  const dragOver = (e: DragEvent, key: string, forceAbove?: boolean) => {
    if (!drag) return
    e.preventDefault()
    const r = e.currentTarget.getBoundingClientRect()
    const above = !!forceAbove || e.clientY < r.top + r.height / 2
    setOver((o) => (o?.key === key && o.above === above ? o : { key, above }))
  }
  const end = () => { setDrag(null); setOver(null) }
  const drop = (e: DragEvent, anchor: string | null) => { // null = Layout-Zeile: ganz nach hinten
    e.preventDefault()
    if (drag && over) edit((l) => (anchor ? moveNextTo(l, drag, anchor, over.above) : reorder(l, drag, 'back')))
    end()
  }
  const dropCls = (key: string) => (over?.key === key ? (over.above ? 'layers-drop-above' : 'layers-drop-below') : '')

  return (
    <details className="layers-panel">
      <summary>Ebenen</summary>
      {!items.length && <p className="muted layers-empty">Keine freien Elemente auf dieser Folie.</p>}
      {(rows.length > 0 || layout) && (
        <ul ref={list} className="layers-list" role="listbox" aria-label="Ebenen der Folie, oberste zuerst" aria-multiselectable tabIndex={0} onKeyDown={key}>
          {rows.map((r) => {
            const Icon = r.icon, locked = isLocked(r.ids)
            return (
              <li key={r.key} role="option" aria-selected={r.ids.every((id) => picked.includes(id))} draggable={!disabled}
                className={`layers-row ${r.head ? 'layers-head' : ''} ${r.member ? 'layers-member' : ''} ${dropCls(r.key)}`}
                onClick={(e) => click(e, r.ids)} onDragStart={(e) => start(e, r.ids)} onDragOver={(e) => dragOver(e, r.key, r.head)} onDrop={(e) => drop(e, r.anchor)} onDragEnd={end}>
                <Icon size={14} aria-hidden />
                <span className="layers-name">{r.label}</span>
                <button type="button" className={`icon-btn layers-lock ${locked ? 'on' : ''}`} title={locked ? 'Entsperren' : 'Sperren'} aria-label={locked ? 'Entsperren' : 'Sperren'} aria-pressed={locked}
                  onClick={(e) => { e.stopPropagation(); lock(r.ids) }}>
                  {locked ? <Lock size={13} /> : <LockOpen size={13} />}
                </button>
              </li>
            )
          })}
          {layout && (
            <li role="option" aria-selected={false} className={`layers-row layers-layout ${dropCls('layout')}`} title="Inhalt des Layouts, liegt immer hinter den freien Elementen"
              onClick={() => !disabled && onPick([])} onDragOver={(e) => dragOver(e, 'layout', true)} onDrop={(e) => drop(e, null)}>
              <LayoutTemplate size={14} aria-hidden />
              <span className="layers-name">Layout: {layout}</span>
            </li>
          )}
        </ul>
      )}
    </details>
  )
}
