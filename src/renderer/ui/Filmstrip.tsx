// Filmstreifen: kleine Folien, Klick wählt aus, Drag & Drop sortiert um, Folien anlegen/duplizieren/ausblenden/löschen.
// Rechtsklick öffnet ein Kontextmenü; mit Fokus auf einer Folie: Strg+C/V/D, Entf.
import { memo, useEffect, useRef, useState } from 'react'
import { confirmDialog } from './kit'
import { Blend, Copy, EyeOff, Plus, Trash2 } from 'lucide-react'
import type { Deck } from '../../shared/deck'
import { SlideView } from '../slide'
import { TRANSITION } from './LookSheet'

interface Props {
  deck: Deck; sel: number; disabled: boolean; onSelect: (i: number) => void; onMove: (from: number, to: number) => void; onAdd: (at?: number) => void
  onDup: (i: number) => void; onDel: (i: number) => void; onHide: (i: number) => void; onCopy: (idx: number[]) => void; onPaste: (at: number) => number; canPaste: () => boolean
}

const off = { opacity: 0.4, cursor: 'default' } // .ctx-menu kennt kein :disabled

export const Filmstrip = memo(function Filmstrip({ deck, sel, disabled, onSelect, onMove, onAdd, onDup, onDel, onHide, onCopy, onPaste, canPaste }: Props) {
  const from = useRef<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null)
  const nav = useRef<HTMLElement>(null)
  const keep = useRef(false) // nach Löschen ist die fokussierte Folie weg: Fokus trotzdem weitergeben
  const end = () => { from.current = null; setOver(null) }
  useEffect(() => { nav.current?.children[sel]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }) }, [sel])
  // Fokus folgt der Auswahl (Pfeiltasten, Einfügen, Duplizieren), damit das nächste Kürzel die angezeigte Folie trifft
  useEffect(() => {
    if (keep.current || nav.current?.contains(document.activeElement)) (nav.current?.children[sel] as HTMLElement | undefined)?.focus({ preventScroll: true })
    keep.current = false
  }, [sel, deck.slides.length])
  useEffect(() => setMenu(null), [disabled, deck.slides]) // KI arbeitet oder Folien geändert: menu.i wäre veraltet
  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.ctx-menu')) setMenu(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    addEventListener('pointerdown', close)
    addEventListener('keydown', esc)
    return () => { removeEventListener('pointerdown', close); removeEventListener('keydown', esc) }
  }, [menu])
  const del = (i: number) => {
    if (deck.slides.length < 2) return
    void confirmDialog({ title: `Folie ${i + 1} löschen?`, text: 'Mit Strg+Z holst du sie zurück.', ok: 'Löschen', danger: true }).then((ok) => { if (ok) { keep.current = true; onDel(i) } })
  }
  const pick = (fn: () => void) => () => { setMenu(null); fn() }

  return (
    <nav className="filmstrip" aria-label="Folien" ref={nav}>
      {deck.slides.map((s, i) => (
        <div
          key={s.id}
          role="button"
          tabIndex={0}
          aria-label={`Folie ${i + 1}${s.hidden ? ', ausgeblendet' : ''}`}
          aria-current={i === sel}
          className={`thumb ${i === sel ? 'active' : ''} ${over === i && from.current !== i ? 'over' : ''} ${s.hidden ? 'dw-hidden' : ''}`}
          draggable={!disabled}
          onClick={(e) => { e.currentTarget.focus(); onSelect(i) }}
          onContextMenu={(e) => {
            e.preventDefault()
            if (disabled) return
            e.currentTarget.focus()
            onSelect(i)
            setMenu({ i, x: Math.min(e.clientX, innerWidth - 240), y: Math.min(e.clientY, innerHeight - 230) }) // im Fenster halten (Menü ca. 240 × 230 px)
          }}
          onKeyDown={(e) => {
            const mod = e.ctrlKey || e.metaKey, cmd = mod && !e.shiftKey && !e.altKey, k = e.key.toLowerCase()
            if (e.key === 'Enter' || e.key === ' ') onSelect(i)
            else if (cmd && k === 'c') onCopy([i])
            else if (disabled) return
            else if (cmd && k === 'v') onPaste(i + 1)
            else if (cmd && k === 'd') onDup(i)
            else if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) del(i)
            else return
            e.preventDefault()
            e.stopPropagation()
          }}
          onDragStart={(e) => { from.current = i; e.dataTransfer.effectAllowed = 'move' }}
          onDragOver={(e) => { e.preventDefault(); setOver(i) }}
          onDrop={() => { if (from.current !== null && from.current !== i) onMove(from.current, i); end() }}
          onDragEnd={end}
        >
          <span className="thumb-num">
            {i + 1}
            {i > 0 && s.transition && <span className="thumb-tr" title={`Übergang zu dieser Folie: ${TRANSITION[s.transition]}`}><Blend size={11} /></span>}
            {s.hidden && <span className="thumb-off" title="Ausgeblendet: fehlt beim Präsentieren und im Export"><EyeOff size={11} /></span>}
          </span>
          {!disabled && (
            <span className="thumb-acts">
              <button className="icon-btn" title="Folie duplizieren" aria-label="Folie duplizieren" onClick={(e) => (e.stopPropagation(), onDup(i))}><Copy size={12} /></button>
              <button className="icon-btn" title="Folie löschen" aria-label="Folie löschen" disabled={deck.slides.length < 2} onClick={(e) => { e.stopPropagation(); del(i) }}><Trash2 size={12} /></button>
            </span>
          )}
          <div className="thumb-slide"><SlideView deck={deck} index={i} width={160} /></div>
        </div>
      ))}
      <button className="thumb-add" disabled={disabled} onClick={() => onAdd()} title="Leere Folie hinzufügen" aria-label="Leere Folie hinzufügen"><Plus size={18} /></button>
      {menu && (
        <div className="ctx-menu" style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 20 }} onMouseDown={(e) => e.preventDefault() /* Fokus bleibt auf der Folie */}>
          <button onClick={pick(() => onAdd(menu.i + 1))}>Neue Folie danach</button>
          <button onClick={pick(() => onDup(menu.i))}>Duplizieren <kbd>Strg+D</kbd></button>
          <button onClick={pick(() => onCopy([menu.i]))}>Kopieren <kbd>Strg+C</kbd></button>
          <button disabled={!canPaste()} style={canPaste() ? undefined : off} onClick={pick(() => onPaste(menu.i + 1))}>Einfügen <kbd>Strg+V</kbd></button>
          <button onClick={pick(() => onHide(menu.i))}>{deck.slides[menu.i]?.hidden ? 'Einblenden' : 'Folie ausblenden'}</button>
          <hr />
          <button className="danger" disabled={deck.slides.length < 2} style={deck.slides.length < 2 ? off : undefined} onClick={pick(() => del(menu.i))}>Löschen <kbd>Entf</kbd></button>
        </div>
      )}
    </nav>
  )
})
