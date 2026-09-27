// Entstehen: links die Storyline wie ein Manuskript (fertig, jetzt, geplant), rechts erscheint jede neue Folie groß.
// Sichtbar, solange die KI ein Deck nach ihrer Storyline baut; danach übernimmt der Editor.
import { useLayoutEffect, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { sizeOf, type Deck } from '../../shared/deck'
import { SlideView } from '../slide'
import type { Msg } from './Chat'

export interface StoryItem { title: string; layout: string }

const CHECKING = ['render_slides', 'render_overview', 'lint_deck']
const R = 9
const C = 2 * Math.PI * R

interface Props { deck: Deck | null; story: StoryItem[]; msgs: Msg[]; onAbort: () => void }

export function BuildView({ deck, story, msgs, onAbort }: Props) {
  const box = useRef<HTMLElement>(null)
  const [w, setW] = useState(0)
  const size = sizeOf(deck)
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.floor(Math.min(e.contentRect.width, ((e.contentRect.height - 124) * size.w) / size.h))))
    ro.observe(box.current!)
    return () => ro.disconnect()
  }, [size.w, size.h])

  const built = Math.min(deck?.slides.length ?? 0, story.length)
  const running = msgs.findLast((m) => m.kind === 'tool' && m.status === 'start')
  const checking = running?.kind === 'tool' && CHECKING.includes(running.name) && built > 0
  const slide = deck && built > 0 ? deck.slides[built - 1] : null

  return (
    <div className="build">
      <nav className="build-story" aria-label="Storyline">
        <div className="build-story-head"><b>Storyline</b><span>{built} von {story.length} fertig</span></div>
        {story.map((s, i) =>
          s.layout === 'section' ? (
            <span key={i} className="story-chapter">{s.title}</span>
          ) : (
            <div key={i} className={`story ${i < built ? 'done' : i === built ? 'now' : ''}`} aria-current={i === built ? 'step' : undefined}>
              {i < built ? <Check size={16} strokeWidth={2.6} aria-label="fertig" />
                : i === built ? <svg width="16" height="16" viewBox="0 0 24 24" className="ring-spin" aria-label="entsteht"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3.5" /><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" /></svg>
                : <span>{i + 1}</span>}
              <span>{s.title}</span>
            </div>
          ),
        )}
      </nav>

      <main className="build-main" ref={box}>
        {slide && w > 0
          ? <div key={slide.id} className="build-slide" style={{ width: w }}><SlideView deck={deck!} index={built - 1} width={w} /></div>
          : <div className="build-empty" style={{ width: w || undefined, aspectRatio: `${size.w} / ${size.h}` }}>Die erste Folie entsteht …</div>}
        <div className="build-status material" role="status">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="11" cy="11" r={R} fill="none" stroke="rgb(22 22 26 / 0.1)" strokeWidth="2.5" />
            <circle cx="11" cy="11" r={R} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(C * built) / Math.max(1, story.length)} ${C}`} transform="rotate(-90 11 11)" />
          </svg>
          <b>{checking ? `Deckwerk prüft Folie ${built}` : built < story.length ? `Folie ${built + 1} von ${story.length} entsteht` : 'Letzter Schliff'}</b>
          <span>{checking ? 'rendert sie als Bild und sucht Überläufe' : 'Danach prüft Deckwerk sie als Bild'}</span>
          <i aria-hidden="true" />
          <button className="pill" onClick={onAbort}>Stopp</button>
        </div>
      </main>
    </div>
  )
}
