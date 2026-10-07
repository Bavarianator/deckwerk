// KI-Leiste: eine Kapsel für Wünsche an die KI (mit Bezug auf das gewählte Element), darüber eine kurze Blase mit
// Status, Antwort oder Rückfrage und auf Wunsch der ganze Verlauf. Ersetzt die Chat-Spalte.
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Check, CircleAlert, History, Image as ImageIcon, LoaderCircle, Paperclip, Sparkles, Square, Undo2, X } from 'lucide-react'
import { Select } from './kit'
import { ChatLog, ChoiceCards, ModelSelect, TOOL, type Msg } from './Chat'
import { GUARD, REWRITE } from './ObjectBar'
import { isImage, sourceContext, useSource } from './Start'

// label steht in der Kapsel, context geht nur an die KI; slot und rect (Fensterkoordinaten) für Werkzeuge am Objekt
export interface Target { label: string; context: string; slot?: string; rect?: { left: number; top: number; width: number; height: number } }

interface Props {
  msgs: Msg[]
  busy: boolean
  model: string
  onModel: (id: string) => void
  onSend: (text: string, context?: string) => boolean
  onAbort: () => void
  target: Target | null
  onTarget: (t: Target | null) => void
  canUndo: boolean
  onUndo: () => void // macht die ganze letzte KI-Runde rückgängig
}

const SPRACHEN = ['Englisch', 'Französisch', 'Spanisch', 'Italienisch', 'Niederländisch', 'Polnisch', 'Türkisch', 'Ukrainisch', 'Deutsch']
const TEXTARTEN = ['E-Mail', 'Newsletter', 'Blogartikel']
const ZAHLEN = Array.from({ length: 11 }, (_, i) => String(i + 5))

// Aufträge fürs ganze Deck: gehen als getippter Wunsch raus, die Regeln dazu stehen im Design-Guide
const AUFTRAG = {
  uebersetzen: (l: string) => `Übersetze das ganze Deck ins ${l}e: alle Folientexte, Diagramm-Beschriftungen, Sprechernotizen und den Titel. Layouts, Bilder und Reihenfolge bleiben; Namen und Marken nicht übersetzen.`,
  notizen: 'Schreibe für jede Folie ohne oder mit dünnen Sprechernotizen passende Sprechernotizen (in der Sprache des Decks, im Ton eines Vortrags). Vorhandene gute Notizen behalten; sonst nichts am Deck ändern.',
  kuerzen: (n: string) => `Kürze das Deck auf ${n} Folien: Verwandtes zusammenlegen, Nebensächliches streichen, die Kernaussagen und die Storyline behalten.`,
  text: (a: string) => `Fasse den Inhalt des Decks als ${a} zusammen und schreibe den Text direkt in den Chat. Das Deck nicht ändern.`,
  rechtschreibung: 'Prüfe die Rechtschreibung, Grammatik und Zeichensetzung in allen Texten des Decks (Folien, Diagramm-Beschriftungen, Sprechernotizen, Titel) und korrigiere Fehler. Ändere sonst nichts, auch nicht den Wortlaut oder Stil.',
}

// Menü „Fürs ganze Deck“ am Sparkles-Knopf links in der Kapsel
// Mit gewähltem Element (auch Text-Feldern des Layouts, die keine Objektleiste haben) stehen oben dessen Text-Aktionen
function DeckMenu({ busy, onSend, target, onTarget }: { busy: boolean; onSend: (text: string, context?: string) => boolean; target: Target | null; onTarget: (t: Target | null) => void }) {
  const [open, setOpen] = useState(false)
  const [sprache, setSprache] = useState(SPRACHEN[0])
  const [zahl, setZahl] = useState('8')
  const [art, setArt] = useState(TEXTARTEN[0])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    box.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus()
    // das Menü der Selects hängt an body, Klicks darin zählen als drinnen
    const close = (e: PointerEvent) => { const t = e.target as Element; if (!box.current?.contains(t) && !t.closest('.kit-menu')) setOpen(false) }
    addEventListener('pointerdown', close, true)
    return () => removeEventListener('pointerdown', close, true)
  }, [open])
  useEffect(() => { if (busy) setOpen(false) }, [busy])
  const go = (text: string) => { if (onSend(text)) setOpen(false) }
  // wie ein getippter Wunsch mit Bezug (AskBar.submit): Label vorn, Kontext nur an die KI, danach Bezug lösen
  const goTarget = (task: string) => { if (target && onSend(`${target.label}: ${task} ${GUARD}`, target.context)) { setOpen(false); onTarget(null) } }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); box.current?.querySelector<HTMLElement>('.deck-btn')?.focus() }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !(e.target as Element).closest('.kit-select')) { // dort öffnen die Pfeile das Select
      const items = [...box.current!.querySelectorAll<HTMLElement>('[role=menuitem]')]
      const at = items.indexOf(document.activeElement as HTMLElement)
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      e.preventDefault()
      e.stopPropagation() // sonst blättert App.tsx die Folie
    }
  }
  const row = (label: string, run: () => void, select?: ReactNode) => (
    <div className="deck-row">
      <button type="button" role="menuitem" onClick={run}>{label}</button>
      {select}
    </div>
  )
  return (
    <div className="deck-act" ref={box} onKeyDown={onKey}>
      <button type="button" className={`plain deck-btn ${open ? 'on' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label="Aufträge an die KI" title="Text umschreiben, Deck übersetzen, Notizen für alle Folien, kürzen …" disabled={busy} onClick={() => setOpen(!open)}>
        <Sparkles size={19} aria-hidden />
      </button>
      {open && (
        <div className="menu deck-menu material" role="menu" aria-label="Aufträge an die KI">
          {target && <>
            <div className="deck-head">Gewählter Text · {target.label}</div>
            {REWRITE.map(([label, task]) => <Fragment key={label}>{row(label, () => goTarget(task))}</Fragment>)}
            {row('Übersetzen ins', () => goTarget(`Übersetze den gewählten Text ins ${sprache}e.`), <Select value={sprache} onChange={(e) => setSprache(e.target.value)} aria-label="Sprache">{SPRACHEN.map((l) => <option key={l}>{l}</option>)}</Select>)}
            <hr />
          </>}
          <div className="deck-head">Fürs ganze Deck</div>
          {row('Übersetzen ins', () => go(AUFTRAG.uebersetzen(sprache)), <Select value={sprache} onChange={(e) => setSprache(e.target.value)} aria-label="Sprache">{SPRACHEN.map((l) => <option key={l}>{l}</option>)}</Select>)}
          {row('Sprechernotizen für alle Folien', () => go(AUFTRAG.notizen))}
          {row('Kürzen auf', () => go(AUFTRAG.kuerzen(zahl)), <><Select value={zahl} onChange={(e) => setZahl(e.target.value)} aria-label="Zahl der Folien">{ZAHLEN.map((n) => <option key={n}>{n}</option>)}</Select><span>Folien</span></>)}
          {row('Zusammenfassen als', () => go(AUFTRAG.text(art)), <Select value={art} onChange={(e) => setArt(e.target.value)} aria-label="Textart">{TEXTARTEN.map((a) => <option key={a}>{a}</option>)}</Select>)}
          {row('Rechtschreibung prüfen', () => go(AUFTRAG.rechtschreibung))}
        </div>
      )}
    </div>
  )
}

export function AskBar(p: Props) {
  const [draft, setDraft] = useState('')
  const [history, setHistory] = useState(false)
  const [seen, setSeen] = useState(0) // Blase ist bis zu dieser Nachrichtenzahl weggeklickt
  const { srcs, attach, remove, clear, err } = useSource()
  const submit = () => {
    const text = draft.trim() || (srcs.length ? 'Nutze diese Dateien für das Deck.' : '')
    const t = p.target
    const ctx = [t?.context, srcs.length > 0 && sourceContext(srcs)].filter(Boolean).join('\n\n') || undefined
    if (text && p.onSend(`${t ? `${t.label}: ` : ''}${text}${srcs.length ? ` · ${srcs.map((s) => s.name).join(', ')}` : ''}`, ctx)) {
      setDraft('')
      clear()
      p.onTarget(null)
    }
  }

  const lastUser = p.msgs.findLastIndex((m) => m.kind === 'user')
  const askAt = p.msgs.findLastIndex((m) => m.kind === 'ask' || m.kind === 'choice')
  const last = p.msgs.at(-1)
  const aiText = p.msgs.slice(lastUser + 1).findLast((m) => m.kind === 'ai')
  const running = p.msgs.findLast((m) => m.kind === 'tool' && m.status === 'start' && m.name !== 'ask_user')
  const acts = (extra?: ReactNode) => (
    <div className="bubble-acts">
      {extra}
      <button type="button" className="plain" onClick={() => setHistory(true)}>Verlauf</button>
      {!p.busy && <button type="button" className="plain" aria-label="Schließen" onClick={() => setSeen(p.msgs.length)}><X size={14} /></button>}
    </div>
  )

  let bubble: ReactNode = null
  if (history || p.msgs.length <= seen) bubble = null
  else if (askAt > lastUser) {
    const m = p.msgs[askAt] as Extract<Msg, { kind: 'ask' | 'choice' }>
    bubble = (
      <div className="bubble ask material" role="status">
        <p>{m.question}</p>
        {m.kind === 'choice'
          ? <ChoiceCards options={m.options} disabled={p.busy} onSend={p.onSend} />
          : <div className="bubble-opts">{m.options.map((o) => <button key={o} type="button" className="pill" disabled={p.busy} onClick={() => p.onSend(o)}>{o}</button>)}</div>}
      </div>
    )
  } else if (p.busy)
    bubble = (
      <div className="bubble material" role="status">
        <LoaderCircle size={18} className="spin" />
        <p>{running?.kind === 'tool' ? `${TOOL[running.name] ?? running.name}${running.summary ? ` · ${running.summary}` : ''} …` : aiText?.kind === 'ai' ? aiText.text : 'Deckwerk denkt nach …'}</p>
        {acts()}
      </div>
    )
  else if (last?.kind === 'error')
    bubble = <div className="bubble error material" role="alert"><CircleAlert size={18} /><p>{last.text}</p>{acts()}</div>
  else if (lastUser >= 0)
    bubble = (
      <div className="bubble material" role="status">
        <span className="ok"><Check size={12} strokeWidth={3} /></span>
        <p>{aiText?.kind === 'ai' ? aiText.text : 'Erledigt.'}</p>
        {acts(p.canUndo && <button type="button" className="plain tint" onClick={p.onUndo}><Undo2 size={14} />Rückgängig</button>)}
      </div>
    )

  return (
    <div className="dock">
      {history && (
        <section className="history material" aria-label="Verlauf">
          <div className="history-head">Verlauf<button type="button" className="plain" aria-label="Verlauf schließen" onClick={() => setHistory(false)}><X size={15} /></button></div>
          <ChatLog className="history-log" msgs={p.msgs} busy={p.busy} onSend={p.onSend} />
        </section>
      )}
      {bubble}
      <form className="cap material" onSubmit={(e) => { e.preventDefault(); submit() }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { const f = [...e.dataTransfer.files]; if (f.length) { e.preventDefault(); attach(f.map(window.api.pathOf)) } }}>
        <DeckMenu busy={p.busy} onSend={p.onSend} target={p.target} onTarget={p.onTarget} />
        {p.target && (
          <span className="cap-token">
            {p.target.label}
            <button type="button" aria-label="Bezug entfernen" onClick={() => p.onTarget(null)}><X size={11} strokeWidth={2.6} /></button>
          </span>
        )}
        {srcs.map((s) => (
          <span key={s.name} className="cap-token file" title={s.cut ? `${s.name} (zu lang, die KI bekommt den Anfang)` : s.name}>
            {isImage(s.name) ? <ImageIcon size={11} /> : <Paperclip size={11} />}<span>{s.name}</span>
            <button type="button" aria-label={`${s.name} entfernen`} onClick={() => remove(s.name)}><X size={11} strokeWidth={2.6} /></button>
          </span>
        ))}
        {err && <span className="cap-token error" role="alert" title={err}>{err}</span>}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && p.target) p.onTarget(null) }}
          placeholder={p.busy ? 'Deckwerk arbeitet …' : p.target ? 'Was soll sich hier ändern?' : 'Sag Deckwerk, was sich ändern soll'}
          aria-label="Wunsch an die KI"
        />
        <button type="button" className="plain" aria-label="Dateien anhängen" title="Dateien anhängen: Text, Word, PowerPoint, PDF oder Bilder (oder hierher ziehen)" disabled={p.busy} onClick={() => attach()}><Paperclip size={16} /></button>
        <button type="button" className="plain" aria-label="Verlauf" aria-pressed={history} disabled={!p.msgs.length} onClick={() => setHistory(!history)}><History size={16} /></button>
        <ModelSelect value={p.model} onChange={p.onModel} />
        {p.busy
          ? <button type="button" className="round stop" aria-label="Stoppen" onClick={p.onAbort}><Square size={12} fill="currentColor" /></button>
          : <button type="submit" className="round" aria-label="Senden (Enter)" disabled={!draft.trim() && !srcs.length}><ArrowUp size={17} strokeWidth={2.4} /></button>}
      </form>
    </div>
  )
}
