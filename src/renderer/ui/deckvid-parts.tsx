// Gemeinsame Bausteine von Deckvid (Video) und PodcastStage: Fenster-Tasten und Prüfhinweise
import { useEffect, useRef, useState } from 'react'
import type { ClipIssue } from '../../shared/clip-lint'

export type Hint = Pick<ClipIssue, 'severity' | 'message'> // auch Podcast-Hinweise (lintEpisode)
export const count = (xs: Hint[]) => xs.filter((x) => x.severity !== 'info').length // Infos zählen nicht

// Fenster-Tasten über eine Ref: ein Listener für die ganze Lebenszeit, der Handler sieht trotzdem den aktuellen Stand
export function useKey(fn: (e: KeyboardEvent) => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const h = (e: KeyboardEvent) => ref.current(e)
    addEventListener('keydown', h)
    return () => removeEventListener('keydown', h)
  }, [])
}
// Tasten der Ansicht nicht beim Tippen, nicht mit Modifikator und nicht, solange ein Dialog, Menü oder Dropdown offen ist (Feinschnitt fängt seine Tasten selbst ab).
// emptyAsk: auch im leeren Chatfeld, dort steht der Cursor nach dem Senden (nur für die Leertaste, Buchstaben wären Text)
export const keysFree = (e: KeyboardEvent, emptyAsk = false) => {
  const t = e.target as HTMLElement
  const typing = t.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !(emptyAsk && t.matches('.dv-ask input') && !(t as HTMLInputElement).value))
  return !(e.ctrlKey || e.metaKey || e.altKey || typing || t.closest('[role=menu], [role=listbox]')
    || document.querySelector('[aria-modal="true"], dialog[open], .kit-menu, [role=menu]'))
}

// Prüfhinweise: höchstens 4 sichtbar, Rest aufklappbar
export function Hints({ xs, busy, onFix }: { xs: Hint[]; busy: boolean; // busy: KI arbeitet oder Cache noch nicht neu geladen
   onFix: () => void }) {
  const [all, setAll] = useState(false)
  const shown = all ? xs : xs.slice(0, 4)
  return (
    <div className="dv-hints" role="group" aria-label="Prüfhinweise">
      <ul>{shown.map((x, k) => <li key={k} className={x.severity}><span className="dv-sr">{x.severity === 'error' ? 'Fehler: ' : 'Hinweis: '}</span>{x.message}</li>)}</ul>
      <div>
        {xs.length > 4 && <button className="plain" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Weniger' : `+ ${xs.length - 4} weitere`}</button>}
        {count(xs) > 0 && <button className="pill" disabled={busy} onClick={onFix}>Von der KI beheben lassen</button>}
      </div>
    </div>
  )
}
