// Diagramm-Daten direkt an der Folie: Typ, Tabelle (Kategorien × Datenreihen), Hervorhebung, Einheit.
// Werte mit Komma oder Punkt; „Aus Excel einfügen“ liest Tabulator-getrennten Text aus der Zwischenablage.
import { useLayoutEffect, useRef, useState } from 'react'
import { Select } from './kit'
import { LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react'
import type { ChartLink, ChartSpec } from '../../shared/deck'

const TYPES: [ChartSpec['type'], string][] = [['line', 'Linie'], ['bar', 'Säulen'], ['hbar', 'Balken'], ['stacked', 'Gestapelt'], ['donut', 'Ring'], ['waterfall', 'Wasserfall']]
const num = (s: string) => { const v = parseFloat(s.replace(/\s/g, '').replace(',', '.')); return Number.isFinite(v) ? v : 0 }
const fmt = (v: number) => String(v).replace('.', ',')

interface Props {
  spec: ChartSpec
  free: boolean // freies Element (items.ts) statt Layout-Diagramm: andere Grenzen
  rect: { left: number; top: number; width: number; height: number }
  busy: boolean
  onChange: (spec: ChartSpec, own?: boolean) => void // own: eigener Undo-Schritt
  onCheck: () => void // KI prüft Titel und Kernaussage gegen die neuen Daten
  onClose: () => void
}

export function ChartEditor({ spec, free, rect, busy, onChange, onCheck, onClose }: Props) {
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
          <button className="plain tint" disabled={busy || spec.series.length >= (free ? 6 : 4)} onClick={() => set({ series: [...spec.series, { name: `Reihe ${spec.series.length + 1}`, values: spec.categories.map(() => 0) }] })}>+ Datenreihe</button>
          <span />
          <button className="plain" disabled={busy} onClick={paste}>Aus Excel einfügen</button>
        </div>
      </div>
      <ExcelLink spec={spec} busy={busy} free={free} onChange={(s) => onChange(s, true)} />

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

// Deckwerk Pro: Werte aus einem Bereich einer .xlsx (src/main/xlsx-link.ts). „Aktualisieren“ liest neu, „Verknüpfung lösen“ behält die Werte.
// Grenzen wie in den zod-Schemas (layouts.ts: Diagramm auf der Folie, items.ts: freies Element); deck:set prüft nicht, spätere KI-Änderungen schon.
type Data = Pick<ChartSpec, 'categories' | 'series'>
function overLimit(d: Data, free: boolean): string | null {
  const [minC, maxC, maxS] = free ? [1, 24, 6] : [2, 12, 4]
  const where = free ? 'Ein freies Diagramm' : 'Ein Diagramm auf der Folie'
  if (d.categories.length < minC) return `Der Bereich braucht mindestens ${minC} Kategorien.`
  if (d.categories.length > maxC) return `Der Bereich hat ${d.categories.length} Kategorien. ${where} fasst höchstens ${maxC}.`
  if (d.series.length > maxS) return `Der Bereich hat ${d.series.length} Datenreihen. ${where} fasst höchstens ${maxS}.`
  if (free) return null
  const cat = d.categories.find((c) => c.length > 14)
  if (cat) return `Die Kategorie „${cat}“ ist länger als 14 Zeichen. Kürze sie in Excel.`
  const s = d.series.find((x) => x.name.length > 24)
  return s ? `Der Reihenname „${s.name}“ ist länger als 24 Zeichen. Kürze ihn in Excel.` : null
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const fileName = (f: string) => f.split(/[\\/]/).pop()

export function ExcelLink({ spec, busy, free = false, onChange }: { spec: ChartSpec; busy: boolean; free?: boolean; onChange: (spec: ChartSpec) => void }) {
  const [form, setForm] = useState<ChartLink | null>(null) // Datei gewählt, Blatt und Bereich fehlen noch
  const [err, setErr] = useState('')
  const [warn, setWarn] = useState<string[]>([])
  const [working, setWorking] = useState(false)
  const off = busy || working
  // Fehler oder zu großer Bereich: nichts speichern, die bisherigen Werte bleiben
  const read = async (link: ChartLink) => {
    setWorking(true)
    setErr('')
    setWarn([])
    try {
      const d = await window.api.xlsxRead(link)
      const bad = overLimit(d, free)
      if (bad) setErr(bad)
      else { onChange({ ...spec, categories: d.categories, series: d.series, link }); setForm(null); setWarn(d.warnings) }
    } catch (e) { setErr(errText(e)) }
    setWorking(false)
  }
  const pick = async () => { const file = await window.api.xlsxPick(); if (file) { setErr(''); setForm({ range: '', ...form, file }) } }
  const submit = () => form?.range.trim() && void read({ file: form.file, sheet: form.sheet?.trim() || undefined, range: form.range.trim() })
  const notes = <>
    {warn.map((w) => <p key={w} className="chart-link-note">{w}</p>)}
    {err && <p className="chart-link-note error" role="alert">{err}</p>}
  </>
  const l = spec.link

  if (form) return (
    <div className="chart-link">
      <span className="chart-link-src"><b>{fileName(form.file)}</b><button className="plain tint" disabled={off} onClick={() => void pick()}>Andere Datei …</button></span>
      <div className="chart-link-fields">
        <label>Blatt<input value={form.sheet ?? ''} placeholder="Erstes Blatt" disabled={off} onChange={(e) => setForm({ ...form, sheet: e.target.value })} /></label>
        <label>Bereich<input value={form.range} placeholder="A1:D5" autoFocus disabled={off} onChange={(e) => setForm({ ...form, range: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') submit() }} /></label>
      </div>
      <p className="chart-link-note">Erste Zeile: Kategorien. Erste Spalte: Namen der Datenreihen.</p>
      <span className="chart-link-acts">
        <button className="pill tint" disabled={off || !form.range.trim()} onClick={submit}>{working && <LoaderCircle size={13} className="spin" />}Verknüpfen</button>
        <button className="plain" disabled={working} onClick={() => { setForm(null); setErr('') }}>Abbrechen</button>
      </span>
      {notes}
    </div>
  )
  if (l) return (
    <div className="chart-link">
      <span className="chart-link-src" title={l.file}><b>{fileName(l.file)}</b><span>{l.sheet ? `${l.sheet} · ` : ''}{l.range}</span></span>
      <span className="chart-link-acts">
        <button className="plain tint" disabled={off} onClick={() => void read(l)}>{working ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}Aktualisieren</button>
        <button className="plain" disabled={off} onClick={() => { onChange({ ...spec, link: undefined }); setErr(''); setWarn([]) }}>Verknüpfung lösen</button>
      </span>
      <p className="chart-link-note">„Aktualisieren“ ersetzt die Werte in der Tabelle durch die aus Excel.</p>
      {notes}
    </div>
  )
  return (
    <div className="chart-link">
      <span className="chart-link-acts"><button className="plain" disabled={off} onClick={() => void pick()}>Mit Excel verknüpfen …</button></span>
      {notes}
    </div>
  )
}
