// Suchen & Ersetzen im ganzen Deck (Strg+F / Strg+H). Durchsucht nur Text, den man sieht: Folieninhalt, freie Textfelder,
// Notizen und den Deck-Titel. Rein und ohne DOM, damit der Selbsttest (scripts/check-find.ts) unter Node läuft.
import type { Deck } from './deck'
import { LAYOUTS, type LayoutId } from './layouts'

export interface FindOpts { caseSensitive?: boolean; wholeWord?: boolean }
// slide -1 = Deck-Titel; n = wievielter Treffer im selben Feld
export interface Hit { slide: number; where: string; n: number; label: string; text: string }

// Kein sichtbarer Text (Schemas in layouts*.ts): Bild-, Link-, QR- und Icon-Felder sowie Auswahlwerte. highlight verweist auf
// eine Kategorie bzw. ein Label und wandert beim Ersetzen mit (refs).
const SKIP = new Set(['image', 'src', 'icon', 'qr', 'video', 'captions', 'pauses', 'type', 'look', 'focus', 'mask', 'sentiment', 'annotate', 'highlight'])
const LABEL: Record<string, string> = { title: 'Titel', subtitle: 'Untertitel', eyebrow: 'Überzeile', source: 'Quelle', chart: 'Diagramm', items: 'Liste', points: 'Liste' }
const labelOf = (where: string) =>
  where === 'title' ? 'Deck-Titel' : where === 'notes' ? 'Notizen' : where.startsWith('items.') ? 'Textfeld' : LABEL[where.split('.')[1]] ?? 'Text'

const pattern = (q: string, o: FindOpts) => {
  const s = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(o.wholeWord ? `(?<![\\p{L}\\p{N}_])${s}(?![\\p{L}\\p{N}_])` : s, o.caseSensitive ? 'gu' : 'giu')
}
// Treffer in s; die Adresse eines Markdown-Links [Text](url) zählt nicht
function matches(s: string, re: RegExp) {
  const urls = [...s.matchAll(/\]\([^)]*\)/g)].map((m) => [m.index, m.index + m[0].length])
  return [...s.matchAll(re)].filter((m) => !urls.some(([a, b]) => m.index < b && m.index + m[0].length > a))
}

// Jeder sichtbare Text des Decks durch fn; where = Pfad wie 'content.items.0.text', 'items.<id>', 'notes', 'title'
type Fn = (s: string, slide: number, where: string) => string
const walk = (v: unknown, fn: (s: string, where: string) => string, where: string): unknown =>
  typeof v === 'string' ? fn(v, where)
    : Array.isArray(v) ? v.map((x, j) => walk(x, fn, `${where}.${j}`))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SKIP.has(k) ? x : walk(x, fn, `${where}.${k}`)]))
    : v
const mapTexts = (deck: Deck, fn: Fn): Deck => ({
  ...deck,
  title: fn(deck.title, -1, 'title'),
  slides: deck.slides.map((s, i) => ({
    ...s,
    content: walk(s.content, (t, w) => fn(t, i, w), 'content'),
    ...(s.items && { items: s.items.map((it) => (it.kind === 'text' && it.text ? { ...it, text: fn(it.text, i, `items.${it.id}`) } : it)) }),
    ...(s.notes !== undefined && { notes: fn(s.notes, i, 'notes') }),
  })),
})

export function findInDeck(deck: Deck, query: string, opts: FindOpts = {}): Hit[] {
  if (!query) return []
  const re = pattern(query, opts), hits: Hit[] = []
  mapTexts(deck, (s, slide, where) => {
    matches(s, re).forEach((m, n) => {
      const a = Math.max(0, m.index - 24), b = m.index + m[0].length + 40
      hits.push({ slide, where, n, label: labelOf(where), text: (a ? '…' : '') + s.slice(a, b).replace(/\s+/g, ' ') + (b < s.length ? '…' : '') })
    })
    return s
  })
  return hits
}

const setPath = (v: any, [k, ...rest]: string[], x: string): any =>
  k === undefined ? x : Array.isArray(v) ? v.map((y, i) => (String(i) === k ? setPath(y, rest, x) : y)) : { ...v, [k]: setPath(v?.[k], rest, x) }
// Würde das Feld gegen das Layout-Schema verstoßen (zu lang, zu kurz)? Sonst scheitert die nächste KI-Änderung der Folie
// in validateContent (tools.ts) an einem Feld, das sie nicht angefasst hat. Fehler anderer Felder zählen nicht.
function breaks(layout: string, content: unknown, where: string, t: string) {
  const path = where.split('.').slice(1)
  const r = LAYOUTS[layout as LayoutId]?.schema.safeParse(setPath(content, path, t))
  return !!r && !r.success && r.error.issues.some((i) => i.path.join('.') === path.join('.'))
}

// only = nur dieser Treffer (aus findInDeck), sonst alle. Passt nichts, kommt dasselbe Deck zurück.
// skipped = Treffer, die nicht ersetzt wurden, weil das Feld danach ungültig wäre.
export function replaceInDeck(deck: Deck, query: string, replacement: string, opts: FindOpts = {}, only?: Pick<Hit, 'slide' | 'where' | 'n'>): { deck: Deck; skipped: number } {
  if (!query) return { deck, skipped: 0 }
  const re = pattern(query, opts), renamed = new Map<number, Map<string, string>>()
  let changed = false, skipped = 0
  const out = mapTexts(deck, (s, slide, where) => {
    if (only && (only.slide !== slide || only.where !== where)) return s
    const ms = matches(s, re)
    const pick = only ? ms.slice(only.n, only.n + 1) : ms
    if (!pick.length) return s
    const t = pick.reduceRight((acc, m) => acc.slice(0, m.index) + replacement + acc.slice(m.index + m[0].length), s)
    if (where.startsWith('content.') && breaks(deck.slides[slide].layout, deck.slides[slide].content, where, t)) return (skipped += pick.length), s
    changed = true
    if (where.startsWith('content.')) renamed.set(slide, (renamed.get(slide) ?? new Map()).set(s, t))
    return t
  })
  if (!changed) return { deck, skipped }
  // highlight folgt einer umbenannten Kategorie bzw. einem Label, wenn es den alten Namen auf der Folie nicht mehr gibt
  const refs = (v: unknown, map: Map<string, string>, left: Set<string>): unknown =>
    Array.isArray(v) ? v.map((x) => refs(x, map, left))
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) =>
        [k, k === 'highlight' && typeof x === 'string' ? (!left.has(x) && map.get(x)) || x : refs(x, map, left)]))
      : v
  return { skipped, deck: { ...out, slides: out.slides.map((s, i) => {
    const map = renamed.get(i)
    if (!map) return s
    const left = new Set<string>()
    walk(s.content, (t) => (left.add(t), t), '')
    return { ...s, content: refs(s.content, map, left) }
  }) } }
}
