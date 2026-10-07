// Quellmaterial lesen (braucht vorher `npm run render examples/quartal.json` und `examples/foto.json` für die Dateien unter exports/):
// npx esbuild scripts/check-source.ts --bundle --packages=external --platform=node --format=esm --outfile=out/check-source.mjs && node out/check-source.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { pdfPick, sourceText } from '../src/main/source-text'
import { imageSize } from '../src/main/tools'

const dir = mkdtempSync(join(tmpdir(), 'dw-src-'))
const zip = new JSZip().file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Umsatz &amp; Plan</w:t></w:r></w:p><w:p><w:r><w:t>+9 %</w:t></w:r></w:p></w:body></w:document>')
writeFileSync(join(dir, 'a.docx'), await zip.generateAsync({ type: 'nodebuffer' }))
assert.equal((await sourceText(join(dir, 'a.docx'))).trim(), 'Umsatz & Plan\n+9 %')
const pptx = await sourceText('exports/q3-update-vertrieb.pptx')
assert.doesNotMatch(pptx, /visibility/)
assert.match(pptx, /--- Folie 1 ---\n[\s\S]*Vertrieb[\s\S]*--- Folie 8 ---\n[^]*Freigabe/)
assert.match(await sourceText('exports/q3-update-vertrieb.pdf'), /Vertrieb/)
const cafe = await sourceText('exports/caf-kollektiv-expansion-2027.pptx', dir)
assert.match(cafe, /--- Folie 1 ---[^]*Bild: asset:\/\/local\/.*\/import-caf-kollektiv-expansion-2027\/[^\n]+\.(png|jpe?g)/)
assert.equal(await sourceText('exports/caf-kollektiv-expansion-2027.pptx', dir), cafe) // erneuter Import: dieselben Dateien
await assert.rejects(sourceText(join(dir, 'x.exe')), /nicht unterstützt/)

// Bilder: Kopie nach assets/, gleicher Inhalt → gleiche Datei, anderer Inhalt → Suffix
const png = (w: number, h: number, tag = 0) => {
  const b = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b)
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  b[32] = tag
  return b
}
const assets = join(dir, 'assets')
mkdirSync(join(dir, 'in'))
const logo = join(dir, 'in', 'Logo Firma.png')
writeFileSync(logo, png(3, 2))
const l1 = await sourceText(logo, assets)
assert.match(l1, /^Bild: asset:\/\/local\/.*\.png \(3×2 px\)$/)
assert.ok(existsSync(join(assets, 'Logo-Firma.png')))
assert.equal(await sourceText(logo, assets), l1)
writeFileSync(logo, png(3, 2, 1))
const l2 = await sourceText(logo, assets)
assert.match(l2, /\/Logo-Firma-[0-9a-f]{8}\.png \(3×2 px\)$/)
assert.equal(await sourceText(logo, assets), l2) // Hash-Suffix: erneuter Import legt keine weitere Kopie an
assert.match(await sourceText(logo), /^Bild: asset:\/\/local\/.*\/in\/Logo%20Firma\.png \(3×2 px\)$/)
writeFileSync(join(dir, 'in', 'Mu\u0308ller Logo.png'), png(3, 2)) // zerlegter Umlaut wie von macOS
assert.match(await sourceText(join(dir, 'in', 'Mu\u0308ller Logo.png'), assets), /\/M%C3%BCller-Logo\.png \(3×2 px\)$/)
assert.ok(existsSync(join(assets, 'Müller-Logo.png')))
writeFileSync(join(dir, 'in', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
assert.match(await sourceText(join(dir, 'in', 'icon.svg'), assets), /\/icon\.svg \(SVG\)$/)
writeFileSync(join(dir, 'in', 'riesig.jpg'), '')
truncateSync(join(dir, 'in', 'riesig.jpg'), 26 << 20)
await assert.rejects(sourceText(join(dir, 'in', 'riesig.jpg'), assets), /größer als 25 MB/)

// DOCX: Abbildung an ihrer Stelle, Icons unter 150×150 px fallen weg
const blip = (id: string) => `<w:p><w:r><w:drawing><a:blip r:embed="${id}" cstate="print"/></w:drawing></w:r></w:p>`
const docx = new JSZip()
  .file('word/document.xml', `<w:document><w:body><w:p><w:r><w:t>Vorher</w:t></w:r></w:p>${blip('rId5')}${blip('rId6')}${blip('rId7')}${blip('rId5')}<w:p><w:r><w:t>Nachher</w:t></w:r></w:p></w:body></w:document>`)
  .file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Target="media/image2.png" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Id="rId6"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/big.png"/></Relationships>')
  .file('word/media/image1.png', png(200, 200))
  .file('word/media/image2.png', png(20, 20))
  .file('word/media/big.png', Buffer.concat([png(400, 400), Buffer.alloc(26 << 20)])) // über 25 MB: fällt weg
writeFileSync(join(dir, 'b.docx'), await docx.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
assert.match(await sourceText(join(dir, 'b.docx'), assets), /^Vorher\nBild: asset:\/\/local\/.*\/import-b\/image1\.png \(200×200 px\)\nNachher$/)
assert.equal(await sourceText(join(dir, 'b.docx')), 'Vorher\nNachher')

// PDF: Rasterbilder seitenweise, Masken (smask) nicht als eigenes Bild
const pdf = 'exports/caf-kollektiv-expansion-2027.pdf'
const pages = await sourceText(pdf, dir)
assert.match(pages, /--- Seite 1 ---/)
assert.match(pages, /Bild: asset:\/\/local\/.*\/import-caf-kollektiv-expansion-2027\/[^\n]+\.(png|jpg) \(1920×1280 px\)/)
const listed = execFileSync('pdfimages', ['-list', pdf], { encoding: 'utf8' }).split('\n').filter((l) => l.trim().split(/\s+/)[2] === 'image').length
assert.ok(pages.match(/^Bild: /gm)!.length <= listed)
// kopierte Datei passt zur Bildzeile, für durchgereichte JPEGs wie für PNGs
const kinds = new Set<string>()
for (const [, url, kind, w, h] of pages.matchAll(/^Bild: (asset:\/\/local\S+\.(png|jpg)) \((\d+)×(\d+) px\)$/gm)) {
  assert.deepEqual(imageSize(readFileSync(fileURLToPath(`file://${url.slice('asset://local'.length)}`))), { width: +w, height: +h })
  kinds.add(kind)
}
assert.deepEqual([...kinds].sort(), ['jpg', 'png'])
assert.doesNotMatch(await sourceText(pdf), /Bild:/)

// pdfPick: Entscheidung aus `pdfimages -list`, ohne Bomben-PDF
const row = (page: number, num: number, type: string, w: number, h: number, obj = `${100 + num} 0`) => `${page} ${num} ${type} ${w} ${h} rgb 3 8 image no ${obj} 72 72 1K 1%`
const list = (...rows: string[]) => ['page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio', '-'.repeat(40), ...rows, ''].join('\n')
assert.equal(pdfPick(execFileSync('pdfimages', ['-list', pdf], { encoding: 'utf8' })).length, 10) // ohne smask, mit allen Fotos
assert.deepEqual(pdfPick(list(row(1, 0, 'image', 400, 300), row(1, 1, 'image', 100, 100), row(2, 2, 'image', 400, 300, '100 0'))).map((c) => c[1]), ['0']) // Icon und Duplikat fallen weg
assert.equal(pdfPick(list(row(1, 0, 'image', 400, 300, '- -'), row(2, 1, 'image', 400, 300, '- -'))).length, 2) // Inline-Bilder sind keine Duplikate
assert.deepEqual(pdfPick(list(row(1, 0, 'image', 400, 300), row(1, 1, 'smask', 30000, 30000))), []) // ein Eintrag über 50 MP
assert.deepEqual(pdfPick(list(...Array.from({ length: 20 }, (_, i) => row(1, i, 'image', 5000, 5000)))), []) // Summe über 400 MP
assert.equal(pdfPick(list(row(1, 0, 'image', 400, 300), row(2, 1, 'image', 30000, 30000))).length, 0) // Riese auf der letzten gewählten Seite
assert.equal(pdfPick(list(row(1, 0, 'image', 400, 300), row(2, 1, 'smask', 30000, 30000))).length, 1) // Seite 2 wird nicht extrahiert
console.log('source ok')
