// Komponenten zu src/shared/layouts-pro.ts: Projektplan (Gantt).
// Balken und Heute-Linie sind Box (native PPTX-Formen), Meilensteine native Rauten; das Spaltenraster ohne data-pptx landet im Hintergrundbild.
import type { z } from 'zod'
import { PRO_LAYOUTS } from '../shared/layouts-pro'
import { Header } from './layouts'
import { Box, Frame, T, useSlide } from './slide'
import './layouts-pro.css'

type Props<K extends keyof typeof PRO_LAYOUTS> = { c: z.infer<(typeof PRO_LAYOUTS)[K]['schema']>; v?: string }

// Raute als freie Form (data-shape): die PPTX bekommt eine echte Raute statt des umschließenden Rechtecks einer gedrehten Box.
// useSlide innerhalb von Frame liefert die getönten Farben.
function Milestone({ slot, hl, build }: { slot: string; hl?: boolean; build: number }) {
  const { theme } = useSlide()
  return <div className={`gt-ms ${hl ? 'hl' : ''}`} data-pptx="box" data-slot={slot} data-build={build} data-shape="diamond" data-fill={hl ? theme.c.fill ?? theme.c.accent : theme.c.muted} data-alpha={1} data-sw={0} />
}

function Gantt({ c }: Props<'gantt'>) {
  const n = c.periods.length
  const cols = { gridTemplateColumns: `var(--gt-label) repeat(${n}, minmax(0, 1fr))` }
  return (
    <Frame>
      <Header c={c} />
      <div className="gt">
        <div className="gt-grid" style={cols}>
          {c.periods.map((_, i) => <div key={i} className="gt-cell" style={{ gridColumn: i + 2 }} />)}
        </div>
        <div className="gt-head" style={cols}>
          {c.periods.map((p, i) => <T key={i} role="small" slot={`periods.${i}`} className={`gt-period ${i === c.today ? 'now' : ''}`} style={{ gridColumn: i + 2 }}>{p}</T>)}
        </div>
        <div className="gt-rows" data-fit data-slot="rows">
          {c.today !== undefined && ( // eigenes Raster unter dem Kopf, damit die Linie die Periodenbeschriftung nicht kreuzt
            <div className="gt-grid" style={cols}><div className="gt-today-col" style={{ gridColumn: c.today + 2 }}><Box slot="_today" className="gt-today" /></div></div>
          )}
          {c.rows.map((r, i) => (
            <div className="gt-row" key={i} style={cols}>
              <T role="label" slot={`rows.${i}.label`} build={i} className={`gt-label ${r.highlight ? 'hl' : ''}`}>{r.label}</T>
              {r.milestone
                ? <div className="gt-ms-cell" style={{ gridColumn: r.start + 2 }}><Milestone slot={`_ms.${i}`} hl={r.highlight} build={i} /></div>
                : <Box slot={`_bar.${i}`} className={`gt-bar ${r.highlight ? 'hl' : ''}`} build={i} style={{ gridColumn: `${r.start + 2} / ${r.end + 3}` }} />}
            </div>
          ))}
        </div>
      </div>
      {c.source && <T role="footer" slot="source" className="source">{c.source}</T>}
    </Frame>
  )
}

export const PRO_COMPONENTS = { gantt: Gantt }
