// Look: Themes an der eigenen Titelfolie durchblättern; dazu Übergang, Ablauf, Gestaltung (tune), Markenfarben, Logo und Schriften.
// Jede Wahl gilt sofort (Undo-fähig), „Abbrechen“ stellt den Stand beim Öffnen wieder her.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Sparkles, X } from 'lucide-react'
import { MOTIONS, TRANSITIONS, sizeOf, type AnimSpeed, type BrandKit, type Deck, type Motion, type ThemeTune, type Transition } from '../../shared/deck'
import { FONT_PAIRS, THEMES, resolveTheme, themeFromSpec } from '../../shared/themes'
import { SlideView } from '../slide'
import { OWN_DESIGN } from './Chat'
import { FontPicker } from './FontPicker'
import { playTransition } from './PresentScreen'
import { Select } from './kit'

const BOLD = 'Gestalte das Deck im Stil mutig neu (Design-Guide §6 „Stil des Decks“): ein eigenes mutiges Design, dann die Folien mit mehr Farbflächen, Plakat-Typo und starken Bildern überarbeiten. Aussagen und Zahlen bleiben.'
const PROPOSE = 'Schlage mir 3 eigene Looks für dieses Deck vor, passend zu Thema und Publikum und deutlich verschieden in Struktur, nicht nur in der Farbe.'

const MOTION: Record<Motion, string> = { none: 'Keine', calm: 'Ruhig', standard: 'Standard', lively: 'Lebhaft' }
// Gestaltung (ThemeRef.tune): Hebel, Titel, Erklärung, Optionen. Die Standard-Option (was das Theme selbst macht) entfernt den Schlüssel.
type TuneKey = 'titleSize' | 'headWeight' | 'leading' | 'measure' | 'labels' | 'margin' | 'signature' | 'heroTone' | 'images' | 'chart'
type TuneRow = [TuneKey, string, string, [string | number, string][]]
const TYPO: TuneRow[] = [
  ['titleSize', 'Titel', 'Größe der Folientitel', [['normal', 'Normal'], ['large', 'Groß'], ['huge', 'Riesig']]],
  ['headWeight', 'Titelgewicht', 'Schnitt der Überschriften', [[400, 'Normal'], [700, 'Fett']]],
  ['leading', 'Zeilenabstand', 'Abstand zwischen den Zeilen im Text', [['tight', 'Eng'], ['normal', 'Normal'], ['open', 'Offen']]],
  ['measure', 'Satzbreite', 'Wie breit Textspalten höchstens laufen; schmal liest sich ruhiger', [['narrow', 'Schmal'], ['standard', 'Standard'], ['wide', 'Breit']]],
  ['labels', 'Rubriken', 'Schreibweise der Rubrik über dem Titel und der Fußzeile', [['sentence', 'Normal'], ['caps', 'Versalien']]],
]
const SPACE: TuneRow[] = [
  ['margin', 'Ränder', 'Abstand zum Folienrand; Bundsteg = breiter Rand links', [['standard', 'Standard'], ['generous', 'Großzügig'], ['asymmetric', 'Bundsteg']]],
  ['signature', 'Signatur', 'Ein wiederkehrendes Element: Haarlinie über dem Titel, Farbkante am Rand oder Rahmen mit Abstand', [['none', 'Keine'], ['rule', 'Linie'], ['edge', 'Kante'], ['passepartout', 'Rahmen']]],
  ['heroTone', 'Titel- und Schlussfolie', 'Grund der Titel- und Schlussfolie', [['normal', 'Normal'], ['field', 'Farbfläche'], ['invert', 'Invertiert']]],
  ['images', 'Bilder', 'Fotos einheitlich: Originalfarben, schwarzweiß oder in Theme-Farben', [['natural', 'Natürlich'], ['mono', 'Schwarzweiß'], ['duotone', 'Duotone']]],
  ['chart', 'Diagramme', 'Fokus = eine Reihe in der Akzentfarbe, Rest grau; Zwei Farben = Akzent und Zweitfarbe; Tonal = Abstufungen einer Farbe', [['focus', 'Fokus'], ['duo', 'Zwei Farben'], ['tonal', 'Tonal']]],
]
// nur diese Schlüssel zählt und entfernt das Panel; weitere (headTracking, rule, elements, labelFont) setzt die KI und bleiben
const OFFERED: (keyof ThemeTune)[] = [...[...TYPO, ...SPACE].map(([k]) => k), 'field']

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
  const [orig] = useState(() => ({ theme: deck.theme, transition: deck.transition, transitionSpeed: deck.transitionSpeed, mode: deck.mode, motion: deck.motion, builds: new Map(deck.slides.map((s) => [s.id, s.build])) }))
  const sheet = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(720)
  // Raum-Hebel wirken auf Inhaltsfolien, die Hauptkarte zeigt aber die Titelfolie: daneben die erste Inhaltsfolie
  const inner = deck.slides.findIndex((s) => !['cover', 'section', 'closing'].includes(s.layout))
  useLayoutEffect(() => {
    sheet.current?.focus()
    const { w: dw, h: dh } = sizeOf(deck)
    // an der Höhe der Bühne statt des Fensters: die aufgeklappte Gestaltung nimmt ihr Platz weg
    const fit = () => setW(Math.max(240, Math.min(720, Math.round(innerWidth * (inner >= 0 ? 0.4 : 0.5)), Math.round(((stage.current!.clientHeight - 24) * dw) / dh))))
    const ro = new ResizeObserver(fit)
    ro.observe(stage.current!)
    return () => ro.disconnect()
  }, [deck.size?.w, deck.size?.h, inner >= 0]) // eslint-disable-line react-hooks/exhaustive-deps

  // eigenes Theme (von der KI angelegt) bleibt als erster Eintrag wählbar
  // alte Themes nur, wenn das Deck gerade eins nutzt; mutige nur im Stil mutig
  const ids = [...(orig.theme.custom ? ['custom'] : []), ...THEMES.filter((t) => (!t.legacy && (!t.mutig || deck.style === 'mutig')) || t.id === orig.theme.id).map((t) => t.id)]
  const at = Math.max(0, ids.indexOf(deck.theme.custom ? 'custom' : deck.theme.id))
  // Gestaltung (tune) liegt über jedem Theme und bleibt beim Blättern
  const themeRef = (id: string) => (id === 'custom' ? { ...orig.theme, brand: deck.theme.brand, tune: deck.theme.tune } : { id, brand: deck.theme.brand, tune: deck.theme.tune })
  const themeOf = (id: string) => (id === 'custom' ? themeFromSpec(orig.theme.custom!) : THEMES.find((t) => t.id === id) ?? THEMES[0])
  const pick = (i: number) => patchDeck({ theme: themeRef(ids[(i + ids.length) % ids.length]) }, 'look-theme')
  const preview = (i: number) => ({ ...deck, theme: themeRef(ids[(i + ids.length) % ids.length]) })

  // Übergang wählen spielt ihn auf der großen Karte vor: Folie 2 kommt über Folie 1 (wie beim Präsentieren)
  const [demo, setDemo] = useState<{ t: Transition; n: number; speed?: AnimSpeed } | null>(null)
  const base = useRef<HTMLDivElement>(null)
  const incoming = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!demo || !incoming.current) return
    const a = playTransition(demo.t, 1, incoming.current, base.current, demo.speed)
    let timer = 0
    a.finished.then(() => { timer = window.setTimeout(() => setDemo(null), 900) }, () => {})
    return () => { clearTimeout(timer); a.cancel(); base.current?.getAnimations().forEach((x) => x.cancel()) }
  }, [demo])
  const chooseTransition = (x: Transition, speed = deck.transitionSpeed) => {
    patchDeck({ transition: x, transitionSpeed: speed })
    setDemo(x !== 'none' && x !== 'morph' && deck.slides.length > 1 ? { t: x, n: Date.now(), speed } : null)
  }

  const t = themeOf(ids[at])
  const brand = deck.theme.brand
  const [saved, setSaved] = useState<BrandKit | null>(null) // gespeichertes Brand-Kit (brand.json)
  useEffect(() => { void window.api.getBrand().then(setSaved) }, [])
  const setBrand = (p: Partial<BrandKit>, tag?: string) => patchDeck({ theme: { ...deck.theme, brand: { primary: t.c.accent, ...brand, ...p } } }, tag)
  // Gestaltung: Standard je Hebel = was das Theme ohne Feinschliff macht (eigene Designs bringen eigene Werte mit)
  const tune = deck.theme.tune ?? {}
  const own = ids[at] === 'custom' ? orig.theme.custom : undefined
  const plain = resolveTheme({ ...deck.theme, tune: undefined }) // mit Marken- und Mischschriften, ohne Feinschliff
  const scale = plain.headScale ?? 1
  const std: Record<TuneKey, string | number> = {
    titleSize: scale > 1.3 ? 'huge' : scale > 1 ? 'large' : 'normal', headWeight: plain.head.weight >= 600 ? 700 : 400,
    leading: own?.leading ?? 'normal', measure: own?.measure ?? 'standard', labels: own?.labels ?? 'sentence', margin: own?.margin ?? 'standard',
    signature: own?.signature?.kind ?? 'none', heroTone: own?.heroTone ?? 'normal', images: own?.images ?? 'natural', chart: own?.chart ?? 'focus',
  }
  const curTune = (k: TuneKey) => (k === 'signature' ? tune.signature?.kind : tune[k]) ?? std[k]
  const setTune = (p: ThemeTune, tag?: string) => {
    const next: ThemeTune = { ...tune, ...p }
    for (const k of Object.keys(next) as (keyof ThemeTune)[]) if (next[k] === undefined) delete next[k]
    patchDeck({ theme: { ...deck.theme, tune: Object.keys(next).length ? next : undefined } }, tag)
  }
  const tuned = OFFERED.filter((k) => tune[k] !== undefined).length
  // Tag je Hebel: mehrere Klicks auf denselben Hebel sind ein Undo-Schritt, verschiedene Hebel getrennte
  const tuneGroups = (rows: TuneRow[]) => rows.filter(([k]) => k !== 'headWeight' || !plain.head.single).map(([k, label, title, opts]) => (
    <div key={k} className="look-group" title={title}>
      <b>{label}</b>
      <div className="seg" role="group" aria-label={label}>
        {opts.filter(([v]) => v !== 'huge' || deck.style === 'mutig' || curTune(k) === 'huge' || std[k] === 'huge').map(([v, name]) => (
          <button key={v} aria-pressed={curTune(k) === v}
            onClick={() => curTune(k) !== v && setTune({ [k]: v === std[k] ? undefined : k === 'signature' ? { kind: v } : v } as ThemeTune, `look-tune-${k}`)}>{name}</button>
        ))}
      </div>
    </div>
  ))
  const [tuneOpen] = useState(() => !!deck.theme.tune) // nur Startwert, danach klappt der Nutzer selbst
  const userToggle = useRef(false) // das initiale open (tuneOpen) löst auch toggle aus, soll aber nicht scrollen
  const field = own?.field ?? plain.c.accent // Standard der Flächenfarbe ist die Akzentfarbe

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

      <div className="look-stage" ref={stage}>
        {ids.length > 1 && (
          <button className="look-side" aria-label={`Theme ${themeOf(ids[(at - 1 + ids.length) % ids.length]).name}`} onClick={() => pick(at - 1)}>
            <div className="look-card"><SlideView deck={preview(at - 1)} index={0} width={Math.round(w * 0.66)} /></div>
          </button>
        )}
        <div className="look-pair">
          <div className="look-card look-main">
            <div ref={base}><SlideView deck={deck} index={0} width={w} /></div>
            {demo && <div ref={incoming} key={demo.n} className="look-demo"><SlideView deck={deck} index={1} width={w} /></div>}
          </div>
          {inner >= 0 && <div className="look-card" title="Erste Inhaltsfolie"><SlideView deck={deck} index={inner} width={Math.round(w * 0.5)} /></div>}
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
            {deck.transition !== 'none' && (
              <div className="seg" role="group" aria-label="Tempo der Übergänge">
                {(['slow', undefined, 'fast'] as const).map((sp) => (
                  <button key={sp ?? 'normal'} aria-pressed={deck.transitionSpeed === sp} onClick={() => chooseTransition(deck.transition, sp)}>{sp === 'slow' ? 'Langsam' : sp === 'fast' ? 'Schnell' : 'Normal'}</button>
                ))}
              </div>
            )}
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
            <div className="seg" title="Wie mutig die KI gestaltet: sachlich = zurückhaltend, mutig = kräftige Farben, Plakat-Typo, starke Bilder; ohne Wahl entscheidet die KI nach Anlass">
              <button aria-pressed={deck.style === 'sachlich'} onClick={() => patchDeck({ style: 'sachlich' })}>Sachlich</button>
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
        {/* aufgeklappt nach oben ins Bild holen: das Panel scrollt, damit die Vorschau stehen bleibt */}
        <details className="look-tune" open={tuneOpen}
          onToggle={(e) => { if (e.currentTarget.open && userToggle.current) e.currentTarget.scrollIntoView({ block: 'start', behavior: 'smooth' }); userToggle.current = false }}>
          <summary onClick={() => { userToggle.current = true }}>
            <ChevronRight size={15} className="look-tune-chev" aria-hidden />
            <b>Gestaltung</b>
            <span>{tuned ? `${tuned} von Hand gesetzt, gilt über jedem Theme` : 'Ränder, Satzbreite, Titel, Signatur … für alle Folien'}</span>
          </summary>
          <div className="look-row">{tuneGroups(TYPO)}</div>
          <div className="look-row">
            {tuneGroups(SPACE)}
            <div className="look-group" title="Farbe großer Flächen: Kapiteltrenner, Farbbänder, hervorgehobene Karten">
              <b>Flächenfarbe</b>
              <label className="swatch" style={{ background: tune.field ?? field }}>
                <input type="color" aria-label="Flächenfarbe" value={tune.field ?? field} onChange={(e) => setTune({ field: e.target.value.toUpperCase() }, 'look-tune-field')} />
              </label>
              {tune.field
                ? <button className="plain tint" onClick={() => setTune({ field: undefined })}>Wie im Theme</button>
                : <span className="muted">aus dem Theme</span>}
            </div>
          </div>
          <p className="look-tune-note">Weniger ist mehr: ein, zwei Hebel reichen meist.
            {tuned > 0 && <button className="plain tint" onClick={() => setTune(Object.fromEntries(OFFERED.map((k) => [k, undefined])))}>Zurücksetzen</button>}
          </p>
        </details>
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
              ? <button className="plain tint" onClick={() => patchDeck({ theme: { id: deck.theme.id, custom: deck.theme.custom, tune: deck.theme.tune } })}>Zurücksetzen</button>
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
            {brand?.logo && (brand.logoDark
              ? <span className="pill" title="Logo für dunklen Grund">hell: {decodeURIComponent(brand.logoDark).split('/').pop()}
                  <button className="plain" aria-label="Logo für dunklen Grund entfernen" onClick={() => setBrand({ logoDark: undefined })}><X size={13} /></button></span>
              : <button className="pill logo-pill" title="Zweites Logo für dunkle Folien" onClick={async () => { const src = await pickImage(); if (src) setBrand({ logoDark: src }) }}><Plus size={14} />Für dunklen Grund</button>)}
          </div>
          <div className="look-group">
            <b>Überschriften</b>
            <FontPicker aria-label="Schrift der Überschriften" placeholder="Wie im Theme" value={brand?.headFont} onChange={(f) => setBrand({ headFont: f })} />
            <FontPicker aria-label="Schrift des Fließtexts" placeholder="Text wie im Theme" value={brand?.bodyFont} onChange={(f) => setBrand({ bodyFont: f })} />
          </div>
          <div className="look-group">
            <b>Brand-Kit</b>
            <button className="pill" disabled={!brand} title="Marke dieses Decks für jedes neue Deck der KI speichern (~/Deckwerk/brand.json)"
              onClick={() => void window.api.setBrand(brand!).then(() => setSaved(brand!))}>Als Standard speichern</button>
            <button className="pill" disabled={!saved} title="Gespeicherte Marke auf dieses Deck anwenden"
              onClick={() => saved && patchDeck({ theme: { ...deck.theme, brand: saved } })}>Standard übernehmen</button>
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
