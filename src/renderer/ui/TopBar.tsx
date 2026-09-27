// Kopfleiste im Editor: zurück zu den Decks, Titel mit Zustand, Einfügen/Anpassen/Look, Export, Präsentieren.
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, LayoutGrid, PanelLeft, Palette, Play, Plus, RectangleHorizontal, Share, SlidersHorizontal } from 'lucide-react'

export interface Status { text: string; error?: boolean }
export type Panel = 'insert' | 'format' | null
export type View = 'slide' | 'grid'
type Format = 'pptx' | 'pdf' | 'png'

const FORMAT: Record<Format, string> = { pptx: 'PowerPoint (.pptx)', pdf: 'PDF', png: 'Bilder (.png)' }

interface Props {
  title: string
  path: string | null
  saved: boolean // automatisch gesichert
  status: Status | null
  hasDeck: boolean
  nav: boolean
  onNav: () => void
  panel: Panel
  onPanel: (p: Panel) => void
  view: View
  onView: (v: View) => void
  onAddSlide: () => void
  onHome: () => void
  onLook: () => void
  onExport: (format: Format) => void
  onFormats: () => void // Sheet „Formate“ (Quadrat, Story, A4 …)
  onPresent: () => void
}

export function TopBar(p: Props) {
  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(false) }
    addEventListener('pointerdown', close)
    return () => removeEventListener('pointerdown', close)
  }, [menu])
  const toggle = (x: Panel) => p.onPanel(p.panel === x ? null : x)
  const state = p.status?.text ?? (!p.hasDeck ? '' : !p.saved ? 'Bearbeitet' : p.path ? 'Gespeichert' : 'Nicht gespeichert')

  return (
    <header className="top">
      <div className="top-l">
        <button className="plain" aria-label="Folienübersicht ein- oder ausblenden" aria-pressed={p.nav} disabled={p.view === 'grid'} onClick={p.onNav}><PanelLeft size={18} /></button>
        <button className="plain tint" onClick={p.onHome}><ChevronLeft size={16} />Decks</button>
        <div className="seg icons" role="group" aria-label="Ansicht">
          <button aria-pressed={p.view === 'slide'} aria-label="Einzelne Folie" title="Einzelne Folie" disabled={!p.hasDeck} onClick={() => p.onView('slide')}><RectangleHorizontal size={15} /></button>
          <button aria-pressed={p.view === 'grid'} aria-label="Übersicht aller Folien" title="Übersicht aller Folien" disabled={!p.hasDeck} onClick={() => p.onView('grid')}><LayoutGrid size={15} /></button>
        </div>
      </div>
      <div className="top-title" title={p.path ?? undefined}>
        <b>{p.title}</b>
        {state && <span className={p.status?.error ? 'error' : undefined} role="status">— {state}</span>}
      </div>
      <div className="top-r">
        {p.view === 'grid' ? (
          <button className="plain" disabled={!p.hasDeck} onClick={p.onAddSlide}><Plus size={17} />Neue Folie</button>
        ) : (
          <>
            <button className={`plain ${p.panel === 'insert' ? 'on' : ''}`} aria-pressed={p.panel === 'insert'} disabled={!p.hasDeck} onClick={() => toggle('insert')}><Plus size={17} />Einfügen</button>
            <button className={`plain ${p.panel === 'format' ? 'on' : ''}`} aria-pressed={p.panel === 'format'} disabled={!p.hasDeck} onClick={() => toggle('format')}><SlidersHorizontal size={17} />Anpassen</button>
          </>
        )}
        <button className="plain" disabled={!p.hasDeck} onClick={p.onLook}><Palette size={17} />Look</button>
        <div className="top-export" ref={box}>
          <button className="plain" disabled={!p.hasDeck} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}><Share size={17} />Exportieren</button>
          {menu && (
            <div className="menu material" role="menu">
              {(Object.keys(FORMAT) as Format[]).map((f) => (
                <button key={f} role="menuitem" onClick={() => { setMenu(false); p.onExport(f) }}>{FORMAT[f]}</button>
              ))}
              <hr />
              <button role="menuitem" onClick={() => { setMenu(false); p.onFormats() }}>Anderes Format …</button>
            </div>
          )}
        </div>
        <button className="pill tint" disabled={!p.hasDeck} onClick={p.onPresent} title="Präsentieren (F5)"><Play size={12} fill="currentColor" />Präsentieren</button>
      </div>
    </header>
  )
}
