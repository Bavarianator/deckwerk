// Lint-Profile je Format (Folien, Social, A4): npx esbuild scripts/check-lint-profile.ts --bundle --platform=node --format=esm --outfile=out/check-lint-profile.mjs && node out/check-lint-profile.mjs
import { deepStrictEqual as eq } from 'node:assert'
import { FORMATS, profileOf, type Deck, type Measured, type TextEl } from '../src/shared/deck'
import { lintDeck, lintSlide } from '../src/shared/lint'

const size = (f: keyof typeof FORMATS) => ({ w: FORMATS[f].w, h: FORMATS[f].h })
eq(profileOf({}), 'slides')
eq(profileOf({ size: size('4:3') }), 'slides')
eq(profileOf({ size: size('og') }), 'slides')
eq(profileOf({ size: size('1:1') }), 'social')
eq(profileOf({ size: size('4:5') }), 'social')
eq(profileOf({ size: size('9:16') }), 'social')
eq(profileOf({ size: size('a4') }), 'doc')
eq(profileOf({ size: size('a4-quer') }), 'doc')

// ein Text mit sizePx und Wortzahl mitten auf der Seite
const text = (sizePx: number, words: number): TextEl => ({
  kind: 'text', slot: 'title', box: { x: 100, y: 100, w: 400, h: 60 }, font: 'body', role: 'body', sizePx, lineHeightPx: sizePx * 1.3, trackingPx: 0,
  align: 'left', upper: false, runs: [{ text: Array(words).fill('wort').join(' '), bold: false, italic: false, color: '#000000' }], lines: 1, bg: '',
} as TextEl)
const measured = (t: TextEl): Measured => ({ els: [t], fit: { ok: true, head: 0, body: 0, overflow: [] } })
const deck = (f?: keyof typeof FORMATS): Deck =>
  ({ title: 't', theme: { id: 'beratung' }, slides: [{ id: 's1', layout: 'statement', content: { text: 'Test' } }], ...(f && { size: size(f) }) }) as Deck
const rules = (d: Deck, t: TextEl) => lintSlide(d, 0, measured(t)).map((i) => i.rule)

// Mindestschrift: Folie 13 px, Social ab 1/60 der Breite (1080 px → 18 px, 720 px → 12 px), A4 12 px
eq(rules(deck(), text(12, 3)).includes('min-size'), true)
eq(rules(deck(), text(13, 3)).includes('min-size'), false)
eq(rules(deck('4:5'), text(17, 3)).includes('min-size'), true)
eq(rules(deck('4:5'), text(18, 3)).includes('min-size'), false)
eq(rules(deck('9:16'), text(12, 3)).includes('min-size'), false)
eq(rules(deck('a4'), text(12, 3)).includes('min-size'), false)

// Wortgrenzen: Folie 50, Social 30, A4 350
eq(rules(deck(), text(20, 51)).includes('density'), true)
eq(rules(deck('a4'), text(20, 51)).includes('density'), false)
eq(rules(deck('a4'), text(20, 351)).includes('density'), true)
eq(rules(deck('4:5'), text(20, 31)).includes('density'), true)

// Deck-Regeln (Struktur, Rhythmus, Atem) gibt es nur bei Folien
const many = (f?: keyof typeof FORMATS): Deck => ({ ...deck(f), slides: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, layout: 'bullets', content: { title: 'T', items: [{ title: 'a' }, { title: 'b' }] } })) }) as Deck
const els = (d: Deck) => d.slides.map(() => measured(text(20, 3)))
eq(lintDeck(many(), els(many())).some((i) => i.rule === 'structure'), true)
eq(lintDeck(many('4:5'), els(many('4:5'))).some((i) => i.rule === 'structure'), false)
eq(lintDeck(many('a4'), els(many('a4'))).some((i) => i.rule === 'structure' || i.rule === 'rhythm'), false)
console.log('check-lint-profile: ok')
