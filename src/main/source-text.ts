// Quellmaterial (Canva „Deck aus Dokument“): Text aus TXT/MD/CSV/JSON, DOCX, PPTX und PDF ziehen.
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import JSZip from 'jszip'
import { assetUrl } from './tools'

export const SOURCE_EXT = ['txt', 'md', 'csv', 'json', 'docx', 'pptx', 'pdf']
export const SOURCE_MAX = 60_000 // Zeichen; der Rest wird abgeschnitten

// nur Textläufe (<a:t>, <w:t>) je Absatz; Animations- und Stilangaben bleiben draußen
const runs = (xml: string) => xml.split(/<\/[aw]:p>/).map((p) => [...p.matchAll(/<[aw]:t(?: [^>]*)?>([^<]*)<\/[aw]:t>/g)].map((m) => unxml(m[1])).join('')).filter((t) => t.trim()).join('\n')
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')

// assetDir: Bilder einer PPTX dorthin kopieren und je Folie als asset://-URL nennen, damit die KI sie im Nachbau nutzt
// Bilder einer Folie laut ppt/slides/_rels/slideN.xml.rels; EMF/WMF u. ä. kann der Renderer nicht zeigen
async function slideImages(zip: JSZip, slide: string, dir: string): Promise<string[]> {
  const rels = await zip.file(slide.replace('slides/', 'slides/_rels/') + '.rels')?.async('string')
  const media = [...(rels ?? '').matchAll(/Type="[^"]*\/image"[^>]*Target="\.\.\/media\/([^"]+)"|Target="\.\.\/media\/([^"]+)"[^>]*Type="[^"]*\/image"/g)]
    .map((m) => m[1] ?? m[2]).filter((n) => /\.(png|jpe?g|gif|webp|svg)$/i.test(n))
  const urls = await Promise.all([...new Set(media)].map(async (n) => {
    const f = zip.file(`ppt/media/${n}`)
    if (!f) return '' // verlinktes, nicht eingebettetes Bild
    await mkdir(dir, { recursive: true })
    const file = join(dir, basename(n.replace(/\\/g, '/'))) // Name kommt aus der fremden PPTX: nie als Pfad nutzen
    await writeFile(file, await f.async('nodebuffer'))
    return assetUrl(file)
  }))
  return urls.filter(Boolean)
}

export async function sourceText(file: string, assetDir?: string): Promise<string> {
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
    if (ext === 'docx') return texts.join('\n')
    const dir = assetDir && join(assetDir, `import-${basename(file, '.pptx').replace(/[^\w.-]+/g, '-')}`)
    const images = await Promise.all(parts.map((n) => (dir ? slideImages(zip, n, dir) : [])))
    return texts.map((t, i) => [`--- Folie ${i + 1} ---`, t.trim(), ...images[i].map((u) => `Bild: ${u}`)].filter(Boolean).join('\n')).join('\n\n')
  }
  if (!SOURCE_EXT.includes(ext)) throw new Error(`Dateityp ${ext ? `.${ext}` : 'ohne Endung'} wird nicht unterstützt (${SOURCE_EXT.join(', ')}).`)
  return readFile(file, 'utf8')
}
