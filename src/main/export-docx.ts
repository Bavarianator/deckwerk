// Word-Export: jede Folie = eine Seite in Foliengröße. Hintergrund-PNG (ohne Text) hinter dem Text, jedes gemessene
// Textelement ein bearbeitbares Textfeld an seiner Position. WordprocessingML von Hand, Theme-Schriften eingebettet.
import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'
import type { EmbedFont } from './embed-fonts'
import { sizeOf, type Deck, type Measured, type Run, type TextEl } from '../shared/deck'
import { resolveTheme } from '../shared/themes'

export interface DocxPage { measured: Measured; background: Buffer } // background = PNG der ganzen Seite

const EMU = (px: number) => Math.round(px * 9525)
const TW = (px: number) => Math.round(px * 15) // Twips; auch Zwanzigstel-Punkt (px * 0.75 * 20)
const hex = (c: string) => c.replace('#', '').toUpperCase() // measure.ts liefert immer #RRGGBB
// Steuerzeichen sind in XML 1.0 verboten (Word meldet sonst ein beschädigtes Dokument)
const esc = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
// wie WRAP_SLACK in export-pptx.ts: etwas breiter, damit Word nicht früher umbricht als Chromium
const WRAP_SLACK = 0.015

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${R}"`
const DOC_NS = `${NS} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"`
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const rels = (list: string[]) => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.join('')}</Relationships>`

// ECMA-376 Teil 1 §17.8.1: Schlüssel = GUID-Bytes in umgekehrter Reihenfolge, nur die ersten 32 Bytes XOR (symmetrisch)
function obfuscate(ttf: Buffer, fontKey: string): Buffer {
  const key = Buffer.from(fontKey.replace(/[{}-]/g, ''), 'hex').reverse()
  const out = Buffer.from(ttf)
  for (let i = 0; i < 32; i++) out[i] ^= key[i % 16]
  return out
}

// Anker an der Seite (nicht am Absatz), ohne Textumfluss
const anchor = (id: number, behind: boolean, x: number, y: number, w: number, h: number, name: string, graphic: string) =>
  `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="${behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1">` +
  `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${EMU(x)}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${EMU(y)}</wp:posOffset></wp:positionV>` +
  `<wp:extent cx="${EMU(w)}" cy="${EMU(h)}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="${esc(name)}"/>${graphic}</wp:anchor></w:drawing></w:r>`

export async function buildDocx(deck: Deck, pages: DocxPage[], fonts: EmbedFont[] = []): Promise<Buffer> {
  const t = resolveTheme(deck.theme)
  const { w: W, h: H } = sizeOf(deck)
  const zip = new JSZip()
  const docRels = [
    `<Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rId2" Type="${R}/settings" Target="settings.xml"/>`,
    `<Relationship Id="rId3" Type="${R}/fontTable" Target="fontTable.xml"/>`,
  ]
  const rel = (type: string, target: string, external = false) => {
    const id = `rId${docRels.length + 1}`
    docRels.push(`<Relationship Id="${id}" Type="${R}/${type}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ''}/>`)
    return id
  }
  const used = new Set([t.body.pptx])
  let n = 0 // docPr-ID und Ebene (relativeHeight), dokumentweit aufsteigend

  const run = (r: Run, el: TextEl, f: string) => {
    const sz = Math.round((r.sizePx ?? el.sizePx) * 1.5), track = TW(r.trackingPx ?? el.trackingPx)
    const hollow = el.effect?.type === 'hollow' // Kontur: gemessene Farbe ist transparent → Words Umriss-Effekt in der Konturfarbe
    const rPr = `<w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>${r.bold ? '<w:b/><w:bCs/>' : ''}${r.italic ? '<w:i/><w:iCs/>' : ''}${el.upper ? '<w:caps/>' : ''}${hollow ? '<w:outline/>' : ''}` +
      `<w:color w:val="${hex(hollow ? el.effect!.color : r.color)}"/>${track ? `<w:spacing w:val="${track}"/>` : ''}<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>${r.underline ? '<w:u w:val="single"/>' : ''}<w:lang w:val="de-DE"/></w:rPr>`
    const xml = `<w:r>${rPr}<w:t xml:space="preserve">${esc(r.text)}</w:t>${r.breakAfter ? '<w:br/>' : ''}</w:r>`
    return r.link ? `<w:hyperlink r:id="${rel('hyperlink', r.link, true)}">${xml}</w:hyperlink>` : xml
  }

  const textBox = (el: TextEl) => {
    const rot = Math.round(((((el.rot ?? 0) % 360) + 360) % 360) * 60000) // 0…360° wie Word selbst
    const family = el.fontFace ?? (el.font === 'head' ? t.head.pptx : t.body.pptx), f = esc(family)
    used.add(family)
    const b = el.box, extra = b.w * WRAP_SLACK
    const x = el.align === 'center' ? b.x - extra / 2 : el.align === 'right' ? b.x - extra : b.x, w = b.w + extra
    const p = `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${TW(el.lineHeightPx)}" w:lineRule="exact"/><w:jc w:val="${el.align}"/><w:rPr><w:lang w:val="de-DE"/></w:rPr></w:pPr>${el.runs.map((r) => run(r, el, f)).join('')}</w:p>`
    return anchor(++n, false, x, b.y, w, b.h, el.slot,
      `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/>` +
      `<wps:spPr><a:xfrm rot="${rot}"><a:off x="0" y="0"/><a:ext cx="${EMU(w)}" cy="${EMU(b.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>` +
      `<wps:txbx><w:txbxContent>${p}</w:txbxContent></wps:txbx>` +
      // einzeilig (Fußzeile, Aktionszeile): nie umbrechen, Word misst minimal anders als Chromium; mehrzeilig wächst das Feld mit dem Text (spAutoFit)
      `<wps:bodyPr rot="0" vert="horz" wrap="${el.lines <= 1 ? 'none' : 'square'}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0">${el.lines <= 1 ? '<a:noAutofit/>' : '<a:spAutoFit/>'}</wps:bodyPr></wps:wsp></a:graphicData></a:graphic>`)
  }

  // Pro Folie ein winziger Absatz (1 pt) mit allen Ankern, so entstehen keine leeren Zusatzseiten
  const body = pages.map(({ measured, background }, i) => {
    const file = `bg${i + 1}.png`
    zip.file(`word/media/${file}`, background)
    const bg = anchor(++n, true, 0, 0, W, H, file,
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${file}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rel('image', `media/${file}`)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${EMU(W)}" cy="${EMU(H)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`)
    // Formen, Bilder, Icons, Diagramme stecken im Hintergrundbild
    const texts = measured.els.flatMap((el) => (el.kind === 'text' && el.runs.some((r) => r.text) ? [textBox(el)] : []))
    return `<w:p><w:pPr>${i ? '<w:pageBreakBefore/>' : ''}<w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:pPr>${bg}${texts.join('')}</w:p>`
  })
  const sect = `<w:sectPr><w:pgSz w:w="${TW(W)}" w:h="${TW(H)}"${W > H ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`

  // Schriften: verwendete Familien in die Schrifttabelle, mitgelieferte TTF verschleiert einbetten
  const fontRels: string[] = []
  const embedded = fonts.filter((f) => used.has(f.family))
  const fontXml = [...used].map((family) => {
    const ef = embedded.find((f) => f.family === family)
    const faces = ef ? ([['Regular', ef.regular], ['Bold', ef.bold], ['Italic', ef.italic], ['BoldItalic', ef.boldItalic]] as const) : []
    const embeds = faces.filter(([, ttf]) => ttf).map(([face, ttf]) => {
      const k = fontRels.length + 1, key = `{${randomUUID().toUpperCase()}}`
      zip.file(`word/fonts/font${k}.odttf`, obfuscate(ttf!, key))
      fontRels.push(`<Relationship Id="rId${k}" Type="${R}/font" Target="fonts/font${k}.odttf"/>`)
      return `<w:embed${face} r:id="rId${k}" w:fontKey="${key}"/>`
    })
    return `<w:font w:name="${esc(family)}">${embeds.join('')}</w:font>`
  })

  const ct = 'application/vnd.openxmlformats-officedocument.wordprocessingml'
  const part = (name: string, type: string) => `<Override PartName="/word/${name}.xml" ContentType="${ct}.${type}+xml"/>`
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>` +
    `${part('document', 'document.main')}${part('styles', 'styles')}${part('settings', 'settings')}${part('fontTable', 'fontTable')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`)
  zip.file('_rels/.rels', rels([`<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>`, '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>']))
  zip.file('docProps/core.xml', `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${esc(deck.title)}</dc:title><dc:creator>Deckwerk</dc:creator></cp:coreProperties>`)
  zip.file('word/document.xml', `${XML}<w:document ${DOC_NS}><w:body>${body.join('')}${sect}</w:body></w:document>`)
  zip.file('word/_rels/document.xml.rels', rels(docRels))
  const bf = esc(t.body.pptx)
  zip.file('word/styles.xml', `${XML}<w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${bf}" w:hAnsi="${bf}" w:cs="${bf}" w:eastAsia="${bf}"/><w:lang w:val="de-DE"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`)
  zip.file('word/settings.xml', `${XML}<w:settings ${NS}>${fontRels.length ? '<w:embedTrueTypeFonts/>' : ''}<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`)
  zip.file('word/fontTable.xml', `${XML}<w:fonts ${NS}>${fontXml.join('')}</w:fonts>`)
  if (fontRels.length) zip.file('word/_rels/fontTable.xml.rels', rels(fontRels))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
