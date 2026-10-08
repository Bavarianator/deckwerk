// Schriftwahl, die jede Schrift in ihrer eigenen Gestalt zeigt (Name und Probe): gebündelte nach Serif, Serifenlos und Mono, dazu die
// Katalogschriften (src/shared/font-catalog.ts), die erst nach der Wahl geladen werden (ensureFonts).
// Liste, Pfeile, Enter, Esc, Tippen und Fokus-Rückgabe kommen von Select (kit.tsx).
import type { CSSProperties } from 'react'
import type { Deck, FontFiles } from '../../shared/deck'
import { CAT_NAMES, FONT_CATALOG, fontInfo, type FontCat } from '../../shared/font-catalog'
import { FONTS, FONT_NAMES, fontRef } from '../../shared/themes'
import { Select } from './kit'

const mono = (f: string) => f.includes('Mono')
const GROUPS = [
  ['Serif', FONT_NAMES.filter((f) => FONTS[f].serif)],
  ['Serifenlos', FONT_NAMES.filter((f) => !FONTS[f].serif && !mono(f))],
  ['Mono', FONT_NAMES.filter(mono)],
] as const
// Katalog ohne gebündelte, Office- und Slop-Schriften, nach Kategorie
const CATS = Object.keys(CAT_NAMES) as FontCat[]
const MORE = FONT_CATALOG.filter((i) => !i.office && i.flag !== 'slop' && !(i.family in FONTS)).sort((a, b) => CATS.indexOf(a.cat) - CATS.indexOf(b.cat))
const KNOWN = new Set<string>([...FONT_NAMES, ...MORE.map((i) => i.family)])
// Katalogschriften im eigenen Namen mit dem Ersatz dahinter: ohne @font-face lädt der Name nichts, die Zeile steht dann im Ersatz;
// nutzt eine Folie die Schrift schon (FontFace registriert), erscheint sie echt
const styleOf = (name: string): CSSProperties => {
  const f = fontRef(name)
  return { fontFamily: name in FONTS ? `"${f!.css}"` : f ? `"${name}", "${f.css}"` : `"${name}"` }
}
const label = (f: string) => <span className="font-pick-opt">{f}<span className="font-pick-probe">Folientitel 2026</span></span>

interface Props {
  value?: string // Schriftname (gebündelt oder Katalog); leer = placeholder
  onChange: (font: string | undefined) => void
  placeholder?: string // Eintrag mit leerem Wert
  extra?: [value: string, label: string][] // Einträge vor den Schriften, z. B. die Theme-Schriften (head/body) freier Texte
  'aria-label': string
  title?: string
}

export function FontPicker({ value, onChange, placeholder, extra = [], ...rest }: Props) {
  return (
    // Select hält bei offener Liste nur Pfeile hoch/runter, Enter und Esc an; Tippen und Pfeile links/rechts blätterten sonst Themes oder Folien
    <span className="font-pick" onKeyDown={(e) => { if (e.currentTarget.querySelector('[aria-expanded="true"]')) e.stopPropagation() }}>
      <Select value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)} className="font-pick-btn" {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {extra.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        {/* Schrift außerhalb der Liste (Slop-Schrift der KI, eigene) bleibt sichtbar statt auf den Platzhalter zu fallen */}
        {value && !KNOWN.has(value) && !extra.some(([v]) => v === value) && <option value={value} style={styleOf(value)}>{value}</option>}
        {GROUPS.map(([g, fonts]) => (
          <optgroup key={g} label={g}>
            {fonts.map((f) => <option key={f} value={f} style={styleOf(f)}>{label(f)}</option>)}
          </optgroup>
        ))}
        <optgroup label="Weitere Schriften (werden bei Bedarf geladen)">
          {MORE.map((i) => <option key={i.family} value={i.family} style={styleOf(i.family)} data-hint={`${CAT_NAMES[i.cat]} · ${i.mood}`}>{label(i.family)}</option>)}
        </optgroup>
      </Select>
    </span>
  )
}

export interface FontsLoaded { fontFiles: Record<string, FontFiles>; notes: string[] }
// Nach der Wahl einer Katalogschrift (nicht gebündelt, nicht Office): Main lädt fehlende Schnitte (Cache ~/Deckwerk/fonts, offline
// Ersatz) und bestimmt fontFiles aus dem ganzen Deck (deck = Stand mit der Wahl). App.tsx mischt neue Einträge ohne eigenen
// Undo-Schritt in den dann aktuellen Stand, so überschreibt ein veraltetes Ergebnis nichts, und zeigt die Hinweise. Liefert die Hinweise.
export async function ensureFonts(deck: Deck, ...fonts: (string | undefined)[]): Promise<string[]> {
  if (!fonts.some((n) => n && !(n in FONTS) && fontInfo(n) && !fontInfo(n)!.office)) return []
  try {
    const { theme, notes } = await window.api.ensureFonts(deck)
    dispatchEvent(new CustomEvent<FontsLoaded>('dw:fonts', { detail: { fontFiles: theme.fontFiles ?? {}, notes } }))
    return notes
  } catch (e) {
    console.warn('[fonts]', e)
    return []
  }
}
