// Startbildschirm: eine Frage, ein Feld. Darunter Beispiele, „Leer beginnen“ und die zuletzt bearbeiteten Decks.
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Paperclip, Settings, X } from 'lucide-react'
import type { Deck } from '../../shared/deck'
import { SlideView } from '../slide'
import { ModelSelect } from './Chat'
import { Logo } from './Logo'

// Angehängtes Dokument (Start und KI-Leiste): Text geht nur an die KI, der Chat zeigt Wunsch und Dateiname
export type Source = { name: string; text: string; cut: boolean }
export const sourceContext = (s: Source) => `Quellmaterial aus „${s.name}“${s.cut ? ' (gekürzt)' : ''}. Inhalte und Zahlen von dort verwenden, nichts dazuerfinden; genannte Bilder (asset://…) direkt als Bildquelle nutzen:\n<quelle>\n${s.text}\n</quelle>`
export function useSource() {
  const [src, setSrc] = useState<Source | null>(null)
  const [err, setErr] = useState('')
  const attach = (path?: string) => { setErr(''); window.api.readSource(path).then((s) => s && setSrc(s), (e: Error) => setErr(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))) }
  return { src, setSrc, err, attach }
}

interface Recent { path: string; title: string; mtime: number; deck: Deck }

const EXAMPLES: [string, string][] = [
  ['Pitch für ein Schul-Start-up', 'Erstelle einen 10-Folien-Pitch für Ortho-Bot, ein KI-Rechtschreibtool für Schulen – Zielgruppe Geschäftsführung'],
  ['Projektstatus für die Geschäftsführung', 'Projektstatus für die Geschäftsführung: ERP-Migration zu 70 % fertig, Budget im Plan, ein Risiko beim Datenimport'],
  ['Strategie 2027 fürs Vertriebsteam', 'Strategie 2027 für unser Vertriebsteam: drei Wachstumshebel, Roadmap und Budget, etwa 12 Folien'],
]

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
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { window.api.recent(8).then(setRecent, () => setRecent([])) }, [])
  const { src, setSrc, err, attach } = useSource()
  const submit = () => {
    const ask = text.trim() || (!src ? '' : /\.pptx$/i.test(src.name)
      ? 'Übernimm diese PowerPoint als Deck: gleiche Folien in gleicher Reihenfolge, gleiche Aussagen, die eigenen Bilder, passende Layouts und ein stimmiges Design.'
      : 'Mach aus diesem Dokument eine Präsentation.')
    if (onSubmit(src ? `${ask} · ${src.name}` : ask, src ? sourceContext(src) : undefined)) { setText(''); setSrc(null) }
  }

  return (
    <div className="home">
      <header className="top">
        <div className="home-brand"><Logo size={22} />Deckwerk</div>
        <span />
        <div className="top-r">
          <button className="plain tint" onClick={onOpen}>Deck öffnen …</button>
          <button className="plain" aria-label="Einrichtung" title="Einrichtung: KI-Zugang und Claude Code" onClick={onKey}><Settings size={17} /></button>
        </div>
      </header>

      <main className="home-main">
        <h1>Was möchtest du zeigen?</h1>
        <p className="home-sub">Ein Satz genügt. Deckwerk schreibt die Storyline, baut die Folien und prüft jede einzelne.</p>
        <form className="home-field" onSubmit={(e) => { e.preventDefault(); submit() }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { const f = e.dataTransfer.files[0]; if (f) { e.preventDefault(); attach(window.api.pathOf(f)) } }}>
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
              {src
                ? <span className="pill" title={src.cut ? 'Zu lang, die KI bekommt den Anfang' : undefined}><Paperclip size={13} />{src.name}<button type="button" className="plain" aria-label="Anhang entfernen" onClick={() => setSrc(null)}><X size={13} /></button></span>
                : <button type="button" className="plain" title="Dokument als Grundlage anhängen: Text, Markdown, Word, PowerPoint, PDF (oder hierher ziehen)" onClick={() => attach()}><Paperclip size={16} />Datei</button>}
              {err && <span className="home-err error" role="alert">{err}</span>}
            </div>
            <button type="submit" className="round" aria-label="Deck erstellen" disabled={!text.trim() && !src}><ArrowUp size={18} strokeWidth={2.4} /></button>
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
            {recent.map((r) => (
              <button key={r.path} className="home-deck" onClick={() => onOpenPath(r.path)}>
                <div className="home-deck-cover"><SlideView deck={r.deck} index={0} width={232} /></div>
                <b>{r.title}</b>
                <span>{when(r.mtime)} · {r.deck.slides.length} Folien</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
