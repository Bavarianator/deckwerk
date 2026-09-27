// Diagramm-Daten direkt an der Folie: Typ, Tabelle (Kategorien × Datenreihen), Hervorhebung, Einheit.
// Werte mit Komma oder Punkt; „Aus Excel einfügen“ liest Tabulator-getrennten Text aus der Zwischenablage.
import { useLayoutEffect, useRef, useState } from 'react'
import { Select } from './kit'
import { Sparkles, X } from 'lucide-react'
import type { ChartSpec } from '../../shared/deck'

const TYPES: [ChartSpec['type'], string][] = [['line', 'Linie'], ['bar', 'Säulen'], ['hbar', 'Balken'], ['stacked', 'Gestapelt'], ['donut', 'Ring'], ['waterfall', 'Wasserfall']]
const num = (s: string) => { const v = parseFloat(s.replace(/\s/g, '').replace(',', '.')); return Number.isFinite(v) ? v : 0 }
const fmt = (v: number) => String(v).replace('.', ',')

interface Props {
  spec: ChartSpec
  rect: { left: number; top: number; width: number; height: number }
  busy: boolean
  onChange: (spec: ChartSpec) => void
  onCheck: () => void // KI prüft Titel und Kernaussage gegen die neuen Daten
  onClose: () => void
}

export function ChartEditor({ spec, rect, busy, onChange, onCheck, onClose }: Props) {
  const box = useRef<HTMLElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  // rechts neben dem Diagramm, sonst über dessen rechten Rand; nie aus dem Fenster
  useLayoutEffect(() => {
    const w = box.current!.offsetWidth, h = box.current!.offsetHeight
    const right = rect.left + rect.width + 16
    const left = right + w < innerWidth - 12 ? right : Math.max(12, rect.left + rect.width - w - 16)
    setPos({ left, top: Math.max(64, Math.min(rect.top, innerHeight - h - 104)) }) // unten bleibt die KI-Leiste frei
  }, [rect.left, rect.top, rect.width])

  const set = (p: Partial<ChartSpec>) => onChange({ ...spec, ...p })
  const setCell = (r: number, c: number, v: string) =>
    set({ series: spec.series.map((s, j) => (j === c ? { ...s, values: s.values.map((x, i) => (i === r ? num(v) : x)) } : s)) })
  const paste = async () => {
    const rows = (await navigator.clipboard.readText()).trim().split(/\r?\n/).map((l) => l.split('\t'))
    if (rows.length < 2 || rows[0].length < 2) return
    const [head, ...body] = rows
    set({ categories: body.map((r) => r[0]), series: head.slice(1).map((name, j) => ({ name, values: body.map((r) => num(r[j + 1] ?? '0')) })) })
  }

  return (
    <section ref={box} className="chart-ed material" style={pos} aria-label="Diagramm bearbeiten" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation() }}>
      <div className="chart-ed-head">
        <b>Diagramm</b>
        <button className="pill tint" onClick={onClose}>Fertig</button>
      </div>
      <div className="seg chart-ed-types" role="radiogroup" aria-label="Diagrammtyp">
        {TYPES.map(([t, name]) => <button key={t} role="radio" aria-checked={spec.type === t} aria-pressed={spec.type === t} disabled={busy} onClick={() => set({ type: t })}>{name}</button>)}
      </div>

      <div className="chart-ed-table" role="table" aria-label="Daten">
        <div role="row" style={{ gridTemplateColumns: `90px repeat(${spec.series.length}, minmax(0, 1fr)) 24px` }}>
          <span role="columnheader">Kategorie</span>
          {spec.series.map((s, j) => (
            <input key={j} role="columnheader" aria-label={`Name Datenreihe ${j + 1}`} value={s.name} disabled={busy}
              onChange={(e) => set({ series: spec.series.map((x, k) => (k === j ? { ...x, name: e.target.value } : x)), highlight: spec.highlight === s.name ? e.target.value : spec.highlight })} />
          ))}
          <span />
        </div>
        {spec.categories.map((cat, i) => (
          <div key={i} role="row" style={{ gridTemplateColumns: `90px repeat(${spec.series.length}, minmax(0, 1fr)) 24px` }}>
            <input aria-label={`Kategorie ${i + 1}`} value={cat} disabled={busy} onChange={(e) => set({ categories: spec.categories.map((c, k) => (k === i ? e.target.value : c)) })} />
            {spec.series.map((s, j) => (
              <input key={`${j}:${s.values[i]}`} inputMode="decimal" aria-label={`${s.name} ${cat}`} defaultValue={fmt(s.values[i] ?? 0)} disabled={busy}
                onBlur={(e) => setCell(i, j, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
            ))}
            <button className="chart-ed-del" aria-label={`Zeile ${cat} entfernen`} disabled={busy || spec.categories.length < 2}
              onClick={() => set({ categories: spec.categories.filter((_, k) => k !== i), series: spec.series.map((s) => ({ ...s, values: s.values.filter((_, k) => k !== i) })) })}><X size={12} /></button>
          </div>
        ))}
        <div className="chart-ed-acts">
          <button className="plain tint" disabled={busy} onClick={() => set({ categories: [...spec.categories, `Neu ${spec.categories.length + 1}`], series: spec.series.map((s) => ({ ...s, values: [...s.values, 0] })) })}>+ Zeile</button>
          <button className="plain tint" disabled={busy || spec.series.length >= 4} onClick={() => set({ series: [...spec.series, { name: `Reihe ${spec.series.length + 1}`, values: spec.categories.map(() => 0) }] })}>+ Datenreihe</button>
          <span />
          <button className="plain" disabled={busy} onClick={paste}>Aus Excel einfügen</button>
        </div>
      </div>

      <div className="chart-ed-row">
        <span>Hervorheben</span>
        <Select value={spec.highlight ?? ''} disabled={busy} onChange={(e) => set({ highlight: e.target.value || undefined })}>
          <option value="">Keine</option>
          {[...spec.series.map((s) => s.name), ...spec.categories].map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
      </div>
      <div className="chart-ed-row">
        <span>Einheit</span>
        <input aria-label="Einheit" value={spec.unit ?? ''} maxLength={8} disabled={busy} onChange={(e) => set({ unit: e.target.value || undefined })} />
      </div>

      <button className="chart-ed-ai" disabled={busy} onClick={onCheck}>
        <Sparkles size={15} />Passen Titel und Kernaussage noch? Deckwerk prüft es.
      </button>
    </section>
  )
}
