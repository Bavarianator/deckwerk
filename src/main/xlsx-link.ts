// Deckwerk Pro: Diagrammwerte aus einem Bereich einer .xlsx lesen (wie think-cell „Aktualisieren“), ohne Electron und ohne Excel-Bibliothek.
// Erste Zeile ab Spalte 2 = Kategorien, erste Spalte ab Zeile 2 = Reihennamen, der Rest = Werte.
// Zahlen kommen direkt als Zahl ins Ergebnis, nie über Text: csvToSpec (items.ts) würde „2.6“ zu 26 machen.
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, posix } from 'node:path'
import JSZip from 'jszip'
import type { ChartLink } from '../shared/deck'
import { readCapped } from './source-text'

const MAX_FILE = 50 << 20
const MAX_ROWS = 30
const MAX_COLS = 30

export interface XlsxRange { categories: string[]; series: { name: string; values: number[] }[]; warnings: string[] }
type Cell = string | number | undefined
type Elem = { a: Record<string, string>; body: string }

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unxml = (s: string) => s.replace(/&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
  if (e[0] !== '#') return ENT[e]
  const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
  return n <= 0x10ffff ? String.fromCodePoint(n) : m
})
// Attribute ohne Namensraum-Präfix (r:id → id)
const attrs = (tag: string) => Object.fromEntries([...tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1].replace(/^[\w.-]+:/, ''), unxml(m[2] ?? m[3])]))
// <name …/> oder <name …>inhalt</name>, Präfix egal; reicht für die flachen Teile hier (c, row, si, t, v, sheet, Relationship, rPh verschachteln sich nicht).
// Linear per indexOf statt Regex mit [\s\S]*?: Der suchte bei vielen offenen Tags ohne Schluss-Tag quadratisch und fror den Hauptprozess ein.
// Fehlt ein Schluss-Tag, endet die Suche (kaputtes XML, danach kommt nichts Verlässliches mehr).
function scan(xml: string, name: string) {
  const out: { from: number; to: number; attrs: string; body: string }[] = []
  const open = new RegExp(`<((?:[\\w.-]+:)?${name})(?=[\\s>]|/>)`, 'g')
  for (let m: RegExpExecArray | null; (m = open.exec(xml)); ) {
    const gt = xml.indexOf('>', open.lastIndex)
    if (gt < 0) break
    const head = xml.slice(open.lastIndex, gt)
    if (head.endsWith('/')) {
      out.push({ from: m.index, to: gt + 1, attrs: head.slice(0, -1), body: '' })
      open.lastIndex = gt + 1
      continue
    }
    const close = `</${m[1]}>`, end = xml.indexOf(close, gt + 1)
    if (end < 0) break
    open.lastIndex = end + close.length
    out.push({ from: m.index, to: open.lastIndex, attrs: head, body: xml.slice(gt + 1, end) })
  }
  return out
}
const elems = (xml: string, name: string): Elem[] => scan(xml, name).map((e) => ({ a: attrs(e.attrs), body: e.body }))
// Text eines <si> oder <is>: alle <t>, auch aus Rich-Text-Läufen <r>, ohne Lautschrift <rPh>
const textOf = (xml: string) => {
  let rest = '', at = 0
  for (const p of scan(xml, 'rPh')) { rest += xml.slice(at, p.from); at = p.to }
  return elems(rest + xml.slice(at), 't').map((t) => unxml(t.body)).join('')
}

const colNum = (s: string) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0)
const colName = (n: number): string => (n > 26 ? colName(Math.floor((n - 1) / 26)) : '') + String.fromCharCode(65 + ((n - 1) % 26))

function value(c: Elem, shared: string[]): Cell {
  if (c.a.t === 'inlineStr') return textOf(c.body)
  const v = elems(c.body, 'v')[0]?.body // bei Formeln der zuletzt berechnete Wert
  if (v === undefined || v.trim() === '') return undefined
  if (c.a.t === 's') return shared[Number(v)]
  if (c.a.t === 'b') return v.trim() === '1' ? 'WAHR' : 'FALSCH'
  if (c.a.t === 'str' || c.a.t === 'e' || c.a.t === 'd') return unxml(v)
  return Number(v)
}

export async function readXlsxRange(link: ChartLink): Promise<XlsxRange> {
  const name = basename(link.file)
  if (extname(link.file).toLowerCase() !== '.xlsx') throw new Error(`„${name}“ ist keine .xlsx-Datei. Bitte in Excel als Arbeitsmappe (.xlsx) speichern.`)
  const m = link.range.trim().toUpperCase().match(/^\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/)
  if (!m || +m[2] < 1 || +m[4] < 1) throw new Error(`Bereich „${link.range}“ ist ungültig, erwartet wird z. B. „A1:D5“.`)
  const [r0, r1] = [+m[2], +m[4]].sort((x, y) => x - y)
  const [c0, c1] = [colNum(m[1]), colNum(m[3])].sort((x, y) => x - y)
  const rows = r1 - r0 + 1, cols = c1 - c0 + 1
  if (rows > MAX_ROWS || cols > MAX_COLS) throw new Error(`Bereich „${link.range}“ ist zu groß (${rows} × ${cols} Zellen, höchstens ${MAX_ROWS} × ${MAX_COLS}).`)
  if (rows < 2 || cols < 2) throw new Error(`Bereich „${link.range}“ ist zu klein: Die erste Zeile trägt die Kategorien, die erste Spalte die Reihennamen, also mindestens 2 × 2 Zellen.`)

  const st = await stat(link.file).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null
    throw e
  })
  if (!st?.isFile()) throw new Error(`Excel-Datei „${link.file}“ nicht gefunden.`)
  if (st.size > MAX_FILE) throw new Error(`„${name}“ ist größer als ${MAX_FILE >> 20} MB.`)
  const zip = await JSZip.loadAsync(await readFile(link.file)).catch(() => {
    throw new Error(`„${name}“ ist keine gültige .xlsx-Datei (beschädigt oder mit Kennwort geschützt).`)
  })
  const part = async (p: string) => {
    const f = zip.file(p)
    if (!f) return undefined
    const b = await readCapped(f)
    if (!b) throw new Error(`„${name}“ enthält einen zu großen Teil (${p}, über 25 MB).`)
    return b.toString('utf8')
  }

  const wb = await part('xl/workbook.xml')
  if (wb === undefined) throw new Error(`„${name}“ ist keine gültige .xlsx-Datei (xl/workbook.xml fehlt).`)
  const sheets = elems(wb, 'sheet').map((s) => s.a)
  const sh = link.sheet ? sheets.find((s) => s.name === link.sheet) : sheets[0]
  if (!sh) throw new Error(link.sheet ? `Blatt „${link.sheet}“ fehlt in „${name}“ (vorhanden: ${sheets.map((s) => s.name).join(', ')}).` : `„${name}“ enthält kein Blatt.`)
  const target = elems((await part('xl/_rels/workbook.xml.rels')) ?? '', 'Relationship').find((r) => r.a.Id === sh.id)?.a.Target
  const xml = target && (await part(target.startsWith('/') ? target.slice(1) : posix.join('xl', target)))
  if (!xml) throw new Error(`Blatt „${sh.name}“ in „${name}“ ist nicht lesbar.`)
  const shared = elems((await part('xl/sharedStrings.xml')) ?? '', 'si').map((s) => textOf(s.body))

  // nur Zeilen und Spalten im Bereich; fehlt r an Zeile oder Zelle, zählt die Position
  const cells = new Map<string, Cell>()
  let row = 0
  for (const r of elems(xml, 'row')) {
    row = Number(r.a.r) || row + 1
    if (row < r0 || row > r1) continue
    let col = 0
    for (const c of elems(r.body, 'c')) {
      const ref = c.a.r?.match(/^([A-Z]+)\d+$/)
      col = ref ? colNum(ref[1]) : col + 1
      if (col >= c0 && col <= c1) cells.set(`${row}:${col}`, value(c, shared))
    }
  }

  const text = (x: Cell) => (x === undefined ? '' : String(x).trim())
  const empty: string[] = [], bad: string[] = []
  const num = (r: number, c: number) => {
    const x = cells.get(`${r}:${c}`)
    if (typeof x === 'number' && Number.isFinite(x)) return x
    if (text(x)) bad.push(`${colName(c)}${r} („${text(x)}“)`)
    else empty.push(`${colName(c)}${r}`)
    return 0
  }
  const span = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)
  const out: XlsxRange = {
    categories: span(c0 + 1, c1).map((c) => text(cells.get(`${r0}:${c}`))),
    series: span(r0 + 1, r1).map((r) => ({ name: text(cells.get(`${r}:${c0}`)), values: span(c0 + 1, c1).map((c) => num(r, c)) })),
    warnings: [],
  }
  const list = (a: string[]) => a.slice(0, 8).join(', ') + (a.length > 8 ? ` und ${a.length - 8} weitere` : '')
  if (empty.length) out.warnings.push(`Leere Zellen als 0 übernommen: ${list(empty)}`)
  if (bad.length) out.warnings.push(`Keine Zahl, als 0 übernommen: ${list(bad)}`)
  return out
}
