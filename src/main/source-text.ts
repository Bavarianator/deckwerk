// Quellmaterial (Canva „Deck aus Dokument“): Text aus TXT/MD/CSV/JSON, DOCX, PPTX und PDF ziehen, dazu Bilder und Abbildungen; Videos nur als Verweis.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import JSZip from 'jszip'
import { VIDEO_EXT } from '../shared/deck'
import { LONG_VIDEO, mmss } from '../shared/video'
import { assetUrl, imageSize } from './tools'

export const SOURCE_IMG = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']
export const SOURCE_EXT = ['txt', 'md', 'csv', 'json', 'docx', 'pptx', 'pdf', ...SOURCE_IMG, ...VIDEO_EXT]
export const SOURCE_MAX = 60_000 // Zeichen; der Rest wird abgeschnitten
const MIN_PX = 150 * 150 // kleinere Abbildungen sind Icons, Linien, Zierrat
const MAX_IMG = 20
const IMG_MAX_BYTES = 25 << 20
const IMG_NAME = /\.(png|jpe?g|gif|webp|svg)$/i // was der Renderer zeigen kann (kein EMF/WMF)

// nur Textläufe (<a:t>, <w:t>) je Absatz; Animations- und Stilangaben bleiben draußen
const paraText = (p: string) => [...p.matchAll(/<[aw]:t(?: [^>]*)?>([^<]*)<\/[aw]:t>/g)].map((m) => unxml(m[1])).join('')
const runs = (xml: string) => xml.split(/<\/[aw]:p>/).map(paraText).filter((t) => t.trim()).join('\n')
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const clean = (n: string) => n.normalize('NFC').replace(/[^\p{L}\p{N}._-]+/gu, '-') // Namen aus fremden Dateien nie als Pfad nutzen; NFC: macOS liefert Umlaute zerlegt
const imageLine = (url: string, b: Buffer) => {
  const s = imageSize(b)
  return `Bild: ${url}${s ? ` (${s.width}×${s.height} px)` : /\.svg$/i.test(url) ? ' (SVG)' : ''}`
}
const run = (cmd: string, args: string[], timeout = 0) => new Promise<string>((ok, fail) => execFile(cmd, args, { maxBuffer: 64 << 20, timeout }, (e, out) => (e ? fail(e) : ok(out))))

// assetDir: Bilder einer PPTX dorthin kopieren und je Folie als asset://-URL nennen, damit die KI sie im Nachbau nutzt
// Bilder einer Folie laut ppt/slides/_rels/slideN.xml.rels; EMF/WMF u. ä. kann der Renderer nicht zeigen
async function slideImages(zip: JSZip, slide: string, dir: string): Promise<string[]> {
  const rels = await zip.file(slide.replace('slides/', 'slides/_rels/') + '.rels')?.async('string')
  const media = [...(rels ?? '').matchAll(/Type="[^"]*\/image"[^>]*Target="\.\.\/media\/([^"]+)"|Target="\.\.\/media\/([^"]+)"[^>]*Type="[^"]*\/image"/g)]
    .map((m) => m[1] ?? m[2]).filter((n) => IMG_NAME.test(n))
  const urls = await Promise.all([...new Set(media)].map(async (n) => {
    const f = zip.file(`ppt/media/${n}`)
    const b = f && (await readCapped(f)) // fehlt bei verlinkten, nicht eingebetteten Bildern
    return b ? assetUrl(await keepImage(basename(n.replace(/\\/g, '/')), b, dir)) : ''
  }))
  return urls.filter(Boolean)
}

// DOCX: Abbildungen (a:blip, v:imagedata) direkt nach dem Text ihres Absatzes nennen
async function docxWithImages(zip: JSZip, xml: string, dir: string): Promise<string> {
  const rels = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? ''
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(([r]) => [r.match(/\bId="([^"]+)"/)?.[1], r.match(/\bTarget="([^"]+)"/)?.[1]]))
  const seen = new Set<string>()
  const lines: string[] = []
  let reads = 0 // zählt auch übersprungene Icons: eine präparierte Datei soll nicht beliebig viele Bilder entpacken lassen
  for (const p of xml.split(/<\/[aw]:p>/)) {
    const t = paraText(p)
    if (t.trim()) lines.push(t)
    for (const [, id] of p.matchAll(/<(?:a:blip\b[^>]*\br:embed|v:imagedata\b[^>]*\br:id)="([^"]+)"/g)) {
      const n = target.get(id)
      if (!n || !IMG_NAME.test(n) || seen.has(n)) continue // EMF/WMF oder doppelt
      if (seen.size >= MAX_IMG || reads >= 3 * MAX_IMG) continue
      const f = zip.file(`word/${n}`)
      if (!f) continue // verlinkt, nicht eingebettet
      reads++
      const b = await readCapped(f)
      const s = b && imageSize(b)
      if (!b || (s && s.width * s.height < MIN_PX)) continue
      seen.add(n)
      lines.push(imageLine(assetUrl(await keepImage(basename(n), b, dir)), b))
    }
  }
  return lines.join('\n')
}

// Auswahl aus `pdfimages -list`: Masken (smask, stencil) und Kleinkram bleiben draußen.
// Leer, wenn die Extraktion der Seiten 1..l zu groß würde: Ein präpariertes PDF kann winzig komprimiert riesige Maße deklarieren (tmpdir ist oft RAM).
export function pdfPick(list: string): string[][] {
  const rows = list.split('\n').slice(2).map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 4)
  const seen = new Set<string>()
  const pick: string[][] = []
  for (const c of rows) {
    const id = c[10] === '-' ? '' : `${c[10]} ${c[11]}` // Objektnummer + Generation: dasselbe Bild auf mehreren Seiten; Inline-Bilder haben keine
    if (c[2] !== 'image' || +c[3] * +c[4] < MIN_PX || seen.has(id) || pick.length >= MAX_IMG) continue
    if (id) seen.add(id)
    pick.push(c)
  }
  const last = +(pick[pick.length - 1]?.[0] ?? 0)
  const px = rows.filter((c) => +c[0] <= last).map((c) => +c[3] * +c[4])
  return px.every((p) => p <= 50e6) && px.reduce((a, p) => a + p, 0) <= 400e6 ? pick : [] // NaN zählt als zu groß
}

// PDF: Rasterbilder per Poppler pdfimages
async function pdfImages(file: string, dir: string): Promise<{ page: number; line: string }[]> {
  const pick = pdfPick(await run('pdfimages', ['-list', file], 60_000))
  if (!pick.length) return []
  const tmp = await mkdtemp(join(tmpdir(), 'dw-pdf-'))
  try {
    // -f 1, damit num wie in -list zählt; Dateien heißen i-<seite>-<num>.png bzw. .jpg (-j: JPEGs unverändert, kleiner und schneller)
    await run('pdfimages', ['-png', '-j', '-p', '-f', '1', '-l', pick[pick.length - 1][0], file, join(tmp, 'i')], 180_000)
    const files = await readdir(tmp)
    return (await Promise.all(pick.map(async ([page, num, , w, h]) => {
      const n = files.find((f) => f.startsWith(`i-${page.padStart(3, '0')}-${num.padStart(3, '0')}.`))
      if (!n || (await stat(join(tmp, n))).size > IMG_MAX_BYTES) return [] // nicht extrahiert oder zu groß: nur dieses Bild fehlt
      return [{ page: +page, line: `Bild: ${assetUrl(await keepImage(n, await readFile(join(tmp, n)), dir))} (${w}×${h} px)` }]
    }))).flat()
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

// Ablage: gleicher Name mit gleichem Inhalt wird wiederverwendet, sonst Suffix aus dem Inhalts-Hash; nie eine vorhandene Datei überschreiben
async function keepImage(name: string, b: Buffer, dir: string): Promise<string> {
  const n = clean(name)
  await mkdir(dir, { recursive: true })
  const old = await readFile(join(dir, n)).catch(() => null)
  const file = join(dir, !old || old.equals(b) ? n : `${basename(n, extname(n))}-${createHash('sha1').update(b).digest('hex').slice(0, 8)}${extname(n)}`)
  await writeFile(file, b, { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e
  })
  return file
}

// Zip-Eintrag lesen, aber nicht über 25 MB (Zip-Bombe: die Größenangabe im Archiv kann lügen)
// JSZips eigener Stream statt nodeStream: läuft auch ohne Node-Streams (Android-WebView); internalStream fehlt in den Typings
type Streamable = { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> }
const readCapped = (f: JSZip.JSZipObject) => new Promise<Buffer | null>((ok, fail) => {
  const parts: Buffer[] = []
  let size = 0
  const s = (f as JSZip.JSZipObject & Streamable).internalStream('uint8array')
  s.on('data', (c) => {
    if ((size += c.length) <= IMG_MAX_BYTES) return parts.push(Buffer.from(c))
    s.pause()
    ok(null)
  })
  s.on('end', () => ok(Buffer.concat(parts))).on('error', fail).resume() // startet pausiert
})

export async function sourceText(file: string, assetDir?: string): Promise<string> {
  const ext = extname(file).slice(1).toLowerCase()
  const dir = assetDir && join(assetDir, `import-${clean(basename(file, extname(file)))}`) // Abbildungen aus PDF, DOCX, PPTX
  if (ext === 'pdf') {
    const text = await run('pdftotext', [file, '-']).catch((e: NodeJS.ErrnoException) => {
      throw new Error(e.code === 'ENOENT' ? 'PDF lesen braucht pdftotext (Paket poppler).' : e.message)
    })
    // ohne pdfimages, bei Fehlern oder Zeitüberschreitung bleibt es beim Text
    const images = dir ? await pdfImages(file, dir).catch(() => []) : []
    if (!images.length) return text
    return text.split('\f').map((t, i) => {
      const l = [t.trim(), ...images.filter((m) => m.page === i + 1).map((m) => m.line)].filter(Boolean)
      return l.length ? [`--- Seite ${i + 1} ---`, ...l].join('\n') : ''
    }).filter(Boolean).join('\n\n')
  }
  if (ext === 'docx' || ext === 'pptx') {
    const zip = await JSZip.loadAsync(await readFile(file))
    const parts = Object.keys(zip.files)
      .filter((n) => (ext === 'docx' ? n === 'word/document.xml' : /^ppt\/slides\/slide\d+\.xml$/.test(n)))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
    if (ext === 'docx' && dir && parts.length) return docxWithImages(zip, await zip.file(parts[0])!.async('string'), dir)
    const texts = await Promise.all(parts.map(async (n) => runs(await zip.file(n)!.async('string'))))
    if (ext === 'docx') return texts.join('\n')
    const images = await Promise.all(parts.map((n) => (dir ? slideImages(zip, n, dir) : [])))
    return texts.map((t, i) => [`--- Folie ${i + 1} ---`, t.trim(), ...images[i].map((u) => `Bild: ${u}`)].filter(Boolean).join('\n')).join('\n\n')
  }
  if (VIDEO_EXT.includes(ext)) {
    // nicht kopieren (oft mehrere GB), nur verlinken. Ohne ffmpeg bleibt die Zeile ohne Maße; lädt Deckwerk es erst, wartet der Anhang höchstens 15 s
    const v = await Promise.race([import('./ffmpeg').then((m) => m.probe(file)), new Promise<null>((ok) => setTimeout(ok, 15_000, null).unref())]).catch(() => null)
    return `Video: ${assetUrl(file)}${v ? ` (${mmss(v.duration)}, ${v.w}×${v.h})` : ''}. ${v && v.duration > LONG_VIDEO ? 'Über 10 min: erst video_highlights, dann nur die Fenster transkribieren (ganzes Video kürzen: transcribe_video mit all: true)' : 'Zuerst transcribe_video'}; Abläufe für Short, ganzes Video kürzen, Stream-Highlights und Kompilation: Guide § Video.`
  }
  if (IMG_NAME.test(file)) {
    if ((await stat(file)).size > IMG_MAX_BYTES) throw new Error('Bild ist größer als 25 MB.')
    const b = await readFile(file)
    return imageLine(assetUrl(assetDir ? await keepImage(basename(file), b, assetDir) : file), b)
  }
  if (!SOURCE_EXT.includes(ext)) throw new Error(`Dateityp ${ext ? `.${ext}` : 'ohne Endung'} wird nicht unterstützt (${SOURCE_EXT.join(', ')}).`)
  return readFile(file, 'utf8')
}
