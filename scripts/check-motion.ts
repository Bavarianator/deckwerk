// Animations-Lint und Übergang pro Folie: npx esbuild scripts/check-motion.ts --bundle --platform=node --format=esm --outfile=out/check-motion.mjs && node out/check-motion.mjs
import assert from 'node:assert/strict'
import { morphNames, transitionOf, type Deck, type Measured } from '../src/shared/deck'
import { lintMotion } from '../src/shared/lint'
import { buildOf } from '../src/shared/layouts'

const m = (...slots: string[]): Measured => ({
  els: slots.map((slot, build) => ({ kind: 'box', slot, build, box: { x: 0, y: 0, w: 1, h: 1 }, radius: 0, ellipse: false })),
  fit: { ok: true, head: 0, body: 0, overflow: [] },
})
const deck: Deck = { title: 't', theme: { id: 'beratung' }, transition: 'fade', mode: 'click', slides: [
  { id: 'a', layout: 'agenda', content: {} },
  { id: 'b', layout: 'agenda', content: {}, transition: 'morph' }, // gemeinsame Punkte → ok
  { id: 'c', layout: 'bullets', content: {}, transition: 'morph' }, // nur Titel gemeinsam → Warnung
  { id: 'd', layout: 'bullets', content: {}, transition: 'push', build: 'list' }, // fremder Übergang, 7 Klicks
] }
const measured = [m('title', 'items.0.title', '_active'), m('title', 'items.0.title', '_active'), m('title', 'other'), m('title', 'a', 'b', 'c', 'd', 'e', 'f')]
assert.deepEqual(lintMotion(deck, measured).map((x) => `${x.slide}:${x.rule}`), ['2:morph', '3:transition', '3:clicks'])
assert.equal(transitionOf(deck, 0), 'none')
assert.equal(transitionOf(deck, 1), 'morph')
assert.equal(transitionOf(deck, 9), 'fade')
assert.deepEqual(lintMotion({ ...deck, mode: 'auto' }, measured).map((x) => x.rule), ['morph', 'transition'])

// Zuordnung: gleicher Text vor gleichem Slot; verdrängter Slot bekommt einen eigenen Namen
const agenda = [{ slot: 'title', key: 'agenda' }, { slot: 'items.0.title', key: 'ausgangslage' }, { slot: 'items.1.title', key: 'marktchance' }, { slot: '_active' }]
assert.deepEqual(morphNames(agenda, [{ slot: 'title', key: 'marktchance' }, { slot: 'number', key: '02' }]), ['items.1.title', 'number'])
assert.deepEqual(morphNames([{ slot: 'title', key: 'a' }, { slot: 'x', key: 'b' }], [{ slot: 'x', key: 'a' }, { slot: 'title', key: 'c' }]), ['title', 'title~'])
assert.deepEqual(morphNames(agenda, agenda), ['title', 'items.0.title', 'items.1.title', '_active']) // gleiche Folie: alles bleibt
assert.deepEqual(morphNames([{ slot: 'images.2', key: 'img:a.jpg' }], [{ slot: 'image', key: 'img:a.jpg' }]), ['images.2'])
// Lint zählt Text-Paare: Agenda-Punkt → Kapiteltitel ist ein echter Morph
const txt = (slot: string, text: string) => ({ kind: 'text', slot, runs: [{ text }], box: { x: 0, y: 0, w: 1, h: 1 } }) as unknown as Measured['els'][number]
const mt = (...els: Measured['els']): Measured => ({ els, fit: { ok: true, head: 0, body: 0, overflow: [] } })
const chap: Deck = { ...deck, slides: [deck.slides[0], { id: 's', layout: 'section', content: {}, transition: 'morph' }] }
assert.deepEqual(lintMotion(chap, [mt(txt('title', 'Agenda'), txt('items.1.title', 'Marktchance')), mt(txt('title', 'Marktchance'))]), [])
assert.equal(lintMotion(chap, [mt(txt('title', 'Agenda')), mt(txt('title', 'Marktchance'))])[0]?.rule, 'morph')
// Magic Animate: none schaltet alles ab (außer eigenem build), lebhaft gibt Folien mit Foto den Foto-Zoom
const md = (motion: Deck['motion'], ...slides: Deck['slides']): Deck => ({ ...deck, motion, slides })
const foto = { id: 'p', layout: 'photo', content: { title: 'x', image: { src: 'asset://local/a.jpg' } } }
assert.equal(buildOf(md('none', { id: 'k', layout: 'kpi-grid', content: {} }), 0), 'none')
assert.equal(buildOf(md('none', { id: 'k', layout: 'kpi-grid', content: {}, build: 'pop' }), 0), 'pop')
assert.equal(buildOf(md('lively', foto), 0), 'photo')
assert.equal(buildOf(md('lively', { ...foto, layout: 'gallery' }), 0) === 'photo', false, 'Galerie ohne Foto-Zoom')
assert.equal(buildOf(md('standard', foto), 0) === 'photo', false)
console.log('ok')
