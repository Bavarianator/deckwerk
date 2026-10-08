// Schriften in eine PPTX einbetten: TTF → EOT (.fntdata, unkomprimiert) + presentation.xml/rels/Content-Types patchen.
// PowerPoint lädt eingebettete Schriften nur, wenn die Familie im Textlauf exakt dem typeface-Namen entspricht.
import JSZip from 'jszip'

export interface EmbedFont { family: string; regular: Buffer; bold?: Buffer; italic?: Buffer; boldItalic?: Buffer; serif?: boolean }

const REL_FONT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font'

function tables(ttf: Buffer): Map<string, Buffer> {
  const n = ttf.readUInt16BE(4), out = new Map<string, Buffer>()
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16, at = ttf.readUInt32BE(o + 8), end = at + ttf.readUInt32BE(o + 12)
    if (end > ttf.length) throw new Error('TTF abgeschnitten') // halb geladene Datei: nicht einbetten
    out.set(ttf.toString('latin1', o, o + 4), ttf.subarray(at, end))
  }
  return out
}

// name-Tabelle: Windows/Unicode (3/1) bevorzugt, sonst Mac Roman (1/0)
function nameOf(name: Buffer, id: number): string {
  const count = name.readUInt16BE(2), base = name.readUInt16BE(4)
  let mac = ''
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12, plat = name.readUInt16BE(r), enc = name.readUInt16BE(r + 2), nid = name.readUInt16BE(r + 6)
    if (nid !== id) continue
    const len = name.readUInt16BE(r + 8), off = base + name.readUInt16BE(r + 10), s = name.subarray(off, off + len)
    if (plat === 3 && (enc === 1 || enc === 10)) return Buffer.from(s).swap16().toString('utf16le') // Kopie: swap16 dreht sonst die Schrift selbst um
    if (plat === 1) mac = s.toString('latin1')
  }
  return mac
}

const utf16 = (s: string) => Buffer.from(s, 'utf16le')

// Hat die Schrift ein Zeichen? cmap Format 12 (volle Unicode-Tabelle) bzw. 4 (BMP), Plattform Unicode oder Windows
function hasGlyph(cmap: Buffer, cp: number): boolean {
  for (let i = 0; i < cmap.readUInt16BE(2); i++) {
    const pid = cmap.readUInt16BE(4 + i * 8), off = cmap.readUInt32BE(8 + i * 8)
    if (pid !== 0 && pid !== 3) continue
    const fmt = cmap.readUInt16BE(off)
    if (fmt === 12) {
      for (let g = 0, n = cmap.readUInt32BE(off + 12); g < n; g++) {
        const at = off + 16 + g * 12
        if (cp >= cmap.readUInt32BE(at) && cp <= cmap.readUInt32BE(at + 4)) return true
      }
    } else if (fmt === 4 && cp <= 0xffff) {
      const seg = cmap.readUInt16BE(off + 6) / 2, ends = off + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2
      for (let k = 0; k < seg; k++) {
        if (cp > cmap.readUInt16BE(ends + k * 2) || cp < cmap.readUInt16BE(starts + k * 2)) continue
        const delta = cmap.readInt16BE(deltas + k * 2), ro = cmap.readUInt16BE(ranges + k * 2)
        const raw = ro === 0 ? cp : cmap.readUInt16BE(ranges + k * 2 + ro + (cp - cmap.readUInt16BE(starts + k * 2)) * 2)
        if (raw !== 0 && ((raw + delta) & 0xffff) !== 0) return true
      }
    }
  }
  return false
}

// Kurzprüfung einer TTF (Schrift-Download, Kuratierung): Namen, Einbettungsrecht, echte Umrisse, fehlende Zeichen aus `chars`
export function inspectTtf(ttf: Buffer, chars = ''): { family: string; style: string; fsType: number; glyf: boolean; missing: string[] } {
  const t = tables(ttf), name = t.get('name'), os2 = t.get('OS/2'), cmap = t.get('cmap')
  if (ttf.readUInt32BE(0) !== 0x00010000 || !name || !cmap) throw new Error('keine TrueType-Schrift')
  return { family: nameOf(name, 1), style: nameOf(name, 2), fsType: os2 ? os2.readUInt16BE(8) : 0, glyf: t.has('glyf'), missing: [...chars].filter((c) => !hasGlyph(cmap, c.codePointAt(0)!)) }
}

// EOT v2.0 (0x00020001) ohne Kompression/XOR, wie ttf2eot. Alle Felder little-endian.
export function ttfToEot(ttf: Buffer): Buffer {
  const t = tables(ttf), os2 = t.get('OS/2'), head = t.get('head'), name = t.get('name')
  if (!os2 || !head || !name) throw new Error('TTF ohne OS/2-, head- oder name-Tabelle')
  const strs = [nameOf(name, 1), nameOf(name, 2), nameOf(name, 5), nameOf(name, 4)].map(utf16)
  const strSize = strs.reduce((n, s) => n + 4 + s.length, 0) + 2 // je: size(2)+bytes+padding(2); RootString: size(2)
  const hdr = Buffer.alloc(82 + strSize)
  let p = 0
  const u32 = (v: number) => { hdr.writeUInt32LE(v >>> 0, p); p += 4 }
  const u16 = (v: number) => { hdr.writeUInt16LE(v, p); p += 2 }
  u32(hdr.length + ttf.length) // EOTSize
  u32(ttf.length) // FontDataSize
  u32(0x00020001) // Version
  u32(0) // Flags
  os2.copy(hdr, p, 32, 42); p += 10 // PANOSE
  hdr[p++] = 1 // Charset DEFAULT_CHARSET
  hdr[p++] = os2.readUInt16BE(62) & 1 ? 1 : 0 // Italic (fsSelection bit 0)
  u32(os2.readUInt16BE(4)) // Weight
  u16(os2.readUInt16BE(8) & ~0x0002) // fsType; „restricted“ ausmaskieren, sonst verweigert PowerPoint die Anzeige
  u16(0x504c) // MagicNumber
  for (let i = 0; i < 4; i++) u32(os2.readUInt32BE(42 + i * 4)) // UnicodeRange1-4
  u32(os2.length >= 86 ? os2.readUInt32BE(78) : 0) // CodePageRange1
  u32(os2.length >= 86 ? os2.readUInt32BE(82) : 0) // CodePageRange2
  u32(head.readUInt32BE(8)) // CheckSumAdjustment
  u32(0); u32(0); u32(0); u32(0) // Reserved1-4
  u16(0) // Padding1
  for (const s of strs) { u16(s.length); s.copy(hdr, p); p += s.length; u16(0) } // Family, Style, Version, FullName (+ Padding)
  u16(0) // RootStringSize
  if (p !== hdr.length) throw new Error(`EOT-Header: ${p} statt ${hdr.length} Bytes`)
  return Buffer.concat([hdr, ttf])
}

export const fontFamilyOf = (ttf: Buffer): string => nameOf(tables(ttf).get('name')!, 1)

export async function embedFonts(pptx: Buffer, fonts: EmbedFont[]): Promise<Buffer> {
  if (!fonts.length) return pptx // Office-Schriften: Datei unverändert lassen
  const zip = await JSZip.loadAsync(pptx)
  const relsPath = 'ppt/_rels/presentation.xml.rels'
  let rels = await zip.file(relsPath)!.async('string')
  let pres = await zip.file('ppt/presentation.xml')!.async('string')
  let types = await zip.file('[Content_Types].xml')!.async('string')
  if (!types.includes('Extension="fntdata"')) types = types.replace('</Types>', '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>')
  let rid = Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => +m[1])), n = 0
  const entries = fonts.flatMap((f) => {
    const faces: [string, Buffer | undefined][] = [['regular', f.regular], ['bold', f.bold], ['italic', f.italic], ['boldItalic', f.boldItalic]]
    // kaputte Schnitte überspringen statt den ganzen Export scheitern zu lassen
    const eots = faces.flatMap(([face, ttf]): [string, Buffer][] => {
      if (!ttf) return []
      try { return [[face, ttfToEot(ttf)]] } catch (e) { console.warn(`[export] ${f.family} ${face} nicht einbettbar:`, (e as Error).message); return [] }
    })
    if (!eots.length) return []
    const refs = eots.map(([face, eot]) => {
      const file = `fonts/font${++n}.fntdata`, id = `rId${++rid}`
      zip.file(`ppt/${file}`, eot)
      rels = rels.replace('</Relationships>', `<Relationship Id="${id}" Type="${REL_FONT}" Target="${file}"/></Relationships>`)
      return `<p:${face} r:id="${id}"/>`
    })
    return [`<p:embeddedFont><p:font typeface="${f.family.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}" pitchFamily="${f.serif ? 18 : 34}" charset="0"/>${refs.join('')}</p:embeddedFont>`]
  })
  if (!entries.length) return pptx
  const lst = `<p:embeddedFontLst>${entries.join('')}</p:embeddedFontLst>`
  // Schema-Reihenfolge: … notesSz, smartTags, embeddedFontLst, custShowLst, …, defaultTextStyle
  pres = pres.includes('<p:embeddedFontLst>')
    ? pres.replace('<p:embeddedFontLst>', `<p:embeddedFontLst>${entries.join('')}`)
    : pres.replace(/(<p:notesSz[^>]*\/>)/, `$1${lst}`)
  if (!/embedTrueTypeFonts=/.test(pres)) pres = pres.replace('<p:presentation ', '<p:presentation embedTrueTypeFonts="1" ')
  zip.file(relsPath, rels)
  zip.file('ppt/presentation.xml', pres)
  zip.file('[Content_Types].xml', types)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
