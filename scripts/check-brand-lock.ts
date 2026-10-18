// Brand-Lock-Lint: npx esbuild scripts/check-brand-lock.ts --bundle --platform=node --format=esm --outfile=$TMPDIR/check-brand-lock.mjs && node $TMPDIR/check-brand-lock.mjs
import { deepStrictEqual as eq } from 'node:assert'
import type { Deck, Measured } from '../src/shared/deck'
import { lintDeck, lintSlide } from '../src/shared/lint'

const empty: Measured = { els: [], fit: { ok: true, head: 0, body: 0, overflow: [] } }
const brand = { primary: '#0A7A5C', secondary: '#F2B705', headFont: 'Inter', bodyFont: 'Inter' }
const deck = (lock: boolean, item: object, theme: object = {}): Deck =>
  ({ title: 't', theme: { id: 'beratung', brand: { ...brand, lock }, ...theme },
    slides: [{ id: 's1', layout: 'statement', content: { text: 'Test' }, items: [{ id: 'a', kind: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, ...item }] }] }) as Deck
const marke = (d: Deck) => lintSlide(d, 0, empty).filter((x) => x.rule === 'marke')
const markeDeck = (d: Deck) => lintDeck(d, [empty]).filter((x) => x.rule === 'marke')

// fremde Farbe bei gesperrter Marke → Fehler mit Slot
const f = marke(deck(true, { fill: '#FF0000' }))
eq(f.map((x) => [x.severity, x.slot]), [['error', 'items.a']])
eq(f[0].message.includes('#FF0000'), true)
// Markenfarbe, auch in anderer Schreibweise, und Theme-Farbe → kein Fehler
eq(marke(deck(true, { fill: '#0a7a5c', stroke: '#F2B705' })), [])
eq(marke(deck(true, { color: '#0A7A5D' })), []) // Rundung
// fremde Schrift → Fehler, head/body und Markenschrift nicht
eq(marke(deck(true, { kind: 'text', font: 'Playfair Display' })).length, 1)
eq(marke(deck(true, { kind: 'text', font: 'head' })), [])
eq(marke(deck(true, { kind: 'text', font: 'Inter' })), [])
// eigener Folienhintergrund in fremder Farbe
const bg = deck(true, {}); bg.slides[0].bg = { gradient: ['#FF0000', '#0A7A5C'] }
eq(marke(bg).length, 1)
// ohne lock: keine Marke-Meldungen
eq(marke(deck(false, { fill: '#FF0000' })), [])
eq(markeDeck(deck(false, {}, { shuffle: 2 })), [])
// Deck-weit: shuffle, fremdes Schriftpaar, eigener Akzent ≠ Marke
eq(markeDeck(deck(true, {}, { shuffle: 2 })).map((x) => x.severity), ['error'])
eq(markeDeck(deck(true, {}, { fonts: ['Playfair Display', 'Inter'] })).length, 1)
const custom = (accent: string) => ({ custom: { name: 'x', bg: '#FFFFFF', accent, headFont: 'Inter', bodyFont: 'Inter', radius: 0, decor: 'none' } })
eq(markeDeck(deck(true, {}, custom('#FF0000'))).length, 1)
eq(markeDeck(deck(true, {}, custom('#0A7A5C'))), [])
eq(markeDeck(deck(true, {})), [])
console.log('check-brand-lock ok')
