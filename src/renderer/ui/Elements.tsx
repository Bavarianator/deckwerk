// Seitenpanel „Elemente“ wie in Canva: Text, Formen, Icons, Fotos (Upload und Suche), Diagramme, Folienvorlagen.
// Klick fügt in die Mitte der Folie ein, Ziehen legt das Element an der Mausposition ab.
import { useMemo, useState, type ReactNode } from 'react'
import { Film, icons, ImagePlus, Music, Search } from 'lucide-react'
import { SHAPES, type ChartSpec, type Deck, type Item } from '../../shared/deck'
import { TEXT_PRESETS, newChart, newIcon, newImage, newMedia, newShape, newText } from '../../shared/items'
import { LAYOUTS, LAYOUT_IDS, type LayoutId } from '../../shared/layouts'
import { resolveTheme } from '../../shared/themes'
import { SHAPE_PATHS } from '../slide'
import { imageRatio } from './itemOps'
import { videoPoster } from './media'

interface Props { deck: Deck; disabled: boolean; onAdd: (it: Item) => void; onAddSlide: (layout: LayoutId) => void; pickImage: () => Promise<string | null> }

const ICON_LIST = Object.keys(icons)
const kebab = (n: string) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase()
const SHAPE_NAMES: Record<string, string> = { rect: 'Rechteck', ellipse: 'Kreis', triangle: 'Dreieck', diamond: 'Raute', hexagon: 'Sechseck', star: 'Stern', arrow: 'Pfeil', line: 'Linie',
  chevron: 'Chevron', pentagon: 'Etikett', trapezoid: 'Trapez', parallelogram: 'Parallelogramm', rtTriangle: 'Rechtwinkliges Dreieck', octagon: 'Achteck',
  donut: 'Ring', plus: 'Plus', heart: 'Herz', star4: 'Stern 4', star6: 'Stern 6', star8: 'Stern 8', star12: 'Siegel' }
const CHARTS: [ChartSpec['type'], string][] = [['bar', 'Säulen'], ['hbar', 'Balken'], ['line', 'Linie'], ['donut', 'Ring'], ['stacked', 'Gestapelt'], ['waterfall', 'Wasserfall']]

function Tile({ make, title, className, children, disabled, onAdd }: { make: () => Item | Promise<Item>; title: string; className?: string; children: ReactNode; disabled: boolean; onAdd: Props['onAdd'] }) {
  return (
    <button type="button" className={`el-tile ${className ?? ''}`} title={title} aria-label={title} disabled={disabled} draggable={!disabled}
      onClick={async () => onAdd(await make())}
      onDragStart={async (e) => { const it = make(); if (!(it instanceof Promise)) e.dataTransfer.setData('application/x-deckwerk-item', JSON.stringify(it)) }}>
      {children}
    </button>
  )
}

export function Elements({ deck, disabled, onAdd, onAddSlide, pickImage }: Props) {
  const t = useMemo(() => resolveTheme(deck.theme), [JSON.stringify(deck.theme)])
  const [iconQ, setIconQ] = useState('')
  const [photoQ, setPhotoQ] = useState('')
  const [photos, setPhotos] = useState<{ urls: string[]; note?: string; busy?: boolean }>({ urls: [] })
  const iconHits = useMemo(() => {
    const q = iconQ.trim().toLowerCase().replace(/[\s-]/g, '')
    return (q ? ICON_LIST.filter((n) => n.toLowerCase().includes(q)) : ['Star', 'Heart', 'Check', 'Rocket', 'Lightbulb', 'Target', 'TrendingUp', 'Users', 'ShieldCheck', 'Globe', 'Zap', 'Award', 'Clock', 'Mail', 'Phone', 'MapPin', 'Leaf', 'Sparkles', 'ChartBar', 'Handshake', 'ArrowRight', 'Quote', 'Flag'].filter((n) => n in icons)).slice(0, 48)
  }, [iconQ])
  const search = async () => {
    setPhotos({ urls: [], busy: true })
    try { setPhotos(await window.api.findImages(photoQ.trim())) } catch (e) { setPhotos({ urls: [], note: e instanceof Error ? e.message : String(e) }) }
  }
  const addMedia = async (kind: 'video' | 'audio') => {
    const src = await window.api.pickMedia(kind)
    if (!src) return
    const poster = kind === 'video' ? await videoPoster(src).catch(() => undefined) : undefined
    onAdd(newMedia(kind, src, poster?.ratio, poster?.src))
  }
  const upload = async () => {
    const src = await pickImage()
    if (src) onAdd(newImage(src, await imageRatio(src)))
  }
  const tile = { disabled, onAdd }

  return (
    <div className="elements">
      <section>
        <h3>Text</h3>
        {(Object.keys(TEXT_PRESETS) as (keyof typeof TEXT_PRESETS)[]).map((p) => (
          <Tile key={p} {...tile} make={() => ({ ...newText(p), color: t.c.text })} title={`${TEXT_PRESETS[p].label} hinzufügen`} className={`el-text el-${p}`}>
            {TEXT_PRESETS[p].label} hinzufügen
          </Tile>
        ))}
      </section>

      <section>
        <h3>Formen</h3>
        <div className="el-grid">
          {SHAPES.map((s) => (
            <Tile key={s} {...tile} make={() => newShape(s, t.c.accent)} title={SHAPE_NAMES[s]}>
              <svg viewBox="-4 -4 108 108" width="36" height="36">
                {s === 'rect' ? <rect width="100" height="100" rx="8" /> : s === 'ellipse' ? <circle cx="50" cy="50" r="50" /> : s === 'line' ? <line x1="0" y1="50" x2="100" y2="50" strokeWidth="8" stroke="currentColor" /> : <path d={SHAPE_PATHS[s]} />}
              </svg>
            </Tile>
          ))}
        </div>
      </section>

      <section>
        <h3>Icons</h3>
        <label className="el-search"><Search size={14} /><input type="text" value={iconQ} onChange={(e) => setIconQ(e.target.value)} placeholder="Icons suchen (englisch)" /></label>
        <div className="el-grid">
          {iconHits.map((n) => {
            const Cmp = icons[n as keyof typeof icons]
            return <Tile key={n} {...tile} make={() => newIcon(kebab(n), t.c.accent)} title={kebab(n)}><Cmp size={22} /></Tile>
          })}
        </div>
      </section>

      <section>
        <h3>Fotos</h3>
        <button type="button" className="btn wide" disabled={disabled} onClick={upload}><ImagePlus size={14} /> Eigenes Bild hochladen</button>
        <form className="el-search" onSubmit={(e) => (e.preventDefault(), search())}>
          <Search size={14} /><input type="text" value={photoQ} onChange={(e) => setPhotoQ(e.target.value)} placeholder="Fotos suchen, z. B. team office" />
        </form>
        {photos.busy && <p className="muted small">Suche …</p>}
        {photos.note && <p className="muted small">{photos.note}</p>}
        <div className="el-photos">
          {photos.urls.map((u) => (
            <Tile key={u} {...tile} make={async () => newImage(u, await imageRatio(u))} title="Foto einfügen" className="el-photo">
              <img src={u} alt="" loading="lazy" />
            </Tile>
          ))}
        </div>
        <p className="muted small">Tipp: Bilder aus dem Dateimanager auf die Folie ziehen oder mit Strg+V einfügen.</p>
      </section>

      <section>
        <h3>Video und Audio</h3>
        <div className="el-grid wide" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <button type="button" className="btn" disabled={disabled} onClick={() => addMedia('video')}><Film size={14} /> Video</button>
          <button type="button" className="btn" disabled={disabled} onClick={() => addMedia('audio')}><Music size={14} /> Audio</button>
        </div>
        <p className="muted small">MP4/WebM, MP3/WAV/M4A. Auch per Drag &amp; Drop auf die Folie.</p>
      </section>

      <section>
        <h3>Diagramme</h3>
        <div className="el-grid wide">
          {CHARTS.map(([type, name]) => <Tile key={type} {...tile} make={() => newChart(type)} title={`${name}diagramm`} className="el-chip">{name}</Tile>)}
        </div>
      </section>

      <section>
        <h3>Folienvorlagen</h3>
        <div className="el-layouts">
          {LAYOUT_IDS.map((id) => (
            <button key={id} type="button" className="el-layout" disabled={disabled} onClick={() => onAddSlide(id)} title={LAYOUTS[id].when}>{LAYOUTS[id].name}</button>
          ))}
        </div>
      </section>
    </div>
  )
}
