// Übersicht aller Tastenkürzel und Mausgesten; öffnet mit „?“ oder über den Knopf in der Kopfleiste (TopBar).
import { useEffect, useRef } from 'react'

const GROUPS: { name: string; keys: [string, string][] }[] = [
  { name: 'Allgemein', keys: [
    ['Strg+S', 'Speichern'], ['Strg+Z', 'Rückgängig'], ['Strg+Umschalt+Z oder Strg+Y', 'Wiederholen'], ['/', 'Wunsch an die KI'],
    ['?', 'Diese Übersicht'], ['F5', 'Präsentieren ab Folie 1'], ['Umschalt+F5', 'Präsentieren ab dieser Folie'],
    ['← → bzw. Bild↑ Bild↓', 'Folie wechseln (wenn nichts ausgewählt ist)'],
  ] },
  { name: 'Ansicht', keys: [['Strg+Mausrad oder Strg+Plus/Minus', 'Zoomen'], ['Strg+0', 'Einpassen']] },
  { name: 'Einfügen', keys: [
    ['T', 'Text'], ['R', 'Rechteck'], ['C', 'Kreis'], ['L', 'Linie'], ['Strg+V', 'Einfügen (auch Bilder aus der Zwischenablage)'],
    ['Dateien auf die Folie ziehen', 'Bild, Video oder Audio einfügen'],
  ] },
  { name: 'Elemente', keys: [
    ['Klick', 'Auswählen'], ['Umschalt+Klick', 'Zur Auswahl hinzufügen'], ['Rahmen aufziehen', 'Mehrere auswählen'], ['Strg+A', 'Alle auswählen'],
    ['Tab / Umschalt+Tab', 'Nächstes / voriges Element'], ['Pfeiltasten', 'Verschieben (mit Umschalt 10 px)'],
    ['Umschalt beim Ziehen', 'Nur waagerecht oder senkrecht'], ['Alt beim Ziehen', 'Kopie ziehen'], ['Strg beim Ziehen', 'Ohne Einrasten'],
    ['Umschalt an einer Ecke', 'Seitenverhältnis frei bzw. fest'], ['Umschalt beim Drehen', 'In 15°-Schritten'],
    ['Doppelklick', 'Text bearbeiten, Bild zuschneiden, in Gruppe wählen'], ['Enter', 'Text bearbeiten'], ['Esc', 'Auswahl aufheben'],
    ['Entf', 'Löschen'], ['Strg+C / Strg+X', 'Kopieren / Ausschneiden'], ['Strg+D', 'Duplizieren'], ['Strg+G', 'Gruppieren'],
    ['Strg+Umschalt+G', 'Gruppierung aufheben'], ['Strg+L', 'Sperren'], ['Strg+] / Strg+[', 'Eine Ebene nach vorne / hinten'],
    ['Strg+Umschalt+] / [', 'Ganz nach vorne / hinten'], ['Strg+Alt+C', 'Stil kopieren'], ['Strg+Alt+V', 'Stil übertragen'],
  ] },
  { name: 'Text', keys: [
    ['Strg+B', 'Fett'], ['Strg+I', 'Kursiv'], ['Strg+U', 'Unterstrichen'], ['Strg+Umschalt+K', 'Großbuchstaben'],
    ['Strg+Umschalt+L / C / R', 'Links / mittig / rechts'], ['Strg+Umschalt+, / .', 'Kleiner / größer'],
  ] },
  { name: 'Zuschneiden', keys: [['Enter', 'Übernehmen'], ['Esc', 'Verwerfen']] },
  { name: 'Folien im Filmstreifen', keys: [
    ['Rechtsklick', 'Folienmenü'], ['Strg+C / Strg+V', 'Folie kopieren / einfügen'], ['Strg+D', 'Duplizieren'], ['Entf', 'Löschen'], ['Ziehen', 'Umsortieren'],
  ] },
  { name: 'Raster-Ansicht', keys: [
    ['Strg+Klick', 'Einzeln auswählen'], ['Umschalt+Klick', 'Bereich auswählen'], ['Strg+A', 'Alle auswählen'],
    ['Strg+C / Strg+V', 'Kopieren / einfügen'], ['Entf', 'Löschen'], ['Doppelklick', 'Folie öffnen'],
  ] },
  { name: 'Präsentieren', keys: [
    ['→ / Leertaste / Klick', 'Weiter'], ['← / Rechtsklick', 'Zurück'], ['Pos1 / Ende', 'Erste / letzte Folie'], ['Zahl + Enter', 'Zu Folie springen'],
    ['B', 'Pause (Folie unscharf)'], ['P', 'Referentenansicht'], ['L', 'Laserpointer'], ['D', 'Stift'], ['E', 'Zeichnung löschen'], ['Esc', 'Beenden'],
  ] },
]

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])
  return (
    <div className="look" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Tastenkürzel"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }}>
      <header className="top">
        <div className="top-l" />
        <b>Tastenkürzel</b>
        <div className="top-r"><button className="plain tint" onClick={onClose}>Schließen</button></div>
      </header>
      <div className="keys-body" onClick={(e) => { if (!(e.target as HTMLElement).closest('h2, dt, dd')) onClose() }}>
        <div className="keys-cols">
          {GROUPS.map((g) => (
            <section key={g.name}>
              <h2>{g.name}</h2>
              <dl>{g.keys.map(([k, d]) => <div key={k + d}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>)}</dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
