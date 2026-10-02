import { FONTS, HEAD_ROLES, SCALE, type FontName } from '../shared/themes'
import { type BoxEl, type El, type Gradient, type ImgEl, type ItemAnim, type AnimDir, type AnimSpeed, type Measured, type Overflow, type Run } from '../shared/deck'

// ---------- autofit: walk the type scale down until nothing overflows ----------

// (head step, body step) combos, cheapest first; on ties shrink body before headlines.
const COMBOS = Array.from({ length: 16 }, (_, i) => [i >> 2, i & 3]).sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0])

function applySteps(root: HTMLElement, head: number, body: number) {
  root.style.setProperty('--head-fit', String(1 - head / 3)) // Plakat-Titel des Themes stufenweise auf Normalgröße
  for (const [role, steps] of Object.entries(SCALE))
    root.style.setProperty(`--fs-${role}`, `${steps[HEAD_ROLES.includes(role) ? head : body]}px`)
}

function lineTops(el: HTMLElement): number[] {
  const range = document.createRange()
  range.selectNodeContents(el)
  const tol = (3 * el.getBoundingClientRect().width) / (el.offsetWidth || 1) // 3 layout px, in (possibly scaled) screen px
  const tops: number[] = []
  for (const r of range.getClientRects()) if (r.width > 0 && !tops.some((t) => Math.abs(t - r.top) < tol)) tops.push(r.top)
  return tops
}

const slotOf = (el: Element) =>
  (el as HTMLElement).dataset.slot ?? (el.querySelector('[data-slot]') as HTMLElement | null)?.dataset.slot ?? 'layout'

export function findOverflow(root: HTMLElement): Overflow[] {
  const out: Overflow[] = []
  for (const el of root.querySelectorAll<HTMLElement>('[data-fit]')) {
    const dh = el.scrollHeight - el.clientHeight
    if (dh > 1) out.push({ slot: slotOf(el), overPx: dh, kind: 'height' })
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-pptx="text"]')) {
    const dw = el.scrollWidth - el.clientWidth
    if (dw > 1) out.push({ slot: slotOf(el), overPx: dw, kind: 'width' })
    const max = Number(el.dataset.maxlines)
    if (max && lineTops(el).length > max) out.push({ slot: slotOf(el), overPx: 0, kind: 'lines' })
  }
  return out
}

export function autofit(root: HTMLElement): Measured['fit'] {
  root.classList.add('dw-fitting')
  try {
    for (const [head, body] of COMBOS) {
      applySteps(root, head, body)
      if (!findOverflow(root).length) return { ok: true, head, body, overflow: [] }
    }
    return { ok: false, head: 3, body: 3, overflow: findOverflow(root) }
  } finally {
    root.classList.remove('dw-fitting')
  }
}

// ---------- extraction: DOM → exportable elements (px on the 1280x720 slide) ----------

function parseColor(s: string): { color: string; alpha: number } | undefined {
  const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
  if (!m) return undefined
  const hex = [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('')
  return { color: `#${hex.toUpperCase()}`, alpha: m[4] === undefined ? 1 : +m[4] }
}

// linear-gradient aus dem berechneten Stil (Chromium normalisiert Farben zu rgb/rgba). Nur lineare Verläufe mit 2+ Stops.
function parseGradient(s: string): Gradient | undefined {
  const m = s.match(/^linear-gradient\((.*)\)$/)
  if (!m) return undefined
  const parts = m[1].split(/,(?![^(]*\))/).map((x) => x.trim())
  const TO: Record<string, number> = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270 }
  let angle = 180
  if (/deg$/.test(parts[0])) angle = parseFloat(parts.shift()!)
  else if (parts[0] in TO) angle = TO[parts.shift()!]
  const stops = parts.flatMap((p, i, all) => {
    const c = parseColor(p)
    const pos = p.match(/([\d.]+)%\s*$/)
    return c ? [{ ...c, pos: pos ? +pos[1] / 100 : i / Math.max(1, all.length - 1) }] : []
  })
  return stops.length >= 2 ? { angle, stops } : undefined
}

function effectiveBg(el: HTMLElement, root: HTMLElement): string {
  for (let n: HTMLElement | null = el; n && n !== root.parentElement; n = n.parentElement) {
    if (n.dataset.pptx === 'img') return ''
    const c = parseColor(getComputedStyle(n).backgroundColor)
    if (c && c.alpha > 0.6) return c.color
  }
  return ''
}

// Text runs; for headlines (data-hardwrap) also the exact line breaks Chromium chose, so PowerPoint can't re-wrap.
function runsOf(el: HTMLElement, hardwrap: boolean, k: number): Run[] {
  const runs: Run[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let lastTop: number | undefined
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const cs = getComputedStyle(node.parentElement!)
    const style = { bold: Number(cs.fontWeight) >= 600, italic: cs.fontStyle === 'italic', underline: cs.textDecorationLine.includes('underline') || undefined, color: parseColor(cs.color)?.color ?? '#000000', link: node.parentElement!.closest<HTMLElement>('[data-href]')?.dataset.href }
    const push = (text: string) => {
      const prev = runs[runs.length - 1]
      if (prev && !prev.breakAfter && prev.bold === style.bold && prev.italic === style.italic && prev.underline === style.underline && prev.color === style.color && prev.link === style.link) prev.text += text
      else runs.push({ text, ...style })
    }
    const lines = node.data.split('\n')
    lines.forEach((line, li) => {
      if (li > 0 && runs.length) runs[runs.length - 1].breakAfter = true
      if (!hardwrap) return line && push(line)
      let offset = node.data.split('\n').slice(0, li).join('\n').length + (li ? 1 : 0)
      for (const tok of line.match(/\S+\s*|\s+/g) ?? []) {
        range.setStart(node, offset)
        range.setEnd(node, offset + 1)
        const top = range.getClientRects()[0]?.top
        if (top !== undefined && lastTop !== undefined && top > lastTop + 3 / k && runs.length) {
          const prev = runs[runs.length - 1]
          prev.text = prev.text.trimEnd()
          prev.breakAfter = true
        }
        if (top !== undefined) lastTop = top
        push(tok)
        offset += tok.length
      }
    })
  }
  if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd()
  return runs.filter((r) => r.text || r.breakAfter)
}

function svgOf(el: HTMLElement): string {
  const svg = el.querySelector('svg')
  if (!svg) return ''
  const color = getComputedStyle(svg).color
  const clone = svg.cloneNode(true) as SVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  return clone.outerHTML.replaceAll('currentColor', parseColor(color)?.color ?? '#000000')
}

export function extract(root: HTMLElement): El[] {
  const o = root.getBoundingClientRect()
  const k = root.offsetWidth / o.width // undo any preview scaling (Folienbreite je nach Format)
  const els: El[] = []
  for (const el of root.querySelectorAll<HTMLElement>('[data-pptx]')) {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    const cs = getComputedStyle(el)
    // Freie Elemente: ungedrehte Box aus dem Layout (getBoundingClientRect wäre bei Drehung die umschließende Box)
    const item = el.dataset.item !== undefined
    const base = {
      slot: el.dataset.slot ?? 'el',
      box: item ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : { x: (r.left - o.left) * k, y: (r.top - o.top) * k, w: r.width * k, h: r.height * k },
      build: el.dataset.build === undefined ? undefined : Number(el.dataset.build),
      rot: el.dataset.rot ? Number(el.dataset.rot) : undefined,
      anim: (el.dataset.anim as ItemAnim | undefined) || undefined,
      animDir: (el.dataset.animDir as AnimDir | undefined) || undefined,
      animSpeed: (el.dataset.animSpeed as AnimSpeed | undefined) || undefined,
    }
    switch (el.dataset.pptx) {
      case 'text': {
        const hardwrap = el.dataset.hardwrap !== undefined
        els.push({
          ...base, kind: 'text',
          font: el.dataset.font === 'head' ? 'head' : 'body',
          effect: el.dataset.effect ? JSON.parse(el.dataset.effect) : undefined,
          fontFace: el.dataset.face ? FONTS[el.dataset.face as FontName]?.pptx ?? el.dataset.face : undefined,
          role: el.dataset.role ?? 'body',
          sizePx: parseFloat(cs.fontSize),
          lineHeightPx: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2,
          trackingPx: parseFloat(cs.letterSpacing) || 0,
          align: cs.textAlign === 'center' ? 'center' : cs.textAlign === 'right' || cs.textAlign === 'end' ? 'right' : 'left',
          upper: cs.textTransform === 'uppercase',
          runs: runsOf(el, hardwrap, k),
          lines: lineTops(el).length,
          bg: effectiveBg(el, root),
        })
        break
      }
      case 'box': {
        if (el.dataset.shape) { // freie Form: Farben stehen in data-*, die Vorschau ist ein SVG
          const d = el.dataset, sw = Number(d.sw) || 0
          els.push({
            ...base, kind: 'box', radius: 0, ellipse: false, shape: d.shape as BoxEl['shape'],
            fill: d.fill && d.shape !== 'line' ? { color: d.fill.toUpperCase(), alpha: Number(d.alpha ?? 1) } : undefined,
            border: d.stroke && sw > 0 ? { color: d.stroke.toUpperCase(), width: sw } : undefined,
            lineStart: d.ls as BoxEl['lineStart'], lineEnd: d.le as BoxEl['lineEnd'], dash: d.dash as BoxEl['dash'],
          })
          break
        }
        const fill = parseColor(cs.backgroundColor)
        const bw = parseFloat(cs.borderTopWidth)
        const sh = cs.boxShadow.match(/(rgba?\([^)]+\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/)
        const shc = sh && parseColor(sh[1])
        els.push({
          ...base, kind: 'box',
          fill: fill && fill.alpha > 0 ? fill : undefined,
          border: bw > 0 && cs.borderTopStyle !== 'none' ? { color: parseColor(cs.borderTopColor)!.color, width: bw } : undefined,
          dash: cs.borderTopStyle === 'dashed' ? 'dash' : cs.borderTopStyle === 'dotted' ? 'dot' : undefined,
          radius: parseFloat(cs.borderTopLeftRadius) || 0,
          shadow: shc ? { color: shc.color, alpha: shc.alpha, blur: +sh[4], offsetY: +sh[3] } : undefined,
          ellipse: el.dataset.ellipse !== undefined,
          gradient: parseGradient(cs.backgroundImage),
        })
        break
      }
      case 'img': {
        const pic = el.querySelector<HTMLElement>('.img-pic')
        const pcs = pic ? getComputedStyle(pic) : cs
        const pct = (v: string) => (v.trim().endsWith('%') ? parseFloat(v) / 100 : 0.5)
        els.push({
          ...base, kind: 'img', src: el.dataset.src ?? '', radius: parseFloat(cs.borderTopLeftRadius) || 0,
          fit: el.dataset.imgfit === 'contain' ? 'contain' : 'cover',
          focus: { x: pct(pcs.backgroundPositionX), y: pct(pcs.backgroundPositionY) },
          under: el.dataset.under !== undefined || undefined,
          look: (el.dataset.look as ImgEl['look']) || undefined,
          alpha: parseFloat(cs.opacity) < 1 ? parseFloat(cs.opacity) : undefined,
          round: el.dataset.round !== undefined || undefined,
          mask: el.dataset.mask as ImgEl['mask'],
          adjust: el.dataset.adjust ? JSON.parse(el.dataset.adjust) : undefined,
          flip: el.dataset.flip !== undefined || undefined,
          crop: el.dataset.crop ? JSON.parse(el.dataset.crop) : undefined,
        })
        break
      }
      case 'media':
        els.push({ ...base, kind: 'media', media: el.dataset.media === 'audio' ? 'audio' : 'video', src: el.dataset.src ?? '', poster: el.dataset.poster })
        break
      case 'icon':
        els.push({ ...base, kind: 'icon', svg: svgOf(el), name: el.dataset.icon, qr: el.dataset.qr, color: parseColor(cs.color)?.color })
        break
      case 'chart':
        els.push({ ...base, kind: 'chart', spec: JSON.parse(el.dataset.chart ?? '{}') })
        break
    }
  }
  return els
}

// Striche vor Eyebrows sind ein CSS-::before (im PPTX-Export Teil des Hintergrundbilds). Für „In freie Elemente
// umwandeln“ als Flächen liefern, sonst fehlen sie auf der leeren Folie.
export function eyebrowRules(root: HTMLElement): El[] {
  const o = root.getBoundingClientRect(), k = root.offsetWidth / o.width
  return [...root.querySelectorAll<HTMLElement>('.eyebrow-wrap')].flatMap((wrap): El[] => {
    const t = wrap.querySelector<HTMLElement>('[data-pptx]'), bs = getComputedStyle(wrap, '::before')
    const w = parseFloat(bs.width), h = parseFloat(bs.height), fill = parseColor(bs.backgroundColor)
    if (!t || !w || !h || !fill) return []
    const r = t.getBoundingClientRect(), gap = parseFloat(getComputedStyle(wrap).columnGap) || 0
    return [{ slot: '_eyebrow', kind: 'box', box: { x: (r.left - o.left) * k - gap - w, y: (r.top - o.top) * k + (r.height * k - h) / 2, w, h }, fill, radius: parseFloat(bs.borderRadius) || 0, ellipse: false }]
  })
}
