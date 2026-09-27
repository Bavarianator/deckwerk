// KI-Verlauf: Nachrichtentypen, Tool-Namen, Modellwahl und die Liste der Nachrichten (für die KI-Leiste).
import { useEffect, useRef } from 'react'
import { Select } from './kit'
import { Check, CircleAlert, LoaderCircle, Sparkles } from 'lucide-react'
import { MODELS } from '../../shared/models'

export type Msg =
  | { kind: 'user' | 'ai' | 'error'; text: string }
  | { kind: 'tool'; name: string; status: 'start' | 'done' | 'error'; summary?: string }
  | { kind: 'ask'; question: string; options: string[] }
  | { kind: 'choice'; question: string; options: { label: string; image: string }[] } // Look-Vorschläge mit Bild

export const TOOL: Record<string, string> = {
  plan_storyline: 'Storyline planen', propose_looks: 'Looks entwerfen', create_deck: 'Deck anlegen', update_deck: 'Deck ändern', add_slides: 'Folien bauen', update_slide: 'Folie ändern',
  reorder_slides: 'Folien sortieren', delete_slides: 'Folien löschen', render_slides: 'Folien ansehen',
  render_overview: 'Übersicht prüfen', lint_deck: 'Qualität prüfen', search_icons: 'Icons suchen',
  find_images: 'Bilder suchen', export_deck: 'Exportieren', remember: 'Im Hausstil merken',
}

// Modellwahl; gilt ab der nächsten Nachricht, auch mitten im Gespräch
export function ModelSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return (
    <Select className="model-select ghost" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Modell" title={MODELS.find((m) => m.id === value)?.hint}>
      {MODELS.map((m) => <option key={m.id} value={m.id} data-hint={m.hint}>{m.name}</option>)}
    </Select>
  )
}

// Wunsch nach einem eigenen Design statt einer Vorlage (Karte unter den Look-Vorschlägen und Knopf im Look)
export const OWN_DESIGN = 'Entwirf ein ganz eigenes Design für dieses Deck: eigene Farben, Schriften und Stil, passend zu Thema und Publikum – keine der fertigen Vorlagen.'

// Look-Vorschläge als Karten mit Kontaktbogen; Klick schickt den Namen als Antwort. Dazu immer „Eigenes Design“.
export function ChoiceCards({ options, disabled, onSend }: { options: { label: string; image: string }[]; disabled: boolean; onSend: (text: string) => boolean }) {
  return (
    <div className="choice-opts">
      {options.map((o) => (
        <button key={o.label} type="button" className="choice-card" disabled={disabled} onClick={() => onSend(o.label)}>
          <img src={o.image} alt="" />
          <span>{o.label}</span>
        </button>
      ))}
      <button type="button" className="choice-card own" disabled={disabled} onClick={() => onSend(OWN_DESIGN)}>
        <Sparkles size={18} />
        <span>Eigenes Design<small>Deckwerk entwirft Farben, Schriften und Stil selbst – ohne Vorlage.</small></span>
      </button>
    </div>
  )
}

// Verlauf: Nachrichten, Tool-Chips, Rückfragen mit Antwort-Buttons (Verlauf der KI-Leiste)
export function ChatLog({ msgs, busy, onSend, className }: { msgs: Msg[]; busy: boolean; onSend: (text: string) => boolean; className: string }) {
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }) }, [msgs, busy])
  const lastUser = msgs.findLastIndex((m) => m.kind === 'user') // beantwortete Rückfragen sind nicht mehr klickbar
  return (
      <div className={className} ref={log}>
        {msgs.map((m, i) =>
          m.kind === 'ask' ? (
            <div key={i} className="msg msg-ask">
              {m.question}
              <div className="ask-opts">
                {m.options.map((o) => <button key={o} type="button" disabled={busy || i < lastUser} onClick={() => onSend(o)}>{o}</button>)}
              </div>
            </div>
          ) : m.kind === 'choice' ? (
            <div key={i} className="msg msg-ask">
              {m.question}
              <ChoiceCards options={m.options} disabled={busy || i < lastUser} onSend={onSend} />
            </div>
          ) : m.kind === 'tool' ? (
            m.name === 'ask_user' ? null :
            <span key={i} className={`chip chip-${m.status}`} title={m.summary}>
              {m.status === 'start' ? <LoaderCircle size={12} className="spin" /> : m.status === 'done' ? <Check size={12} /> : <CircleAlert size={12} />}
              {TOOL[m.name] ?? m.name}
              {m.summary && <span className="chip-sum">{m.summary}</span>}
            </span>
          ) : (
            <div key={i} className={`msg msg-${m.kind}`}>{m.text}</div>
          ),
        )}
        {busy && <div className="msg-busy"><LoaderCircle size={14} className="spin" /> Die KI arbeitet …</div>}
      </div>
  )
}
