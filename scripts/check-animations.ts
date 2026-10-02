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

// 4: Canva-Stile: Kernsatz Wort für Wort, danach Unterzeile; Schreibmaschine und Pop per Klick; CTA atmet ab Folienbeginn
const s4 = pptx.addSlide()
s4.addText('Der Pilot startet im November', { objectName: 'dw:claim', x: 0.6, y: 1, w: 12, h: 1.2, fontSize: 40 })
s4.addText('Freigabe heute', { objectName: 'dw:sub', x: 0.6, y: 2.4, w: 12, h: 0.8, fontSize: 24 })
s4.addText('Jetzt', { objectName: 'dw:typed', x: 0.6, y: 3.6, w: 4, h: 0.8, fontSize: 24 })
s4.addText('+42 %', { objectName: 'dw:pop', x: 5, y: 3.6, w: 3, h: 1.2, fontSize: 40 })
s4.addText('Termin buchen', { objectName: 'dw:cta', shape: pptx.ShapeType.roundRect, x: 9, y: 5.5, w: 3.5, h: 0.9, fill: { color: 'C2410C' }, fontSize: 20 })
// 5: Farbwischen (in PowerPoint als Wischen); Foto-Zoom, Wischen nach oben, schnelles Schwenken nach links
const s5 = pptx.addSlide()
title(s5, 'Farbwischen')
s5.addImage({ objectName: 'dw:image', x: 0, y: 0, w: 6, h: 7.5,
  data: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' })
s5.addText('Von unten', { objectName: 'dw:up', x: 7, y: 2, w: 5, h: 1, fontSize: 24 })
s5.addText('Von rechts', { objectName: 'dw:left', x: 7, y: 3.5, w: 5, h: 1, fontSize: 24 })

const anims: SlideAnim[] = [
  { transition: 'fade', steps: [0, 1, 2, 3].map(p => ({ shape: 'dw:bullets', effect: 'fade', trigger: 'click', paragraph: p })) },
  { transition: 'fade', steps: [0, 1, 2].map(i => ({ shape: `dw:kpi-${i}`, effect: 'float', trigger: 'after', durMs: 400 })) },
  { transition: 'morph', steps: [
    { shape: 'dw:chart', effect: 'wipe', trigger: 'click' },
    { shape: 'dw:logo', effect: 'zoom', trigger: 'with', delayMs: 150 },
    { shape: 'dw:gibtsnicht', effect: 'fade', trigger: 'after' }, // muss mit Warnung übersprungen werden
  ] },
  { transition: 'slide', steps: [
    { shape: 'dw:cta', effect: 'pulse', trigger: 'with', durMs: 1200 },
    { shape: 'dw:claim', effect: 'float', by: 'word', trigger: 'after', durMs: 400 },
    { shape: 'dw:sub', effect: 'fade', trigger: 'after' },
    { shape: 'dw:typed', effect: 'appear', by: 'letter', trigger: 'click', durMs: 1 },
    { shape: 'dw:pop', effect: 'pop', trigger: 'click', durMs: 450 },
  ] },
  { transition: 'color', steps: [
    { shape: 'dw:image', effect: 'grow', trigger: 'with', durMs: 12000 },
    { shape: 'dw:up', effect: 'wipe', dir: 'up', trigger: 'after' },
    { shape: 'dw:left', effect: 'pan', dir: 'left', trigger: 'after', durMs: 300 },
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
  if (xml.includes('<p:timing>')) assert.ok(xml.indexOf('</p:clrMapOvr>') < xml.indexOf('<p:timing>'), `${path}: p:timing an falscher Stelle`)
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
const s4xml = await zip.file('ppt/slides/slide4.xml')!.async('string')
assert.match(s4xml, /<p:push dir="l"\/>/, 'Folie 4: Slide = waagerecht schieben')
assert.match(s4xml, /<p:cond evt="onBegin" delay="0">/, 'Folie 4: Atmen startet mit der Folie')
assert.match(s4xml, /presetClass="emph"[^>]*>.*?<p:cTn id="\d+" dur="1200" autoRev="1" repeatCount="indefinite" fill="hold"\/>.*?<p:by x="104000" y="104000"\/>/s, 'Folie 4: Atmen als Dauerpuls')
assert.match(s4xml, /<\/p:stCondLst><p:iterate type="wd"><p:tmAbs val="120"\/><\/p:iterate><p:childTnLst>/, 'Folie 4: Wort für Wort (Reihenfolge im cTn)')
assert.match(s4xml, /<p:iterate type="lt"><p:tmAbs val="45"\/><\/p:iterate>/, 'Folie 4: Schreibmaschine')
assert.match(s4xml, /<p:cond delay="880"\/>/, 'Folie 4: Unterzeile wartet, bis alle 5 Wörter da sind (400 + 4 × 120 ms)')
assert.match(s4xml, /<p:tav tm="70000"><p:val><p:strVal val="#ppt_w\*1.06"\/>/, 'Folie 4: Pop schwingt über')
const s5xml = await zip.file('ppt/slides/slide5.xml')!.async('string')
assert.match(s5xml, /<p:wipe dir="r"\/>/, 'Folie 5: Farbwischen als Wischen')
assert.match(s5xml, /presetID="6" presetClass="emph"[^>]*>.*?<p:cTn id="\d+" dur="12000" fill="hold"\/>.*?<p:by x="108000" y="108000"\/>/s, 'Folie 5: Foto-Zoom als langsames Vergrößern')
assert.match(s5xml, /presetID="22" presetClass="entr" presetSubtype="4".*?filter="wipe\(down\)"/s, 'Folie 5: Wischen nach oben = von unten')
assert.match(s5xml, /presetID="2" presetClass="entr" presetSubtype="2".*?<p:strVal val="#ppt_x\+.05"\/>/s, 'Folie 5: Schwenken nach links startet rechts')
assert.match(s5xml, /<p:cond delay="500"\/>/, 'Folie 5: Foto-Zoom blockiert die Kette nicht (Wischen 500 ms, dann Schwenken)')
console.log('ok → out/anim-test.pptx')
