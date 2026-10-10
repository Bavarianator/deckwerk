// Deckvid-Leerzustand: die Arbeitsschritte der KI mit Fortschritt statt eines einzelnen Satzes.
import { useEffect, useState } from 'react'
import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { JOB, TOOL, type Msg } from './Chat'
import './deckvid-work.css'

export function WorkSteps({ msgs, busy }: { msgs: Msg[]; busy: boolean }) {
  const from = msgs.findLastIndex((m) => m.kind === 'user') + 1
  const steps = msgs.slice(from).filter((m): m is Extract<Msg, { kind: 'tool' }> => m.kind === 'tool' && m.name !== 'ask_user' && m.name !== 'auto_model')
  const running = busy && steps.some((s) => s.status === 'start' && s.name in JOB)
  const [pct, setPct] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!running) return
    let off = false // Antworten nach dem Ende und Prozente des vorigen Laufs nicht mehr zeigen
    const poll = () => window.api.jobs().then((js) => { if (!off) setPct(Object.fromEntries(js.filter((j) => !j.done).map((j) => [j.name, j.pct]))) }, () => {})
    void poll()
    const t = setInterval(poll, 1000)
    return () => { off = true; clearInterval(t); setPct({}) }
  }, [running])
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
          const p = s.status === 'start' ? pct[JOB[s.name]] : undefined
          return (
            <li key={i} aria-current={s.status === 'start' ? 'step' : undefined}>
              <div className="dv-work-row">
                {s.status === 'done' ? <Check size={16} className="dv-work-ok" /> : s.status === 'error' ? <CircleAlert size={16} className="dv-work-err" /> : <LoaderCircle size={16} className="spin dv-work-run" />}
                <span className="dv-work-name">{TOOL[s.name] ?? s.name}</span>
                {s.summary && <span className="dv-work-sum">{s.summary}</span>}
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
