// Baut eine Test-PPTX, injiziert Animationen und prüft das Ergebnis strukturell.
// Aufruf: node scripts/check-animations.ts → out/anim-test.pptx (Abnahme in echtem PowerPoint)
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { injectAnimations, type SlideAnim } from '../src/main/animations.ts'
import { animStartOf, itemSteps } from '../src/shared/deck.ts'

// Start und Verzögerung freier Elemente (Präsentieren, itemSteps): Schritt 0 läuft ohne Klick, jeder weitere per Klick
assert.deepEqual(itemSteps([{ ms: 500 }, { ms: 500 }], 'click'), [[], [{ k: 0, at: 0 }], [{ k: 1, at: 0 }]], 'ohne Start: je ein Klick')
assert.deepEqual(itemSteps([{ ms: 500 }, { ms: 700 }], 'auto', 400), [[{ k: 0, at: 400 }, { k: 1, at: 900 }]], 'Selbstlauf: nacheinander nach dem Aufbau')
assert.deepEqual(itemSteps([
  { start: 'click', ms: 500 },
  { start: 'with', delay: 0.2, ms: 500 }, // zugleich, 200 ms später → Ende 700
  { start: 'after', ms: 300 }, // nach allem Bisherigen: 700
  { start: 'with', ms: 100 }, // gleicher Kettenbeginn wie das vorige: 700
  { start: 'after', delay: 1, ms: 500 }, // Ende 1000 + 1 s
  { start: 'click', delay: 0.5, ms: 500 },
], 'click'), [[], [{ k: 0, at: 0 }, { k: 1, at: 200 }, { k: 2, at: 700 }, { k: 3, at: 700 }, { k: 4, at: 2000 }], [{ k: 5, at: 500 }]], 'click/with/after/delay')
assert.deepEqual(itemSteps([{ start: 'after', ms: 500 }, { ms: 500 }], 'click', 600), [[{ k: 0, at: 600 }], [{ k: 1, at: 0 }]], 'nach vorherigem ohne Klick hinter den Aufbau')
// Aufbau aus mehreren after-Ketten (wipe, words, Liste im Selbstlauf): „Zugleich“ startet mit der letzten Kette (500 ms)
// wie in der PPTX (Folie 9), „Danach“ nach dem Ende des Aufbaus (1000 ms)
assert.deepEqual(itemSteps([{ start: 'with', delay: 0.1, ms: 500 }, { start: 'after', ms: 300 }], 'click', 1000, 500), [[{ k: 0, at: 600 }, { k: 1, at: 1100 }]], 'Zugleich an der letzten Aufbau-Kette')
assert.deepEqual(itemSteps([{ start: 'click', ms: 500 }, { start: 'with', ms: 500 }], 'auto'), [[{ k: 0, at: 0 }, { k: 1, at: 0 }]], 'Selbstlauf: Klick wird nach vorherigem')
// Export: Start → trigger (export-pptx.ts), Selbstlauf ohne Klicks
assert.deepEqual([undefined, 'click', 'with', 'after'].map((st) => animStartOf(st as never, 'click')), ['click', 'click', 'with', 'after'])
assert.deepEqual([undefined, 'click', 'with', 'after'].map((st) => animStartOf(st as never, 'auto')), ['after', 'after', 'with', 'after'])

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
// 6–7: Start mit/nach vorherigem mit Verzögerung, langsamer Übergang; 8: schneller Morph
const s6 = pptx.addSlide()
;['a', 'b', 'c'].forEach((n, i) => s6.addText(n, { objectName: `dw:${n}`, x: 0.6 + i * 4, y: 2, w: 3, h: 1, fontSize: 24 }))
title(pptx.addSlide(), 'Langsam')
title(pptx.addSlide(), 'Schnell')
// 9: Aufbau in zwei after-Ketten, danach ein Element „Zugleich“ (App: itemSteps oben)
const s9 = pptx.addSlide()
;['g1', 'g2', 'w'].forEach((n, i) => s9.addText(n, { objectName: `dw:${n}`, x: 0.6 + i * 4, y: 2, w: 3, h: 1, fontSize: 24 }))

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
  { transition: 'fade', speed: 'fast', steps: [
    { shape: 'dw:a', effect: 'fade', trigger: 'click' },
    { shape: 'dw:b', effect: 'fade', trigger: 'with', delayMs: 200 },
    { shape: 'dw:c', effect: 'fade', trigger: 'after', delayMs: 1000 },
  ] },
  { transition: 'fade', speed: 'slow', steps: [] },
  { transition: 'morph', speed: 'fast', steps: [] },
  { transition: 'none', steps: [
    { shape: 'dw:g1', effect: 'wipe', trigger: 'after' },
    { shape: 'dw:g2', effect: 'wipe', trigger: 'after' },
    { shape: 'dw:w', effect: 'fade', trigger: 'with', delayMs: 100 },
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
const s6xml = await zip.file('ppt/slides/slide6.xml')!.async('string')
assert.match(s6xml, /nodeType="withEffect"><p:stCondLst><p:cond delay="200"\/>/, 'Folie 6: mit vorherigem, 200 ms verzögert')
assert.match(s6xml, /<p:cond delay="700"\/><\/p:stCondLst><p:childTnLst><p:par><p:cTn id="\d+" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="afterEffect"><p:stCondLst><p:cond delay="1000"\/>/,
  'Folie 6: nach vorherigem (Kette ab 700 ms) mit 1 s Verzögerung')
assert.match(s6xml, /<mc:Choice xmlns:p14="[^"]+" Requires="p14"><p:transition spd="fast" p14:dur="300"><p:fade\/><\/p:transition><\/mc:Choice><mc:Fallback><p:transition spd="fast"><p:fade\/>/, 'Folie 6: schneller Übergang')
const s7xml = await zip.file('ppt/slides/slide7.xml')!.async('string')
assert.match(s7xml, /<p:transition spd="med" p14:dur="800"><p:fade\/>/, 'Folie 7: langsamer Übergang')
const s8xml = await zip.file('ppt/slides/slide8.xml')!.async('string')
assert.match(s8xml, /Requires="p159"><p:transition spd="fast" p14:dur="600"><p159:morph option="byObject"\/>.*<mc:Fallback><p:transition spd="fast"><p:fade\/>/, 'Folie 8: schneller Morph')
assert.doesNotMatch(s1xml + s3xml, /p14:dur/, 'ohne Tempo: Übergänge wie bisher')
assert.match(s1xml, /<p:transition spd="fast"><p:fade\/><\/p:transition>/)
const s9xml = await zip.file('ppt/slides/slide9.xml')!.async('string')
assert.match(s9xml, /<p:cond delay="500"\/><\/p:stCondLst><p:childTnLst><p:par>[^]*?nodeType="afterEffect">[^]*?nodeType="withEffect"><p:stCondLst><p:cond delay="100"\/>/, 'Folie 9: Zugleich hängt an der letzten Kette (500 ms + 100 ms)')
console.log('ok → out/anim-test.pptx')
