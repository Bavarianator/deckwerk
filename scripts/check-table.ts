// Tabellen-Element: npx esbuild scripts/check-table.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-table.mjs && node ${TMPDIR:-/tmp}/check-table.mjs
import assert from 'node:assert/strict'
import type { Deck } from '../src/shared/deck'
import { cellsToCsv, csvToCells, itemSchema, newTable, squareCells } from '../src/shared/items'
import { handout } from '../src/shared/handout'
import { findInDeck, replaceInDeck } from '../src/shared/find'
import { fillDeck, placeholders } from '../src/shared/merge'

// CSV-Rundreise, Tab-Trenner, ungleich lange Zeilen
assert.deepEqual(csvToCells(cellsToCsv([['a', 'b'], ['c', 'd']])), [['a', 'b'], ['c', 'd']])
assert.deepEqual(csvToCells('a\tb\tc\nd'), [['a', 'b', 'c'], ['d', '', '']])
assert.deepEqual(squareCells([['a'], ['b', 'c']]), [['a', ''], ['b', 'c']])
assert.equal(csvToCells('  \n'), null)

// Begrenzung 16 × 8
const big = csvToCells(Array.from({ length: 20 }, () => Array(10).fill('x').join(';')).join('\n'))!
assert.deepEqual([big.length, big[0].length], [16, 8])

// Schema: 8 Spalten ok, 9 nicht
const t = newTable()
assert.ok(itemSchema.safeParse(t).success)
assert.ok(!itemSchema.safeParse({ ...t, cells: [Array(9).fill('x')] }).success)

const deck: Deck = {
  title: 'T', theme: { id: 'beratung' }, transition: 'fade', mode: 'click',
  slides: [{ id: 's', layout: 'blank', content: {}, items: [{ ...t, id: 't', cells: [['Posten', '{{Jahr}}'], ['A|B', 'Umsatz']] }] }],
}

// Handout: Kopf, Trennzeile, escaptes |
assert.ok(handout(deck).includes('| Posten | {{Jahr}} |\n|---|---|\n| A\\|B | Umsatz |'))

// Suchen/Ersetzen in Zellen
assert.equal(findInDeck(deck, 'umsatz').length, 1)
const r = replaceInDeck(deck, 'Umsatz', 'Gewinn').deck
assert.equal(r.slides[0].items![0].cells![1][1], 'Gewinn')
assert.equal(deck.slides[0].items![0].cells![1][1], 'Umsatz')

// Serienbrief
assert.deepEqual(placeholders(deck), ['Jahr'])
assert.equal(fillDeck(deck, { Jahr: '2026' }).slides[0].items![0].cells![0][1], '2026')

console.log('check-table: ok')
