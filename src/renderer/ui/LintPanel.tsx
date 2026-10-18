// Prüfen ohne KI: ruft lint_deck auf und listet die Meldungen je Folie; Klick springt zur Folie.
import { useState } from 'react'
import { ListChecks } from 'lucide-react'

export interface LintEntry { slide: number; slideId: string; level: 'error' | 'warn' | 'hinweis'; rule: string; slot?: string; message: string }

// Zeilenformat aus lint_deck (tools.ts): „  - Folie 3 (id) (ausgeblendet) [warn] regel @slot: Text“
const LINE = /^\s*- Folie (\d+) \(([^)]*)\)(?: \(ausgeblendet\))? \[(error|warn|hinweis)\] (\S+?)(?: @(\S+))?: (.*)$/

export function parseLint(text: string): LintEntry[] {
  return text.split('\n').flatMap((l) => {
    const m = LINE.exec(l)
    return m ? [{ slide: +m[1] - 1, slideId: m[2], level: m[3] as LintEntry['level'], rule: m[4], slot: m[5], message: m[6] }] : []
  })
}

const LEVEL = { error: 'Fehler', warn: 'Warnung', hinweis: 'Hinweis' }

// order: Folien-IDs in Reihenfolge; weicht sie vom Stand der Prüfung ab, gilt die Liste als veraltet
export function LintPanel({ order, disabled, onSelect }: { order: string; disabled?: boolean; onSelect: (i: number) => void }) {
  const [list, setList] = useState<LintEntry[] | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [at, setAt] = useState('')
  const run = async () => {
    setBusy(true); setErr(''); setOpen(true); setAt(order)
    try { setList(parseLint((await window.api.runTool('lint_deck', {})).text)) } catch (e) { setList(null); setErr((e as Error).message) } finally { setBusy(false) }
  }
  const errors = list?.filter((x) => x.level === 'error').length ?? 0
  const slides = [...new Set(list?.map((x) => x.slide))]
  const stale = !!list && at !== order
  return (
    <span className="lint-panel">
      <button type="button" className={`plain${open ? ' on' : ''}`} disabled={disabled || busy} onClick={() => (open && list ? setOpen(false) : run())} title="Deck prüfen (Lint)">
        <ListChecks size={13} />{busy ? 'Prüfe …' : list && !stale ? `Prüfen · ${list.length}${errors ? ` (${errors} Fehler)` : ''}` : 'Prüfen'}
      </button>
      {open && !busy && (
        <div className="lint-pop" role="dialog" aria-label="Prüfergebnis">
          <div className="lint-head">
            <span>{err || (stale ? 'Veraltet – erneut prüfen' : list?.length ? `${list.length} Meldungen` : 'Keine Probleme. Das Deck ist sauber.')}</span>
            <button type="button" className="plain" onClick={run}>Erneut prüfen</button>
          </div>
          {!stale && slides.map((n) => (
            <div key={n} className="lint-group">
              <button type="button" className="lint-slide" onClick={() => onSelect(n)}>Folie {n + 1}</button>
              {list!.filter((x) => x.slide === n).map((x, k) => (
                <button type="button" key={k} className={`lint-item ${x.level}`} onClick={() => onSelect(n)}>
                  <span className="lint-level">{LEVEL[x.level]}</span>
                  <span><b>{x.rule}</b>{x.slot && ` @${x.slot}`}: {x.message}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}
