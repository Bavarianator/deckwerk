// UI-Bausteine nach dem Design „Deckwerk – UI-Bausteine“ (Canvas): Dropdown, Schalter, Bestätigung.
// Select ist ein Drop-in für <select>: gleiche Props (value, onChange mit e.target.value), <option>/<optgroup> als Kinder.
// Vorschau je Option: data-swatch="#hex" (Farbpunkt) oder style={{ fontFamily }} (Schrift in sich selbst), data-hint (zweite Zeile).
import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Check, ChevronDown } from 'lucide-react'
import './kit.css'

interface Opt { value: string; label: ReactNode; group?: string; disabled?: boolean; swatch?: string; hint?: string; style?: CSSProperties }
type OptProps = { value?: string | number; children?: ReactNode; disabled?: boolean; style?: CSSProperties; 'data-swatch'?: string; 'data-hint'?: string }

function collect(children: ReactNode, group?: string, out: Opt[] = []): Opt[] {
  Children.forEach(children, (c) => {
    if (!isValidElement(c)) return
    const el = c as ReactElement<OptProps & { label?: string }>
    if (el.type === 'optgroup') collect(el.props.children, el.props.label, out)
    else if (el.type === 'option')
      out.push({ value: String(el.props.value ?? el.props.children ?? ''), label: el.props.children, group, disabled: el.props.disabled, swatch: el.props['data-swatch'], hint: el.props['data-hint'], style: el.props.style })
    else if (el.props.children) collect(el.props.children, group, out) // Fragmente, Listen
  })
  return out
}

interface SelectProps {
  value: string | number | undefined
  onChange: (e: { target: { value: string } }) => void
  children: ReactNode
  disabled?: boolean
  className?: string
  title?: string
  'aria-label'?: string
  id?: string
}

export function Select({ value, onChange, children, disabled, className, title, id, ...rest }: SelectProps) {
  const opts = collect(children)
  const cur = opts.find((o) => o.value === String(value ?? '')) ?? opts[0]
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<CSSProperties>({})
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const lid = useId()

  // Menü als position: fixed an den Auslöser hängen (Panels mit overflow schneiden es sonst ab); unten zu wenig Platz → nach oben
  useLayoutEffect(() => {
    if (!open || !btn.current) return
    const r = btn.current.getBoundingClientRect()
    const h = Math.min(340, 8 + opts.length * 34 + new Set(opts.map((o) => o.group)).size * 26)
    const up = r.bottom + h + 8 > innerHeight && r.top > h
    setPos({ left: r.left, minWidth: r.width, maxWidth: Math.max(r.width, 320), ...(up ? { bottom: innerHeight - r.top + 4 } : { top: r.bottom + 4 }) })
    setActive(Math.max(0, opts.indexOf(cur)))
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false) }
    addEventListener('pointerdown', close, true)
    return () => removeEventListener('pointerdown', close, true)
  }, [open])
  useEffect(() => { if (open) list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }) }, [active, open])

  const pick = (o: Opt) => { if (o.disabled) return; setOpen(false); btn.current?.focus(); if (o.value !== cur?.value) onChange({ target: { value: o.value } }) }
  const step = (d: number) => { for (let i = active + d; i >= 0 && i < opts.length; i += d) if (!opts[i].disabled) return setActive(i) }
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return
    if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); return setOpen(true) }
    if (!open) return
    if (e.key === 'ArrowDown') step(1)
    else if (e.key === 'ArrowUp') step(-1)
    else if (e.key === 'Enter' || e.key === ' ') opts[active] && pick(opts[active])
    else if (e.key === 'Escape' || e.key === 'Tab') { setOpen(false); if (e.key === 'Tab') return }
    else if (e.key.length === 1) { // Tippen springt zur ersten passenden Option
      const i = opts.findIndex((o) => String(typeof o.label === 'string' ? o.label : o.value).toLowerCase().startsWith(e.key.toLowerCase()))
      if (i >= 0) setActive(i)
      return
    }
    else return
    e.preventDefault()
    e.stopPropagation() // Canvas/App sollen Pfeile und Esc nicht zusätzlich verarbeiten
  }

  let lastGroup: string | undefined
  return (
    <>
      <button
        ref={btn} type="button" id={id} className={`kit-select ${open ? 'open' : ''} ${className ?? ''}`} title={title} disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? lid : undefined} aria-label={rest['aria-label']}
        onClick={() => setOpen((o) => !o)} onKeyDown={onKey}
      >
        {cur?.swatch && <span className="kit-swatch" style={{ background: cur.swatch }} />}
        <span className="kit-select-label" style={cur?.style}>{cur?.label}</span>
        <ChevronDown size={14} className="kit-chev" aria-hidden />
      </button>
      {open && (
        <div ref={list} id={lid} role="listbox" aria-label={rest['aria-label']} className="kit-menu" style={pos} onKeyDown={onKey}>
          {opts.map((o, i) => {
            const head = o.group !== lastGroup && o.group
            lastGroup = o.group
            const on = o.value === cur?.value
            return (
              <div key={`${o.group ?? ''}:${o.value}`} style={{ display: 'contents' }}>
                {head && <div className={`kit-group ${i ? 'sep' : ''}`}>{o.group}</div>}
                <div
                  role="option" aria-selected={on} aria-disabled={o.disabled} data-i={i}
                  className={`kit-opt ${on ? 'on' : ''} ${i === active ? 'active' : ''} ${o.disabled ? 'dis' : ''}`}
                  onPointerEnter={() => setActive(i)} onClick={() => pick(o)}
                >
                  {o.swatch && <span className="kit-swatch" style={{ background: o.swatch }} />}
                  <span className="kit-opt-text">
                    <span style={o.style}>{o.label}</span>
                    {o.hint && <span className="kit-hint">{o.hint}</span>}
                  </span>
                  {on && <Check size={14} strokeWidth={2.6} className="kit-check" aria-hidden />}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

// Schalter (an/aus) mit Beschriftung und optionaler Erklärung
export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className="kit-switch" onClick={() => onChange(!checked)}>
      <span className="kit-switch-text"><span>{label}</span>{hint && <span className="kit-hint">{hint}</span>}</span>
      <span className={`kit-track ${checked ? 'on' : ''}`}><span className="kit-knob" /></span>
    </button>
  )
}

// Bestätigung statt window.confirm(): nennt, was verloren geht; Enter bestätigt, Esc bricht ab. Liefert true/false.
export function confirmDialog(o: { title: string; text?: string; ok?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog')
    dlg.className = 'kit-dialog'
    document.body.appendChild(dlg)
    const root = createRoot(dlg)
    const done = (v: boolean) => { dlg.close(); root.unmount(); dlg.remove(); resolve(v) }
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false) })
    dlg.addEventListener('click', (e) => { if (e.target === dlg) done(false) }) // Klick auf den Hintergrund
    root.render(
      <form method="dialog" onSubmit={(e) => { e.preventDefault(); done(true) }}>
        <h2>{o.title}</h2>
        {o.text && <p>{o.text}</p>}
        <div className="kit-dialog-actions">
          <button type="button" className="kit-btn" onClick={() => done(false)}>{o.cancel ?? 'Abbrechen'}</button>
          <button type="submit" className={`kit-btn ${o.danger ? 'danger' : 'primary'}`} autoFocus>{o.ok ?? 'OK'}</button>
        </div>
      </form>,
    )
    dlg.showModal()
  })
}
