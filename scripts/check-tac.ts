// Gesamtfarbauftrag (TAC) im CMYK-Druck-PDF (gs ab 10.05 optional): npx esbuild scripts/check-tac.ts --bundle --platform=node --outfile=${TMPDIR:-/tmp}/check-tac.cjs && node ${TMPDIR:-/tmp}/check-tac.cjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gsVersionError, tacOfPam, tacWarning, toPdfX4 } from '../src/main/print-pdf'

// PAM 100×10: 999 Pixel weiß, 1 Pixel 400 % (Kante) → Perzentil ignoriert ihn; mit 2 ‰ Vollton zählt er
const pam = (px: number[][]) => Buffer.concat([Buffer.from(`P7\nWIDTH ${px.length}\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE CMYK\nENDHDR\n`), Buffer.from(px.flat())])
const page = (dark: number, cmyk: number[], n = 1000) => pam([...Array(n - dark).fill([0, 0, 0, 0]), ...Array(dark).fill(cmyk)])
assert.equal(tacOfPam(page(0, [0, 0, 0, 0])), 0)
assert.equal(tacOfPam(page(1, [255, 255, 255, 255])), 0)
assert.equal(tacOfPam(page(2, [255, 255, 255, 255])), 400)
assert.equal(tacOfPam(page(1000, [191, 173, 170, 230])), 300) // 764/255 = 299,6 %
assert.equal(tacWarning([120, 300]), undefined)
assert.equal(tacWarning([335, 0, 301]), 'Gesamtfarbauftrag über 300 %: Seite 1 (335 %), Seite 3 (301 %). Tiefes Schwarz aus Fotos oder Farbflächen dunkler Themes; Druckerei fragen oder hellere Flächen.')

;(async () => {
  const version = (() => { try { return execFileSync('gs', ['--version']).toString() } catch { return undefined } })()
  if (gsVersionError(version)) console.log(`gs ab 10.05 fehlt (${version?.trim() ?? 'nicht gefunden'}), PDF-Teil übersprungen`)
  else {
    // Seite 1 RGB-Schwarz (FOGRA39 über gs: 299 %, knapp darunter), Seite 2 Passerschwarz 400 %, Seite 3 weiß
    const dir = mkdtempSync(join(tmpdir(), 'check-tac-'))
    execFileSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=pdfwrite', `-o${join(dir, 'in.pdf')}`, '-c',
      '<< /PageSize [200 200] >> setpagedevice 0 0 0 setrgbcolor 0 0 200 200 rectfill showpage 1 1 1 1 setcmykcolor 0 0 200 200 rectfill showpage 1 1 1 setrgbcolor 0 0 200 200 rectfill showpage'])
    const { pdf, warning } = await toPdfX4(readFileSync(join(dir, 'in.pdf')), resolve('assets/icc/FOGRA39L_coated.icc'))
    assert.ok(pdf.subarray(0, 5).toString() === '%PDF-')
    assert.match(warning ?? '', /^Gesamtfarbauftrag über 300 %: Seite 2 \((39\d|400) %\)\. /)
    console.log(warning)
  }
  console.log('check-tac ok')
})().catch((e) => { console.error(e); process.exit(1) })
