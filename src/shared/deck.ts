// pan, pop, words: Canva-Seitenanimationen (Schwenken, Pop, Wort für Wort)
// photo: Canva „Foto-Zoom“ – randlose Fotos zoomen langsam, Text blendet ein
export const BUILDS = ['none', 'fade', 'list', 'stagger', 'wipe', 'zoom-kpi', 'pan', 'pop', 'words', 'photo'] as const
// slide, stack, color: Canva-Übergänge (Slide, Stapel, Farbwischen)
export const TRANSITIONS = ['none', 'fade', 'push', 'morph', 'dissolve', 'wipe', 'cover', 'split', 'circle', 'zoom', 'slide', 'stack', 'color'] as const
export type BuildPreset = (typeof BUILDS)[number]
export type Transition = (typeof TRANSITIONS)[number]
export const MOTIONS = ['none', 'calm', 'standard', 'lively'] as const // none = keine Aufbauten (Canva Magic Animate „Keine“)
export type Motion = (typeof MOTIONS)[number]
// Folien-Ton: normal = Theme wie definiert, accent = Akzentfläche, invert = Hell/Dunkel getauscht (Rhythmus ohne zweite Palette).
export const TONES = ['normal', 'accent', 'invert'] as const
export type Tone = (typeof TONES)[number]
// Dekor-Motiv der Hintergrundebene (wird als Bild in die PPTX gerastert).
export const DECORS = ['none', 'blobs', 'glow', 'rings', 'grid', 'stripe', 'dots'] as const
export type DecorId = (typeof DECORS)[number]
// Komposition der Inhaltsfolie: top = Titel oben (Standard), split = Titel auf randabfallender Akzentfläche links,
// band = Titel in einem Farbband oben, center = Titel zentriert. Welche Frames ein Layout kann, steht in LayoutDef.frames.
export const FRAMES = ['top', 'split', 'band', 'center'] as const
export type FrameId = (typeof FRAMES)[number]

export interface ThemeRef {
  id: string; brand?: BrandKit; custom?: ThemeSpec; shuffle?: number; fonts?: [string, string]; customFont?: CustomFont
  // Schriften aus dem Katalog (src/shared/font-catalog.ts), in ~/Deckwerk/fonts geladen: Familie → Schnitte als asset://-URL.
  // Zwischengewichte sind eigene Familien („Inter SemiBold“, nur regular). Fehlt ein Eintrag, greift der gebündelte Ersatz.
  fontFiles?: Record<string, FontFiles>
  tune?: ThemeTune // Feinschliff über dem Theme (Katalog oder eigen): gesetzte Tokens schlagen die des Themes
}
// Struktur-Tokens, die Nutzer (Look → Gestaltung) und KI (update_deck) auf jedes Theme legen können; Farben und Schriften bleiben im Theme
export const TUNE_KEYS = ['titleSize', 'headWeight', 'headTracking', 'leading', 'labels', 'labelFont', 'margin', 'measure', 'rule', 'elements', 'signature', 'heroTone', 'field', 'chart', 'images'] as const
export type ThemeTune = Partial<Pick<ThemeSpec, (typeof TUNE_KEYS)[number]>>
export interface FontFiles { regular: string; bold?: string; italic?: string; boldItalic?: string }
// Eigene Schrift (TTF, vom Nutzer gewählt): im Renderer per FontFace, in der PPTX eingebettet. Pfade als asset://-URL.
export interface CustomFont { family: string; regular: string; bold?: string }

export interface BrandKit {
  primary: string // #RRGGBB
  secondary?: string
  logo?: string // asset://local/<abs path>
  logoDark?: string // Logo für dunklen Grund (Theme dark); fehlt es, gilt logo
  headFont?: string // FontName aus src/shared/themes.ts
  bodyFont?: string // FontName für Fließtext
}

// Eigenes Theme, das die KI pro Deck entwirft. Aus wenigen Vorgaben leitet resolveTheme die volle Palette ab
// (Flächen, Rand, Sekundärtext, Diagrammfarben) und erzwingt Kontraste; hell/dunkel folgt aus dem Hintergrund.
export interface ThemeSpec {
  name: string
  bg: string // #RRGGBB
  text?: string
  accent: string
  accent2?: string
  headFont: string // Name aus FONT_LIST (gebündelt) oder dem Schriftkatalog
  bodyFont: string
  radius: number
  decor: DecorId
  texture?: 'grain'
  // Struktur statt nur Farbe: damit eigene Designs sich wirklich unterscheiden
  titleSize?: 'normal' | 'large' | 'huge' // large = Plakat-Titel (rund 1,2×), huge = 1,45× (Stil mutig)
  titleWeight?: 'regular' | 'bold'
  rule?: 'none' | 'over' | 'under' // feine Linie über bzw. unter dem Folienkopf
  sectionTone?: Tone // Kapiteltrenner: accent (Standard), invert oder normal
  vivid?: boolean // kräftiger Farbgrund (Stil mutig); sonst dämpft themeFromSpec den Grund auf Papier- bzw. Dunkeltöne
  labelFont?: 'body' | 'mono' // mono = Eyebrow und Fußzeile in IBM Plex Mono
  elements?: 'line' | 'plain' | 'solid' // Bauteile: line = offen mit Kopflinien, keine Flächen (Standard); plain = nur Typografie und Weißraum, keine Linien und Flächen; solid = Farbflächen (Stil mutig)
  // Themes-Fundament (theme-lint.ts, theme-refs.ts); auch als ThemeRef.tune über jedem Theme
  field?: string // Farbe großer Flächen (Kapitel, split/band, hervorgehobene Karten); Standard = accent
  headWeight?: HeadWeight
  headTracking?: number // em, −0.05 … +0.02
  leading?: Leading
  labels?: Labels
  margin?: Margin
  measure?: Measure
  signature?: Signature
  heroTone?: HeroTone
  chart?: ChartStrategy
  images?: ImageStyle
}
export const HEAD_WEIGHTS = [300, 400, 500, 600, 700, 800, 900] as const
export type HeadWeight = (typeof HEAD_WEIGHTS)[number]
export type TitleSize = NonNullable<ThemeSpec['titleSize']>
export const LEADINGS = ['tight', 'normal', 'open'] as const
export type Leading = (typeof LEADINGS)[number]
export const LABELS = ['sentence', 'caps'] as const
export type Labels = (typeof LABELS)[number]
export const MARGINS = ['standard', 'generous', 'asymmetric'] as const
export type Margin = (typeof MARGINS)[number]
export const MEASURES = ['narrow', 'standard', 'wide'] as const
export type Measure = (typeof MEASURES)[number]
export const HERO_TONES = ['normal', 'field', 'invert'] as const
export type HeroTone = (typeof HERO_TONES)[number]
export const CHART_STRATEGIES = ['focus', 'duo', 'tonal'] as const
export type ChartStrategy = (typeof CHART_STRATEGIES)[number]
export const IMAGE_STYLES = ['natural', 'mono', 'duotone'] as const
export type ImageStyle = (typeof IMAGE_STYLES)[number]
// Genau ein wiederkehrendes Element statt Motiven: Haarlinie über dem Titel, Kante am Folienrand oder Rahmen mit Abstand
export const SIGNATURES = ['none', 'rule', 'edge', 'passepartout'] as const
export interface Signature {
  kind: (typeof SIGNATURES)[number]
  color?: 'accent' | 'field' | 'text'
  size?: number // px: Linienstärke bzw. Kantenbreite
  length?: 'short' | 'full' // rule: 64 px oder volle Satzbreite
  side?: 'left' | 'top' // edge
}

export interface Slide {
  id: string
  layout: string
  variant?: string
  content: any // validated by the layout's zod schema (src/shared/layouts.ts)
  build?: BuildPreset // default comes from the layout
  transition?: Transition // Übergang zu dieser Folie (meist morph); ohne = Deck-Übergang
  transitionSpeed?: AnimSpeed // Tempo des Übergangs zu dieser Folie; ohne = Deck-Tempo
  tone?: Tone // default comes from the layout (section: accent)
  decor?: DecorId // default comes from the theme
  frame?: FrameId // Komposition; default top
  notes?: string
  items?: Item[] // freie Elemente über dem Layout (Canvas: ziehen, skalieren, drehen); Reihenfolge = Ebenen
  bg?: { color?: string; image?: string; gradient?: [string, string]; angle?: number } // eigener Folienhintergrund statt Theme-Fläche; gradient = Verlauf (Winkel in Grad, Standard 135)
  hidden?: boolean // ausgeblendet (Canva „Seite ausblenden“): fehlt beim Präsentieren und im Export, PowerPoint behält sie versteckt
}

// ---- freie Elemente (wie in Canva): Position in px auf der 1280x720-Folie ----
export const SHAPES = ['rect', 'ellipse', 'triangle', 'diamond', 'hexagon', 'star', 'arrow', 'line',
  'chevron', 'pentagon', 'trapezoid', 'parallelogram', 'rtTriangle', 'octagon', 'donut', 'plus', 'heart', 'star4', 'star6', 'star8', 'star12'] as const
// Bildrahmen (Canva „Frames“): Foto in eine Form geschnitten, im Export native Bildgeometrie (patch-xml.ts)
export const MASKS = ['circle', 'arch', 'hexagon', 'diamond', 'octagon', 'star', 'heart'] as const
export type MaskId = (typeof MASKS)[number]
// Texteffekte wie in Canva, alle nativ in PowerPoint (Schatten, Leuchten, Kontur im Textlauf)
export const TEXT_EFFECTS = ['none', 'shadow', 'lift', 'hollow', 'neon'] as const
export type TextEffect = (typeof TEXT_EFFECTS)[number]
// Bildanpassung −100…100 (blur 0…100); nativ als Bildeffekte lum/hsl/blur in PowerPoint
export interface Adjust { bright?: number; contrast?: number; sat?: number; blur?: number }
export const LINE_ENDS = ['none', 'arrow', 'triangle', 'dot'] as const
export type LineEnd = (typeof LINE_ENDS)[number]
export const DASHES = ['solid', 'dash', 'dot'] as const
export type Dash = (typeof DASHES)[number]
export type ShapeId = (typeof SHAPES)[number]
// wie Canva: float = Aufsteigen (Rise); typewriter/ascend nur für Text (Buchstabe/Wort einzeln); breathe = Dauerpuls ohne Klick
export const ITEM_ANIMS = ['none', 'fade', 'float', 'pan', 'drift', 'pop', 'zoom', 'tumble', 'stomp', 'baseline', 'wipe', 'typewriter', 'ascend', 'breathe'] as const
export type ItemAnim = (typeof ITEM_ANIMS)[number]
// Richtung der Bewegung (Canva: Schwenken, Treiben, Wischen, Aufsteigen); ohne = Standard des Stils
export const ANIM_DIRS = ['right', 'left', 'up', 'down'] as const
export type AnimDir = (typeof ANIM_DIRS)[number]
export type AnimSpeed = 'slow' | 'fast' // ohne = normal
// Start wie in PowerPoint: bei Klick, mit vorherigem (gleichzeitig), nach vorherigem (wenn er fertig ist)
export type AnimStart = 'click' | 'with' | 'after'
export interface Item {
  id: string
  kind: 'text' | 'shape' | 'image' | 'icon' | 'chart' | 'video' | 'audio' | 'qr' | 'graphic' // qr: text = Inhalt; graphic: Name aus GRAPHICS
  group?: string // gemeinsame ID = Gruppe: wird zusammen gewählt, verschoben und skaliert
  x: number; y: number; w: number; h: number // Text: h ergibt sich aus dem Inhalt
  rot?: number // Grad im Uhrzeigersinn
  opacity?: number // 0..1
  locked?: boolean
  anim?: ItemAnim // Auftritt beim Präsentieren (nacheinander per Klick)
  animDir?: AnimDir; animSpeed?: AnimSpeed
  animStart?: AnimStart; animDelay?: number // ohne Start: Klick-Modus je ein Klick, Selbstlauf nacheinander; Verzögerung in s (0–10)
  // text
  text?: string
  font?: 'head' | 'body' | string // head/body = Theme-Schrift, sonst FontName
  size?: number // px
  color?: string
  bold?: boolean; italic?: boolean; underline?: boolean
  align?: 'left' | 'center' | 'right'
  lineHeight?: number // Faktor
  spacing?: number // Laufweite in em
  upper?: boolean
  list?: 'bullet' | 'number' // Aufzählung: jede Zeile ein Punkt (PPTX: native Aufzählungszeichen bzw. Nummern)
  effect?: TextEffect; effectColor?: string // Texteffekt; Farbe für Neon/Kontur, sonst Textfarbe
  // shape (fill auch Texthintergrund)
  shape?: ShapeId
  lineStart?: LineEnd; lineEnd?: LineEnd // Linienenden (Form line)
  dash?: Dash // Strichart für Linie und Umriss
  fill?: string; fill2?: string // fill2 = Verlauf (nur Rechteck/Ellipse)
  gradAngle?: number // Winkel des Verlaufs in Grad (CSS-Sinn, Standard 135)
  stroke?: string; strokeW?: number
  radius?: number
  shadow?: boolean
  // image
  src?: string
  look?: 'natural' | 'duotone' | 'mono'
  mask?: MaskId // Bildrahmen
  adjust?: Adjust // Bildanpassung
  round?: boolean
  flipX?: boolean
  crop?: Crop // sichtbarer Ausschnitt des Bildes (Anteile 0..1); ohne = füllend (cover, mittig)
  // video/audio: src; poster = Vorschaubild des Videos (asset://), wird beim Einfügen erzeugt
  poster?: string
  autoplay?: boolean; loop?: boolean; muted?: boolean
  // icon: icon + color; chart: spec
  icon?: string
  graphic?: string
  spec?: ChartSpec
}

export interface Crop { x: number; y: number; w: number; h: number }

// Formate (Magic Resize): Größe in CSS-px, 96 px = 1 Zoll. Die Layouts sind für 16:9 entworfen und passen sich an.
export const FORMATS = {
  '16:9': { name: 'Präsentation 16:9', w: 1280, h: 720 },
  '4:3': { name: 'Präsentation 4:3', w: 960, h: 720 },
  '1:1': { name: 'Quadrat (Instagram-Post)', w: 1080, h: 1080 },
  '4:5': { name: 'Hochformat 4:5 (Instagram)', w: 1080, h: 1350 },
  '9:16': { name: 'Story / Reel 9:16', w: 720, h: 1280 },
  'a4': { name: 'A4 Hochformat', w: 794, h: 1123 },
  'a4-quer': { name: 'A4 Querformat', w: 1123, h: 794 },
  'og': { name: 'Link-Vorschau 1200×630', w: 1200, h: 630 },
  'visitenkarte': { name: 'Visitenkarte 85×55 mm', w: 321, h: 208 }, // Druck: Endformat = Größe bei 96 dpi
} as const
export type FormatId = keyof typeof FORMATS
export interface Size { w: number; h: number }
// Kürzel für Dateinamen (4x5, a4 …); Sondergrößen als 800x600. 16:9 bleibt leer, damit die Namen wie bisher heißen.
export const formatSuffix = (size: Size | undefined): string => {
  // size kommt ungeprüft aus der deck.json (auch fremden): nur Zahlen in den Namen, sonst schriebe "w": "/../../.." den Export irgendwohin
  if (!size || !Number.isFinite(size.w) || !Number.isFinite(size.h) || (size.w === 1280 && size.h === 720)) return ''
  const id = (Object.keys(FORMATS) as FormatId[]).find((k) => FORMATS[k].w === size.w && FORMATS[k].h === size.h)
  return `-${(id ?? `${size.w}x${size.h}`).replace(':', 'x')}`
}
export const sizeOf = (deck: Pick<Deck, 'size'> | null | undefined): Size => deck?.size ?? { w: 1280, h: 720 }

// Druck-PDF (Export „print“): Seite = Endformat + Beschnitt ringsum, TrimBox/BleedBox gesetzt, keine Schnittmarken.
// Beschnitt je Druckerei: Flyeralarm 1 mm, Saxoprint/Onlineprinters 2 mm, WIRmachenDRUCK 3 mm (Stand 10/2026).
// Farben bleiben RGB (Chromium kann kein CMYK); diese Druckereien wandeln selbst, print24 verlangt CMYK.
// size skaliert A4-Seiten (hoch oder quer, Verhältnis 1:√2) verlustfrei auf ein anderes A-Format (A2 = Plakat, A6 = Postkarte); weglassen = Foliengröße.
export const PRINT_SIZES = { a2: [420, 594], a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148] } as const // mm, hochkant
export interface PrintOptions { size?: keyof typeof PRINT_SIZES; bleed?: number } // bleed in mm (0–5), Standard 3

const is = (s: Size, f: Size) => s.w === f.w && s.h === f.h
export const isA4 = (s: Size) => is(s, FORMATS.a4) || is(s, FORMATS['a4-quer'])

// Profil aus der Größe: bestimmt Lint-Grenzen und Guide-Regeln. Druck (A4, Visitenkarte) = Dokument, Quadrat/Hochformat = Social, sonst Folien.
export type Profile = 'slides' | 'social' | 'doc'
export function profileOf(deck: Pick<Deck, 'size'> | null | undefined): Profile {
  const s = sizeOf(deck)
  if (isA4(s) || is(s, FORMATS.visitenkarte)) return 'doc'
  return s.w / s.h <= 1.2 ? 'social' : 'slides'
}

export interface Deck {
  title: string
  size?: Size // Foliengröße in px; ohne = 1280×720 (16:9)
  brief?: { audience?: string; goal?: string; tone?: string }
  // custom hat Vorrang vor id; shuffle = Farbvariante (Canva „Stile mischen“), fonts = Schriftpaar [Titel, Text]
  theme: ThemeRef
  transition: Transition
  transitionSpeed?: AnimSpeed // Tempo der Übergänge; ohne = normal
  motion?: Motion // Bewegungsstil des Decks (Canva „Magic Animate“); einzelne Folien-builds haben Vorrang
  style?: 'sachlich' | 'mutig' // Gestaltungsstil für die KI (Design-Guide §6 „Stil des Decks“); ohne = noch nicht gewählt: die KI wählt beim Anlegen nach Anlass, bis dahin wie sachlich
  mode: 'click' | 'auto' // click = presenter advances builds, auto = builds run by themselves
  music?: { src: string; volume?: number; credit?: string } // Hintergrundmusik im Video-Export (mp4): asset://-Pfad, volume 0–1 (Standard 0,25), credit = Nachweis (CC-BY)
  slides: Slide[]
}
// Folien, die präsentiert und exportiert werden (PDF, PNG, Word, Handout); ausgeblendete fehlen
export const visibleSlides = (deck: Deck): Slide[] => deck.slides.filter((s) => !s.hidden)
// Präsentieren: nur sichtbare Folien. start (Index im ganzen Deck) rückt von einer ausgeblendeten Folie auf die nächste
// sichtbare, hinter der letzten auf die letzte. Sind alle ausgeblendet, läuft das ganze Deck, statt leer abzustürzen.
export function showOf(deck: Deck, start: number): { deck: Deck; start: number } {
  const slides = visibleSlides(deck)
  if (!slides.length) return { deck, start }
  return { deck: { ...deck, slides }, start: Math.min(deck.slides.slice(0, start).filter((s) => !s.hidden).length, slides.length - 1) }
}
// Übergang an der Grenze zu Folie i (die erste Folie hat keinen)
export const transitionOf = (deck: Deck, i: number): Transition => (i <= 0 ? 'none' : deck.slides[i]?.transition ?? deck.transition)
export const transitionSpeedOf = (deck: Deck, i: number): AnimSpeed | undefined => deck.slides[i]?.transitionSpeed ?? deck.transitionSpeed

// Start eines Element-Auftritts; im Selbstlauf gibt es keine Klicks, dort läuft alles nacheinander
export const animStartOf = (start: AnimStart | undefined, mode: Deck['mode']): AnimStart => (mode === 'auto' ? (start === 'with' ? 'with' : 'after') : start ?? 'click')
// Klicks der freien Elemente im Klick-Modus: „mit/nach vorherigem“ und Atmen brauchen keinen
export const itemClicks = (s: Slide) => (s.items ?? []).filter((it) => it.anim && it.anim !== 'none' && it.anim !== 'breathe' && animStartOf(it.animStart, 'click') === 'click').length
// Ablauf der Element-Auftritte wie in PowerPoint (animations.ts): click = neuer Schritt, with = zugleich mit dem vorigen
// (gleicher Kettenbeginn), after = wenn alles Bisherige im Schritt fertig ist; delay (s) kommt jeweils dazu, ms = Dauer.
// Liefert je Schritt die Elemente (k = Index) mit Startzeit in ms ab Schrittbeginn. Schritt 0 läuft ohne Klick und hängt
// am vorigen Schritt (Layout-Aufbau), der nach `end` ms fertig ist und dessen letzte Kette bei `chain` ms beginnt;
// jeder weitere Schritt startet per Klick.
export function itemSteps(items: { start?: AnimStart; delay?: number; ms: number }[], mode: Deck['mode'], end = 0, chain = 0): { k: number; at: number }[][] {
  const steps: { k: number; at: number }[][] = [[]]
  items.forEach((it, k) => {
    const start = animStartOf(it.start, mode)
    if (start === 'click') { steps.push([]); chain = end = 0 }
    else if (start === 'after') chain = end
    const at = chain + (it.delay ?? 0) * 1000
    steps.at(-1)!.push({ k, at })
    end = Math.max(end, at + it.ms)
  })
  return steps
}

// Morph-Zuordnung, gleich in App (PresentScreen), PPTX und Lint. key = Text bzw. Bildquelle: Gleicher Inhalt wandert zuerst
// (Agenda-Punkt → Kapiteltitel, Kennzahl → große Zahl, Galeriebild → Vollbild), danach gleicher Slot. Liefert für jedes
// Element von next den gemeinsamen Namen; gepaart ist es, wenn der Name auf prev vorkommt. Slots je Liste eindeutig.
export interface MorphEl { slot: string; key?: string }
export const morphText = (t: string): string | undefined => { const k = t.replace(/\s+/g, '').toLowerCase(); return k.length > 1 ? k : undefined }
export const morphKey = (e: El): string | undefined => (e.kind === 'text' ? morphText(e.runs.map((r) => r.text).join('')) : e.kind === 'img' ? `img:${e.src}` : undefined)
export function morphNames(prev: MorphEl[], next: MorphEl[]): string[] {
  const slots = new Set(prev.map((e) => e.slot))
  const taken = new Set<string>()
  const byKey = next.map((e) => {
    const cands = prev.filter((p) => p.key && p.key === e.key && !taken.has(p.slot)).map((p) => p.slot)
    const s = cands.includes(e.slot) ? e.slot : cands[0]
    if (s !== undefined) taken.add(s)
    return s
  })
  return next.map((e, k) => {
    if (byKey[k] !== undefined) return byKey[k]
    if (!slots.has(e.slot)) return e.slot
    if (taken.has(e.slot)) return `${e.slot}~` // eigener Slot wandert schon in ein anderes Element
    taken.add(e.slot)
    return e.slot
  })
}

// ---- what the renderer measures and hands to lint + PPTX export (all px, relative to the 1280x720 slide) ----

export interface Box { x: number; y: number; w: number; h: number }

export interface Run { text: string; bold: boolean; italic: boolean; underline?: boolean; color: string; breakAfter?: boolean; link?: string; sizePx?: number; trackingPx?: number } // sizePx/trackingPx nur, wenn die Schrift vom Element abweicht (Einheit einer Kennzahl)

interface Base { slot: string; box: Box; build?: number; rot?: number; anim?: ItemAnim; animDir?: AnimDir; animSpeed?: AnimSpeed }
export interface TextEl extends Base {
  kind: 'text'
  font: 'head' | 'body'
  role: string
  sizePx: number
  effect?: { type: Exclude<TextEffect, 'none'>; color: string }
  fontFace?: string // freier Text mit eigener Schrift (FontName), sonst Theme-Schrift nach `font`
  lineHeightPx: number
  trackingPx: number
  align: 'left' | 'center' | 'right'
  upper: boolean
  runs: Run[]
  list?: { type: NonNullable<Item['list']>; indentPx: number } // Aufzählung (freier Text): jeder Absatz ein Punkt, hängender Einzug
  lines: number
  bg: string // effective background colour behind the text (for contrast lint)
}
export interface BoxEl extends Base {
  kind: 'box'
  fill?: { color: string; alpha: number }
  border?: { color: string; width: number }
  radius: number
  shadow?: { color: string; alpha: number; blur: number; offsetY: number }
  ellipse: boolean
  gradient?: Gradient // linear-gradient (z. B. Verlauf über einem Foto), wird per XML-Patch nativ
  shape?: Exclude<ShapeId, 'rect' | 'ellipse'> // freie Form (Dreieck, Stern …) als native PowerPoint-Form
  lineStart?: LineEnd; lineEnd?: LineEnd; dash?: Dash
}
export interface Gradient { angle: number; stops: { color: string; alpha: number; pos: number }[] } // angle in CSS-Grad, pos 0..1
export interface ImgEl extends Base {
  kind: 'img'; src: string; radius: number; fit: 'cover' | 'contain'
  focus: { x: number; y: number } // background-position in 0..1 (Zuschnitt bzw. Ausrichtung)
  under?: boolean // Foto liegt unter Text (Vollbild): Überlappung erlaubt, Kontrast wird gegen das Overlay geprüft
  nat?: { w: number; h: number } // Pixelgröße der Bilddatei (vom Render-Host), für die Druckauflösung im Lint
  look?: 'duotone' | 'mono'
  mask?: MaskId
  adjust?: Adjust
  alpha?: number
  round?: boolean
  flip?: boolean // horizontal gespiegelt
  crop?: Crop // expliziter Ausschnitt (freie Bilder), sonst cover + focus
}
// png: data URL rasterized at 4x, because PptxGenJS can't create SVG fallbacks in Node
export interface IconEl extends Base { kind: 'icon'; svg: string; png?: string; name?: string; qr?: string; color?: string } // name/qr: Herkunft, damit „Layout lösen“ echte Icon-/QR-Elemente erzeugt
export interface ChartEl extends Base { kind: 'chart'; spec: ChartSpec }
// Video/Audio: in der PPTX als eingebettetes Medium, im PDF/PNG als Vorschaubild
export interface MediaEl extends Base { kind: 'media'; media: 'video' | 'audio'; src: string; poster?: string }
export type El = TextEl | BoxEl | ImgEl | IconEl | ChartEl | MediaEl

export interface ChartSpec {
  type: 'bar' | 'hbar' | 'stacked' | 'waterfall' | 'line' | 'donut'
  categories: string[]
  series: { name: string; values: number[] }[]
  unit?: string
  highlight?: string // Kategorie oder Serie mit der Aussage; Rest grau (src/shared/charts.ts)
  annotate?: 'cagr' | 'delta' // automatisch berechnete Beschriftung erster → letzter Wert
}

export interface Overflow { slot: string; overPx: number; kind: 'height' | 'width' | 'lines' }

export interface Measured {
  els: El[]
  fit: { ok: boolean; head: number; body: number; overflow: Overflow[] }
}

// Dateien, die ein Deck über asset:// bzw. file:// einbinden darf (Protokoll-Handler und PPTX-Export). Alles andere
// wird verweigert, damit eine fremde deck.json keine beliebigen Dateien (Schlüssel, Zugangsdaten) in eine PPTX zieht.
// flv = OBS-/Stream-Aufnahmen; .ts (MPEG-TS) bewusst nicht, das gäbe TypeScript-Quellen frei.
export const VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'flv']
export const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'ogg', 'oga', 'aac', 'opus', 'flac']
const extRe = (exts: string[]) => new RegExp(`\\.(${exts.join('|')})$`, 'i')
export const VIDEO_FILE = extRe(VIDEO_EXT)
export const AUDIO_FILE = extRe(AUDIO_EXT)
export const MEDIA_EXT = extRe(['png', 'jpe?g', 'gif', 'webp', 'svg', 'avif', 'bmp', ...VIDEO_EXT, ...AUDIO_EXT, 'ttf', 'otf', 'woff2?'])
