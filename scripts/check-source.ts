// Quellmaterial lesen: npx esbuild scripts/check-source.ts --bundle --packages=external --platform=node --outfile=out/check-source.cjs && node out/check-source.cjs
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { sourceText } from '../src/main/source-text'

const dir = mkdtempSync(join(tmpdir(), 'dw-src-'))
const zip = new JSZip().file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Umsatz &amp; Plan</w:t></w:r></w:p><w:p><w:r><w:t>+9 %</w:t></w:r></w:p></w:body></w:document>')
writeFileSync(join(dir, 'a.docx'), await zip.generateAsync({ type: 'nodebuffer' }))
assert.equal((await sourceText(join(dir, 'a.docx'))).trim(), 'Umsatz & Plan\n+9 %')
const pptx = await sourceText('exports/q3-update-vertrieb.pptx')
assert.doesNotMatch(pptx, /visibility/)
assert.match(pptx, /--- Folie 1 ---\n[\s\S]*Vertrieb[\s\S]*--- Folie 8 ---\n[^]*Freigabe/)
assert.match(await sourceText('exports/q3-update-vertrieb.pdf'), /Vertrieb/)
await assert.rejects(sourceText(join(dir, 'x.exe')), /nicht unterstützt/)
console.log('source ok')
