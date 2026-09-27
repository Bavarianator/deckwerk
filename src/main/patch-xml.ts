// Nachbearbeitung einzelner Shapes in der PptxGenJS-Datei (Muster wie animations.ts): Verläufe, Bild-Radius, Neu-Einfärben.
// Alles bleibt in PowerPoint editierbar (Form formatieren → Verlauf, Bildformat → Farbe).
import JSZip from 'jszip'
import type { Gradient } from '../shared/deck'

export interface ShapePatch { slide: number; name: string; fn: (shapeXml: string) => string } // slide 1-basiert, name = cNvPr-Name

export async function patchShapes(pptx: Buffer, patches: ShapePatch[]): Promise<Buffer> {
  if (!patches.length) return pptx
  const zip = await JSZip.loadAsync(pptx)
  for (const n of new Set(patches.map((p) => p.slide))) {
    const path = `ppt/slides/slide${n}.xml`
    let xml = await zip.file(path)!.async('string')
    for (const p of patches.filter((x) => x.slide === n)) {
      let hit = false
      xml = xml.replace(/<p:(sp|pic)>[\s\S]*?<\/p:\1>/g, (el) => {
        if (hit || el.match(/<p:cNvPr\b[^>]*\bname="([^"]*)"/)?.[1] !== p.name) return el
        hit = true
        return p.fn(el)
      })
      if (!hit) console.warn(`[patch-xml] ${path}: Shape "${p.name}" nicht gefunden`)
    }
    zip.file(path, xml)
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

const hex = (c: string) => c.replace('#', '').toUpperCase()

// CSS-Winkel (0 = nach oben, im Uhrzeigersinn) → OOXML lin ang (0 = nach rechts, im Uhrzeigersinn, 1/60000 Grad)
export const gradFill = (g: Gradient) => (sp: string) => {
  const ang = ((((g.angle - 90) % 360) + 360) % 360) * 60000
  const stops = g.stops.map((s) => `<a:gs pos="${Math.round(s.pos * 100000)}"><a:srgbClr val="${hex(s.color)}"><a:alpha val="${Math.round(s.alpha * 100000)}"/></a:srgbClr></a:gs>`)
  // vorhandene Füllung ersetzen (eine Form darf nur eine haben, sonst repariert PowerPoint die Datei)
  return sp.replace(/<\/a:prstGeom>(?:<a:solidFill>[\s\S]*?<\/a:solidFill>|<a:noFill\/>)?/, `</a:prstGeom><a:gradFill rotWithShape="1"><a:gsLst>${stops.join('')}</a:gsLst><a:lin ang="${ang}" scaled="0"/></a:gradFill>`)
}

// Bild mit abgerundeten Ecken: roundRect, adj = Radius relativ zur kürzeren Seite (100000 = halbe Seite … PowerPoint: adj/100000 · min(w,h))
export const roundRect = (radius: number, w: number, h: number) => (pic: string) =>
  pic.replace(/<a:prstGeom prst="rect">\s*<a:avLst\s*\/>\s*<\/a:prstGeom>/, `<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val ${Math.min(50000, Math.round((radius / Math.min(w, h)) * 100000))}"/></a:avLst></a:prstGeom>`)

// Bildrahmen: Geometrie des Bildes tauschen (Bild bleibt austauschbar, Form unter Bildformat → Zuschneiden → Auf Form zuschneiden)
const MASK_GEOM: Record<string, string> = {
  circle: '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>',
  arch: '<a:prstGeom prst="round2SameRect"><a:avLst><a:gd name="adj1" fmla="val 50000"/><a:gd name="adj2" fmla="val 0"/></a:avLst></a:prstGeom>',
  hexagon: '<a:prstGeom prst="hexagon"><a:avLst/></a:prstGeom>',
  diamond: '<a:prstGeom prst="diamond"><a:avLst/></a:prstGeom>',
  octagon: '<a:prstGeom prst="octagon"><a:avLst/></a:prstGeom>',
  star: '<a:prstGeom prst="star5"><a:avLst/></a:prstGeom>',
  heart: '<a:prstGeom prst="heart"><a:avLst/></a:prstGeom>',
}
export const maskShape = (mask: string) => (pic: string) => pic.replace(/<a:prstGeom prst="[^"]+">[\s\S]*?<\/a:prstGeom>/, MASK_GEOM[mask] ?? '$&')

// Texteffekt auf alle Textläufe der Form. Maße relativ zur Schriftgröße wie in der Vorschau (slide.tsx effectCss); 1 px = 9525 EMU.
export const textEffect = (e: { type: string; color: string }, sizePx: number) => (sp: string) => {
  const emu = (em: number) => Math.round(em * sizePx * 9525)
  const clr = (a: number) => `<a:srgbClr val="${hex(e.color)}"><a:alpha val="${a}"/></a:srgbClr>`
  const fx = {
    shadow: `<a:effectLst><a:outerShdw blurRad="${emu(0.04)}" dist="${emu(0.07)}" dir="2700000" algn="tl" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="45000"/></a:srgbClr></a:outerShdw></a:effectLst>`,
    lift: `<a:effectLst><a:outerShdw blurRad="${emu(0.4)}" dist="${emu(0.08)}" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst>`,
    neon: `<a:effectLst><a:glow rad="${emu(0.25)}">${clr(60000)}</a:glow></a:effectLst>`,
  }[e.type]
  return sp.replace(/(<a:rPr\b[^>]*>)([\s\S]*?)(<\/a:rPr>)/g, (_, open: string, body: string, close: string) => {
    // Reihenfolge im rPr: ln, Füllung, effectLst
    if (e.type === 'hollow') body = body.replace(/<a:solidFill>[\s\S]*?<\/a:solidFill>/, `<a:ln w="${Math.max(9525, emu(0.03))}"><a:solidFill><a:srgbClr val="${hex(e.color)}"/></a:solidFill></a:ln><a:noFill/>`)
    else if (fx) body = body.replace(/(<a:solidFill>[\s\S]*?<\/a:solidFill>|<a:noFill\/>)/, `$1${fx}`)
    return open + body + close
  })
}

// Bildanpassung als Kinder von <a:blip> (Bildformat → Bildkorrekturen); Werte in 1/1000 Prozent, Weichzeichner in EMU
export const adjustBlip = (a: { bright?: number; contrast?: number; sat?: number; blur?: number }) => (pic: string) => {
  const fx = [
    a.blur ? `<a:blur rad="${Math.round((a.blur / 10) * 9525 * 2)}" grow="0"/>` : '',
    a.sat ? `<a:hsl hue="0" sat="${a.sat * 1000}" lum="0"/>` : '',
    a.bright || a.contrast ? `<a:lum bright="${(a.bright ?? 0) * 1000}" contrast="${(a.contrast ?? 0) * 1000}"/>` : '',
  ].join('')
  return fx ? pic.replace(/<a:blip (r:embed="[^"]+")\s*(\/>|>)/, (_, rid: string, end: string) => `<a:blip ${rid}>${fx}${end === '/>' ? '</a:blip>' : ''}`) : pic
}

// Bild neu einfärben: Duotone [dunkel, hell] oder Graustufen
export const recolor = (look: 'duotone' | 'mono', [dark, light]: [string, string]) => (pic: string) =>
  pic.replace(/<a:blip (r:embed="[^"]+")\s*(\/>|>)/, (_, rid: string, end: string) =>
    `<a:blip ${rid}>${look === 'mono' ? '<a:grayscl/>' : `<a:duotone><a:srgbClr val="${hex(dark)}"/><a:srgbClr val="${hex(light)}"/></a:duotone>`}${end === '/>' ? '</a:blip>' : ''}`)
