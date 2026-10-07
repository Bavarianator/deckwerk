// Eine Suche über alles im Einfügen-Popover: Text, Formen, Icons (auch deutsche Begriffe), Diagramme, Folienvorlagen,
// Fotos (eigene und Unsplash per Enter). Leeres Feld → das normale Elemente-Panel darunter.
import { useMemo, useState, type ReactNode } from 'react'
import { icons, Search, X } from 'lucide-react'
import { SHAPES, type ChartSpec, type Deck, type Item } from '../../shared/deck'
import { TEXT_PRESETS, newChart, newIcon, newImage, newShape, newText } from '../../shared/items'
import { LAYOUTS, type LayoutId } from '../../shared/layouts'
import { resolveTheme } from '../../shared/themes'
import { SHAPE_PATHS } from '../slide'
import { layoutIdsFor } from './Elements'
import { imageRatio } from './itemOps'

const SHAPE_NAMES: Record<string, string> = { rect: 'Rechteck', ellipse: 'Kreis', triangle: 'Dreieck', diamond: 'Raute', hexagon: 'Sechseck', star: 'Stern', arrow: 'Pfeil', line: 'Linie' }
const CHARTS: [ChartSpec['type'], string][] = [['bar', 'Säulendiagramm'], ['hbar', 'Balkendiagramm'], ['line', 'Liniendiagramm'], ['donut', 'Ringdiagramm'], ['stacked', 'Gestapelt'], ['waterfall', 'Wasserfall']]
// häufige deutsche Suchwörter → englische Icon-Namen (lucide)
const DE: Record<string, string[]> = {
  stern: ['star'], haus: ['house', 'home'], pfeil: ['arrow'], schule: ['school', 'graduation'], bildung: ['graduation', 'book'], buch: ['book'],
  geld: ['banknote', 'coins', 'euro', 'wallet'], euro: ['euro'], person: ['user'], team: ['users'], menschen: ['users'], ziel: ['target', 'flag'],
  idee: ['lightbulb'], zeit: ['clock', 'timer'], uhr: ['clock'], kalender: ['calendar'], herz: ['heart'], haken: ['check'], häkchen: ['check'],
  rakete: ['rocket'], welt: ['globe', 'earth'], schutz: ['shield'], sicherheit: ['shield', 'lock'], schloss: ['lock'], diagramm: ['chart'],
  wachstum: ['trending-up', 'sprout'], telefon: ['phone'], mail: ['mail'], brief: ['mail'], ort: ['map-pin'], karte: ['map'], blatt: ['leaf'],
  natur: ['leaf', 'tree'], auto: ['car'], computer: ['laptop', 'monitor'], handy: ['smartphone'], stift: ['pencil', 'pen'], suche: ['search'],
  einstellungen: ['settings'], werkzeug: ['wrench', 'hammer'], blitz: ['zap'], auszeichnung: ['award', 'trophy'], pokal: ['trophy'], frage: ['circle-help'],
  info: ['info'], warnung: ['triangle-alert'], fabrik: ['factory'], gebäude: ['building'], handschlag: ['handshake'], vertrag: ['file-signature'],
}

const kebab = (n: string) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase()
const ICONS = Object.keys(icons).map((n) => [n, kebab(n)] as const)

interface Props { deck: Deck; disabled: boolean; onAdd: (it: Item) => void; onAddSlide: (layout: LayoutId) => void; children: ReactNode }

export function InsertSearch({ deck, disabled, onAdd, onAddSlide, children }: Props) {
  const [q, setQ] = useState('')
  const [photos, setPhotos] = useState<{ urls: string[]; note?: string; busy?: boolean } | null>(null)
  const t = useMemo(() => resolveTheme(deck.theme), [JSON.stringify(deck.theme)]) // eslint-disable-line react-hooks/exhaustive-deps
  const s = q.trim().toLowerCase()
  const hit = (name: string) => name.toLowerCase().includes(s)

  const found = useMemo(() => {
    if (!s) return null
    const words = [s, ...Object.entries(DE).filter(([de]) => de.startsWith(s) || s.startsWith(de)).flatMap(([, en]) => en)]
    return {
      text: (Object.keys(TEXT_PRESETS) as (keyof typeof TEXT_PRESETS)[]).filter((p) => hit(TEXT_PRESETS[p].label) || 'text schrift'.includes(s)),
      shapes: SHAPES.filter((x) => hit(SHAPE_NAMES[x] ?? x) || hit(x) || 'form'.startsWith(s)),
      icons: ICONS.filter(([, k]) => words.some((w) => k.includes(w))).slice(0, 32),
      charts: CHARTS.filter(([type, name]) => hit(name) || hit(type) || 'diagramm'.startsWith(s)),
      layouts: layoutIdsFor(deck).filter((id) => hit(LAYOUTS[id].name) || 'folie vorlage'.includes(s)),
    }
  }, [s, deck.size?.w, deck.size?.h]) // eslint-disable-line react-hooks/exhaustive-deps

  const findPhotos = async () => {
    setPhotos({ urls: [], busy: true })
    try { setPhotos(await window.api.findImages(q.trim())) } catch (e) { setPhotos({ urls: [], note: e instanceof Error ? e.message : String(e) }) }
  }
  const tile = (key: string, title: string, make: () => Item | Promise<Item>, body: ReactNode, cls = '') => (
    <button key={key} type="button" className={`el-tile ${cls}`} title={title} aria-label={title} disabled={disabled} onClick={async () => onAdd(await make())}>{body}</button>
  )
  const none = found && !found.text.length && !found.shapes.length && !found.icons.length && !found.charts.length && !found.layouts.length

  return (
    <div className="ins">
      <form className="ins-search" onSubmit={(e) => { e.preventDefault(); if (s) void findPhotos() }}>
        <Search size={16} />
        <input autoFocus value={q} placeholder="Formen, Icons, Fotos, Diagramme suchen" aria-label="Einfügen: suchen"
          onChange={(e) => { setQ(e.target.value); setPhotos(null) }} />
        {q && <button type="button" className="plain" aria-label="Suche leeren" onClick={() => { setQ(''); setPhotos(null) }}><X size={14} /></button>}
      </form>
      {!found ? children : (
        <div className="elements ins-results">
          {found.text.length > 0 && (
            <section><h3>Text</h3>
              {found.text.map((p) => tile(p, TEXT_PRESETS[p].label, () => ({ ...newText(p), color: t.c.text }), `${TEXT_PRESETS[p].label} hinzufügen`, `el-text el-${p}`))}
            </section>
          )}
          {found.shapes.length > 0 && (
            <section><h3>Formen</h3><div className="el-grid">
              {found.shapes.map((x) => tile(x, SHAPE_NAMES[x], () => newShape(x, t.c.accent), (
                <svg viewBox="-4 -4 108 108" width="30" height="30">
                  {x === 'rect' ? <rect width="100" height="100" rx="8" /> : x === 'ellipse' ? <circle cx="50" cy="50" r="50" /> : x === 'line' ? <line x1="0" y1="50" x2="100" y2="50" strokeWidth="8" stroke="currentColor" /> : <path d={SHAPE_PATHS[x]} />}
                </svg>
              )))}
            </div></section>
          )}
          {found.icons.length > 0 && (
            <section><h3>Icons</h3><div className="el-grid">
              {found.icons.map(([n, k]) => { const Cmp = icons[n as keyof typeof icons]; return tile(n, k, () => newIcon(k, t.c.accent), <Cmp size={20} />) })}
            </div></section>
          )}
          {found.charts.length > 0 && (
            <section><h3>Diagramme</h3><div className="el-grid wide">
              {found.charts.map(([type, name]) => tile(type, name, () => newChart(type), name, 'el-chip'))}
            </div></section>
          )}
          {found.layouts.length > 0 && (
            <section><h3>Folienvorlagen</h3><div className="el-layouts">
              {found.layouts.map((id) => <button key={id} type="button" className="el-layout" disabled={disabled} onClick={() => onAddSlide(id)} title={LAYOUTS[id].when}>{LAYOUTS[id].name}</button>)}
            </div></section>
          )}
          <section><h3>Fotos</h3>
            {!photos && <button type="button" className="pill" disabled={disabled} onClick={findPhotos}>Fotos zu „{q.trim()}“ suchen</button>}
            {photos?.busy && <p className="muted">Suche …</p>}
            {photos?.note && <p className="muted">{photos.note}</p>}
            {photos && photos.urls.length > 0 && (
              <div className="el-photos">
                {photos.urls.map((u) => tile(u, 'Foto einfügen', async () => newImage(u, await imageRatio(u)), <img src={u} alt="" loading="lazy" />, 'el-photo'))}
              </div>
            )}
          </section>
          {none && !photos && <p className="muted ins-none">Keine Formen, Icons oder Vorlagen zu „{q.trim()}“. Fotos suchst du mit Enter.</p>}
        </div>
      )}
    </div>
  )
}
