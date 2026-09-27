import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useEffect, useState, type JSX } from 'react'
import '@fontsource/arimo/400.css'
import '@fontsource/arimo/700.css'
import '@fontsource/arimo/400-italic.css'
import '@fontsource/carlito/400.css'
import '@fontsource/carlito/700.css'
import '@fontsource/carlito/400-italic.css'
import '@fontsource/gelasio/400.css'
import '@fontsource/gelasio/700.css'
import '@fontsource/gelasio/400-italic.css'
import './fonts.css'
import type { Deck, Measured } from '../shared/deck'
import { SlideView, loadCustomFont } from './slide'
import { PresentScreen } from './ui/PresentScreen'
import { autofit, extract } from './measure'
import { FONTS } from '../shared/themes'

// App.tsx is built in parallel; fall back to a stub until it exists.
const apps = import.meta.glob('./App.tsx', { eager: true }) as Record<string, { default: () => JSX.Element }>
const App = apps['./App.tsx']?.default ?? (() => <p style={{ font: '16px sans-serif', padding: 24 }}>App folgt …</p>)

const frames = (n = 2) => new Promise<void>((r) => { const f = () => (--n ? requestAnimationFrame(f) : r()); requestAnimationFrame(f) })
async function fontsLoaded() {
  const specs = Object.values(FONTS).flatMap((f) => ['400', '700', 'italic 400'].map((w) => `${w} 16px "${f.css}"`))
  await Promise.all(specs.map((s) => document.fonts.load(s, 'AaÄäÖöÜüß€–')))
  await document.fonts.ready
}

async function svgToPng(svg: string, w: number, h: number): Promise<string> {
  const img = new Image(w, h)
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(w), height: Math.round(h) })
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

// Offscreen host driven by the main process: render one slide, autofit, measure. Also used for PDF (all slides).
function Host({ mode }: { mode: string }) {
  const [state, setState] = useState<{ deck: Deck; index: number } | null>(null)
  ;(window as any).dw = {
    // 1px marker row below the slide; its colour tells the main process which job a painted frame belongs to
    mark(seq: number) {
      const m = document.getElementById('dw-marker') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'dw-marker' }))
      m.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:1px;background:rgb(${seq % 200},${255 - (seq % 200)},128)`
      return frames()
    },
    async render(deck: Deck, index: number): Promise<Measured> {
      await fontsLoaded()
      await loadCustomFont(deck)
      flushSync(() => setState({ deck, index }))
      await frames()
      const root = document.querySelector<HTMLElement>('.slide')!
      const fit = autofit(root) // idempotent; SlideView already ran it, this returns the settled result
      const els = extract(root)
      for (const e of els) if (e.kind === 'icon' && e.svg) e.png = await svgToPng(e.svg, e.box.w * 4, e.box.h * 4)
      return { fit, els }
    },
    async hideExportables(on: boolean) {
      document.body.classList.toggle('hide-exportables', on)
      await frames()
    },
    async renderAll(deck: Deck) {
      await fontsLoaded()
      await loadCustomFont(deck)
      flushSync(() => setState({ deck, index: -1 }))
      await frames(3)
    },
  }
  if (!state) return null
  if (mode === 'print')
    return (
      <div className="print-root">
        {state.deck.slides.map((_, i) => <SlideView key={i} deck={state.deck} index={i} print />)}
      </div>
    )
  if (mode === 'overview')
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 296px)', gap: 16, padding: 24, background: '#15171c', font: '600 13px sans-serif', color: '#c9ced8' }}>
        {state.deck.slides.map((s, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <SlideView deck={state.deck} index={i} width={296} />
            <span>{`${i + 1} · ${s.layout}${s.variant ? ` (${s.variant})` : ''} · ${s.id}`}</span>
          </div>
        ))}
      </div>
    )
  return <SlideView deck={state.deck} index={state.index} />
}

// Publikumsfenster auf dem zweiten Bildschirm: Deck vom Main-Prozess, Schritte kommen vom Referenten
function Audience() {
  const [show, setShow] = useState<{ deck: Deck; start: number } | null>(null)
  useEffect(() => { window.api.presentDeck().then(setShow) }, [])
  return show && <PresentScreen deck={show.deck} start={show.start} mode="audience" onExit={() => window.close()} />
}

const mode = location.hash.slice(1)
const hosted = ['render', 'print', 'overview'].includes(mode)
if (hosted) document.body.style.cssText = 'margin:0;overflow:hidden;background:transparent'
createRoot(document.getElementById('root')!).render(hosted ? <Host mode={mode} /> : mode === 'audience' ? <Audience /> : <App />)
