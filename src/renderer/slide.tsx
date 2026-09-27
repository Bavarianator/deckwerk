import { createContext, useContext, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import { icons } from 'lucide-react'
import QRCode from 'qrcode'
import { GRAPHICS } from '../shared/items'
import { Chart, registerables, type ChartConfiguration, type Plugin } from 'chart.js'
import { chartColors, decimals, fmt, readableOn, valueLabels, waterfall } from '../shared/charts'
import { sizeOf, type ChartSpec, type Crop, type Deck, type DecorId, type FrameId, type Item, type MaskId, type Adjust, type Measured, type Tone } from '../shared/deck'
import { FONTS, HEAD_ROLES, SCALE, duotoneOf, ensureContrast, mix, resolveTheme, withTone, type FontName, type Theme } from '../shared/themes'
import { LAYOUTS } from '../shared/layouts'
import { COMPONENTS } from './layouts'
import { autofit } from './measure'
import './slide.css'

Chart.register(...registerables)

interface Ctx { theme: Theme; deck: Deck; index: number; editable: boolean; onEdit?: (slot: string, text: string) => void; print: boolean; editing?: string; live?: boolean }
const SlideCtx = createContext<Ctx>(null!)
export const useSlide = () => useContext(SlideCtx)

// ---------- primitives: every exportable element carries data-pptx; slot = content path ("kpis.1.value"), "_" = not content ----------

// sichtbarer Text ohne Markup (Vergleich beim Bearbeiten, sonst ginge Markup schon beim bloßen Anklicken verloren)
const plain = (text: string) => text.replaceAll('**', '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
// **fett** und [Text](https://…) → Link (als span: ein <a> würde im Electron-Fenster navigieren; PPTX: nativer Hyperlink)
const rich = (text: string) =>
  text.split(/(\*\*.+?\*\*|\[[^\]]+\]\((?:https?:|mailto:)[^)\s]+\))/g).map((part, i) => {
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (link) return <span key={i} className="lnk" data-href={link[2]}>{link[1]}</span>
    return part.startsWith('**') && part.endsWith('**') && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : part
  })

export function T(p: { role: keyof typeof SCALE; slot: string; children: string; maxLines?: number; build?: number; className?: string; style?: CSSProperties }) {
  const { editable, onEdit } = useSlide()
  const head = HEAD_ROLES.includes(p.role) || p.role === 'h2' || p.role === 'h3'
  const canEdit = editable && !p.slot.startsWith('_')
  return (
    <div
      className={`t r-${p.role} ${p.className ?? ''}`}
      style={p.style}
      data-pptx="text"
      data-slot={p.slot}
      data-role={p.role}
      data-font={head ? 'head' : 'body'}
      data-hardwrap={head ? '' : undefined}
      data-maxlines={p.maxLines}
      data-build={p.build}
      contentEditable={canEdit || undefined}
      suppressContentEditableWarning
      onBlur={canEdit ? (e) => e.currentTarget.innerText.trim() !== plain(p.children) && onEdit?.(p.slot, e.currentTarget.innerText.trim()) : undefined}
    >
      {rich(p.children)}
    </div>
  )
}

export function Box(p: { slot: string; className?: string; children?: ReactNode; build?: number; fit?: boolean; ellipse?: boolean; style?: CSSProperties }) {
  return (
    <div className={`box ${p.className ?? ''}`} style={p.style} data-pptx="box" data-slot={p.slot} data-build={p.build} data-fit={p.fit ? '' : undefined} data-ellipse={p.ellipse ? '' : undefined}>
      {p.children}
    </div>
  )
}

export type Focus = 'center' | 'top' | 'bottom' | 'left' | 'right'
export type Look = 'natural' | 'duotone' | 'mono'
const FOCUS_POS: Record<Focus, string> = { center: '50% 50%', top: '50% 25%', bottom: '50% 80%', left: '20% 50%', right: '80% 50%' }

// Foto oder Logo. under = liegt unter Text (Vollbild), look = Duotone/Mono (PPTX: „Neu einfärben“), round = Kreismaske.
// Der Radius kommt aus dem CSS (border-radius) und wird im Export zu roundRect.
// Bildanpassung als CSS-Filter (Export: patch-xml.ts adjustBlip mit denselben Prozentwerten)
const adjustCss = (a?: Adjust) =>
  a ? [a.bright && `brightness(${1 + a.bright / 100})`, a.contrast && `contrast(${1 + a.contrast / 100})`, a.sat && `saturate(${1 + a.sat / 100})`, a.blur && `blur(${a.blur / 10}px)`].filter(Boolean).join(' ') || undefined : undefined

// Bildrahmen: clip-path aus derselben Form wie im Export, in Pixeln der aktuellen Box (Autofit kann die Box noch ändern)
function useMask(mask?: MaskId) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!mask) return void (el.style.clipPath = '')
    const apply = () => (el.style.clipPath = `path('${shapePath(mask, el.offsetWidth, el.offsetHeight, true)}')`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => ro.disconnect()
  }, [mask])
  return ref
}

export function Img(p: { src: string; slot: string; className?: string; contain?: boolean; build?: number; focus?: Focus; under?: boolean; look?: Look; alpha?: number; round?: boolean; style?: CSSProperties; attrs?: Record<string, string | undefined>; crop?: Crop; mask?: MaskId; adjust?: Adjust }) {
  const { theme } = useSlide()
  const look = p.look === 'natural' ? undefined : p.look
  const ref = useMask(p.mask)
  const c = p.crop
  // Zuschnitt: Bild so groß, dass der Ausschnitt die Box füllt; background-position in % bezieht sich auf den Überstand
  const pic: CSSProperties = c
    ? { backgroundImage: `url("${p.src}")`, backgroundSize: `${100 / c.w}% ${100 / c.h}%`, backgroundPosition: `${c.w < 1 ? (c.x / (1 - c.w)) * 100 : 0}% ${c.h < 1 ? (c.y / (1 - c.h)) * 100 : 0}%` }
    : { backgroundImage: `url("${p.src}")`, backgroundSize: p.contain ? 'contain' : 'cover', ...(p.focus && { backgroundPosition: FOCUS_POS[p.focus] }) }
  const [dark, light] = duotoneOf(theme)
  return (
    <div
      ref={ref}
      className={`img ${p.round ? 'round' : ''} ${p.className ?? ''}`}
      data-mask={p.mask}
      data-adjust={p.adjust ? JSON.stringify(p.adjust) : undefined}
      data-pptx="img"
      data-slot={p.slot}
      data-src={p.src}
      data-build={p.build}
      data-imgfit={p.contain ? 'contain' : 'cover'}
      data-under={p.under ? '' : undefined}
      data-look={look}
      data-round={p.round ? '' : undefined}
      data-crop={c ? JSON.stringify(c) : undefined}
      {...p.attrs}
      style={{ ...(look ? { isolation: 'isolate' } : pic), opacity: p.alpha, filter: adjustCss(p.adjust), ...p.style }}
    >
      {look && <div className="img-pic" style={{ ...pic, filter: 'grayscale(1) contrast(1.05)' }} />}
      {look === 'duotone' && <div className="img-tone" style={{ background: light, mixBlendMode: 'multiply' }} />}
      {look === 'duotone' && <div className="img-tone" style={{ background: dark, mixBlendMode: 'screen' }} />}
    </div>
  )
}

const pascal = (name: string) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase())
export const hasIcon = (name: string) => pascal(name) in icons

export function Icon(p: { name: string; slot: string; size: number; build?: number; className?: string }) {
  const Cmp = icons[pascal(p.name) as keyof typeof icons] ?? icons.Sparkles
  return (
    <span className={`icon ${p.className ?? ''}`} data-pptx="icon" data-slot={p.slot} data-build={p.build} style={{ width: p.size, height: p.size }}>
      <Cmp size={p.size} strokeWidth={1.75} />
    </span>
  )
}

export function fmtNum(v: number) {
  return v.toLocaleString('de-DE', { maximumFractionDigits: 1 })
}

// Profi-Diagramm (Logik geteilt mit dem PPTX-Export in shared/charts.ts): Fokusfarbe, Werte am Balken statt Achse,
// Seriennamen am Linienende statt Legende, keine geglätteten Linien, Wasserfall als schwebende Balken.
function chartConfig(spec: ChartSpec, t: Theme, print: boolean): ChartConfiguration {
  const font = { family: t.body.css, size: 15 }
  const base = { animation: false as const, responsive: true, maintainAspectRatio: false, devicePixelRatio: print ? 3 : 2 }
  const { perSeries, perPoint } = chartColors(spec, t)
  if (spec.type === 'donut') {
    const donut: ChartConfiguration<'doughnut'> = {
      type: 'doughnut',
      data: { labels: spec.categories, datasets: [{ data: spec.series[0]?.values ?? [], backgroundColor: perPoint ?? t.c.chart, borderColor: t.c.bg, borderWidth: 3 }] },
      options: { ...base, cutout: '62%', plugins: { legend: { position: 'right', labels: { font, color: t.c.text, boxWidth: 14, padding: 16 } } } },
    }
    return donut as unknown as ChartConfiguration
  }
  const line = spec.type === 'line', horizontal = spec.type === 'hbar', stacked = spec.type === 'stacked'
  const endLabels = line && spec.series.length > 1
  const labels = valueLabels(spec), dec = decimals(spec)
  const wf = spec.type === 'waterfall' ? waterfall(spec.series[0]?.values ?? []) : undefined
  const wfColor = (i: number) => (wf!.total[i] ? t.c.chart[0] : wf!.up[i] ? t.c.good : t.c.bad)
  const datasets = wf
    ? [{ label: spec.series[0]?.name ?? '', data: spec.categories.map((_, i) => [wf.base[i], wf.base[i] + wf.up[i] + wf.down[i] + wf.total[i]]), backgroundColor: spec.categories.map((_, i) => wfColor(i)), borderRadius: 4, maxBarThickness: 72 }]
    : spec.series.map((s, i) => ({
        label: s.name, data: s.values, backgroundColor: perPoint ?? perSeries[i], borderColor: perSeries[i], pointBackgroundColor: perSeries[i],
        borderWidth: line ? 3 : 0, borderRadius: line || stacked ? 0 : 6, maxBarThickness: 64, tension: 0, pointRadius: line ? 4 : 0,
      }))

  const valueText = (di: number, i: number) => {
    const v = spec.series[wf ? 0 : di]?.values[i] ?? 0
    return wf && !wf.total[i] ? `${v < 0 ? '−' : '+'}${fmt(Math.abs(v), dec)}` : fmt(v, dec)
  }
  const dwLabels: Plugin = {
    id: 'dwLabels',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx
      ctx.save()
      chart.data.datasets.forEach((_, di) => {
        chart.getDatasetMeta(di).data.forEach((el, i) => {
          const p = el as unknown as { x: number; y: number; base: number }
          if (endLabels) {
            if (i !== spec.categories.length - 1) return
            ctx.font = `700 15px "${t.body.css}"`, ctx.fillStyle = perSeries[di], ctx.textAlign = 'left', ctx.textBaseline = 'middle'
            return ctx.fillText(spec.series[di].name, p.x + 10, p.y)
          }
          if (!labels || (stacked && !spec.series[di].values[i])) return
          ctx.font = `600 14px "${t.body.css}"`
          if (stacked || wf) { // wie PowerPoint: bei gestapelten Balken nur innen möglich
            const fill = wf ? wfColor(i) : (perPoint ?? perSeries)[perPoint ? i : di]
            if (Math.abs(horizontal ? p.x - p.base : p.base - p.y) < 20) { // zu schmal für innen: Wasserfall darüber, Stapel weglassen
              if (!wf) return
              ctx.fillStyle = t.c.text, ctx.textAlign = 'center', ctx.textBaseline = 'bottom'
              return ctx.fillText(valueText(di, i), p.x, Math.min(p.y, p.base) - 6)
            }
            ctx.fillStyle = readableOn(fill), ctx.textAlign = 'center', ctx.textBaseline = 'middle'
            return ctx.fillText(valueText(di, i), horizontal ? (p.x + p.base) / 2 : p.x, horizontal ? p.y : (p.y + p.base) / 2)
          }
          ctx.fillStyle = t.c.text
          if (horizontal) (ctx.textAlign = 'left'), (ctx.textBaseline = 'middle'), ctx.fillText(valueText(di, i), p.x + 8, p.y)
          else (ctx.textAlign = 'center'), (ctx.textBaseline = 'bottom'), ctx.fillText(valueText(di, i), p.x, Math.min(p.y, p.base) - 6)
        })
      })
      ctx.restore()
    },
  }
  const cat = { grid: { display: false }, border: { color: t.c.border }, ticks: { font, color: t.c.muted }, stacked }
  const val = { display: !labels, stacked, beginAtZero: true, grid: { color: t.c.border }, border: { display: false }, ticks: { font, color: t.c.muted, callback: (v: string | number) => fmtNum(Number(v)) } }
  const longest = Math.max(...spec.series.map((s) => s.name.length))
  return {
    type: line ? 'line' : 'bar',
    data: { labels: spec.categories, datasets },
    options: {
      ...base,
      indexAxis: horizontal ? 'y' : 'x',
      layout: { padding: { top: labels && !horizontal ? 26 : 8, right: endLabels ? longest * 8.5 + 18 : labels && horizontal ? 64 : 8 } },
      scales: horizontal ? { y: cat, x: val } : { x: cat, y: val },
      plugins: { legend: { display: !line && !wf && spec.series.length > 1, position: 'top', align: 'end', labels: { font, color: t.c.text, boxWidth: 12, boxHeight: 12, padding: 16 } } },
    },
    plugins: [dwLabels],
  } as ChartConfiguration
}

export function ChartBox(p: { spec: ChartSpec; slot: string; build?: number; className?: string; style?: CSSProperties; attrs?: Record<string, string | undefined> }) {
  const { theme, print } = useSlide()
  const ref = useRef<HTMLCanvasElement>(null)
  const json = JSON.stringify(p.spec)
  useLayoutEffect(() => {
    const chart = new Chart(ref.current!, chartConfig(p.spec, theme, print))
    return () => chart.destroy()
  }, [json, theme, print])
  return (
    <div className={`chart ${p.className ?? ''}`} data-pptx="chart" data-slot={p.slot} data-build={p.build} data-chart={json} {...p.attrs} style={p.style}>
      <canvas ref={ref} />
    </div>
  )
}

// ---------- frame: background decor (rasterized into the PPTX background), safe area, footer ----------

export type DecorKind = 'hero' | 'content'

// Motive der Hintergrundebene. a/b = Akzentfarben, line = feine Linienfarbe; hero = Cover/Statement/Kapitel (kräftiger).
interface Motif { t: Theme; a: string; b: string; hero: boolean; line: string }
const div = (className: string, style: CSSProperties) => <div className={className} style={style} />
const corner = 'radial-gradient(ellipse at 88% 8%, #000 0%, transparent 55%)'
const MOTIFS: Record<DecorId, (m: Motif) => ReactNode> = {
  none: () => null,
  blobs: ({ t, a, b, hero }) => (
    <>
      {div('blob', { width: hero ? 820 : 560, height: hero ? 820 : 560, right: hero ? -260 : -300, top: hero ? -320 : -360, background: a, opacity: hero ? 0.16 : 0.07 })}
      {hero && div('blob', { width: 520, height: 520, left: -240, bottom: -300, background: b, opacity: 0.12 })}
      {hero && div('ring', { width: 540, height: 540, right: 60, top: -300, borderColor: mix(t.c.bg, a, 0.18) })}
    </>
  ),
  glow: ({ a, b, hero, line }) => (
    <>
      {div('grid-lines', { '--line': line, opacity: hero ? 1 : 0.6 } as CSSProperties)}
      {div('blob', { width: hero ? 760 : 520, height: hero ? 760 : 520, right: hero ? -200 : -260, top: hero ? -280 : -320, background: a, opacity: hero ? 0.5 : 0.22 })}
      {div('blob', { width: 560, height: 560, left: -220, bottom: -300, background: b, opacity: hero ? 0.32 : 0.1 })}
    </>
  ),
  rings: ({ t, a, b, hero }) => (
    <>
      {hero && div('ring', { width: 620, height: 620, right: -180, bottom: -260, borderColor: mix(t.c.bg, a, 0.35) })}
      {hero && div('ring', { width: 420, height: 420, right: -80, bottom: -160, borderColor: mix(t.c.bg, b, 0.3) })}
      {div('rule', { background: a })}
    </>
  ),
  grid: ({ hero, line }) => div('grid-lines', { '--line': line, maskImage: hero ? 'radial-gradient(ellipse at 70% 40%, #000 0%, transparent 75%)' : corner } as CSSProperties),
  stripe: ({ t, a, hero }) =>
    hero ? (
      <>
        {div('panel', { right: 0, width: 380, background: mix(t.c.bg, a, 0.1) })}
        {div('panel', { right: 380, width: 3, background: a })}
      </>
    ) : (
      div('panel', { left: 0, width: 8, background: a })
    ),
  dots: ({ t, a, hero }) => (
    <>
      {div('dots', { '--dot': mix(t.c.bg, a, 0.45), maskImage: corner } as CSSProperties)}
      {hero && div('dots', { '--dot': mix(t.c.bg, a, 0.35), maskImage: 'radial-gradient(ellipse at 6% 96%, #000 0%, transparent 40%)' } as CSSProperties)}
    </>
  ),
}

function Decor({ kind, id }: { kind: DecorKind; id: DecorId }) {
  const { theme: t } = useSlide()
  // Akzentfläche (Ton accent): leichter Verlauf in accent2, darüber das Motiv
  const base = t.tone === 'accent' ? { background: `linear-gradient(120deg, ${t.c.bg} 0%, ${t.c.bg} 45%, ${mix(t.c.bg, t.c.accent2, 0.35)} 100%)` } : undefined
  return (
    <div className={['decor', id === 'rings' && 'paper', t.texture].filter(Boolean).join(' ')} style={base}>
      {MOTIFS[id]?.({ t, a: t.c.accent, b: t.c.accent2, hero: kind === 'hero', line: mix(t.c.bg, t.c.text, 0.08) })}
    </div>
  )
}

function themeVars(t: Theme): CSSProperties {
  const v: Record<string, string | number> = {
    '--bg': t.c.bg, '--surface': t.c.surface, '--surface2': t.c.surface2, '--text': t.c.text, '--muted': t.c.muted,
    '--accent': t.c.accent, '--accent2': t.c.accent2, '--on-accent': t.c.onAccent, '--border': t.c.border,
    '--good': t.c.good, '--bad': t.c.bad,
    // Auf Akzentflächen ist accent die Textfarbe: dort abgestufte Fläche statt Mischung Richtung Text (Kontrast)
    '--accent-tint': t.tone === 'accent' ? t.c.surface2 : mix(t.c.bg, t.c.accent, t.dark ? 0.22 : 0.1),
    '--fill': t.c.fill!,
    '--on-accent-soft': ensureContrast(mix(t.c.fill!, t.c.onAccent, 0.85), t.c.fill!, 4.6),
    '--font-head': `'${t.head.css}'`, '--font-body': `'${t.body.css}'`, '--head-weight': t.head.weight, '--head-tracking': `${t.head.tracking}em`,
    '--radius': `${t.radius}px`,
  }
  for (const [role, steps] of Object.entries(SCALE)) v[`--fs-${role}`] = `${steps[0]}px`
  return v as CSSProperties
}

// ---------- Fotos als Hintergrund ----------

export interface PhotoRef { src: string; focus?: Focus; look?: Look; mask?: MaskId }
// Inhalt kann aus älteren Decks noch ein String sein
export const photoOf = (v: unknown): PhotoRef | undefined => (typeof v === 'string' ? { src: v } : (v as PhotoRef | undefined))

export const rgba = (hex: string, a: number) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')}, ${a})`
const SCRIM = {
  left: (d: string) => `linear-gradient(90deg, ${rgba(d, 0.9)} 0%, ${rgba(d, 0.8)} 55%, ${rgba(d, 0.25)} 100%)`,
  bottom: (d: string) => `linear-gradient(0deg, ${rgba(d, 0.92)} 0%, ${rgba(d, 0.7)} 42%, ${rgba(d, 0)} 80%)`,
  full: (d: string) => `linear-gradient(0deg, ${rgba(d, 0.84)} 0%, ${rgba(d, 0.84)} 100%)`, // Text mittig auf dem Foto
  none: () => '',
}

// Vollbildfoto unter dem Inhalt (für Frame.media) mit nativem Verlauf darüber; beides bleibt in PowerPoint editierbar.
export function Backdrop(p: { image: PhotoRef; scrim: keyof typeof SCRIM }) {
  const { theme } = useSlide()
  const d = mix('#000000', theme.c.accent, 0.12)
  return (
    <div className="backdrop">
      <Img src={p.image.src} focus={p.image.focus} look={p.image.look} under slot="image" />
      {p.scrim !== 'none' && <Box slot="_scrim" className="scrim" style={{ backgroundImage: SCRIM[p.scrim](d) }} />}
    </div>
  )
}

// Schrift auf dem Foto: weiß, Akzent aufgehellt. Als Style auf einen Wrapper innerhalb von Frame setzen.
export const onPhoto = (t: Theme): CSSProperties => ({ '--text': '#FFFFFF', '--muted': '#E9E9E9', '--accent': mix('#FFFFFF', t.c.accent, 0.3), color: '#FFFFFF' }) as CSSProperties

// Frame stellt den Folien-Ton als abgeleitetes Theme bereit: alles innerhalb (Text, Charts, Dekor) sieht die getönten Farben.
export function Frame(p: { decor?: DecorKind; tone?: Tone; media?: ReactNode; safeClass?: string; children: ReactNode }) {
  const ctx = useSlide()
  const { deck, index } = ctx
  const s = deck.slides[index]
  const def = LAYOUTS[s.layout as keyof typeof LAYOUTS] as { tone?: Tone; footer: boolean; frames?: FrameId[] } | undefined
  const theme = withTone(ctx.theme, s.tone ?? p.tone ?? def?.tone)
  const frame = s.frame && def?.frames?.includes(s.frame) ? s.frame : 'top'
  return (
    <SlideCtx.Provider value={{ ...ctx, theme }}>
      <div className={`slide ${theme.dark ? 'dark' : ''} fr-${frame}`} style={{ ...themeVars(theme), width: sizeOf(deck).w, height: sizeOf(deck).h, ...(s.bg?.color && { background: s.bg.color }), ...(s.bg?.gradient && { background: `linear-gradient(${s.bg.angle ?? 135}deg, ${s.bg.gradient[0]}, ${s.bg.gradient[1]})` }) }}>
        {s.bg?.image ? <div className="backdrop"><Img src={s.bg.image} slot="_bg" under /></div> : <Decor kind={p.decor ?? 'content'} id={s.decor ?? theme.decor} />}
        {p.media}
        <div className={`safe ${p.safeClass ?? ''}`} data-fit data-slot="_slide">
          {p.children}
        </div>
        {def?.footer && (
          <div className={`footer ${p.safeClass ?? ''}`}>
            <T role="footer" slot="_footer.title">{deck.title}</T>
            <div className="footer-right">
              {theme.logo && <Img src={theme.logo} slot="_footer.logo" className="footer-logo" contain />}
              <T role="footer" slot="_footer.page">{String(index + 1)}</T>
            </div>
          </div>
        )}
        {s.items?.map((it) => <FreeItem key={it.id} it={it} />)}
      </div>
    </SlideCtx.Provider>
  )
}

// ---------- freie Elemente: dieselben data-pptx-Primitive wie die Layouts, daher gleicher Export (PPTX/PDF/PNG) ----------

// Pfade im 100×100-Raster; im Export werden daraus native PowerPoint-Formen (export-pptx.ts, SHAPE_TYPE).
// Formen mit festen Adjust-Werten hängen vom Seitenverhältnis ab: a = Anteil der kürzeren Seite wie in PowerPoint.
// ponytail: Sterne und Herz nur ungefähr wie PowerPoints Presets; exakt über deren Formeln, falls es stört
// px = true: Koordinaten in Pixeln der Box (für clip-path), sonst im 100×100-Raster (SVG mit preserveAspectRatio none)
export function shapePath(shape: string, w = 100, h = 100, px = false): string {
  const kx = px ? w / 100 : 1, ky = px ? h / 100 : 1
  const n = (v: number) => +v.toFixed(2)
  const P = (x: number, y: number) => `${n(x * kx)} ${n(y * ky)}`
  const poly = (pts: number[][]) => `M${pts.map(([x, y]) => P(x, y)).join(' L')} Z`
  const star = (k: number, inner: number) =>
    poly(Array.from({ length: k * 2 }, (_, i) => {
      const r = i % 2 ? inner : 1, a = (Math.PI * i) / k - Math.PI / 2
      return [50 + 50 * r * Math.cos(a), 50 + 50 * r * Math.sin(a)]
    }))
  const m = Math.min(w, h), ax = (f: number) => ((f * m) / w) * 100, ay = (f: number) => ((f * m) / h) * 100
  const ellipse = (rx: number, ry: number) => `M${P(50 - rx, 50)} A${n(rx * kx)} ${n(ry * ky)} 0 1 0 ${P(50 + rx, 50)} A${n(rx * kx)} ${n(ry * ky)} 0 1 0 ${P(50 - rx, 50)} Z`
  switch (shape) {
    case 'triangle': return poly([[50, 0], [100, 100], [0, 100]])
    case 'rtTriangle': return poly([[0, 0], [100, 100], [0, 100]])
    case 'diamond': return poly([[50, 0], [100, 50], [50, 100], [0, 50]])
    case 'hexagon': return poly([[ax(0.25), 0], [100 - ax(0.25), 0], [100, 50], [100 - ax(0.25), 100], [ax(0.25), 100], [0, 50]])
    case 'octagon': { const x = ax(0.29289), y = ay(0.29289); return poly([[x, 0], [100 - x, 0], [100, y], [100, 100 - y], [100 - x, 100], [x, 100], [0, 100 - y], [0, y]]) }
    case 'star': return star(5, 0.382)
    case 'star4': return star(4, 0.25)
    case 'star6': return star(6, 0.577)
    case 'star8': return star(8, 0.765)
    case 'star12': return star(12, 0.75)
    case 'arrow': { const head = 100 - ax(0.5); return poly([[0, 25], [head, 25], [head, 0], [100, 50], [head, 100], [head, 75], [0, 75]]) } // rightArrow adj 50 %/50 %
    case 'chevron': { const x = ax(0.5); return poly([[0, 0], [100 - x, 0], [100, 50], [100 - x, 100], [0, 100], [x, 50]]) }
    case 'pentagon': { const x = ax(0.5); return poly([[0, 0], [100 - x, 0], [100, 50], [100 - x, 100], [0, 100]]) } // homePlate
    case 'trapezoid': { const x = ax(0.25); return poly([[x, 0], [100 - x, 0], [100, 100], [0, 100]]) }
    case 'parallelogram': { const x = ax(0.25); return poly([[x, 0], [100, 0], [100 - x, 100], [0, 100]]) }
    case 'plus': { const x = ax(0.25), y = ay(0.25); return poly([[x, 0], [100 - x, 0], [100 - x, y], [100, y], [100, 100 - y], [100 - x, 100 - y], [100 - x, 100], [x, 100], [x, 100 - y], [0, 100 - y], [0, y], [x, y]]) }
    case 'donut': return `${ellipse(50, 50)} ${ellipse(50 - ax(0.25), 50 - ay(0.25))}` // Ring, Dicke 25 % der kürzeren Seite (evenodd)
    case 'circle': case 'ellipse': return ellipse(50, 50)
    case 'arch': { // round2SameRect adj 50 %: oben zwei Viertelkreise mit halber kürzerer Seite
      const rx = ax(0.5), ry = ay(0.5)
      return `M${P(0, 100)} L${P(0, ry)} A${n(rx * kx)} ${n(ry * ky)} 0 0 1 ${P(rx, 0)} L${P(100 - rx, 0)} A${n(rx * kx)} ${n(ry * ky)} 0 0 1 ${P(100, ry)} L${P(100, 100)} Z`
    }
    case 'heart': {
      const c = [[20, 76, 0, 56, 0, 30], [0, 12, 13, 0, 28, 0], [40, 0, 47, 8, 50, 16], [53, 8, 60, 0, 72, 0], [87, 0, 100, 12, 100, 30], [100, 56, 80, 76, 50, 100]]
      return `M${P(50, 100)} ${c.map((q) => `C${P(q[0], q[1])} ${P(q[2], q[3])} ${P(q[4], q[5])}`).join(' ')} Z`
    }
    default: return poly([[0, 0], [100, 0], [100, 100], [0, 100]])
  }
}
export const SHAPE_PATHS: Record<string, string> = new Proxy({}, { get: (_, k) => shapePath(String(k)) }) // Vorschau-Kacheln (quadratisch)

// Linie in px (nicht gestreckt), damit Pfeilspitzen proportional bleiben; Größe wie PowerPoints „mittel“ (3 × Strichstärke)
const dashArray = (d: Item['dash'], sw: number) => (d === 'dash' ? `${4 * sw} ${3 * sw}` : d === 'dot' ? `${sw} ${sw}` : undefined)
function LineSvg({ it, sw, color, alpha }: { it: Item; sw: number; color: string; alpha: number }) {
  const y = it.h / 2, head = sw * 3
  const end = (kind: Item['lineEnd'], x: number, dir: 1 | -1) =>
    kind === 'arrow' ? <path d={`M${x - dir * head} ${y - head / 1.4} L${x} ${y} L${x - dir * head} ${y + head / 1.4}`} fill="none" stroke={color} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />
      : kind === 'triangle' ? <path d={`M${x - dir * head} ${y - head / 1.6} L${x} ${y} L${x - dir * head} ${y + head / 1.6} Z`} fill={color} />
        : kind === 'dot' ? <circle cx={x - (dir * head) / 2} cy={y} r={head / 2} fill={color} /> : null
  // Strich endet vor gefüllten Spitzen, sonst ragt er bei dicken Linien heraus
  const inset = (k: Item['lineEnd']) => (k === 'triangle' || k === 'dot' ? head * 0.8 : 0)
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${it.w} ${it.h}`} style={{ display: 'block', overflow: 'visible', opacity: alpha }}>
      <line x1={inset(it.lineStart)} y1={y} x2={it.w - inset(it.lineEnd)} y2={y} stroke={color} strokeWidth={sw} strokeDasharray={dashArray(it.dash, sw)} />
      {end(it.lineStart, 0, -1)}
      {end(it.lineEnd, it.w, 1)}
    </svg>
  )
}

// Vorschau der Texteffekte; Maße in em, damit sie mit der Schrift skalieren (Export: patch-xml.ts textEffect, gleiche Werte)
function effectCss(effect: Item['effect'], color: string): CSSProperties {
  switch (effect) {
    case 'shadow': return { textShadow: '0.05em 0.05em 0.04em rgba(0, 0, 0, 0.45)' }
    case 'lift': return { textShadow: '0 0.08em 0.4em rgba(0, 0, 0, 0.35)' }
    case 'hollow': return { color: 'transparent', WebkitTextStroke: `max(1px, 0.03em) ${color}` }
    case 'neon': return { textShadow: `0 0 0.12em ${rgba(color, 0.6)}, 0 0 0.25em ${rgba(color, 0.6)}` }
    default: return {}
  }
}

// QR-Code als SVG mit hellem Rand (Ruhezone); Export wie Icons als gerastertes Bild (measure.ts svgOf)
export function QrCode(p: { text: string; slot: string; color: string; bg: string; className?: string; build?: number; style?: CSSProperties; attrs?: Record<string, string | undefined> }) {
  const d = useMemo(() => {
    if (!p.text) return { n: 1, path: '' }
    const m = QRCode.create(p.text, { errorCorrectionLevel: 'M' }).modules
    let path = ''
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.get(x, y)) path += `M${x + 2} ${y + 2}h1v1h-1z`
    return { n: m.size + 4, path }
  }, [p.text])
  return (
    <span {...p.attrs} className={`icon ${p.className ?? ''}`} data-pptx="icon" data-slot={p.slot} data-build={p.build} style={p.style}>
      <svg viewBox={`0 0 ${d.n} ${d.n}`} width="100%" height="100%" shapeRendering="crispEdges">
        <rect width={d.n} height={d.n} fill={p.bg} />
        <path d={d.path} fill={p.color} />
      </svg>
    </span>
  )
}

// Eigene Schrift (theme.customFont) einmal pro Datei registrieren; Messen erst danach, sonst misst Autofit die Ersatzschrift
const customFonts = new Map<string, Promise<void>>()
export function loadCustomFont(deck: Deck): Promise<void> {
  const cf = deck.theme.customFont
  if (!cf) return Promise.resolve()
  const key = `${cf.family}|${cf.regular}|${cf.bold ?? ''}`
  let p = customFonts.get(key)
  if (!p) {
    const faces = [new FontFace(cf.family, `url("${cf.regular}")`, { weight: '400' }), ...(cf.bold ? [new FontFace(cf.family, `url("${cf.bold}")`, { weight: '700' })] : [])]
    p = Promise.all(faces.map((f) => f.load().then((ff) => void document.fonts.add(ff)))).then(() => {}, (e) => console.warn('[font] eigene Schrift lädt nicht', e))
    customFonts.set(key, p)
  }
  return p
}

export const fontCss = (it: Item) => (it.font === 'head' || !it.font ? 'var(--font-head)' : it.font === 'body' ? 'var(--font-body)' : `'${FONTS[it.font as FontName]?.css ?? it.font}'`)

// Audio: runder Lautsprecher-Knopf; beim Präsentieren spielt ein Klick ab bzw. pausiert (Klick blättert dann nicht weiter)
function AudioItem({ it, attrs, pos, slot, live, color }: { it: Item; attrs: Record<string, string | undefined>; pos: CSSProperties; slot: string; live?: boolean; color: string }) {
  const ref = useRef<HTMLAudioElement>(null)
  const Cmp = icons.Volume2
  return (
    <div {...attrs} className="free-media" data-pptx="media" data-media="audio" data-slot={slot} data-src={it.src}
      onClick={live ? (e) => { e.stopPropagation(); const a = ref.current!; a.paused ? void a.play() : a.pause() } : undefined}
      style={{ ...pos, borderRadius: '50%', background: color, color: readableOn(color), display: 'grid', placeItems: 'center', opacity: it.opacity, cursor: live ? 'pointer' : undefined }}>
      <Cmp width="50%" height="50%" strokeWidth={2} />
      {live && <audio ref={ref} src={it.src} autoPlay={it.autoplay} loop={it.loop} />}
    </div>
  )
}

function FreeItem({ it }: { it: Item }) {
  const { theme, editable, editing, onEdit, live } = useSlide()
  const slot = `items.${it.id}`
  const attrs = { 'data-item': it.id, 'data-rot': it.rot ? String(it.rot) : undefined, 'data-anim': it.anim && it.anim !== 'none' ? it.anim : undefined }
  const pos: CSSProperties = { position: 'absolute', left: it.x, top: it.y, width: it.w, height: it.h, transform: it.rot ? `rotate(${it.rot}deg)` : undefined }
  const alpha = it.opacity ?? 1
  switch (it.kind) {
    case 'text': {
      const edit = editable && editing === it.id
      return (
        <div
          {...attrs}
          className="t free-text"
          data-pptx="text" data-slot={slot} data-role="free" data-font={it.font === 'body' ? 'body' : 'head'} data-face={it.font && it.font !== 'head' && it.font !== 'body' ? it.font : undefined}
          data-effect={it.effect && it.effect !== 'none' ? JSON.stringify({ type: it.effect, color: it.effectColor ?? it.color ?? theme.c.text }) : undefined}
          contentEditable={edit || undefined}
          suppressContentEditableWarning
          onBlur={edit ? (e) => onEdit?.(slot, e.currentTarget.innerText.replace(/\n$/, '')) : undefined}
          style={{
            ...pos, height: undefined, minHeight: 10, fontFamily: fontCss(it), fontSize: it.size ?? 32, fontWeight: it.bold ? 700 : 400,
            fontStyle: it.italic ? 'italic' : undefined, textDecoration: it.underline ? 'underline' : undefined, color: it.color ?? theme.c.text,
            textAlign: it.align ?? 'left', lineHeight: it.lineHeight ?? 1.2, letterSpacing: it.spacing ? `${it.spacing}em` : undefined,
            textTransform: it.upper ? 'uppercase' : undefined, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', opacity: alpha < 1 ? alpha : undefined,
            ...effectCss(it.effect, it.effectColor ?? it.color ?? theme.c.text),
          }}
        >
          {it.text ?? ''}
        </div>
      )
    }
    case 'image':
      return <Img src={it.src ?? ''} slot={slot} look={it.look} round={it.round} mask={it.mask} adjust={it.adjust} crop={it.crop} alpha={alpha < 1 ? alpha : undefined} className="free-img"
        attrs={{ ...attrs, 'data-flip': it.flipX ? '' : undefined }}
        style={{ ...pos, borderRadius: it.round ? undefined : it.radius, transform: [pos.transform, it.flipX && 'scaleX(-1)'].filter(Boolean).join(' ') || undefined }} />
    case 'video':
      return (
        <div {...attrs} className="free-media" data-pptx="media" data-media="video" data-slot={slot} data-src={it.src} data-poster={it.poster} style={{ ...pos, opacity: alpha < 1 ? alpha : undefined, borderRadius: it.radius, overflow: 'hidden', background: '#000' }}>
          <video src={it.src} poster={it.poster} muted={!live || it.muted} loop={it.loop} autoPlay={live && it.autoplay} controls={live} playsInline preload="metadata"
            onClick={live ? (e) => e.stopPropagation() : undefined} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: live ? 'auto' : 'none' }} />
        </div>
      )
    case 'audio':
      return <AudioItem it={it} attrs={attrs} pos={pos} slot={slot} live={live} color={it.color ?? theme.c.accent} />
    case 'qr':
      return <QrCode text={it.text ?? ''} slot={slot} color={it.color ?? '#000000'} bg={it.fill ?? '#FFFFFF'} attrs={attrs} style={{ ...pos, opacity: alpha < 1 ? alpha : undefined }} />
    case 'graphic': {
      const g = GRAPHICS[it.graphic ?? ''] ?? GRAPHICS.squiggle
      return (
        <span {...attrs} className="icon" data-pptx="icon" data-slot={slot} style={{ ...pos, color: it.color ?? theme.c.accent, opacity: alpha < 1 ? alpha : undefined }}>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style={{ overflow: 'visible' }}>
            <path d={g.d} fill={g.fill ? 'currentColor' : 'none'} stroke={g.fill ? 'none' : 'currentColor'} strokeWidth={it.strokeW ?? 6} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </svg>
        </span>
      )
    }
    case 'icon': {
      const Cmp = icons[pascal(it.icon ?? 'star') as keyof typeof icons] ?? icons.Star
      return (
        <span {...attrs} className="icon" data-pptx="icon" data-slot={slot} style={{ ...pos, color: it.color ?? theme.c.accent, opacity: alpha < 1 ? alpha : undefined }}>
          <Cmp width="100%" height="100%" strokeWidth={it.strokeW ?? 1.75} />
        </span>
      )
    }
    case 'chart':
      return it.spec ? <ChartBox spec={it.spec} slot={slot} attrs={attrs} style={{ ...pos, transform: undefined }} /> : null
    default: {
      const shape = it.shape ?? 'rect'
      const fill = it.fill ? rgba(it.fill, alpha) : 'transparent'
      if (shape === 'rect' || shape === 'ellipse')
        return (
          <div
            {...attrs}
            data-pptx="box" data-slot={slot} data-ellipse={shape === 'ellipse' ? '' : undefined}
            style={{
              ...pos, backgroundColor: fill, backgroundImage: it.fill && it.fill2 ? `linear-gradient(135deg, ${fill}, ${rgba(it.fill2, alpha)})` : undefined,
              border: it.stroke && it.strokeW ? `${it.strokeW}px ${it.dash === 'dash' ? 'dashed' : it.dash === 'dot' ? 'dotted' : 'solid'} ${it.stroke}` : undefined,
              borderRadius: shape === 'ellipse' ? '50%' : it.radius, boxShadow: it.shadow ? '0px 12px 32px rgba(0, 0, 0, 0.28)' : undefined,
            }}
          />
        )
      const sw = it.strokeW ?? (shape === 'line' ? 4 : 0)
      return (
        <div {...attrs} data-pptx="box" data-slot={slot} data-shape={shape} data-fill={it.fill} data-alpha={alpha} data-stroke={it.stroke ?? (shape === 'line' ? it.fill : undefined)} data-sw={sw}
          data-ls={it.lineStart} data-le={it.lineEnd} data-dash={it.dash} style={pos}>
          {shape === 'line' ? <LineSvg it={it} sw={sw} color={it.stroke ?? it.fill ?? theme.c.text} alpha={alpha} /> : (
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style={{ display: 'block', overflow: 'visible' }}>
              <path d={shapePath(shape, it.w, it.h)} fillRule="evenodd" fill={fill} stroke={it.stroke && sw ? it.stroke : 'none'} strokeWidth={sw} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeDasharray={dashArray(it.dash, sw)} />
            </svg>
          )}
        </div>
      )
    }
  }
}

// ---------- SlideView: one slide, scaled to `width`, autofitted ----------

export function SlideView(p: { deck: Deck; index: number; width?: number; editable?: boolean; editing?: string; onEdit?: (slot: string, text: string) => void; onFit?: (fit: Measured['fit']) => void; print?: boolean; live?: boolean }) {
  const size = sizeOf(p.deck)
  const width = p.width ?? size.w
  const host = useRef<HTMLDivElement>(null)
  const last = useRef('')
  const theme = useMemo(() => resolveTheme(p.deck.theme), [JSON.stringify(p.deck.theme)])
  const slide = p.deck.slides[p.index]
  const Layout = slide && COMPONENTS[slide.layout]

  useLayoutEffect(() => {
    const root = host.current?.querySelector<HTMLElement>('.slide')
    if (!root) return
    const run = () => {
      const fit = autofit(root)
      const key = JSON.stringify(fit)
      if (key !== last.current) (last.current = key), p.onFit?.(fit)
    }
    run()
    Promise.all([document.fonts.ready, loadCustomFont(p.deck)]).then(run)
  })

  const ctx: Ctx = { theme, deck: p.deck, index: p.index, editable: !!p.editable, onEdit: p.onEdit, print: !!p.print, editing: p.editing, live: p.live }
  return (
    <div className="slide-host" style={{ width, height: (width * size.h) / size.w }} ref={host}>
      <div style={{ transform: `scale(${width / size.w})`, transformOrigin: '0 0', width: size.w, height: size.h }}>
        {p.print && <style>{`@page { size: ${size.w}px ${size.h}px; margin: 0; }`}</style>}
        <SlideCtx.Provider value={ctx}>
          {Layout ? <Layout c={slide.content ?? {}} v={slide.variant} /> : <Frame><T role="h1" slot="_error">{`Unbekanntes Layout: ${slide?.layout}`}</T></Frame>}
        </SlideCtx.Provider>
      </div>
    </div>
  )
}

// Immutable set by content path ("kpis.1.value").
export function setAt(obj: any, path: string, value: unknown): any {
  const [head, ...rest] = path.split('.')
  const key = Array.isArray(obj) ? Number(head) : head
  const copy = Array.isArray(obj) ? [...obj] : { ...obj }
  copy[key] = rest.length ? setAt(obj?.[key] ?? {}, rest.join('.'), value) : value
  return copy
}
