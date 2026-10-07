// UI-Bausteine nach dem Design „Deckwerk – UI-Bausteine“ (Canvas): Dropdown, Schalter, Bestätigung.
// Select ist ein Drop-in für <select>: gleiche Props (value, onChange mit e.target.value), <option>/<optgroup> als Kinder.
// Vorschau je Option: data-swatch="#hex" (Farbpunkt) oder style={{ fontFamily }} (Schrift in sich selbst), data-hint (zweite Zeile).
import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
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

// Option ins Bild holen, dabei nur die Liste scrollen: scrollIntoView zöge scrollende Panels mit (Diagramm-Editor), das schlösse das Menü
function reveal(l: HTMLElement | null, i: number) {
  const o = l?.querySelector<HTMLElement>(`[data-i="${i}"]`)
  if (!l || !o) return
  if (o.offsetTop < l.scrollTop) l.scrollTop = o.offsetTop
  else if (o.offsetTop + o.offsetHeight > l.scrollTop + l.clientHeight) l.scrollTop = o.offsetTop + o.offsetHeight - l.clientHeight
}

export function Select({ value, onChange, children, disabled, className, title, id, ...rest }: SelectProps) {
  const opts = collect(children)
  const cur = opts.find((o) => o.value === String(value ?? '')) ?? opts[0]
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const btn = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const lid = useId()

  // Menü als position: fixed an den Auslöser hängen (Panels mit overflow schneiden es sonst ab). Vor dem Paint mit fester Breite
  // die echte Höhe messen (Hinweise brechen um): unten, wenn es passt, sonst auf der Seite mit mehr Platz.
  // Direkt am DOM statt per State, damit die gewählte Option noch vor dem Paint ins Bild scrollen kann.
  useLayoutEffect(() => {
    const l = list.current
    if (!open || !btn.current || !l) return
    const r = btn.current.getBoundingClientRect()
    Object.assign(l.style, { left: '0px', minWidth: `${r.width}px`, maxWidth: `${Math.max(r.width, 320)}px` })
    const m = l.getBoundingClientRect()
    const below = innerHeight - r.bottom - 12, above = r.top - 12 // 4 px zum Knopf, 8 px zum Fensterrand
    const up = Math.min(m.height, 560) > below && above > below
    Object.assign(l.style, { left: `${Math.max(8, Math.min(r.left, innerWidth - m.width - 8))}px`, maxHeight: `${Math.min(560, up ? above : below)}px`, ...(up ? { bottom: `${innerHeight - r.top + 4}px` } : { top: `${r.bottom + 4}px` }) })
    const i = Math.max(0, opts.indexOf(cur))
    setActive(i)
    reveal(l, i)
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => { if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false) }
    // wie ein natives <select>: scrollt die Seite unter dem Knopf oder ändert sich das Fenster, schließt das Menü (es ist fixed)
    const moved = (e: Event) => { if ((e.target as Node).contains(btn.current)) setOpen(false) }
    const resized = () => setOpen(false)
    addEventListener('pointerdown', close, true)
    addEventListener('scroll', moved, true)
    addEventListener('resize', resized)
    return () => { removeEventListener('pointerdown', close, true); removeEventListener('scroll', moved, true); removeEventListener('resize', resized) }
  }, [open])

  const pick = (o: Opt) => { if (o.disabled) return; setOpen(false); btn.current?.focus(); if (o.value !== cur?.value) onChange({ target: { value: o.value } }) }
  // Nur Tastatur scrollt die Liste mit; Hover setzt active ohne Scrollen, sonst wandert die Liste unter der Maus weg
  const show = (i: number) => { setActive(i); reveal(list.current, i) }
  const step = (d: number) => { for (let i = active + d; i >= 0 && i < opts.length; i += d) if (!opts[i].disabled) return show(i) }
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
      if (i >= 0) show(i)
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
      {open && createPortal( // an body: Vorfahren mit backdrop-filter (KI-Leiste, Panels) würden fixed sonst auf sich beziehen
        <div ref={list} id={lid} role="listbox" aria-label={rest['aria-label']} className="kit-menu" onKeyDown={onKey}>
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
        </div>,
        document.body,
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
