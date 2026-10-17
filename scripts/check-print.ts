// Druck-PDF als PDF/X-4 in CMYK (Ghostscript ab 10.05, qpdf, pdfinfo): npx esbuild scripts/check-print.ts --bundle --platform=node --outfile=${TMPDIR:-/tmp}/check-print.cjs && node ${TMPDIR:-/tmp}/check-print.cjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setPrintBoxes } from '../src/main/pdf-boxes'
import { gsVersionError, toPdfX4 } from '../src/main/print-pdf'

const ICC = resolve('assets/icc/FOGRA39L_coated.icc')
const dir = mkdtempSync(join(tmpdir(), 'check-print-'))

// Versionsvergleich
assert.equal(gsVersionError('10.05.0'), undefined)
assert.equal(gsVersionError('10.08.0\n'), undefined)
assert.equal(gsVersionError('11.0.1'), undefined)
for (const v of ['10.04.0', '10.02.1', '9.56.1']) assert.match(gsVersionError(v)!, new RegExp(`ab 10\\.05 \\(gefunden: ${v.replace(/\./g, '\\.')}\\)`))
assert.match(gsVersionError(undefined)!, /ab 10\.05 \(nicht gefunden\)/)

// zu altes und fehlendes gs über PATH: Meldung statt Wandlung
const path = process.env.PATH
writeFileSync(join(dir, 'gs'), '#!/bin/sh\necho 10.02.1\n')
chmodSync(join(dir, 'gs'), 0o755)
;(async () => {
  process.env.PATH = dir
  await assert.rejects(toPdfX4(Buffer.from('%PDF'), ICC), /ab 10\.05 \(gefunden: 10\.02\.1\)/)
  process.env.PATH = join(dir, 'leer')
  await assert.rejects(toPdfX4(Buffer.from('%PDF'), ICC), /nicht gefunden/)
  process.env.PATH = path

  let version: string | undefined
  try { version = execFileSync('gs', ['--version'], { encoding: 'utf8' }) } catch { /* fehlt */ }
  if (gsVersionError(version)) {
    console.log(`check-print: übersprungen, ${gsVersionError(version)}`)
    return
  }

  // RGB-PDF wie von Skia (PDF-1.4, klassische xref): rote Fläche, halbtransparente blaue Fläche, schwarzer Text, Transparenzgruppe in RGB
  const content = '1 0 0 rg 0 0 300 200 re f\n/G1 gs 0 0 1 rg 100 50 300 200 re f\n/G0 gs BT /F1 24 Tf 0 0 0 rg 40 120 Td (Schwarzer Text) Tj ET\n'
  const objs = [
    '<</Title (Test)>>',
    '<</Type /Catalog\n/Pages 3 0 R>>',
    '<</Type /Pages\n/Count 1\n/Kids [4 0 R]>>',
    '<</Type /Page\n/Resources <</ExtGState <</G0 <</ca 1>> /G1 <</ca 0.5>>>> /Font <</F1 6 0 R>>>>\n/Group <</Type /Group /S /Transparency /CS /DeviceRGB>>\n/MediaBox [0 0 500 300]\n/Contents 5 0 R\n/Parent 3 0 R>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',
  ]
  let src = '%PDF-1.4\n'
  const offs = objs.map((o, i) => { const at = src.length; src += `${i + 1} 0 obj\n${o}\nendobj\n`; return at })
  const xrefAt = src.length
  src += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  src += `trailer\n<</Size ${objs.length + 1}\n/Root 2 0 R\n/Info 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`

  const bleed = (3 * 72) / 25.4
  const out = join(dir, 'druck-x4.pdf')
  writeFileSync(out, await toPdfX4(setPrintBoxes(Buffer.from(src, 'latin1'), bleed), ICC))
  execFileSync('qpdf', ['--qdf', '--object-streams=disable', out, join(dir, 'qdf.pdf')])
  const q = readFileSync(join(dir, 'qdf.pdf'), 'latin1')
  assert.match(q, /\/GTS_PDFXVersion \(PDF\/X-4\)/)
  assert.match(q, /\/OutputIntents/)
  assert.match(q, /\/OutputConditionIdentifier \(FOGRA39\)/)
  assert.doesNotMatch(q, /\/DeviceRGB/)
  assert.match(q, /\/ca 0\.5/, 'Transparenz bleibt (nicht gerastert)')

  const info = execFileSync('pdfinfo', ['-box', out], { encoding: 'utf8' })
  const box = (k: string) => /: +([-\d.]+) +([-\d.]+) +([-\d.]+) +([-\d.]+)/.exec(info.split('\n').find((l) => l.startsWith(k))!)!.slice(1).map(Number)
  const media = box('MediaBox')
  box('TrimBox').forEach((v, i) => assert.ok(Math.abs(v - (media[i] + (i < 2 ? bleed : -bleed))) < 0.01, `TrimBox = MediaBox − Beschnitt (${i})`))
  assert.deepEqual(box('BleedBox'), media)
  console.log(`check-print: ok (${out})`)
})().catch((e) => { console.error(e); process.exit(1) })
