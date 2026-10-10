// Freie Textfelder (fett, Links, Aufzählung): npx esbuild scripts/check-free-text.ts --bundle --platform=node --format=cjs --external:electron --loader:.css=empty --loader:.md=text --jsx=automatic --log-level=warning --outfile=out/check-free-text.cjs && node out/check-free-text.cjs
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import type { Run } from '../src/shared/deck'
import { edited } from '../src/renderer/slide'
import { listBullets, listXml } from '../src/main/export-pptx'

// Bearbeiten: sichtbar unverändert → Original mit Markup, sonst gilt der getippte Text
const md = '**Fett** und [Link](https://example.org)'
assert.equal(edited(md, 'Fett und Link'), md, 'bloßes Anklicken darf Markup nicht verlieren')
assert.equal(edited(md, 'Fett und mehr'), '**Fett** und mehr', 'Link-Text weg, fetter Teil unverändert → fett bleibt')
// Tippfehler: Markup-Teile, deren Text genau einmal im neuen Text steht, bleiben; geänderte Teile werden Klartext
assert.equal(edited('Ein **wichtiger** Satz mit Tippfeler', 'Ein wichtiger Satz mit Tippfehler'), 'Ein **wichtiger** Satz mit Tippfehler')
assert.equal(edited('Ein **wichtiger** Satz', 'Ein wichtigster Satz'), 'Ein wichtigster Satz')
assert.equal(edited('Mehr unter [Deckwerk](https://example.org) lesen', 'Mehr dazu unter Deckwerk lesen'), 'Mehr dazu unter [Deckwerk](https://example.org) lesen')
assert.equal(edited('**a** und a', 'a und a!'), 'a und a!', 'mehrdeutig (Text kommt zweimal vor) → Klartext')
assert.equal(edited('**A** und [B](https://b.de)', 'B und A'), '[B](https://b.de) und **A**', 'Reihenfolge darf sich ändern')
assert.equal(edited('**A**\n\nB', 'A\n\nB'), '**A**\n\nB', 'Zeilen und Leerzeilen einer Aufzählung zählen mit')
assert.equal(edited('A\nB', 'A\nB\nC'), 'A\nB\nC')

// Export: jeder Lauf trägt die Aufzählung seines Absatzes (PptxGenJS schreibt pPr je Lauf), leere Absätze keinen Marker
const run = (text: string, breakAfter?: boolean, bold = false): Run => ({ text, bold, italic: false, color: '#000000', breakAfter })
const runs = [run('Eins ', false, true), run('fett', true), run('  ', true), run('Zwei', true), run('Drei')]
assert.deepEqual(listBullets(runs, { type: 'bullet', indentPx: 32 }), [{ indent: 24 }, { indent: 24 }, undefined, { indent: 24 }, { indent: 24 }])
const num = listBullets(runs, { type: 'number', indentPx: 48 })
assert.deepEqual(num.map((b) => b && typeof b === 'object' && [b.type, b.indent]), [['number', 36], ['number', 36], undefined, ['number', 36], ['number', 36]])

// Nummerierung in der PPTX: startAt nur am ersten Absatz eines Blocks (LibreOffice beginnt sonst bei jedem Absatz neu)
// (CJS-Bündel wegen electron in export-pptx: kein await auf oberster Ebene)
void (async () => {
  const pptx = new PptxGenJS()
  pptx.addSlide().addText(runs.map((r, i) => ({ text: r.text, options: { bold: r.bold, breakLine: r.breakAfter, bullet: num[i] } })), { x: 0, y: 0, w: 4, h: 2, align: 'left', objectName: 'liste' })
  const xml = await (await JSZip.loadAsync((await pptx.write({ outputType: 'nodebuffer' })) as Buffer)).file('ppt/slides/slide1.xml')!.async('string')
  const sp = listXml(xml.match(/<p:sp>[\s\S]*?<\/p:sp>/)![0])
  const paras = sp.match(/<a:p>[\s\S]*?<\/a:p>/g)!.map((p) => (p.includes('<a:buNone') ? '-' : (p.match(/<a:buAutoNum\b[^>]*>/g) ?? []).map((a) => a.match(/startAt="(\d+)"/)?.[1] ?? 'weiter').join('+')))
  assert.deepEqual(paras, ['1+1', '-', '1', 'weiter'], 'Block 1 (zwei Läufe), Leerzeile, Block 2')
  // Nummern in der Schrift des Textes (wie die App), nicht in der Titelschrift des Themes (+mj-lt)
  assert.ok(!sp.includes('+mj-lt') && (sp.match(/<a:buFontTx\/><a:buAutoNum/g) ?? []).length === 4, 'buFontTx vor jeder Nummer')
  assert.equal(listXml('<a:buSzPct val="100000"/><a:buChar char="&#x2022;"/>'), '<a:buSzPct val="100000"/><a:buFontTx/><a:buChar char="&#x2022;"/>')
  console.log('free-text ok')
})()
