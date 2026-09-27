// Look: Themes an der eigenen Titelfolie durchblättern; dazu Übergang, Ablauf, Markenfarben, Logo und Überschriften.
// Jede Wahl gilt sofort (Undo-fähig), „Abbrechen“ stellt den Stand beim Öffnen wieder her.
import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Sparkles, X } from 'lucide-react'
import { TRANSITIONS, sizeOf, type BrandKit, type Deck, type Transition } from '../../shared/deck'
import { FONT_NAMES, FONT_PAIRS, THEMES, themeFromSpec } from '../../shared/themes'
import { SlideView } from '../slide'
import { OWN_DESIGN } from './Chat'
import { Select } from './kit'

const PROPOSE = 'Schlage mir 3 Looks für dieses Deck vor, passend zu Thema und Publikum, darunter mindestens ein ganz eigenes Design.'

const TRANSITION: Record<Transition, string> = { none: 'Keiner', fade: 'Überblenden', push: 'Schieben', morph: 'Morph', dissolve: 'Auflösen', wipe: 'Wischen', cover: 'Überdecken', split: 'Teilen', circle: 'Kreis', zoom: 'Zoom' }

interface Props {
  deck: Deck
  busy: boolean
  patchDeck: (p: Partial<Deck>, tag?: string) => void
  pickImage: () => Promise<string | null>
  onAsk: (text: string) => boolean // „Eigenes Design“: die KI entwirft ein Theme ohne Vorlage
  onClose: () => void
}

export function LookSheet({ deck, busy, patchDeck, pickImage, onAsk, onClose }: Props) {
  const [orig] = useState(() => ({ theme: deck.theme, transition: deck.transition, mode: deck.mode }))
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
  const ids = [...(orig.theme.custom ? ['custom'] : []), ...THEMES.map((t) => t.id)]
  const at = Math.max(0, ids.indexOf(deck.theme.custom ? 'custom' : deck.theme.id))
  const themeRef = (id: string) => (id === 'custom' ? { ...orig.theme, brand: deck.theme.brand } : { id, brand: deck.theme.brand })
  const themeOf = (id: string) => (id === 'custom' ? themeFromSpec(orig.theme.custom!) : THEMES.find((t) => t.id === id) ?? THEMES[0])
  const pick = (i: number) => patchDeck({ theme: themeRef(ids[(i + ids.length) % ids.length]) }, 'look-theme')
  const preview = (i: number) => ({ ...deck, theme: themeRef(ids[(i + ids.length) % ids.length]) })

  const t = themeOf(ids[at])
  const brand = deck.theme.brand
  const setBrand = (p: Partial<BrandKit>, tag?: string) => patchDeck({ theme: { ...deck.theme, brand: { primary: t.c.accent, ...brand, ...p } } }, tag)
  const cancel = () => { patchDeck(orig); onClose() }

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
        <div className="look-card"><SlideView deck={deck} index={0} width={w} /></div>
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
            <div className="seg">
              {TRANSITIONS.map((x) => <button key={x} aria-pressed={deck.transition === x} onClick={() => patchDeck({ transition: x })}>{TRANSITION[x]}</button>)}
            </div>
          </div>
          <div className="look-group">
            <b>Ablauf</b>
            <div className="seg">
              <button aria-pressed={deck.mode === 'click'} onClick={() => patchDeck({ mode: 'click' })}>Per Klick</button>
              <button aria-pressed={deck.mode === 'auto'} onClick={() => patchDeck({ mode: 'auto' })}>Selbstlauf</button>
            </div>
          </div>
        </div>
        {deck.transition === 'morph' && <p className="look-note">Morph läuft in PowerPoint. In der Vorschau blendet Deckwerk über.</p>}
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
