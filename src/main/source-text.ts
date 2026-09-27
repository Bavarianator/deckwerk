// Quellmaterial (Canva „Deck aus Dokument“): Text aus TXT/MD/CSV/JSON, DOCX, PPTX und PDF ziehen.
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import JSZip from 'jszip'

export const SOURCE_EXT = ['txt', 'md', 'csv', 'json', 'docx', 'pptx', 'pdf']
export const SOURCE_MAX = 60_000 // Zeichen; der Rest wird abgeschnitten

// nur Textläufe (<a:t>, <w:t>) je Absatz; Animations- und Stilangaben bleiben draußen
const runs = (xml: string) => xml.split(/<\/[aw]:p>/).map((p) => [...p.matchAll(/<[aw]:t(?: [^>]*)?>([^<]*)<\/[aw]:t>/g)].map((m) => unxml(m[1])).join('')).filter((t) => t.trim()).join('\n')
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

export async function sourceText(file: string): Promise<string> {
  const ext = extname(file).slice(1).toLowerCase()
  if (ext === 'pdf')
    return new Promise((ok, fail) => execFile('pdftotext', [file, '-'], { maxBuffer: 64 << 20 }, (e, out) =>
      e ? fail(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'PDF lesen braucht pdftotext (Paket poppler).' : e.message)) : ok(out)))
  if (ext === 'docx' || ext === 'pptx') {
    const zip = await JSZip.loadAsync(await readFile(file))
    const parts = Object.keys(zip.files)
      .filter((n) => (ext === 'docx' ? n === 'word/document.xml' : /^ppt\/slides\/slide\d+\.xml$/.test(n)))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
    const texts = await Promise.all(parts.map(async (n) => runs(await zip.file(n)!.async('string'))))
    return ext === 'pptx' ? texts.map((t, i) => `--- Folie ${i + 1} ---\n${t.trim()}`).join('\n\n') : texts.join('\n')
  }
  if (!SOURCE_EXT.includes(ext)) throw new Error(`Dateityp ${ext ? `.${ext}` : 'ohne Endung'} wird nicht unterstützt (${SOURCE_EXT.join(', ')}).`)
  return readFile(file, 'utf8')
}
