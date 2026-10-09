// PDF für die Druckerei: Endformat (A2 bis A6, nur bei A4-Decks; die Visitenkarte druckt in ihrer Größe) und Beschnitt je Druckerei wählen, dann exportieren.
// Seite = Endformat + Beschnitt ringsum; die Auswahl wird für das nächste Mal gemerkt.
import { useEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { isA4, PRINT_SIZES, sizeOf, type Deck, type PrintOptions } from '../../shared/deck'

type Size = keyof typeof PRINT_SIZES
const SIZES: Size[] = ['a4', 'a5', 'a6', 'a3', 'a2']
const SHOPS: { bleed: number; name: string; hint: string }[] = [
  { bleed: 3, name: 'WIRmachenDRUCK oder andere', hint: '3 mm Beschnitt' },
  { bleed: 2, name: 'Saxoprint, Onlineprinters', hint: '2 mm Beschnitt' },
  { bleed: 1, name: 'Flyeralarm', hint: '1 mm Beschnitt' },
]
const KEY = 'dw.print'

function saved(): { size: Size; bleed: number } {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { size: SIZES.includes(o.size) ? o.size : 'a4', bleed: SHOPS.some((s) => s.bleed === o.bleed) ? o.bleed : 3 }
  } catch { return { size: 'a4', bleed: 3 } }
}

interface Props { deck: Deck; onExport: (o: PrintOptions) => void; onClose: () => void }

export function PrintSheet({ deck, onExport, onClose }: Props) {
  const [size, setSize] = useState(() => saved().size)
  const [bleed, setBleed] = useState(() => saved().bleed)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])
  const { w, h } = sizeOf(deck)
  const quer = w > h, a4 = isA4({ w, h })
  const n = deck.slides.length
  const go = () => {
    try { localStorage.setItem(KEY, JSON.stringify({ size, bleed })) } catch { /* Wahl gilt nur diesmal */ }
    onExport({ size: a4 ? size : undefined, bleed })
    onClose()
  }

  return (
    <div className="look fmt" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="PDF für die Druckerei"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }}>
      <header className="top">
        <div className="top-l"><button className="plain tint" onClick={onClose}>Abbrechen</button></div>
        <b>PDF für die Druckerei</b>
        <div className="top-r"><button className="pill tint" onClick={go}>Exportieren</button></div>
      </header>
      <div className="fmt-body">
        <aside className="fmt-side">
          <h1>Druckfertig, mit Beschnitt.</h1>
          <p>Seite = Endformat + Beschnitt ringsum, ohne Schnittmarken. Randabfallende Fotos laufen in den Beschnitt. Farben bleiben RGB: Flyeralarm, Saxoprint, WIRmachenDRUCK und Onlineprinters wandeln selbst nach CMYK, leuchtende Akzente werden dabei etwas matter. print24 verlangt CMYK-Daten. Vor einer großen Auflage einen Probedruck bestellen.</p>
          {n > 2 && <p>Das Deck hat {n} Seiten. Ein Flyer hat 1 Seite, beidseitig 2 (Vorder- und Rückseite). Nicht gewählte Entwürfe vorher löschen.</p>}
          {a4 && <div className="fmt-list" role="radiogroup" aria-label="Endformat">
            {SIZES.map((id) => {
              const [mw, mh] = PRINT_SIZES[id]
              const k = 26 / Math.max(mw, mh)
              return (
                <button key={id} role="radio" aria-checked={size === id} className={size === id ? 'on' : ''} onClick={() => setSize(id)}>
                  <span className="fmt-icon"><span style={quer ? { width: mh * k, height: mw * k } : { width: mw * k, height: mh * k }} /></span>
                  <span className="fmt-name"><b>{id.toUpperCase()}{quer ? ' quer' : ''}</b><span>{quer ? `${mh} × ${mw} mm` : `${mw} × ${mh} mm`}</span></span>
                  <span className={`fmt-check ${size === id ? 'on' : ''}`} aria-hidden="true">{size === id && <Check size={12} strokeWidth={3.2} />}</span>
                </button>
              )
            })}
          </div>}
          <div className="fmt-list" role="radiogroup" aria-label="Druckerei und Beschnitt">
            {SHOPS.map((s) => (
              <button key={s.bleed} role="radio" aria-checked={bleed === s.bleed} className={bleed === s.bleed ? 'on' : ''} onClick={() => setBleed(s.bleed)}>
                <span className="fmt-name"><b>{s.name}</b><span>{s.hint}</span></span>
                <span className={`fmt-check ${bleed === s.bleed ? 'on' : ''}`} aria-hidden="true">{bleed === s.bleed && <Check size={12} strokeWidth={3.2} />}</span>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
