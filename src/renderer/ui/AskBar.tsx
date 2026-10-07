// KI-Leiste: eine Kapsel für Wünsche an die KI (mit Bezug auf das gewählte Element), darüber eine kurze Blase mit
// Status, Antwort oder Rückfrage und auf Wunsch der ganze Verlauf. Ersetzt die Chat-Spalte.
import { useState, type ReactNode } from 'react'
import { ArrowUp, Check, CircleAlert, History, Image as ImageIcon, LoaderCircle, Paperclip, Sparkles, Square, Undo2, X } from 'lucide-react'
import { ChatLog, ChoiceCards, ModelSelect, TOOL, type Msg } from './Chat'
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
        <Sparkles size={19} aria-hidden />
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
