// Look: Themes an der eigenen Titelfolie durchblättern; dazu Übergang, Ablauf, Markenfarben, Logo und Überschriften.
// Jede Wahl gilt sofort (Undo-fähig), „Abbrechen“ stellt den Stand beim Öffnen wieder her.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Sparkles, X } from 'lucide-react'
import { MOTIONS, TRANSITIONS, sizeOf, type BrandKit, type Deck, type Motion, type Transition } from '../../shared/deck'
import { FONT_NAMES, FONT_PAIRS, THEMES, themeFromSpec } from '../../shared/themes'
import { SlideView } from '../slide'
import { OWN_DESIGN } from './Chat'
import { playTransition } from './PresentScreen'
import { Select } from './kit'

const BOLD = 'Gestalte das Deck im Stil mutig neu (Design-Guide §6 „Stil des Decks“): ein eigenes mutiges Design, dann die Folien mit mehr Farbflächen, Plakat-Typo und starken Bildern überarbeiten. Aussagen und Zahlen bleiben.'
const PROPOSE = 'Schlage mir 3 eigene Looks für dieses Deck vor, passend zu Thema und Publikum und deutlich verschieden in Struktur, nicht nur in der Farbe.'

const MOTION: Record<Motion, string> = { none: 'Keine', calm: 'Ruhig', standard: 'Standard', lively: 'Lebhaft' }
export const TRANSITION: Record<Transition, string> = {
  none: 'Keiner', fade: 'Überblenden', push: 'Schieben', morph: 'Morph', dissolve: 'Auflösen', wipe: 'Wischen', cover: 'Überdecken', split: 'Teilen',
  circle: 'Kreis', zoom: 'Zoom', slide: 'Slide', stack: 'Stapel', color: 'Farbwischen',
}

interface Props {
  deck: Deck
  busy: boolean
  patchDeck: (p: Partial<Deck>, tag?: string) => void
  pickImage: () => Promise<string | null>
  onAsk: (text: string) => boolean // „Eigenes Design“: die KI entwirft ein Theme ohne Vorlage
  onClose: () => void
}

export function LookSheet({ deck, busy, patchDeck, pickImage, onAsk, onClose }: Props) {
  const [orig] = useState(() => ({ theme: deck.theme, transition: deck.transition, mode: deck.mode, motion: deck.motion, builds: new Map(deck.slides.map((s) => [s.id, s.build])) }))
  const sheet = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(720)
  useLayoutEffect(() => {
    sheet.current?.focus()
    const { w: dw, h: dh } = sizeOf(deck)
    const fit = () => setW(Math.max(240, Math.min(720, Math.round(innerWidth * 0.5), Math.round(((innerHeight - 560) * dw) / dh))))
    fit()
    addEventListener('resize', fit)
    return () => removeEventListener('resize', fit)
  }, [deck.size?.w, deck.size?.h]) // eslint-disable-line react-hooks/exhaustive-deps

  // eigenes Theme (von der KI angelegt) bleibt als erster Eintrag wählbar
  // alte Themes nur, wenn das Deck gerade eins nutzt
  const ids = [...(orig.theme.custom ? ['custom'] : []), ...THEMES.filter((t) => !t.legacy || t.id === orig.theme.id).map((t) => t.id)]
  const at = Math.max(0, ids.indexOf(deck.theme.custom ? 'custom' : deck.theme.id))
  const themeRef = (id: string) => (id === 'custom' ? { ...orig.theme, brand: deck.theme.brand } : { id, brand: deck.theme.brand })
  const themeOf = (id: string) => (id === 'custom' ? themeFromSpec(orig.theme.custom!) : THEMES.find((t) => t.id === id) ?? THEMES[0])
  const pick = (i: number) => patchDeck({ theme: themeRef(ids[(i + ids.length) % ids.length]) }, 'look-theme')
  const preview = (i: number) => ({ ...deck, theme: themeRef(ids[(i + ids.length) % ids.length]) })

  // Übergang wählen spielt ihn auf der großen Karte vor: Folie 2 kommt über Folie 1 (wie beim Präsentieren)
  const [demo, setDemo] = useState<{ t: Transition; n: number } | null>(null)
  const base = useRef<HTMLDivElement>(null)
  const incoming = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!demo || !incoming.current) return
    const a = playTransition(demo.t, 1, incoming.current, base.current)
    let timer = 0
    a.finished.then(() => { timer = window.setTimeout(() => setDemo(null), 900) }, () => {})
    return () => { clearTimeout(timer); a.cancel(); base.current?.getAnimations().forEach((x) => x.cancel()) }
  }, [demo])
  const chooseTransition = (x: Transition) => {
    patchDeck({ transition: x })
    setDemo(x !== 'none' && x !== 'morph' && deck.slides.length > 1 ? { t: x, n: Date.now() } : null)
  }

  const t = themeOf(ids[at])
  const brand = deck.theme.brand
  const setBrand = (p: Partial<BrandKit>, tag?: string) => patchDeck({ theme: { ...deck.theme, brand: { primary: t.c.accent, ...brand, ...p } } }, tag)
  const cancel = () => {
    const { builds, ...rest } = orig
    patchDeck({ ...rest, slides: deck.slides.map((s) => ({ ...s, build: builds.get(s.id) })) }) // auch Magic Animate zurück
    onClose()
  }

  return (
    <div
      className="look" ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Look"
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest('input, select')) return
        if (e.key === 'ArrowLeft') pick(at - 1)
        else if (e.key === 'ArrowRight') pick(at + 1)
        else if (e.key === 'Escape') cancel()
        else return
        e.preventDefault()
        e.stopPropagation() // App blättert sonst die Folien
      }}
    >
      <header className="top">
        <div className="top-l"><button className="plain tint" onClick={cancel}>Abbrechen</button></div>
        <b>Look</b>
        <div className="top-r"><button className="pill tint" onClick={onClose}>Fertig</button></div>
      </header>
      <p className="look-hint">Das Theme gilt für alle {deck.slides.length} Folien. Deine Inhalte bleiben, wie sie sind.</p>

      <div className="look-stage">
        {ids.length > 1 && (
          <button className="look-side" aria-label={`Theme ${themeOf(ids[(at - 1 + ids.length) % ids.length]).name}`} onClick={() => pick(at - 1)}>
            <div className="look-card"><SlideView deck={preview(at - 1)} index={0} width={Math.round(w * 0.66)} /></div>
          </button>
        )}
        <div className="look-card look-main">
          <div ref={base}><SlideView deck={deck} index={0} width={w} /></div>
          {demo && <div ref={incoming} key={demo.n} className="look-demo"><SlideView deck={deck} index={1} width={w} /></div>}
        </div>
        {ids.length > 1 && (
          <button className="look-side" aria-label={`Theme ${themeOf(ids[(at + 1) % ids.length]).name}`} onClick={() => pick(at + 1)}>
            <div className="look-card"><SlideView deck={preview(at + 1)} index={0} width={Math.round(w * 0.66)} /></div>
          </button>
        )}
      </div>

      <div className="look-name">
        <h2>{t.name}</h2>
        <p>{ids[at] === 'custom' ? 'Eigenes Design von Deckwerk · ' : ''}{t.dark ? 'Dunkel' : 'Hell'} · {t.head.pptx}{t.body.pptx !== t.head.pptx ? ` und ${t.body.pptx}` : ''}</p>
        <div className="look-ai">
          <button className="plain tint look-own" disabled={busy} onClick={() => { if (onAsk(PROPOSE)) onClose() }}>
            <Sparkles size={15} />Looks für dieses Deck vorschlagen
          </button>
          <button className="plain tint look-own" disabled={busy} onClick={() => { if (onAsk(OWN_DESIGN)) onClose() }}>
            <Sparkles size={15} />{orig.theme.custom ? 'Neues eigenes Design entwerfen' : 'Eigenes Design entwerfen lassen'}
          </button>
        </div>
      </div>
      <div className="look-dots">
        <button className="look-arrow" aria-label="Vorheriges Theme" onClick={() => pick(at - 1)}><ChevronLeft size={15} /></button>
        <div className="look-strip" role="listbox" aria-label="Alle Themes">
          {ids.map((id, i) => (
            <button key={id} role="option" aria-selected={i === at} className={`look-thumb ${i === at ? 'on' : ''}`} title={themeOf(id).name} onClick={() => pick(i)}>
              <span><SlideView deck={preview(i)} index={0} width={112} /></span>
              <small>{themeOf(id).name}</small>
            </button>
          ))}
        </div>
        <button className="look-arrow" aria-label="Nächstes Theme" onClick={() => pick(at + 1)}><ChevronRight size={15} /></button>
      </div>

      <section className="look-panel" aria-label="Einstellungen für das ganze Deck">
        <div className="look-row">
          <div className="look-group">
            <b>Übergang</b>
            {/* 13 Übergänge passen nicht in eine Knopfleiste; jede Wahl spielt die Vorschau auf der Karte */}
            <Select value={deck.transition} aria-label="Übergang" onChange={(e) => chooseTransition(e.target.value as Transition)}>
              {TRANSITIONS.map((x) => <option key={x} value={x}>{TRANSITION[x]}</option>)}
            </Select>
          </div>
          <div className="look-group">
            <b>Ablauf</b>
            <div className="seg">
              <button aria-pressed={deck.mode === 'click'} onClick={() => patchDeck({ mode: 'click' })}>Per Klick</button>
              <button aria-pressed={deck.mode === 'auto'} onClick={() => patchDeck({ mode: 'auto' })}>Selbstlauf</button>
            </div>
          </div>
          <div className="look-group">
            <b>Stil</b>
            <div className="seg" title="Wie mutig die KI gestaltet: sachlich = zurückhaltend, mutig = kräftige Farben, Plakat-Typo, starke Bilder">
              <button aria-pressed={deck.style !== 'mutig'} onClick={() => patchDeck({ style: undefined })}>Sachlich</button>
              <button aria-pressed={deck.style === 'mutig'} onClick={() => patchDeck({ style: 'mutig' })}>Mutig</button>
            </div>
          </div>
          <div className="look-group">
            <b>Animation</b>
            <div className="seg" title="Wie Canva Magic Animate: setzt die Aufbauten aller Folien auf einen Stil (einzelne Folien danach unter Anpassen)">
              {MOTIONS.map((m) => (
                <button key={m} aria-pressed={(deck.motion ?? 'standard') === m}
                  onClick={() => patchDeck({ motion: m === 'standard' ? undefined : m, slides: deck.slides.map((x) => (x.build ? { ...x, build: undefined } : x)) })}>{MOTION[m]}</button>
              ))}
            </div>
          </div>
        </div>
        {deck.style === 'mutig' && (
          <p className="look-note">Mutig: kräftige Farben, Plakat-Typo, mehr Farbflächen und markante Bilder. Gilt für alles, was die KI ab jetzt gestaltet.{' '}
            <button className="plain tint" disabled={busy} onClick={() => { if (onAsk(BOLD)) onClose() }}>Jetzt mutig neu gestalten</button>
          </p>
        )}
        {deck.transition === 'morph' && <p className="look-note">Morph lässt gleiche Elemente an ihren neuen Platz wandern (Präsentieren und PowerPoint). Meist besser nur für einzelne Folien: Folie wählen, Anpassen → Übergang.</p>}
        <div className="look-row">
          <div className="look-group">
            <b>Markenfarben</b>
            <label className="swatch" style={{ background: brand?.primary ?? t.c.accent }} title="Primärfarbe">
              <input type="color" aria-label="Primärfarbe" value={brand?.primary ?? t.c.accent} onChange={(e) => setBrand({ primary: e.target.value.toUpperCase() }, 'brand-primary')} />
            </label>
            <label className="swatch" style={{ background: brand?.secondary ?? t.c.accent2 }} title="Sekundärfarbe">
              <input type="color" aria-label="Sekundärfarbe" value={brand?.secondary ?? t.c.accent2} onChange={(e) => setBrand({ secondary: e.target.value.toUpperCase() }, 'brand-secondary')} />
            </label>
            {brand
              ? <button className="plain tint" onClick={() => patchDeck({ theme: { id: deck.theme.id, custom: deck.theme.custom } })}>Zurücksetzen</button>
              : <span className="muted">aus dem Theme</span>}
          </div>
          <div className="look-group">
            <b>Logo</b>
            {brand?.logo ? (
              <span className="pill" title={decodeURIComponent(brand.logo)}>
                {decodeURIComponent(brand.logo).split('/').pop()}
                <button className="plain" aria-label="Logo entfernen" onClick={() => setBrand({ logo: undefined })}><X size={13} /></button>
              </span>
            ) : (
              <button className="pill logo-pill" onClick={async () => { const src = await pickImage(); if (src) setBrand({ logo: src }) }}><Plus size={14} />Hinzufügen</button>
            )}
          </div>
          <div className="look-group">
            <b>Überschriften</b>
            <Select aria-label="Schrift der Überschriften" value={brand?.headFont ?? ''} onChange={(e) => setBrand({ headFont: (e.target.value || undefined) as BrandKit['headFont'] })}>
              <option value="">Wie im Theme</option>
              {FONT_NAMES.map((f) => <option key={f}>{f}</option>)}
            </Select>
          </div>
          <div className="look-group">
            <b>Mischen</b>
            <button className="pill" title="Farbvariante des Themes: Akzente tauschen, Hell/Dunkel tauschen, Grund tönen"
              onClick={() => patchDeck({ theme: { ...deck.theme, shuffle: ((deck.theme.shuffle ?? 0) + 1) % 6 || undefined } }, 'look-shuffle')}>Farben mischen</button>
            <button className="pill" title="Nächstes kuratiertes Schriftpaar (Titel + Text)"
              onClick={() => { const i = FONT_PAIRS.findIndex(([h, b]) => h === deck.theme.fonts?.[0] && b === deck.theme.fonts?.[1]); patchDeck({ theme: { ...deck.theme, fonts: FONT_PAIRS[(i + 1) % FONT_PAIRS.length] } }, 'look-fonts') }}>Schriften mischen</button>
            <button className="pill" title="Eigene Schrift (TTF, Regular und optional Bold) für die Überschriften; wird in die PPTX eingebettet"
              onClick={async () => { const f = await window.api.pickFont(); if (f) patchDeck({ theme: { ...deck.theme, customFont: f, fonts: [f.family, deck.theme.fonts?.[1] ?? ''] } }) }}>
              {deck.theme.customFont ? deck.theme.customFont.family : 'Eigene Schrift …'}
            </button>
          </div>
          <div className="look-group">
            <b>Hausstil</b>
            <button className="pill" title="Vorlieben für alle Decks (Tonfall, Anrede, No-Gos). Die KI ergänzt sie, wenn du „merk dir …“ sagst."
              onClick={() => void window.api.openStyle()}>Bearbeiten …</button>
          </div>
        </div>
      </section>
    </div>
  )
}
