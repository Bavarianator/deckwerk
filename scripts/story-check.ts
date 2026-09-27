// Selbsttest für die Kapitel-Logik (Referentenansicht, Übersicht): npx esbuild … oder `node --experimental-strip-types`
import assert from 'node:assert/strict'
import { chaptersOf, titleOf } from '../src/renderer/ui/story.ts'

const deck = {
  slides: [
    { layout: 'cover', content: { title: 'Titel' } },
    { layout: 'section', content: { title: 'Das Problem' } },
    { layout: 'statement', content: { text: 'Ein **fetter** Satz' } },
    { layout: 'section', content: { title: 'Die Lösung' } },
  ],
} as any

assert.deepEqual(chaptersOf(deck), [
  { title: 'Einstieg', from: 0, to: 0 },
  { title: 'Das Problem', from: 1, to: 2 },
  { title: 'Die Lösung', from: 3, to: 3 },
])
assert.equal(titleOf(deck, 2), 'Ein fetter Satz')
console.log('story ok')
