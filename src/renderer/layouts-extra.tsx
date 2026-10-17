// Komponenten zu src/shared/layouts-extra.ts: Executive Summary, Optionsvergleich, 2×2-Matrix.
// Nur Primitive aus slide.tsx (T, Box → native PPTX-Objekte); Trennlinien ohne data-pptx landen im Hintergrundbild.
import type { z } from 'zod'
import { EXTRA_LAYOUTS } from '../shared/layouts-extra'
import { withTone } from '../shared/themes'
import { Header } from './layouts'
import { assetOf } from './ui/itemOps'
import { Backdrop, Box, Frame, Icon, Img, QrCode, T, onPhoto, photoOf, rgba, useSlide } from './slide'
import './layouts-extra.css'

type Props<K extends keyof typeof EXTRA_LAYOUTS> = { c: z.infer<(typeof EXTRA_LAYOUTS)[K]['schema']>; v?: string }

function Summary({ c }: Props<'summary'>) {
  const last = c.points.length
  return (
    <Frame>
      <Header c={c} />
      <div className={`sum ${c.recommendation ? 'with-rec' : ''}`}>
        <div className="sum-list" data-fit data-slot="points">
          {c.points.map((p, i) => (
            <div className="sum-row" key={i}>
              <T role="h2" slot={`_n.${i}`} build={i} className="sum-num">{String(i + 1).padStart(2, '0')}</T>
              <div className="sum-text">
                <T role="h3" slot={`points.${i}.title`} build={i}>{p.title}</T>
                {p.text && <T role="small" slot={`points.${i}.text`} build={i}>{p.text}</T>}
              </div>
            </div>
          ))}
        </div>
        {c.recommendation && (
          <Box slot="_rec" className="sum-rec" build={last} fit>
            <T role="eyebrow" slot="_rec.label" build={last}>Empfehlung</T>
            <T role="body" slot="recommendation" build={last}>{c.recommendation}</T>
          </Box>
        )}
      </div>
    </Frame>
  )
}

// Harvey Ball 0–4 als kleines SVG (exportiert wie Icons als Bild; Farbe = currentColor).
function Harvey({ score, slot, build }: { score: number; slot: string; build?: number }) {
  const s = Math.max(0, Math.min(4, Math.round(score)))
  const a = (s / 4) * 2 * Math.PI
  const x = (16 + 13 * Math.sin(a)).toFixed(2), y = (16 - 13 * Math.cos(a)).toFixed(2)
  return (
    <span className="harvey" data-pptx="icon" data-slot={slot} data-build={build} role="img" aria-label={`${s} von 4`}>
      <svg viewBox="0 0 32 32" width="30" height="30">
        <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="2" />
        {s === 4 ? <circle cx="16" cy="16" r="13" fill="currentColor" /> : s > 0 && <path d={`M16 16 L16 3 A13 13 0 ${s > 2 ? 1 : 0} 1 ${x} ${y} Z`} fill="currentColor" />}
      </svg>
    </span>
  )
}

function Options({ c }: Props<'options'>) {
  const rec = c.recommended !== undefined && c.recommended < c.options.length ? c.recommended : undefined
  const rows = c.criteria.length + 2 // Kopf, Kriterien, Fazit
  const at = (col: number, row: number) => ({ gridColumn: col + 1, gridRow: row + 1 })
  return (
    <Frame>
      <Header c={c} />
      <div className="opt" data-fit data-slot="options" style={{ gridTemplateColumns: `1.3fr repeat(${c.options.length}, 1fr)`, gridTemplateRows: `auto repeat(${c.criteria.length}, 1fr) auto` }}>
        {rec !== undefined && <Box slot="_rec" className="opt-hl" style={{ gridColumn: rec + 2, gridRow: `1 / ${rows + 1}` }} />}
        {c.options.map((o, j) => (
          <div className={`opt-head ${j === rec ? 'hl' : ''}`} key={`h${j}`} style={at(j + 1, 0)}>
            {j === rec && <Box slot="_badge" className="opt-badge"><T role="eyebrow" slot="_badge.text">Empfehlung</T></Box>}
            <T role="h3" slot={`options.${j}.name`} build={0}>{o.name}</T>
          </div>
        ))}
        {c.criteria.map((k, i) => (
          <div className="opt-crit" key={`c${i}`} style={at(0, i + 1)}>
            <T role="label" slot={`criteria.${i}`} build={0}>{k}</T>
          </div>
        ))}
        {c.options.map((o, j) =>
          c.criteria.map((_, i) => (
            <div className="opt-cell" key={`s${j}.${i}`} style={at(j + 1, i + 1)}>
              <Harvey score={o.scores[i] ?? 0} slot={`options.${j}.scores.${i}`} build={0} />
            </div>
          )),
        )}
        {c.options.map((o, j) => o.note && (
          <div className="opt-note" key={`n${j}`} style={at(j + 1, rows - 1)}>
            <T role="small" slot={`options.${j}.note`} build={0}>{o.note}</T>
          </div>
        ))}
      </div>
    </Frame>
  )
}

function Matrix({ c }: Props<'matrix'>) {
  const q = c.quadrants
  return (
    <Frame>
      <Header c={c} />
      <div className={`mx ${c.takeaway ? 'with-take' : ''}`}>
        <div className="mx-area">
          <T role="small" slot="y" className="mx-axis">{`↑ ${c.y}`}</T>
          <div className="mx-plot">
            {[0, 1, 2, 3].map((i) => (
              <Box key={i} slot={`_q.${i}`} className={`mx-q q${i}`}>
                {q && <T role="small" slot={`quadrants.${i}`} className="mx-qlabel">{q[i]}</T>}
              </Box>
            ))}
            {c.items.map((it, i) => {
              const hl = !c.highlight || it.label === c.highlight
              const side = it.x < 22 ? 'start' : it.x > 78 ? 'end' : 'mid' // Label am Rand nach innen ausrichten
              return (
                <div key={i} className={`mx-item ${side} ${it.y < 12 ? 'up' : ''}`} style={{ left: `${it.x}%`, top: `${100 - it.y}%` }}>
                  <Box slot={`_dot.${i}`} className={`mx-dot ${hl ? 'hl' : ''}`} ellipse build={i} />
                  <T role="small" slot={`items.${i}.label`} build={i} className={`mx-lbl ${hl && c.highlight ? 'hl' : ''}`}>{it.label}</T>
                </div>
              )
            })}
          </div>
          <T role="small" slot="x" className="mx-axis mx-x">{`${c.x} →`}</T>
        </div>
        {c.takeaway && (
          <Box slot="_take" className="card mx-take" build={c.items.length} fit>
            <T role="body" slot="takeaway" build={c.items.length}>{c.takeaway}</T>
          </Box>
        )}
      </div>
    </Frame>
  )
}


// ---------- Tranche A (CANVA-VERGLEICH 1.3) ----------

// ponytail: Tabelle aus nativen Textboxen und Flächen statt PowerPoint-Tabelle (Umbruch bleibt pixelgenau);
// native addTable, falls Nutzer in PowerPoint Zeilen einfügen wollen
const isNum = (v: string) => /^[−+-]?[\d.,\s]+(%|€|Mio|Mrd|Pkt\.?|Tsd\.?|k|M|€\s*[kM]?)?\s*€?$/.test(v.trim()) || /^[€$]\s?[\d.,]/.test(v.trim())
function Table({ c }: Props<'table'>) {
  const cols = `minmax(0, 1.4fr) repeat(${c.columns.length - 1}, minmax(0, 1fr))`
  const hl = c.highlight ?? {}
  const roomy = c.rows.length <= 4 && c.columns.length <= 4 // wenige Zeilen: Lesegröße statt Fußnotengröße
  const cell = (v: string, r: number, i: number) => (
    <T key={i} role={roomy && r >= 0 ? 'body' : 'label'} slot={r < 0 ? `columns.${i}` : `rows.${r}.${i}`} build={r < 0 ? 0 : r + 1}
      className={`tb-cell ${i > 0 && isNum(r < 0 ? (c.rows[0]?.[i] ?? '') : v) ? 'num' : ''} ${i === hl.col ? 'hl' : ''} ${i === 0 ? 'first' : ''}`}>{v}</T>
  )
  return (
    <Frame>
      <Header c={c} />
      <div className={`tb ${roomy ? 'roomy' : ''}`} data-fit data-slot="rows">
        <div className="tb-row tb-head" style={{ gridTemplateColumns: cols }}>{c.columns.map((v, i) => cell(v, -1, i))}</div>
        {c.rows.map((row, r) =>
          r === hl.row ? (
            <Box key={r} slot={`_hl.${r}`} className="tb-row tb-hl" build={r + 1} style={{ gridTemplateColumns: cols }}>{row.map((v, i) => cell(v, r, i))}</Box>
          ) : (
            <div key={r} className="tb-row" style={{ gridTemplateColumns: cols }}>{row.map((v, i) => cell(v, r, i))}</div>
          ),
        )}
      </div>
      {c.source && <T role="footer" slot="source" className="source">{c.source}</T>}
    </Frame>
  )
}

function BigNumber({ c, v }: Props<'big-number'>) {
  const img = photoOf(c.image)
  if (v === 'poster' && !img) return (
    <Frame>
      <div className="bign poster" data-fit data-slot="_body">
        <div className="bign-top">
          {c.eyebrow ? <T role="eyebrow" slot="eyebrow">{c.eyebrow}</T> : <div />}
          <div className="bign-side">
            <T role="h1" slot="label" maxLines={5} className="bign-label" build={0}>{c.label}</T>
            {c.context && <T role="body" slot="context" className="muted" build={0}>{c.context}</T>}
          </div>
        </div>
        <T role="hero" slot="value" className="bign-value" build={0} unit>{c.value}</T>
      </div>
      {c.source && <T role="footer" slot="source" className="source">{c.source}</T>}
    </Frame>
  )
  return (
    <Frame safeClass={img ? 'safe-left' : undefined} media={img && (
      <div className="media right">{img.src ? <Img {...img} slot="image" /> : <div className="placeholder" />}</div>
    )}>
      <div className={`bign ${img ? 'with-img' : ''}`} data-fit data-slot="_body">
        {c.eyebrow && <T role="eyebrow" slot="eyebrow">{c.eyebrow}</T>}
        <T role="hero" slot="value" className="bign-value" build={0} unit>{c.value}</T>
        <T role="h1" slot="label" maxLines={img ? 4 : 3} className="bign-label" build={0}>{c.label}</T>
        {c.context && <T role="body" slot="context" className="muted" build={0}>{c.context}</T>}
      </div>
      {c.source && <T role="footer" slot="source" className="source">{c.source}</T>}
    </Frame>
  )
}

function DocText({ c, v }: Props<'doc-text'>) {
  const two = v === 'two'
  const half = two ? Math.ceil(c.sections.length / 2) : c.sections.length
  const col = (items: typeof c.sections, off: number) => (
    <div className="doc-col">
      {items.map((s, i) => (
        <div className="doc-sec" key={off + i}>
          {s.heading && <T role="h3" slot={`sections.${off + i}.heading`} build={off + i}>{s.heading}</T>}
          <T role="body" slot={`sections.${off + i}.text`} build={off + i}>{s.text}</T>
        </div>
      ))}
    </div>
  )
  return (
    <Frame>
      <Header c={c} />
      {c.lead && <T role="body" slot="lead" className="doc-lead" build={0}>{c.lead}</T>}
      <div className={`doc ${two ? 'two' : ''}`} data-fit data-slot="sections">
        {col(c.sections.slice(0, half), 0)}
        {two && col(c.sections.slice(half), half)}
      </div>
      {c.source && <T role="footer" slot="source" className="source">{c.source}</T>}
    </Frame>
  )
}

function Offer({ c }: Props<'offer'>) {
  const last = c.totals.length - 1
  return (
    <Frame>
      <Header c={c} />
      {(c.to || c.meta) && (
        <div className="of-meta">
          {c.to && <T role="label" slot="to" className="of-to">{c.to}</T>}
          {c.meta && <T role="label" slot="meta" className="muted of-date">{c.meta}</T>}
        </div>
      )}
      <div className="of" data-fit data-slot="items">
        <div className="of-row of-head">
          <T role="label" slot="_h.name" className="muted">Position</T>
          <T role="label" slot="_h.qty" className="muted num">Menge</T>
          <T role="label" slot="_h.price" className="muted num">Betrag</T>
        </div>
        {c.items.map((it, i) => (
          <div className="of-row" key={i}>
            <div className="of-name">
              <T role="body" slot={`items.${i}.name`} build={i}>{it.name}</T>
              {it.detail && <T role="label" slot={`items.${i}.detail`} build={i} className="muted">{it.detail}</T>}
            </div>
            <T role="body" slot={`items.${i}.qty`} build={i} className="num">{it.qty ?? ''}</T>
            <T role="body" slot={`items.${i}.price`} build={i} className="num">{it.price}</T>
          </div>
        ))}
        <div className="of-tot">
          {c.totals.map((t, i) => (
            <div className={`of-tot-row ${i === last ? 'sum' : ''}`} key={i}>
              <T role={i === last ? 'h3' : 'body'} slot={`totals.${i}.label`} build={c.items.length}>{t.label}</T>
              <T role={i === last ? 'h3' : 'body'} slot={`totals.${i}.value`} build={c.items.length} className="num">{t.value}</T>
            </div>
          ))}
        </div>
      </div>
      {c.terms && <T role="label" slot="terms" className="muted of-terms">{c.terms}</T>}
    </Frame>
  )
}

// Flyer: top = Foto oben (36 %), full = Foto vollflächig mit Text unten, ohne Foto typografisch (Schlagzeile oben, alles andere als Block unten).
// Handlung typografisch wie im Druck üblich, gebündelt mit QR-Code und Kontakt zu einem Aktionsblock.
function Flyer({ c, v }: Props<'flyer'>) {
  const { theme } = useSlide()
  const img = photoOf(c.image)
  const full = v === 'full' && !!img?.src
  const top = !full && !!img
  const pts = c.points ?? []
  const sub = c.subtitle && <T role="body" slot="subtitle" maxLines={3} className="fly-sub">{c.subtitle}</T>
  return (
    <Frame decor="hero" media={full ? <Backdrop image={img!} scrim="bottom" /> : top && (
      <div className="fly-media">{img!.src ? <Img {...img!} slot="image" /> : <div className="placeholder" />}</div>
    )} safeClass={`fly-safe ${top ? 'fly-below' : ''}`}>
      <div className={`fly ${full ? 'fly-full' : top ? 'fly-top' : 'fly-type'}`} style={full ? onPhoto(theme) : undefined}>
        <div className="fly-head">
          {c.eyebrow && <T role="eyebrow" slot="eyebrow" className="fly-eyebrow">{c.eyebrow}</T>}
          <T role="display" slot="title" maxLines={top ? 3 : 4} className="fly-title">{c.title}</T>
          {(top || full) && sub}
        </div>
        {!top && !full && sub}
        {pts.length > 0 && (
          <div className="fly-pts" data-fit data-slot="points">
            {pts.map((p, i) => (
              <div className="fly-pt" key={i}>
                <T role="h3" slot={`points.${i}.head`} build={i} className="fly-pt-head">{p.head}</T>
                {p.text && <T role="small" slot={`points.${i}.text`} build={i}>{p.text}</T>}
              </div>
            ))}
          </div>
        )}
        <FlyerAction c={c} build={pts.length} />
      </div>
    </Frame>
  )
}

// Aktionsblock beider Flyerseiten: QR-Code, Handlung, Kontakt, Logo (gleiches DOM, damit Vorder- und Rückseite zusammenpassen).
function FlyerAction({ c, build }: { c: { cta: string; contact?: string[]; qr?: string }; build: number }) {
  const { theme } = useSlide()
  return (
    <div className="fly-foot">
      <div className="fly-act">
        {c.qr && <QrCode text={c.qr} slot="_qr" color="#000000" bg="#FFFFFF" className="fly-qr" build={build} />}
        <div className="fly-act-text">
          <T role="h2" slot="cta" maxLines={2} className="fly-cta" build={build}>{c.cta}</T>
          {c.contact?.map((x, i) => <T key={i} role="label" slot={`contact.${i}`} className="fly-contact" build={build}>{x}</T>)}
        </div>
      </div>
      {theme.logo && <Img src={theme.logo} slot="_logo" className="fly-logo" contain />}
    </div>
  )
}

// Flyer-Rückseite: Titel, Programm oder Preise als Liste mit fester Kopfspalte, Eckdaten in einer Zeile, unten derselbe Aktionsblock wie vorn.
function FlyerBack({ c }: Props<'flyer-back'>) {
  const n = c.items.length
  return (
    <Frame safeClass="fly-safe">
      <div className="fly flb">
        <div className="fly-head">
          {c.eyebrow && <T role="eyebrow" slot="eyebrow" className="fly-eyebrow">{c.eyebrow}</T>}
          <T role="h1" slot="title" maxLines={3} className="flb-title">{c.title}</T>
          {c.intro && <T role="body" slot="intro" maxLines={4} className="fly-sub">{c.intro}</T>}
        </div>
        <div className="flb-list" data-fit data-slot="items">
          {c.items.map((it, i) => (
            <div className="flb-row" key={i}>
              <T role="h3" slot={`items.${i}.head`} build={i} className="flb-head">{it.head}</T>
              <T role="body" slot={`items.${i}.text`} build={i}>{it.text}</T>
            </div>
          ))}
        </div>
        {!!c.facts?.length && (
          <div className={`flb-facts n${c.facts.length}`}>
            {c.facts.map((f, i) => (
              <div className="flb-fact" key={i}>
                <T role="label" slot={`facts.${i}.label`} build={n} className="muted">{f.label}</T>
                <T role="h3" slot={`facts.${i}.value`} build={n} className="flb-head">{f.value}</T>
              </div>
            ))}
          </div>
        )}
        <FlyerAction c={c} build={n} />
        {c.legal && <T role="label" slot="legal" className="muted flb-legal">{c.legal}</T>}
      </div>
    </Frame>
  )
}

function IconGrid({ c }: Props<'icon-grid'>) {
  const n = c.items.length
  return (
    <Frame>
      <Header c={c} />
      <div className="ig" data-fit data-slot="items" style={{ gridTemplateColumns: `repeat(${n === 4 ? 2 : 3}, minmax(0, 1fr))` }}>
        {c.items.map((it, i) => (
          <div className="ig-item" key={i}>
            <Box slot={`_badge.${i}`} className="ig-badge" ellipse build={i}><Icon name={it.icon} slot={`_icon.${i}`} size={30} build={i} /></Box>
            <div className="ig-text">
              <T role={n <= 4 ? 'h2' : 'h3'} slot={`items.${i}.head`} build={i}>{it.head}</T>
              {it.sub && <T role={n <= 4 ? 'body' : 'label'} slot={`items.${i}.sub`} build={i} className="muted">{it.sub}</T>}
            </div>
          </div>
        ))}
      </div>
    </Frame>
  )
}

function ProsCons({ c }: Props<'pros-cons'>) {
  const col = (k: 'pros' | 'cons', i: number) => (
    <div className={`pc-col pc-${k}`} key={k}>
      <T role="h2" slot={`${k === 'pros' ? 'prosLabel' : 'consLabel'}`} build={i}>{(k === 'pros' ? c.prosLabel : c.consLabel) ?? (k === 'pros' ? 'Dafür' : 'Dagegen')}</T>
      {c[k].map((p, j) => (
        <div className="pc-item" key={j}>
          <Box slot={`_pb.${k}.${j}`} className="pc-badge" ellipse build={i}><Icon name={k === 'pros' ? 'check' : 'x'} slot={`_pi.${k}.${j}`} size={18} build={i} /></Box>
          <T role="body" slot={`${k}.${j}`} build={i}>{p}</T>
        </div>
      ))}
    </div>
  )
  return (
    <Frame>
      <Header c={c} />
      <div className="pc" data-fit data-slot="pros">
        <div className="pc-cols">{col('pros', 0)}{col('cons', 1)}</div>
        {c.verdict && (
          <Box slot="_verdict" className="pc-verdict" build={2}>
            <Icon name="scale" slot="_vi" size={26} build={2} />
            <T role="h3" slot="verdict" build={2}>{c.verdict}</T>
          </Box>
        )}
      </div>
    </Frame>
  )
}

function ProblemSolution({ c }: Props<'problem-solution'>) {
  const round = useSlide().theme.elements === 'solid' // wie Points: Strich statt flacher Ellipse in der PPTX
  const card = (k: 'problem' | 'solution', i: number) => {
    const s = c[k]
    return (
      <Box key={k} slot={`_card.${k}`} className={`card ps-card ps-${k}`} build={i} fit>
        <T role="eyebrow" slot={`${k}.heading`} build={i}>{s.heading ?? (k === 'problem' ? 'Heute' : 'Mit uns')}</T>
        {s.text && <T role="h2" slot={`${k}.text`} build={i}>{s.text}</T>}
        {s.points?.map((p, j) => (
          <div className="point" key={j}>
            <Box slot={`_pd.${k}.${j}`} className="pdot" ellipse={round} build={i} />
            <T role="body" slot={`${k}.points.${j}`} build={i}>{p}</T>
          </div>
        ))}
      </Box>
    )
  }
  return (
    <Frame>
      <Header c={c} />
      <div className="psol">
        {card('problem', 0)}
        <Box slot="_arrow" className="ps-arrow" ellipse build={1}><Icon name="arrow-right" slot="_arrow.icon" size={28} build={1} /></Box>
        {card('solution', 1)}
      </div>
    </Frame>
  )
}

const initials = (name: string) => name.replace(/^(Dr\.|Prof\.)\s*/g, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
function Team({ c }: Props<'team'>) {
  const n = c.people.length
  return (
    <Frame>
      <Header c={c} />
      <div className={`team n${n}`} data-fit data-slot="people" style={{ gridTemplateColumns: `repeat(${n > 4 ? 3 : n}, minmax(0, 1fr))` }}>
        {c.people.map((p, i) => {
          const img = photoOf(p.image)
          return (
            <div className="tm" key={i}>
              {img?.src ? <Img {...img} slot={`people.${i}.image`} className="tm-pic" round={!img.mask} build={i} />
                : <Box slot={`_ini.${i}`} className="tm-pic tm-ini" ellipse build={i}><T role="h2" slot={`_ini.${i}.t`} build={i}>{initials(p.name)}</T></Box>}
              <T role={n <= 4 ? 'h2' : 'h3'} slot={`people.${i}.name`} build={i}>{p.name}</T>
              <T role={n <= 4 ? 'label' : 'small'} slot={`people.${i}.role`} build={i} className="tm-role">{p.role}</T>
              {p.line && <T role={n <= 4 ? 'label' : 'small'} slot={`people.${i}.line`} build={i} className="muted">{p.line}</T>}
            </div>
          )
        })}
      </div>
    </Frame>
  )
}

// ---------- Tranche B ----------

function Pricing({ c }: Props<'pricing'>) {
  return (
    <Frame>
      <Header c={c} />
      <div className="pr" data-fit data-slot="tiers" style={{ gridTemplateColumns: `repeat(${c.tiers.length}, minmax(0, 1fr))` }}>
        {c.tiers.map((t, i) => (
          <Box key={i} slot={`_card.${i}`} className={`card pr-card ${t.highlight ? 'hl' : ''}`} build={i} fit>
            <T role="eyebrow" slot={`tiers.${i}.name`} build={i}>{t.name}</T>
            <div className="pr-price">
              <T role="kpi" slot={`tiers.${i}.price`} build={i}>{t.price}</T>
              {t.period && <T role="small" slot={`tiers.${i}.period`} build={i}>{t.period}</T>}
            </div>
            <div className="pr-feat">
              {t.features.map((f, j) => (
                <div className="pc-item" key={j}>
                  <Icon name="check" slot={`_chk.${i}.${j}`} size={18} build={i} className="pr-chk" />
                  <T role="label" slot={`tiers.${i}.features.${j}`} build={i}>{f}</T>
                </div>
              ))}
            </div>
          </Box>
        ))}
      </div>
      {c.note && <T role="footer" slot="note" className="source">{c.note}</T>}
    </Frame>
  )
}

// Zahl aus „12.400“, „38 %“, „1,2 Mio“; NaN, wenn keine Zahl drinsteht
const num = (s: string) => parseFloat(s.split('–')[0].replace(/\.(?=\d{3})/g, '').replace(',', '.').replace(/[^\d.-]/g, ''))

function Funnel({ c }: Props<'funnel'>) {
  const n = c.stages.length
  const vals = c.stages.map((s) => num(s.value))
  const conv = vals.every((x) => x > 0) ? vals.map((x, i) => (i ? x / vals[i - 1] : 1)) : undefined // Übergangsquote je Stufe
  const drop = conv ? conv.indexOf(Math.min(...conv.slice(1))) : -1 // größter Abfall: die eine Stufe in Akzentfarbe
  return (
    <Frame>
      <Header c={c} />
      <div className={`fn ${c.takeaway ? 'with-take' : ''}`}>
        <div className="fn-bars" data-fit data-slot="stages">
          {c.stages.map((s, i) => (
            <div className="fn-row" key={i}>
              <Box slot={`_bar.${i}`} className={`fn-bar ${drop < 0 || i === drop ? 'hl' : ''}`} build={i} style={{ width: `${100 - (i * 55) / Math.max(1, n - 1)}%` }}>
                <T role="h3" slot={`stages.${i}.value`} build={i} className="fn-val">{s.value}</T>
              </Box>
              <div className="fn-side">
                <T role="label" slot={`stages.${i}.label`} build={i} className="fn-label">{s.label}</T>
                {conv && i > 0 && <T role="small" slot={`_conv.${i}`} build={i} className={i === drop ? 'fn-conv hl' : 'fn-conv'}>{`${Math.round(conv[i] * 100)} % der Vorstufe`}</T>}
              </div>
            </div>
          ))}
        </div>
        {c.takeaway && <Box slot="_take" className="card take-card" build={n} fit><T role="body" slot="takeaway" build={n}>{c.takeaway}</T></Box>}
      </div>
    </Frame>
  )
}

function MarketSize({ c }: Props<'market-size'>) {
  const rings = (['tam', 'sam', 'som'] as const)
  return (
    <Frame>
      <Header c={c} />
      <div className="ms">
        <div className="ms-rings">
          {rings.map((k, i) => <Box key={k} slot={`_ring.${k}`} className={`ms-ring ms-r-${k}`} ellipse build={i} />)}
        </div>
        <div className="ms-legend" data-fit data-slot="tam">
          {rings.map((k, i) => (
            <div className={`ms-item ms-${k}`} key={k}>
              <Box slot={`_dot.${k}`} className="ms-dot" ellipse build={i} />
              <div className="ms-text">
                <T role="kpi" slot={`${k}.value`} build={i} className="ms-val">{c[k].value}</T>
                <T role="label" slot={`${k}.label`} build={i}>{`**${k.toUpperCase()}** · ${c[k].label}`}</T>
              </div>
            </div>
          ))}
        </div>
      </div>
      {c.source && <T role="footer" slot="source" className="source">{c.source}</T>}
    </Frame>
  )
}

function Logos({ c }: Props<'logos'>) {
  const n = c.logos.length
  return (
    <Frame>
      <Header c={c} />
      <div className="lg" data-fit data-slot="logos" style={{ gridTemplateColumns: `repeat(${Math.min(n, 4)}, minmax(0, 1fr))` }}>
        {c.logos.map((l, i) => (
          <Box key={i} slot={`_tile.${i}`} className="lg-tile" build={i}>
            {l.src ? <Img src={l.src} slot={`logos.${i}.src`} contain look={c.mono ? 'mono' : undefined} className="lg-img" build={i} />
              : <T role="h3" slot={`logos.${i}.name`} build={i} className="lg-name">{l.name}</T>}
          </Box>
        ))}
      </div>
    </Frame>
  )
}

// Bewerbung – Deckblatt: zwei Pole wie in einer gedruckten Mappe. Oben Stelle und Unternehmen, unten Foto, Name und Kontakt,
// rechts daneben der Inhalt der Mappe als Liste mit Haarlinien (Linien an Hüllen ohne data-pptx, sonst fehlen sie im Hintergrundbild).
function ApplicationCover({ c }: Props<'application-cover'>) {
  const img = photoOf(c.photo)
  const toc = c.contents ?? []
  return (
    <Frame safeClass="bw-safe">
      <div className="bw">
        <div className="bw-head">
          {c.eyebrow && <T role="eyebrow" slot="eyebrow" className="bw-eyebrow">{c.eyebrow}</T>}
          <T role="display" slot="title" maxLines={3} className="bw-title">{c.title}</T>
          {c.org && <T role="body" slot="org" maxLines={2} className="bw-org">{c.org}</T>}
        </div>
        <div className={`bw-foot ${toc.length ? 'with-toc' : ''}`}>
          <div className="bw-person">
            {img && <div className="bw-photo">{img.src ? <Img {...img} slot="photo" build={0} /> : <div className="placeholder" />}</div>}
            <T role="h1" slot="name" maxLines={2} className="bw-name" build={0}>{c.name}</T>
            {c.contact?.map((x, i) => <T key={i} role="label" slot={`contact.${i}`} className="bw-contact" build={0}>{x}</T>)}
          </div>
          {toc.length > 0 && (
            <div className="bw-toc">
              <T role="eyebrow" slot="_toc.label" className="bw-toc-label" build={1}>Inhalt</T>
              {toc.map((x, i) => <div className="bw-toc-row" key={i}><T role="body" slot={`contents.${i}`} build={1}>{x}</T></div>)}
            </div>
          )}
        </div>
      </div>
    </Frame>
  )
}

// Videoclip: Standbild am Start des ersten Ausschnitts, Hook darüber. Keine Wiedergabe (v1); MP4 baut export-video.ts.
// Standbild per asset://…?frame=<s> (ffmpeg, index.ts) als CSS-Hintergrund, kein <video>: im Offscreen-Fenster hängt das Spulen. Ohne data-pptx landet es im Hintergrund-PNG statt als Video im PPTX.
function Clip({ c }: Props<'clip'>) {
  const { theme } = useSlide()
  // Dunkler Grund wie im MP4 (Video unverfärbt, Hook hell): auf hellen Themes invertiert, damit Scrim, Hook-Farbe und Lint-Kontrast zusammenpassen
  const tone = theme.dark ? undefined : 'invert'
  const d = withTone(theme, tone).c.bg
  const url = c.video.startsWith('/') ? assetOf(c.video) : c.video
  const p0 = c.parts[0]
  const media = (
    <div className="clip-media">
      {url ? <div className="clip-still" style={{ backgroundImage: `url("${url}?frame=${p0.start}")`, backgroundPosition: `${(p0.focus ?? 0.5) * 100}% 50%` }} /> : <div className="clip-ph" style={{ background: d }} />}
      {c.hook && <Box slot="_scrim" className="scrim clip-scrim" style={{ backgroundImage: `linear-gradient(180deg, ${rgba(d, 0.85)} 0%, ${rgba(d, 0.55)} 55%, ${rgba(d, 0)} 100%)` }} />}
    </div>
  )
  return (
    <Frame tone={tone} media={media}>
      <div className="clip">
        {c.hook && <T role="h1" slot="hook" maxLines={4} className="clip-hook">{c.hook}</T>}
      </div>
    </Frame>
  )
}

// Urkunde (A4 quer): Art und Titel oben, Empfänger als Held darunter, Ort/Datum und Unterschriftsfelder unten in einem Spaltenraster.
// Würde über Satzspiegel, Größe und Weißraum statt Zierrahmen oder Siegel; die einzigen Linien sind die zum Unterschreiben.
function Certificate({ c }: Props<'certificate'>) {
  const { theme } = useSlide()
  const signers = c.signers ?? []
  return (
    <Frame safeClass="ur-safe">
      {theme.logo && <Img src={theme.logo} slot="_logo" className="ur-logo" contain />}
      <div className="ur-head">
        {c.eyebrow && <T role="eyebrow" slot="eyebrow" className="ur-eyebrow">{c.eyebrow}</T>}
        <T role="h1" slot="title" maxLines={2} className="ur-title">{c.title}</T>
      </div>
      <div className="ur-main">
        <T role="display" slot="recipient" maxLines={2} className="ur-name" build={0}>{c.recipient}</T>
        {c.text && <T role="body" slot="text" className="ur-text" build={0}>{c.text}</T>}
      </div>
      {(c.date || signers.length > 0) && (
        <div className="ur-foot">
          {c.date && <T role="body" slot="date" className="ur-date" build={1}>{c.date}</T>}
          {signers.map((s, i) => (
            <div className="ur-sign" key={i}>
              {s.name && <T role="body" slot={`signers.${i}.name`} className="ur-signer" build={1}>{s.name}</T>}
              <T role="body" slot={`signers.${i}.role`} className="muted" build={1}>{s.role}</T>
            </div>
          ))}
        </div>
      )}
    </Frame>
  )
}

// Einladung: zwei Pole wie der Flyer – Anlass, Titel, Text und Absender oben, Eckdaten und Antwort unten; mit Foto steht es oben.
function Invitation({ c }: Props<'invitation'>) {
  const { theme } = useSlide()
  const img = photoOf(c.image)
  const n = c.facts.length
  return (
    <Frame media={img && (
      <div className="inv-media">{img.src ? <Img {...img} slot="image" /> : <div className="placeholder" />}</div>
    )} safeClass={`inv-safe ${img ? 'inv-below' : ''}`}>
      <div className={`inv ${img ? '' : 'inv-type'}`}>
        <div className="inv-head">
          {c.eyebrow && <T role="eyebrow" slot="eyebrow" className="inv-eyebrow">{c.eyebrow}</T>}
          <T role="display" slot="title" maxLines={img ? 3 : 4} className="inv-title">{c.title}</T>
          {c.text && <T role="body" slot="text" className="inv-text">{c.text}</T>}
          {c.host && <T role="body" slot="host" className="inv-host">{c.host}</T>}
        </div>
        <div className="inv-end">
          <div className="inv-facts">
            {c.facts.map((f, i) => (
              <div className="inv-fact" key={i}>
                <T role="label" slot={`facts.${i}.label`} build={i} className="inv-label">{f.label}</T>
                <T role="h3" slot={`facts.${i}.value`} build={i} className="inv-value">{f.value}</T>
              </div>
            ))}
          </div>
          {(c.rsvp || c.qr || theme.logo) && (
            <div className="inv-foot">
              {c.qr && <QrCode text={c.qr} slot="_qr" color="#000000" bg="#FFFFFF" className="inv-qr" build={n} />}
              {c.rsvp && <T role="h2" slot="rsvp" maxLines={3} className="inv-rsvp" build={n}>{c.rsvp}</T>}
              {theme.logo && <Img src={theme.logo} slot="_logo" className="inv-logo" contain />}
            </div>
          )}
        </div>
      </div>
    </Frame>
  )
}

// Brief nach DIN 5008 Form B: alle Felder in mm an fester Stelle (Anschriftfeld im Umschlagfenster), das Autofit verkleinert nur die Schrift.
// Falz- und Lochmarken landen im Hintergrundbild.
function Letter({ c }: Props<'letter'>) {
  const { theme } = useSlide()
  // Absätze mit Leerzeile; das geschützte Leerzeichen hält sie auch in PPTX und Word (leere Zeilen fallen beim Messen weg)
  const body = c.body.split('\n').map((s) => s.trim()).filter(Boolean).join('\n\u00A0\n')
  return (
    <Frame safeClass="bf-safe">
      <div className="bf-marks" />
      <div className="bf-head">
        <T role="h1" slot="sender" maxLines={2} className="bf-sender">{c.sender}</T>
        {theme.logo && <Img src={theme.logo} slot="_logo" className="bf-logo" contain />}
      </div>
      <div className="bf-window">
        <div className="bf-note">{c.senderLine && <T role="small" slot="senderLine" maxLines={1}>{c.senderLine}</T>}</div>
        <div className="bf-to" data-fit data-slot="_to"><T role="body" slot="to" className="bf-addr">{c.to}</T></div>
      </div>
      {!!c.info?.length && (
        <div className="bf-info" data-fit data-slot="_info">
          {c.info.map((r, i) => (
            <div className="bf-row" key={i}>
              <T role="label" slot={`info.${i}.label`} className="muted">{r.label}</T>
              <T role="label" slot={`info.${i}.value`}>{r.value}</T>
            </div>
          ))}
        </div>
      )}
      <div className="bf-text">
        <div className="bf-main" data-fit data-slot="_body">
          <T role="body" slot="subject" className="bf-bold">{c.subject}</T>
          {c.salutation && <T role="body" slot="salutation" className="bf-gap">{c.salutation}</T>}
          <T role="body" slot="body" className="bf-gap">{body}</T>
          {c.closing && <T role="body" slot="closing" className="bf-gap">{c.closing}</T>}
          {c.signature && <T role="body" slot="signature" className="bf-sign">{c.signature}</T>}
          {!!c.enclosures?.length && <T role="body" slot="_enc" className="bf-gap bf-bold">Anlagen</T>}
          {c.enclosures?.map((x, i) => <T key={i} role="body" slot={`enclosures.${i}`}>{x}</T>)}
        </div>
        {!!c.footer?.length && <div className="bf-foot">{c.footer.map((f, i) => <T key={i} role="small" slot={`footer.${i}`}>{f}</T>)}</div>}
      </div>
    </Frame>
  )
}

// Visitenkarte: front = Name und Funktion oben, Organisation und Kontakt unten; back = Logo, sonst Organisation (oder Name) groß, unten claim und QR-Code.
// Auf der Karte stehen alle Rollen außer display bei 12 px: Hierarchie über Rolle, Gewicht und Farbe.
function BusinessCard({ c, v }: Props<'business-card'>) {
  const { theme } = useSlide()
  if (v === 'back') return (
    <Frame safeClass="vk-safe">
      <div className="vk">
        {theme.logo ? <Img src={theme.logo} slot="_logo" className="vk-mark" contain focus={{ x: 0, y: 0 }} />
          : <T role="display" slot={c.org ? 'org' : 'name'} maxLines={2} className="vk-name">{c.org ?? c.name}</T>}
        {(c.claim || c.qr) && (
          <div className="vk-foot">
            {c.claim ? <T role="body" slot="claim" className="vk-claim">{c.claim}</T> : <div />}
            {c.qr && <QrCode text={c.qr} slot="_qr" color="#000000" bg="#FFFFFF" className="vk-qr" />}
          </div>
        )}
      </div>
    </Frame>
  )
  return (
    <Frame safeClass="vk-safe">
      <div className="vk">
        <div className="vk-top">
          <div className="vk-who">
            <T role="display" slot="name" maxLines={2} className="vk-name">{c.name}</T>
            {c.role && <T role="label" slot="role" className="vk-role">{c.role}</T>}
          </div>
          {theme.logo && <Img src={theme.logo} slot="_logo" className="vk-logo" contain focus={{ x: 1, y: 0 }} />}
        </div>
        {(c.org || !!c.lines?.length) && (
          <div className="vk-contact">
            {c.org && <T role="label" slot="org" className="vk-org">{c.org}</T>}
            {c.lines?.map((x, i) => <T key={i} role="label" slot={`lines.${i}`}>{x}</T>)}
          </div>
        )}
      </div>
    </Frame>
  )
}

// Lebenslauf (A4 hoch): side = schmale Seitenspalte (Foto, Kontakt, Kenntnisse) neben Name und Stationen,
// plain = tabellarisch (Zeitraum in schmaler Spalte links, Foto rechts neben dem Namen). Kenntnisse nur als Text, Abschnitte über Haarlinien.
function Cv({ c, v }: Props<'cv'>) {
  const table = v === 'plain'
  const img = photoOf(c.image)
  const skills = c.skills ?? []
  const pic = img && <div className="cv-photo">{img.src ? <Img {...img} slot="image" /> : <div className="placeholder" />}</div>
  const contact = !!c.contact?.length && <div className="cv-contact">{c.contact.map((x, i) => <T key={i} role="label" slot={`contact.${i}`}>{x}</T>)}</div>
  // Zeile mit Schlüsselspalte (Zeitraum bzw. Bezeichnung der Kenntnis); die Spalten setzt das CSS je Variante
  const skillRows = skills.map((k, i) => (
    <div className="cv-entry" key={i}>
      <T role="label" slot={`skills.${i}.label`} build={c.sections.length} className="cv-key">{k.label}</T>
      <T role="label" slot={`skills.${i}.text`} build={c.sections.length}>{k.text}</T>
    </div>
  ))
  const head = (
    <div className="cv-head">
      <T role="h1" slot="name" maxLines={2} className="cv-name">{c.name}</T>
      {c.role && <T role="body" slot="role" className="cv-role">{c.role}</T>}
      {table && contact}
    </div>
  )
  const body = (
    <>
      {c.profile && <T role="body" slot="profile" className="cv-profile">{c.profile}</T>}
      {c.sections.map((s, i) => (
        <div className="cv-sec" key={i}>
          <T role="eyebrow" slot={`sections.${i}.heading`} build={i} className="cv-heading">{s.heading}</T>
          {s.entries.map((e, j) => {
            const p = `sections.${i}.entries.${j}`
            return (
              <div className="cv-entry" key={j}>
                <T role="label" slot={`${p}.period`} build={i} className="cv-key">{e.period}</T>
                <div className="cv-what">
                  <T role="h3" slot={`${p}.title`} build={i} className="cv-title">{e.title}</T>
                  {e.place && <T role="label" slot={`${p}.place`} build={i} className="muted">{e.place}</T>}
                  {e.text && <T role="label" slot={`${p}.text`} build={i}>{e.text}</T>}
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
  const signed = c.signed && <T role="label" slot="signed" build={c.sections.length} className="muted cv-signed">{c.signed}</T>
  if (table) return (
    <Frame safeClass="cv-safe">
      <div className="cv cv-table" data-fit data-slot="sections">
        <div className="cv-top">{head}{pic}</div>
        {body}
        {skills.length > 0 && (
          <div className="cv-sec">
            <T role="eyebrow" slot="_skills" build={c.sections.length} className="cv-heading">Kenntnisse</T>
            {skillRows}
          </div>
        )}
        {signed}
      </div>
    </Frame>
  )
  const aside = (pic || contact || skills.length > 0) && (
    <div className="cv-aside" data-fit data-slot="_aside">
      {pic}
      {contact}
      {skillRows}
    </div>
  )
  return (
    <Frame safeClass="cv-safe">
      <div className={`cv cv-sidebar ${aside ? '' : 'cv-solo'}`}>
        {aside}
        <div className="cv-main" data-fit data-slot="sections">{head}{body}{signed}</div>
      </div>
    </Frame>
  )
}

// Speisekarte: Name und Preis auf einer Zeile, Zutaten darunter, Abschnitte mit Haarlinie. two = CSS-Spalten, die Abschnitte fließen
// in Lesereihenfolge; die Spalten wachsen mit dem Inhalt (ausgeglichen statt fester Höhe), damit der Autofit den Überlauf sieht.
function Menu({ c, v }: Props<'menu'>) {
  return (
    <Frame>
      <div className="sk-head">
        {c.eyebrow && <T role="eyebrow" slot="eyebrow" className="sk-eyebrow">{c.eyebrow}</T>}
        <T role="h1" slot="title" maxLines={2} className="sk-title">{c.title}</T>
        {c.intro && <T role="body" slot="intro" className="sk-intro">{c.intro}</T>}
      </div>
      <div className="sk" data-fit data-slot="sections">
        <div className={`sk-cols ${v === 'two' ? 'two' : ''}`}>
          {c.sections.map((s, i) => (
            <div className="sk-sec" key={i}>
              <T role="h2" slot={`sections.${i}.heading`} build={i} className="sk-sec-head">{s.heading}</T>
              {s.items.map((it, j) => (
                <div className="sk-item" key={j}>
                  <div className="sk-name">
                    <T role="h3" slot={`sections.${i}.items.${j}.name`} build={i}>{it.name}</T>
                    {it.tag && <T role="small" slot={`sections.${i}.items.${j}.tag`} build={i} className="sk-tag">{it.tag}</T>}
                  </div>
                  <T role="h3" slot={`sections.${i}.items.${j}.price`} build={i} className="sk-price">{it.price}</T>
                  {it.text && <T role="small" slot={`sections.${i}.items.${j}.text`} build={i} className="sk-text">{it.text}</T>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      {c.note && <T role="small" slot="note" className="sk-note">{c.note}</T>}
    </Frame>
  )
}

export const EXTRA_COMPONENTS = {
  blank: () => <Frame>{null}</Frame>, summary: Summary, options: Options, matrix: Matrix,
  table: Table, 'doc-text': DocText, offer: Offer, flyer: Flyer, 'flyer-back': FlyerBack, 'big-number': BigNumber, 'icon-grid': IconGrid, 'pros-cons': ProsCons, 'problem-solution': ProblemSolution, team: Team,
  pricing: Pricing, funnel: Funnel, 'market-size': MarketSize, logos: Logos, clip: Clip,
  'application-cover': ApplicationCover, certificate: Certificate, invitation: Invitation, letter: Letter, 'business-card': BusinessCard, cv: Cv, menu: Menu,
}
