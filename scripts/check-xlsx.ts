// Excel-Verknüpfung (Bereich aus .xlsx → Diagrammdaten): npx esbuild scripts/check-xlsx.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=${TMPDIR:-/tmp}/check-xlsx.mjs && node ${TMPDIR:-/tmp}/check-xlsx.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { readXlsxRange } from '../src/main/xlsx-link'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const sheet = (rows: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`

// Blatt „Umsatz“: Shared Strings (auch Rich Text mit Lautschrift), Inline-String mit Entity, Formel mit gecachtem Wert, Formel-Text, leere und Text-Zelle
const SHEET1 = sheet(
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Q2 &#8211; neu</t></is></c><c r="D1"><v>999</v></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="3"><v>2.6</v></c><c r="C2"><f>B2*2</f><v>5.2</v></c><c r="D2"><v>999</v></c></row>' +
  '<row r="3"><c r="A3" t="str"><f>"West"</f><v>West</v></c><c r="B3" s="1"/><c r="C3" t="inlineStr"><is><r><t>n. v.</t></r></is></c></row>',
)
// Blatt „Kosten & Co“ (Name mit Entity, Ziel absolut): Zahlen als Kategorien, wissenschaftliche Schreibweise
const SHEET2 = sheet('<row r="1"><c r="B1"><v>2024</v></c><c r="C1"><v>2025</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Miete</t></is></c><c r="B2"><v>1200</v></c><c r="C2"><v>-3.5E2</v></c></row>')

const SST = `<?xml version="1.0" encoding="UTF-8"?><sst ${NS} count="3" uniqueCount="3"><si><t>Region</t></si><si><t>Q1</t></si><si><r><rPr><b/><sz val="11"/></rPr><t>Nord</t></r><r><t xml:space="preserve"> &amp; Süd</t></r><rPh sb="0" eb="1"><t>ignorieren</t></rPh></si></sst>`

async function xlsx(file: string, sheet1 = SHEET1, sst = SST) {
  const z = new JSZip()
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>')
  z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  z.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS}><sheets><sheet name="Umsatz" sheetId="1" r:id="rId1"/><sheet name="Kosten &amp; Co" sheetId="2" r:id="rId2"/></sheets></workbook>`)
  z.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`)
  z.file('xl/sharedStrings.xml', sst)
  z.file('xl/worksheets/sheet1.xml', sheet1)
  z.file('xl/worksheets/sheet2.xml', SHEET2)
  writeFileSync(file, await z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
  return file
}

const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'check-xlsx-'))
try {
  const file = await xlsx(join(dir, 'zahlen.xlsx'))

  // erstes Blatt ohne Namen, Bereich mit $
  const a = await readXlsxRange({ file, range: '$A$1:$C$3' })
  assert.deepEqual(a.categories, ['Q1', 'Q2 – neu'])
  assert.deepEqual(a.series, [{ name: 'Nord & Süd', values: [2.6, 5.2] }, { name: 'West', values: [0, 0] }])
  assert.equal(a.warnings.length, 2, a.warnings.join(' | '))
  assert.match(a.warnings.join(' | '), /B3/)
  assert.match(a.warnings.join(' | '), /C3 \(„n\. v\.“\)/)

  // zweites Blatt per Name
  const b = await readXlsxRange({ file, sheet: 'Kosten & Co', range: 'A1:C2' })
  assert.deepEqual(b, { categories: ['2024', '2025'], series: [{ name: 'Miete', values: [1200, -350] }], warnings: [] })

  // Fehler
  await assert.rejects(readXlsxRange({ file, range: 'A1:AE2' }), /zu groß.*30/)
  await assert.rejects(readXlsxRange({ file, range: 'A1:A5' }), /zu klein/)
  await assert.rejects(readXlsxRange({ file, range: 'A1-C3' }), /ungültig/)
  await assert.rejects(readXlsxRange({ file: join(dir, 'alt.xls'), range: 'A1:C3' }), /keine \.xlsx-Datei/)
  await assert.rejects(readXlsxRange({ file: join(dir, 'fehlt.xlsx'), range: 'A1:C3' }), /nicht gefunden/)
  await assert.rejects(readXlsxRange({ file, sheet: 'Gibtsnicht', range: 'A1:C3' }), /Blatt „Gibtsnicht“ fehlt.*Umsatz, Kosten & Co/)
  writeFileSync(join(dir, 'kaputt.xlsx'), 'kein zip')
  await assert.rejects(readXlsxRange({ file: join(dir, 'kaputt.xlsx'), range: 'A1:C3' }), /keine gültige/)
  // Zip-Bombe: 26 MB Leerraum komprimieren auf wenige KB, der Eintrag liegt über dem Limit von readCapped
  const bomb = await xlsx(join(dir, 'bombe.xlsx'), SHEET1.replace('<sheetData>', ' '.repeat(26 << 20) + '<sheetData>'))
  await assert.rejects(readXlsxRange({ file: bomb, range: 'A1:C3' }), /über 25 MB/)
  // ReDoS: 300 000 offene Tags ohne Schluss-Tag (komprimiert winzig) dürfen den Hauptprozess nicht einfrieren
  const open = await xlsx(join(dir, 'offen.xlsx'), sheet(`<row r="1">${'<c r="A1">'.repeat(300_000)}</row>`), SST.replace('<si><t>Region', `<si>${'<rPh>'.repeat(300_000)}</si><si><t>Region`))
  const t0 = performance.now()
  await readXlsxRange({ file: open, range: 'A1:C3' }).catch((e: Error) => e)
  const ms = performance.now() - t0
  assert.ok(ms < 2000, `offene Tags brauchen ${Math.round(ms)} ms`)

  console.log('xlsx ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
