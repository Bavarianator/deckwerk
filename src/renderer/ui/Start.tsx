// Startbildschirm: eine Frage, ein Feld. Darunter Beispiele, „Leer beginnen“, die zuletzt bearbeiteten Decks (auch per MCP gebaute) und Vorlagen.
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Image as ImageIcon, Paperclip, Settings, X } from 'lucide-react'
import { profileOf, type Deck } from '../../shared/deck'
import { SlideView } from '../slide'
import { ModelSelect } from './Chat'
import { Logo } from './Logo'

// Angehängte Dateien (Start und KI-Leiste): Text geht nur an die KI, der Chat zeigt Wunsch und Dateinamen
export type Source = { name: string; text: string; cut: boolean }
export const isImage = (name: string) => /\.(png|jpe?g|webp|gif|svg)$/i.test(name)
// Gesamtbudget: viele Dateien sprengen sonst das Kontextfenster; gekürzt wird an der Zeilengrenze (Bild-Zeilen bleiben ganz)
export const sourceContext = (srcs: Source[]) => srcs.map((s) => {
  const max = Math.min(60_000, Math.floor(120_000 / srcs.length)), cut = s.cut || s.text.length > max
  return `Quellmaterial aus „${s.name}“${cut ? ' (gekürzt)' : ''}. Inhalte und Zahlen von dort verwenden, nichts dazuerfinden:\n<quelle>\n${s.text.length > max ? s.text.slice(0, max).replace(/\n[^\n]*$/, '') : s.text}\n</quelle>`
}).join('\n\n')
  + '\n\nBilder (Zeilen „Bild: asset://…“) vor dem Einbauen mit find_images ansehen (url = dieser Pfad). Ein Logo gehört ins Brand-Kit (update_deck brand) und steht dann nur auf Titel- und Schlussfolie, nie auf jeder Folie; Fotos und Abbildungen als Bildquelle der passenden Folie. Nichts dazuerfinden.'
export function useSource() {
  const [srcs, setSrcs] = useState<Source[]>([])
  const [err, setErr] = useState('')
  const attach = (paths?: string[]) => {
    if (paths && !(paths = paths.filter(Boolean)).length) return // gezogen ohne Datei (z. B. Text aus dem Browser)
    setErr('')
    // gleicher Name: der zuletzt angehängte gilt, auch innerhalb einer Auswahl
    window.api.readSource(paths).then((r) => {
      if (!r) return
      setSrcs((old) => [...old, ...r.srcs].filter((s, i, all) => all.findLastIndex((x) => x.name === s.name) === i))
      setErr(r.errors.join(' · '))
    }, (e: Error) => setErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
  }
  return { srcs, attach, remove: (name: string) => setSrcs((old) => old.filter((o) => o.name !== name)), clear: () => setSrcs([]), err }
}

interface Recent { path: string; title: string; mtime: number; deck: Deck }

const EXAMPLES: [string, string][] = [
  ['Pitch für ein Schul-Start-up', 'Erstelle einen 10-Folien-Pitch für Ortho-Bot, ein KI-Rechtschreibtool für Schulen – Zielgruppe Geschäftsführung'],
  ['Projektstatus für die Geschäftsführung', 'Projektstatus für die Geschäftsführung: ERP-Migration zu 70 % fertig, Budget im Plan, ein Risiko beim Datenimport'],
  ['Strategie 2027 fürs Vertriebsteam', 'Strategie 2027 für unser Vertriebsteam: drei Wachstumshebel, Roadmap und Budget, etwa 12 Folien'],
  ['Flyer für ein Sommerfest', 'Gestalte einen Flyer (A4) für unser Sommerfest am 12. Juli ab 15 Uhr im Innenhof: Musik, Grill, Kinderprogramm – Anmeldung über unsere Webseite'],
]

// A4 (Flyer, Fließtext) zählt Seiten, alles andere Folien
const pages = (d: Deck) => {
  const n = d.slides.length
  return `${n} ${profileOf(d) === 'doc' ? (n === 1 ? 'Seite' : 'Seiten') : n === 1 ? 'Folie' : 'Folien'}`
}

const day = (t: number) => new Date(new Date(t).toDateString()).getTime()
const when = (t: number) => {
  const days = Math.round((day(Date.now()) - day(t)) / 864e5)
  return days === 0 ? 'Heute' : days === 1 ? 'Gestern' : new Date(t).toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })
}

interface Props {
  onSubmit: (text: string, context?: string) => boolean
  model: string
  onModel: (id: string) => void
  onBlank: () => void
  onOpen: () => void
  onOpenPath: (path: string) => void
  onKey: () => void
}

export function Start({ onSubmit, model, onModel, onBlank, onOpen, onOpenPath, onKey }: Props) {
  const [text, setText] = useState('')
  const [recent, setRecent] = useState<Recent[]>([])
  const [all, setAll] = useState(false)
  const [templates, setTemplates] = useState<Deck[]>([])
  useEffect(() => { window.api.templates().then(setTemplates, () => setTemplates([])) }, [])
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    // bei jedem Fokus neu: Decks, die Claude Code oder Codex per MCP speichern, erscheinen ohne Neustart
    // alle holen, gezeigt werden 8 bis „Alle anzeigen“; Fehler: alte Liste bleibt
    const load = () => window.api.recent(Infinity).then(setRecent, () => {})
    void load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])
  const { srcs, attach, remove, clear, err } = useSource()
  const submit = () => {
    const ask = text.trim() || (!srcs.length ? '' : srcs.length === 1 && /\.pptx$/i.test(srcs[0].name)
      ? 'Übernimm diese PowerPoint als Deck: gleiche Folien in gleicher Reihenfolge, gleiche Aussagen, die eigenen Bilder, passende Layouts und ein stimmiges Design.'
      : 'Mach aus diesen Dateien eine Präsentation.')
    if (onSubmit(srcs.length ? `${ask} · ${srcs.map((s) => s.name).join(', ')}` : ask, srcs.length ? sourceContext(srcs) : undefined)) { setText(''); clear() }
  }

  return (
    <div className="home">
      <header className="top">
        <div className="home-brand"><Logo size={22} />Deckwerk</div>
        <span />
        <div className="top-r">
          <button className="plain tint" onClick={onOpen}>Deck öffnen …</button>
          <button className="plain" aria-label="Einrichtung" title="Einrichtung: KI-Zugang, Modelle, Agenten und Bilder" onClick={onKey}><Settings size={17} /></button>
        </div>
      </header>

      <main className="home-main">
        <h1>Was möchtest du zeigen?</h1>
        <p className="home-sub">Ein Satz genügt. Deckwerk denkt sich die Geschichte aus, gestaltet die Folien und prüft jede einzelne.</p>
        <form className="home-field" onSubmit={(e) => { e.preventDefault(); submit() }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { const f = [...e.dataTransfer.files]; if (f.length) { e.preventDefault(); attach(f.map(window.api.pathOf)) } }}>
          <textarea
            ref={ref}
            autoFocus
            rows={2}
            value={text}
            aria-label="Worum geht es in deiner Präsentation?"
            placeholder="Zum Beispiel: Quartalsbericht für die Geschäftsführung, 8 Folien, Fokus auf Wachstum"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          />
          <div className="home-field-bar">
            <div className="home-field-l">
              <ModelSelect value={model} onChange={onModel} />
              {srcs.map((s) => (
                <span key={s.name} className="pill" title={s.cut ? 'Zu lang, die KI bekommt den Anfang' : undefined}>{isImage(s.name) ? <ImageIcon size={13} /> : <Paperclip size={13} />}{s.name}<button type="button" className="plain" aria-label={`${s.name} entfernen`} onClick={() => remove(s.name)}><X size={13} /></button></span>
              ))}
              <button type="button" className="plain" title="Dateien anhängen: Text, Word, PowerPoint, PDF oder Bilder (oder hierher ziehen)" onClick={() => attach()}><Paperclip size={16} />Datei</button>
              {err && <span className="home-err error" role="alert">{err}</span>}
            </div>
            <button type="submit" className="round" aria-label="Deck erstellen" disabled={!text.trim() && !srcs.length}><ArrowUp size={18} strokeWidth={2.4} /></button>
          </div>
        </form>
        <div className="home-chips">
          {EXAMPLES.map(([label, full]) => <button key={label} className="pill" onClick={() => { setText(full); ref.current?.focus() }}>{label}</button>)}
        </div>
        <button className="plain tint home-blank" onClick={onBlank}>Leer beginnen und frei gestalten</button>
      </main>

      {recent.length > 0 && (
        <section className="home-recent" aria-label="Zuletzt">
          <h2>Zuletzt</h2>
          <div className="home-shelf">
            {(all ? recent : recent.slice(0, 8)).map((r) => (
              <button key={r.path} className="home-deck" onClick={() => onOpenPath(r.path)}>
                <div className="home-deck-cover"><SlideView deck={r.deck} index={0} width={232} /></div>
                <b>{r.title}</b>
                <span>{when(r.mtime)} · {pages(r.deck)}</span>
              </button>
            ))}
          </div>
          {recent.length > 8 && <button className="plain tint home-more" onClick={() => setAll(!all)}>{all ? 'Weniger anzeigen' : `Alle anzeigen (${recent.length})`}</button>}
        </section>
      )}

      {templates.length > 0 && (
        <section className="home-recent" aria-label="Vorlagen">
          <h2>Mit einer Vorlage beginnen</h2>
          <div className="home-shelf">
            {templates.map((d) => (
              <button key={d.title} className="home-deck" title="Öffnet eine Kopie, die Vorlage bleibt unverändert" onClick={() => window.api.saveCopy(d).then(onOpenPath)}>
                <div className="home-deck-cover"><SlideView deck={d} index={0} width={232} /></div>
                <b>{d.title}</b>
                <span>{pages(d)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
