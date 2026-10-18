// Ecken-Akzent ohne KI: dieselbe Auswahl wie decorate_slide (Ecke, Art, Größe), die Engine sucht freien Platz.
import { useState } from 'react'
import { icons, Stamp } from 'lucide-react'
import { GRAPHICS } from '../../shared/items'
import { Select } from './kit'

const ZONES = { 'top-left': 'oben links', 'top-right': 'oben rechts', 'bottom-left': 'unten links', 'bottom-right': 'unten rechts' }
const SHAPES = { star12: 'Siegel', star8: 'Stern', star4: 'Funkeln', donut: 'Ring', plus: 'Plus', heart: 'Herz', ellipse: 'Kreis' }
const kebab = (n: string) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase()
const ICONS = Object.keys(icons).map(kebab)

export function AccentPicker({ slideId, disabled }: { slideId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [zone, setZone] = useState<keyof typeof ZONES>('top-right')
  const [kind, setKind] = useState<'shape' | 'graphic' | 'icon'>('graphic')
  const [shape, setShape] = useState('star12')
  const [graphic, setGraphic] = useState('sparkle')
  const [icon, setIcon] = useState('sparkles')
  const [size, setSize] = useState<'s' | 'm' | 'l'>('m')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const hits = icon.length > 1 ? ICONS.filter((n) => n.includes(icon.toLowerCase())).slice(0, 30) : []
  const apply = async (remove?: boolean) => {
    setBusy(true); setMsg('')
    const accent = remove ? null : { kind, zone, size, ...(kind === 'shape' ? { shape } : kind === 'graphic' ? { graphic } : { icon }) }
    try { setMsg((await window.api.runTool('decorate_slide', { id: slideId, accent })).text.split('\n')[0]) } catch (e) { setMsg((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <span className="lint-panel">
      <button type="button" className={`plain${open ? ' on' : ''}`} disabled={disabled} onClick={() => setOpen(!open)} title="Akzent in einer Ecke (nur auf luftigen Folien)">
        <Stamp size={13} />Akzent
      </button>
      {open && (
        <div className="lint-pop accent-pop" role="dialog" aria-label="Akzent">
          <Select value={zone} onChange={(e) => setZone(e.target.value as keyof typeof ZONES)}>
            {Object.entries(ZONES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="graphic">Handgezeichnet</option><option value="shape">Form</option><option value="icon">Icon</option>
          </Select>
          {kind === 'shape' && <Select value={shape} onChange={(e) => setShape(e.target.value)}>{Object.entries(SHAPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
          {kind === 'graphic' && <Select value={graphic} onChange={(e) => setGraphic(e.target.value)}>{Object.entries(GRAPHICS).map(([k, g]) => <option key={k} value={k}>{g.name}</option>)}</Select>}
          {kind === 'icon' && <>
            <input list="accent-icons" value={icon} onChange={(e) => setIcon(e.target.value.trim())} placeholder="Icon suchen (englisch)" />
            <datalist id="accent-icons">{hits.map((n) => <option key={n} value={n} />)}</datalist>
          </>}
          <Select value={size} onChange={(e) => setSize(e.target.value as typeof size)}>
            <option value="s">klein</option><option value="m">mittel</option><option value="l">groß</option>
          </Select>
          <div className="lint-head">
            <button type="button" className="plain tint" disabled={busy || disabled || (kind === 'icon' && !ICONS.includes(icon))} onClick={() => apply()}>Setzen</button>
            <button type="button" className="plain" disabled={busy || disabled} onClick={() => apply(true)}>Entfernen</button>
          </div>
          {msg && <span className="accent-msg">{msg}</span>}
        </div>
      )}
    </span>
  )
}
