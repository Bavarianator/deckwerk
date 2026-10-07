// Schwebende Leiste über einem gewählten freien Element: die häufigsten Handgriffe direkt am Objekt
// (Größe, Farbe, Schnitt, Ausrichtung), alles Weitere im Panel „Anpassen“, Wünsche an die KI über „Frag Deckwerk“.
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight, Minus, Plus, SlidersHorizontal, Sparkles, WandSparkles } from 'lucide-react'
import type { Item } from '../../shared/deck'

const ALIGN = { left: AlignLeft, center: AlignCenter, right: AlignRight }
const NEXT = { left: 'center', center: 'right', right: 'left' } as const

// Schnellaktionen „Umschreiben“: jeder Auftrag ändert nur den gewählten Text (auch im ✦-Menü der KI-Leiste für Layout-Felder)
export const GUARD = 'Nur diesen Text ändern, Aussage und Fakten behalten, Layout und andere Folien nicht anfassen.'
export const REWRITE: [string, string][] = [
  ['Kürzer', 'Schreibe den gewählten Text kürzer.'],
  ['Ausführlicher', 'Schreibe den gewählten Text ausführlicher.'],
  ['Einfacher', 'Schreibe den gewählten Text in einfacherer, leichter verständlicher Sprache.'],
  ['Förmlicher', 'Schreibe den gewählten Text förmlicher.'],
  ['Lockerer', 'Schreibe den gewählten Text lockerer und persönlicher.'],
  ['Rechtschreibung und Grammatik korrigieren', 'Korrigiere Rechtschreibung und Grammatik im gewählten Text, ohne Wortwahl oder Stil zu ändern.'],
]
const LANGS: [string, string][] = [['Englisch', 'Englische'], ['Französisch', 'Französische'], ['Spanisch', 'Spanische'], ['Italienisch', 'Italienische'], ['Niederländisch', 'Niederländische'], ['Polnisch', 'Polnische'], ['Türkisch', 'Türkische'], ['Ukrainisch', 'Ukrainische']]
  .map(([l, ins]) => [l, `Übersetze den gewählten Text ins ${ins}.`])
const MENU: [string, string][] = [...REWRITE, ...LANGS]

interface Props {
  item: Item
  rect: { left: number; top: number; width: number; height: number }
  colors: string[] // Theme-Farben
  busy: boolean
  onPatch: (p: Partial<Item>, tag?: string) => void
  onMore: () => void // Panel „Anpassen“
  onAsk: () => void // Fokus in die KI-Leiste (Bezug ist schon gesetzt)
  onRewrite: (text: string) => void // Auftrag an die KI mit dem aktuellen Bezug
}

export function ObjectBar({ item, rect, colors, busy, onPatch, onMore, onAsk, onRewrite }: Props) {
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

  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    wrap.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  useEffect(() => { if (busy) setOpen(false) }, [busy])
  // Menü ins Fenster setzen: nach oben bzw. rechtsbündig öffnen, wo unten/rechts der Platz fehlt; Höhe begrenzen
  const [place, setPlace] = useState({ up: false, right: false, max: 0 })
  useLayoutEffect(() => {
    const m = wrap.current?.querySelector<HTMLElement>('.menu')
    if (!open || !m) return setPlace({ up: false, right: false, max: 0 }) // frisch messen
    const w = wrap.current!.getBoundingClientRect()
    const below = innerHeight - (w.top + 38) - 8
    const above = w.top - 6 - 8
    const up = m.offsetHeight > below && above > below
    setPlace({ up, right: w.left + m.offsetWidth > innerWidth - 8, max: Math.max(120, up ? above : below) })
  }, [open])
  const menuKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); wrap.current?.querySelector<HTMLElement>('button')?.focus(); return }
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    e.stopPropagation() // sonst blättert App.tsx die Folie
    const l = [...wrap.current!.querySelectorAll<HTMLElement>('[role=menuitem]')]
    l[(l.indexOf(document.activeElement as HTMLElement) + d + l.length) % l.length]?.focus()
  }

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
          <div className="obj-rewrite" ref={wrap} onKeyDown={menuKey} onBlur={(e) => { if (open && !wrap.current?.contains(e.relatedTarget as Node)) setOpen(false) }}>
            <button className={`plain ${open ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label="Umschreiben" title="Text von der KI umschreiben" disabled={busy} onClick={() => setOpen(!open)}><WandSparkles size={15} /></button>
            {open && (
              <div className={`menu material ${place.up ? 'up' : ''} ${place.right ? 'right' : ''}`} role="menu" aria-label="Umschreiben" style={place.max ? { maxHeight: place.max } : undefined}>
                {MENU.map(([label, task], i) => (
                  <Fragment key={label}>
                    {i === REWRITE.length && <><hr /><span className="menu-cap" role="presentation">Übersetzen</span></>}
                    <button role="menuitem" onClick={() => { setOpen(false); onRewrite(`${task} ${GUARD}`) }}>{label}</button>
                  </Fragment>
                ))}
              </div>
            )}
          </div>
          <i aria-hidden="true" />
        </>
      )}
      <button className="plain" aria-label="Alle Einstellungen" title="Anpassen" onClick={onMore}><SlidersHorizontal size={15} /></button>
      <button className="plain tint" onClick={onAsk}><Sparkles size={15} />Frag Deckwerk</button>
    </div>
  )
}
