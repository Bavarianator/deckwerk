// TrimBox/BleedBox fürs Druck-PDF, als inkrementelles Update: Die Originalbytes bleiben unverändert, dahinter folgen die
// Seitenobjekte (gleiche Nummer) mit den Boxen, eine neue xref-Sektion und ein trailer mit /Prev. Electron-frei,
// Selbsttest scripts/check-pdf-boxes.ts. Bei Beschnitt 0 wird TrimBox = MediaBox gesetzt (gleicher Weg, kein Sonderfall).
// ponytail: klassische xref von Skia; schreibt Chromium einmal xref-Streams, dann pdf-lib
export function setPrintBoxes(pdf: Buffer, bleedPt: number): Buffer {
  const s = pdf.toString('latin1')
  const keep = (why: string) => (console.warn(`[druck] TrimBox/BleedBox nicht gesetzt: ${why}`), pdf)
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)
  if (!sx) return keep('kein startxref am Dateiende')
  const prev = Number(sx[1])
  if (!s.startsWith('xref', prev)) return keep('keine klassische xref-Tabelle (xref-Stream?)')
  const trailer = /trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(s.slice(prev))?.[1] ?? ''
  const [size, root, info] = ['Size', 'Root', 'Info'].map((k) => new RegExp(`/${k}\\s+(\\d+(?:\\s+\\d+\\s+R)?)`).exec(trailer)?.[1])
  if (!size || !root) return keep('trailer ohne /Size oder /Root')
  const fmt = (n: number) => String(+n.toFixed(4))
  let add = s.endsWith('\n') ? '' : '\n'
  let xref = ''
  for (const m of s.matchAll(/(\d+) (\d+) obj\s*(<<\s*\/Type\s*\/Page(?!\w)[\s\S]*?>>)\s*endobj/g)) {
    const box = /\/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*\]/.exec(m[3])
    if (!box) return keep(`Seite ${m[1]} ohne MediaBox`)
    const [x0, y0, x1, y1] = box.slice(1).map(Number)
    xref += `${m[1]} 1\n${String(pdf.length + add.length).padStart(10, '0')} ${m[2].padStart(5, '0')} n \n`
    add += `${m[1]} ${m[2]} obj\n${m[3].slice(0, -2)}\n/TrimBox [${[x0 + bleedPt, y0 + bleedPt, x1 - bleedPt, y1 - bleedPt].map(fmt).join(' ')}]\n/BleedBox [${box.slice(1).join(' ')}]>>\nendobj\n`
  }
  if (!xref) return keep('keine Seitenobjekte gefunden')
  const at = pdf.length + add.length
  add += `xref\n${xref}trailer\n<</Size ${size}\n/Root ${root}${info ? `\n/Info ${info}` : ''}\n/Prev ${prev}>>\nstartxref\n${at}\n%%EOF\n`
  return Buffer.concat([pdf, Buffer.from(add, 'latin1')])
}
