// Suchen & Ersetzen im ganzen Deck (Strg+F, mit Ersetzen Strg+H): schwebt oben rechts im Editor und springt zur Folie des Treffers.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, CaseSensitive, ChevronDown, ChevronRight, X } from 'lucide-react'
import type { Deck } from '../../shared/deck'
import { findInDeck, replaceInDeck } from '../../shared/find'

interface Props {
  deck: Deck
  index: number // angezeigte Folie: eine neue Suche beginnt dort
  busy: boolean
  replace: boolean // mit Ersetzen öffnen (Strg+H)
  focus: number // zählt jedes Strg+F/H hoch: Suchfeld erneut fokussieren
  onJump: (slide: number) => void
  onReplace: (fn: (d: Deck) => Deck) => void // ein Undo-Schritt
  onClose: () => void
}

export function FindBar(p: Props) {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [by, setBy] = useState('')
  const [caseSensitive, setCase] = useState(false)
  const [open, setOpen] = useState(p.replace)
  const [cur, setCur] = useState(0)
  const [skipped, setSkipped] = useState(0) // zuletzt nicht ersetzt, weil das Feld zu lang oder leer würde
  const reveal = useRef<number | null>(null) // nach dem Ersetzen: diesen Treffer zeigen, sobald die neuen Treffer da sind
  const opts = { caseSensitive }
  const hits = useMemo(() => findInDeck(p.deck, query, { caseSensitive }), [p.deck, query, caseSensitive])
  const at = Math.min(cur, hits.length - 1)
  const hit = hits[at]
  const go = (i: number) => {
    if (!hits[i]) return
    setCur(i)
    if (hits[i].slide >= 0) p.onJump(hits[i].slide) // Deck-Titel (-1) steht auf keiner Folie
  }

  useEffect(() => { if (p.replace) setOpen(true); input.current?.focus(); input.current?.select() }, [p.focus])
  useEffect(() => { setSkipped(0); const i = hits.findIndex((h) => h.slide >= p.index); go(Math.max(0, i)) }, [query, caseSensitive]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (reveal.current === null) return
    if (hits.length) go(reveal.current % hits.length)
    reveal.current = null
  }, [hits]) // eslint-disable-line react-hooks/exhaustive-deps

  const replaceOne = () => {
    if (!hit || p.busy) return
    const r = replaceInDeck(p.deck, query, by, opts, hit)
    setSkipped(r.skipped)
    if (r.deck === p.deck) return step(1) // Feld würde ungültig: bleibt stehen, weiter zum nächsten Treffer
    // enthält der Ersatz den Suchtext selbst, diese Treffer überspringen, sonst ersetzt der nächste Klick dieselbe Stelle
    reveal.current = at + findInDeck({ ...p.deck, title: by, slides: [] }, query, opts).length
    p.onReplace(() => r.deck)
  }
  const replaceAll = () => {
    if (!hits.length || p.busy) return
    const r = replaceInDeck(p.deck, query, by, opts)
    setSkipped(r.skipped)
    if (r.deck !== p.deck) p.onReplace(() => r.deck)
  }
  const step = (d: number) => go((at + d + hits.length) % hits.length)

  return (
    <div className="find-bar material" role="search" aria-label="Suchen und ersetzen"
      onKeyDown={(e) => {
        if (e.key === 'Escape') p.onClose()
        else if (e.key === 'Enter' && e.target === input.current) step(e.shiftKey ? -1 : 1)
        else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') replaceOne()
        else return
        e.preventDefault()
        e.stopPropagation()
      }}>
      <div className="find-row">
        <button className="plain" aria-label="Ersetzen" aria-expanded={open} title="Ersetzen ein- oder ausblenden (Strg+H)" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <input ref={input} type="text" value={query} placeholder="Im Deck suchen" aria-label="Suchen" onChange={(e) => setQuery(e.target.value)} />
        <span className="find-count" aria-live="polite">{hits.length ? `${at + 1} von ${hits.length}` : query ? 'Keine Treffer' : ''}</span>
        <button className={`plain ${caseSensitive ? 'on' : ''}`} aria-label="Groß- und Kleinschreibung beachten" aria-pressed={caseSensitive} title="Groß- und Kleinschreibung beachten" onClick={() => setCase(!caseSensitive)}>
          <CaseSensitive size={16} />
        </button>
        <button className="plain" aria-label="Vorheriger Treffer" title="Vorheriger Treffer (Umschalt+Enter)" disabled={!hits.length} onClick={() => step(-1)}><ArrowUp size={15} /></button>
        <button className="plain" aria-label="Nächster Treffer" title="Nächster Treffer (Enter)" disabled={!hits.length} onClick={() => step(1)}><ArrowDown size={15} /></button>
        <button className="plain" aria-label="Schließen" title="Schließen (Esc)" onClick={p.onClose}><X size={15} /></button>
      </div>
      {open && (
        <div className="find-row find-rep">
          <input type="text" value={by} placeholder="Ersetzen durch" aria-label="Ersetzen durch" onChange={(e) => setBy(e.target.value)} />
          <button className="plain" disabled={!hit || p.busy} onClick={replaceOne}>Ersetzen</button>
          <button className="plain" disabled={!hits.length || p.busy} onClick={replaceAll}>Alle ersetzen</button>
        </div>
      )}
      {skipped > 0 && <div className="find-where find-skip" role="status">{skipped === 1 ? '1 Stelle' : `${skipped} Stellen`} übersprungen: zu lang oder leer für das Feld</div>}
      {hit && <div className="find-where" title={hit.text}>{hit.slide >= 0 && `Folie ${hit.slide + 1} · `}{hit.label}: {hit.text}</div>}
    </div>
  )
}
