import { Fragment, type ReactNode } from 'react'
import type { z } from 'zod'
import { LAYOUTS } from '../shared/layouts'
import { Backdrop, Box, ChartBox, Frame, Icon, Img, QrCode, T, onPhoto, photoOf, rgba, useSlide } from './slide'
import { annotation } from '../shared/charts'
import { EXTRA_COMPONENTS } from './layouts-extra'

type C<K extends keyof typeof LAYOUTS> = z.infer<(typeof LAYOUTS)[K]['schema']>
type Props<K extends keyof typeof LAYOUTS> = { c: C<K>; v?: string }

function Eyebrow({ text, center }: { text?: string; center?: boolean }) {
  if (!text) return null
  return (
    <div className={`eyebrow-wrap ${center ? 'center' : ''}`}>
      <T role="eyebrow" slot="eyebrow">{text}</T>
    </div>
  )
}

export function Header({ c, maxLines = 2 }: { c: { eyebrow?: string; title: string }; maxLines?: number }) {
  const s = useSlide().deck.slides[useSlide().index]
  if (s?.frame === 'split' && (LAYOUTS[s.layout as keyof typeof LAYOUTS] as { frames?: string[] })?.frames?.includes('split')) maxLines = 6 // schmale Titelspalte
  return (
    <div className="hdr">
      <Eyebrow text={c.eyebrow} />
      <T role="h1" slot="title" maxLines={maxLines} className="title">{c.title}</T>
    </div>
  )
}

function Points({ items, base, build }: { items?: string[]; base: string; build?: number }) {
  if (!items?.length) return null
  return (
    <div className="points">
      {items.map((p, j) => (
        <div className="point" key={j}>
          <Box slot={`_pd.${base}.${j}`} className="pdot" ellipse build={build} />
          <T role="body" slot={`${base}.${j}`} build={build}>{p}</T>
        </div>
      ))}
    </div>
  )
}

function Cover({ c, v }: Props<'cover'>) {
  const { theme } = useSlide()
  const img = photoOf(c.image)
  const photo = !!img?.src
  return (
    <Frame decor="hero" media={photo && <Backdrop image={img!} scrim={v === 'center' ? 'full' : 'left'} />}>
      <div className={`cover ${v === 'center' ? 'center' : ''} ${photo ? 'on-photo' : ''}`} style={photo ? onPhoto(theme) : undefined}>
        <div className="cover-top">{theme.logo && <Img src={theme.logo} slot="_logo" className="cover-logo" contain />}</div>
        <div className="cover-main">
          <Eyebrow text={c.eyebrow} center={v === 'center'} />
          <T role="display" slot="title" maxLines={3} className="cover-title">{c.title}</T>
          {c.subtitle && <T role="body" slot="subtitle" maxLines={2} className="cover-sub">{c.subtitle}</T>}
        </div>
        <div className="cover-bottom">{c.meta && <T role="label" slot="meta" className="muted">{c.meta}</T>}</div>
      </div>
    </Frame>
  )
}

function Agenda({ c }: Props<'agenda'>) {
  return (
    <Frame>
      <div className="agenda">
        <div className="agenda-side">
          <T role="h1" slot="title" maxLines={2}>{c.title}</T>
        </div>
        <div className="agenda-list" data-fit data-slot="items">
          {c.items.map((it, i) => {
            const inner = (
              <>
                <T role="h2" slot={`_num.${i}`} className="agenda-num" build={i}>{String(i + 1).padStart(2, '0')}</T>
                <div className="agenda-text">
                  <T role="h2" slot={`items.${i}.title`} build={i}>{it.title}</T>
                  {it.desc && <T role="small" slot={`items.${i}.desc`} build={i}>{it.desc}</T>}
                </div>
              </>
            )
            return c.active === i ? (
              <Box key={i} slot={`_active.${i}`} className="agenda-row active" build={i}>{inner}</Box>
            ) : (
              <div key={i} className="agenda-row">{inner}</div>
            )
          })}
        </div>
      </div>
    </Frame>
  )
}

function Section({ c }: Props<'section'>) {
  const img = photoOf(c.image)
  const photo = !!img?.src
  return (
    <Frame decor="hero" safeClass={photo ? 'safe-left' : undefined} media={photo && (
      <div className="media right section-media"><Img src={img!.src} focus={img!.focus} look={img!.look ?? 'duotone'} slot="image" /></div>
    )}>
      <div className="section">
        {c.number && <T role="display" slot="number" className="section-num">{c.number}</T>}
        <T role="display" slot="title" maxLines={photo ? 3 : 2}>{c.title}</T>
        {c.subtitle && <T role="body" slot="subtitle" maxLines={photo ? 3 : 2} className="section-sub">{c.subtitle}</T>}
      </div>
    </Frame>
  )
}

function Statement({ c }: Props<'statement'>) {
  return (
    <Frame decor="hero">
      <div className="statement">
        <Eyebrow text={c.eyebrow} center />
        <T role="statement" slot="text" maxLines={4} className="statement-text" build={0}>{c.text}</T>
        {c.source && (
          <div className="statement-source">
            <div className="dash" />
            <T role="label" slot="source" className="muted" build={0}>{c.source}</T>
          </div>
        )}
      </div>
    </Frame>
  )
}

function Bullets({ c, v }: Props<'bullets'>) {
  const sub = c.items.some((it) => it.sub)
  // auto: 2–4 points that all have a sub line read better as a row of cards than as a left-heavy list
  const cards = c.items.length <= 4 && (v === 'cards' || (v !== 'list' && c.items.every((it) => it.sub)))
  return (
    <Frame>
      <Header c={c} />
      <div className={`bullets ${sub ? 'has-sub' : ''} ${cards ? 'as-cards' : ''}`} data-fit data-slot="items" style={cards ? { gridTemplateColumns: `repeat(${c.items.length}, 1fr)` } : undefined}>
        {c.items.map((it, i) => {
          const mark = it.icon ? (
            <Box slot={`_ib.${i}`} className="bullet-icon" build={i}>
              <Icon name={it.icon} slot={`_icon.${i}`} size={26} build={i} />
            </Box>
          ) : cards ? (
            <Box slot={`_ib.${i}`} className="bullet-icon" build={i}>
              <T role="label" slot={`_n.${i}`} build={i} className="bullet-num">{String(i + 1)}</T>
            </Box>
          ) : (
            <Box slot={`_dot.${i}`} className="bullet-dot" build={i} />
          )
          const text = (
            <div className="bullet-text">
              <T role={cards ? 'h3' : 'body'} slot={`items.${i}.text`} build={i} className="bullet-main">{it.text}</T>
              {it.sub && <T role="small" slot={`items.${i}.sub`} build={i}>{it.sub}</T>}
            </div>
          )
          return cards ? (
            <Box key={i} slot={`_card.${i}`} className="card bullet-card" build={i} fit>{mark}{text}</Box>
          ) : (
            <div className="bullet" key={i}>{mark}{text}</div>
          )
        })}
      </div>
    </Frame>
  )
}

function TwoColumn({ c, v }: Props<'two-column'>) {
  return (
    <Frame>
      <Header c={c} />
      <div className="cols">
        {(['left', 'right'] as const).map((k, i) => {
          const col = c[k]
          return (
            <Box key={k} slot={`_card.${k}`} className={`card col-card ${v === 'highlight-right' && k === 'right' ? 'hl' : ''}`} build={i} fit>
              <T role="h2" slot={`${k}.heading`} build={i}>{col.heading}</T>
              {col.text && <T role="body" slot={`${k}.text`} build={i}>{col.text}</T>}
              <Points items={col.points} base={`${k}.points`} build={i} />
            </Box>
          )
        })}
      </div>
    </Frame>
  )
}

function Placeholder() {
  return (
    <div className="placeholder">
      <div className="ph-circle" />
      <div className="ph-circle two" />
    </div>
  )
}

function ImageText({ c, v }: Props<'image-text'>) {
  const right = v === 'image-right'
  return (
    <Frame media={<div className={`media ${right ? 'right' : ''}`}>{photoOf(c.image)?.src ? <Img {...photoOf(c.image)!} slot="image" /> : <Placeholder />}</div>} safeClass={right ? 'safe-left' : 'safe-right'}>
      <div className="imgtext" data-fit data-slot="_body">
        <Header c={c} maxLines={3} />
        {c.text && <T role="body" slot="text" className="muted-body" build={0}>{c.text}</T>}
        <Points items={c.points} base="points" build={0} />
      </div>
    </Frame>
  )
}

const arrow = (delta?: string) => (!delta ? undefined : /^[−-]/.test(delta.trim()) ? 'arrow-down-right' : /^\+/.test(delta.trim()) ? 'arrow-up-right' : undefined)

function KpiGrid({ c, v }: Props<'kpi-grid'>) {
  const plain = v === 'plain'
  const focus = c.focus !== undefined && c.focus < c.kpis.length ? c.focus : -1
  // Fokus-Karte ist 1,3-mal so breit
  const cols = c.kpis.map((_, i) => (i === focus ? 'minmax(0, 1.3fr)' : 'minmax(0, 1fr)')).join(' ')
  return (
    <Frame>
      <Header c={c} />
      <div className={`kpis n${c.kpis.length} ${plain ? 'plain' : ''}`} style={{ gridTemplateColumns: cols }}>
        {c.kpis.map((k, i) => {
          const dir = arrow(k.delta)
          return (
            <Box key={i} slot={`_card.${i}`} className={`${plain ? 'kpi-plain' : 'card'} kpi-card ${i === focus ? (plain ? 'big' : 'hl') : ''}`} build={i} fit>
              {plain ? i > 0 && <Box slot={`_rule.${i}`} className="kpi-rule" build={i} /> : <Box slot={`_bar.${i}`} className="kpi-bar" build={i} />}
              <T role="kpi" slot={`kpis.${i}.value`} build={i} className="kpi-value">{k.value}</T>
              <T role="label" slot={`kpis.${i}.label`} build={i} className="kpi-label">{k.label}</T>
              {k.delta && (
                <div className={`kpi-delta ${k.sentiment ?? 'neutral'}`}>
                  {dir && <Icon name={dir} slot={`_arrow.${i}`} size={18} build={i} />}
                  <T role="small" slot={`kpis.${i}.delta`} build={i}>{k.delta}</T>
                </div>
              )}
            </Box>
          )
        })}
      </div>
      {c.source && <T role="footer" slot="source" className="source">{c.source}</T>}
    </Frame>
  )
}

function ChartSlide({ c }: Props<'chart'>) {
  const note = annotation(c.chart) // CAGR/Differenz aus den Daten gerechnet, nicht von der KI geschrieben
  return (
    <Frame>
      <Header c={c} />
      <div className={`chart-wrap ${c.takeaway ? 'with-take' : ''}`}>
        <div className="chart-col">
          {(c.chart.unit || note) && (
            <div className="chart-meta">
              {c.chart.unit ? <T role="small" slot="_unit" className="chart-unit">{`in ${c.chart.unit}`}</T> : <span />}
              {note && (
                <Box slot="_ann" className="chart-ann" build={0}>
                  <T role="small" slot="_ann.text" build={0}>{note}</T>
                </Box>
              )}
            </div>
          )}
          <ChartBox spec={c.chart} slot="chart" build={0} className={c.chart.type === 'donut' ? 'donut' : undefined} />
        </div>
        {c.takeaway && (
          <Box slot="_take" className="card take-card" build={1} fit>
            {c.takeaway.value && <T role="kpi" slot="takeaway.value" build={1} className="kpi-value">{c.takeaway.value}</T>}
            <T role="body" slot="takeaway.text" build={1}>{c.takeaway.text}</T>
          </Box>
        )}
      </div>
      {c.source && <T role="footer" slot="source" className="source">{c.source}</T>}
    </Frame>
  )
}

function Timeline({ c }: Props<'timeline'>) {
  return (
    <Frame>
      <Header c={c} />
      <div className={`tl ${c.items.length > 4 ? 'dense' : ''}`} data-fit data-slot="items" style={{ gridTemplateColumns: `repeat(${c.items.length}, 1fr)` }}>
        <Box slot="_axis" className="tl-axis" />
        {c.items.map((it, i) => (
          <div className="tl-item" key={i}>
            <Box slot={`_dot.${i}`} className="tl-dot" ellipse build={i} />
            <Box slot={`_card.${i}`} className="card tl-card" build={i} fit>
              <T role="label" slot={`items.${i}.date`} build={i} className="tl-date">{it.date}</T>
              <T role="h3" slot={`items.${i}.title`} build={i}>{it.title}</T>
              {it.desc && <T role="label" slot={`items.${i}.desc`} build={i} className="muted">{it.desc}</T>}
            </Box>
          </div>
        ))}
      </div>
    </Frame>
  )
}

function Process({ c }: Props<'process'>) {
  return (
    <Frame>
      <Header c={c} />
      <div className="proc">
        {c.steps.map((s, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <div className="proc-arrow">
                <Icon name="chevron-right" slot={`_arrow.${i}`} size={26} build={i} />
              </div>
            )}
            <Box slot={`_card.${i}`} className="card proc-card" build={i} fit>
              <div className="proc-head">
                <Box slot={`_badge.${i}`} className="proc-badge" ellipse build={i}>
                  <T role="label" slot={`_n.${i}`} build={i}>{String(i + 1)}</T>
                </Box>
                {s.icon && <Icon name={s.icon} slot={`_icon.${i}`} size={28} build={i} className="proc-icon" />}
              </div>
              <T role="h3" slot={`steps.${i}.title`} build={i}>{s.title}</T>
              {s.desc && <T role="label" slot={`steps.${i}.desc`} build={i} className="muted">{s.desc}</T>}
            </Box>
          </Fragment>
        ))}
      </div>
    </Frame>
  )
}

function Closing({ c }: Props<'closing'>) {
  const { theme } = useSlide()
  const img = photoOf(c.image)
  const photo = !!img?.src
  return (
    <Frame decor="hero" media={photo && <Backdrop image={img!} scrim="left" />}>
      <div className={`closing ${photo ? 'on-photo' : ''}`} style={photo ? onPhoto(theme) : undefined}>
        <div className="closing-main">
          <T role="display" slot="title" maxLines={3} className="cover-title">{c.title}</T>
          {c.subtitle && <T role="body" slot="subtitle" maxLines={2} className="cover-sub">{c.subtitle}</T>}
        </div>
        <div className="closing-bottom">
          {c.contact?.length ? (
            <div className="contact">
              {c.contact.map((x, i) => <T key={i} role="label" slot={`contact.${i}`}>{x}</T>)}
            </div>
          ) : <div />}
          <div className="closing-right">
            {theme.logo && <Img src={theme.logo} slot="_logo" className="cover-logo" contain />}
            {c.qr && <QrCode text={c.qr} slot="_qr" color="#000000" bg="#FFFFFF" className="closing-qr" />}
          </div>
        </div>
      </div>
    </Frame>
  )
}

// ---------- Foto-Layouts (Phase 4) ----------

// Innerhalb von Frame gerendert, damit die Karte die Grundfarbe des Folientons bekommt (ohne Foto: accent)
function PhotoCard({ children }: { children: ReactNode }) {
  const { theme } = useSlide()
  return <Box slot="_card" className="photo-card" style={{ background: rgba(theme.c.bg, 0.97) }}>{children}</Box>
}

function PhotoSlide({ c, v }: Props<'photo'>) {
  const { theme } = useSlide()
  const img = photoOf(c.image)
  const photo = !!img?.src
  const card = v === 'card'
  const text = (
    <>
      <Eyebrow text={c.eyebrow} />
      <T role="h1" slot="title" maxLines={3}>{c.title}</T>
      {c.subtitle && <T role="body" slot="subtitle" maxLines={3} className="muted">{c.subtitle}</T>}
    </>
  )
  // Ohne Foto: Akzentfläche statt Bild, damit Text und Kontrast stimmen
  return (
    <Frame decor="hero" tone={photo ? undefined : 'accent'} media={photo && <Backdrop image={img!} scrim={card ? 'none' : v === 'text-left' ? 'left' : 'bottom'} />}>
      <div className={`photo-slide ps-${v ?? 'text-bottom'}`} style={photo && !card ? onPhoto(theme) : undefined}>
        {card ? <PhotoCard>{text}</PhotoCard> : <div className="photo-text">{text}</div>}
      </div>
    </Frame>
  )
}

function Gallery({ c: raw, v }: Props<'gallery'>) {
  const c = raw.look ? { ...raw, images: raw.images.map((it) => ({ ...it, image: { ...photoOf(it.image)!, look: raw.look } })) } : raw
  const n = c.images.length
  const mosaic = v === 'mosaic' && n > 2 // ein großes Bild links, die übrigen rechts gestapelt
  return (
    <Frame>
      <Header c={c} />
      <div className="gallery" style={mosaic ? { gridTemplateColumns: '1.55fr 1fr', gridTemplateRows: `repeat(${n - 1}, minmax(0, 1fr))` } : { gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }} data-fit data-slot="images">
        {c.images.map((it, i) => {
          const img = photoOf(it.image)
          return (
            <div className="gal-cell" key={i} style={mosaic && i === 0 ? { gridRow: '1 / -1' } : undefined}>
              {img?.src ? <Img {...img} slot={`images.${i}.image`} className="gal-img" build={i} /> : <div className="gal-img gal-ph"><Placeholder /></div>}
              {it.caption && <T role="label" slot={`images.${i}.caption`} className="muted" build={i}>{it.caption}</T>}
            </div>
          )
        })}
      </div>
    </Frame>
  )
}

function Quote({ c }: Props<'quote'>) {
  const img = photoOf(c.image)
  return (
    <Frame decor="hero">
      <div className={`quote ${img ? 'with-portrait' : ''}`}>
        {img && (img.src ? <Img {...img} slot="image" className="quote-portrait" round={!img.mask} /> : <div className="quote-portrait ph"><Placeholder /></div>)}
        <div className="quote-body">
          <T role="display" slot="_mark" className="quote-mark">{'\u201C'}</T>
          <T role="statement" slot="text" maxLines={5} className="quote-text" build={0}>{c.text}</T>
          <div className="quote-by">
            <T role="label" slot="author" className="quote-author" build={0}>{c.author}</T>
            {c.role && <T role="small" slot="role" build={0}>{c.role}</T>}
          </div>
        </div>
      </div>
    </Frame>
  )
}

export const COMPONENTS: Record<string, (p: { c: any; v?: string }) => ReactNode> = {
  cover: Cover,
  agenda: Agenda,
  section: Section,
  statement: Statement,
  bullets: Bullets,
  'two-column': TwoColumn,
  'image-text': ImageText,
  'kpi-grid': KpiGrid,
  chart: ChartSlide,
  timeline: Timeline,
  process: Process,
  closing: Closing,
  photo: PhotoSlide,
  gallery: Gallery,
  quote: Quote,
  ...EXTRA_COMPONENTS,
}
