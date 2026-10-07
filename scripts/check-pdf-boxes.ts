// TrimBox/BleedBox im Druck-PDF: npx esbuild scripts/check-pdf-boxes.ts --bundle --platform=node --outfile=out/check-pdf-boxes.cjs && node out/check-pdf-boxes.cjs
import assert from 'node:assert/strict'
import { setPrintBoxes } from '../src/main/pdf-boxes'

// Kleines PDF wie von Skia: PDF-1.4, klassische xref, unkomprimierte Seitenobjekte mit verschachtelten Dicts
const objs = [
  '<</Title (Test)>>',
  '<</Type /Catalog\n/Pages 3 0 R>>',
  '<</Type /Pages\n/Count 2\n/Kids [4 0 R 5 0 R]>>',
  '<</Type /Page\n/Resources <</ProcSet [/PDF]>>\n/MediaBox [0 0 612.28345 858.89764]\n/Parent 3 0 R>>',
  '<</Type /Page\n/Resources <</ProcSet [/PDF]>>\n/MediaBox [0 0 612.28345 858.89764]\n/Parent 3 0 R>>',
]
let src = '%PDF-1.4\n'
const offs = objs.map((o, i) => { const at = src.length; src += `${i + 1} 0 obj\n${o}\nendobj\n`; return at })
const xrefAt = src.length
src += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
src += `trailer\n<</Size ${objs.length + 1}\n/Root 2 0 R\n/Info 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`
const pdf = Buffer.from(src, 'latin1')

const b = (3 * 72) / 25.4 // 3 mm in pt
const out = setPrintBoxes(pdf, b)
assert.ok(out.length > pdf.length && out.subarray(0, pdf.length).equals(pdf), 'Original bleibt unverändert als Präfix')
const tail = out.subarray(pdf.length).toString('latin1')

// beide Seiten neu, mit Boxen aus ihrer MediaBox; Pages-Objekt bleibt
for (const n of [4, 5]) {
  const obj = new RegExp(`${n} 0 obj\\n([\\s\\S]*?)\\nendobj`).exec(tail)?.[1]
  assert.ok(obj, `Seite ${n} im Update`)
  const nums = (key: string) => new RegExp(`/${key} \\[([^\\]]+)\\]`).exec(obj!)![1].split(' ').map(Number)
  nums('TrimBox').forEach((v, i) => assert.ok(Math.abs(v - [b, b, 612.28345 - b, 858.89764 - b][i]) < 1e-3, `TrimBox Seite ${n}`))
  assert.deepEqual(nums('BleedBox'), [0, 0, 612.28345, 858.89764])
  assert.deepEqual(nums('MediaBox'), [0, 0, 612.28345, 858.89764])
  assert.ok(obj.includes('/Parent 3 0 R') && obj.includes('/Resources <</ProcSet [/PDF]>>'), 'restliche Einträge bleiben')
}
assert.ok(!/3 0 obj/.test(tail), '/Pages wird nicht angefasst')

// neue xref: jeder Offset zeigt auf „N 0 obj“; trailer mit /Prev auf die alte xref; startxref auf die neue
const s = out.toString('latin1')
const newXref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)![1])
assert.ok(s.startsWith('xref\n', newXref), 'startxref zeigt auf die neue xref')
const entries = [...s.slice(newXref).matchAll(/^(\d+) 1\n(\d{10}) 00000 n \n/gm)]
assert.deepEqual(entries.map((e) => e[1]), ['4', '5'])
for (const [, n, off] of entries) assert.ok(s.startsWith(`${n} 0 obj`, Number(off)), `Offset von Objekt ${n}`)
const trailer = /trailer\n<<([\s\S]*?)>>\nstartxref/.exec(s.slice(newXref))![1]
assert.match(trailer, /\/Size 6\b/)
assert.match(trailer, /\/Root 2 0 R/)
assert.match(trailer, /\/Info 1 0 R/)
assert.match(trailer, new RegExp(`/Prev ${xrefAt}\\b`))

// unerwartete Struktur → unverändert zurück (mit Warnung)
const warn = console.warn
console.warn = () => {}
const broken = [
  Buffer.from(src.replace(/startxref\n\d+/, 'startxref\n12'), 'latin1'), // startxref zeigt nicht auf „xref“ (wie bei xref-Streams)
  Buffer.from(src.replace(/\/MediaBox \[[^\]]+\]/g, ''), 'latin1'), // keine MediaBox
  Buffer.from(src.replace(/%%EOF\n$/, ''), 'latin1'), // abgeschnitten
  Buffer.from('kein pdf'),
]
for (const x of broken) assert.equal(setPrintBoxes(x, b), x)
console.warn = warn
console.log('check-pdf-boxes: ok')
