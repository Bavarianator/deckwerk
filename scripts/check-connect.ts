// Konnektoren: npx esbuild scripts/check-connect.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-connect.mjs && node ${TMPDIR:-/tmp}/check-connect.mjs
import assert from 'node:assert/strict'
import type { Item } from '../src/shared/deck'
import { connect, newConnector } from '../src/shared/items'
import { cloneItems } from '../src/renderer/ui/itemOps'

const box = (id: string, x: number, y: number): Item => ({ id, kind: 'shape', shape: 'rect', x, y, w: 100, h: 100 })
const line = newConnector('a', 'b', '#000000')

// waagerecht: Rand a (x=100) + 8 bis Rand b (x=300) − 8
let [, , l] = connect([box('a', 0, 0), box('b', 300, 0), line])
assert.deepEqual([l.x, l.y, l.w, l.rot], [108, 40, 184, undefined])

// senkrecht nach unten: um die Mitte um 90° gedreht
;[, , l] = connect([box('a', 0, 0), box('b', 0, 300), line])
assert.equal(l.rot, 90)
assert.equal(l.w, 184)
assert.equal(l.x + l.w / 2, 50) // Mitte liegt auf der Achse

// Ziel fehlt oder Elemente überlappen: Lage bleibt
assert.equal(connect([box('a', 0, 0), line])[1], line)
assert.equal(connect([box('a', 0, 0), box('b', 50, 0), line])[2], line)

// Duplizieren: mit beiden Enden hängt die Kopie an den Kopien, allein wird sie zur freien Linie
const [ka, kb, kl] = cloneItems([box('a', 0, 0), box('b', 300, 0), line])
assert.deepEqual([kl.from, kl.to], [ka.id, kb.id])
assert.deepEqual([cloneItems([line])[0].from, cloneItems([line])[0].to], [undefined, undefined])

console.log('check-connect: ok')
