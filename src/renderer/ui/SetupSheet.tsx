// Einrichtung beim ersten Start: Willkommen → KI-Zugang (dieselben Konten wie in den Einstellungen) → Fertig.
// Alles Weitere (Modell, Agenten, Bilder, Cloud …) steht in den Einstellungen; „Alle Einstellungen“ springt dorthin.
import { useContext, useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, FileDown, HardDrive, MousePointerClick, Sparkles, Wand2 } from 'lucide-react'
import { Logo } from './Logo'
import { KiZugang } from './settings/KiSection'
import { OpenSettings } from './settings/parts'

const STEPS = ['Willkommen', 'KI-Zugang', 'Fertig']

/** start: Schritt, mit dem die Einrichtung aufgeht (z. B. „KI-Zugang“ aus dem Key-Dialog) */
interface Props { model: string; onModel: (id: string) => void; onKeySaved: () => void; onClose: () => void; start?: string }

export function SetupSheet({ model, onModel, onKeySaved, onClose, start }: Props) {
  const [step, setStep] = useState(() => Math.max(0, STEPS.indexOf(start ?? '')))
  const openSettings = useContext(OpenSettings)
  // Für die Fertig-Seite: irgendein Zugang da?
  const [bereit, setBereit] = useState(false)
  useEffect(() => {
    if (step === STEPS.length - 1) void window.api.setupStatus().then((s) => setBereit(s.key || s.clis.some((c) => c.found && c.login !== false)))
  }, [step])
  const next = () => setStep((x) => Math.min(STEPS.length - 1, x + 1))

  const pages: ReactNode[] = [
    <>
      <Logo size={56} />
      <h1 id="setup-title">Willkommen bei Deckwerk</h1>
      <p className="setup-sub">Sag in einem Satz, was du zeigen willst. Deckwerk baut daraus eine fertige Präsentation.</p>
      <ul className="setup-feats">
        <li><Wand2 size={18} /><span><b>Aus einem Satz eine Präsentation</b>Deckwerk denkt sich die Geschichte aus, gestaltet die Folien und prüft jede einzelne.</span></li>
        <li><MousePointerClick size={18} /><span><b>Alles bleibt änderbar</b>Klick auf eine Folie und ändere Text, Bilder und Farben, oder sag einfach, was anders sein soll.</span></li>
        <li><FileDown size={18} /><span><b>Als PowerPoint oder PDF</b>Weitergeben, weiterbearbeiten oder direkt aus Deckwerk vortragen.</span></li>
        <li><HardDrive size={18} /><span><b>Deine Dateien bleiben bei dir</b>Präsentationen liegen als Datei auf deinem Rechner. Ein Konto bei uns gibt es nicht.</span></li>
      </ul>
    </>,
    <>
      <h1 id="setup-title">Woher kommt die KI?</h1>
      <p className="setup-sub">Deckwerk denkt mit einer KI, die du schon hast oder schnell einrichtest. Ein Weg reicht, ändern kannst du ihn jederzeit.</p>
      <KiZugang model={model} onModel={onModel} onChanged={onKeySaved} />
    </>,
    <>
      <Logo size={56} />
      <h1 id="setup-title">{bereit ? 'Alles bereit' : 'Schau dich ruhig erst um'}</h1>
      <p className="setup-sub">{bereit
        ? 'Schreib auf dem Startbildschirm in einem Satz, was du zeigen willst, zum Beispiel „Quartalsbericht für die Geschäftsführung, 8 Folien“. Den Rest macht Deckwerk.'
        : 'Ohne KI-Zugang kannst du Vorlagen öffnen, bearbeiten, präsentieren und exportieren. Den Zugang richtest du später über das Zahnrad oben rechts ein.'}</p>
      <div className="setup-keys">
        <span><kbd>/</kbd> Wunsch an die KI</span><span><kbd>F5</kbd> Präsentieren</span><span><kbd>P</kbd> Referentenansicht</span><span><kbd>Strg</kbd>+<kbd>Z</kbd> Rückgängig</span>
      </div>
    </>,
  ]

  return (
    <div className="setup" role="dialog" aria-modal="true" aria-labelledby="setup-title"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation() }}>
      <div className="setup-card material">
        <ol className="setup-steps" aria-label="Schritte">
          {STEPS.map((t, i) => (
            <li key={t}><button className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>{t}</button></li>
          ))}
          <li><button className="setup-mehr" title="Modell, Cloud, Bilder, Marke und Agenten" onClick={() => { openSettings('ki'); onClose() }}>Alle Einstellungen</button></li>
        </ol>
        <div className="setup-page" key={step}>{pages[step]}</div>
        <div className="setup-nav">
          {step > 0 ? <button className="plain" onClick={() => setStep(step - 1)}><ArrowLeft size={15} />Zurück</button> : <button className="plain" onClick={onClose}>Überspringen</button>}
          {step < STEPS.length - 1
            ? <button className="pill tint" onClick={next}>{step === 0 ? 'Einrichten' : 'Weiter'}</button>
            : <button className="pill tint" onClick={onClose}><Sparkles size={15} />{bereit ? 'Erstes Deck erstellen' : 'Vorlagen ansehen'}</button>}
        </div>
      </div>
    </div>
  )
}
