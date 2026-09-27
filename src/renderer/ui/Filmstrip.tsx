// Filmstreifen: kleine Folien, Klick wählt aus, Drag & Drop sortiert um, Folien anlegen/duplizieren/löschen.
import { memo, useEffect, useRef, useState } from 'react'
import { confirmDialog } from './kit'
import { Copy, Plus, Trash2 } from 'lucide-react'
import type { Deck } from '../../shared/deck'
import { SlideView } from '../slide'

interface Props { deck: Deck; sel: number; disabled: boolean; onSelect: (i: number) => void; onMove: (from: number, to: number) => void; onAdd: () => void; onDup: (i: number) => void; onDel: (i: number) => void }

export const Filmstrip = memo(function Filmstrip({ deck, sel, disabled, onSelect, onMove, onAdd, onDup, onDel }: Props) {
  const from = useRef<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const nav = useRef<HTMLElement>(null)
  const end = () => { from.current = null; setOver(null) }
  useEffect(() => { nav.current?.children[sel]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }) }, [sel])

  return (
    <nav className="filmstrip" aria-label="Folien" ref={nav}>
      {deck.slides.map((s, i) => (
        <div
          key={s.id}
          role="button"
          tabIndex={0}
          aria-label={`Folie ${i + 1}`}
          aria-current={i === sel}
          className={`thumb ${i === sel ? 'active' : ''} ${over === i && from.current !== i ? 'over' : ''}`}
          draggable={!disabled}
          onClick={() => onSelect(i)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(i))}
          onDragStart={(e) => { from.current = i; e.dataTransfer.effectAllowed = 'move' }}
          onDragOver={(e) => { e.preventDefault(); setOver(i) }}
          onDrop={() => { if (from.current !== null && from.current !== i) onMove(from.current, i); end() }}
          onDragEnd={end}
        >
          <span className="thumb-num">{i + 1}</span>
          {!disabled && (
            <span className="thumb-acts">
              <button className="icon-btn" title="Folie duplizieren" aria-label="Folie duplizieren" onClick={(e) => (e.stopPropagation(), onDup(i))}><Copy size={12} /></button>
              <button className="icon-btn" title="Folie löschen" aria-label="Folie löschen" disabled={deck.slides.length < 2} onClick={(e) => { e.stopPropagation(); void confirmDialog({ title: `Folie ${i + 1} löschen?`, text: 'Mit Strg+Z holst du sie zurück.', ok: 'Löschen', danger: true }).then((ok) => ok && onDel(i)) }}><Trash2 size={12} /></button>
            </span>
          )}
          <div className="thumb-slide"><SlideView deck={deck} index={i} width={160} /></div>
        </div>
      ))}
      <button className="thumb-add" disabled={disabled} onClick={onAdd} title="Leere Folie hinzufügen" aria-label="Leere Folie hinzufügen"><Plus size={18} /></button>
    </nav>
  )
})
