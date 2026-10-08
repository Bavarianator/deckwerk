// Formate: dasselbe Deck als Quadrat, Story, A4 … Mehrere ankreuzen → je eine Kopie als eigenes Deck (Original bleibt);
// genau eines → auch „Dieses Deck umwandeln“ (Undo-Schritt). Vorschau live am zuletzt gewählten Format.
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { FORMATS, sizeOf, type Deck, type FormatId } from '../../shared/deck'
import { resizeDeck } from '../../shared/items'
import { SlideView } from '../slide'

const IDS = Object.keys(FORMATS) as FormatId[]
const HINT: Partial<Record<FormatId, string>> = {
  '1:1': 'LinkedIn, Instagram', '4:5': 'Instagram-Feed', '9:16': 'Story, Reel', a4: 'Handout zum Ausdrucken', 'a4-quer': 'Ausdruck quer', og: 'Vorschau in E-Mail und Chat', visitenkarte: 'Druck mit Beschnitt',
}

interface Props { deck: Deck; index: number; onApply: (id: FormatId) => void; onCopies: (ids: FormatId[]) => void; onClose: () => void }

export function FormatSheet({ deck, index, onApply, onCopies, onClose }: Props) {
  const cur = sizeOf(deck)
  const now = IDS.find((id) => FORMATS[id].w === cur.w && FORMATS[id].h === cur.h)
  const [pick, setPick] = useState<FormatId>(now === '1:1' ? '9:16' : '1:1') // in der Vorschau
  const [checked, setChecked] = useState<FormatId[]>([pick])
  const toggle = (id: FormatId) => { setPick(id); setChecked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id])) }
  const [i, setI] = useState(index)
  const box = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ w: 600, h: 500 })
  useLayoutEffect(() => {
    box.current?.focus()
    const ro = new ResizeObserver(([e]) => setArea({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(box.current!.querySelector('.fmt-preview')!)
    return () => ro.disconnect()
  }, [])
  const preview = useMemo(() => resizeDeck(deck, pick), [deck, pick])
  const f = FORMATS[pick]
  const w = Math.floor(Math.min(area.w, (area.h * f.w) / f.h))

  return (
    <div className="look fmt" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Formate"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
        else if (e.key === 'ArrowLeft') setI(Math.max(0, i - 1))
        else if (e.key === 'ArrowRight') setI(Math.min(deck.slides.length - 1, i + 1))
        else return
        e.preventDefault()
        e.stopPropagation()
      }}>
      <header className="top">
        <div className="top-l"><button className="plain tint" onClick={onClose}>Abbrechen</button></div>
        <b>Formate</b>
        <div className="top-r">
          {checked.length === 1 && checked[0] !== now && <button className="plain tint" onClick={() => { onApply(checked[0]); onClose() }}>Dieses Deck umwandeln</button>}
          <button className="pill tint" disabled={!checked.length} onClick={() => { onCopies(checked); onClose() }}>
            {checked.length === 1 ? 'Als Kopie anlegen' : `${checked.length || ''} Kopien anlegen`}
          </button>
        </div>
      </header>
      <div className="fmt-body">
        <aside className="fmt-side">
          <h1>Eine Idee, jedes Format.</h1>
          <p>Kreuze an, was du brauchst. Deckwerk ordnet Titel, Texte und Bilder für jedes Format neu an und legt je ein eigenes Deck an. Dein Original bleibt, wie es ist.</p>
          <div className="fmt-list" role="group" aria-label="Formate">
            {IDS.map((id) => {
              const x = FORMATS[id], k = 26 / Math.max(x.w, x.h)
              return (
                <button key={id} role="checkbox" aria-checked={checked.includes(id)} className={pick === id ? 'on' : ''} onClick={() => toggle(id)}>
                  <span className="fmt-icon"><span style={{ width: x.w * k, height: x.h * k }} /></span>
                  <span className="fmt-name"><b>{x.name}</b><span>{HINT[id] ?? `${x.w} × ${x.h}`}</span></span>
                  {id === now && <span className="fmt-now">Aktuell</span>}
                  <span className={`fmt-check ${checked.includes(id) ? 'on' : ''}`} aria-hidden="true">{checked.includes(id) && <Check size={12} strokeWidth={3.2} />}</span>
                </button>
              )
            })}
          </div>
        </aside>
        <main className="fmt-main">
          <div className="fmt-nav">
            <button className="look-arrow" aria-label="Vorherige Folie" disabled={i === 0} onClick={() => setI(i - 1)}><ChevronLeft size={15} /></button>
            <span>Vorschau · <b>Folie {i + 1}</b> von {deck.slides.length}</span>
            <button className="look-arrow" aria-label="Nächste Folie" disabled={i >= deck.slides.length - 1} onClick={() => setI(i + 1)}><ChevronRight size={15} /></button>
          </div>
          <div className="fmt-preview">
            {w > 0 && <div className="look-card" style={{ width: w }}><SlideView deck={preview} index={i} width={w} /></div>}
          </div>
          <p className="fmt-cap">{f.name} · {f.w} × {f.h}</p>
        </main>
      </div>
    </div>
  )
}
