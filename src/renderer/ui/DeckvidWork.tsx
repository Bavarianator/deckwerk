// Deckvid-Leerzustand: die Arbeitsschritte der KI mit Fortschritt statt eines einzelnen Satzes.
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { JOB, TOOL, sameNext, useJobs, type Msg } from './Chat'
import './deckvid-work.css'

export function WorkSteps({ msgs, busy }: { msgs: Msg[]; busy: boolean }) {
  const from = msgs.findLastIndex((m) => m.kind === 'user') + 1
  const steps = msgs.slice(from).filter((m): m is Extract<Msg, { kind: 'tool' }> => m.kind === 'tool' && !['ask_user', 'auto_model', 'router'].includes(m.name))
    .filter((_, i, all) => !sameNext(all, i)) // Nachfragen eines laufenden Video-Tools: eine Zeile
  const running = busy && steps.some((s) => s.status === 'start' && s.name in JOB)
  const jobs = useJobs(running)
  if (!busy) return null
  return (
    <div className="dv-work">
      <h2>Die KI arbeitet</h2>
      <p className="dv-work-sub">Du kannst das Fenster offen lassen. Die Clips erscheinen links, sobald sie fertig sind.</p>
      <ol aria-label="Arbeitsschritte" role="status" aria-live="polite">
        {steps.length === 0 && (
          <li aria-current="step"><div className="dv-work-row"><LoaderCircle size={16} className="spin dv-work-run" /><span className="dv-work-name">Die KI liest deinen Auftrag …</span></div></li>
        )}
        {steps.map((s, i) => {
          const j = s.status === 'start' ? jobs[JOB[s.name]] : undefined, p = j?.pct
          // laufend: wer rechnet (Handy oder PC) und wie viele Bereiche desselben Tools noch offen sind
          const sum = s.summary ?? (j?.where && `${j.where}${j.open > 1 ? ` · ${j.open} Bereiche offen` : ''}`)
          return (
            <li key={i} aria-current={s.status === 'start' ? 'step' : undefined}>
              <div className="dv-work-row">
                {s.status === 'done' ? <Check size={16} className="dv-work-ok" /> : s.status === 'error' ? <CircleAlert size={16} className="dv-work-err" /> : <LoaderCircle size={16} className="spin dv-work-run" />}
                <span className="dv-work-name">{TOOL[s.name] ?? s.name}</span>
                {sum && <span className="dv-work-sum" title={sum}>{sum}</span>}
                {p !== undefined && <span className="dv-work-pct">{Math.round(p)} %</span>}
              </div>
              {p !== undefined && <div className="dv-work-bar"><i style={{ width: `${Math.min(100, Math.max(0, p))}%` }} /></div>}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
