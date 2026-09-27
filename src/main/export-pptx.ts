import PptxGenJS from 'pptxgenjs'
import { nativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { embedFonts, type EmbedFont } from './embed-fonts'
import { MEDIA_EXT, sizeOf, type BoxEl, type BuildPreset, type ChartEl, type Deck, type El, type ImgEl, type Measured } from '../shared/deck'
import { LAYOUTS, buildOf } from '../shared/layouts'
import { FONTS, duotoneOf, resolveTheme, withTone, type FontName, type FontRef, type Theme } from '../shared/themes'
import { injectAnimations, type AnimStep, type SlideAnim } from './animations'
import { adjustBlip, gradFill, maskShape, patchShapes, recolor, roundRect, textEffect, type ShapePatch } from './patch-xml'
import { postProcess } from './pptx-post'
import { WF, chartColors, decimals, valueLabels, waterfall } from '../shared/charts'

const IN = (px: number) => px / 96
const PT = (px: number) => px * 0.75
const hex = (c: string) => c.replace('#', '').toUpperCase()
// ponytail: fixed width slack so PowerPoint never wraps earlier than Chromium. Metric twins make real differences
// sub-pixel (LibreOffice check: Arial/Calibri identical); more slack makes lines join and the look drift.
// Final calibration needs real PowerPoint (Windows/Mac).
const WRAP_SLACK = 0.015

export interface ExportSlide { measured: Measured; background: Buffer }

export function assetPath(src: string): string | undefined {
  const p = src.startsWith('asset://') ? decodeURIComponent(new URL(src).pathname) : src.startsWith('file://') ? fileURLToPath(src) : undefined
  return p && MEDIA_EXT.test(p) ? p : undefined
}

// Contained image rect inside its box, honoring the CSS background-position the layout used.
function containRect(el: ImgEl, path: string) {
  const { width, height } = nativeImage.createFromPath(path).getSize()
  const b = el.box
  if (!width || !height) return b
  const k = Math.min(b.w / width, b.h / height)
  const w = width * k, h = height * k
  return { x: b.x + (b.w - w) * el.focus.x, y: b.y + (b.h - h) * el.focus.y, w, h }
}

// Natives, editierbares Diagramm mit derselben Logik wie die Vorschau (shared/charts.ts). Was PptxGenJS nicht kann
// (unsichtbare Wasserfall-Basis, Vorzeichen, Namen am Linienende), erledigt pptx-post.ts nach dem Schreiben.
function addChart(pptx: PptxGenJS, slide: PptxGenJS.Slide, el: ChartEl, t: Theme, name: string) {
  const s = el.spec
  const pos = { x: IN(el.box.x), y: IN(el.box.y), w: IN(el.box.w), h: IN(el.box.h) }
  const font = { fontFace: t.body.pptx, size: 11 }
  const { perSeries, perPoint } = chartColors(s, t)
  if (s.type === 'donut') {
    slide.addChart(pptx.ChartType.doughnut, [{ name: s.series[0]?.name ?? '', labels: s.categories, values: s.series[0]?.values ?? [] }], {
      ...pos, objectName: name, chartColors: (perPoint ?? t.c.chart).map(hex), holeSize: 62, showLegend: true, legendPos: 'r',
      legendFontFace: font.fontFace, legendFontSize: font.size, legendColor: hex(t.c.text),
      showPercent: false, showValue: false, dataBorder: { pt: 2, color: hex(t.c.bg) },
    })
    return
  }
  const line = s.type === 'line', labels = valueLabels(s)
  const wf = s.type === 'waterfall' ? waterfall(s.series[0]?.values ?? []) : undefined
  const stacked = s.type === 'stacked' || !!wf
  const data = wf
    ? [WF.base, WF.up, WF.down, WF.total].map((n, k) => ({ name: n, labels: s.categories, values: [wf.base, wf.up, wf.down, wf.total][k] }))
    : s.series.map((x) => ({ name: x.name, labels: s.categories, values: x.values }))
  const colors = wf ? [t.c.bg, t.c.good, t.c.bad, t.c.chart[0]] : perPoint ?? perSeries
  slide.addChart(line ? pptx.ChartType.line : pptx.ChartType.bar, data, {
    ...pos, objectName: name, chartColors: colors.map(hex),
    barDir: s.type === 'hbar' ? 'bar' : 'col', barGrouping: stacked ? 'stacked' : 'clustered', barGapWidthPct: 60,
    catAxisOrientation: (s.type === 'hbar' ? 'maxMin' : 'minMax') as 'minMax', // Typen zu eng, PptxGenJS schreibt den Wert durch (Ranking von oben nach unten)
    lineSize: 2.25, lineDataSymbol: 'circle', lineDataSymbolSize: 6, lineSmooth: false,
    catAxisLabelColor: hex(t.c.muted), valAxisLabelColor: hex(t.c.muted),
    catAxisLabelFontFace: font.fontFace, valAxisLabelFontFace: font.fontFace, catAxisLabelFontSize: font.size, valAxisLabelFontSize: font.size,
    catAxisLineShow: true, catAxisLineColor: hex(t.c.border), valAxisLineShow: false,
    valAxisHidden: labels, valGridLine: labels ? { style: 'none' } : { color: hex(t.c.border), size: 0.75 }, catGridLine: { style: 'none' },
    showValue: labels, dataLabelPosition: stacked ? 'ctr' : 'outEnd', dataLabelFormatCode: decimals(s) ? '#,##0.0' : '#,##0',
    dataLabelColor: hex(t.c.text), dataLabelFontFace: font.fontFace, dataLabelFontSize: font.size, dataLabelFontBold: true,
    showLegend: !line && !wf && s.series.length > 1, legendPos: 't', legendFontFace: font.fontFace, legendFontSize: font.size, legendColor: hex(t.c.text),
    // Platz rechts für die Seriennamen am Linienende (pptx-post.ts)
    layout: line && s.series.length > 1 ? { x: 0.07, y: 0.05, w: 0.74, h: 0.82 } : undefined,
  })
}

const SHAPE_TYPE = {
  triangle: 'triangle', diamond: 'diamond', hexagon: 'hexagon', star: 'star5', arrow: 'rightArrow', chevron: 'chevron', pentagon: 'homePlate',
  trapezoid: 'trapezoid', parallelogram: 'parallelogram', rtTriangle: 'rtTriangle', octagon: 'octagon', donut: 'donut', plus: 'plus', heart: 'heart',
  star4: 'star4', star6: 'star6', star8: 'star8', star12: 'star12',
} as const satisfies Record<Exclude<NonNullable<BoxEl['shape']>, 'line'>, keyof typeof PptxGenJS.ShapeType>
const ARROW = { none: 'none', arrow: 'arrow', triangle: 'triangle', dot: 'oval' } as const
const DASH = { solid: 'solid', dash: 'dash', dot: 'sysDot' } as const
// Umriss inkl. Strichart und (bei Linien) Pfeilspitzen
const lineOf = (el: BoxEl): PptxGenJS.ShapeLineProps =>
  el.border
    ? { color: hex(el.border.color), width: PT(el.border.width), dashType: el.dash ? DASH[el.dash] : undefined, beginArrowType: el.lineStart ? ARROW[el.lineStart] : undefined, endArrowType: el.lineEnd ? ARROW[el.lineEnd] : undefined }
    : { type: 'none' }

function addEl(pptx: PptxGenJS, slide: PptxGenJS.Slide, el: El, t: Theme, name: string) {
  const b = el.box
  switch (el.kind) {
    case 'text': {
      const extra = b.w * WRAP_SLACK
      const x = el.align === 'center' ? b.x - extra / 2 : el.align === 'right' ? b.x - extra : b.x
      slide.addText(
        el.runs.map((r) => ({ text: el.upper ? r.text.toUpperCase() : r.text, options: { bold: r.bold, italic: r.italic, underline: r.underline ? { style: 'sng' as const } : undefined, color: hex(r.color), breakLine: r.breakAfter, hyperlink: r.link ? { url: r.link } : undefined } })),
        {
          x: IN(x), y: IN(b.y), w: IN(b.w + extra), h: IN(b.h), objectName: name, rotate: el.rot,
          fontFace: el.fontFace ?? (el.font === 'head' ? t.head.pptx : t.body.pptx), fontSize: PT(el.sizePx),
          lineSpacing: PT(el.lineHeightPx), charSpacing: el.trackingPx ? PT(el.trackingPx) : undefined,
          align: el.align, valign: 'top', margin: 0, fit: 'none', wrap: true, paraSpaceBefore: 0, paraSpaceAfter: 0, lang: 'de-DE',
        },
      )
      break
    }
    case 'box':
      if (el.shape === 'line') {
        slide.addShape(pptx.ShapeType.line, { x: IN(b.x), y: IN(b.y + b.h / 2), w: IN(b.w), h: 0, objectName: name, rotate: el.rot, line: lineOf(el) })
        break
      }
      slide.addShape(el.shape ? pptx.ShapeType[SHAPE_TYPE[el.shape]] : el.ellipse ? pptx.ShapeType.ellipse : el.radius > 0.5 ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
        x: IN(b.x), y: IN(b.y), w: IN(b.w), h: IN(b.h), objectName: name, rotate: el.rot,
        fill: el.fill ? { color: hex(el.fill.color), transparency: Math.round((1 - el.fill.alpha) * 100) } : { type: 'none' },
        line: lineOf(el),
        rectRadius: IN(Math.min(el.radius, b.w / 2, b.h / 2)),
        shadow: el.shadow ? { type: 'outer', color: hex(el.shadow.color), opacity: el.shadow.alpha, blur: PT(el.shadow.blur), offset: PT(el.shadow.offsetY), angle: 90 } : undefined,
      })
      break
    case 'img': {
      const path = assetPath(el.src)
      if (!path && !el.src.startsWith('data:')) break
      if (el.fit === 'contain' && path) {
        const r = containRect(el, path)
        slide.addImage({ path, x: IN(r.x), y: IN(r.y), w: IN(r.w), h: IN(r.h), objectName: name, rotate: el.rot, flipH: el.flip })
      } else {
        // Cover: auf volle Bildgröße skalieren und per srcRect nach focus zuschneiden (nicht strecken). Ersetzbar über „Bild ändern“.
        const { width: iw, height: ih } = path ? nativeImage.createFromPath(path).getSize() : { width: 0, height: 0 }
        const k = iw && ih ? Math.max(b.w / iw, b.h / ih) : 0
        const src = path ? { path } : { data: el.src.slice(5) }
        const extra = { rotate: el.rot, flipH: el.flip, rounding: el.round, transparency: el.alpha !== undefined ? Math.round((1 - el.alpha) * 100) : undefined, objectName: name }
        if (el.crop && iw) { // freier Zuschnitt: volles Bild so groß, dass der Ausschnitt die Box füllt
          const W = b.w / el.crop.w, H = b.h / el.crop.h
          slide.addImage({ ...src, ...extra, x: IN(b.x), y: IN(b.y), w: IN(W), h: IN(H), sizing: { type: 'crop', x: IN(el.crop.x * W), y: IN(el.crop.y * H), w: IN(b.w), h: IN(b.h) } })
        } else if (k) {
          const W = iw * k, H = ih * k
          slide.addImage({ ...src, ...extra, x: IN(b.x), y: IN(b.y), w: IN(W), h: IN(H), sizing: { type: 'crop', x: IN((W - b.w) * el.focus.x), y: IN((H - b.h) * el.focus.y), w: IN(b.w), h: IN(b.h) } })
        } else slide.addImage({ ...src, ...extra, x: IN(b.x), y: IN(b.y), w: IN(b.w), h: IN(b.h) })
      }
      break
    }
    case 'media': {
      // eingebettetes Video/Audio; Vorschaubild = Poster (sonst PowerPoints Play-Symbol)
      const path = assetPath(el.src), poster = el.poster && assetPath(el.poster)
      if (!path || !existsSync(path)) break
      const cover = poster && existsSync(poster) ? `data:image/${poster.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(poster).toString('base64')}` : undefined
      slide.addMedia({ type: el.media, path, cover, x: IN(b.x), y: IN(b.y), w: IN(b.w), h: IN(b.h), objectName: name })
      break
    }
    case 'icon':
      if (el.png) slide.addImage({ data: el.png.slice(5), x: IN(b.x), y: IN(b.y), w: IN(b.w), h: IN(b.h), objectName: name, rotate: el.rot })
      break
    case 'chart':
      addChart(pptx, slide, el, t, name)
      break
  }
}

// Build preset + build groups (data-build on the elements) → animation steps for the injector.
function stepsFor(preset: BuildPreset, groups: Map<number, string[]>, mode: Deck['mode']): AnimStep[] {
  const order = [...groups.keys()].sort((a, b) => a - b)
  const steps: AnimStep[] = []
  const group = (g: number, first: Omit<AnimStep, 'shape'>, rest: Omit<AnimStep, 'shape'> = { ...first, trigger: 'with' }) =>
    groups.get(g)!.forEach((shape, j) => steps.push({ shape, ...(j ? rest : first) }))
  switch (preset) {
    case 'fade':
      order.forEach((g, i) => group(g, { effect: 'fade', trigger: i ? 'with' : 'after', durMs: 600 }))
      break
    case 'list':
      order.forEach((g) => group(g, { effect: 'float', trigger: mode === 'click' ? 'click' : 'after', durMs: 450 }))
      break
    case 'stagger':
    case 'zoom-kpi':
      order.forEach((g, i) => {
        const fx = { effect: preset === 'stagger' ? ('float' as const) : ('zoom' as const), durMs: 450, delayMs: i * 150 }
        group(g, { ...fx, trigger: i ? 'with' : 'after', delayMs: i ? i * 150 : 0 }, { ...fx, trigger: 'with' })
      })
      break
    case 'wipe':
      order.forEach((g) => group(g, { effect: 'wipe', trigger: 'after', durMs: 500 }))
      break
  }
  return steps
}

export async function buildPptx(deck: Deck, slides: ExportSlide[]): Promise<Buffer> {
  const t = resolveTheme(deck.theme)
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'DECKWERK', width: sizeOf(deck).w / 96, height: sizeOf(deck).h / 96 })
  pptx.layout = 'DECKWERK'
  pptx.title = deck.title
  pptx.author = 'Deckwerk'
  pptx.theme = { headFontFace: t.head.pptx, bodyFontFace: t.body.pptx }

  const anims: SlideAnim[] = []
  const patches: ShapePatch[] = []
  deck.slides.forEach((s, i) => {
    const { measured, background } = slides[i]
    const slide = pptx.addSlide()
    slide.background = { data: `image/png;base64,${background.toString('base64')}` }
    const groups = new Map<number, string[]>()
    const itemSteps: AnimStep[] = [] // freie Elemente: je eins pro Klick (Selbstlauf: nacheinander) nach dem Layout-Aufbau
    const used = new Set<string>()
    const ts = withTone(t, s.tone ?? LAYOUTS[s.layout as keyof typeof LAYOUTS]?.tone) // Chart-Farben der Folie
    for (const el of measured.els) {
      let name = `dw:${el.slot}`.replace(/[&<>"']/g, '')
      for (let n = 2; used.has(name); n++) name = `dw:${el.slot}#${n}`
      used.add(name)
      addEl(pptx, slide, el, ts, name)
      if (el.kind === 'box' && el.gradient) patches.push({ slide: i + 1, name, fn: gradFill(el.gradient) })
      if (el.kind === 'text' && el.effect) patches.push({ slide: i + 1, name, fn: textEffect(el.effect, el.sizePx) })
      if (el.kind === 'img' && el.mask) patches.push({ slide: i + 1, name, fn: maskShape(el.mask) })
      else if (el.kind === 'img' && el.fit === 'cover' && !el.round && el.radius > 0.5) patches.push({ slide: i + 1, name, fn: roundRect(el.radius, el.box.w, el.box.h) })
      if (el.kind === 'img' && el.adjust) patches.push({ slide: i + 1, name, fn: adjustBlip(el.adjust) })
      if (el.kind === 'img' && el.look) patches.push({ slide: i + 1, name, fn: recolor(el.look, duotoneOf(ts)) })
      if (el.build !== undefined && !(el.kind === 'img' && !assetPath(el.src))) groups.set(el.build, [...(groups.get(el.build) ?? []), name])
      if (el.anim && el.anim !== 'none') itemSteps.push({ shape: name, effect: el.anim, trigger: deck.mode === 'click' ? 'click' : 'after', durMs: 500 })
    }
    if (s.notes) slide.addNotes(s.notes)
    const preset = buildOf(deck, i)
    anims.push({ transition: i === 0 ? 'none' : deck.transition, steps: [...stepsFor(preset, groups, deck.mode), ...itemSteps] })
  })
  const buf = await patchShapes((await pptx.write({ outputType: 'nodebuffer' })) as Buffer, patches)
  const free = deck.slides.flatMap((s) => s.items ?? []).flatMap((it) => (it.font && it.font in FONTS ? [FONTS[it.font as FontName]] : []))
  return embedFonts(await postProcess(await injectAnimations(buf, anims), deck), embedList([t.head, t.body, ...free]))
}

// Premium-Schriften des Themes (head/body mit `embed`) als TTF-Buffer für embedFonts; Office-Schriften brauchen nichts.
function embedList(fonts: FontRef[]): EmbedFont[] {
  const out = new Map<string, EmbedFont>()
  for (const f of fonts) {
    if ((!f.embed && !f.files) || out.has(f.pptx)) continue
    const file = (url?: string) => { const p = url && assetPath(url); return p && existsSync(p) ? readFileSync(p) : undefined }
    if (f.files) { // eigene Schrift des Nutzers
      const regular = file(f.files.regular)
      if (regular) out.set(f.pptx, { family: f.pptx, regular, bold: file(f.files.bold), serif: f.serif })
      continue
    }
    const face = (name: string) => { const p = join(app.getAppPath(), 'assets/fonts', `${f.embed}-${name}.ttf`); return existsSync(p) ? readFileSync(p) : undefined }
    const regular = face('Regular')
    if (!regular) { console.warn(`[export] ${f.embed}-Regular.ttf fehlt (npm run fonts:fetch), Schrift wird nicht eingebettet`); continue }
    out.set(f.pptx, { family: f.pptx, regular, bold: face('Bold'), italic: face('Italic'), boldItalic: face('BoldItalic'), serif: f.serif })
  }
  return [...out.values()]
}
