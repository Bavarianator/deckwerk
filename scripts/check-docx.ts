// Word-Export: npx esbuild scripts/check-docx.ts --bundle --platform=node --outfile=out/check-docx.cjs && node out/check-docx.cjs [ziel.docx]
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import JSZip from 'jszip'
import { buildDocx } from '../src/main/export-docx'
import type { Deck, El, Run, TextEl } from '../src/shared/deck'

const run = (text: string, more: Partial<Run> = {}): Run => ({ text, bold: false, italic: false, color: '#1a1a1a', ...more })
const text = (slot: string, x: number, y: number, runs: Run[], more: Partial<TextEl> = {}): TextEl => ({
  kind: 'text', slot, box: { x, y, w: 600, h: 60 }, font: 'body', role: 'body', sizePx: 24, lineHeightPx: 32, trackingPx: 0,
  align: 'left', upper: false, runs, lines: 1, bg: '#FFFFFF', ...more,
})
const page = (els: El[]) => ({ measured: { els, fit: { ok: true, head: 0, body: 0, overflow: [] } }, background: readFileSync('assets/icon.png') })

const deck: Deck = {
  title: 'Test & <Probe>', size: { w: 794, h: 1123 }, theme: { id: 'x', fonts: ['Archivo', 'Archivo'] }, transition: 'none', mode: 'click',
  slides: [{ id: 's1', layout: 'doc-text', content: {} }, { id: 's2', layout: 'doc-text', content: {} }],
}
const ttf = readFileSync('assets/fonts/Archivo-Regular.ttf')

// CJS-Bündel: kein Top-Level-await; Fehler beenden node über die unbehandelte Rejection
void (async () => {
  const buf = await buildDocx(deck, [
    page([
      text('title', 60, 80, [run('Kapitel eins', { bold: true, breakAfter: true }), run('Untertitel')], { font: 'head', sizePx: 48, lineHeightPx: 56, upper: true }),
      { kind: 'box', slot: 'rule', box: { x: 60, y: 200, w: 600, h: 4 }, radius: 0, ellipse: false, fill: { color: '#D7261E', alpha: 1 } },
      text('body', 60, 240, [run('Mehr unter '), run('deckwerk.de', { link: 'https://deckwerk.de/?a=1&b=2', underline: true })]),
    ]),
    page([
      text('quote', 100, 400, [run('Gedreht & zentriert', { color: '#000000' })], { align: 'center', rot: -8, effect: { type: 'hollow', color: '#D7261E' } }),
      text('leer', 100, 600, [run('')]),
    ]),
  ], [{ family: 'Archivo', regular: ttf }])
  if (process.argv[2]) writeFileSync(process.argv[2], buf)

  const zip = await JSZip.loadAsync(buf)
  const read = (p: string) => zip.file(p)!.async('string')
  for (const p of ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/settings.xml', 'word/fontTable.xml', 'word/_rels/fontTable.xml.rels', 'word/media/bg1.png', 'word/media/bg2.png'])
    assert.ok(zip.file(p), `fehlt: ${p}`)
  const doc = await read('word/document.xml'), docRels = await read('word/_rels/document.xml.rels')
  assert.match(await read('docProps/core.xml'), /<dc:title>Test &#38; &#60;Probe&#62;<\/dc:title>/)
  assert.match(doc, /<w:pgSz w:w="11910" w:h="16845"\/>/)
  assert.equal(doc.split('<w:pageBreakBefore/>').length - 1, 1)
  assert.equal(doc.split('txBox="1"').length - 1, 3, 'Box und leerer Text erzeugen kein Textfeld')
  assert.equal(doc.split('behindDoc="1"').length - 1, 2)
  for (const s of ['>Kapitel eins</w:t><w:br/>', '<w:caps/>', '>Gedreht &#38; zentriert</w:t>', 'rot="21120000"', '<w:jc w:val="center"/>', 'w:ascii="Archivo"', '<w:sz w:val="72"/>', '<w:outline/><w:color w:val="D7261E"/>'])
    assert.ok(doc.includes(s), `fehlt im Dokument: ${s}`)
  const link = doc.match(/<w:hyperlink r:id="(rId\d+)">/)?.[1]
  assert.ok(link && docRels.includes(`Id="${link}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://deckwerk.de/?a=1&#38;b=2" TargetMode="External"`), 'Hyperlink-Relationship')
  assert.ok((await read('word/settings.xml')).includes('<w:embedTrueTypeFonts/>'))

  // Eingebettete Schrift: nur die ersten 32 Bytes verschleiert, Schlüssel = GUID-Bytes rückwärts
  const fontTable = await read('word/fontTable.xml')
  const [, rid, fontKey] = fontTable.match(/<w:embedRegular r:id="(rId\d+)" w:fontKey="(\{[0-9A-F-]{36}\})"\/>/)!
  const target = (await read('word/_rels/fontTable.xml.rels')).match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`))![1]
  const odttf = await zip.file(`word/${target}`)!.async('nodebuffer')
  assert.equal(odttf.length, ttf.length)
  assert.notDeepEqual(odttf.subarray(0, 32), ttf.subarray(0, 32))
  assert.deepEqual(odttf.subarray(32), ttf.subarray(32))
  const hexKey = fontKey.replace(/[{}-]/g, '')
  const key = Array.from({ length: 16 }, (_, i) => parseInt(hexKey.slice(30 - 2 * i, 32 - 2 * i), 16))
  const plain = Buffer.from(odttf)
  for (let i = 0; i < 32; i++) plain[i] ^= key[i % 16]
  assert.deepEqual(plain, ttf)
  console.log('docx ok')
})()
