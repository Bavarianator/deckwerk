// KI-Merkmale im Lint (ki-sprache, ki-muster, mut): npx esbuild scripts/check-ki-look.ts --bundle --platform=node --format=esm --outfile=/tmp/check-ki-look.mjs && node /tmp/check-ki-look.mjs
import assert from 'node:assert/strict'
import type { Deck, Measured, Slide } from '../src/shared/deck'
import { lintDeck, lintSlide } from '../src/shared/lint'

const empty: Measured = { els: [], fit: { ok: true, head: 0, body: 0, overflow: [] } }
const deck = (slides: Slide[]): Deck => ({ title: 't', theme: { id: 'beratung' }, transition: 'none', mode: 'auto', slides })
const rules = (d: Deck) => lintDeck(d, d.slides.map(() => empty)).map((x) => `${x.slide}:${x.rule}`)
const bullets = (id: string, title: string, n: number): Slide =>
  ({ id, layout: 'bullets', content: { title, items: Array.from({ length: n }, (_, k) => ({ text: `Punkt ${k + 1}` })) } })

// ki-sprache: Floskel (auch flektiert), Emoji und „nicht nur … sondern“ in einer Meldung; Bildfelder zählen nicht
const ki = lintSlide(deck([{ id: 'a', layout: 'bullets', content: { title: 'Wir arbeiten **nahtlos** zusammen 🚀', items: [{ text: 'Nicht nur schnell, sondern auch günstig' }, { text: 'Echter Mehrwerte-Kram', icon: 'rocket' }] } }]), 0, empty)
  .filter((x) => x.rule === 'ki-sprache')
assert.equal(ki.length, 1)
assert.equal(ki[0].severity, 'warn')
for (const w of ['„nahtlos“', 'Emoji', '„nicht nur … sondern“', '„Mehrwerte“']) assert.ok(ki[0].message.includes(w), w)
const clean = lintSlide(deck([{ id: 'b', layout: 'bullets', content: { title: 'Der Umsatz wächst seit Q1 um 12 %', items: [{ text: 'Hebel: Preis', icon: 'innovativ' }, { text: '© 2026 Werk Nord' }] } }]), 0, empty)
assert.deepEqual(clean.filter((x) => x.rule === 'ki-sprache'), [])

// ki-muster: dritte Folie mit genau drei Punkten
const three = deck([
  { id: 'c', layout: 'cover', content: { title: 'Plan für 2027' } },
  bullets('1', 'Der Umsatz wächst', 3), bullets('2', 'Die Kosten sinken', 4), bullets('3', 'Das Team wächst', 3), bullets('4', 'Wir starten im März', 3),
])
assert.deepEqual(rules(three).filter((r) => r.endsWith('ki-muster')), ['4:ki-muster'])
// Doppelpunkt- und Gedankenstrich-Titel: je mehr als ein Drittel
const colon = deck([bullets('1', 'Markt: wächst schnell', 2), bullets('2', 'Team: ist stark', 2), bullets('3', 'Der Plan steht', 2)])
assert.deepEqual(rules(colon).filter((r) => r.endsWith('ki-muster')), ['0:ki-muster'])
const dash = deck([bullets('1', 'Der Markt wächst', 2), bullets('2', 'Das Team – stark wie nie', 2), bullets('3', 'Der Plan—fertig', 2)])
assert.deepEqual(rules(dash).filter((r) => r.endsWith('ki-muster')), ['1:ki-muster'])

// mut: 9 Folien ohne Ton/Foto → Meldung an Folie 0; eine big-number auf Akzent reicht
const plain = deck(Array.from({ length: 9 }, (_, k) => bullets(String(k), `Aussage Nummer ${k}`, 2 + (k % 3))))
assert.ok(rules(plain).includes('0:mut'))
const brave = deck([...plain.slides.slice(0, 8), { id: 'z', layout: 'big-number', tone: 'accent', content: { value: '42 %', text: 'mehr Abschlüsse' } }])
assert.ok(!rules(brave).some((r) => r.endsWith(':mut')))
// section ist ohnehin Akzent und zählt nicht
const sect = deck([...plain.slides.slice(0, 8), { id: 'z', layout: 'section', tone: 'accent', content: { title: 'Kapitel zwei' } }])
assert.ok(rules(sect).includes('0:mut'))

console.log('check-ki-look: ok')

// Fehlalarme aus dem Review: Mehrwertsteuer, Trendpfeile, Linkziele, „sondern“ im nächsten Satz, Dreier-Diagramme
const legit = lintSlide(deck([{ id: 'l', layout: 'bullets', content: { title: 'Preise ab Q3 inkl. Mehrwertsteuer ↗', items: [{ text: 'Nicht nur heute. Sondern morgen' }, { text: '[Kontakt](https://innovativ-gmbh.de)' }] } }]), 0, empty)
assert.deepEqual(legit.filter((x) => x.rule === 'ki-sprache'), [])
const chart = (id: string): Slide => ({ id, layout: 'chart', content: { title: `Umsatz ${id}`, chart: { type: 'bar', categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'a', values: [1, 2, 3] }] } } })
assert.ok(!rules(deck([chart('1'), chart('2'), chart('3')])).some((r) => r.endsWith('ki-muster')))
// poster mit Foto fällt im Renderer auf normal zurück und zählt nicht als Mut
const filler = Array.from({ length: 8 }, (_, k) => bullets(`f${k}`, `Folie ${k}`, 2))
assert.ok(rules(deck([...filler, { id: 'p', layout: 'big-number', variant: 'poster', content: { value: '41 %', label: 'x', image: { src: 'asset://a.jpg' } } }])).includes('0:mut'))
console.log('ki-look: Fehlalarme ok')
