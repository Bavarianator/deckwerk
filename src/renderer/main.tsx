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
import { sizeOf, type Deck, type Measured } from '../shared/deck'
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

// Fotos sind CSS-Hintergründe und laden nebenher: abwarten, sonst nimmt der Snapshot ein frisch erzeugtes Bild leer auf
async function imagesLoaded(root: ParentNode) {
  const urls = [...root.querySelectorAll<HTMLElement>('[style*="url("]')].flatMap((el) => [...el.style.backgroundImage.matchAll(/url\("(.+?)"\)/g)].map((m) => m[1]))
  if (!urls.length) return
  await Promise.all(urls.map((src) => Object.assign(new Image(), { src }).decode().catch(() => {})))
  await frames()
}

async function svgToPng(svg: string, w: number, h: number): Promise<string> {
  const img = new Image(w, h)
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(w), height: Math.round(h) })
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

// Druck-PDF (render.ts renderPrintPdf): Seite und Beschnitt in pt, Folie um den Beschnitt versetzt und auf das Endformat skaliert; bx/by = Beschnitt in Folien-px
interface PrintGeo { pageW: number; pageH: number; bleed: number; fx: number; fy: number; bx: number; by: number }

// Beschnitt durch Spiegeln am Rand (wie Acrobats „Beschnittzugabe durch Spiegeln“): 8 Klone der fertigen Folie in Kantenstreifen
// und Ecken, an der Schnittkante gespiegelt. So laufen Fotos, Flächen, Dekor und freie Elemente ohne Layout-Änderung in den Beschnitt
// und bleiben Vektor. Text liegt nie dort (Lint-Regel frame: ≥ 24 px vom Rand). cloneNode übernimmt keine Canvas-Pixel; Diagramme
// liegen nie am Rand. Die Teile ragen OVER px unter die Folie bzw. die Nachbarteile (Achse OVER/2 innerhalb der Kante, Spalte x landet
// links bei bx + OVER − x): Viewer glätten aneinanderstoßende Kanten einzeln, an den Stößen schien sonst eine weiße Haarlinie durch.
const OVER = 2
function mirrorBleed(box: HTMLElement, w: number, h: number, bx: number, by: number) {
  const host = box.firstElementChild, slide = box.querySelector('.slide')!
  // erst Kanten, dann Ecken, alles vor der Folie im DOM: Spätere liegen oben, die Folie über allem
  for (const [ix, iy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const clip = Object.assign(document.createElement('div'), { className: 'bleed-clip' })
    // Lage per transform statt left/top: Kästen, die per Layout neben der Folie liegen, zählt Chromium beim Drucken trotz
    // overflow:hidden als Überbreite und verkleinert dann die ganze Seite (bis auf 2/3)
    const at = (i: number, b: number, len: number) => (i < 0 ? -b : i ? len - OVER : 0)
    clip.style.cssText = `position:absolute;overflow:hidden;left:0;top:0;width:${ix ? bx + OVER : w}px;height:${iy ? by + OVER : h}px;transform:translate(${at(ix, bx, w)}px, ${at(iy, by, h)}px)`
    const c = slide.cloneNode(true) as HTMLElement
    const axis = (i: number, b: number, len: number) => (i < 0 ? b + OVER : i ? len : 0)
    Object.assign(c.style, { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0', transform: `translate(${axis(ix, bx, w)}px, ${axis(iy, by, h)}px) scale(${ix ? -1 : 1}, ${iy ? -1 : 1})` })
    clip.append(c)
    box.insertBefore(clip, host)
  }
}

// Offscreen host driven by the main process: render one slide, autofit, measure. Also used for PDF (all slides).
function Host({ mode }: { mode: string }) {
  const [state, setState] = useState<{ deck: Deck; index: number; geo?: PrintGeo } | null>(null)
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
      await imagesLoaded(root)
      const fit = autofit(root) // idempotent; SlideView already ran it, this returns the settled result
      const els = extract(root)
      for (const e of els) if (e.kind === 'icon' && e.svg) e.png = await svgToPng(e.svg, e.box.w * 4, e.box.h * 4)
      // Pixelgröße der Bilddatei für die Druckauflösung im Lint; dekodiert sind die Bilder durch imagesLoaded schon
      await Promise.all(els.map((e) => {
        if (e.kind !== 'img' || !e.src) return
        const img = Object.assign(new Image(), { src: e.src })
        return img.decode().then(() => void (e.nat = { w: img.naturalWidth, h: img.naturalHeight }), () => {})
      }))
      return { fit, els }
    },
    async hideExportables(on: boolean | 'text') { // 'text': nur Text ausblenden (Word-Export: alles andere bleibt im Hintergrundbild)
      document.body.classList.toggle('hide-exportables', on === true)
      document.body.classList.toggle('hide-text', on === 'text')
      await frames()
    },
    async renderAll(deck: Deck, geo?: PrintGeo) {
      document.querySelectorAll('.bleed-clip').forEach((e) => e.remove()) // Spiegel-Klone des letzten Druck-PDFs; React kennt sie nicht
      await fontsLoaded()
      await loadCustomFont(deck)
      flushSync(() => setState({ deck, index: -1, geo }))
      await frames(3)
      await imagesLoaded(document)
      if (!geo) return
      const { w, h } = sizeOf(deck)
      for (const box of document.querySelectorAll<HTMLElement>('.bleed-slide')) mirrorBleed(box, w, h, geo.bx, geo.by)
      await frames()
    },
  }
  if (!state) return null
  const g = state.geo
  if (mode === 'print' && g) {
    const { w, h } = sizeOf(state.deck)
    const n = state.deck.slides.length
    // Eigene Root-Klasse (.print-root setzt break-after am slide-host); Umbruch nach jeder Seite außer der letzten (keine Leerseite).
    // Chromium-Fallen: Seite auch nur Bruchteile breiter als das Papier → alles verkleinert, deshalb Breite automatisch. Folie per Layout
    // höher als die Seite (A5) → Rest verschoben/gespiegelt, deshalb contain: strict. left/top auf ganze px gerundet → Versatz im transform.
    return (
      <div className="print-bleed">
        {state.deck.slides.map((_, i) => (
          <div key={i} style={{ contain: 'strict', height: `${g.pageH}pt`, breakAfter: i < n - 1 ? 'page' : undefined }}>
            <div className="bleed-slide" style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, transform: `translate(${g.bleed}pt, ${g.bleed}pt) scale(${g.fx}, ${g.fy})`, transformOrigin: '0 0' }}>
              <SlideView deck={state.deck} index={i} print />
            </div>
          </div>
        ))}
        <style>{`@page { size: ${g.pageW}pt ${g.pageH}pt; margin: 0; }`}</style>{/* nach den @page der SlideViews: gewinnt */}
      </div>
    )
  }
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
