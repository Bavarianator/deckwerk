// Eigenes Theme von Hand: alle ThemeSpec-Felder, die nicht schon die Gestaltung (ThemeRef.tune im Look) anbietet.
// Startet vom sichtbaren Theme (Katalog als Spec ausgeklappt); jede Änderung geht sofort als custom ans Deck, die Leitplanken
// von themeFromSpec/resolveTheme (gedämpfter Grund, Kontraste) bleiben aktiv und werden angezeigt.
import { useEffect, useRef, useState } from 'react'
import { DECORS, TONES, type Deck, type ThemeRef, type ThemeSpec, type ThemeTune } from '../../shared/deck'
import { CATALOG_THEMES, FONTS, FONT_NAMES, THEMES, resolveTheme, type FontRef, type Theme } from '../../shared/themes'
import { fontInfo } from '../../shared/font-catalog'
import { FontPicker } from './FontPicker'
import { Select } from './kit'

// Tune-Schlüssel, die nur dieser Editor setzt: ein gesetzter Feinschliff schlüge die Spec, deshalb übernimmt der Editor ihn
const OWN_TUNE = ['headTracking', 'rule', 'elements', 'labelFont'] as const

const fontName = (f: FontRef) => FONT_NAMES.find((n) => FONTS[n].css === f.css) ?? f.css // eigene Schrift: ihre Familie

// Katalog-Theme als Spec: die Werte, aus denen themeFromSpec es wieder aufbaut
function fromTheme(t: Theme): ThemeSpec {
  const s = t.headScale ?? 1
  return {
    name: t.name, bg: t.c.bg, text: t.c.text, accent: t.c.accent, accent2: t.c.accent2,
    headFont: fontName(t.head), bodyFont: fontName(t.body), radius: t.radius, decor: t.decor, texture: t.texture,
    titleSize: s > 1.3 ? 'huge' : s > 1 ? 'large' : 'normal', titleWeight: t.head.weight >= 600 ? 'bold' : 'regular', headTracking: t.head.tracking,
    rule: t.rule ?? 'none', sectionTone: t.sectionTone, vivid: t.vivid, labelFont: t.mono ? 'mono' : 'body', elements: t.elements ?? 'line',
    field: t.field, leading: t.leading, labels: t.labels, margin: t.margin, measure: t.measure, signature: t.signature, heroTone: t.heroTone, images: t.images, chart: t.chart,
  }
}

// Spec des sichtbaren Themes: Marke, Farbvariante und Schriftwahl fließen ein, der Feinschliff nur mit den Schlüsseln dieses Editors
export function specOf(ref: ThemeRef): ThemeSpec {
  const base = ref.custom ?? fromTheme(THEMES.find((x) => x.id === ref.id) ?? THEMES[0])
  const own = Object.fromEntries(OWN_TUNE.filter((k) => ref.tune?.[k] !== undefined).map((k) => [k, ref.tune![k]])) as ThemeTune
  if (!ref.brand && !ref.shuffle && !ref.fonts) return { ...base, ...own }
  const t = resolveTheme({ ...ref, tune: undefined })
  return { ...base, ...own, bg: t.c.bg, text: t.c.text, accent: t.c.accent, accent2: t.c.accent2, headFont: fontName(t.head), bodyFont: fontName(t.body) }
}

// Ref zur Spec: Marke nur noch fürs Logo (ihre Farben und Schriften schlügen die Spec), Farbvariante weg, eigene Schrift bleibt
export function refOf(ref: ThemeRef, spec: ThemeSpec): ThemeRef {
  const b = ref.brand, cf = ref.customFont
  // eigene Schrift nur über ref.fonts: im Spec bricht ein unbekannter Name die Schema-Prüfung (update_deck der KI);
  // dort steht dann die bisherige bekannte Schrift als Ersatz
  const known = (n?: string) => !!n && ((FONT_NAMES as string[]).includes(n) || fontInfo(n)?.family === n)
  const font = (n: string, old: string | undefined, dflt: string) => (known(n) ? n : known(old) ? old! : dflt)
  const isCf = (n: string) => !!cf && n === cf.family
  const old = ref.custom ?? fromTheme(THEMES.find((x) => x.id === ref.id) ?? THEMES[0])
  const tune = ref.tune && Object.fromEntries(Object.entries(ref.tune).filter(([k, v]) => v !== undefined && !(OWN_TUNE as readonly string[]).includes(k)))
  return {
    ...ref, shuffle: undefined,
    custom: {
      ...spec, name: spec.name.trim().length >= 2 ? spec.name : ref.custom?.name ?? 'Eigenes Theme', // Schema verlangt 2–40 Zeichen
      headFont: font(spec.headFont, old.headFont, 'Arial'), bodyFont: font(spec.bodyFont, old.bodyFont, 'Calibri'),
    },
    brand: b?.logo ? { primary: spec.accent, secondary: spec.accent2, logo: b.logo, logoDark: b.logoDark } : undefined,
    fonts: isCf(spec.headFont) || isCf(spec.bodyFont) ? [isCf(spec.headFont) ? cf!.family : '', isCf(spec.bodyFont) ? cf!.family : ''] : undefined,
    tune: tune && Object.keys(tune).length ? tune : undefined,
  }
}

// Was die Leitplanken an den Vorgaben geändert haben (leer = nichts)
export function guardNotes(spec: ThemeSpec, t: Theme): string[] {
  const diff = (a: string | undefined, b: string) => !!a && a.toLowerCase() !== b.toLowerCase()
  return [
    diff(spec.bg, t.c.bg) && (spec.vivid ? 'Grund aus dem mittleren Helligkeitsband geholt' : 'Grund gedämpft (kräftige Gründe nur mit Farbgrund)'),
    diff(spec.text, t.c.text) && 'Textfarbe für Kontrast angepasst',
    diff(spec.accent, t.c.accent) && 'Akzent für Kontrast angepasst',
  ].filter((x): x is string => !!x)
}

const L: Record<string, string> = {
  none: 'Keins', blobs: 'Blobs', glow: 'Leuchten', rings: 'Ringe', grid: 'Raster', stripe: 'Streifen', dots: 'Punkte', grain: 'Körnung',
  normal: 'Normal', large: 'Groß', huge: 'Riesig', regular: 'Normal', bold: 'Fett', over: 'Über dem Titel', under: 'Unter dem Kopf',
  accent: 'Akzentfläche', invert: 'Invertiert', body: 'Textschrift', mono: 'Mono', line: 'Linien', plain: 'Nur Typografie', solid: 'Flächen',
}
type Enum = [keyof ThemeSpec, string, string, readonly string[]]
const ENUMS: Enum[] = [
  ['titleWeight', 'Titelschnitt', 'Normal wirkt redaktionell, fett sachlich', ['regular', 'bold'] satisfies NonNullable<ThemeSpec['titleWeight']>[]],
  ['labelFont', 'Rubrikschrift', 'Schrift von Rubrik und Fußzeile', ['body', 'mono'] satisfies NonNullable<ThemeSpec['labelFont']>[]],
  ['elements', 'Bauteile', 'Linien = offen mit Kopflinien, Nur Typografie = ohne Linien und Flächen, Flächen = Akzentflächen (Stil mutig)', ['line', 'plain', 'solid'] satisfies NonNullable<ThemeSpec['elements']>[]],
  ['rule', 'Kopflinie', 'Feine Linie über dem Titel oder unter dem Folienkopf', ['none', 'over', 'under'] satisfies NonNullable<ThemeSpec['rule']>[]],
  ['sectionTone', 'Kapitel', 'Grund der Kapiteltrenner', TONES],
  ['decor', 'Motiv', 'Hintergrundmotiv; Keins empfohlen', DECORS],
  ['texture', 'Körnung', 'Feine Papierkörnung', ['', 'grain'] satisfies (NonNullable<ThemeSpec['texture']> | '')[]],
]

interface Props { deck: Deck; onTheme: (theme: Deck['theme'], final: boolean) => void }

export function ThemeEditor({ deck, onTheme }: Props) {
  const ref = deck.theme
  const sent = useRef<ThemeRef | null>(null)
  const open = useRef(false) // Vorschau ohne Abschluss (Ziehen, Farbwahl): Loslassen bzw. Verlassen schließt sie ab
  const [spec, setSpec] = useState(() => specOf(ref))
  // Undo, Theme-Wechsel oder KI: neu vom Deck starten, eigene Änderungen nicht
  useEffect(() => { if (ref !== sent.current) setSpec(specOf(ref)) }, [ref])

  const emit = (p: Partial<ThemeSpec>, final: boolean) => {
    const next = { ...spec, ...p }
    for (const k of Object.keys(next) as (keyof ThemeSpec)[]) if (next[k] === undefined) delete next[k]
    setSpec(next)
    // ein gesetztes tune.headWeight schlüge den neuen Titelschnitt
    const base = 'titleWeight' in p && ref.tune?.headWeight !== undefined ? { ...ref, tune: { ...ref.tune, headWeight: undefined } } : ref
    sent.current = refOf(base, next)
    open.current = !final
    onTheme(sent.current, final)
  }
  const done = () => { if (open.current && sent.current) { open.current = false; onTheme(sent.current, true) } }
  const notes = ref.custom ? guardNotes(spec, resolveTheme(ref)) : []

  const color = (k: 'bg' | 'text' | 'accent' | 'accent2', label: string, auto?: string) => (
    <label className="swatch" style={{ background: spec[k] ?? auto }} title={label}>
      <input type="color" aria-label={label} value={spec[k] ?? auto} onChange={(e) => emit({ [k]: e.target.value.toUpperCase() }, false)} onBlur={done} />
    </label>
  )
  const auto = resolveTheme(refOf(ref, spec)).c
  const slider = (k: 'radius' | 'headTracking', label: string, min: number, max: number, step: number, show: (v: number) => string) => (
    <div className="look-group" title={k === 'radius' ? 'Eckenradius in px: 0–4 empfohlen' : 'Laufweite der Titel in em'}>
      <b>{label}</b>
      <input type="range" aria-label={label} min={min} max={max} step={step} value={spec[k] ?? 0}
        onChange={(e) => emit({ [k]: Number(e.target.value) }, false)} onPointerUp={done} onKeyUp={done} />
      <span className="muted">{show(spec[k] ?? 0)}</span>
    </div>
  )

  return (
    <>
      <div className="look-row">
        <div className="look-group">
          <b>Name</b>
          <input aria-label="Name des Themes" value={spec.name} maxLength={40} onChange={(e) => emit({ name: e.target.value }, false)} onBlur={done} />
        </div>
        <div className="look-group" title="Grund, Text, Akzent, Zweitfarbe">
          <b>Farben</b>
          {color('bg', 'Grund')}
          {color('text', 'Text', auto.text)}
          {color('accent', 'Akzent')}
          {color('accent2', 'Zweitfarbe', auto.accent2)}
          {(spec.text || spec.accent2) && <button className="plain tint" title="Text und Zweitfarbe aus Grund und Akzent ableiten" onClick={() => emit({ text: undefined, accent2: undefined }, true)}>Automatisch</button>}
        </div>
        <div className="look-group" title="Nur im Stil mutig: Grund bleibt kräftig statt gedämpft">
          <b>Farbgrund</b>
          <Select value={spec.vivid ? '1' : ''} aria-label="Farbgrund" onChange={(e) => emit({ vivid: e.target.value ? true : undefined }, true)}>
            <option value="">Gedämpft</option>
            <option value="1">Kräftig</option>
          </Select>
        </div>
      </div>
      <div className="look-row">
        <div className="look-group">
          <b>Schriften</b>
          <FontPicker aria-label="Titelschrift" placeholder="Titelschrift" value={spec.headFont} onChange={(f) => f && emit({ headFont: f }, true)} />
          <FontPicker aria-label="Textschrift" placeholder="Textschrift" value={spec.bodyFont} onChange={(f) => f && emit({ bodyFont: f }, true)} />
        </div>
        {slider('headTracking', 'Laufweite', -0.05, 0.02, 0.005, (v) => `${v.toFixed(3)} em`)}
        {slider('radius', 'Ecken', 0, 28, 1, (v) => `${v} px`)}
      </div>
      <div className="look-row">
        {ENUMS.map(([k, label, title, opts]) => (
          <div key={k} className="look-group" title={title}>
            <b>{label}</b>
            <Select value={String(spec[k] ?? '')} aria-label={label} onChange={(e) => emit({ [k]: e.target.value || undefined }, true)}>
              {/* ohne Wert entscheidet das Theme (z. B. Kapitel = Akzentfläche); Körnung kennt nur aus/an */}
              {k !== 'texture' && spec[k] === undefined && <option value="">Automatisch</option>}
              {opts.map((v) => <option key={v} value={v}>{v ? L[v] : 'Aus'}</option>)}
            </Select>
          </div>
        ))}
      </div>
      <p className="look-tune-note">
        {notes.length ? `Leitplanken: ${notes.join(' · ')}.` : 'Grund, Kontraste und Diagrammfarben leitet Deckwerk aus wenigen Vorgaben ab.'}
        {ref.custom && (
          <button className="plain tint" onClick={() => onTheme({ id: THEMES.some((t) => t.id === ref.id) ? ref.id : CATALOG_THEMES[0].id, brand: ref.brand, tune: ref.tune, fontFiles: ref.fontFiles }, true)}>
            Zurück zum Katalog-Theme
          </button>
        )}
      </p>
    </>
  )
}
