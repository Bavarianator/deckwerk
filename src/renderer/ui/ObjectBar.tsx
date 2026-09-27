// Schwebende Leiste über einem gewählten freien Element: die häufigsten Handgriffe direkt am Objekt
// (Größe, Farbe, Schnitt, Ausrichtung), alles Weitere im Panel „Anpassen“, Wünsche an die KI über „Frag Deckwerk“.
import { useLayoutEffect, useRef, useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight, Minus, Plus, SlidersHorizontal, Sparkles } from 'lucide-react'
import type { Item } from '../../shared/deck'

const ALIGN = { left: AlignLeft, center: AlignCenter, right: AlignRight }
const NEXT = { left: 'center', center: 'right', right: 'left' } as const

interface Props {
  item: Item
  rect: { left: number; top: number; width: number; height: number }
  colors: string[] // Theme-Farben
  busy: boolean
  onPatch: (p: Partial<Item>, tag?: string) => void
  onMore: () => void // Panel „Anpassen“
  onAsk: () => void // Fokus in die KI-Leiste (Bezug ist schon gesetzt)
}

export function ObjectBar({ item, rect, colors, busy, onPatch, onMore, onAsk }: Props) {
  const bar = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  useLayoutEffect(() => {
    const w = bar.current!.offsetWidth
    const above = rect.top - 56
    setPos({
      left: Math.max(12, Math.min(rect.left + rect.width / 2 - w / 2, innerWidth - w - 12)),
      top: above > 60 ? above : rect.top + rect.height + 12, // oben kein Platz: darunter
    })
  }, [rect.left, rect.top, rect.width, rect.height])

  const color = item.kind === 'shape' ? item.fill : item.color
  const colorKey = item.kind === 'shape' ? 'fill' : 'color'
  const size = item.size ?? 32
  const Align = ALIGN[item.align ?? 'left']

  return (
    <div ref={bar} className="obj-bar material" role="toolbar" aria-label="Element bearbeiten" style={pos} onPointerDown={(e) => e.stopPropagation()}>
      {item.kind === 'text' && (
        <>
          <button className="plain" aria-label="Kleiner" disabled={busy} onClick={() => onPatch({ size: Math.max(6, Math.round(size / 1.1)) }, `size-${item.id}`)}><Minus size={14} /></button>
          <span className="obj-size" aria-label="Schriftgröße">{size}</span>
          <button className="plain" aria-label="Größer" disabled={busy} onClick={() => onPatch({ size: Math.round(size * 1.1) }, `size-${item.id}`)}><Plus size={14} /></button>
          <i aria-hidden="true" />
        </>
      )}
      {(item.kind === 'text' || item.kind === 'shape' || item.kind === 'icon') && (
        <>
          {colors.map((c) => (
            <button key={c} className={`obj-swatch ${color?.toUpperCase() === c.toUpperCase() ? 'on' : ''}`} style={{ background: c }}
              aria-label={`Farbe ${c}`} aria-pressed={color?.toUpperCase() === c.toUpperCase()} disabled={busy} onClick={() => onPatch({ [colorKey]: c })} />
          ))}
          <i aria-hidden="true" />
        </>
      )}
      {item.kind === 'text' && (
        <>
          <button className={`plain ${item.bold ? 'on' : ''}`} aria-label="Fett" aria-pressed={!!item.bold} disabled={busy} onClick={() => onPatch({ bold: !item.bold || undefined })}><b>B</b></button>
          <button className={`plain ${item.italic ? 'on' : ''}`} aria-label="Kursiv" aria-pressed={!!item.italic} disabled={busy} onClick={() => onPatch({ italic: !item.italic || undefined })}><em>I</em></button>
          <button className="plain" aria-label={`Ausrichtung: ${item.align ?? 'left'}`} disabled={busy} onClick={() => onPatch({ align: NEXT[item.align ?? 'left'] })}><Align size={16} /></button>
          <i aria-hidden="true" />
        </>
      )}
      <button className="plain" aria-label="Alle Einstellungen" title="Anpassen" onClick={onMore}><SlidersHorizontal size={15} /></button>
      <button className="plain tint" onClick={onAsk}><Sparkles size={15} />Frag Deckwerk</button>
    </div>
  )
}
