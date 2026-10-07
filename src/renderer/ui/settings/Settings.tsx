// Einstellungen: eigene Seite über dem ganzen Fenster, links die Navigation, rechts der aktive Abschnitt. Die Einrichtung (SetupSheet) bleibt für den ersten Start.
import { useEffect, useRef, useState, type ComponentType } from 'react'
import { ChevronLeft, Cloud, Image, Info, Palette, Sparkles, SquareTerminal, type LucideIcon } from 'lucide-react'
import { AgentenSection } from './AgentenSection'
import { AllgemeinSection } from './AllgemeinSection'
import { BilderSection } from './BilderSection'
import { CloudSection } from './CloudSection'
import { KiSection } from './KiSection'
import { MarkeSection } from './MarkeSection'
import type { SectionId, SectionProps } from './parts'
import './settings.css'

const SECTIONS: { id: SectionId; name: string; Icon: LucideIcon; Page: ComponentType<SectionProps> }[] = [
  { id: 'ki', name: 'KI-Zugang', Icon: Sparkles, Page: KiSection },
  { id: 'cloud', name: 'Cloud', Icon: Cloud, Page: CloudSection },
  { id: 'bilder', name: 'Bilder', Icon: Image, Page: BilderSection },
  { id: 'marke', name: 'Marke', Icon: Palette, Page: MarkeSection },
  { id: 'agenten', name: 'Agenten', Icon: SquareTerminal, Page: AgentenSection },
  { id: 'allgemein', name: 'Allgemein', Icon: Info, Page: AllgemeinSection },
]

export function Settings({ section, model, onModel, onChanged, onClose }: { section?: SectionId; model: string; onModel: (id: string) => void; onChanged: () => void; onClose: () => void }) {
  const [cur, setCur] = useState<SectionId>(section ?? 'ki')
  const nav = useRef<HTMLElement>(null)
  useEffect(() => nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus(), [])
  // Esc am document: wirkt auch, wenn der Fokus nach einem verschwundenen Knopf auf body liegt.
  // Offene Select-Menüs und Dialoge (confirmDialog, KeyDialog) schließen zuerst sich selbst.
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]') || (e.target instanceof Element && e.target.closest('.kit-menu'))) return
      e.stopPropagation() // Editor (window-Listener) soll Esc nicht zusätzlich verarbeiten
      onClose()
    }
    document.addEventListener('keydown', esc)
    return () => document.removeEventListener('keydown', esc)
  }, [onClose])
  const { Page } = SECTIONS.find((s) => s.id === cur)!
  return (
    // übrige Tasten nicht an die Kürzel des Editors durchreichen; Esc muss bis zum document
    <div className="settings" role="dialog" aria-modal="true" aria-label="Einstellungen"
      onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation() }}>
      <header className="top">
        <div className="top-l"><button type="button" className="plain tint" onClick={onClose}><ChevronLeft size={16} />Zurück</button></div>
        <b>Einstellungen</b>
        <div className="top-r"><button type="button" className="pill tint" onClick={onClose}>Fertig</button></div>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" ref={nav} aria-label="Abschnitte">
          {SECTIONS.map(({ id, name, Icon }) => (
            <button key={id} type="button" aria-current={id === cur ? 'page' : undefined} onClick={() => setCur(id)}><Icon size={16} />{name}</button>
          ))}
        </nav>
        <div className="settings-page" key={cur}><Page model={model} onModel={onModel} onChanged={onChanged} go={setCur} /></div>
      </div>
    </div>
  )
}
