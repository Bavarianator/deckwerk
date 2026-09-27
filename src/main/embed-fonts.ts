// Schriften in eine PPTX einbetten: TTF → EOT (.fntdata, unkomprimiert) + presentation.xml/rels/Content-Types patchen.
// PowerPoint lädt eingebettete Schriften nur, wenn die Familie im Textlauf exakt dem typeface-Namen entspricht.
import JSZip from 'jszip'

export interface EmbedFont { family: string; regular: Buffer; bold?: Buffer; italic?: Buffer; boldItalic?: Buffer; serif?: boolean }

const REL_FONT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font'

function tables(ttf: Buffer): Map<string, Buffer> {
  const n = ttf.readUInt16BE(4), out = new Map<string, Buffer>()
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16
    out.set(ttf.toString('latin1', o, o + 4), ttf.subarray(ttf.readUInt32BE(o + 8), ttf.readUInt32BE(o + 8) + ttf.readUInt32BE(o + 12)))
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
    if (plat === 3 && (enc === 1 || enc === 10)) return s.swap16().toString('utf16le')
    if (plat === 1) mac = s.toString('latin1')
  }
  return mac
}

const utf16 = (s: string) => Buffer.from(s, 'utf16le')

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
  const entries = fonts.map((f) => {
    const faces: [string, Buffer | undefined][] = [['regular', f.regular], ['bold', f.bold], ['italic', f.italic], ['boldItalic', f.boldItalic]]
    const refs = faces.filter((x): x is [string, Buffer] => !!x[1]).map(([face, ttf]) => {
      const file = `fonts/font${++n}.fntdata`, id = `rId${++rid}`
      zip.file(`ppt/${file}`, ttfToEot(ttf))
      rels = rels.replace('</Relationships>', `<Relationship Id="${id}" Type="${REL_FONT}" Target="${file}"/></Relationships>`)
      return `<p:${face} r:id="${id}"/>`
    })
    return `<p:embeddedFont><p:font typeface="${f.family}" pitchFamily="${f.serif ? 18 : 34}" charset="0"/>${refs.join('')}</p:embeddedFont>`
  })
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
