// Startbildschirm: eine Frage, ein Feld. Darunter Beispiele, „Leer beginnen“, die zuletzt bearbeiteten Decks (auch per MCP gebaute) und Vorlagen.
import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Image as ImageIcon, Paperclip, Settings, X } from 'lucide-react'
import { FORMATS, VIDEO_FILE, profileOf, type Deck, type FormatId, type Size } from '../../shared/deck'
import { SlideView } from '../slide'
import { ModelSelect } from './Chat'
import { Select } from './kit'
import { Logo } from './Logo'
import { CloudButton } from './settings/CloudSection'

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
// Datei-Chips der KI-Leisten (AskBar, Deckvid) samt Lesefehler
export function SourceChips({ srcs, remove, err }: { srcs: Source[]; remove: (name: string) => void; err: string }) {
  return <>
    {srcs.map((s) => (
      <span key={s.name} className="cap-token file" title={s.cut ? `${s.name} (zu lang, die KI bekommt den Anfang)` : s.name}>
        {isImage(s.name) ? <ImageIcon size={11} /> : <Paperclip size={11} />}<span>{s.name}</span>
        <button type="button" aria-label={`${s.name} entfernen`} onClick={() => remove(s.name)}><X size={11} strokeWidth={2.6} /></button>
      </span>
    ))}
    {err && <span className="cap-token error" role="alert" title={err}>{err}</span>}
  </>
}

interface Recent { path: string; title: string; mtime: number; deck: Deck }

// Dritter Eintrag: Format, das der Chip mitsetzt
const EXAMPLES: [string, string, string?][] = [
  ['Pitch für ein Schul-Start-up', 'Erstelle einen 10-Folien-Pitch für Ortho-Bot, ein KI-Rechtschreibtool für Schulen – Zielgruppe Geschäftsführung'],
  ['Projektstatus für die Geschäftsführung', 'Projektstatus für die Geschäftsführung: ERP-Migration zu 70 % fertig, Budget im Plan, ein Risiko beim Datenimport'],
  ['Strategie 2027 fürs Vertriebsteam', 'Strategie 2027 für unser Vertriebsteam: drei Wachstumshebel, Roadmap und Budget, etwa 12 Folien'],
  ['Flyer für ein Sommerfest', 'Gestalte einen Flyer (A4) für unser Sommerfest am 12. Juli ab 15 Uhr im Innenhof: Musik, Grill, Kinderprogramm – Anmeldung über unsere Webseite', 'flyer'],
]

// Video-Chips: Label, Wunsch im Feld, ask geht unsichtbar an die KI (Abläufe: Design-Guide §11)
export const VIDEO_EXAMPLES: [string, string, string][] = [
  ['5 Shorts', 'Mach aus meinem Video 5 Shorts mit Hook und Untertiteln.',
    'Ablauf Shorts (Guide §11, Ablauf 1): create_deck format 9:16, transition none. transcribe_video, die 5 stärksten Momente (ideal 55–75 s, Schnitte nur an Segmentgrenzen) vorab kurz mit Zeiten nennen. Je Short ein clip mit Hook (max. 70 Zeichen), captions wort, style lebendig, fit crop mit Zuschnitt aufs Gesicht (ohne focus). Am Ende export_deck mit clips. Fehlt ein Video oder Link, frag zuerst kurz danach (Video anhängen oder Link einfügen).'],
  ['Ganzes Video kürzen', 'Kürze mein ganzes Video: Füllsätze, Versprecher und Abschweifungen raus.',
    'Ablauf Fulltime (Guide §11, Ablauf 2): create_deck format 16:9, transition none. transcribe_video mit all: true über alles, Gestrichenes kurz nennen. Eine einzige clip-Folie mit allen behaltenen Ausschnitten als parts, pauses kurz, captions satz, kein Hook. Am Ende export_deck mit mp4. Fehlt ein Video oder Link, frag zuerst kurz danach (Video anhängen oder Link einfügen).'],
  ['Highlights aus dem Stream', 'Finde die besten Momente in meinem Stream und mach daraus Shorts.',
    'Ablauf Stream-Highlights (Guide §11, Ablauf 3): import_video bei Link, dann zuerst video_highlights. Nur die besten Fenster mit from/to transkribieren, nie den ganzen Stream. 5 Shorts im Format 9:16 wie im Ablauf Shorts; zusätzlich optional ein 16:9-Zusammenschnitt der Highlights. Am Ende export_deck mit clips (Zusammenschnitt: mp4). Fehlt ein Video oder Link, frag zuerst kurz danach (Video anhängen oder Link einfügen).'],
  ['Zusammenschnitt', 'Schneide meine Videos zu einem Zusammenschnitt zusammen.',
    'Ablauf Kompilation (Guide §11, Ablauf 4): create_deck format 16:9, transition none. Je Quelle transcribe_video und eine clip-Folie, dazwischen kurze Zwischentitel (Layout section), transition fade nur sparsam an Zwischentiteln. Musik über find_music nur auf Wunsch, dezent. Am Ende export_deck mit mp4. Fehlt ein Video oder Link, frag zuerst kurz danach (Video anhängen oder Link einfügen).'],
]
const LINK = /https?:\/\/[^\s<>"']+/g
const linksOf = (text: string) => [...new Set((text.match(LINK) ?? []).map((u) => u.replace(/[.,;:!?)\]]+$/, '')))]
// Nur Video-Links schalten in den Video-Modus, ein Quellenlink für eine Präsentation nicht
const VIDEO_HOST = /^https?:\/\/([^/?#]*\.)?(youtube\.com|youtu\.be|twitch\.tv|kick\.com|vimeo\.com)([/:?#]|$)/i
const isVideoLink = (u: string) => VIDEO_HOST.test(u) || VIDEO_FILE.test(u.replace(/[?#].*/, ''))

// Formatwahl neben dem Modell: ask geht unsichtbar an die KI, format gilt für „Leer beginnen“ (ohne = 16:9)
const FORMAT_CHOICES: { id: string; name: string; hint: string; format?: FormatId; ask?: string }[] = [
  { id: 'auto', name: 'Automatisch', hint: 'Deckwerk wählt passend zu deinem Wunsch' },
  { id: 'praesentation', name: 'Präsentation', hint: '16:9 für Beamer und Bildschirm', ask: 'Format: Präsentation 16:9 (create_deck format 16:9).' },
  { id: 'flyer', name: 'Flyer', hint: 'A4 hoch, zum Drucken', format: 'a4', ask: 'Format: Flyer, A4 hoch (create_deck format a4, Layout flyer; Rückseite flyer-back nur auf Wunsch).' },
  { id: 'plakat', name: 'Plakat', hint: 'Gedruckt als A3 oder A2', format: 'a4', ask: 'Format: Plakat, gestaltet auf A4 hoch und gedruckt als A2 oder A3 (create_deck format a4, Layout flyer; export_deck print mit size a2 oder a3).' },
  { id: 'dokument', name: 'Dokument', hint: 'A4 hoch: Handout, Bericht oder Angebot', format: 'a4', ask: 'Format: Dokument, A4 hoch, z. B. Handout, Bericht oder Angebot (create_deck format a4).' },
  { id: 'brief', name: 'Brief', hint: 'A4 nach DIN 5008, für Fensterumschläge', format: 'a4', ask: 'Format: Geschäftsbrief nach DIN 5008, A4 hoch (create_deck format a4, Layout letter).' },
  { id: 'bewerbung', name: 'Bewerbung', hint: 'Deckblatt, Anschreiben und Lebenslauf', format: 'a4', ask: 'Format: Bewerbung, A4 hoch, alles in einem Deck und Design: Deckblatt (Layout application-cover, nur auf Wunsch oder bei Mappen), Anschreiben (Layout letter nach DIN 5008, Anlagen in enclosures) und Lebenslauf (Layout cv) (create_deck format a4).' },
  { id: 'lebenslauf', name: 'Lebenslauf', hint: 'A4 hoch, für die Bewerbung', format: 'a4', ask: 'Format: Lebenslauf, A4 hoch (create_deck format a4, Layout cv).' },
  { id: 'einladung', name: 'Einladung', hint: 'Gedruckt als A5 oder Postkarte', format: 'a4', ask: 'Format: Einladung, gestaltet auf A4 hoch und gedruckt als A5 oder A6 (create_deck format a4, Layout invitation).' },
  { id: 'urkunde', name: 'Urkunde', hint: 'A4 quer: Zertifikat, Teilnahme', format: 'a4-quer', ask: 'Format: Urkunde, A4 quer (create_deck format a4-quer, Layout certificate).' },
  { id: 'speisekarte', name: 'Speisekarte', hint: 'A4 hoch, Gerichte mit Preisen', format: 'a4', ask: 'Format: Speisekarte, A4 hoch (create_deck format a4, Layout menu).' },
  { id: 'visitenkarte', name: 'Visitenkarte', hint: '85 × 55 mm, Vorder- und Rückseite', format: 'visitenkarte', ask: 'Format: Visitenkarte 85 × 55 mm (create_deck format visitenkarte, Layout business-card: Seite 1 variant front, Seite 2 variant back).' },
  { id: 'social', name: 'Social-Post', hint: 'Karussell im Hochformat 4:5', format: '4:5', ask: 'Format: Social-Media-Karussell 4:5 (create_deck format 4:5).' },
  { id: 'story', name: 'Story', hint: 'Hochkant 9:16', format: '9:16', ask: 'Format: Story 9:16 (create_deck format 9:16).' },
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
  onBlank: (size?: Size) => void
  onOpen: () => void
  onOpenPath: (path: string) => void
  onKey: () => void
  onVideo?: () => void // Video-Modus: nach erfolgreichem Absenden, damit die App die Video-Ansicht zeigt
}

export function Start({ onSubmit, model, onModel, onBlank, onOpen, onOpenPath, onKey, onVideo }: Props) {
  const [text, setText] = useState('')
  const [video, setVideo] = useState(false)
  const [vask, setVask] = useState<string>() // ask des gewählten Video-Chips
  const [fmt, setFmt] = useState('auto')
  const choice = FORMAT_CHOICES.find((f) => f.id === fmt)!
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
  // Video oder Video-Link im Feld: automatisch in den Video-Modus (danach frei umschaltbar)
  const hasVideo = srcs.some((s) => VIDEO_FILE.test(s.name)) || linksOf(text).some(isVideoLink)
  useEffect(() => { if (hasVideo) { setVideo(true); setFmt('auto') } }, [hasVideo])
  const mode = (v: boolean) => { setVideo(v); setVask(undefined); if (v) setFmt('auto') } // Format-Wahl gilt nur für Präsentationen
  const submit = () => {
    const onlyVideos = video && srcs.length > 0 && srcs.every((s) => VIDEO_FILE.test(s.name))
    const ask = text.trim() || (onlyVideos ? `Mach aus ${srcs.length === 1 ? 'diesem Video' : 'diesen Videos'} 5 Shorts.` : !srcs.length ? '' : srcs.length === 1 && /\.pptx$/i.test(srcs[0].name)
      ? 'Übernimm diese PowerPoint als Deck: gleiche Folien in gleicher Reihenfolge, gleiche Aussagen, die eigenen Bilder, passende Layouts und ein stimmiges Design.'
      : 'Mach aus diesen Dateien eine Präsentation.')
    const links = video ? linksOf(text).map((u) => `Link: ${u} – zuerst import_video`) : []
    const context = [video ? vask : choice.ask, ...links, srcs.length ? sourceContext(srcs) : undefined].filter(Boolean).join('\n\n') || undefined
    // onSubmit liefert false bei busy oder fehlendem Key: dann nicht in die Video-Ansicht wechseln
    if (onSubmit(srcs.length ? `${ask} · ${srcs.map((s) => s.name).join(', ')}` : ask, context)) { if (video) onVideo?.(); setText(''); setVask(undefined); clear() }
  }

  return (
    <div className="home">
      <header className="top">
        <div className="home-brand"><Logo size={22} />Deckwerk</div>
        <span />
        <div className="top-r">
          <button className="plain tint" onClick={onOpen}>Deck öffnen …</button>
          <CloudButton />
          <button className="plain" aria-label="Einstellungen" title="Einstellungen: KI-Zugang, Cloud, Bilder, Marke, Agenten" onClick={onKey}><Settings size={17} /></button>
        </div>
      </header>

      <main className="home-main">
        <div className="seg home-mode" role="group" aria-label="Modus">
          <button type="button" aria-pressed={!video} onClick={() => mode(false)}>Präsentation</button>
          <button type="button" aria-pressed={video} onClick={() => mode(true)}>Video</button>
        </div>
        <h1>{video ? 'Was soll aus deinem Video werden?' : 'Was möchtest du zeigen?'}</h1>
        <p className="home-sub">{video ? 'Deckwerk hört das Video ab, wählt die Momente, schneidet, untertitelt und exportiert.' : 'Ein Satz genügt. Deckwerk denkt sich die Geschichte aus, gestaltet die Folien und prüft jede einzelne.'}</p>
        <form className="home-field" onSubmit={(e) => { e.preventDefault(); submit() }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { const f = [...e.dataTransfer.files]; if (f.length) { e.preventDefault(); attach(f.map(window.api.pathOf)) } }}>
          <textarea
            ref={ref}
            autoFocus
            rows={2}
            value={text}
            aria-label={video ? 'Was soll aus deinem Video werden?' : 'Worum geht es in deiner Präsentation?'}
            placeholder={video ? 'Video hierher ziehen oder Link einfügen – und sag kurz, was du brauchst' : 'Zum Beispiel: Quartalsbericht für die Geschäftsführung, 8 Folien, Fokus auf Wachstum'}
            onChange={(e) => { setText(e.target.value); setVask(undefined) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          />
          <div className="home-field-bar">
            <div className="home-field-l">
              <ModelSelect value={model} onChange={onModel} />
              {!video && <Select className="model-select ghost format-select" value={fmt} onChange={(e) => setFmt(e.target.value)} aria-label="Format" title="Format">
                {FORMAT_CHOICES.map((f) => <option key={f.id} value={f.id} data-hint={f.hint}>{f.name}</option>)}
              </Select>}
              {srcs.map((s) => (
                <span key={s.name} className="pill" title={s.cut ? 'Zu lang, die KI bekommt den Anfang' : undefined}>{isImage(s.name) ? <ImageIcon size={13} /> : <Paperclip size={13} />}{s.name}<button type="button" className="plain" aria-label={`${s.name} entfernen`} onClick={() => remove(s.name)}><X size={13} /></button></span>
              ))}
              <button type="button" className="plain" title={video ? 'Video anhängen (oder hierher ziehen)' : 'Dateien anhängen: Text, Word, PowerPoint, PDF oder Bilder (oder hierher ziehen)'} onClick={() => attach()}><Paperclip size={16} />Datei</button>
              {err && <span className="home-err error" role="alert">{err}</span>}
            </div>
            <button type="submit" className="round" aria-label={video ? 'Video-Auftrag senden' : 'Deck erstellen'} disabled={!text.trim() && !srcs.length}><ArrowUp size={18} strokeWidth={2.4} /></button>
          </div>
        </form>
        <div className="home-chips">
          {video
            ? VIDEO_EXAMPLES.map(([label, full, ask]) => <button key={label} className="pill" onClick={() => { setText(full); setVask(ask); ref.current?.focus() }}>{label}</button>)
            : EXAMPLES.map(([label, full, f]) => <button key={label} className="pill" onClick={() => { setText(full); setFmt(f ?? 'auto'); ref.current?.focus() }}>{label}</button>)}
        </div>
        <button className="plain tint home-blank" onClick={() => onBlank(choice.format && { w: FORMATS[choice.format].w, h: FORMATS[choice.format].h })}>Leer beginnen und frei gestalten</button>
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

      {!video && templates.length > 0 && (
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
