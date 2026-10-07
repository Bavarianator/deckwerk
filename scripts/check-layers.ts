// Ebenen-Panel, Reihenfolge per Ziehen: npx esbuild scripts/check-layers.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-layers.mjs && node ${TMPDIR:-/tmp}/check-layers.mjs
import assert from 'node:assert/strict'
import type { Item } from '../src/shared/deck'
import { moveNextTo, reorder, withGroups } from '../src/renderer/ui/itemOps'

const make = (ids: string) => [...ids].map((id): Item => ({ id, kind: 'shape', x: 0, y: 0, w: 1, h: 1, group: /[A-Z]/.test(id) ? 'G' : undefined }))
const ids = (l: Item[]) => l.map((it) => it.id).join('')
const items = make('abcd')

assert.equal(ids(moveNextTo(items, ['a'], 'c', true)), 'bcad') // a über c (davor gezeichnet)
assert.equal(ids(moveNextTo(items, ['d'], 'a', false)), 'dabc') // above=false: d unter a = ganz nach hinten
assert.equal(ids(moveNextTo(items, ['c'], 'a', false)), 'cabd')
assert.equal(ids(moveNextTo(items, ['a', 'c'], 'd', true)), 'bdac') // Mehrfachauswahl bleibt zusammen und in ihrer Reihenfolge
assert.equal(ids(moveNextTo(items, ['d', 'a'], 'b', false)), 'adbc')
assert.equal(ids(moveNextTo(items, ['b'], 'b', true)), 'abcd') // Anker in ids: unverändert
assert.equal(ids(moveNextTo(items, ['a', 'b'], 'b', false)), 'abcd')
assert.equal(ids(moveNextTo(items, ['b'], 'x', true)), 'abcd') // unbekannter Anker: unverändert

// Gruppen (Großbuchstaben = Gruppe G): Block bleibt zusammenhängend, fremde Elemente nie zwischen Mitgliedern
const grouped = make('aXYbc')
const whole = (l: Item[]) => assert.match(ids(l), /XY/, `Gruppe zerrissen: ${ids(l)}`)
whole(moveNextTo(grouped, ['c'], 'X', true)) // über das untere Mitglied gezogen → über die ganze Gruppe
assert.equal(ids(moveNextTo(grouped, ['c'], 'X', true)), 'aXYcb')
assert.equal(ids(moveNextTo(grouped, ['c'], 'Y', false)), 'acXYb') // unter das obere Mitglied → unter die ganze Gruppe
assert.equal(ids(moveNextTo(grouped, withGroups(grouped, ['X']), 'c', true)), 'abcXY') // Mitgliedszeile zieht die ganze Gruppe
assert.equal(ids(moveNextTo(grouped, withGroups(grouped, ['Y']), 'a', false)), 'XYabc')
assert.equal(ids(moveNextTo(grouped, withGroups(grouped, ['X']), 'Y', true)), 'aXYbc') // Anker in der eigenen Gruppe: unverändert
// eine Ebene (Alt+Pfeil, Strg+]/[): fremde Gruppe wird als Ganzes übersprungen
assert.equal(ids(reorder(grouped, ['a'], 'forward')), 'XYabc')
assert.equal(ids(reorder(grouped, ['b'], 'backward')), 'abXYc')
assert.equal(ids(reorder(grouped, withGroups(grouped, ['X']), 'forward')), 'abXYc')
assert.equal(ids(reorder(grouped, ['X'], 'forward')), 'aYXbc') // innerhalb der eigenen Gruppe weiter schrittweise
for (const anchor of 'aXYbc') for (const above of [true, false]) for (const sel of ['a', 'b', 'c', 'ab', 'bc']) whole(moveNextTo(grouped, [...sel], anchor, above))
console.log('layers ok')
