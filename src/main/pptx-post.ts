// OOXML-Nachbearbeitung für das, was PptxGenJS nicht kann (Muster wie animations.ts):
// Diagramme (unsichtbare Wasserfall-Basis, Vorzeichen-Formate, lesbare Werte in Stapeln, Seriennamen am Linienende)
// und Abschnitte der Foliensortierung aus den Kapiteltrennern.
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import type { Deck } from '../shared/deck'
import { WF, readableOn } from '../shared/charts'

export async function postProcess(pptx: Buffer, deck?: Deck): Promise<Buffer> {
  const zip = await JSZip.loadAsync(pptx)
  const patch = async (path: string, fn: (xml: string) => string) => {
    const xml = await zip.file(path)!.async('string')
    const out = fn(xml)
    if (out !== xml) zip.file(path, out)
  }
  for (const path of Object.keys(zip.files).filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f))) await patch(path, patchChart)
  if (deck) {
    await patch('ppt/presentation.xml', (xml) => addSections(xml, deck))
    for (const [i, links] of agendaLinks(deck)) {
      const rels = `ppt/slides/_rels/slide${i + 1}.xml.rels`
      if (!zip.file(rels)) continue
      let next = Math.max(0, ...[...(await zip.file(rels)!.async('string')).matchAll(/Id="rId(\d+)"/g)].map((m) => +m[1])) + 1
      const ids = links.map(() => `rId${next++}`)
      await patch(rels, (xml) => xml.replace('</Relationships>',
        links.map(([, to], k) => `<Relationship Id="${ids[k]}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slide${to + 1}.xml"/>`).join('') + '</Relationships>'))
      await patch(`ppt/slides/slide${i + 1}.xml`, (xml) => links.reduce((x, [item], k) =>
        x.replace(new RegExp(`(<p:cNvPr id="\\d+" name="dw:items\\.${item}\\.title">)`), `$1<a:hlinkClick r:id="${ids[k]}" action="ppaction://hlinksldjump"/>`), xml))
    }
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// Agenda anklickbar: Punkt → Kapiteltrenner mit einem gemeinsamen Wort (≥ 4 Buchstaben) im Titel, z. B.
// „Lösung und Produkt“ → „Die Lösung“. Ohne eindeutigen Treffer bleibt der Punkt ohne Link.
export function agendaLinks(deck: Deck): [number, [number, number][]][] {
  const words = (s: string) => new Set((s.toLowerCase().match(/\p{L}{4,}/gu) ?? []))
  const out: [number, [number, number][]][] = []
  deck.slides.forEach((s, i) => {
    if (s.layout !== 'agenda') return
    const links: [number, number][] = []
    ;(s.content?.items ?? []).forEach((it: { title?: string }, k: number) => {
      const w = words(it.title ?? '')
      const to = deck.slides.findIndex((x, j) => j !== i && x.layout === 'section' && [...words(x.content?.title ?? '')].some((y) => w.has(y)))
      if (to >= 0) links.push([k, to])
    })
    if (links.length) out.push([i, links])
  })
  return out
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Abschnitte in PowerPoints Foliensortierung: jeder Kapiteltrenner beginnt einen, Folien davor heißen „Einstieg“.
// Gleiches XML wie PptxGenJS' addSection (p14:sectionLst im extLst von presentation.xml).
export function addSections(xml: string, deck: Deck): string {
  if (xml.includes('<p:extLst>') || !deck.slides.some((s) => s.layout === 'section')) return xml
  const ids = [...xml.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => m[1])
  const secs: { name: string; ids: string[] }[] = []
  deck.slides.forEach((s, i) => {
    if (s.layout === 'section' || !secs.length)
      secs.push({ name: s.layout === 'section' ? [s.content?.number, s.content?.title].filter(Boolean).join(' ') : 'Einstieg', ids: [] })
    if (ids[i]) secs[secs.length - 1].ids.push(ids[i])
  })
  const lst = secs.map((sec) =>
    `<p14:section name="${esc(sec.name)}" id="{${randomUUID().toUpperCase()}}"><p14:sldIdLst>${sec.ids.map((id) => `<p14:sldId id="${id}"/>`).join('')}</p14:sldIdLst></p14:section>`).join('')
  return xml.replace('</p:presentation>',
    `<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">${lst}</p14:sectionLst></p:ext></p:extLst></p:presentation>`)
}

const q = (s: string) => s.replace(/"/g, '&quot;')
const setDLbls = (ser: string, dLbls: string) => ser.replace(/<c:dLbls>[\s\S]*?<\/c:dLbls>/, dLbls)
const setLabelColor = (ser: string, color: string) =>
  ser.replace(/(<c:dLbls>[\s\S]*?<a:defRPr[^>]*>)<a:solidFill><a:srgbClr val="[0-9A-Fa-f]{6}"\/><\/a:solidFill>/, `$1<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`)

export function patchChart(xml: string): string {
  const stacked = /<c:grouping val="(percentS|s)tacked"\/>/.test(xml)
  const lines = xml.includes('<c:lineChart>') ? (xml.match(/<c:ser>/g) ?? []).length : 0
  return xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
    const name = ser.match(/<c:tx>[\s\S]*?<c:v>([^<]*)<\/c:v>/)?.[1]
    const fill = ser.match(/<c:spPr><a:solidFill><a:srgbClr val="([0-9A-Fa-f]{6})"/)?.[1]
    const vals = [...(ser.match(/<c:val>[\s\S]*?<\/c:val>/)?.[0] ?? '').matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((m) => Number(m[1]))
    const num = vals.some((v) => !Number.isInteger(v)) ? '#,##0.0' : '#,##0'

    if (name === WF.base) // unsichtbarer Sockel, keine Beschriftung
      return setDLbls(ser.replace(/<c:spPr>[\s\S]*?<\/c:spPr>/, '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>'), '<c:dLbls><c:delete val="1"/></c:dLbls>')
    const wf = name === WF.up ? `+${num};;;` : name === WF.down ? `"−"${num};;;` : name === WF.total ? `${num};;;` : undefined
    if (wf) ser = ser.replace(/<c:numFmt formatCode="[^"]*"/, `<c:numFmt formatCode="${q(wf)}"`)
    if (stacked && fill) ser = setLabelColor(ser, readableOn(fill).slice(1))

    // Linien mit mehreren Serien: Name am letzten Punkt statt Legende (direkte Beschriftung)
    if (lines > 1 && vals.length && fill) {
      const font = ser.match(/<a:latin typeface="([^"]*)"/)?.[1] ?? 'Calibri'
      const flags = (serName: 0 | 1) =>
        `<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="${serName}"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>`
      ser = setDLbls(ser,
        `<c:dLbls><c:dLbl><c:idx val="${vals.length - 1}"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>` +
        `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1100" b="1"><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:latin typeface="${q(font)}"/></a:defRPr></a:pPr><a:endParaRPr lang="de-DE"/></a:p></c:txPr>` +
        `<c:dLblPos val="r"/>${flags(1)}</c:dLbl>${flags(0)}</c:dLbls>`)
    }
    return ser
  })
}
