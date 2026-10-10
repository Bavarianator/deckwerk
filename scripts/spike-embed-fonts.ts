// Spike: Schrift in eine PPTX einbetten und prüfen, ob LibreOffice sie benutzt (pdffonts). Abnahme in PowerPoint durch den User.
// Aufruf: npm run spike:fonts -- <Regular.ttf> [Bold.ttf]   → out/spike-fonts.pptx (+ .pdf, wenn LibreOffice da ist)
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import PptxGenJS from 'pptxgenjs'
import { embedFonts, fontFamilyOf, ttfToEot } from '../src/main/embed-fonts'

const [regPath, boldPath] = process.argv.slice(2)
if (!regPath) { console.error('Aufruf: spike-embed-fonts <Regular.ttf> [Bold.ttf]'); process.exit(2) }
const regular = readFileSync(regPath), bold = boldPath ? readFileSync(boldPath) : undefined
const family = fontFamilyOf(regular)

// EOT-Header-Selbstcheck
const eot = ttfToEot(regular)
assert.equal(eot.readUInt32LE(0), eot.length); assert.equal(eot.readUInt32LE(4), regular.length); assert.equal(eot.readUInt16LE(34), 0x504c)
assert.ok(eot.subarray(eot.length - regular.length).equals(regular))

const pptx = new PptxGenJS()
pptx.layout = 'LAYOUT_WIDE'
const s = pptx.addSlide()
s.addText(`${family}: Zwölf Boxkämpfer jagen Viktor quer über den großen Sylter Deich – 0123456789 %`, { x: 0.6, y: 0.6, w: 12, h: 1.2, fontFace: family, fontSize: 28 })
s.addText(`${family} fett: Sphinx of black quartz, judge my vow`, { x: 0.6, y: 2, w: 12, h: 1, fontFace: family, fontSize: 28, bold: true })
s.addText('Calibri zum Vergleich: Zwölf Boxkämpfer jagen Viktor quer über den großen Sylter Deich', { x: 0.6, y: 3.4, w: 12, h: 1, fontFace: 'Calibri', fontSize: 28 })
const raw = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
const out = await embedFonts(raw, [{ family, regular, bold, serif: true }])
mkdirSync('out', { recursive: true })
writeFileSync('out/spike-fonts.pptx', out)

const zip = await JSZip.loadAsync(out)
const pres = await zip.file('ppt/presentation.xml')!.async('string')
assert.match(pres, new RegExp(`<p:embeddedFontLst><p:embeddedFont><p:font typeface="${family}"`))
assert.ok(pres.includes('embedTrueTypeFonts="1"') && zip.file('ppt/fonts/font1.fntdata'))
console.log(`out/spike-fonts.pptx: "${family}" eingebettet (${bold ? 'regular + bold' : 'regular'}, ${Math.round(out.length / 1024)} kB)`)

const soffice = spawnSync('which', ['soffice']).status === 0 ? ['soffice'] : spawnSync('flatpak', ['info', 'org.libreoffice.LibreOffice']).status === 0 ? ['flatpak', 'run', 'org.libreoffice.LibreOffice'] : null
if (!soffice) { console.log('LibreOffice fehlt, keine Render-Prüfung. PPTX in PowerPoint öffnen: Datei → Info → Schriftarten eingebettet?'); process.exit(0) }
execFileSync(soffice[0], [...soffice.slice(1), '--headless', '--convert-to', 'pdf', '--outdir', 'out', 'out/spike-fonts.pptx'], { stdio: 'pipe' })
const fonts = execFileSync('pdffonts', ['out/spike-fonts.pdf']).toString()
console.log(fonts)
const norm = (t: string) => t.replace(/[\s-]/g, '') // PDF nennt den PostScript-Namen: „Inter-SemiBold“
console.log(norm(fonts).includes(norm(family)) ? `✓ LibreOffice hat "${family}" aus der PPTX benutzt` : `✗ LibreOffice hat "${family}" ersetzt (eingebettete Schrift ignoriert oder Familie nicht gefunden)`)
