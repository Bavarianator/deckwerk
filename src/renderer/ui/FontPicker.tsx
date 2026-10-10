// Schriftwahl, die jede Schrift in ihrer eigenen Gestalt zeigt (Name und Probe), gruppiert nach Serif, Serifenlos und Mono.
// Liste, Pfeile, Enter, Esc, Tippen und Fokus-Rückgabe kommen von Select (kit.tsx).
import { FONTS, FONT_NAMES } from '../../shared/themes'
import { Select } from './kit'

const mono = (f: string) => f.includes('Mono')
const GROUPS = [
  ['Serif', FONT_NAMES.filter((f) => FONTS[f].serif)],
  ['Serifenlos', FONT_NAMES.filter((f) => !FONTS[f].serif && !mono(f))],
  ['Mono', FONT_NAMES.filter(mono)],
] as const

interface Props {
  value?: string // Name aus FONT_NAMES; leer = placeholder
  onChange: (font: string | undefined) => void
  placeholder: string
  'aria-label': string
  title?: string
}

export function FontPicker({ value, onChange, placeholder, ...rest }: Props) {
  return (
    // Select hält bei offener Liste nur Pfeile hoch/runter, Enter und Esc an; Tippen und Pfeile links/rechts blätterten sonst Themes oder Folien
    <span className="font-pick" onKeyDown={(e) => { if (e.currentTarget.querySelector('[aria-expanded="true"]')) e.stopPropagation() }}>
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} className="font-pick-btn" {...rest}>
        <option value="">{placeholder}</option>
        {/* Schrift außerhalb der gebündelten (Katalog, eigene) bleibt sichtbar statt auf den Platzhalter zu fallen */}
        {value && !(FONT_NAMES as string[]).includes(value) && <option value={value} style={{ fontFamily: `"${value}"` }}>{value}</option>}
        {GROUPS.map(([g, fonts]) => (
          <optgroup key={g} label={g}>
            {fonts.map((f) => (
              <option key={f} value={f} style={{ fontFamily: `"${FONTS[f].css}"` }}>
                <span className="font-pick-opt">{f}<span className="font-pick-probe">Folientitel 2026</span></span>
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </span>
  )
}
