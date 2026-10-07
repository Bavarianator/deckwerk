// Suchen & Ersetzen: npx esbuild scripts/check-find.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-find.mjs && node ${TMPDIR:-/tmp}/check-find.mjs
import assert from 'node:assert/strict'
import type { Deck } from '../src/shared/deck'
import { findInDeck, replaceInDeck } from '../src/shared/find'

const deck: Deck = {
  title: 'Umsatz 2026', theme: { id: 'beratung' }, transition: 'fade', mode: 'click',
  slides: [
    { id: 's1', layout: 'cover', content: { title: 'Der Umsatz wächst', image: { src: 'asset://local/home/umsatz.jpg', look: 'mono' } }, notes: 'Umsatz kurz erklären' },
    { id: 's2', layout: 'bullets', content: { title: 'Drei Gründe', items: [{ text: 'umsatzstark im Süden', icon: 'umsatz' }, { text: 'Mehr [Umsatz](https://umsatz.de) online' }] } },
    { id: 's3', layout: 'chart', content: { title: 'Plan', chart: { type: 'line', categories: ['2025', 'Umsatz'], series: [{ name: 'Linie', values: [1, 2] }], highlight: 'Umsatz' } } },
    { id: 's4', layout: 'blank', content: {}, items: [
      { id: 'umsatz', kind: 'text', x: 0, y: 0, w: 100, h: 20, text: 'Freier Umsatz', color: '#123456' },
      { id: 'b', kind: 'image', x: 0, y: 0, w: 100, h: 100, src: 'asset://local/umsatz.png' },
      { id: 'q', kind: 'qr', x: 0, y: 0, w: 100, h: 100, text: 'https://umsatz.de' },
    ] },
  ],
}
const before = JSON.stringify(deck)

// Fundstellen: Deck-Titel, Titel, Notizen, Aufzählung (ohne Link-Adresse und Icon), Diagramm, freier Text
const all = findInDeck(deck, 'umsatz')
assert.deepEqual(all.map((h) => `${h.slide}:${h.where}`), [
  '-1:title', '0:content.title', '0:notes', '1:content.items.0.text', '1:content.items.1.text', '2:content.chart.categories.1', '3:items.umsatz',
])
assert.deepEqual(all.slice(0, 3).map((h) => h.label), ['Deck-Titel', 'Titel', 'Notizen'])
assert.equal(all[3].label, 'Liste')
assert.equal(all.at(-1)!.label, 'Textfeld')
assert.ok(all[1].text.includes('Der Umsatz wächst'))
// Groß/klein und ganzes Wort
assert.equal(findInDeck(deck, 'umsatz', { caseSensitive: true }).length, 1)
assert.equal(findInDeck(deck, 'Umsatz', { wholeWord: true }).length, 6) // „umsatzstark“ zählt nicht
assert.equal(findInDeck(deck, 'umsatz', { caseSensitive: true, wholeWord: true }).length, 0)
assert.equal(findInDeck(deck, '').length, 0)
assert.equal(findInDeck(deck, '2.2').length, 0) // Sonderzeichen sind kein Regex

// einzeln ersetzen: nur der gewählte Treffer
const one = replaceInDeck(deck, 'umsatz', 'Erlös', {}, all[2]).deck
assert.equal(one.slides[0].notes, 'Erlös kurz erklären')
assert.equal(one.slides[0].content.title, 'Der Umsatz wächst')
assert.equal(one.title, 'Umsatz 2026')
assert.equal(findInDeck(one, 'umsatz').length, all.length - 1)
// zweiter Treffer im selben Feld
const twice: Deck = { ...deck, slides: [{ id: 'x', layout: 'statement', content: { text: 'Umsatz und Umsatz' } }] }
assert.equal(replaceInDeck(twice, 'umsatz', 'X', {}, findInDeck(twice, 'umsatz').find((h) => h.n === 1)).deck.slides[0].content.text, 'Umsatz und X')

// alle ersetzen
const { deck: rep, skipped } = replaceInDeck(deck, 'Umsatz', 'Erlös', { wholeWord: true })
assert.equal(skipped, 0)
assert.equal(rep.title, 'Erlös 2026')
assert.equal(rep.slides[0].content.title, 'Der Erlös wächst')
assert.equal(rep.slides[1].content.items[0].text, 'umsatzstark im Süden')
assert.equal(rep.slides[1].content.items[1].text, 'Mehr [Erlös](https://umsatz.de) online')
assert.equal(rep.slides[2].content.chart.categories[1], 'Erlös')
assert.equal(rep.slides[2].content.chart.highlight, 'Erlös') // Bezug wandert mit der umbenannten Kategorie
assert.equal(rep.slides[3].items![0].text, 'Freier Erlös')
// unberührt: Bild-URLs, Icon-Namen, Farben, IDs, QR-Inhalt, Diagrammtyp und -zahlen
assert.equal(rep.slides[0].content.image.src, 'asset://local/home/umsatz.jpg')
assert.equal(rep.slides[1].content.items[0].icon, 'umsatz')
assert.equal(rep.slides[3].items![0].color, '#123456')
assert.equal(rep.slides[3].items![0].id, 'umsatz')
assert.equal(rep.slides[3].items![1].src, 'asset://local/umsatz.png')
assert.equal(rep.slides[3].items![2].text, 'https://umsatz.de')
assert.equal(replaceInDeck(deck, 'line', 'x').deck.slides[2].content.chart.type, 'line')
assert.deepEqual(replaceInDeck(deck, '2', '9').deck.slides[2].content.chart.series[0].values, [1, 2])
assert.equal(findInDeck(rep, 'Umsatz', { wholeWord: true }).length, 0)
assert.ok(!('items' in rep.slides[0]) && !('notes' in rep.slides[1])) // keine leeren Schlüssel

// nichts passt: dasselbe Deck; Eingabe bleibt unverändert
assert.deepEqual(replaceInDeck(deck, 'gibtsnicht', 'x'), { deck, skipped: 0 })

// Layout-Schema: zu lang (value max. 8) oder zu kurz (title min. 3) bleibt stehen und wird gezählt, der Rest wird ersetzt
const kpi: Deck = { ...deck, title: 'K', slides: [{ id: 'k', layout: 'kpi-grid', content: {
  title: 'Quote steigt', kpis: [{ value: '123,4 %', label: 'Quote Nord' }, { value: '9 %', label: 'Quote Süd' }] } }] }
const long = replaceInDeck(kpi, '%', ' Prozent')
assert.equal(long.skipped, 2)
assert.equal(long.deck, kpi)
const empty = replaceInDeck(kpi, 'Quote steigt', '')
assert.deepEqual([empty.skipped, empty.deck], [1, kpi])
const mixed = replaceInDeck(kpi, 'Quote', 'Rate')
assert.equal(mixed.skipped, 0)
assert.deepEqual(mixed.deck.slides[0].content.kpis.map((k: { label: string }) => k.label), ['Rate Nord', 'Rate Süd'])
const part = replaceInDeck(kpi, ' %', ' Pkt') // „123,4 Pkt“ (9) zu lang, „9 Pkt“ passt
assert.deepEqual([part.skipped, part.deck.slides[0].content.kpis.map((k: { value: string }) => k.value)], [1, ['123,4 %', '9 Pkt']])
const fit = replaceInDeck(kpi, ' %', '%')
assert.deepEqual([fit.skipped, fit.deck.slides[0].content.kpis.map((k: { value: string }) => k.value)], [0, ['123,4%', '9%']])
assert.equal(JSON.stringify(deck), before)
console.log('find ok')
