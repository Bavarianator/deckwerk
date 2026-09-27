export const BUILDS = ['none', 'fade', 'list', 'stagger', 'wipe', 'zoom-kpi'] as const
export const TRANSITIONS = ['none', 'fade', 'push', 'morph', 'dissolve', 'wipe', 'cover', 'split', 'circle', 'zoom'] as const
export type BuildPreset = (typeof BUILDS)[number]
export type Transition = (typeof TRANSITIONS)[number]
export const MOTIONS = ['calm', 'standard', 'lively'] as const
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

export interface ThemeRef { id: string; brand?: BrandKit; custom?: ThemeSpec; shuffle?: number; fonts?: [string, string]; customFont?: CustomFont }
// Eigene Schrift (TTF, vom Nutzer gewählt): im Renderer per FontFace, in der PPTX eingebettet. Pfade als asset://-URL.
export interface CustomFont { family: string; regular: string; bold?: string }

export interface BrandKit {
  primary: string // #RRGGBB
  secondary?: string
  logo?: string // asset://local/<abs path>
  headFont?: string // FontName aus src/shared/themes.ts
}

// Eigenes Theme, das die KI pro Deck entwirft. Aus wenigen Vorgaben leitet resolveTheme die volle Palette ab
// (Flächen, Rand, Sekundärtext, Diagrammfarben) und erzwingt Kontraste; hell/dunkel folgt aus dem Hintergrund.
export interface ThemeSpec {
  name: string
  bg: string // #RRGGBB
  text?: string
  accent: string
  accent2?: string
  headFont: string // FontName aus src/shared/themes.ts
  bodyFont: string
  radius: number
  decor: DecorId
  texture?: 'grain'
}

export interface Slide {
  id: string
  layout: string
  variant?: string
  content: any // validated by the layout's zod schema (src/shared/layouts.ts)
  build?: BuildPreset // default comes from the layout
  tone?: Tone // default comes from the layout (section: accent)
  decor?: DecorId // default comes from the theme
  frame?: FrameId // Komposition; default top
  notes?: string
  items?: Item[] // freie Elemente über dem Layout (Canvas: ziehen, skalieren, drehen); Reihenfolge = Ebenen
  bg?: { color?: string; image?: string; gradient?: [string, string]; angle?: number } // eigener Folienhintergrund statt Theme-Fläche; gradient = Verlauf (Winkel in Grad, Standard 135)
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
export const ITEM_ANIMS = ['none', 'fade', 'float', 'zoom', 'wipe'] as const
export type ItemAnim = (typeof ITEM_ANIMS)[number]
export interface Item {
  id: string
  kind: 'text' | 'shape' | 'image' | 'icon' | 'chart' | 'video' | 'audio' | 'qr' | 'graphic' // qr: text = Inhalt; graphic: Name aus GRAPHICS
  group?: string // gemeinsame ID = Gruppe: wird zusammen gewählt, verschoben und skaliert
  x: number; y: number; w: number; h: number // Text: h ergibt sich aus dem Inhalt
  rot?: number // Grad im Uhrzeigersinn
  opacity?: number // 0..1
  locked?: boolean
  anim?: ItemAnim // Auftritt beim Präsentieren (nacheinander per Klick)
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
  effect?: TextEffect; effectColor?: string // Texteffekt; Farbe für Neon/Kontur, sonst Textfarbe
  // shape (fill auch Texthintergrund)
  shape?: ShapeId
  lineStart?: LineEnd; lineEnd?: LineEnd // Linienenden (Form line)
  dash?: Dash // Strichart für Linie und Umriss
  fill?: string; fill2?: string // fill2 = Verlauf (nur Rechteck/Ellipse)
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
} as const
export type FormatId = keyof typeof FORMATS
export interface Size { w: number; h: number }
export const sizeOf = (deck: Pick<Deck, 'size'> | null | undefined): Size => deck?.size ?? { w: 1280, h: 720 }

export interface Deck {
  title: string
  size?: Size // Foliengröße in px; ohne = 1280×720 (16:9)
  brief?: { audience?: string; goal?: string; tone?: string }
  // custom hat Vorrang vor id; shuffle = Farbvariante (Canva „Stile mischen“), fonts = Schriftpaar [Titel, Text]
  theme: ThemeRef
  transition: Transition
  motion?: Motion // Bewegungsstil des Decks (Canva „Magic Animate“); einzelne Folien-builds haben Vorrang
  mode: 'click' | 'auto' // click = presenter advances builds, auto = builds run by themselves
  slides: Slide[]
}

// ---- what the renderer measures and hands to lint + PPTX export (all px, relative to the 1280x720 slide) ----

export const SLIDE_W = 1280
export const SLIDE_H = 720

export interface Box { x: number; y: number; w: number; h: number }

export interface Run { text: string; bold: boolean; italic: boolean; underline?: boolean; color: string; breakAfter?: boolean; link?: string }

interface Base { slot: string; box: Box; build?: number; rot?: number; anim?: ItemAnim }
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
export const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|mp4|webm|mov|m4v|ogv|mp3|wav|m4a|ogg|oga|aac|opus|flac|ttf|otf|woff2?)$/i
