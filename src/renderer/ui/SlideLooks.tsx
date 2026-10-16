// „Andere Gestaltung“: Alternativen der gewählten Folie als Mini-Vorschauen, Klick übernimmt sie.
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Deck, FrameId, Slide } from '../../shared/deck'
import { LAYOUTS, looksOf, type LayoutId } from '../../shared/layouts'
import { SlideView } from '../slide'

const FRAME: Record<FrameId, string> = { top: 'Titel oben', split: 'Titel links auf Farbfläche', band: 'Titel im Farbband', center: 'Zentriert' }
const PAGE = 4
const WIDTH = 116 // 2 Kacheln + Rand passen auch mit Scrollbar in das 300-px-Panel

type Props = { deck: Deck; index: number; patchSlide: (i: number, p: Partial<Slide>, tag?: string) => void }

// SlideView misst bei jedem Render neu: nur neu zeichnen, wenn sich Folie, Theme oder Format ändern (nicht bei jedem Tippen im Deck).
const same = (a: Props, b: Props) =>
  a.index === b.index && a.deck.theme === b.deck.theme && a.deck.size === b.deck.size && a.deck.slides.length === b.deck.slides.length && a.deck.slides[a.index] === b.deck.slides[b.index]

export const SlideLooks = memo(function SlideLooks({ deck, index, patchSlide }: Props) {
  const slide = deck.slides[index]
  const def = LAYOUTS[slide.layout as LayoutId]
  const [page, setPage] = useState(0)
  const grid = useRef<HTMLDivElement>(null)
  const refocus = useRef(false)
  const patch = useRef(patchSlide)
  patch.current = patchSlide
  const all = useMemo(() => looksOf(slide), [slide])
  // Neue Folie oder übernommene Gestaltung: wieder mit den besten Vorschlägen beginnen. Die geklickte Kachel verschwindet,
  // der Fokus ginge sonst auf body und Stage-Kürzel (t/r/c/l) würden Elemente einfügen.
  useEffect(() => {
    setPage(0)
    if (refocus.current) grid.current?.querySelector('button')?.focus()
    refocus.current = false
  }, [index, slide.layout, slide.variant, slide.frame, slide.tone])
  const pages = Math.ceil(all.length / PAGE)
  const looks = all.slice((page % pages) * PAGE, (page % pages) * PAGE + PAGE)
  const previews = useMemo(() => looks.map((look) => ({ look, deck: { ...deck, slides: deck.slides.map((s, i) => (i === index ? { ...s, ...look } : s)) } })), [deck, index, all, page])
  if (!looks.length) return null
  return (
    <div className="slide-looks">
      <span className="slide-looks-title">Andere Gestaltung</span>
      <div className="slide-looks-grid" ref={grid}>
        {previews.map(({ look, deck }) => {
          const label = [def.frames && FRAME[look.frame ?? 'top'], look.variant && `Variante ${look.variant}`, look.tone === 'invert' && 'invertiert'].filter(Boolean).join(' · ')
          return (
            <button key={`${look.variant}|${look.frame}|${look.tone}`} type="button" className="slide-looks-item" title={label} aria-label={label}
              onClick={() => ((refocus.current = true), patch.current(index, look))}>
              <span className="slide-looks-thumb">
                <SlideView deck={deck} index={index} width={WIDTH} />
              </span>
            </button>
          )
        })}
      </div>
      {pages > 1 && <button type="button" className="btn wide" onClick={() => setPage((page + 1) % pages)}>Weitere Vorschläge</button>}
    </div>
  )
}, same)
