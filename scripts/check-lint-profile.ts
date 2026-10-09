// Lint-Profile je Format (Folien, Social, A4): npx esbuild scripts/check-lint-profile.ts --bundle --platform=node --format=esm --outfile=out/check-lint-profile.mjs && node out/check-lint-profile.mjs
import { deepStrictEqual as eq } from 'node:assert'
import { FORMATS, formatSuffix, profileOf, type Deck, type ImgEl, type Measured, type Size, type TextEl } from '../src/shared/deck'
import { isA4 } from '../src/shared/deck'
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
eq(profileOf({ size: size('visitenkarte') }), 'doc') // Druck, aber kein A4: druckt in eigener Größe
eq([isA4(size('a4')), isA4(size('a4-quer')), isA4(size('visitenkarte'))], [true, true, false])

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

// Druckauflösung (nur A4): Vollbild per cover, Querformat 2560×1707 ≈ 146 ppi, Hochformat 2560×3840 ≈ 310 ppi; ohne nat still
const photo = (nat?: ImgEl['nat']): Measured => ({ els: [{ kind: 'img', slot: 'image', box: { x: 0, y: 0, w: 794, h: 1123 }, src: 'asset:///foto.jpg', radius: 0, fit: 'cover', focus: { x: 0.5, y: 0.5 }, under: true, nat } as ImgEl], fit: { ok: true, head: 0, body: 0, overflow: [] } })
const res = (d: Deck, m: Measured) => lintSlide(d, 0, m).filter((i) => i.rule === 'print-res')
const quer = res(deck('a4'), photo({ w: 2560, h: 1707 }))
eq(quer.length, 1)
eq(quer[0].message.includes('146 ppi'), true)
eq(res(deck('a4'), photo({ w: 2560, h: 3840 })).length, 0)
eq(res(deck('a4'), photo()).length, 0)
eq(res(deck(), photo({ w: 2560, h: 1707 })).length, 0)

// Formatkürzel im Exportnamen: präparierte Größe aus fremder deck.json darf keinen Pfad in den Namen bringen
eq(formatSuffix(FORMATS['4:5']), '-4x5')
eq(formatSuffix({ w: 800, h: 600 }), '-800x600')
eq(formatSuffix({ w: '/../../../.claude/', h: '/../CLAUDE' } as unknown as Size), '')
console.log('check-lint-profile: ok')
