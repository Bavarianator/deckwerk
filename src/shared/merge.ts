// Serienbrief (Canva „Bulk Create“): CSV-Zeilen füllen {{Spalte}} im Deck. Electron- und Node-frei, läuft auch im Renderer.
import type { Deck } from './deck'

const PH = /\{\{\s*([^{}]+?)\s*\}\}/g

/** CSV mit Kopfzeile; Trennzeichen , oder ; (häufigeres in der Kopfzeile außerhalb von Anführungszeichen), "" escapt ein Anführungszeichen */
export function parseCsv(text: string): Record<string, string>[] {
  text = text.replace(/^\uFEFF/, '')
  const n = { ',': 0, ';': 0 }
  let q = false
  for (const c of text) {
    if (c === '"') q = !q
    else if (!q && (c === '\n' || c === '\r')) break
    else if (!q && (c === ',' || c === ';')) n[c]++
  }
  const sep = n[';'] > n[','] ? ';' : ','
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false, start = true // start: Zellanfang, nur dort öffnet " (RFC 4180)
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') cell += '"', i++
      else if (c === '"') quoted = false
      else cell += c
      continue
    }
    if (c === '"' && start) quoted = true
    else if (c === sep) row.push(cell), cell = ''
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell), rows.push(row), row = [], cell = ''
    } else cell += c
    start = c === sep || c === '\n' || c === '\r'
  }
  row.push(cell), rows.push(row)
  const [keys = [], ...body] = rows.filter((r) => r.some((v) => v.trim()))
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k.trim(), r[i]?.trim() ?? ''])))
}

const fill = (s: string, row: Record<string, string>) => s.replace(PH, (m, k: string) => (Object.hasOwn(row, k) ? row[k] : m))

function walk(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => walk(x, f))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f)]))
  return v
}

/** Kopie des Decks mit ersetzten Platzhaltern in Titel, content, items[].text und Notizen; unbekannte bleiben stehen */
export function fillDeck(deck: Deck, row: Record<string, string>): Deck {
  const d = structuredClone(deck)
  const f = (s: string) => fill(s, row)
  d.title = f(d.title)
  for (const s of d.slides) {
    s.content = walk(s.content, f)
    if (s.notes) s.notes = f(s.notes)
    for (const it of s.items ?? []) if (it.text) it.text = f(it.text)
  }
  return d
}

/** Namen aller {{Platzhalter}} im Deck (gleiche Felder wie fillDeck) */
export function placeholders(deck: Deck): string[] {
  const names = new Set<string>()
  walk([deck.title, deck.slides.map((s) => [s.content, s.notes, s.items?.map((i) => i.text)])], (s) => {
    for (const m of s.matchAll(PH)) names.add(m[1])
    return s
  })
  return [...names]
}
