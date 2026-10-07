// Folien ausblenden: npx esbuild scripts/check-hidden.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/check-hidden.mjs && node out/check-hidden.mjs
import { deepStrictEqual as eq, ok } from 'node:assert'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { showOf, visibleSlides, type Deck } from '../src/shared/deck'
import { LAYOUTS } from '../src/shared/layouts'
import { buildTools } from '../src/main/tools'
import { postProcess } from '../src/main/pptx-post'

const content = LAYOUTS.statement.samples.typ
const deck: Deck = {
  title: 'Test', theme: { id: 'beratung' }, transition: 'fade', mode: 'click',
  slides: ['a', 'b', 'c', 'd'].map((id) => ({ id, layout: 'statement', content, hidden: id === 'b' || id === 'd' })),
}
const ids = (d: Deck) => d.slides.map((s) => s.id)

// Export und Präsentieren: nur sichtbare Folien; Start auf ausgeblendeter Folie → nächste sichtbare, am Ende → letzte
eq(visibleSlides(deck).map((s) => s.id), ['a', 'c'])
eq(ids(showOf(deck, 0).deck), ['a', 'c'])
eq([0, 1, 2, 3].map((i) => showOf(deck, i).start), [0, 1, 1, 1])
const none = { ...deck, slides: deck.slides.map((s) => ({ ...s, hidden: true })) }
eq(showOf(none, 2), { deck: none, start: 2 }) // alle ausgeblendet: ganzes Deck statt leer
const old = { ...deck, slides: deck.slides.map(({ hidden: _, ...s }) => s) } // altes Deck ohne Feld
eq(ids(showOf(old, 3).deck), ['a', 'b', 'c', 'd'])
eq(showOf(old, 3).start, 3)

// PowerPoint behält ausgeblendete Folien, aber versteckt (<p:sld show="0">), auch nach der XML-Nachbearbeitung
const pptx = new PptxGenJS()
for (const s of deck.slides) pptx.addSlide().hidden = !!s.hidden // wie export-pptx.ts
const zip = await JSZip.loadAsync(await postProcess((await pptx.write({ outputType: 'nodebuffer' })) as Buffer, deck))
const show = await Promise.all([1, 2, 3, 4].map(async (n) => /<p:sld [^>]*show="0"/.test(await zip.file(`ppt/slides/slide${n}.xml`)!.async('string'))))
eq(show, [false, true, false, true])

// KI: update_slide blendet aus und ein, Rückmeldung markiert ausgeblendete Folien
let cur: Deck | null = structuredClone(old)
const engine = { measure: async () => [], renderPng: async () => [], renderOverview: async () => Buffer.alloc(0), lint: async () => [], exportDeck: async () => [] }
const tools = buildTools({ engine: engine as never, getDeck: () => cur, setDeck: (d) => { cur = d }, assetDir: '/nonexistent', outDir: '/tmp/out' })
const run = (name: string, input: unknown) => { const t = tools.find((x) => x.name === name)!; return t.run(t.inputSchema.parse(input)) }
const r = await run('update_slide', { id: 'c', hidden: true })
eq(cur!.slides[2].hidden, true)
ok(r.text.includes('Folie 3 (c, statement) (ausgeblendet)'), r.text)
ok((await run('reorder_slides', { order: ['a', 'b', 'c', 'd'] })).text.includes('3:statement (ausgeblendet)'))
await run('update_slide', { id: 'c', hidden: false })
eq(cur!.slides[2].hidden, undefined)
console.log('check-hidden: ok')
