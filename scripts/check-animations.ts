// Baut eine Test-PPTX, injiziert Animationen und prüft das Ergebnis strukturell.
// Aufruf: node scripts/check-animations.ts → out/anim-test.pptx (Abnahme in echtem PowerPoint)
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { injectAnimations, type SlideAnim } from '../src/main/animations.ts'

const pptx = new PptxGenJS()
pptx.layout = 'LAYOUT_WIDE'
const title = (s: PptxGenJS.Slide, text: string) =>
  s.addText(text, { objectName: 'dw:title', x: 0.6, y: 0.4, w: 12, h: 0.9, fontSize: 32, bold: true })

// 1: Liste, Absatz für Absatz per Klick
const s1 = pptx.addSlide()
title(s1, 'Vier Gründe, warum der Pilot sofort startet')
s1.addText(['Kosten sinken um 18 %', 'Rollout in 6 Wochen', 'Kein neues Personal', 'Risiko begrenzt'].map(t => ({ text: t, options: { bullet: true } })),
  { objectName: 'dw:bullets', x: 0.6, y: 1.6, w: 12, h: 4, fontSize: 24 })

// 2: drei Karten, schweben nacheinander automatisch ein
const s2 = pptx.addSlide()
title(s2, 'Drei Kennzahlen zeigen den Durchbruch')
;['+42 %', '3,1 Mio.', '98 %'].forEach((v, i) =>
  s2.addText(v, { objectName: `dw:kpi-${i}`, shape: pptx.ShapeType.roundRect, x: 0.6 + i * 4.1, y: 2.2, w: 3.8, h: 2.6, fill: { color: 'EEF2FF' }, fontSize: 40, align: 'center' }))

// 3: Morph-Übergang, Chart wischt rein, Bild zoomt mit
const s3 = pptx.addSlide()
s3.addText('Umsatz wächst seit Q1 jedes Quartal', { objectName: 'dw:title', x: 0.6, y: 6.2, w: 12, h: 0.9, fontSize: 28, bold: true })
s3.addChart(pptx.ChartType.bar, [{ name: 'Umsatz', labels: ['Q1', 'Q2', 'Q3', 'Q4'], values: [3, 4, 6, 8] }], { objectName: 'dw:chart', x: 0.6, y: 0.5, w: 8, h: 5.4 })
s3.addImage({ objectName: 'dw:logo', x: 9.2, y: 0.5, w: 3, h: 3,
  data: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' })

const anims: SlideAnim[] = [
  { transition: 'fade', steps: [0, 1, 2, 3].map(p => ({ shape: 'dw:bullets', effect: 'fade', trigger: 'click', paragraph: p })) },
  { transition: 'fade', steps: [0, 1, 2].map(i => ({ shape: `dw:kpi-${i}`, effect: 'float', trigger: 'after', durMs: 400 })) },
  { transition: 'morph', steps: [
    { shape: 'dw:chart', effect: 'wipe', trigger: 'click' },
    { shape: 'dw:logo', effect: 'zoom', trigger: 'with', delayMs: 150 },
    { shape: 'dw:gibtsnicht', effect: 'fade', trigger: 'after' }, // muss mit Warnung übersprungen werden
  ] },
]

const raw = await pptx.write({ outputType: 'nodebuffer' }) as Buffer
const out = await injectAnimations(raw, anims)
mkdirSync('out', { recursive: true })
writeFileSync('out/anim-test.pptx', out)

// Prüfen
const zip = await JSZip.loadAsync(out)
for (const [i, name] of ['dw:title', 'dw:kpi-0', 'dw:chart'].entries()) {
  const xml = await zip.file(`ppt/slides/slide${i + 1}.xml`)!.async('string')
  assert.match(xml, new RegExp(`<p:cNvPr id="\\d+" name="${name}"`), `objectName ${name} steht nicht im cNvPr name`)
}
for (let i = 1; i <= anims.length; i++) {
  const path = `ppt/slides/slide${i}.xml`
  const xml = await zip.file(path)!.async('string')
  execFileSync('xmllint', ['--noout', '-'], { input: xml }) // wirft bei nicht wohlgeformtem XML / undeklariertem Namespace
  const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map(m => m[1])
  assert.equal(new Set(ids).size, ids.length, `${path}: doppelte cNvPr ids`)
  for (const [, spid] of xml.matchAll(/<p:(?:spTgt|bldP|bldGraphic) spid="(\d+)"/g)) assert.ok(ids.includes(spid), `${path}: spid ${spid} ohne Shape`)
  const ctn = [...xml.matchAll(/<p:cTn id="(\d+)"/g)].map(m => m[1])
  assert.equal(new Set(ctn).size, ctn.length, `${path}: doppelte cTn ids`)
  assert.ok(xml.indexOf('</p:clrMapOvr>') < xml.indexOf('<p:timing>'), `${path}: p:timing an falscher Stelle`)
}
const s1xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
assert.equal(s1xml.match(/nodeType="clickEffect"/g)?.length, 4, 'Folie 1: 4 Klick-Effekte erwartet')
assert.match(s1xml, /<p:bldP spid="\d+" grpId="0" build="p"\/>/)
const s2xml = await zip.file('ppt/slides/slide2.xml')!.async('string')
assert.match(s2xml, /<p:cond evt="onBegin" delay="0"><p:tn val="2"\/><\/p:cond>/, 'Folie 2: Autostart fehlt')
assert.match(s2xml, /<p:cond delay="400"\/>.*<p:cond delay="800"\/>/s, 'Folie 2: kumulierte after-Delays fehlen')
const s3xml = await zip.file('ppt/slides/slide3.xml')!.async('string')
assert.match(s3xml, /<p159:morph option="byObject"\/>/)
assert.doesNotMatch(s3xml, /<p:bldP /, 'Folie 3: Bild/Chart dürfen keinen bldP haben')
console.log('ok → out/anim-test.pptx')
