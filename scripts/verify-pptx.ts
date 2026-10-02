// PPTX-Treue-Check: rendert unsere PPTX mit LibreOffice (PPTX → PDF → PNG) und vergleicht jede Folie mit dem
// eigenen PNG-Export (Chromium). Pro Folie: Diff-Score und Textboxen, deren Zeilenzahl abweicht oder die
// überlaufen. Dient der Kalibrierung von WRAP_SLACK und Zeilenabständen in src/main/export-pptx.ts.
// Aufruf: npm run verify:pptx -- exports/<slug>.pptx [weitere.pptx]   (vorher: npm run render examples/<x>.json)
// Braucht: soffice (oder flatpak org.libreoffice.LibreOffice) und pdftoppm (poppler).
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { inflateSync } from 'node:zlib'
import JSZip from 'jszip'

const EMU = 9525 // 1 CSS-px
const K = 2 // Export-PNGs sind 2560×1440 (zoom 2)

// ---------- PNG → Graustufen (nur was wir brauchen: 8 Bit, RGB/RGBA/Gray, nicht interlaced) ----------
interface Gray { w: number; h: number; px: Uint8Array }
function decodePng(buf: Buffer): Gray {
  let p = 8, w = 0, h = 0, ct = 0
  const idat: Buffer[] = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; if (data[8] !== 8 || data[12]) throw new Error('PNG: nur 8 Bit, nicht interlaced') }
    else if (type === 'IDAT') idat.push(data)
    p += 12 + len
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] ?? 3
  const raw = inflateSync(Buffer.concat(idat)), stride = w * ch, out = new Uint8Array(w * h), prev = new Uint8Array(stride), cur = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0
      let x = row[i]
      if (f === 1) x += a; else if (f === 2) x += b; else if (f === 3) x += (a + b) >> 1
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); x += pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
      cur[i] = x & 255
    }
    for (let x = 0; x < w; x++) out[y * w + x] = ch < 3 ? cur[x * ch] : (cur[x * ch] * 299 + cur[x * ch + 1] * 587 + cur[x * ch + 2] * 114) / 1000
    prev.set(cur)
  }
  return { w, h, px: out }
}

// Box-Mittelwert auf 1/n → tolerant gegen Antialiasing und Subpixel-Verschiebungen
function shrink(g: Gray, n: number): Gray {
  const w = Math.floor(g.w / n), h = Math.floor(g.h / n), px = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) s += g.px[(y * n + dy) * g.w + x * n + dx]
    px[y * w + x] = s / (n * n)
  }
  return { w, h, px }
}

function diffScore(a: Gray, b: Gray): { mean: number; changed: number } {
  let sum = 0, changed = 0
  for (let i = 0; i < a.px.length; i++) { const d = Math.abs(a.px[i] - b.px[i]); sum += d; if (d > 40) changed++ }
  return { mean: (sum / a.px.length / 255) * 100, changed: (changed / a.px.length) * 100 }
}

// Tinte-Zeilen (Pixel, die deutlich vom Box-Hintergrund abweichen) im Bereich y0..y1 der Box; Hintergrund = Median der obersten Zeile.
function inkRows(g: Gray, box: Box, fromY: number, toY: number): boolean[] {
  const x0 = Math.max(0, Math.round(box.x * K)), x1 = Math.min(g.w, Math.round((box.x + box.w) * K))
  const y0 = Math.max(0, Math.round((box.y + fromY) * K)), y1 = Math.min(g.h, Math.round((box.y + toY) * K))
  const top = Array.from(g.px.subarray(Math.round(box.y * K) * g.w + x0, Math.round(box.y * K) * g.w + x1)).sort((a, b) => a - b)
  const bg = top[top.length >> 1] ?? 0
  const rows: boolean[] = []
  for (let y = y0; y < y1; y++) {
    let n = 0
    for (let x = x0; x < x1; x++) if (Math.abs(g.px[y * g.w + x] - bg) > 60) n++
    rows.push(n > 2)
  }
  return rows
}
// Zeilen = Tinte-Blöcke innerhalb der Box; Lücken kleiner als 1/4 der Schriftgröße (Umlautpunkte, Unterlängen) zählen nicht
function countLines(rows: boolean[], fontPx: number): number {
  const minGap = Math.max(2, Math.round(fontPx * 0.25 * K))
  let lines = 0, gap = Infinity
  for (const r of rows) {
    if (r) { if (gap >= minGap) lines++; gap = 0 } else gap++
  }
  return lines
}
const inkCount = (rows: boolean[]) => rows.filter(Boolean).length
// Tinte-Höhe in CSS-px (erste bis letzte Tinte-Zeile): robuster als Zeilenzählen bei großen Schriften
const inkExtent = (rows: boolean[]) => { const i = rows.indexOf(true), j = rows.lastIndexOf(true); return i < 0 ? 0 : (j - i + 1) / K }
const inkTop = (rows: boolean[]) => rows.indexOf(true) / K

interface Box { name: string; x: number; y: number; w: number; h: number; fontPx: number }
async function textBoxes(pptx: Buffer): Promise<Box[][]> {
  const zip = await JSZip.loadAsync(pptx)
  const out: Box[][] = []
  for (let i = 1; zip.file(`ppt/slides/slide${i}.xml`); i++) {
    const xml = await zip.file(`ppt/slides/slide${i}.xml`)!.async('string')
    const boxes: Box[] = []
    for (const [sp] of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
      const name = sp.match(/<p:cNvPr[^>]*\bname="(dw:[^"]*)"/)?.[1]
      const off = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"/), ext = sp.match(/<a:ext cx="(\d+)" cy="(\d+)"/)
      if (!name || !off || !ext || !/<a:t>[^<]*\S/.test(sp) || /^(!!)?dw:_/.test(name)) continue
      const sz = sp.match(/<a:rPr[^>]*\bsz="(\d+)"/)?.[1]
      boxes.push({ name, x: +off[1] / EMU, y: +off[2] / EMU, w: +ext[1] / EMU, h: +ext[2] / EMU, fontPx: sz ? +sz / 100 / 0.75 : 20 })
    }
    out.push(boxes)
  }
  return out
}

function soffice(): string[] {
  if (spawnSync('which', ['soffice']).status === 0) return ['soffice']
  if (spawnSync('flatpak', ['info', 'org.libreoffice.LibreOffice']).status === 0) return ['flatpak', 'run', 'org.libreoffice.LibreOffice']
  throw new Error('LibreOffice fehlt: `flatpak install --user flathub org.libreoffice.LibreOffice` oder pacman -S libreoffice-fresh')
}

async function verify(pptxPath: string) {
  const slug = basename(pptxPath, '.pptx'), ours = join(dirname(pptxPath), slug), out = join(dirname(pptxPath), 'verify', slug)
  mkdirSync(out, { recursive: true })
  const [cmd, ...args] = soffice()
  execFileSync(cmd, [...args, '--headless', '--convert-to', 'pdf', '--outdir', out, pptxPath], { stdio: 'pipe' })
  execFileSync('pdftoppm', ['-scale-to-x', String(1280 * K), '-scale-to-y', String(720 * K), '-png', join(out, `${slug}.pdf`), join(out, 'lo')])
  const lo = readdirSync(out).filter((f) => /^lo-\d+\.png$/.test(f)).sort()
  const boxes = await textBoxes(readFileSync(pptxPath))
  const report: any[] = []
  const offsets: { fontPx: number; offset: number }[] = []
  console.log(`\n${slug}: ${lo.length} Folien (LibreOffice) vs. ${ours}`)
  lo.forEach((f, i) => {
    const n = String(i + 1).padStart(2, '0'), oursFile = join(ours, `${n}.png`)
    if (!existsSync(oursFile)) return console.log(`  Folie ${i + 1}: ${oursFile} fehlt`)
    const a = decodePng(readFileSync(oursFile)), b = decodePng(readFileSync(join(out, f)))
    if (a.w !== b.w || a.h !== b.h) return console.log(`  Folie ${i + 1}: Größe ${a.w}×${a.h} vs ${b.w}×${b.h}`)
    const score = diffScore(shrink(a, 4), shrink(b, 4))
    const all = (boxes[i] ?? []).map((bx) => {
      const rowsA = inkRows(a, bx, 0, bx.h), rowsB = inkRows(b, bx, 0, bx.h)
      const linesOurs = countLines(rowsA, bx.fontPx), linesLo = countLines(rowsB, bx.fontPx)
      const extentOurs = inkExtent(rowsA), extentLo = inkExtent(rowsB)
      const wrapDiff = Math.abs(extentLo - extentOurs) > bx.fontPx * 0.6 // mehr/weniger Zeilen als bei uns
      const offset = rowsA.includes(true) && rowsB.includes(true) ? inkTop(rowsB) - inkTop(rowsA) : NaN // LO tiefer (+) / höher (−) als wir, CSS-px
      // Überlauf: LibreOffice hat im Streifen unter der Box deutlich mehr Tinte als wir (Nachbarn zählen in beiden gleich)
      const below = inkCount(inkRows(b, bx, bx.h, bx.h + 30)) - inkCount(inkRows(a, bx, bx.h, bx.h + 30))
      const box = diffScore(shrink(crop(a, bx), 2), shrink(crop(b, bx), 2))
      return { ...bx, linesOurs, linesLo, extentOurs, extentLo, wrapDiff, offset, overflowLo: below > 6, boxDiff: box.mean }
    })
    offsets.push(...all.filter((s) => !Number.isNaN(s.offset)).map((s) => ({ fontPx: s.fontPx, offset: s.offset })))
    const suspects = all.filter((s) => s.wrapDiff || s.overflowLo || s.boxDiff > 12)
    report.push({ slide: i + 1, ...score, boxes: all })
    const tag = score.changed > 15 ? '✗' : score.changed > 5 ? '!' : '✓'
    console.log(`  ${tag} Folie ${i + 1}: Diff ${score.mean.toFixed(1)} % (Fläche ${score.changed.toFixed(1)} %)`)
    for (const s of suspects)
      console.log(`      ${s.name.padEnd(28)} Zeilen ${s.linesOurs}→${s.linesLo}, Texthöhe ${Math.round(s.extentOurs)}→${Math.round(s.extentLo)} px${s.wrapDiff ? ' UMBRUCH' : ''}${s.overflowLo ? ' ÜBERLAUF' : ''}  Versatz ${s.offset >= 0 ? '+' : ''}${s.offset.toFixed(1)} px  Box-Diff ${s.boxDiff.toFixed(1)} %`)
  })
  // Vertikaler Versatz LO vs. Chromium nach Schriftgröße (Median): Kalibrierdaten für Zeilenabstand/Position im Export
  const buckets = new Map<string, number[]>()
  for (const o of offsets) { const k = o.fontPx < 20 ? '<20px' : o.fontPx < 32 ? '20–31px' : o.fontPx < 50 ? '32–49px' : '≥50px'; buckets.set(k, [...(buckets.get(k) ?? []), o.offset]) }
  const med = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1]
  console.log('  Versatz LO−Chromium (Median, CSS-px): ' + [...buckets].map(([k, v]) => `${k}: ${med(v) >= 0 ? '+' : ''}${med(v).toFixed(1)} (n=${v.length})`).join(' · '))
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 1))
  copyFileSync(pptxPath, join(out, `${slug}.pptx`))
  return report
}

function crop(g: Gray, b: Box): Gray {
  const x0 = Math.max(0, Math.round(b.x * K)), y0 = Math.max(0, Math.round(b.y * K))
  const w = Math.min(g.w - x0, Math.round(b.w * K)), h = Math.min(g.h - y0, Math.round(b.h * K)), px = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) px.set(g.px.subarray((y0 + y) * g.w + x0, (y0 + y) * g.w + x0 + w), y * w)
  return { w, h, px }
}

const files = process.argv.slice(2)
if (!files.length) { console.error('Aufruf: verify-pptx <datei.pptx> …'); process.exit(2) }
for (const f of files) await verify(f)
