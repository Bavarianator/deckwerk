// Übersicht: alle Folien als Lichttisch, nach Kapiteln. Klick wählt (Umschalt: Bereich, Strg: einzeln dazu), Doppelklick öffnet,
// Ziehen sortiert um. Für die Auswahl: Kopieren/Einfügen (Strg+C/V), Duplizieren, Ausblenden, Löschen, mit Deckwerk überarbeiten.
import { useRef, useState } from 'react'
import { Check, EyeOff, Sparkles } from 'lucide-react'
import type { Deck, Measured } from '../../shared/deck'
import { SlideView } from '../slide'
import { chaptersOf, titleOf } from './story'
import { confirmDialog } from './kit'

interface Props {
  deck: Deck
  index: number
  busy: boolean
  onOpen: (i: number) => void
  onMove: (from: number, to: number) => void
  onDup: (i: number) => void
  onDel: (i: number) => void
  onHide: (idx: number[], on: boolean) => void
  onCopy: (idx: number[]) => void
  onPaste: (at: number) => number
  onAsk: (text: string, context: string) => boolean
}

const W = 212

export function Overview({ deck, index, busy, onOpen, onMove, onDup, onDel, onHide, onCopy, onPaste, onAsk }: Props) {
  const [picked, setSel] = useState<number[]>([])
  const sel = picked.filter((i) => i < deck.slides.length) // Deck kann schrumpfen (Rückgängig, KI): alte Indizes fallen weg
  const [fit, setFit] = useState<Record<string, Measured['fit']>>({})
  const [from, setFrom] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const anchor = useRef<number | null>(null) // zuletzt geklickte Folie, Start der Umschalt-Auswahl
  const range = (a: number, b: number) => Array.from({ length: Math.abs(b - a) + 1 }, (_, k) => Math.min(a, b) + k)
  const pick = (i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor.current !== null) return setSel(range(Math.min(anchor.current, deck.slides.length - 1), i))
    anchor.current = i
    setSel((s) => (e.ctrlKey || e.metaKey ? (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]) : [i]))
  }
  const desc = [...sel].sort((a, b) => b - a) // von hinten, damit die Indizes stimmen
  // Faustregel: gut eine Minute pro Inhaltsfolie, Kapiteltrenner und Titel zählen kaum
  const minutes = Math.max(1, Math.round(deck.slides.reduce((m, s) => m + (s.layout === 'section' || s.layout === 'cover' ? 0.25 : 1.1), 0)))
  const shown = sel.some((i) => !deck.slides[i].hidden) // Auswahl enthält sichtbare Folien: Knopf blendet aus, sonst ein
  const ids = sel.map((i) => `„${deck.slides[i].id}“ (Folie ${i + 1})`).join(', ')

  return (
    <div
      className="grid-view" tabIndex={-1} onClick={(e) => { if (e.target === e.currentTarget) setSel([]) }}
      onKeyDown={(e) => {
        const mod = e.ctrlKey || e.metaKey
        if (mod && e.key.toLowerCase() === 'a') setSel(deck.slides.map((_, i) => i))
        else if (e.key === 'Escape') setSel([])
        else if (mod && e.key.toLowerCase() === 'c' && sel.length) onCopy(sel)
        else if (mod && e.key.toLowerCase() === 'v' && !busy) {
          const at = (sel.length ? Math.max(...sel) : index) + 1, n = onPaste(at)
          if (n) { setSel(range(at, at + n - 1)); anchor.current = at }
        }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length && sel.length < deck.slides.length && !busy) void confirmDialog({ title: `${sel.length === 1 ? 'Folie' : `${sel.length} Folien`} löschen?`, text: 'Mit Strg+Z holst du sie zurück.', ok: 'Löschen', danger: true }).then((ok) => { if (ok) { desc.forEach(onDel); setSel([]) } })
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <p className="grid-meta">{deck.slides.length} Folien · etwa {minutes} Minuten Vortrag</p>
      {chaptersOf(deck).map((c) => (
        <section key={c.from} className="grid-chapter" aria-label={c.title}>
          <h2>{c.title}</h2>
          <div className="grid-slides">
            {Array.from({ length: c.to - c.from + 1 }, (_, k) => c.from + k).map((i) => {
              const s = deck.slides[i]
              const bad = fit[s.id] && !fit[s.id].ok
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`grid-slide ${sel.includes(i) ? 'on' : ''} ${over === i && from !== i ? 'over' : ''} ${s.hidden ? 'dw-hidden' : ''}`}
                  aria-pressed={sel.includes(i)}
                  aria-label={`Folie ${i + 1}${s.hidden ? ', ausgeblendet' : ''}${bad ? ', Text passt nicht' : ''}`}
                  draggable={!busy}
                  onClick={(e) => pick(i, e)}
                  onDoubleClick={() => onOpen(i)}
                  onDragStart={(e) => { setFrom(i); e.dataTransfer.effectAllowed = 'move' }}
                  onDragOver={(e) => { e.preventDefault(); setOver(i) }}
                  onDrop={() => { if (from !== null && from !== i) { onMove(from, i); setSel([]) } setFrom(null); setOver(null) }}
                  onDragEnd={() => { setFrom(null); setOver(null) }}
                >
                  <span className="grid-thumb">
                    <SlideView deck={deck} index={i} width={W} onFit={(f) => setFit((m) => (m[s.id]?.ok === f.ok ? m : { ...m, [s.id]: f }))} />
                    {bad && <span className="grid-warn" />}
                    {sel.includes(i) && <span className="grid-check"><Check size={11} strokeWidth={3.2} /></span>}
                  </span>
                  <span className="grid-cap"><b>{i + 1}</b>{s.hidden && <EyeOff size={13} className="grid-off" aria-hidden />}<span>{titleOf(deck, i)}</span></span>
                  {bad && <span className="grid-bad">Text passt nicht</span>}
                </button>
              )
            })}
          </div>
        </section>
      ))}

      {sel.length > 0 && (
        <div className="grid-bar material" role="toolbar" aria-label={`${sel.length} Folien ausgewählt`}>
          <b>{sel.length === 1 ? '1 Folie' : `${sel.length} Folien`} ausgewählt</b>
          <button className="plain" disabled={busy} onClick={() => { desc.forEach(onDup); setSel([]) }}>Duplizieren</button>
          <button className="plain" disabled={busy} onClick={() => onHide(sel, shown)}>{shown ? 'Ausblenden' : 'Einblenden'}</button>
          <button className="plain danger" disabled={busy || sel.length >= deck.slides.length}
            onClick={() => void confirmDialog({ title: `${sel.length === 1 ? 'Folie' : `${sel.length} Folien`} löschen?`, text: 'Mit Strg+Z holst du sie zurück.', ok: 'Löschen', danger: true }).then((ok) => { if (ok) { desc.forEach(onDel); setSel([]) } })}>Löschen</button>
          <i aria-hidden="true" />
          <button className="pill tint" disabled={busy}
            onClick={() => { if (onAsk(`Überarbeite ${sel.length === 1 ? 'diese Folie' : `diese ${sel.length} Folien`}`, `Ausgewählte Folien: ${ids}`)) setSel([]) }}>
            <Sparkles size={15} />Mit Deckwerk überarbeiten
          </button>
        </div>
      )}
    </div>
  )
}
