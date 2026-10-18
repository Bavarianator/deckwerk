// Fixture-Erzeuger für die Differenztests von dw-pptx; Aufruf über gen.mjs (bündelt diese Datei mit esbuild).
// Jede Fixture hält Eingabe und TS-Ausgabe; tests/diff.rs rechnet dieselbe Eingabe in Rust und vergleicht.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { injectSlide, transitionXml, type AnimStep } from '../../../../src/main/animations'
import { addChart, stepsFor, ITEM_FX } from '../../../../src/main/export-pptx'
import { addSections, agendaLinks, postProcess } from '../../../../src/main/pptx-post'
import { adjustBlip, maskShape, recolor, textEffect } from '../../../../src/main/patch-xml'
import { ttfToEot } from '../../../../src/main/embed-fonts'
import { chartColors } from '../../../../src/shared/charts'
import { TRANSITIONS, animStartOf, type ChartSpec, type ChartEl, type Deck } from '../../../../src/shared/deck'
import { duotoneOf, resolveTheme } from '../../../../src/shared/themes'

const dir = process.env.DW_FIXTURES!
const root = process.env.DW_ROOT!
const save = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data, null, 1) + '\n')

// ---------- Übergänge ----------
save('transitions.json', TRANSITIONS.flatMap((t) => ([undefined, 'slow', 'fast'] as const).map((speed) => ({ t, speed: speed ?? null, xml: transitionXml(t, speed) }))))

// ---------- Zeitleiste ----------
interface FShape { name: string; kind: 'sp' | 'pic' | 'graphicFrame'; txBox?: boolean; paras?: string[][]; chart?: boolean }
const shapeXml = (s: FShape, id: number) => {
  const cnv = `<p:cNvPr id="${id}" name="${s.name}"/>`
  if (s.kind === 'pic') return `<p:pic><p:nvPicPr>${cnv}<p:cNvPicPr/><p:nvPr/></p:nvPicPr></p:pic>`
  if (s.kind === 'graphicFrame') return `<p:graphicFrame><p:nvGraphicFramePr>${cnv}</p:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/${s.chart ? 'chart' : 'picture'}"/></a:graphic></p:graphicFrame>`
  const paras = (s.paras ?? []).map((p) => `<a:p>${p.map((t) => `<a:r><a:t>${t}</a:t></a:r>`).join('')}</a:p>`).join('')
  return `<p:sp><p:nvSpPr>${cnv}<p:cNvSpPr${s.txBox ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr><p:spPr/>${paras ? `<p:txBody><a:bodyPr/>${paras}</p:txBody>` : ''}</p:sp>`
}
const timing = (shapes: FShape[], steps: AnimStep[], transition: string = 'none', speed?: 'slow' | 'fast') => {
  const xml = `<p:sld><p:cSld><p:spTree>${shapes.map((s, i) => shapeXml(s, i + 2)).join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  const outXml = injectSlide(xml, { transition: transition as never, speed, steps }, 'fixture')
  return outXml.slice(outXml.indexOf('</p:clrMapOvr>') + '</p:clrMapOvr>'.length, outXml.lastIndexOf('</p:sld>'))
}
const T = (name: string, ...paras: string[][]): FShape => ({ name, kind: 'sp', txBox: true, paras })
const shapes: FShape[] = [
  T('dw:title', ['Die große Überschrift']),
  T('dw:body', ['Erster Punkt hier'], ['Zweiter', ' Punkt'], ['  ']),
  { name: 'dw:box', kind: 'sp' },
  { name: 'dw:photo', kind: 'pic' },
  { name: 'dw:chart', kind: 'graphicFrame', chart: true },
  { name: 'dw:frame', kind: 'graphicFrame' },
  T('dw:empty', ['   ']),
  { name: 'dw:label', kind: 'sp', txBox: false, paras: [['Text in Form']] },
]
const names = shapes.map((s) => s.name)
const cases: { name: string; steps: AnimStep[]; transition?: string; speed?: 'slow' | 'fast' }[] = []
// alle Effekte in allen Richtungen, je Auslöser
const effects = ['fade', 'float', 'pan', 'drift', 'pop', 'zoom', 'stomp', 'baseline', 'wipe', 'appear', 'pulse', 'grow'] as const
for (const effect of effects) for (const dir of [undefined, 'right', 'left', 'up', 'down'] as const)
  cases.push({ name: `effect-${effect}-${dir ?? 'std'}`, steps: [{ shape: 'dw:title', effect, trigger: 'click', dir }, { shape: 'dw:photo', effect, trigger: 'after', dir, durMs: 700, delayMs: 100 }, { shape: 'dw:box', effect, trigger: 'with', dir }] })
cases.push({ name: 'iterate', steps: [
  { shape: 'dw:title', effect: 'float', by: 'word', trigger: 'after', durMs: 400 },
  { shape: 'dw:body', effect: 'appear', by: 'letter', trigger: 'after', durMs: 1, gapMs: 27 },
  // nicht dabei: Leerraum-Text. TS hält ihn für Text (/<a:t>[^<]*\S/ trifft das „<“ von </a:t>), Rust nicht
  { shape: 'dw:photo', effect: 'fade', by: 'word', trigger: 'after' },
  { shape: 'dw:frame', effect: 'zoom', by: 'word', trigger: 'after' },
] })
cases.push({ name: 'paragraphs', steps: [
  { shape: 'dw:body', effect: 'float', trigger: 'click', paragraph: 0 },
  { shape: 'dw:body', effect: 'float', trigger: 'click', paragraph: 1 },
  { shape: 'dw:body', effect: 'float', trigger: 'click', paragraph: 7 },
  { shape: 'dw:photo', effect: 'fade', trigger: 'click', paragraph: 0 },
  { shape: 'dw:fehlt', effect: 'fade', trigger: 'click' },
  { shape: 'dw:chart', effect: 'wipe', trigger: 'after' },
  { shape: 'dw:label', effect: 'fade', trigger: 'after' },
  { shape: 'dw:body', effect: 'fade', trigger: 'after' },
] })
cases.push({ name: 'with-first', steps: [{ shape: 'dw:box', effect: 'pulse', trigger: 'with', durMs: 1200 }, { shape: 'dw:title', effect: 'fade', trigger: 'with', delayMs: 300 }, { shape: 'dw:body', effect: 'grow', trigger: 'after', durMs: 12000, delayMs: 50 }] })
cases.push({ name: 'nothing', steps: [], transition: 'morph', speed: 'slow' })
cases.push({ name: 'transition+steps', steps: [{ shape: 'dw:title', effect: 'fade', trigger: 'click' }], transition: 'fade', speed: 'fast' })
// Aufbau-Presets (stepsFor) mit drei Gruppen, Klick- und Selbstlauf
const groups = new Map([[0, ['dw:title']], [1, ['dw:body', 'dw:box']], [3, ['dw:photo', 'dw:chart', 'dw:label']]])
const presets = ['none', 'fade', 'list', 'stagger', 'wipe', 'zoom-kpi', 'pan', 'pop', 'words', 'photo'] as const
const presetCases = presets.flatMap((preset) => (['click', 'auto'] as const).map((mode) => ({ preset, mode, steps: stepsFor(preset, groups, mode) })))
for (const p of presetCases) cases.push({ name: `preset-${p.preset}-${p.mode}`, steps: p.steps })
// Element-Animationen wie in buildPptx (Tempo, Richtung, Start, Verzögerung)
const itemCases: { anim: string; dir?: string; speed?: string; start?: string; delay: number; mode: 'click' | 'auto' }[] = []
for (const anim of Object.keys(ITEM_FX)) for (const [dir, speed, start, delay, mode] of [[undefined, undefined, undefined, 0, 'click'], ['left', 'slow', 'with', 1.5, 'click'], ['down', 'fast', 'after', 0.25, 'auto'], [undefined, undefined, 'click', 0, 'auto']] as const)
  itemCases.push({ anim, dir, speed, start, delay, mode })
const itemStep = (c: (typeof itemCases)[number], shape: string): AnimStep => {
  const fx = ITEM_FX[c.anim as keyof typeof ITEM_FX], f = c.speed === 'slow' ? 1.6 : c.speed === 'fast' ? 0.6 : 1
  const step: AnimStep = { shape, ...fx, durMs: Math.round((fx.durMs ?? 500) * f), dir: c.dir as AnimStep['dir'], gapMs: fx.by ? Math.round((fx.by === 'word' ? 120 : 45) * f) : undefined, trigger: animStartOf(c.start as never, c.mode), delayMs: Math.round(c.delay * 1000) }
  return c.anim === 'breathe' ? { ...step, trigger: 'with', delayMs: 0 } : step
}
const itemNames = names.filter((n) => n !== 'dw:empty') // Leerraum-Text, siehe oben
const items = itemCases.map((c, k) => ({ ...c, shape: itemNames[k % itemNames.length], steps: [itemStep(c, itemNames[k % itemNames.length])] }))
for (const it of items) cases.push({ name: `item-${it.anim}-${it.mode}-${it.start ?? 'std'}`, steps: it.steps })
save('timing.json', { shapes, presets: presetCases.map(({ preset, mode }) => ({ preset, mode })), groups: [...groups], items: items.map(({ steps: _, ...c }) => c), cases: cases.map((c) => ({ ...c, xml: timing(shapes, c.steps, c.transition, c.speed) })) })

// ---------- Abschnitte und Agenda-Links ----------
const deck = (slides: { layout: string; content: Record<string, unknown> }[]): Deck => ({ title: 'T', theme: { id: 'beratung' }, transition: 'none', slides: slides.map((s, i) => ({ id: `s${i}`, ...s })) } as unknown as Deck)
const decks = [
  deck([{ layout: 'title', content: { title: 'Start' } }, { layout: 'agenda', content: { items: [{ title: 'Markt und Lage' }, { title: 'Die Lösung' }, { title: 'Team' }, { title: 'Ausblick 2030' }] } }, { layout: 'section', content: { number: '01', title: 'Der Markt' } }, { layout: 'bullets', content: {} }, { layout: 'section', content: { number: 2, title: 'Unsere Lösung' } }, { layout: 'section', content: { title: '' } }, { layout: 'section', content: { number: 0, title: 'Ausblick & Ziele <2030>' } }]),
  deck([{ layout: 'section', content: { title: 'Gleich zu Beginn' } }, { layout: 'agenda', content: { items: [{ title: 'Beginn' }, {}] } }, { layout: 'quote', content: {} }]),
  deck([{ layout: 'title', content: {} }, { layout: 'bullets', content: {} }]),
]
const pres = '<p:presentation><p:sldIdLst>' + [...Array(8).keys()].map((i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('') + '</p:sldIdLst></p:presentation>'
save('sections.json', decks.map((d) => {
  const xml = addSections(pres, { ...d, slides: d.slides })
  const lst = xml.includes('<p14:sectionLst') ? xml.slice(xml.indexOf('<p:extLst>'), xml.indexOf('</p:presentation>')).replace(/id="\{[0-9A-F-]+\}"/g, 'id="{GUID}"') : ''
  return { deck: d, sections: lst, agenda: agendaLinks(d) }
}))

// ---------- Bildanpassung, Masken, Texteffekte ----------
const pic = '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
const blipOf = (x: string) => x.match(/<a:blip r:embed="rId2">([\s\S]*?)<\/a:blip>/)?.[1] ?? ''
const adjusts = [{ bright: 20 }, { contrast: -35 }, { sat: -100 }, { blur: 37 }, { bright: -10, contrast: 15, sat: 50, blur: 100 }, { bright: 0, sat: 0 }, {}]
const looks = [undefined, 'mono', 'duotone'] as const
const duo: [string, string] = ['#12345a', '#E0E8F0']
save('blip.json', { duotone: duo, cases: adjusts.flatMap((adjust) => looks.map((look) => {
  let x = adjustBlip(adjust)(pic)
  if (look) x = recolor(look, duo)(x)
  return { adjust, look: look ?? null, kids: blipOf(x) }
})) })
save('masks.json', ['circle', 'arch', 'hexagon', 'diamond', 'octagon', 'star', 'heart', 'blob'].map((mask) => ({ mask, geom: maskShape(mask)(pic).match(/<a:prstGeom[\s\S]*?<\/a:prstGeom>/)![0] })))
const sp = '<p:sp><p:txBody><a:p><a:r><a:rPr lang="de-DE" sz="2400"><a:solidFill><a:srgbClr val="112233"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>'
save('effects.json', ['shadow', 'lift', 'neon', 'hollow', 'unknown'].flatMap((type) => [17, 48, 120].map((sizePx) => {
  const x = textEffect({ type, color: '#C03A2B' }, sizePx)(sp)
  return { type, color: '#C03A2B', sizePx, rpr: x.match(/<a:rPr\b[^>]*>([\s\S]*?)<a:latin/)![1] }
})))

// ---------- Diagramme ----------
const specs: ChartSpec[] = [
  { type: 'bar', categories: ['2022', '2023', '2024', '2025'], series: [{ name: 'Umsatz', values: [12, 15.5, 19, 24] }] },
  { type: 'bar', categories: ['Nord', 'Süd'], series: [{ name: 'A', values: [3, -2] }, { name: 'B & C', values: [4, 1] }], highlight: 'B & C' },
  { type: 'hbar', categories: ['Alpha', 'Beta', 'Gamma'], series: [{ name: 'Score', values: [80, 65, 40] }], highlight: 'Beta' },
  { type: 'stacked', categories: ['Q1', 'Q2', 'Q3'], series: [{ name: 'Neu', values: [5, 6, 7] }, { name: 'Bestand', values: [10, 11, 12.5] }, { name: 'Rest', values: [1, 1, 1] }] },
  { type: 'waterfall', categories: ['Start', 'Preis', 'Menge', 'Kosten', 'Ende'], series: [{ name: 'EBIT', values: [100, 20, 15.5, -30, 105.5] }] },
  { type: 'line', categories: ['Jan', 'Feb', 'Mär', 'Apr'], series: [{ name: 'Wir', values: [1, 3, 2, 5] }, { name: 'Markt', values: [2, 2, 3, 3] }] },
  { type: 'line', categories: ['Jan', 'Feb'], series: [{ name: 'Allein', values: [-1, 4] }] },
  { type: 'donut', categories: ['Miete', 'Personal', 'Sonstiges'], series: [{ name: 'Kosten', values: [30, 50, 20] }], highlight: 'Personal' },
  { type: 'donut', categories: ['A', 'B'], series: [{ name: 'Anteil', values: [60, 40] }] },
  { type: 'bar', categories: [...'abcdefghijk'], series: [{ name: 'X', values: [...Array(11).keys()] }, { name: 'Y', values: [...Array(11).keys()].map((v) => -v) }] },
]
const charts = []
for (const id of ['beratung', 'keynote']) {
  const t = resolveTheme({ id } as never)
  const palette = { bg: t.c.bg, text: t.c.text, muted: t.c.muted, border: t.c.border, good: t.c.good, bad: t.c.bad, chart: t.c.chart, duotone: duotoneOf(t) }
  for (const spec of specs) {
    const pptx = new PptxGenJS()
    const el = { kind: 'chart', slot: 'c', box: { x: 100, y: 100, w: 600, h: 400 }, spec } as ChartEl
    addChart(pptx, pptx.addSlide(), el, t, 'dw:c')
    const buf = await postProcess((await pptx.write({ outputType: 'nodebuffer' })) as Buffer)
    const zip = await JSZip.loadAsync(buf) // PptxGenJS zählt Diagramme über Instanzen hinweg
    const xml = await zip.file(Object.keys(zip.files).find((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f))!)!.async('string')
    charts.push({ theme: id, font: t.body.pptx, palette, spec, colors: chartColors(spec, t), xml })
  }
}
save('charts.json', charts)

// ---------- Schriften ----------
const ttf = readFileSync(join(root, 'assets/fonts/DMSans-Regular.ttf'))
writeFileSync(join(dir, 'DMSans-Regular.eot'), ttfToEot(ttf))
console.log(`Fixtures: ${cases.length} Zeitleisten, ${charts.length} Diagramme → ${dir}`)
