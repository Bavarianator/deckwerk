// Inhalt der Folie als Formular, generisch aus dem zod-Schema des Layouts (über JSON-Schema).
// Nur gültige Stände gehen an die Folie: Tippen als Entwurf (final=false), Blur/Enter und alle anderen Eingaben final.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ImagePlus, Plus, X } from 'lucide-react'
import { z } from 'zod'
import type { Slide } from '../../shared/deck'
import { LAYOUTS, type LayoutId } from '../../shared/layouts'
import { FIELD_NAMES } from '../../shared/layout-switch'
import { Select, Switch } from './kit'
import './content-form.css'

interface JS {
  type?: string; properties?: Record<string, JS>; required?: string[]; items?: JS; anyOf?: JS[]; enum?: string[]; description?: string
  minItems?: number; maxItems?: number; maxLength?: number; minimum?: number; maximum?: number
}
type Path = (string | number)[]
type Obj = Record<string, unknown>

const OWN_EDITOR: Record<string, string> = { clip: 'Clips schneidest du mit „Schneiden“ oder in Deckvid.', schnitt: 'Die Mehrspur-Timeline bearbeitest du in Deckvid.' }
const MEDIA_KEYS = new Set(['src', 'image', 'poster', 'video'])

// Wert unter path ersetzen (undefined = Feld entfernen), unveränderlich
function setIn(v: unknown, path: Path, x: unknown): unknown {
  if (!path.length) return x
  const [k, ...rest] = path
  if (typeof k === 'number') { const a = [...((v as unknown[]) ?? [])]; a[k] = setIn(a[k], rest, x); return a }
  const o = { ...((v as Obj) ?? {}) }
  const nx = setIn(o[k], rest, x)
  if (nx === undefined) delete o[k]
  else o[k] = nx
  return o
}
// Muster-Wert an derselben Stelle in samples.typ; bei Listen der Eintrag mit gleichem Index, sonst der erste
function sampleAt(sample: unknown, path: Path): unknown {
  let v = sample
  for (const k of path) {
    if (typeof k === 'number') v = Array.isArray(v) ? v[k] ?? v[0] : undefined
    else v = v && typeof v === 'object' ? (v as Obj)[k] : undefined
    if (v === undefined) return
  }
  return structuredClone(v)
}
function dflt(s: JS): unknown {
  if (s.anyOf) return dflt(s.anyOf[0])
  if (s.enum) return s.enum[0]
  switch (s.type) {
    case 'string': return ''
    case 'number': case 'integer': return s.minimum ?? 0
    case 'boolean': return false
    case 'array': return Array.from({ length: s.minItems ?? 0 }, () => dflt(s.items ?? {}))
    case 'object': return Object.fromEntries((s.required ?? []).map((k) => [k, dflt(s.properties![k])]))
  }
}
const fits = (s: JS, v: unknown) =>
  s.type === 'array' ? Array.isArray(v) : s.type === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : s.type === 'integer' ? typeof v === 'number' : typeof v === s.type

function Label({ name, s, extra }: { name: string; s: JS; extra?: ReactNode }) {
  const d = s.description
  return (
    <span className="cf-label" title={d}>
      <span>{FIELD_NAMES[name] ?? name}{d && <span className="cf-desc"> · {d.length > 60 ? `${d.slice(0, 60)}…` : d}</span>}</span>
      {extra}
    </span>
  )
}

export function ContentForm({ slide, onPatch }: { slide: Slide; onPatch: (content: unknown, final: boolean) => void }) {
  const def = LAYOUTS[slide.layout as LayoutId]
  const json = useMemo(() => (def ? (z.toJSONSchema(def.schema) as JS) : undefined), [def])
  const [draft, setDraft] = useState<unknown>(slide.content ?? {})
  const [err, setErr] = useState<string[]>([])
  const cur = useRef(draft)
  const dirty = useRef(false)
  // nur fremde Änderungen (KI, Undo, Folie im Canvas) übernehmen; der eigene Entwurf kommt hier ebenfalls an und muss dirty bleiben
  useEffect(() => { if (slide.content === cur.current) return; cur.current = slide.content ?? {}; setDraft(cur.current); setErr([]); dirty.current = false }, [slide.content])

  if (!def || !json) return <p className="muted cf-note">Unbekanntes Layout.</p>
  if (OWN_EDITOR[slide.layout]) return <p className="muted cf-note">{OWN_EDITOR[slide.layout]}</p>
  if (!Object.keys(json.properties ?? {}).length) return <p className="muted cf-note">Dieses Layout hat keine Inhaltsfelder.</p>

  const check = (v: unknown) => {
    const r = def.schema.safeParse(v)
    setErr(r.success ? [] : r.error.issues.slice(0, 4).map((i) => `${i.path.map((k) => (typeof k === 'number' ? k + 1 : FIELD_NAMES[String(k)] ?? String(k))).join(' › ')}: ${i.message}`))
    return r.success
  }
  const change = (path: Path, x: unknown, final = true) => {
    const next = setIn(cur.current, path, x)
    cur.current = next
    setDraft(next)
    if (check(next)) { onPatch(next, final); dirty.current = !final }
  }
  const commit = () => { if (dirty.current && check(cur.current)) { dirty.current = false; onPatch(cur.current, true) } }
  const fresh = (s: JS, path: Path) => { const v = sampleAt(def.samples.typ, path); return v !== undefined && fits(s, v) ? v : dflt(s) }

  const text = (s: JS, v: unknown, path: Path, label?: string) => {
    const props = {
      value: typeof v === 'string' ? v : '', 'aria-label': label, maxLength: s.maxLength,
      onChange: (e: { target: { value: string } }) => change(path, e.target.value, false), onBlur: commit,
    }
    return (s.maxLength ?? 0) > 90
      ? <textarea rows={3} {...props} />
      : <input type="text" {...props} onKeyDown={(e) => { if (e.key === 'Enter') commit() }} />
  }
  const media = (s: JS, v: unknown, path: Path, key: string) => {
    const src = typeof v === 'string' ? v : ''
    return (
      <div className="cf-media">
        {src && key !== 'video' && <img src={src} alt="" />}
        <div className="cf-row">
          {text(s, v, path, key)}
          <button type="button" className="icon-btn" title={key === 'video' ? 'Video wählen' : 'Bild wählen'} aria-label={key === 'video' ? 'Video wählen' : 'Bild wählen'}
            onClick={async () => { const p = key === 'video' ? await window.api.pickMedia('video') : await window.api.pickImage(); if (p) change(path, p) }}><ImagePlus size={14} /></button>
        </div>
      </div>
    )
  }

  // Eingabe ohne Beschriftung; key = Feldname (für Bildfelder und aria-label)
  const input = (s: JS, v: unknown, path: Path, key: string, optional: boolean): ReactNode => {
    if (s.anyOf) return input(s.anyOf.find((b) => fits(b, v)) ?? s.anyOf[0], v, path, key, optional)
    const name = FIELD_NAMES[key] ?? key
    if (s.enum) return (
      <Select value={typeof v === 'string' ? v : ''} aria-label={name} onChange={(e) => change(path, e.target.value || undefined)}>
        {optional && <option value="">–</option>}
        {s.enum.map((o) => <option key={o} value={o}>{o}</option>)}
      </Select>
    )
    switch (s.type) {
      case 'string': return MEDIA_KEYS.has(key) ? media(s, v, path, key) : text(s, v, path, name)
      case 'number': case 'integer': return (
        <input type="number" aria-label={name} value={typeof v === 'number' ? v : ''} min={s.minimum} max={s.maximum} step={s.type === 'integer' ? 1 : 'any'}
          onChange={(e) => { const t = e.target.value; if (t === '' && !optional) return; change(path, t === '' ? undefined : Number(t), false) }} onBlur={commit} />
      )
      case 'boolean': return <Switch checked={v === true} label={name} onChange={(b) => change(path, b)} />
      case 'object': return object(s, v as Obj | undefined, path)
      case 'array': return list(s, v as unknown[] | undefined, path, key)
    }
    return <p className="muted cf-note">Feld nicht bearbeitbar.</p>
  }

  const object = (s: JS, v: Obj | undefined, path: Path) => {
    const props = Object.entries(s.properties ?? {})
    const req = new Set(s.required ?? [])
    const missing = props.filter(([k]) => !req.has(k) && v?.[k] === undefined)
    return (
      <div className="cf-group">
        {props.filter(([k]) => req.has(k) || v?.[k] !== undefined).map(([k, p]) => (
          <div key={k} className="field">
            {k === 'chart' && p.properties?.series
              ? <><Label name={k} s={{}} /><p className="muted cf-note">Diagramm auf der Folie anklicken, um es zu bearbeiten.</p></>
              : <>
                  {(p.type !== 'boolean' || p.anyOf) && <Label name={k} s={p} extra={!req.has(k) && <button type="button" className="link" title="Feld entfernen" onClick={() => change([...path, k], undefined)}>entfernen</button>}/>}
                  {input(p, v?.[k], [...path, k], k, !req.has(k))}
                  {p.type === 'boolean' && !req.has(k) && <button type="button" className="link" onClick={() => change([...path, k], undefined)}>entfernen</button>}
                </>}
          </div>
        ))}
        {missing.length > 0 && (
          <div className="cf-add">
            {missing.map(([k, p]) => (
              <button key={k} type="button" className="link" title={p.description} onClick={() => change([...path, k], fresh(p, [...path, k]))}><Plus size={12} /> {FIELD_NAMES[k] ?? k}</button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const list = (s: JS, v: unknown[] | undefined, path: Path, key: string) => {
    const a = v ?? [], it = s.items ?? {}
    const move = (i: number, d: number) => { const b = [...a];[b[i], b[i + d]] = [b[i + d], b[i]]; change(path, b) }
    return (
      <div className="cf-list">
        {a.map((x, i) => (
          <div key={i} className="cf-item">
            <div className="cf-item-head">
              <span>{i + 1}.</span>
              <button type="button" className="icon-btn" aria-label="Nach oben" title="Nach oben" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
              <button type="button" className="icon-btn" aria-label="Nach unten" title="Nach unten" disabled={i === a.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
              <button type="button" className="icon-btn" aria-label="Entfernen" title="Entfernen" disabled={a.length <= (s.minItems ?? 0)} onClick={() => change(path, a.filter((_, j) => j !== i))}><X size={13} /></button>
            </div>
            {input(it, x, [...path, i], key, false)}
          </div>
        ))}
        <button type="button" className="link" disabled={s.maxItems !== undefined && a.length >= s.maxItems} onClick={() => change(path, [...a, fresh(it, [...path, a.length])])}><Plus size={12} /> Eintrag</button>
      </div>
    )
  }

  return (
    <div className="content-form">
      {object(json, draft as Obj, [])}
      {err.length > 0 && <ul className="cf-err" role="alert">{err.map((e, i) => <li key={i}>{e}</li>)}</ul>}
    </div>
  )
}
