// Die 12 KI-Tools, SDK-frei: DeckAgent (agent.ts) und MCP-Server hängen an derselben Definition.
// Fehler werfen ein Error mit konkreter Meldung; der Aufrufer macht daraus is_error / isError.
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { converter } from 'culori'
import { icons } from 'lucide-react'
import { BUILDS, CHART_STRATEGIES, DECORS, FORMATS, FRAMES, HEAD_WEIGHTS, HERO_TONES, IMAGE_STYLES, LABELS, LEADINGS, MARGINS, MEASURES, MOTIONS, PRINT_SIZES, SIGNATURES, sizeOf, TONES, TRANSITIONS, TUNE_KEYS, itemClicks, transitionOf, AUDIO_EXT, AUDIO_FILE, MEDIA_EXT, VIDEO_EXT, VIDEO_FILE, visibleSlides, type BrandKit, type Deck, type Measured, type FormatId, type FrameId, type Item, type Slide, type ThemeRef, type ThemeSpec, type ThemeTune, type PrintOptions } from '../shared/deck'
import { fontName, GRAPHICS, itemSchema, newId, resizeDeck } from '../shared/items'
import { LAYOUTS, LAYOUT_IDS, buildOf, type LayoutId } from '../shared/layouts'
import { CATALOG_THEMES, FONT_NAMES, FONTS, THEMES, resolveTheme, type FontName } from '../shared/themes'
import { FONT_CATALOG, type FontCat } from '../shared/font-catalog'
import { lintClip, type ClipIssue } from '../shared/clip-lint'
import type { Issue } from '../shared/lint'
import { axesOf, lintLooks, lintTheme, type ThemeIssue } from '../shared/theme-lint'
import { overview, searchTranscript } from '../shared/transcript-search'
import { typeset } from '../shared/typo'
import { fillDeck, placeholders } from '../shared/merge'
import { retakes } from '../shared/retakes'
import { LONG_VIDEO, mmss, partsLength, transcriptLines, type ClipContent } from '../shared/video'
import type { Engine, ExportFormat, VideoTools } from './agent'
import { findCli } from './claude-agent' // dieselbe Suche wie für den Chat (der Mac-Fork patcht sie)
import { contactSheet } from './ffmpeg'
import { fetchMusic, findMusic } from './music'
import { localAsset } from './sync'
import { fontNeeds, withDeckFonts, withFonts } from './webfonts'

export interface ToolContext {
  engine: Engine
  getDeck(): Deck | null
  setDeck(deck: Deck): void // einziger Schreibpfad (UI-Update, Persistenz)
  assetDir: string // eigene Bilder für find_images; Unsplash-Downloads landen auch hier
  outDir: string // Exportziel
  unsplashKey?: string // Unsplash Access Key; ohne Key sucht find_images nur lokal
  previews?: false // Bildsuche der UI (image:find) braucht nur die Pfade, keine Vorschaubilder
  ask?(q: { question: string; options: string[] }): void // nur im App-Chat: Rückfrage mit Antwort-Buttons
  storyline?(slides: { title: string; layout: string }[]): void // nur im App-Chat: geplante Folien für die Entstehen-Ansicht
  choice?(c: { question: string; options: { label: string; image: string }[] }): void // nur im App-Chat: Auswahl-Karten (image = PNG als data:-URL)
}
// Hausstil (Canva „Memory Library“): Vorlieben des Nutzers für alle Decks, von Hand oder per remember gepflegt
export const STYLE_FILE = join(homedir(), 'Deckwerk', 'hausstil.md')
export const houseStyle = () => { try { return readFileSync(STYLE_FILE, 'utf8').trim() } catch { return '' } }
// Brand-Kit des Nutzers für jedes neue Deck (Farben, Schriften, Logo); DECKWERK_HOME: Tests
export const BRAND_FILE = join(process.env.DECKWERK_HOME ?? join(homedir(), 'Deckwerk'), 'brand.json')
export const defaultBrand = (): BrandKit | undefined => { try { return brand.parse(JSON.parse(readFileSync(BRAND_FILE, 'utf8'))) } catch { return undefined } }
export const saveBrand = (b: BrandKit) => { mkdirSync(dirname(BRAND_FILE), { recursive: true }); writeFileSync(BRAND_FILE, JSON.stringify(b, null, 2)) }

export interface ToolOutput { text: string; images?: Buffer[] } // PNG oder JPEG, siehe mimeOf
export const mimeOf = (b: Buffer): 'image/png' | 'image/jpeg' => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : 'image/png')
export const assetUrl = (abs: string) => `asset://local${pathToFileURL(abs).pathname}` // Format wie ipc.ts
// Relative Bildpfade im Deck (z. B. "assets/foto.jpg" in examples/) gegen den Ordner der JSON-Datei auflösen
export function localizeDeck(deck: Deck, dir: string): Deck {
  const walk = (o: any): void => {
    for (const k of Object.keys(o ?? {})) {
      const v = o[k]
      if ((k === 'src' || k === 'image' || k === 'poster' || k === 'video') && typeof v === 'string' && v && !/^(asset|data|file|https?):/.test(v)) o[k] = assetUrl(resolve(dir, v))
      else if (v && typeof v === 'object') walk(v)
    }
  }
  deck.slides.forEach((s) => { walk(s.content); walk(s.items); walk(s.bg) })
  return deck
}
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  inputSchema: S
  run(input: z.infer<S>): Promise<ToolOutput>
  readOnly?: true // ändert das Deck nicht: Claude Code führt solche Aufrufe parallel aus, alle anderen strikt nacheinander
}

const format = z.enum(Object.keys(FORMATS) as [FormatId, ...FormatId[]]).describe(Object.entries(FORMATS).map(([k, f]) => `${k} = ${f.name} (${f.w}×${f.h})`).join(', '))
const THEME_IDS = THEMES.map((t) => t.id) as [string, ...string[]]
const layoutId = z.enum(LAYOUT_IDS as [LayoutId, ...LayoutId[]])
const build = z.enum(BUILDS).describe('Animations-Preset; weglassen = Default des Layouts')
const slideTransition = z.enum(TRANSITIONS).describe('Übergang zu dieser Folie; weglassen = Deck-Übergang. Praktisch nur für morph: wörtlich gleicher Text, dasselbe Foto oder derselbe Platz im Layout wandert von der vorigen Folie herüber (Design-Guide §8). In Video-Decks: fade = Abblende über Schwarz im MP4, gezielt an Zwischentiteln (Guide §11)')
const brand = z.object({
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Markenfarbe #RRGGBB'),
  secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logo: z.string().optional().describe('Pfad zum Logo (aus find_images)'),
  logoDark: z.string().optional().describe('Logo für dunklen Grund; fehlt es, gilt logo'),
  headFont: fontName.optional().describe('Headline-Schrift; Office: Arial, Calibri, Georgia; alle übrigen werden eingebettet, siehe customTheme.headFont'),
  bodyFont: fontName.optional().describe('Schrift für Fließtext'),
})
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const deckStyle = z.enum(['sachlich', 'mutig']).describe('Gestaltungsstil, beim Anlegen immer setzen (Design-Guide §6 „Stil des Decks“). Nach Anlass: mutig für Vortrag, Schule/Unterricht, Verein, Event, Kampagne, Kultur, Marketing, Produktvorstellung, Social; sachlich für Chef-Update, Entscheidungsvorlage, Antrag, Bericht, Finanzen, Projektstatus, A4-Dokument, Angebot. Steht im Kontext „Deck-Stil: …“ oder wünscht der Nutzer einen Stil, gilt der. mutig = kräftige Farbgründe, Plakat-Typo, mehr Farbflächen, markante Bilder.')
// Zeichen jeder Schrift, damit die KI Paare nach Stimmung wählt
const FONT_MOOD: Record<FontName, string> = {
  Fraunces: 'warme Display-Serif mit Charakter: editorial, Magazin, Handwerk, Kultur',
  'DM Serif Display': 'elegante, kontrastreiche Serif (nur ein Schnitt): Luxus, Premium, ruhig',
  'Space Grotesk': 'technische Grotesk, inzwischen Standard generierter Tech-Decks: nur auf Wunsch',
  Manrope: 'freundliche geometrische Sans: modern, zugänglich, gut für Fließtext',
  Inter: 'neutrale Profi-Sans, sehr gut lesbar: Business, Produkt, Fließtext',
  'DM Sans': 'klare geometrische Sans, Partner zu DM Serif Display',
  Arial: 'Office-Standard, maximal kompatibel, wirkt generisch',
  Calibri: 'Office-Standard für Text, wirkt generisch',
  Georgia: 'Office-Serif, solide, wirkt klassisch-konservativ',
  'Playfair Display': 'klassische Kontrast-Serif: Hochzeit, Mode, Kultur, gehobene Anlässe',
  'Source Sans 3': 'sachliche Humanist-Sans, sehr gut lesbar: Verwaltung, Wissenschaft, Fließtext',
  'Plus Jakarta Sans': 'moderne, freundliche Grotesk: SaaS, Agentur, Startup',
  Lora: 'ruhige Buch-Serif: Bildung, Stiftung, Gesundheit, Erzählung',
  'Instrument Serif': 'schmale Display-Serif (nur ein Schnitt), inzwischen Standard generierter Designs: nur auf Wunsch',
  Archivo: 'kräftige, sachliche Grotesk im Schweizer Stil: Industrie, Logistik, Architektur, klare Ansagen',
  'IBM Plex Sans': 'sachliche Profi-Grotesk mit Charakter: Beratung, Finanzen, Technik, Zahlen',
  'IBM Plex Serif': 'nüchterne Serif, Partner zu IBM Plex Sans: Vortrag, Forschung, Reflexion',
  'Source Serif 4': 'redaktionelle Buch-Serif: Bericht, Stiftung, Verwaltung, Wissenschaft',
  'Archivo Black': 'Plakat-Grotesk in Black (nur ein Schnitt), nur als Titelschrift im Stil mutig: Kampagne, Event, laute Ansagen',
  'IBM Plex Mono': 'Monospace, nicht als Titel- oder Textschrift: nur über labelFont mono für Eyebrow und Fußzeile',
}
const oklch = converter('oklch')
// Designtyp (Guide §6 „Abwechslung“): die fünf Merkmale, an denen man Decks auf einen Blick unterscheidet; font/akzent nur zur Anzeige
export interface LookTyp { hell: 'hell' | 'dunkel'; schrift: 'Serif' | 'Sans'; gewicht: 'regular' | 'bold'; grund: 'kräftig' | 'getönt' | 'neutral'; bauteile: 'line' | 'plain' | 'solid'; font: string; akzent: string }
export function lookTyp(ref: ThemeRef): LookTyp {
  const t = resolveTheme(ref), bg = oklch(t.c.bg), l = bg?.l ?? 1, c = bg?.c ?? 0
  const tinted = t.dark ? c > 0.02 : l < 0.955 && c > 0.006
  return { hell: t.dark ? 'dunkel' : 'hell', schrift: t.head.serif ? 'Serif' : 'Sans', gewicht: t.head.weight < 600 && !(t.head.single && !t.head.serif) ? 'regular' : 'bold', grund: t.vivid ? 'kräftig' : tinted ? 'getönt' : 'neutral', bauteile: t.elements ?? 'line', font: t.head.css, akzent: t.c.accent }
}
export const sameLook = (a: LookTyp, b: LookTyp) => a.hell === b.hell && a.schrift === b.schrift && a.gewicht === b.gewicht && a.grund === b.grund && a.bauteile === b.bauteile
const typText = (t: LookTyp) => `${t.hell}, ${t.schrift}-Titel ${t.gewicht}, Grund ${t.grund}, Bauteile ${{ line: 'Linie', plain: 'frei', solid: 'Fläche' }[t.bauteile]}`
// Zuletzt gebaute Decks, neueste zuerst; Decks mit Brand-Kit zählen nicht (dort ist der Look vorgegeben)
export function recentLooks(except?: string): { title: string; typ: LookTyp }[] {
  const home = process.env.DECKWERK_HOME ?? join(homedir(), 'Deckwerk')
  let dirs: string[]
  try { dirs = readdirSync(home).filter((d) => !d.startsWith('.') && !['versions', 'out', 'assets', 'models'].includes(d)) } catch { return [] }
  const files = dirs.flatMap((d) => { const f = join(home, d, 'deck.json'); try { return [{ f, t: statSync(f).mtimeMs }] } catch { return [] } }).sort((a, b) => b.t - a.t)
  const out: { title: string; typ: LookTyp }[] = []
  for (const { f } of files.slice(0, 12)) { // begrenzt: mit Brand-Kit zählt kein Deck, sonst würde jede deck.json gelesen
    if (out.length >= 4) break
    try {
      const d = JSON.parse(readFileSync(f, 'utf8')) as Deck
      if (!d.theme.brand && d.title !== except) out.push({ title: String(d.title).replace(/\s+/g, ' ').slice(0, 80), typ: lookTyp(d.theme) })
    } catch {}
  }
  return out
}
// Hinweis, wenn ein Design im Typ einem der 3 neuesten Decks gleicht; '' sonst
function repeats(typ: LookTyp, recent: { title: string; typ: LookTyp }[]): string {
  const alike = recent.slice(0, 3).filter((r) => sameLook(r.typ, typ)).map((r) => `„${r.title}“`)
  return alike.length ? `gleicht im Typ deinen letzten Decks ${alike.join(', ')} (${typText(typ)}). Ändere mindestens eins: Grund (getönt, dunkel, im Stil mutig kräftig), Schrift (Sans statt Serif oder umgekehrt), Titelgewicht oder Bauteile (line/plain) – außer der Nutzer will eine Serie (Design-Guide §6 „Abwechslung“).` : ''
}
const themeSpec = z.object({
  name: z.string().min(2).max(40).describe('Name, z. B. "Nordlicht Finance"'),
  bg: hexColor.describe('Grund: fast neutrales Weiß, höchstens ein Hauch Tönung (#FAFAF8, #F5F3EE, #EFF2EE) oder tiefer Dunkelton (Nachtblau #121D33, Tannengrün #13251C, Aubergine, Graphit). Mitteltöne, Creme und Pastell lehnt der Theme-Lint ab. Kräftige Farbgründe nur mit vivid (Stil mutig).'),
  text: hexColor.optional().describe('Textfarbe; weglassen = automatisch passend'),
  accent: hexColor.describe('Hauptakzent mit Charakter (Zahlen, Hervorhebungen, Akzentflächen); wird bei Bedarf für Kontrast nachgedunkelt/aufgehellt'),
  accent2: hexColor.optional().describe('Zweitfarbe für Vergleichsserien und Duotone; weglassen = neutrales Grau (empfohlen: eine Akzentfarbe reicht)'),
  headFont: fontName.describe('Titelschrift: gebündelte Schrift oder Familie aus dem Schriftkatalog'),
  bodyFont: fontName.describe('Textschrift (Sans empfohlen)'),
  radius: z.number().int().min(0).max(28).describe('Eckenradius in px: 0–4 empfohlen; über 8 wirkt es schnell generiert'),
  decor: z.enum(DECORS).describe('Hintergrundmotiv; none empfohlen. blobs/glow (unscharfe Farbkreise) nur auf ausdrücklichen Wunsch'),
  texture: z.enum(['grain']).optional().describe('feine Papierkörnung, nur auf Wunsch'),
  titleSize: z.enum(['normal', 'large', 'huge']).optional().describe('large = Plakat-Titel (Vortrag, Swiss, Editorial); huge = übergroße Titel, nur im Stil mutig; normal = sachlich (Chef-Update, viele Daten)'),
  titleWeight: z.enum(['regular', 'bold']).optional().describe('regular wirkt edel und redaktionell (am besten mit Serif und titleSize large), bold sachlich und kräftig'),
  rule: z.enum(['none', 'over', 'under']).optional().describe('feine Linie: over = Kopflinie über dem Titel (Swiss, Redaktion), under = Trennlinie unter dem Kopf (Beratung), none = pur'),
  sectionTone: z.enum(TONES).optional().describe('Kapiteltrenner: accent = Akzentfläche (Standard), invert = Hell/Dunkel getauscht, normal = nur große Typo auf dem Grund'),
  vivid: z.boolean().optional().describe('nur im Stil mutig: bg als kräftiger Farbgrund übernehmen (z. B. Signalgelb, Tiefblau, Ziegelrot) statt ihn auf Papier- bzw. Dunkeltöne zu dämpfen; Textfarbe kommt automatisch mit Kontrast'),
  labelFont: z.enum(['body', 'mono']).optional().describe('mono = Eyebrow und Fußzeile in IBM Plex Mono (Magazin, Tech); body = Textschrift (Standard)'),
  elements: z.enum(['line', 'plain', 'solid']).optional().describe('Bauteile (Design-Guide §6): line = offen, Kopflinien statt Kästen, kurze Striche als Marker (Standard, redaktionell, Beratung); plain = nur Typografie und Weißraum, keine Linien, große leichte Nummern (Keynote, Zen, Tech); solid = Akzentflächen für Hervorhebungen, nur im Stil mutig'),
  // Struktur-Tokens (Guide §6 „Feinschliff“), auch als tune über jedem Theme
  field: hexColor.optional().describe('Farbe großer Flächen (Kapitel, split/band, heroTone field); weglassen = accent. Nur als eigene Stimme, z. B. Signalgelb zu schwarzem Akzent'),
  headWeight: z.literal(HEAD_WEIGHTS).optional().describe('Titelgewicht, schlägt titleWeight; gebündelte Schriften nur 400/700'),
  headTracking: z.number().min(-0.05).max(0.02).optional().describe('Laufweite der Titel in em: −0.02 bis −0.04 für große Grotesk-Titel, sonst weglassen'),
  leading: z.enum(LEADINGS).optional().describe('Zeilenabstand: tight = dicht (große Titel), open = luftig (Lesetext, Zen)'),
  labels: z.enum(LABELS).optional().describe('caps = Eyebrow und Fußzeile in Versalien'),
  margin: z.enum(MARGINS).optional().describe('Ränder: generous = mehr Luft, asymmetric = breiter Bundsteg links (editorial)'),
  measure: z.enum(MEASURES).optional().describe('Satzbreite: narrow ≈ 760 px (ruhig, nicht mit titleSize huge), wide = volle Breite'),
  signature: z.object({
    kind: z.enum(SIGNATURES),
    color: z.enum(['accent', 'field', 'text']).optional(),
    size: z.number().int().min(1).max(24).optional().describe('px: Linienstärke bzw. Kantenbreite'),
    length: z.enum(['short', 'full']).optional().describe('rule: 64 px oder volle Satzbreite'),
    side: z.enum(['left', 'top']).optional().describe('edge'),
  }).optional().describe('Genau ein wiederkehrendes Element statt Deko: rule = Haarlinie über dem Titel, edge = Farbkante am Folienrand, passepartout = Rahmenlinie mit Abstand'),
  heroTone: z.enum(HERO_TONES).optional().describe('Titel- und Schlussfolie: field = Farbfläche, invert = Hell/Dunkel getauscht, normal = Grund'),
  chart: z.enum(CHART_STRATEGIES).optional().describe('Diagrammfarben: focus = Akzent + Grau (Standard), tonal = Akzent in Helligkeitsstufen, duo = zwei Akzente (mit accent2)'),
  images: z.enum(IMAGE_STYLES).optional().describe('ein Bildstil fürs ganze Deck: natural, mono (hält uneinheitliche Fotos zusammen), duotone (Stil mutig)'),
})
// Feinschliff über jedem Theme (Katalog oder eigen): dieselben Tokens, null entfernt einen gesetzten Wert.
// unwrap() lässt die Beschreibungen weg: sie stehen schon in customTheme, doppelt kosteten sie Tokens in jeder Anfrage.
const tuneSpec = z.object(Object.fromEntries(TUNE_KEYS.map((k) => [k, themeSpec.shape[k].unwrap().nullable().optional()])) as { [K in (typeof TUNE_KEYS)[number]]: z.ZodOptional<z.ZodNullable<ReturnType<(typeof themeSpec.shape)[K]['unwrap']>>> })
  .describe('Struktur-Tokens über dem Theme, auch über Katalog-Themes (Felder und Wirkung wie in customTheme). Wird mit dem Bestand gemischt; null entfernt einen Wert')
const mergeTune = (old: ThemeTune | undefined, patch: z.infer<typeof tuneSpec> | undefined): ThemeTune | undefined => {
  const t: Record<string, unknown> = { ...old, ...patch }
  for (const k of Object.keys(t)) if (t[k] == null) delete t[k]
  return Object.keys(t).length ? (t as ThemeTune) : undefined
}
const override = z.string().min(3).max(200).optional().describe('Nur auf ausdrücklichen Wunsch des Nutzers: Begründung (z. B. Markenvorgabe), warum ein vom Theme-Lint abgelehntes Design so bleiben soll; Fehler werden dann zu Hinweisen')
// Rauschen: „sehr verbreitet“ bei gebündelten Schriften (die erprobte Grundauswahl); bei Katalogschriften bleibt der Hinweis
const fontNoise = (x: ThemeIssue) => x.rule === 'font-common' && (FONT_NAMES as string[]).includes(x.message.split(' ist ')[0])
// Theme-Lint (theme-lint.ts) für ein eigenes Design, wie es gerendert wird: ein Brand-Kit ersetzt Akzent und ggf. Schriften (withBrand), das ist Vorgabe
function lintFor(s: ThemeSpec, kit: BrandKit | undefined, override?: string): ThemeIssue[] {
  const spec = kit ? { ...s, accent: kit.primary, headFont: kit.headFont ?? s.headFont, bodyFont: kit.bodyFont ?? s.bodyFont } : s
  return lintTheme(spec, { override: !!override, brand: kit && { accent: true, headFont: !!kit.headFont, bodyFont: !!kit.bodyFont } }).filter((x) => !fontNoise(x))
}
// Fehler lehnen ab (mit override nur Hinweis), außer sie bestanden schon vor dem Aufruf (before); Rest als kurzer Block
function checkTheme(issues: ThemeIssue[], where: string, before: ThemeIssue[] = []): string {
  const key = (x: ThemeIssue) => `${x.rule}|${x.message}`
  const old = new Set(before.filter((x) => x.level === 'error').map(key))
  const line = (x: ThemeIssue) => `  - [${x.level}${old.has(key(x)) ? ', schon vorher' : ''}] ${x.rule}: ${x.message}`
  const errors = issues.filter((x) => x.level === 'error' && !old.has(key(x)))
  if (errors.length) throw new Error(`${where}: Theme-Lint lehnt ab:\n${errors.map(line).join('\n')}\nKorrigieren und erneut aufrufen. Will der Nutzer es ausdrücklich so (z. B. Markenvorgabe), override mit Begründung setzen.`)
  return issues.length ? `Theme-Hinweise (${where}):\n${issues.map(line).join('\n')}\n` : ''
}
// tune schlägt das Theme, auch ein neues customTheme: sonst scheint ein neuer Wert nicht zu greifen
function shadowed(custom: object | null | undefined, tune: ThemeTune | undefined): string {
  const keys = Object.keys(custom ?? {}).filter((k) => tune && k in tune)
  return keys.length ? `Hinweis: tune überschreibt ${keys.map((k) => `customTheme.${k}`).join(', ')}; mit tune { ${keys.map((k) => `${k}: null`).join(', ')} } entfernen.\n` : ''
}

const FRAME_HINT = 'Komposition: top = Titel oben (Standard), split = Titel auf Akzentfläche links, band = Titel im Farbband oben, center = Kopf zentriert. Nur die im Katalog genannten Frames des Layouts.'
// Frame muss zum Layout passen, sonst würde er stillschweigend als top gerendert
function checkFrame(layout: string, frame: FrameId | undefined, where: string) {
  const ok = LAYOUTS[layout as LayoutId]?.frames
  if (frame && frame !== 'top' && !ok?.includes(frame)) throw new Error(`${where}: Layout ${layout} kann frame "${frame}" nicht. Erlaubt: top${ok?.length ? ', ' + ok.join(', ') : ''}`)
}

const slideBg = z.object({ color: hexColor.optional(), image: z.string().optional().describe('asset://-Pfad'), gradient: z.tuple([hexColor, hexColor]).optional().describe('Verlauf von → nach'), angle: z.number().min(0).max(360).optional() }).describe('Eigener Folienhintergrund statt Theme')
const withIds = (items: Item[] | undefined) => items?.map((it) => ({ ...it, id: it.id || newId() }))
const slideInput = z.object({
  layout: layoutId,
  variant: z.string().optional(),
  content: z.record(z.string(), z.unknown()).describe('Inhalt nach dem Schema des Layouts (siehe Katalog)'),
  build: build.optional(),
  transition: slideTransition.optional(),
  tone: z.enum(TONES).optional().describe('Folien-Ton; weglassen = Standard des Layouts'),
  decor: z.enum(DECORS).optional().describe('Dekor-Motiv; weglassen = Standard des Themes'),
  frame: z.enum(FRAMES).optional().describe(FRAME_HINT),
  notes: z.string().max(1500).optional().describe('Speaker Notes'),
  items: z.array(itemSchema).max(60).optional().describe('Freie Elemente über dem Layout (px auf 1280×720). Nur für Layout blank oder wenn der Nutzer frei gestalten will.'),
  bg: slideBg.optional(),
})

// ponytail: PascalCase → kebab-case reicht für lucide-Namen (AArrowDown → a-arrow-down, Grid2x2 → grid-2x2)
export const ICON_NAMES = Object.keys(icons).map((n) =>
  n.replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([a-zA-Z])(\d)/g, '$1-$2').toLowerCase(),
)

export function newSlideId(deck: Deck): string {
  const used = new Set(deck.slides.map((s) => s.id))
  for (;;) {
    const id = 's' + randomBytes(2).toString('hex')
    if (!used.has(id)) return id
  }
}

// Feinsatz rekursiv über alle Strings; Quellen, Links und Symbolnamen bleiben unberührt
const NO_TYPESET = new Set(['src', 'image', 'url', 'href', 'link', 'poster', 'icon', 'qr', 'focus', 'video'])
const typesetDeep = (v: unknown, key?: string): unknown =>
  typeof v === 'string' ? (key && NO_TYPESET.has(key) ? v : typeset(v))
    : Array.isArray(v) ? v.map((x) => typesetDeep(x, key))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typesetDeep(x, k)]))
    : v

// Validiert content gegen das Layout-Schema. Wirft mit konkretem Hinweis.
// Unbekannte Felder (z. B. „kicker“ statt „eyebrow“) würde zod still verwerfen; der Inhalt fehlte dann ohne Meldung.
export function validateContent(layout: string, content: unknown, where: string): Record<string, unknown> {
  const def = LAYOUTS[layout as LayoutId]
  if (!def) throw new Error(`${where}: Unbekanntes Layout "${layout}". Erlaubt: ${LAYOUT_IDS.join(', ')}`)
  const r = def.schema.safeParse(content)
  const json = z.toJSONSchema(def.schema) as JsonSchema
  const stray = [...new Set(strayKeys(json, content, ''))]
  if (r.success && !stray.length) {
    const c = typesetDeep(r.data) as Record<string, unknown>
    if (layout === 'clip' && typeof c.video === 'string' && isAbsolute(c.video)) c.video = assetUrl(c.video) // der Renderer lädt Videos nur über asset://
    return c
  }
  const { $schema: _, ...schema } = json as Record<string, unknown>
  throw new Error([
    `${where} (${layout}): Inhalt ungültig.`,
    ...(stray.length ? [`Unbekannte Felder: ${stray.join('; ')}`] : []),
    ...(r.success ? [] : [z.prettifyError(r.error), 'Zu lang: kürzen oder Folie teilen.']),
    `Schema von ${layout}: ${JSON.stringify(schema)}`,
  ].join('\n'))
}

interface JsonSchema { properties?: Record<string, JsonSchema>; items?: JsonSchema; anyOf?: JsonSchema[] }
// Felder, die das Schema nicht kennt, als „pfad.feld (erlaubt: …)“; Array-Indizes zu [] zusammengefasst
function strayKeys(s: JsonSchema, v: unknown, path: string): string[] {
  if (s.anyOf) {
    const fit = (o: JsonSchema) => (o.properties && v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).filter((k) => k in o.properties!).length : o.items && Array.isArray(v) ? 0 : -1)
    const best = s.anyOf.reduce((a, o) => (fit(o) > fit(a) ? o : a))
    return fit(best) < 0 ? [] : strayKeys(best, v, path)
  }
  if (s.properties && v && typeof v === 'object' && !Array.isArray(v))
    return Object.entries(v).flatMap(([k, x]) => (k in s.properties! ? strayKeys(s.properties![k], x, `${path}${k}.`) : [`${path}${k} (erlaubt: ${Object.keys(s.properties!).join(', ')})`]))
  if (s.items && Array.isArray(v)) return v.flatMap((x) => strayKeys(s.items!, x, `${path}[].`))
  return []
}

// Markiert ausgeblendete Folien in jeder Auflistung für die KI
const hid = (s: Slide | undefined) => (s?.hidden ? ' (ausgeblendet)' : '')

// Lint-Meldung samt Clip-Prüfung; info = Hinweis, zählt nicht als Warnung
type Note = Omit<Issue, 'severity'> & { severity: ClipIssue['severity'] }
const sev = (x: Note) => (x.severity === 'info' ? 'hinweis' : x.severity)
function fmtIssues(issues: Note[]): string {
  return issues.map((i) => `  - [${sev(i)}] ${i.rule}${i.slot ? ` @${i.slot}` : ''}: ${i.message}`).join('\n')
}
const sec = (n: number) => String(+n.toFixed(1)).replace('.', ',')

// Quelle einer clip-Folie wie mediaFile in engine.ts (Pfade fremder Geräte über localAsset); null = kein Videopfad
function clipFile(src: unknown): string | null {
  try {
    const p = typeof src === 'string' && src.startsWith('asset:') ? decodeURIComponent(new URL(src).pathname) : src
    return typeof p === 'string' && isAbsolute(p) && VIDEO_FILE.test(p) ? localAsset(p) : null
  } catch { return null } // kaputte URL
}
// Clip-Prüfung (lintClip) der clip-Folien an `indices`; liest nur den Cache der Engine (Transkript, Dauer, Signale), rechnet nie.
// music: frisch getaggt (check_clip) statt Cache; im Ergebnis music = ob Musik geprüft wurde
async function clipChecks(ctx: ToolContext, deck: Deck, indices: number[], music?: number[]): Promise<Map<number, { issues: Note[]; summary: string; music: boolean }>> {
  const clips = deck.slides.flatMap((s, i) => (s.layout === 'clip' ? [i] : []))
  const others = clips.map((i) => { const c = deck.slides[i].content as ClipContent; return { video: c.video, parts: c.parts } })
  const cache = new Map<string, Promise<Awaited<ReturnType<NonNullable<VideoTools['cached']>>> | undefined>>() // je Quelle einmal
  const out = new Map<number, { issues: Note[]; summary: string; music: boolean }>()
  for (const i of indices) {
    const k = clips.indexOf(i)
    if (k < 0) continue
    const s = deck.slides[i], c = s.content as ClipContent, file = clipFile(c.video)
    if (file && !cache.has(file)) cache.set(file, Promise.resolve(ctx.engine.video?.cached?.(file)).catch(() => undefined))
    const d = file ? await cache.get(file) : undefined
    // Signal „Musik im Hintergrund“ aus der Highlight-Suche, falls schon gerechnet
    const info = { duration: d?.duration, transcript: d?.transcript, music: music ?? (d?.signals as { music?: number[] } | null | undefined)?.music }
    const issues = lintClip(c, sizeOf(deck), info, others, k).map((x) => ({ ...x, slide: i, slideId: s.id }))
    const n = c.parts.length, transcript = d?.transcript && !issues.some((x) => x.rule === 'clip-transkript') ? 'ok' : 'fehlt'
    out.set(i, { issues, music: !!info.music?.length, summary: `Länge ${sec(partsLength(c.parts))} s${c.pauses === 'kurz' ? ' (Quelle)' : ''} · ${n} ${n === 1 ? 'Ausschnitt' : 'Ausschnitte'} · Transkript ${transcript}` })
  }
  return out
}

// Autofit + Lint für die Folien an `indices` – die Rückmeldung, mit der die KI korrigiert.
async function report(ctx: ToolContext, deck: Deck, indices: number[]): Promise<string> {
  let measured: Awaited<ReturnType<Engine['measure']>>, issues: Issue[], clips: Awaited<ReturnType<typeof clipChecks>>
  try {
    ;[measured, issues, clips] = await Promise.all([ctx.engine.measure(deck, indices), ctx.engine.lint(deck), clipChecks(ctx, deck, indices)])
  } catch (e) {
    // Das Deck ist schon gespeichert: nicht als Tool-Fehler melden, sonst wiederholt die KI die Änderung
    return `Gespeichert (Folien ${indices.map((i) => i + 1).join(', ')}), aber die Messung ist fehlgeschlagen: ${(e as Error).message}. Später lint_deck aufrufen.`
  }
  return indices
    .map((i, k) => {
      const s = deck.slides[i]
      const m = measured[k]
      const clip = clips.get(i)
      const own: Note[] = [...issues.filter((x) => x.slide === i), ...(clip?.issues ?? [])]
      const errors = own.filter((x) => x.severity === 'error').length
      const over = m && !m.fit.ok ? ', Überlauf: ' + m.fit.overflow.map((o) => `${o.slot} +${Math.round(o.overPx)}px (${o.kind})`).join(', ') : ''
      const fit = clip ? clip.summary + over : m ? `Autofit head ${m.fit.head}/body ${m.fit.body}${over}` : 'nicht gemessen'
      const head = `Folie ${i + 1} (${s.id}, ${s.layout})${hid(s)}: ${errors ? `${errors} FEHLER` : 'OK'} · ${fit}${m ? ` · ${motionOf(deck, i, m)}` : ''}`
      return own.length ? `${head}\n${fmtIssues(own)}` : head
    })
    .join('\n')
}

// Ablauf beim Präsentieren in Worten, damit die KI Animationen beurteilen kann, ohne sie zu sehen
function motionOf(deck: Deck, i: number, m: Measured): string {
  const preset = buildOf(deck, i)
  const groups = new Set(m.els.flatMap((e) => (e.build === undefined ? [] : [e.build]))).size
  const clicks = deck.mode === 'click' ? (preset === 'list' ? groups : 0) + itemClicks(deck.slides[i]) : 0
  const build = preset === 'none' || !groups ? 'ohne Aufbau' : `Aufbau ${preset} (${groups} ${groups > 1 ? 'Gruppen' : 'Gruppe'})`
  return `Übergang ${transitionOf(deck, i)}, ${build}${clicks ? `, ${clicks} Klick${clicks > 1 ? 's' : ''}` : ''}`
}

// Theme sofort sichtbar machen, bevor Folien gebaut werden: Musterfolien mit Theme, Brand und Ton-Wechsel als ein Kontaktbogen.
const PREVIEW: LayoutId[] = ['cover', 'kpi-grid', 'chart', 'section']
const PREVIEW_HINT = 'Bild: das Theme an Musterfolien (Cover, Kennzahlen, Diagramm, Kapiteltrenner mit Akzentfläche; Texte sind Platzhalter). Kritisch prüfen: eigenständig statt generisch, passend zur Stimmung, Akzent und Schriften mit Charakter? Wenn nicht, jetzt mit update_deck.customTheme nachschärfen, dann add_slides.'
const ART_DIRECTOR = 'Prüfe als Art Director: Erzählen die Titel allein die Geschichte? Gibt es mindestens drei verschiedene Kompositionen und einen Hell/Dunkel-Rhythmus (tone)? Wirkt eine Folie leer oder überladen? Folgen dieselben Layouts zu oft aufeinander? Gibt es einen klaren Höhepunkt? Wirken Fotos einheitlich? Schwächste 1–3 Folien gezielt verbessern.'
async function themePreview(ctx: ToolContext, deck: Deck): Promise<Buffer[]> {
  const slides = PREVIEW.map((l) => ({ id: `preview-${l}`, layout: l, content: LAYOUTS[l].samples.typ }))
  try {
    return [await ctx.engine.renderOverview({ ...deck, slides })]
  } catch (e) {
    console.warn('[tools] Theme-Vorschau übersprungen:', (e as Error).message)
    return []
  }
}

const needDeck = (ctx: ToolContext): Deck => {
  const d = ctx.getDeck()
  if (!d) throw new Error('Noch kein Deck. Erst create_deck aufrufen.')
  return structuredClone(d)
}
const indexOf = (deck: Deck, id: string): number => {
  const i = deck.slides.findIndex((s) => s.id === id)
  if (i < 0) throw new Error(`Folie "${id}" gibt es nicht. Vorhanden: ${deck.slides.map((s) => s.id).join(', ') || '(keine)'}`)
  return i
}

function tool<S extends z.ZodType>(t: ToolDef<S>): ToolDef<S> { return t }

// Lange Arbeiten (Transkript, Video-Export) laufen im Hintergrund weiter; ein Aufruf wartet höchstens JOB_WAIT.ms. Grund: Vibe und
// Codex brechen Tool-Aufrufe nach 300 s ab, der API-Agent hält bei Deck-Tools die Sperre. Der nächste Aufruf mit gleichem Schlüssel
// hängt sich an den laufenden Job oder holt sein Ergebnis ab; danach ist der Job vergessen.
export const JOB_WAIT = { ms: 240_000 } // Tests setzen ihn kürzer
// ponytail: nie abgeholte Ergebnisse bleiben bis Prozessende in der Map (klein: Pfadlisten, Transkripte); Ablaufzeit, falls das stört
const jobs = new Map<string, { promise: Promise<unknown>; pct: number; done: boolean }>()
/** Laufende und fertige, nicht abgeholte Jobs für die Fortschrittsanzeige der UI; name = Teil des Schlüssels vor „:“ */
export const jobList = () => [...jobs].map(([key, j]) => ({ key, name: key.split(':')[0], pct: Math.round(j.pct), done: j.done }))
async function job<T>(key: string, start: (onProgress: (pct: number) => void) => Promise<T>): Promise<{ value: T } | { pct: number }> {
  let j = jobs.get(key)
  if (!j) {
    const nj = { promise: Promise.resolve() as Promise<unknown>, pct: 0, done: false }
    nj.promise = start((pct) => { nj.pct = pct })
    nj.promise.catch(() => {}).finally(() => { // den Fehler holt der nächste Aufruf ab; unbeobachtet würde Node den Prozess beenden
      nj.done = true
      setTimeout(() => { if (jobs.get(key) === nj) jobs.delete(key) }, 600_000).unref?.() // nicht abgeholt: nach 10 min vergessen (früher holt die KI ein fertiges Ergebnis sonst nicht mehr ab und rechnet neu)
    })
    jobs.set(key, (j = nj))
  }
  const cur = j
  let timer: ReturnType<typeof setTimeout> | undefined
  const waiting = new Promise<'waiting'>((ok) => { timer = setTimeout(ok, JOB_WAIT.ms, 'waiting') })
  try {
    const r = await Promise.race([cur.promise.then((value) => ({ value: value as T })), waiting])
    if (r === 'waiting') return { pct: Math.round(cur.pct) }
    if (jobs.get(key) === cur) jobs.delete(key)
    return r
  } catch (e) {
    if (jobs.get(key) === cur) jobs.delete(key)
    throw e
  } finally {
    clearTimeout(timer)
  }
}
const stillRunning = (what: string, pct: number) => `${what} läuft noch (${pct} %). Rufe dasselbe Tool gleich noch einmal mit denselben Eingaben auf; die Arbeit läuft im Hintergrund weiter.`

// Quellvideo der Video-Tools: asset://-URL oder absoluter Pfad → Datei. Nur Video-Endungen, die asset:// auch ausliefert (MEDIA_EXT).
function videoFile(ctx: ToolContext, video: string): { file: string; v: VideoTools } {
  const v = ctx.engine.video
  if (!v) throw new Error('Video-Funktionen gibt es nur in der Deckwerk-App und im MCP-Server.')
  const path = video.startsWith('asset:') ? decodeURIComponent(new URL(video).pathname) : video
  if (!isAbsolute(path)) throw new Error(`video "${video}": asset://-Pfad aus dem Anhang („Video: asset://…“) oder absoluten Dateipfad angeben.`)
  const file = resolve(path)
  if (!VIDEO_FILE.test(file)) throw new Error(`${file} ist kein unterstütztes Video (${VIDEO_EXT.join(', ')}).`)
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Video nicht gefunden: ${file}`)
  return { file, v }
}
// Hintergrundmusik (deck.music): asset://-URL oder absoluter Pfad einer Audiodatei → asset://-URL wie clip.video
function audioSrc(src: string): string {
  const path = src.startsWith('asset:') ? decodeURIComponent(new URL(src).pathname) : src
  if (!isAbsolute(path)) throw new Error(`music.src "${src}": asset://-Pfad aus find_music oder absoluten Dateipfad angeben.`)
  const file = resolve(path)
  if (!AUDIO_FILE.test(file)) throw new Error(`music.src: ${file} ist keine Audiodatei (${AUDIO_EXT.join(', ')}).`)
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Musik nicht gefunden: ${file}`)
  return assetUrl(file) // immer asset://local/…: die Engine erkennt nur diese Form
}
// wie musicOf in engine.ts: fehlt die Datei, entsteht das Video still ohne Musik
function musicMissing(src: string): boolean {
  try { return !existsSync(localAsset(src.startsWith('asset:') ? decodeURIComponent(new URL(src).pathname) : src)) } catch { return true } // kaputte URL
}
const videoInput = z.string().min(1).describe('Quellvideo: asset://-Pfad aus dem Anhang („Video: asset://…“), aus import_video oder absoluter Dateipfad')
const TRANSCRIPT_MAX = 30_000 // Zeichen je Antwort; der Rest seitenweise über from
const hms = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const VIDEO_NEXT = 'Weiter (Guide § Video), je nach Auftrag: Short 9:16 = 3–5 stärkste Momente, je ideal 55–75 s, hart 20–90 s, hook, captions wort, style lebendig. Ganzes Video kürzen (Fulltime) 16:9 = eine clip-Folie je Quelle mit allen behaltenen Ausschnitten in Reihenfolge, pauses kurz. Stream = nur die Highlight-Fenster, daraus Shorts, optional ein 16:9-Zusammenschnitt. Kompilation = je Quelle eine clip-Folie, Zwischentitel als section oder statement. Schnitte nur an Segmentgrenzen. Dann video_frames als Kontaktabzug, create_deck im Format (transition none), add_slides (je Short cover = Quellsekunde fürs Titelbild aus dem Kontaktabzug, post = Titel, 1–2 Sätze, 3–5 Hashtags), render_slides, export_deck clips (je Short eine MP4) oder mp4 (alles in einem Video).'
const OVERVIEW_NEXT = 'Weiter: die besten Fenster mit transcribe_video (from/to) transkribieren, Stellen mit search_transcript finden, dann video_highlights ohne overview oder direkt Shorts bauen (Guide § Video).'
const CLIP_LOOK = 'Prüfe: Gesicht im Bild, Hook passt zum Bild, keine schwarzen/eingefrorenen Bilder, Untertitelbereich frei.'
const HIGHLIGHT_NEXT = 'Weiter (Guide § Video, Stream): 1. Für die besten 3–5 Fenster transcribe_video mit from/to; nur diese Bereiche werden transkribiert, gern 30 s Anlauf davor. 2. video_frames als Kontaktabzug, 4–8 Zeitpunkte je Kandidat über das Fenster verteilt. 3. Nur Momente behalten, die ohne Chat und Vorwissen tragen; der Score ist ein Hinweis, kein Urteil. 4. Shorts bauen (create_deck format 9:16, je Moment eine clip-Folie, ideal 55–75 s, hart 20–90 s), auf Wunsch zusätzlich ein Zusammenschnitt 16:9 (je Moment eine clip-Folie, export_deck mp4).'

export function buildTools(ctx: ToolContext): ToolDef[] {
  // Speichern für Theme- und Folienänderungen: braucht das Deck andere Katalogschriften als vorher (Theme, freie Texte), lädt
  // withDeckFonts sie (offline: Ersatz) und trägt fontFiles ein. Liefert den Hinweis fürs Ergebnis, sonst ''.
  const put = async (deck: Deck, fresh = false): Promise<string> => {
    const prev = ctx.getDeck()
    let notes: string[] = []
    if (fresh || !prev || fontNeeds(prev) !== fontNeeds(deck)) ({ theme: deck.theme, notes } = await withDeckFonts(deck))
    ctx.setDeck(deck)
    return notes.length ? `Schriften: ${notes.join('; ')}\n` : ''
  }
  return [
    tool({
      name: 'create_deck',
      description: 'Neues Deck anlegen (ersetzt ein vorhandenes). Briefing, Theme oder Brand-Kit, Titel.',
      inputSchema: z.object({
        title: z.string().max(80),
        brief: z.object({ audience: z.string().max(120), goal: z.string().max(200), tone: z.string().max(60) }).optional(),
        theme: z.enum(THEME_IDS).default(THEME_IDS[0]).describe('Katalog-Theme; wird ignoriert, wenn customTheme gesetzt ist'),
        customTheme: themeSpec.optional().describe('Eigenes Design für genau dieses Deck (Standard). Vorgehen und Regeln im Design-Guide §6'),
        brand: brand.nullable().optional().describe('Brand-Kit; weglassen = das gespeicherte Brand-Kit des Nutzers (~/Deckwerk/brand.json), falls es eines gibt; null = ohne Marke'),
        transition: z.enum(TRANSITIONS).default('fade'),
        mode: z.enum(['click', 'auto']).default('click').describe('click = Vortrag (Builds per Klick), auto = Selbstlauf'),
        motion: z.enum(MOTIONS).optional().describe('Bewegungsstil wie Canva „Magic Animate“: none = keine Aufbauten, calm = nur Einblenden (Vorstand, Behörde), standard = Layout-Standard, lively = Karten nacheinander, Zahlen zoomen, Fotos mit Foto-Zoom (Pitch, Event)'),
        style: deckStyle.optional(),
        format: format.optional().describe('Folienformat; weglassen = 16:9-Präsentation'),
        tune: tuneSpec.optional(),
        override,
      }),
      async run(i) {
        const deck: Deck = { title: typeset(i.title), brief: i.brief, theme: { id: i.customTheme ? 'custom' : i.theme, brand: i.brand === undefined ? defaultBrand() : i.brand ?? undefined, custom: i.customTheme && { ...i.customTheme, elements: i.customTheme.elements ?? 'line' }, tune: mergeTune(undefined, i.tune) }, transition: i.transition, mode: i.mode, motion: i.motion === 'standard' ? undefined : i.motion, style: i.style ?? (!i.customTheme && THEMES.find((t) => t.id === i.theme)?.mutig ? 'mutig' : undefined), slides: [], ...(i.format && i.format !== '16:9' && { size: { w: FORMATS[i.format].w, h: FORMATS[i.format].h } }) }
        const hints = deck.theme.custom ? checkTheme(lintFor({ ...deck.theme.custom, ...deck.theme.tune }, deck.theme.brand, i.override), 'customTheme') + shadowed(i.customTheme, deck.theme.tune) : ''
        const fonts = await put(deck, true)
        const rep = deck.theme.brand ? '' : repeats(lookTyp(deck.theme), recentLooks(deck.title))
        return { text: `${hints}${fonts}${rep && `Hinweis: Dieses Design ${rep}\n`}Deck "${deck.title}" angelegt (Theme ${deck.theme.custom ? `eigenes: ${deck.theme.custom.name}` : deck.theme.id}, Übergang ${deck.transition}, Modus ${deck.mode}, Stil ${deck.style ?? 'nicht gewählt (gilt als sachlich; nach Anlass wählen, Design-Guide §6)'}${deck.theme.brand ? `, Brand-Kit des Nutzers angewendet${deck.theme.brand.logo ? `, Logo ${deck.theme.brand.logo} auf Titel- und Schlussfolie (A4: Seite 1)` : ''}` : ''}). ${PREVIEW_HINT}`, images: await themePreview(ctx, deck) }
      },
    }),
    tool({
      name: 'update_deck',
      description: 'Titel, Theme, Feinschliff (tune), Brand-Kit, Übergang, Modus, Briefing oder Hintergrundmusik (Video) des Decks ändern.',
      inputSchema: z.object({
        title: z.string().max(80).optional(),
        brief: z.object({ audience: z.string().optional(), goal: z.string().optional(), tone: z.string().optional() }).optional(),
        theme: z.enum(THEME_IDS).optional().describe('Katalog-Theme; entfernt ein eigenes Theme'),
        customTheme: themeSpec.partial().nullable().optional().describe('Eigenes Theme setzen oder einzelne Werte ändern (Rest bleibt); null = zurück zum Katalog-Theme'),
        brand: brand.nullable().optional().describe('null entfernt das Brand-Kit'),
        transition: z.enum(TRANSITIONS).optional(),
        mode: z.enum(['click', 'auto']).optional(),
        motion: z.enum(MOTIONS).optional().describe('Bewegungsstil wie Canva „Magic Animate“: none = keine Aufbauten, calm = nur Einblenden (Vorstand, Behörde), standard = Layout-Standard, lively = Karten nacheinander, Zahlen zoomen, Fotos mit Foto-Zoom (Pitch, Event)'),
        style: deckStyle.optional(),
        shuffle: z.number().int().min(0).max(5).optional().describe('Farbvariante des Themes wie Canva „Stile mischen“: 0 = Original, 1 = Akzente getauscht, 2 = Hell/Dunkel getauscht, 3 = beides, 4/5 = getönter Grund'),
        fonts: z.tuple([fontName, fontName]).nullable().optional().describe('Schriftpaar [Titel, Text] über das Theme legen; null = Theme-Schriften'),
        format: format.optional().describe('Magic Resize: Deck in ein anderes Format bringen; freie Elemente werden mitskaliert, Layouts ordnen sich neu an. Danach render_overview prüfen.'),
        music: z.object({
          src: z.string().min(1).describe('asset://-Pfad aus find_music oder absoluter Pfad einer Audiodatei'),
          volume: z.number().min(0).max(1).optional().describe('0–1, Standard 0,25; dezent bleiben'),
          credit: z.string().max(300).optional().describe('Nachweis aus find_music (bei CC BY Pflicht), zusätzlich in die Notes der letzten Folie'),
        }).nullable().optional().describe('Hintergrundmusik im Video-Export (mp4, clips), leise unter allem, weicht der Sprache automatisch; nur auf Wunsch oder bei Kompilationen. null = entfernen'),
        tune: tuneSpec.optional(),
        override,
      }),
      async run(i) {
        const deck = needDeck(ctx)
        // Neues eigenes Design (keins vorher oder neuer Name): Bauteile line; Korrekturen an einem alten Design behalten seine Bauteile
        const fresh = !deck.theme.custom || (!!i.customTheme?.name && i.customTheme.name !== deck.theme.custom.name)
        // Lint-Stand vor dem Aufruf: alte Fehler (Decks von vor dem Theme-Lint) blockieren keine Korrekturen und keinen Feinschliff;
        // ein ganz neuer Entwurf erbt keine Altlast
        const before = (i.customTheme || i.tune) && deck.theme.custom && !fresh ? lintFor({ ...deck.theme.custom, ...deck.theme.tune }, deck.theme.brand) : []
        if (i.music === null) delete deck.music
        else if (i.music) deck.music = { ...i.music, src: audioSrc(i.music.src) }
        if (i.title) deck.title = typeset(i.title)
        if (i.brief) deck.brief = { ...deck.brief, ...i.brief }
        if (i.theme) { deck.theme.id = i.theme; delete deck.theme.custom }
        if (i.customTheme === null) { delete deck.theme.custom; if (deck.theme.id === 'custom') deck.theme.id = THEME_IDS[0] }
        else if (i.customTheme) {
          const merged = { ...deck.theme.custom, ...(fresh && { elements: 'line' as const }), ...i.customTheme }
          const r = themeSpec.safeParse(merged)
          if (!r.success) throw new Error(`customTheme unvollständig: ${z.prettifyError(r.error)}\nBeim ersten Setzen alle Pflichtfelder angeben.`)
          deck.theme.custom = r.data
          deck.theme.id = 'custom'
        }
        if (i.tune) deck.theme.tune = mergeTune(deck.theme.tune, i.tune)
        if (i.brand !== undefined) deck.theme.brand = i.brand ?? undefined
        const hints = (i.customTheme || i.tune) && deck.theme.custom ? checkTheme(lintFor({ ...deck.theme.custom, ...deck.theme.tune }, deck.theme.brand, i.override), 'customTheme', before) + shadowed(i.customTheme, deck.theme.tune) : ''
        if (i.transition) deck.transition = i.transition
        if (i.mode) deck.mode = i.mode
        if (i.motion) deck.motion = i.motion === 'standard' ? undefined : i.motion
        if (i.style) deck.style = i.style
        if (i.shuffle !== undefined) deck.theme.shuffle = i.shuffle || undefined
        if (i.fonts !== undefined) deck.theme.fonts = i.fonts ?? undefined
        if (i.format) Object.assign(deck, resizeDeck(deck, i.format))
        const fonts = await put(deck)
        const look = i.theme || i.customTheme || i.tune || i.brand !== undefined || i.shuffle !== undefined || i.fonts !== undefined // Theme geändert → neue Vorschau
        return {
          text: `${hints}${fonts}Deck aktualisiert: ${JSON.stringify({ title: deck.title, theme: { ...deck.theme, fontFiles: undefined }, transition: deck.transition, mode: deck.mode, style: deck.style ?? 'nicht gewählt', music: deck.music })}${look ? `\n${PREVIEW_HINT}` : ''}`,
          images: look ? await themePreview(ctx, deck) : undefined,
        }
      },
    }),
    tool({
      name: 'add_slides',
      description: 'Folien im Batch anhängen (oder an Position `at` einfügen). Gibt pro Folie Autofit und Lint zurück – Fehler müssen behoben werden.',
      inputSchema: z.object({
        slides: z.array(slideInput).min(1).max(20),
        at: z.number().int().min(0).optional().describe('Einfügeposition (0-basiert); weglassen = ans Ende'),
      }),
      async run(i) {
        const deck = needDeck(ctx)
        const fresh: Slide[] = i.slides.map((s, k) => ({
          id: '', layout: s.layout, variant: s.variant, build: s.build, transition: s.transition, tone: s.tone, decor: s.decor, frame: (checkFrame(s.layout, s.frame, `slides[${k}]`), s.frame), notes: s.notes && typeset(s.notes), items: withIds(s.items as Item[]), bg: s.bg,
          content: validateContent(s.layout, s.content, `slides[${k}]`),
        }))
        for (const s of fresh) { s.id = newSlideId(deck); deck.slides.push(s) } // push nur für die ID-Vergabe
        deck.slides.splice(-fresh.length, fresh.length)
        const at = Math.min(i.at ?? deck.slides.length, deck.slides.length)
        deck.slides.splice(at, 0, ...fresh)
        const fonts = await put(deck)
        return { text: fonts + await report(ctx, deck, fresh.map((_, k) => at + k)) }
      },
    }),
    tool({
      name: 'update_slide',
      description: 'Eine Folie ändern: Inhalt (Patch, wird mit dem Bestand gemischt), Layout, Variante, Build, Notes, Ausblenden. Gibt Autofit und Lint zurück.',
      inputSchema: z.object({
        id: z.string(),
        layout: layoutId.optional().describe('Layout wechseln; dann content vollständig mitgeben'),
        variant: z.string().nullable().optional(),
        tone: z.enum(TONES).nullable().optional().describe('null = Standard des Layouts'),
        decor: z.enum(DECORS).nullable().optional().describe('null = Standard des Themes'),
        frame: z.enum(FRAMES).nullable().optional().describe(FRAME_HINT),
        content: z.record(z.string(), z.unknown()).optional().describe('Nur geänderte Felder; Arrays werden komplett ersetzt'),
        build: build.nullable().optional(),
        transition: slideTransition.nullable().optional().describe('null = Deck-Übergang'),
        notes: z.string().max(1500).nullable().optional(),
        items: z.array(itemSchema).max(60).nullable().optional().describe('Ersetzt alle freien Elemente der Folie (vorhandene IDs mitgeben, um sie zu behalten); null = alle entfernen'),
        bg: slideBg.nullable().optional(),
        hidden: z.boolean().optional().describe('true = Folie ausblenden (fehlt beim Präsentieren und in PDF, PNG, Word, Handout; in PowerPoint versteckt), false = wieder einblenden'),
      }),
      async run(i) {
        const deck = needDeck(ctx)
        const idx = indexOf(deck, i.id)
        const s = deck.slides[idx]
        const layout = i.layout ?? s.layout
        const merged = i.layout && i.layout !== s.layout ? (i.content ?? {}) : { ...s.content, ...i.content }
        checkFrame(layout, i.frame === undefined ? s.frame : (i.frame ?? undefined), `Folie ${i.id}`) // vor jeder Änderung
        s.content = validateContent(layout, merged, `Folie ${i.id}`)
        s.layout = layout
        if (i.variant !== undefined) s.variant = i.variant ?? undefined
        if (i.tone !== undefined) s.tone = i.tone ?? undefined
        if (i.decor !== undefined) s.decor = i.decor ?? undefined
        if (i.frame !== undefined) s.frame = i.frame ?? undefined
        if (i.build !== undefined) s.build = i.build ?? undefined
        if (i.transition !== undefined) s.transition = i.transition ?? undefined
        if (i.notes !== undefined) s.notes = i.notes ? typeset(i.notes) : undefined
        if (i.items !== undefined) s.items = withIds((i.items ?? undefined) as Item[] | undefined)
        if (i.bg !== undefined) s.bg = i.bg ?? undefined
        if (i.hidden !== undefined) s.hidden = i.hidden || undefined
        const fonts = await put(deck)
        return { text: fonts + await report(ctx, deck, [idx]) }
      },
    }),
    tool({
      name: 'reorder_slides',
      description: 'Reihenfolge setzen: vollständige Liste aller Folien-IDs in neuer Reihenfolge.',
      inputSchema: z.object({ order: z.array(z.string()).min(1) }),
      async run(i) {
        const deck = needDeck(ctx)
        const have = deck.slides.map((s) => s.id).sort().join()
        if ([...i.order].sort().join() !== have) throw new Error(`order muss genau alle IDs enthalten: ${deck.slides.map((s) => s.id).join(', ')}`)
        deck.slides = i.order.map((id) => deck.slides[indexOf(deck, id)])
        ctx.setDeck(deck)
        return { text: `Neue Reihenfolge: ${deck.slides.map((s, k) => `${k + 1}:${s.layout}${hid(s)}`).join(' ')}` }
      },
    }),
    tool({
      name: 'delete_slides',
      description: 'Folien löschen.',
      inputSchema: z.object({ ids: z.array(z.string()).min(1) }),
      async run(i) {
        const deck = needDeck(ctx)
        i.ids.forEach((id) => indexOf(deck, id))
        deck.slides = deck.slides.filter((s) => !i.ids.includes(s.id))
        ctx.setDeck(deck)
        return { text: `${i.ids.length} Folie(n) gelöscht, ${deck.slides.length} übrig.` }
      },
    }),
    tool({
      name: 'decorate_slide',
      description: 'Nur auf ausdrücklichen Wunsch des Nutzers oder im Deck-Stil mutig (wirkt sonst generiert). Canva-Akzent auf eine Layout-Folie setzen, ohne Koordinaten: Sticker, Form oder Icon in einer freien Ecke. Die Engine sucht dort freien Platz, der nichts überdeckt. Höchstens ein Akzent pro Folie, nur auf luftigen Folien (cover, statement, section, big-number, quote, closing).',
      inputSchema: z.object({
        id: z.string(),
        accent: z.object({
          kind: z.enum(['shape', 'icon', 'graphic']),
          graphic: z.enum(Object.keys(GRAPHICS) as [string, ...string[]]).optional().describe('handgezeichnet: sparkle = Funkeln, squiggle = Kringel, burst = Strahlen, blob = Klecks, arrow, scribble, swoosh, waves'),
          shape: z.enum(['star12', 'star8', 'star4', 'donut', 'plus', 'heart', 'ellipse']).optional().describe('star12 = Siegel/Sticker, star4 = Funkeln, donut = Ring'),
          icon: z.string().max(40).optional().describe('lucide-Name, z. B. "sparkles"'),
          zone: z.enum(['top-right', 'bottom-right', 'bottom-left', 'top-left']),
          size: z.enum(['s', 'm', 'l']).default('m'),
          color: hexColor.optional().describe('weglassen = Zweitakzent des Themes'),
          rot: z.number().min(-45).max(45).optional(),
        }).nullable().describe('null entfernt den Akzent'),
      }),
      async run(i) {
        const deck = needDeck(ctx)
        const idx = indexOf(deck, i.id)
        const s = deck.slides[idx]
        s.items = (s.items ?? []).filter((it) => it.id !== 'accent')
        let where = 'entfernt'
        if (i.accent) {
          const a = i.accent
          if (a.kind === 'shape' && !a.shape) throw new Error('accent.shape fehlt')
          if (a.kind === 'icon' && !a.icon) throw new Error('accent.icon fehlt')
          if (a.kind === 'graphic' && !a.graphic) throw new Error('accent.graphic fehlt')
          const [m] = await ctx.engine.measure(deck, [idx])
          const { w: W, h: H } = sizeOf(deck)
          const px = { s: 72, m: 112, l: 160 }[a.size], gap = 16, edge = 28
          const blocked = m.els.filter((e) => !e.slot.startsWith('items.') && !(e.kind === 'img' && e.under)).map((e) => e.box)
          const free = (x: number, y: number) => blocked.every((b) => x + px + gap <= b.x || x >= b.x + b.w + gap || y + px + gap <= b.y || y >= b.y + b.h + gap)
          // Kandidaten von der Ecke nach innen, nächstgelegene zuerst
          const right = a.zone.endsWith('right'), bottom = a.zone.startsWith('bottom')
          const cands: [number, number][] = []
          for (let dx = 0; dx <= W / 2 - px; dx += 16) for (let dy = 0; dy <= H / 2 - px; dy += 16)
            cands.push([right ? W - edge - px - dx : edge + dx, bottom ? H - edge - px - dy : edge + dy])
          cands.sort((p, q) => Math.hypot(p[0] - (right ? W : 0), p[1] - (bottom ? H : 0)) - Math.hypot(q[0] - (right ? W : 0), q[1] - (bottom ? H : 0)))
          const at = cands.find(([x, y]) => free(x, y))
          if (!at) throw new Error(`In der Ecke ${a.zone} ist kein Platz für Größe ${a.size}. Kleinere Größe oder andere Ecke wählen.`)
          const color = a.color ?? resolveTheme(deck.theme).c.accent2
          const box = { id: 'accent', x: at[0], y: at[1], w: px, h: px, rot: a.rot }
          s.items.push(a.kind === 'shape' ? { ...box, kind: 'shape', shape: a.shape, fill: color } : a.kind === 'graphic' ? { ...box, kind: 'graphic', graphic: a.graphic, color } : { ...box, kind: 'icon', icon: a.icon, color })
          where = `gesetzt bei x=${at[0]}, y=${at[1]} (${px} px)`
        }
        ctx.setDeck(deck)
        return { text: `Akzent ${where}.\n${await report(ctx, deck, [idx])}` }
      },
    }),
    tool({
      name: 'render_slides',
      description: 'PNG-Vorschau einzelner Folien (Standard 1024 px breit). Nur geänderte Folien anfordern, Bilder kosten Tokens.',
      inputSchema: z.object({ ids: z.array(z.string()).min(1).max(8), width: z.number().int().min(320).max(1280).default(1024) }),
      async run(i) {
        const deck = needDeck(ctx)
        const idx = i.ids.map((id) => indexOf(deck, id))
        const bufs = await ctx.engine.renderPng(deck, idx, i.width)
        return { text: idx.map((k) => `Folie ${k + 1} (${deck.slides[k].id}, ${deck.slides[k].layout})${hid(deck.slides[k])}`).join('\n'), images: bufs }
      },
    }),
    tool({
      name: 'propose_looks',
      description: 'Zwei bis drei deutlich verschiedene Looks zur Auswahl rendern (je Cover, Kennzahlen, Diagramm, Kapiteltrenner). Für neue Decks, vor create_deck. Der Nutzer wählt; danach create_deck mit genau diesem customTheme bzw. Katalog-Theme.',
      inputSchema: z.object({ looks: z.array(z.union([z.enum(CATALOG_THEMES.map((t) => t.id) as [string, ...string[]]), themeSpec])).min(2).max(3).describe('Eigene Entwürfe für dieses Thema (Design-Guide §6): einer hell und sachlich, einer dunkel oder plakativ, ein dritter als Überraschung (unerwartet, aber aus dem Thema begründet); sie unterscheiden sich in Struktur (Serif/Sans, titleSize, rule, sectionTone, labelFont, signature, margin/measure, heroTone, field), nicht nur in der Farbe. Ein Katalog-Theme ist erlaubt, im Stil mutig auch plakat/magazin/neomono/pastell.'), override }),
      async run(i) {
        const title = ctx.getDeck()?.title ?? 'Vorschau'
        const refs = i.looks.map((l) => (typeof l === 'string' ? { id: l } : { id: 'custom', custom: { ...l, elements: l.elements ?? 'line' } }))
        const kit = defaultBrand()
        const lint = i.looks.map((l, k) => (typeof l === 'string' ? '' : checkTheme(lintFor(l, kit, i.override), `Look ${k + 1} ${l.name}`))).join('')
        // Guide §6: Entwürfe unterscheiden sich in der Struktur (mindestens 4 Merkmale), sonst sieht der Nutzer nur Umfärbungen desselben Looks
        const traits = refs.map((r) => {
          const t = resolveTheme(r), ax = r.custom && axesOf(r.custom)
          return { 'hell/dunkel': t.dark, 'Serif/Sans': !!t.head.serif, titleSize: (t.headScale ?? 1) > 1, titleWeight: t.head.weight, rule: t.rule ?? 'none', sectionTone: t.sectionTone ?? 'accent', Farbgrund: !!t.vivid, Bauteile: t.elements ?? 'line',
            field: !!ax?.field, signature: ax?.signature ?? 'none', 'margin/measure': ax?.space ?? 'standard', heroTone: ax?.heroTone ?? 'normal' }
        })
        for (let a = 0; a < traits.length; a++)
          for (let b = a + 1; b < traits.length; b++) {
            const same = Object.keys(traits[a]).filter((k) => traits[a][k as keyof (typeof traits)[0]] === traits[b][k as keyof (typeof traits)[0]])
            const differ = Object.keys(traits[a]).length - same.length
            if (differ < 4) throw new Error(`Look ${a + 1} und ${b + 1} unterscheiden sich kaum, gleich sind: ${same.join(', ')}. Ändere bei einem mindestens ${4 - differ} davon, damit der Nutzer echte Alternativen sieht.`)
          }
        // dazu Farbstrategie und Schriftgenre (theme-lint.ts) als Hinweis
        const similar = lintLooks(i.looks.flatMap((l) => (typeof l === 'string' ? [] : [axesOf(l)]))).map((x) => `Hinweis: ${x.message}\n`).join('')
        // Guide §6 „Abwechslung“: mindestens ein Look hebt sich im Typ von den letzten Decks ab (mit Brand-Kit gilt dessen Look)
        const recent = kit ? [] : recentLooks()
        const reps = refs.map((r) => repeats(lookTyp(r), recent))
        if (reps.every(Boolean)) throw new Error(`Alle Looks gleichen im Typ deinen letzten Decks (${recent.slice(0, 3).map((r) => `„${r.title}“: ${typText(r.typ)}`).join('; ')}). Baue mindestens einen Look in Grund (getönt, dunkel, im Stil mutig kräftig), Schrift (Sans statt Serif oder umgekehrt), Titelgewicht oder Bauteile (line/plain) anders – außer der Nutzer will eine Serie, dann create_deck direkt (Design-Guide §6 „Abwechslung“).`)
        const loaded = await Promise.all(refs.map((r) => withFonts(r))) // Vorschau in den gewählten Schriften (offline: Ersatz)
        const images = (await Promise.all(loaded.map(({ ref: theme }) => themePreview(ctx, { title, theme, transition: 'fade', mode: 'click', slides: [] })))).map((b) => b[0])
        const fontNotes = [...new Set(loaded.flatMap((l) => l.notes))]
        if (images.some((b) => !b)) throw new Error('Vorschau fehlgeschlagen, bitte einzeln mit create_deck prüfen.')
        const label = (l: (typeof i.looks)[number]) => (typeof l === 'string' ? CATALOG_THEMES.find((t) => t.id === l)!.name : l.name)
        const names = i.looks.map((l, k) => `${k + 1}. ${label(l)}`).join('\n')
        const hints = lint + similar + reps.map((x, k) => x && `Hinweis: Look ${k + 1} ${x}\n`).join('') + (fontNotes.length ? `Schriften: ${fontNotes.join('; ')}\n` : '')
        if (!ctx.choice) return { text: `${hints}Looks (Bilder in dieser Reihenfolge):\n${names}\nZeig dem Nutzer die Namen und frag, welchen er möchte.`, images }
        ctx.choice({ question: 'Welcher Look soll es werden?', options: i.looks.map((l, k) => ({ label: label(l), image: `data:${mimeOf(images[k])};base64,${images[k].toString('base64')}` })) })
        return { text: `${hints}Looks zur Auswahl angezeigt:\n${names}\nBeende jetzt den Turn ohne weiteren Text; die Wahl kommt als nächste Nachricht (Name des Looks).`, images }
      },
    }),
    tool({
      name: 'render_overview',
      description: 'Kontaktbogen aller Folien als ein Bild – der Art-Director-Blick auf Rhythmus, Konsistenz und Dichte.',
      inputSchema: z.object({}),
      async run() {
        const deck = needDeck(ctx)
        if (!deck.slides.length) throw new Error('Das Deck hat noch keine Folien.')
        return { text: `Kontaktbogen: ${deck.slides.length} Folien, Reihenfolge ${deck.slides.map((s) => s.layout + hid(s)).join(' → ')}\n${ART_DIRECTOR}`, images: [await ctx.engine.renderOverview(deck)] }
      },
    }),
    tool({
      name: 'lint_deck',
      description: 'Alle Probleme des Decks (Fehler müssen weg, Warnungen sind Ermessen).',
      inputSchema: z.object({}),
      async run() {
        const deck = needDeck(ctx)
        const [lint, clips] = await Promise.all([ctx.engine.lint(deck), clipChecks(ctx, deck, deck.slides.map((_, i) => i))])
        const issues: Note[] = [...lint, ...[...clips.values()].flatMap((c) => c.issues)].sort((a, b) => a.slide - b.slide) // stabil: je Folie erst Lint, dann Clip-Prüfung
        const e = issues.filter((x) => x.severity === 'error').length, h = issues.filter((x) => x.severity === 'info').length
        if (!issues.length) return { text: 'Keine Probleme. Das Deck ist sauber.' }
        return { text: `${e} Fehler, ${issues.length - e - h} Warnungen${h ? `, ${h} Hinweise` : ''}:\n` + issues.map((x) => `  - Folie ${x.slide + 1} (${x.slideId})${hid(deck.slides[x.slide])} [${sev(x)}] ${x.rule}${x.slot ? ` @${x.slot}` : ''}: ${x.message}`).join('\n') }
      },
    }),
    tool({
      name: 'search_icons',
      description: 'Lucide-Icons suchen (kebab-case-Namen für das Feld `icon`).',
      inputSchema: z.object({ query: z.string().min(1).max(40).describe('englischer Begriff, z. B. "shield", "chart"'), limit: z.number().int().min(1).max(50).default(20) }),
      async run(i) {
        const terms = i.query.toLowerCase().split(/[\s,]+/).filter(Boolean)
        const hits = ICON_NAMES.filter((n) => terms.some((t) => n.includes(t))).slice(0, i.limit)
        return { text: hits.length ? hits.join(', ') : `Kein Icon zu "${i.query}". Anderen englischen Begriff versuchen.` }
      },
    }),
    tool({
      name: 'find_images',
      readOnly: true,
      description: 'Bilder finden: eigene Dateien im Asset-Ordner, Fotos aus dem Netz (Unsplash mit Key, sonst Openverse: freie Bilder von Wikimedia Commons, Flickr u. a., ohne Key) oder ein Bild direkt per `url` (Link vom Nutzer oder aus der Websuche; asset://-Pfade aus dem Material des Nutzers zeigt es nur an). Eigene Dateien kommen neueste zuerst. Treffer werden heruntergeladen und als Vorschau mitgeliefert. Rückgabe: asset://-Pfade für `image.src`, mit Maßen, Lizenz und Bildnachweis für die Notes. Setze `image.focus` nach dem Vorschaubild (wo Gesicht oder Motiv sitzt), wenn es nicht mittig ist.',
      inputSchema: z.object({
        query: z.string().max(80).optional().describe('lokal: Teil des Dateinamens; Netz: englische Suchbegriffe, z. B. "teacher classroom"'),
        source: z.enum(['auto', 'local', 'unsplash', 'web']).default('auto').describe('auto = lokal, ohne lokalen Treffer aus dem Netz (Unsplash, sonst Openverse); web = Openverse'),
        url: z.string().url().max(2000).optional().describe('Bild direkt von dieser Adresse übernehmen. Nur Bilder, die der Nutzer genannt hat oder die verwendet werden dürfen (freie Lizenz, eigene Website); Quelle in die Notes. Auch asset://-Pfade aus Quellmaterial oder Anhängen des Nutzers, um sie vor dem Einbauen anzusehen'),
        limit: z.number().int().min(1).max(5).default(3),
        orientation: z.enum(['landscape', 'portrait', 'squarish']).default('landscape').describe('Unsplash: landscape für Vollbild/Cover/Galerie, portrait für Porträts (quote) und Hochformat-Decks (4:5, 9:16, A4), squarish für Kacheln und Quadrat-Decks'),
      }),
      async run(i) {
        if (i.url) return i.url.startsWith('asset:') ? fromAsset(ctx, i.url) : fromUrl(ctx, i.url)
        const q = i.query?.toLowerCase()
        let local: { file: string; t: number }[] = []
        try {
          local = readdirSync(ctx.assetDir, { recursive: true, encoding: 'utf8' }).filter((f) => IMG_FILE.test(f) && (!q || f.toLowerCase().includes(q)))
            .flatMap((f) => { const file = join(ctx.assetDir, f), st = statSync(file, { throwIfNoEntry: false }); return st?.isFile() ? [{ file, t: st.mtimeMs }] : [] })
            .sort((a, b) => b.t - a.t)
        } catch {}
        if (i.source === 'local' || (i.source === 'auto' && local.length)) return localImages(ctx, local.map((h) => h.file), i.limit)
        if (!i.query) return { text: `${local.length ? '' : 'Keine lokalen Bilder. '}Für Fotos aus dem Netz eine englische query angeben.` }
        const unsplashKey = imageSettings.unsplash || ctx.unsplashKey // Key aus der App hat Vorrang wie bei den Bild-Keys
        if (i.source === 'unsplash' && !unsplashKey) throw new Error('Unsplash ist nicht eingerichtet (Einstellungen → Bilder oder UNSPLASH_ACCESS_KEY). source "web" sucht ohne Key.')
        return i.source !== 'web' && unsplashKey ? unsplash(ctx, i.query, i.limit, i.orientation) : openverse(ctx, i.query, i.limit, i.orientation)
      },
    }),
    tool({
      name: 'generate_image',
      readOnly: true, // ein Bild dauert 1–2 min; nacheinander wurden aus 4 Bildern über 6 min
      description: 'Bild per KI erzeugen (Szene, Stimmung, Illustration, ruhige Bildfläche), wenn find_images nichts Passendes liefert oder der Nutzer es will. Dauert 20–120 s und kostet: alle Bilder des Plans in einer Antwort gleichzeitig anfordern (sie laufen parallel), erst einen Bildplan machen (2–5 Schlüsselfolien wie Cover, Kapitelwechsel, Höhepunkt, Abschluss) und einen Stilsatz, der wörtlich an jeden Prompt kommt. Nie für echte Personen, Logos, Marken, echte Produkte oder Orte des Nutzers (das wären Fälschungen), Diagramme oder Text. Kein KI-Look (Neon, Roboter, Glühbirnen, glänzendes 3D). Regeln im Design-Guide §6 „KI-Bilder“. Rückgabe: asset://-Pfad für `image.src` plus Vorschau.',
      inputSchema: z.object({
        prompt: z.string().min(10).max(1500).describe('Englisch, in dieser Reihenfolge: Motiv und Handlung, Umgebung, Ausschnitt mit ruhiger Fläche für den Titel (z. B. "subject on the right, calm empty left half"), Licht und Stimmung, Stilsatz des Decks mit Theme-Farben als Wort plus Hex, zum Schluss "no text, no letters, no logos, no watermark". Konkrete Szene statt abstraktem Begriff.'),
        orientation: z.enum(['landscape', 'portrait', 'square']).default('landscape').describe('landscape für cover, photo, closing und gallery; square für image-text, section und big-number; portrait für Hochformat-Decks (4:5, 9:16, A4), sonst selten'),
        provider: z.enum(IMAGE_PROVIDERS).optional().describe('nur auf Wunsch des Nutzers; weglassen = der erste eingerichtete (Mammouth, OpenAI, Codex)'),
      }),
      async run(i) {
        return generateImage(ctx, i.prompt, i.orientation, i.provider)
      },
    }),
    tool({
      name: 'export_deck',
      description: 'Deck exportieren: pptx (editierbar, mit Animationen), docx (Word: eine Seite pro Folie, Text in bearbeitbaren Textfeldern, Fotos, Flächen und Diagramme als Hintergrundbild; für Flyer und A4-Dokumente, die der Nutzer in Word weiterbearbeiten will), pdf (pixelgenau), png (eine Datei pro Folie), zip (alle PNG plus PDF in einer Datei, z. B. Social-Karussell), md (Handout: Titel, Inhalte, Notizen), print (PDF für die Druckerei, Datei …-druck.pdf: Seite = Endformat + Beschnitt ringsum, Standard 3 mm; Flyeralarm 1 mm, Saxoprint/Onlineprinters 2 mm, WIRmachenDRUCK 3 mm; ohne Schnittmarken, randabfallende Fotos laufen gespiegelt in den Beschnitt; Farben RGB, die genannten Druckereien wandeln selbst nach CMYK, print24 verlangt CMYK – dem Nutzer bei großer Auflage einen Probedruck raten), clips (je Folie im Layout clip ein Short als eigene MP4 mit Hook und Untertiteln; die Untertitel kommen aus dem Transkript, also vorher transcribe_video für die Ausschnitte aufrufen) oder mp4 (das ganze Deck als ein Video: Clip-Folien mit ihren Ausschnitten, bis 100 je Folie, z. B. ein ganzes Video gekürzt (Fulltime); andere Folien als Standbild von 3 s, z. B. Zwischentitel; Folien mit transition außer none und morph blenden über Schwarz ab und auf, deshalb Video-Decks mit transition none anlegen und fade nur gezielt setzen). fit blur zeigt das ganze Bild auf unscharfem Grund statt es zuzuschneiden. Hintergrundmusik aus update_deck music (find_music) läuft in jeder Video-Datei leise mit und weicht der Sprache automatisch (Ducking). Video-Exporte laufen im Hintergrund (1080p auf langsamen Rechnern mit ~10 fps, 1 h Video ≈ 2–3 h): meldet das Tool „läuft noch“, gleich noch einmal aufrufen. Dateinamen tragen bei Nicht-16:9 das Format (…-4x5, …-a4). Serienbrief (Urkunden, Namensschilder, Einladungen): {{Spalte}} in die Texte setzen und rows übergeben, dann entsteht je Zeile eine Datei im Ordner serie-<format>.',
      inputSchema: z.object({
        format: z.enum(['pptx', 'docx', 'pdf', 'png', 'zip', 'md', 'print', 'clips', 'mp4']),
        size: z.enum(Object.keys(PRINT_SIZES) as [keyof typeof PRINT_SIZES, ...(keyof typeof PRINT_SIZES)[]]).optional().describe('nur print und nur bei A4-Decks: verlustfrei auf ein anderes A-Format skalieren (a2 = Plakat, a3, a5, a6 = Postkarte); weglassen = Format des Decks'),
        bleed: z.number().min(0).max(5).optional().describe('nur print: Beschnitt in mm (Standard 3)'),
        rows: z.array(z.record(z.string(), z.string())).min(1).max(500).optional().describe('Serienbrief: je Zeile eine Datei, {{Spalte}} im Deck wird ersetzt'),
      }),
      async run(i) {
        const deck = needDeck(ctx)
        if (!deck.slides.length) throw new Error('Das Deck hat noch keine Folien.')
        const print = { size: i.size, bleed: i.bleed }
        if (i.rows) return { text: `Exportiert (${i.format}):\n${(await exportSeries(ctx.engine, deck, i.rows, i.format, ctx.outDir, print)).join('\n')}` }
        const key = `export:${createHash('sha1').update(JSON.stringify([i.format, print, ctx.outDir, deck])).digest('hex')}` // geändertes Deck = neuer Export
        const r = await job(key, (onProgress) => ctx.engine.exportDeck(deck, i.format, ctx.outDir, print, onProgress))
        if (!('value' in r)) return { text: stillRunning('Export', r.pct) }
        const notes: string[] = []
        if (i.format === 'mp4') { // wie export-video.ts: Folien mit Übergang außer none/morph blenden über Schwarz
          const shown = { ...deck, slides: visibleSlides(deck) }
          const n = shown.slides.filter((_, k) => !['none', 'morph'].includes(transitionOf(shown, k))).length
          notes.push(`${n} ${n === 1 ? 'Übergang' : 'Übergänge'} mit Abblende (Folien-transition; none = harter Schnitt)`)
        }
        if ((i.format === 'mp4' || i.format === 'clips') && deck.music?.src && musicMissing(deck.music.src))
          notes.push('Musik nicht gefunden – ohne Musik exportiert, Nachweis aus den Notes entfernen')
        // wie export-video.ts: clips = je Short immer ein Cover, .txt nur mit post; mp4 = aus der ersten Clip-Folie mit cover/post
        const cs = visibleSlides(deck).filter((s) => s.layout === 'clip').map((s) => s.content as ClipContent)
        if (i.format === 'clips' && cs.length)
          notes.push(`Neben jeder MP4: Cover (.jpg${cs.some((c) => c.cover == null) ? ', ohne cover aus der Mitte des ersten Ausschnitts' : ''})${cs.some((c) => c.post?.trim()) ? ' und Post-Text (.txt) bei Shorts mit post' : ''}`)
        if (i.format === 'mp4' && cs.some((c) => c.cover != null || c.post?.trim()))
          notes.push('Neben der MP4: Cover (.jpg) und Post-Text (.txt, mit post) aus der ersten Clip-Folie mit cover/post')
        return { text: [`Exportiert (${i.format}):`, ...r.value, ...notes].join('\n') }
      },
    }),
    tool({
      name: 'import_video',
      description: 'Video per Link laden (YouTube, Twitch, Kick und andere Seiten, die yt-dlp kennt), bis 1080p, dazu Kapitel und bei ehemaligen Livestreams auf YouTube und Twitch der Chat (Signal für video_highlights). Nur Material, an dem der Nutzer die Rechte hat (eigener Kanal, eigener Stream, Erlaubnis) oder das frei lizenziert ist; im Zweifel nachfragen statt laden. Laufende Livestreams gehen erst nach dem Ende als Aufzeichnung. Lange Downloads laufen im Hintergrund: meldet das Tool „läuft noch“, rufe es gleich noch einmal mit derselben url auf. Rückgabe: asset://-Pfad für die Video-Tools und clip.video. Ablauf: read_guide topic video.',
      inputSchema: z.object({ url: z.string().url().max(2000).describe('Link zum Video oder zur Aufzeichnung (VOD)') }),
      async run(i) {
        const v = ctx.engine.video
        if (!v?.importUrl) throw new Error('Videos per Link laden gibt es nur in der Deckwerk-App und im MCP-Server.')
        const r = await job(`import:${i.url}`, (onProgress) => v.importUrl!(i.url, onProgress))
        if (!('value' in r)) return { text: stillRunning('Download', r.pct) }
        const x = r.value, src = assetUrl(x.file)
        const chapters = x.chapters.slice(0, 30).map((c) => `${hms(c.start)} ${c.title}`)
        if (x.chapters.length > 30) chapters.push(`… und ${x.chapters.length - 30} weitere`)
        const next = x.duration > LONG_VIDEO ? `video_highlights mit diesem Video (über 10 min: erst die stärksten Fenster finden, dann nur diese transkribieren)` : 'transcribe_video mit diesem Video'
        return { text: [`Video: ${src}`, `Titel: ${x.title}`, `Dauer: ${hms(x.duration)}`, `Chat: ${x.chat ? 'ja (fließt in video_highlights ein)' : 'nein'}`,
          ...(chapters.length ? [`Kapitel (${x.chapters.length}):`, ...chapters] : ['Kapitel: keine']), '', `Weiter: ${next}. Link als Quelle in die Notes.`].join('\n') }
      },
    }),
    tool({
      name: 'video_highlights',
      readOnly: true,
      description: 'Für lange Videos und Streams (ab ~10 min): findet die stärksten Momente aus Lautheit, Chat-Ausbrüchen (Chat aus import_video), Lachen und Jubel sowie der YouTube-Heatmap, ohne das ganze Video zu transkribieren. Liefert je Kandidat ein Zeitfenster mit Score und Grund. Läuft im Hintergrund: meldet das Tool „läuft noch“, rufe es gleich noch einmal mit demselben video auf. Danach nur die besten Fenster mit transcribe_video (from/to) transkribieren, video_frames als Kontaktabzug, dann Shorts oder Zusammenschnitt bauen. Ablauf: read_guide topic video.',
      inputSchema: z.object({ video: videoInput, overview: z.boolean().optional().describe('true = statt der Kandidaten eine Zeile je 90 s (Signale, Anfang des Gesagten): grober Überblick langer Videos') }),
      async run(i) {
        const { file, v } = videoFile(ctx, i.video)
        const missing = () => new Error('Die Highlight-Suche fehlt in dieser Deckwerk-Version. Stattdessen transcribe_video in Abschnitten (from/to) lesen.')
        if (i.overview) {
          let c = await v.cached?.(file)
          if (!c?.signals) { // Signale fehlen: erst die Highlight-Suche rechnen lassen, sie legt sie in den Cache
            if (!v.highlights) throw missing()
            const r = await job(`overview:${file}`, (onProgress) => v.highlights!(file, onProgress))
            if (!('value' in r)) return { text: stillRunning('Highlight-Suche', r.pct) }
            c = await v.cached?.(file)
          }
          const dur = c?.duration ?? (await v.probe(file)).duration
          return { text: [`Überblick über ${assetUrl(file)} (${hms(dur)}), eine Zeile je 90 s:`, ...overview(c?.transcript ?? null, c?.signals ?? null, dur), '', OVERVIEW_NEXT].join('\n') }
        }
        if (!v.highlights) throw missing()
        const r = await job(`highlights:${file}`, (onProgress) => v.highlights!(file, onProgress))
        if (!('value' in r)) return { text: stillRunning('Highlight-Suche', r.pct) }
        if (!r.value.length) return { text: `In ${assetUrl(file)} gibt es keine deutlichen Spitzen (Lautheit, Chat, Reaktionen). Stattdessen transcribe_video in Abschnitten (from/to) lesen und Momente nach Inhalt wählen.` }
        const de = (n: number) => n.toFixed(1).replace('.', ',')
        // from/to in Sekunden dahinter: die KI soll sie nicht aus h:mm:ss zurückrechnen
        const lines = r.value.map((h, k) => `${k + 1}. ${hms(h.start)}–${hms(h.end)} · Score ${de(h.score)} · ${h.why} · from=${Math.floor(h.start)} to=${Math.ceil(h.end)}`)
        return { text: [`${lines.length} Kandidaten in ${assetUrl(file)}, zeitlich sortiert:`, ...lines, '', HIGHLIGHT_NEXT].join('\n') }
      },
    }),
    tool({
      name: 'transcribe_video',
      readOnly: true,
      description: 'Transkribiert ein Video lokal (Parakeet für 25 europäische Sprachen; bei Sprachen außerhalb Europas, z. B. Japanisch, Türkisch, Arabisch, lang setzen – dann Whisper) und liefert je Segment eine Zeile „[s12] 61.2–66.8 Text“ (Sekunden im Video), mit speakers „[s12] S1 61.2–66.8 Text“. from/to bestimmen, welcher Bereich transkribiert und gezeigt wird; schon erkannte Stücke kommen aus dem Cache. Beim ersten Mal lädt Deckwerk das Sprachmodell (~670 MB); die Erkennung dauert auf schnellen Rechnern etwa die halbe Länge des Bereichs, auf langsamen auch länger als das Video – deshalb bei langen Videos nur die nötigen Bereiche transkribieren. Sie läuft im Hintergrund: meldet das Tool „läuft noch“, rufe es gleich noch einmal mit denselben Eingaben auf. Bereiche über 10 min (ohne from/to: das ganze Video) nur mit all: true (Fulltime-Schnitt), sonst erst video_highlights (overview: true), dann nur die Fenster transkribieren. Momente 4 × 0–25 bewerten (Hook: die ersten 2 s halten; Bogen bis zum Payoff; Wert; Teilbarkeit), nur ≥ 70 nehmen; steht für sich allein, Ende auf einem abgeschlossenen Satz. Schnitte nur an Segmentgrenzen (nie mitten im Satz), Füllsätze, Abschweifungen und die unter dem Transkript gelisteten Neuansätze (verworfene Anläufe) über mehrere parts herausschneiden. Abläufe für Short, ganzes Video, Stream und Kompilation: read_guide topic video.',
      inputSchema: z.object({
        video: videoInput,
        from: z.number().min(0).optional().describe('Bereich ab dieser Sekunde: nur er wird transkribiert und gezeigt (Highlight-Fenster, lange Transkripte seitenweise)'),
        to: z.number().min(0).optional().describe('Bereich bis zu dieser Sekunde'),
        lang: z.string().regex(/^[a-z]{2}$/).optional().describe('Sprache als ISO-639-1-Code (de, en, ja …). Weglassen = Parakeet, der nur die 25 europäischen Sprachen kennt; bei Sprachen außerhalb Europas (z. B. Japanisch, Türkisch, Arabisch) lang setzen – dann Whisper'),
        speakers: z.boolean().optional().describe('true = Sprecher unterscheiden (S1, S2 … je Zeile), für Podcasts, Interviews und Gespräche'),
        all: z.boolean().optional().describe('true = auch über 10 min, z. B. das ganze Video (nur für den Fulltime-Schnitt)'),
      }),
      async run(i) {
        const { file, v } = videoFile(ctx, i.video)
        if (i.from !== undefined && i.to !== undefined && i.to <= i.from) throw new Error('to muss nach from liegen.')
        if (!i.all) { // auch ein Bereich über 10 min (fehlendes to = Videoende) nur mit all
          const { duration } = await v.probe(file), whole = i.from === undefined && i.to === undefined
          const end = Math.min(i.to ?? duration, duration), span = end - (i.from ?? 0)
          if (span > LONG_VIDEO) return { text: `${whole ? 'Video' : `Bereich ${mmss(i.from ?? 0)}–${mmss(end)}`} ist ${mmss(span)} lang – erst video_highlights (overview: true), dann transcribe_video mit from/to der besten Fenster; das ganze Video nur für einen Fulltime-Schnitt mit all: true.` }
        }
        // Bereich und Optionen im Schlüssel: ein anderes Fenster ist eine andere Arbeit
        const r = await job(`transcribe:${file}:${JSON.stringify([i.from, i.to, i.lang, !!i.speakers])}`, async (onProgress) => {
          const info = await v.probe(file)
          const range = i.from === undefined && i.to === undefined ? undefined : { from: i.from ?? 0, to: Math.min(i.to ?? info.duration, info.duration) }
          if (range && range.from >= range.to) throw new Error(`from liegt hinter dem Ende des Videos (${mmss(info.duration)}).`)
          return [info, await v.transcribe(file, onProgress, { range, lang: i.lang, speakers: i.speakers })] as const
        })
        if (!('value' in r)) return { text: stillRunning('Transkription', r.pct) }
        const [info, t] = r.value
        const from = i.from ?? 0, to = i.to ?? Infinity, lines: string[] = []
        const all = transcriptLines(t).map((l, k) => { const sp = t.segments[k].speaker; return sp === undefined ? l : l.replace(/^\[s\d+\] /, (m) => `${m}S${sp + 1} `) })
        let size = 0, more = '', shownEnd = to
        for (const [k, s] of t.segments.entries()) {
          if (s.end <= from || s.start >= to) continue
          if ((size += all[k].length + 1) > TRANSCRIPT_MAX) { more = `… weiter mit from=${s.start.toFixed(1)}${i.to === undefined ? '' : ` und to=${i.to}`}`; shownEnd = s.start; break }
          lines.push(all[k])
        }
        const head = `Video: ${assetUrl(file)} · ${mmss(info.duration)} · ${info.w}×${info.h} · Sprache ${t.lang} · ${t.segments.length} Segmente`
        const rt = retakes(t).filter((x) => x.drop[1] > from && x.drop[0] < shownEnd)
        const retake = rt.length ? ['', 'Neuansätze (verworfene Anläufe – herausschneiden):', ...rt.slice(0, 20).map((x) => `${x.drop[0].toFixed(1)}–${x.drop[1].toFixed(1)} „${x.text}“ → neu ab ${x.keep.toFixed(1)}`), ...(rt.length > 20 ? [`… und ${rt.length - 20} weitere`] : [])] : []
        return { text: [head, ...lines, ...(lines.length ? [] : ['(keine Sprache in diesem Bereich)']), ...(more ? [more] : []), ...retake, '', VIDEO_NEXT].join('\n') }
      },
    }),
    tool({
      name: 'search_transcript',
      readOnly: true,
      description: 'Thema oder wörtliches Zitat im schon erkannten Transkript finden → Zeiten (from/to). Damit Zitate exakt treffen statt Zeiten zu raten.',
      inputSchema: z.object({
        video: videoInput,
        query: z.string().min(2).max(300).describe('Thema in Stichworten oder Zitat als Wortfolge'),
        n: z.number().int().min(1).max(20).optional().describe('höchstens so viele Treffer, Standard 8'),
      }),
      async run(i) {
        const { file, v } = videoFile(ctx, i.video)
        const t = (await v.cached?.(file))?.transcript
        if (!t) return { text: 'Noch kein Transkript – erst transcribe_video (bei langen Videos video_highlights overview: true).' }
        const hits = searchTranscript(t, i.query, i.n)
        if (!hits.length) return { text: `Keine Stelle zu „${i.query}“${t.covered ? ' in den transkribierten Bereichen' : ''}. Andere Stichworte oder ein kürzeres Zitat versuchen.` }
        const cut = (x: string) => (x.length > 160 ? x.slice(0, 159).trimEnd() + '…' : x)
        // from abrunden, to aufrunden (1 Nachkommastelle), damit kein Wort angeschnitten wird; 1e-6 gegen Rundungsrauschen
        const at = (h: (typeof hits)[number]) => `from=${(Math.floor(h.start * 10 + 1e-6) / 10).toFixed(1)} to=${(Math.ceil(h.end * 10 - 1e-6) / 10).toFixed(1)}`
        return { text: [`${hits.length} ${hits.length === 1 ? 'Stelle' : 'Stellen'} zu „${i.query}“ in ${assetUrl(file)}:`, ...hits.map((h) => `${mmss(h.start)}–${mmss(h.end)} · „${cut(h.text)}“ · ${at(h)}`)].join('\n') }
      },
    }),
    tool({
      name: 'video_frames',
      readOnly: true,
      description: 'Standbilder eines Videos (JPEG, 640 px breit) zu 1–12 Zeitpunkten. Zweck: Kontaktabzug der Kandidaten (4–8 Zeitpunkte je Moment): Szenenwechsel, schwache Bilder, Personen im Bild, Folien oder Gesten am Rand (dann fit blur). Ohne focus setzt der Export den Zuschnitt aufs Gesicht; focus je part (horizontale Bildmitte, 0 = links, 1 = rechts) nur setzen, wenn etwas anderes ins Bild muss. Zeiten hinter dem Ende gelten als Ende.',
      inputSchema: z.object({ video: videoInput, times: z.array(z.number().min(0)).min(1).max(12).describe('Sekunden im Video') }),
      async run(i) {
        const { file, v } = videoFile(ctx, i.video)
        const info = await v.probe(file)
        const times = i.times.map((t) => Math.min(t, Math.max(0, info.duration - 0.1))) // genau am Ende liefert ffmpeg kein Bild
        const images = await v.frames(file, times)
        const share = Math.round(100 * Math.min(1, (info.h * 9) / 16 / info.w))
        return {
          text: `${images.length} Standbilder aus ${assetUrl(file)} (${info.w}×${info.h}, ${mmss(info.duration)}), Reihenfolge wie die Bilder:\n${times.map((t, k) => `${k + 1}. ${t.toFixed(1)} s (${mmss(t)})`).join('\n')}\nEin 9:16-Short zeigt ${share} % der Bildbreite um focus: Gesicht und Gestik müssen drin bleiben. Wechselt die Szene innerhalb eines parts, den part dort teilen.`,
          images,
        }
      },
    }),
    tool({
      name: 'check_clip',
      description: 'Clip-Folie vor dem Export prüfen: volle Clip-Prüfung (auch Musik im Hintergrund) und Kontaktabzug (9 Bilder, zugeschnitten wie im Export). Nur für die besten Clips, höchstens 2 Runden.',
      inputSchema: z.object({ slide: z.string().describe('ID der clip-Folie') }),
      async run(i) {
        const deck = needDeck(ctx)
        const idx = indexOf(deck, i.slide), s = deck.slides[idx]
        if (s.layout !== 'clip') throw new Error(`Folie ${i.slide} ist keine clip-Folie (${s.layout}).`)
        if (!ctx.engine.video) throw new Error('Video-Funktionen gibt es nur in der Deckwerk-App und im MCP-Server.')
        const c = s.content as ClipContent, file = clipFile(c.video)
        // Musik nur hier frisch taggen (Sekunden der parts), synchron und deshalb nur bis 10 min; länger → Cache aus video_highlights. report() liest nur den Cache
        const fresh = file && partsLength(c.parts) <= LONG_VIDEO ? await ctx.engine.video.musicIn?.(file, c.parts).catch(() => []) : undefined
        const { issues, summary, music } = (await clipChecks(ctx, deck, [idx], fresh?.length ? fresh : undefined)).get(idx)!
        const head = `Folie ${idx + 1} (${s.id}, clip)${hid(s)}: ${summary}${issues.length ? `\n${fmtIssues(issues)}` : ' · Prüfung ohne Befund'}${music ? '' : '\nMusik nicht geprüft'}`
        if (!file || !statSync(file, { throwIfNoEntry: false })?.isFile())
          return { text: `${head}\nKein Kontaktabzug: ${file ? `Video nicht gefunden (${file})` : 'kein Video gesetzt'} – video mit update_slide setzen (asset://-Pfad aus dem Anhang).` }
        const { jpg, times } = await contactSheet(file, c.parts, { size: sizeOf(deck), fit: c.fit })
        const total = partsLength(c.parts) // Kachel k zeigt die Clipzeit (k + 0,5) · Länge / Anzahl, wie die Beschriftung im Bild
        const tiles = times.map((t, k) => `${k + 1}. ${(((k + 0.5) * total) / times.length).toFixed(1)} s = ${t.toFixed(1)} s`)
        return { text: [head, `Kontaktabzug 3×3, zeilenweise (Clipzeit = Quellzeit): ${tiles.join(', ')}`, CLIP_LOOK].join('\n'), images: [jpg] }
      },
    }),
    tool({
      name: 'find_music',
      description: 'Freie Hintergrundmusik für Video-Exporte suchen und laden (Openverse: nur CC0, Public Domain und CC BY). Nur auf Wunsch des Nutzers oder bei Kompilationen; dezent und instrumental, nie laut unter Sprache (das Ducking unter Sprache macht der Export). query = suchen, id = Titel aus der Trefferliste laden. Danach update_deck mit music: { src, credit }; den Nachweis zusätzlich in die Notes der letzten Folie.',
      inputSchema: z.object({
        query: z.string().min(2).max(80).optional().describe('englische Suchbegriffe: Stimmung, Genre, Instrument, z. B. "calm piano instrumental"'),
        id: z.string().max(64).optional().describe('Openverse-ID aus der Trefferliste: lädt diesen Titel'),
      }),
      async run(i) {
        if (i.id) {
          const { file, credit } = await fetchMusic(i.id, join(ctx.assetDir, 'music'))
          return { text: `Musik geladen. Weiter: update_deck mit music: ${JSON.stringify({ src: assetUrl(file), credit })} (volume weglassen = 0,25); den Nachweis zusätzlich in die Notes der letzten Folie.` }
        }
        if (!i.query) throw new Error('query (suchen) oder id (Titel aus der Trefferliste laden) angeben.')
        const hits = await findMusic(i.query)
        if (!hits.length) return { text: `Keine freie Musik zu "${i.query}". Andere englische Begriffe versuchen (Stimmung, Genre, "instrumental").` }
        const line = (t: (typeof hits)[number]) => [t.id, `„${t.title}“ – ${t.artist}`, t.duration ? mmss(t.duration) : 'Länge unbekannt', LICENSE[t.license], t.tags.join(', ')].filter(Boolean).join(' · ')
        return { text: `${hits.length} freie Titel (Openverse), zum Laden find_music mit id:\n${hits.map(line).join('\n')}` }
      },
    }),
    tool({
      name: 'remember',
      description: 'Dauerhafte Vorliebe des Nutzers in den Hausstil schreiben; gilt für alle künftigen Decks (Tonfall, Anrede, Farben, Dinge, die er nicht will). Nur bei ausdrücklichem Wunsch („merk dir …“, „immer …“, „nie …“) oder wenn er dieselbe Korrektur zum zweiten Mal verlangt. Ein kurzer Satz pro Aufruf.',
      inputSchema: z.object({ note: z.string().min(3).max(200) }),
      async run(i) {
        if (houseStyle().includes(i.note.trim())) return { text: 'Steht schon im Hausstil.' }
        mkdirSync(dirname(STYLE_FILE), { recursive: true })
        appendFileSync(STYLE_FILE, `- ${i.note.trim()}\n`)
        return { text: `Gemerkt (${STYLE_FILE}). Gilt ab jetzt für jedes Deck; sag dem Nutzer kurz Bescheid.` }
      },
    }),
    ...(ctx.storyline ? [tool({
      name: 'plan_storyline',
      description: 'Geplante Storyline zeigen: Action Title und Layout pro Folie, in Reihenfolge. Bei neuen Decks einmal vor add_slides aufrufen, bei größeren Umbauten erneut.',
      inputSchema: z.object({ slides: z.array(z.object({ title: z.string().max(120), layout: layoutId })).min(1).max(40) }),
      async run(i) {
        ctx.storyline!(i.slides)
        return { text: `Storyline mit ${i.slides.length} Folien angezeigt. Weiter mit create_deck bzw. add_slides.` }
      },
    })] : []),
    ...(ctx.ask ? [tool({
      name: 'ask_user',
      description: 'Rückfrage an den Nutzer mit 2–4 Antworten zum Anklicken (freie Antwort bleibt möglich). Eine Frage pro Turn; danach den Turn ohne weiteren Text beenden, die Antwort kommt als nächste Nachricht.',
      inputSchema: z.object({
        question: z.string().min(3).max(200),
        options: z.array(z.string().min(1).max(80)).min(2).max(4).describe('kurze, sich ausschließende Antworten'),
      }),
      async run(i) {
        ctx.ask!(i)
        return { text: 'Frage angezeigt. Beende jetzt den Turn und warte auf die Antwort.' }
      },
    })] : []),
  ] as ToolDef[]
}

// Unsplash: suchen, die besten `limit` Fotos (1080 px) nach assetDir laden, Download melden (API-Bedingung), Thumbs zurückgeben.
async function unsplash(ctx: ToolContext, query: string, limit: number, orientation = 'landscape'): Promise<ToolOutput> {
  const headers = { Authorization: `Client-ID ${imageSettings.unsplash || ctx.unsplashKey}`, 'Accept-Version': 'v1' }
  const get = (url: string) => fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  const res = await get(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${limit}&orientation=${orientation}&content_filter=high`)
  if (!res.ok) throw new Error(`Unsplash antwortet ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const hits = ((await res.json()) as { results: { id: string; width: number; height: number; alt_description?: string; description?: string; urls: { raw: string; small: string }; user: { name: string; links: { html: string } }; links: { download_location: string } }[] }).results
  if (!hits.length) return { text: `Unsplash hat nichts zu "${query}". Andere englische Begriffe versuchen.` }
  mkdirSync(ctx.assetDir, { recursive: true })
  const lines: string[] = [], images: Buffer[] = []
  for (const h of hits) {
    // 2560 px statt „regular“ (1080): Vollbildfotos werden mit 2560 px exportiert, so bleiben sie scharf
    const [full, thumb] = await Promise.all([get(`${h.urls.raw}&w=2560&q=82&fm=jpg`).then((r) => r.arrayBuffer()), get(h.urls.small).then((r) => r.arrayBuffer())])
    const file = join(ctx.assetDir, `unsplash-${h.id.replace(/[^\w-]/g, '')}.jpg`)
    writeFileSync(file, Buffer.from(full))
    get(h.links.download_location).catch(() => {}) // Unsplash-Richtlinie: Download zählen
    lines.push(`${assetUrl(file)} — 2560×${Math.round((2560 * h.height) / h.width)} px, ${h.alt_description ?? h.description ?? query} (Foto: ${h.user.name} / Unsplash, ${h.user.links.html})`)
    images.push(Buffer.from(thumb))
  }
  return { text: `${hits.length} Unsplash-Fotos geladen (Reihenfolge wie die Vorschaubilder). Bildnachweis in die Speaker Notes übernehmen:\n${lines.join('\n')}`, images }
}

// Bilder aus dem Netz laden: nur http(s), keine Adressen im eigenen Netz (die KI wählt die URL), nur Bilddateien, Größe begrenzt
const WEB_UA = { 'User-Agent': 'Deckwerk/0.1 (+https://github.com/Bavarianator/deckwerk)' }
// JPEG/PNG bevorzugt: der PPTX-Export (nativeImage) misst nur diese, CDNs liefern sonst gern WebP
const WEB_IMG = { ...WEB_UA, Accept: 'image/jpeg,image/png;q=0.9,image/*;q=0.5' }
const IMG_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }
async function download(url: string, maxMB = 15): Promise<{ buf: Buffer; ext: string }> {
  const u = new URL(url)
  if (!/^https?:$/.test(u.protocol)) throw new Error('Nur http(s)-Links.')
  // ponytail: prüft Hostnamen und Weiterleitungsziel nicht per DNS; reicht gegen versehentliche Zugriffe aufs eigene Netz
  if (/^(localhost|127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(u.hostname)) throw new Error('Adressen im eigenen Netz sind gesperrt.')
  const res = await fetch(u, { headers: WEB_IMG, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${u.hostname} antwortet ${res.status}.`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
  if (!IMG_EXT[type]) throw new Error(`Unter dem Link liegt kein Bild (${type || 'unbekannter Typ'}), sondern vermutlich eine Webseite. Die direkte Bildadresse nehmen.`)
  if (Number(res.headers.get('content-length')) > maxMB * 1e6) throw new Error(`Bild ist größer als ${maxMB} MB.`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > maxMB * 1e6) throw new Error(`Bild ist größer als ${maxMB} MB.`)
  return { buf, ext: IMG_EXT[type] }
}

// WebP-Maße aus dem Dateikopf (erweitert, verlustfrei, verlustbehaftet); null = kein WebP
// Serienbrief: je Zeile ein gefülltes Deck, seriell (ein Render-Fenster, wenig RAM) nach <outDir>/serie-<format>/NN-<erster Wert>
export async function exportSeries(engine: Engine, deck: Deck, rows: Record<string, string>[], format: ExportFormat, outDir: string, print?: PrintOptions): Promise<string[]> {
  const missing = placeholders(deck).filter((k) => rows.some((r) => !Object.hasOwn(r, k)))
  if (missing.length) throw new Error(`Spalten fehlen für Platzhalter: ${missing.map((k) => `{{${k}}}`).join(', ')}. Vorhanden: ${Object.keys(rows[0]).join(', ') || '–'}`)
  const dir = join(outDir, `serie-${format}`)
  await mkdir(dir, { recursive: true })
  // nur eigene Altlasten früherer Läufe entfernen, sonst mischen sich alte und neue Serie; fremde Dateien bleiben
  for (const e of await readdir(dir)) if (/^(\d{3}-|\d{3}$|\.tmp-)/.test(e)) await rm(join(dir, e), { recursive: true, force: true })
  const out: string[] = []
  for (const [n, row] of rows.entries()) {
    // Engine benennt nach dem Deck-Titel; daher in einen Zwischenordner exportieren und umbenennen
    const tmp = join(dir, `.tmp-${n}`)
    try {
      await mkdir(tmp, { recursive: true })
      await engine.exportDeck(fillDeck(deck, row), format, tmp, print)
      const name = [String(n + 1).padStart(3, '0'), Object.values(row)[0]?.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40)].filter(Boolean).join('-')
      for (const e of await readdir(tmp)) {
        const to = join(dir, name + extname(e))
        await rename(join(tmp, e), to)
        out.push(to)
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }
  return out
}

export function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
  if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 } }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  return null
}

// Pixelmaße aus dem Dateikopf (PNG, GIF, JPEG, WebP), ohne Electron; null = unbekannt (SVG, kaputt)
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: Segmente bis zum Frame-Kopf SOF0–SOF15 (ohne DHT C4, JPG C8, DAC CC)
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null
      const m = b[i + 1]
      if (m === 0xff) { i++; continue } // Füllbyte
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
      i += 2 + b.readUInt16BE(i + 2)
    }
    return null
  }
  return webpSize(b)
}

// Vorschau, die ins Modell passt: JPEG/PNG verkleinert nativeImage in Millisekunden; andere Formate (WebP) rendert die Engine,
// gleich in Vorschaugröße (in Originalgröße, mit Render-Zoom 3840 px, dauerte jede Offscreen-Aufnahme 30–40 s).
async function preview(ctx: ToolContext, img: Buffer, src: string, w0: number, h0: number, width = 768): Promise<Buffer[]> {
  if (ctx.previews === false) return []
  const thumb = ctx.engine.thumbnail?.(img, width)
  if (thumb) return [thumb]
  const w = Math.round(width / 2), h = Math.round((w * h0) / w0) // Render-Zoom 2 → genau `width` Pixel breit
  try {
    return await ctx.engine.renderPng({ title: '', theme: ctx.getDeck()?.theme ?? { id: THEME_IDS[0] }, transition: 'none', mode: 'click', size: { w, h },
      slides: [{ id: 'bild', layout: 'blank', content: {}, items: [{ id: 'bild', kind: 'image', src, x: 0, y: 0, w, h }] }] }, [0], width)
  } catch (e) {
    console.warn('[tools] Bildvorschau übersprungen:', (e as Error).message)
    return []
  }
}

// Eigene Bilder (auch Unterordner wie import-*/ aus dem Quellmaterial): Maße für die Trefferzeile, SVG/AVIF ohne lesbare Pixelmaße
export const IMG_FILE = /\.(png|jpe?g|gif|webp|svg|avif)$/i
function dims(buf: Buffer, file: string): { label: string; w: number; h: number } {
  const s = imageSize(buf)
  if (!s) return { label: extname(file).slice(1).toUpperCase(), w: 1600, h: 1000 }
  const r = s.width / s.height
  return { label: `${s.width}×${s.height} px, ${r > 1.1 ? 'quer' : r < 0.9 ? 'hoch' : 'quadratisch'}`, w: s.width, h: s.height }
}

// Bild aus dem Asset-Ordner ansehen, ohne es zu kopieren; die KI wählt den Pfad, deshalb nur dort und nur Bilddateien
async function fromAsset(ctx: ToolContext, url: string): Promise<ToolOutput> {
  const file = resolve(decodeURIComponent(new URL(url).pathname))
  if (!IMG_FILE.test(file) || !file.startsWith(resolve(ctx.assetDir) + sep)) throw new Error(`Nur Bilder aus dem Asset-Ordner (${ctx.assetDir}) lassen sich ansehen.`)
  const buf = readFileSync(file), d = dims(buf, file), src = assetUrl(file)
  return { text: `Bild: ${src} — ${d.label}
Als Logo: update_deck mit brand (logo = dieser Pfad; vorhandene Brand-Felder mitgeben, sonst gehen die Farben verloren); es steht dann nur auf Titel- und Schlussfolie (A4: Seite 1), nie auf jeder Folie. Als Foto oder Abbildung: image.src, image.focus nach der Vorschau.`, images: await preview(ctx, buf, src, d.w, d.h, 640) }
}

// Lokale Treffer (neueste zuerst): die ersten `limit` mit Vorschau und Maßen, der Rest nur als Pfad, höchstens 30 Zeilen
async function localImages(ctx: ToolContext, files: string[], limit: number): Promise<ToolOutput> {
  if (!files.length) return { text: `Keine passenden Bilder in ${ctx.assetDir}.` }
  const lines: string[] = [], images: Buffer[] = []
  for (const [n, file] of files.slice(0, 30).entries()) {
    const src = assetUrl(file)
    if (n >= limit) { lines.push(src); continue }
    const buf = readFileSync(file), d = dims(buf, file)
    images.push(...(await preview(ctx, buf, src, d.w, d.h, 512)))
    lines.push(`${src} — ${d.label}`)
  }
  const more = files.length > 30 ? `\n… und ${files.length - 30} weitere, query eingrenzen` : ''
  return { text: `${files.length} eigene Bilder, neueste zuerst (die ersten ${Math.min(limit, files.length)} mit Vorschau, gleiche Reihenfolge):\n${lines.join('\n')}${more}`, images }
}

async function fromUrl(ctx: ToolContext, url: string): Promise<ToolOutput> {
  const { buf, ext } = await download(url)
  mkdirSync(ctx.assetDir, { recursive: true })
  const file = join(ctx.assetDir, `web-${randomBytes(4).toString('hex')}.${ext}`)
  writeFileSync(file, buf)
  const src = assetUrl(file)
  return { text: `Bild übernommen: ${src}
Quelle in die Notes: ${url}`, images: await preview(ctx, buf, src, 1600, 1000, 640) }
}

// Openverse: freie Bilder (Wikimedia Commons, Flickr …) ohne API-Key. Nur Lizenzen, die Nutzung und Zuschnitt erlauben;
// CC BY/BY-SA verlangen den Bildnachweis, deshalb steht er in der Antwort für die Notes.
const LICENSE: Record<string, string> = { cc0: 'CC0', pdm: 'Public Domain', by: 'CC BY', 'by-sa': 'CC BY-SA' }
// Wikimedia liefert Originale bis 5000 px: das 1920er-Thumbnail (offizielles URL-Schema) hält Decks klein
const wikiThumb = (url: string, w = 0) => {
  const m = w > 1920 && url.match(/^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/(\w\/\w\w)\/([^/]+\.jpe?g)$/i)
  return m ? `${m[1]}/thumb/${m[2]}/${m[3]}/1920px-${m[3]}` : url
}
async function openverse(ctx: ToolContext, query: string, limit: number, orientation = 'landscape'): Promise<ToolOutput> {
  const aspect = ({ landscape: 'wide', portrait: 'tall', squarish: 'square' } as Record<string, string>)[orientation] ?? 'wide'
  const res = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${limit * 3}&license=cc0,pdm,by,by-sa&extension=jpg,png&size=large&aspect_ratio=${aspect}&mature=false`,
    { headers: WEB_UA, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`Openverse antwortet ${res.status}: ${(await res.text()).slice(0, 200)}`)
  type Hit = { id: string; url: string; width?: number; height?: number; title?: string; creator?: string; license: string; license_version?: string; foreign_landing_url: string; source: string }
  const hits = ((await res.json()) as { results: Hit[] }).results.filter((h) => (h.width ?? 0) >= 1200 && LICENSE[h.license])
  mkdirSync(ctx.assetDir, { recursive: true })
  const lines: string[] = [], images: Buffer[] = []
  for (const h of hits) {
    if (lines.length >= limit) break
    const got = await download(wikiThumb(h.url, h.width)).catch(() => download(h.url)).catch(() => null) // tote Links überspringen
    if (!got || !['jpg', 'png'].includes(got.ext)) continue // manche CDNs liefern trotz Filter WebP
    const file = join(ctx.assetDir, `web-${h.id.replace(/[^\w-]/g, '').slice(0, 12)}.${got.ext}`)
    writeFileSync(file, got.buf)
    const w = Math.min(h.width!, 1920), hh = Math.round((w * (h.height ?? h.width! * 0.66)) / h.width!)
    const src = assetUrl(file)
    images.push(...(await preview(ctx, got.buf, src, w, hh, 512)))
    lines.push(`${src} — ${w}×${hh} px, ${h.title ?? query} (Foto: ${h.creator ?? 'unbekannt'} / ${h.source}, ${LICENSE[h.license]}${h.license_version ? ` ${h.license_version}` : ''}, ${h.foreign_landing_url})`)
  }
  if (!lines.length) return { text: `Im Netz (Openverse) nichts Passendes zu "${query}". Andere englische Begriffe versuchen oder generate_image.` }
  return { text: `${lines.length} freie Fotos aus dem Netz geladen (Reihenfolge wie die Vorschaubilder). Bildnachweis mit Lizenz in die Speaker Notes übernehmen:\n${lines.join('\n')}`, images }
}

// KI-Bilder: Mammouth (LiteLLM-Proxy) und OpenAI sprechen dieselbe Images-API; Codex erzeugt sie mit dem ChatGPT-Login über sein
// eingebautes image_gen. Einstellungen aus der App (Einstellungen → Bilder, image-settings.ts) haben Vorrang, sonst gilt die Umgebung;
// beides wird erst beim Aufruf gelesen.
export const IMAGE_PROVIDERS = ['mammouth', 'openai', 'codex'] as const
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number]
export const imageSettings: { mammouth?: string; openai?: string; unsplash?: string; provider?: ImageProvider; model?: string } = {}
const IMAGE_API = {
  mammouth: { url: 'https://api.mammouth.ai/v1', env: 'MAMMOUTH_API_KEY' },
  openai: { url: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY' },
}
export const IMAGE_SIZE = { landscape: { w: 1536, h: 1024 }, portrait: { w: 1024, h: 1536 }, square: { w: 1024, h: 1024 } }
export type Orientation = keyof typeof IMAGE_SIZE
const IMAGE_CHECK = 'Vorschau prüfen: Passt das Motiv zur Aussage der Folie? Sind Hände, Gesichter und Perspektive fehlerfrei, ist die Fläche für den Titel ruhig, passt der Stil zu den anderen Bildern? Wenn nicht, den Prompt gezielt ändern; nach zwei Fehlversuchen die Folie ohne Bild bauen. Sonst image.src setzen, focus nach der Vorschau wählen, die Folie mit render_slides ansehen und in die Notes „Bild: KI-generiert. Stil: <Stilsatz>“ schreiben (beim ersten KI-Bild des Decks, damit spätere Bilder dazu passen).'

// Codex nacheinander: codexImage nimmt das neueste Bild im gemeinsamen Ordner, parallel wäre es das falsche
let codexQueue: Promise<Buffer> = Promise.resolve(Buffer.alloc(0))

export const NO_IMAGE_AI = 'Keine Bild-KI eingerichtet (Einstellungen → Bilder: Mammouth- oder OpenAI-Key, oder Codex installieren).'

// Bild erzeugen und unter assetDir ablegen, ohne Tool-Kontext (auch für die UI, image:generate). null = kein Anbieter eingerichtet
export async function makeImage(prompt: string, orientation: Orientation, assetDir: string, provider?: ImageProvider): Promise<{ file: string; buf: Buffer; via: string } | null> {
  const keyOf = (p: keyof typeof IMAGE_API) => imageSettings[p] || process.env[IMAGE_API[p].env]
  const ready = (p: ImageProvider) => (p === 'codex' ? !!findCli('codex') : !!keyOf(p))
  const p = provider ?? imageSettings.provider ?? IMAGE_PROVIDERS.find(ready)
  if (!p) return null
  if (!ready(p)) throw new Error(`${p} ist nicht eingerichtet. Verfügbar: ${IMAGE_PROVIDERS.filter(ready).join(', ') || 'keiner'}`)
  const model = imageSettings.model || process.env.IMAGE_MODEL || 'gpt-image-2'
  const buf = p === 'codex' ? await (codexQueue = codexQueue.catch(() => {}).then(() => codexImage(prompt, orientation))) : await apiImage(p, keyOf(p)!, model, prompt, orientation)
  mkdirSync(assetDir, { recursive: true })
  const ext = buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.subarray(8, 12).toString() === 'WEBP' ? 'webp' : 'png'
  const file = join(assetDir, `ki-${Date.now().toString(36)}${randomBytes(2).toString('hex')}.${ext}`)
  writeFileSync(file, buf)
  return { file, buf, via: p === 'codex' ? 'Codex' : `${p} · ${model}` }
}

async function generateImage(ctx: ToolContext, prompt: string, orientation: Orientation, provider?: ImageProvider): Promise<ToolOutput> {
  const img = await makeImage(prompt, orientation, ctx.assetDir, provider)
  if (!img) return { text: `${NO_IMAGE_AI} Stattdessen find_images nutzen oder den Nutzer um ein Bild bitten.` }
  const src = assetUrl(img.file)
  const { w, h } = IMAGE_SIZE[orientation]
  const images = await preview(ctx, img.buf, src, w, h) // Codex liefert PNGs mit mehreren MB
  return { text: `Bild erzeugt (${img.via}): ${src}\n${IMAGE_CHECK}`, images }
}

async function apiImage(p: keyof typeof IMAGE_API, key: string, model: string, prompt: string, orientation: Orientation): Promise<Buffer> {
  const { w, h } = IMAGE_SIZE[orientation]
  const res = await fetch(`${IMAGE_API[p].url}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, n: 1, size: `${w}x${h}` }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`${p} antwortet ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const d = ((await res.json()) as { data?: { b64_json?: string; url?: string }[] }).data?.[0]
  if (d?.b64_json) return Buffer.from(d.b64_json, 'base64')
  if (d?.url) return Buffer.from(await (await fetch(d.url, { signal: AbortSignal.timeout(60_000) })).arrayBuffer()) // DALL·E-artige Anbieter liefern eine URL
  throw new Error(`${p} hat kein Bild geliefert.`)
}

// Codex headless wie im Chat (claude-agent.ts): nur das Bildwerkzeug, keine Shell, Sandbox nur lesen. Das Bild legt Codex selbst
// unter $CODEX_HOME/generated_images ab.
// ponytail: nimmt das neueste Bild dort seit dem Start; erzeugt ein paralleles Codex gleichzeitig Bilder, kann es das falsche sein
function codexImage(prompt: string, orientation: Orientation): Promise<Buffer> {
  const dir = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'generated_images')
  const start = Date.now()
  return new Promise((ok, fail) => {
    const child = execFile(findCli('codex')!, ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'hooks', '--enable', 'image_generation',
      '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', '-c', 'model_reasoning_effort="low"', '-'],
    { timeout: 240_000, maxBuffer: 20e6 }, (e, _out, err) => {
      let files: string[] = []
      try { files = (readdirSync(dir, { recursive: true }) as string[]).map((f) => join(dir, f)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && statSync(f).mtimeMs >= start) } catch {}
      const newest = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
      if (newest) return ok(readFileSync(newest))
      const why = `${err}\n${e?.message ?? ''}`
      fail(new Error(/401|Unauthorized|not logged in/i.test(why) ? 'Codex ist nicht angemeldet. Einmal im Terminal `codex login` ausführen.' : `Codex hat kein Bild erzeugt${e ? `: ${why.trim().split('\n').pop()}` : ''}`))
    })
    child.stdin?.end(`Generate exactly one image with your built-in image generation tool, ${orientation} (${IMAGE_SIZE[orientation].w}x${IMAGE_SIZE[orientation].h}). Do nothing else and write no files. Image description:\n${prompt}`)
  })
}

// Katalogschriften kompakt (nur Namen, nach Art): ohne gebündelte und ohne markierte (Standard generierter Designs, sehr verbreitet)
function catalogFonts(): string {
  const cats: Record<FontCat, string> = { grotesk: 'Grotesk', humanist: 'Humanistisch', geometric: 'Geometrisch', condensed: 'Condensed', serif: 'Serif', 'display-serif': 'Display-Serif', slab: 'Slab', mono: 'Mono' }
  return (Object.keys(cats) as FontCat[]).map((c) => `${cats[c]}: ${FONT_CATALOG.filter((f) => f.cat === c && !f.flag && !(f.family in FONTS)).map((f) => f.family + (f.role === 'head' ? '*' : '')).join(', ')}`).join(' · ')
}

// Layout-Katalog für den Systemprompt: id, wann, Varianten, Default-Build, JSON-Schema. Stabil → Prompt-Caching.
export function buildCatalog(): string {
  const layouts = LAYOUT_IDS.map((id) => {
    const L = LAYOUTS[id]
    const { $schema: _, ...schema } = z.toJSONSchema(L.schema) as Record<string, unknown>
    return [
      `### ${L.id} – ${L.name}`,
      `Wann: ${L.when}`,
      L.variants?.length ? `Varianten: ${L.variants.join(', ')}` : null,
      L.frames?.length ? `Frames: top, ${L.frames.join(', ')}` : null,
      (L as { sizes?: FormatId[] }).sizes ? `Nur im Format: ${(L as { sizes?: FormatId[] }).sizes!.join(', ')} (create_deck format)` : null,
      `Default-Build: ${L.defaultBuild}`,
      `Schema: ${JSON.stringify(schema)}`,
    ].filter(Boolean).join('\n')
  })
  return [
    '## Layout-Katalog',
    'Du setzt nie Koordinaten. Du wählst ein Layout und füllst seine Felder nach dem Schema; die Engine misst, passt Schriftgrößen an und meldet Probleme zurück.',
    'Ausnahme: freie Elemente (`items` in add_slides/update_slide: Text, Form, Bild, Icon, Diagramm mit x/y/w/h in px auf 1280×720, Drehung, Deckkraft). Nur auf Layout blank oder wenn der Nutzer ausdrücklich frei gestaltet bzw. ein Element „wie in Canva“ platziert haben will. Mindestens 48 px Rand, Text ab 20 px, prüfe das Ergebnis mit render_slides. get_deck zeigt vorhandene items mit IDs.',
    ...layouts,
    '## Themes',
    'Entwirf für jedes Deck ein eigenes Design (create_deck.customTheme) nach Design-Guide §6: Farbe, Schriftpaar und Struktur (titleSize, titleWeight, rule, sectionTone, sparsam Feinschliff wie signature, margin, heroTone) aus Thema, Branche und Anlass. Der Theme-Lint lehnt Klischees mit konkreter Korrektur ab. Die Katalog-Themes sind erprobte Vorbilder dafür und die Wahl, wenn es schnell gehen soll (Feinschliff per `tune`): beratung (hell, Daten, Chef-Update), keynote (dunkel, Plakat-Titel), schweiz (streng, Kopflinie), redaktion (Serif regular, Kopflinie), zen (dunkel, Serif, fotolastig). Nur im Stil mutig: plakat (Signalgelb, Black-Titel), magazin (Papier, riesige Serif, Mono-Labels), neomono (Off-Black, Signalorange, Plex, Mono-Labels), pastell (Lavendel, rund, freundlich). Die Engine leitet Flächen, Ränder, Sekundärtext und Diagrammfarben ab, dämpft den Grund und sichert Kontraste.',
    'Schriften (Premium-Schriften werden in die PPTX eingebettet):',
    FONT_NAMES.map((f) => `- ${f}: ${FONT_MOOD[f]}`).join('\n'),
    `Dazu Familien aus dem Schriftkatalog für headFont, bodyFont, fonts, brand und freie Texte (lädt die Engine bei Bedarf und bettet sie ein, offline gilt ein ähnlicher gebündelter Ersatz; * = nur Titel): ${catalogFonts()}`,
    'Katalog-Themes:',
    CATALOG_THEMES.map((t) => `- ${t.id}: ${t.name}${t.dark ? ' (dunkel)' : ''}${t.mutig ? ' (nur Stil mutig)' : ''}`).join('\n'),
    '## Folien-Ton und Dekor',
    'Pro Folie optional `tone`: normal | accent (Akzentfläche, Standard bei section) | invert (Hell/Dunkel getauscht). Für Rhythmus: Kapiteltrenner, Kernaussage oder den Höhepunkt des Decks auf accent/invert setzen, höchstens jede 3.–4. Folie. `decor` wählt das Hintergrundmotiv (none, blobs, glow, rings, grid, stripe, dots); Standard kommt vom Theme (none). Motive nur auf ausdrücklichen Wunsch.',
    '## Animationen',
    `Builds: ${BUILDS.join(', ')} · Übergänge: ${TRANSITIONS.join(', ')}. Ein Übergangstyp pro Deck (create_deck/update_deck); \`transition\` an einer Folie nur für morph (Design-Guide §8). Die Rückmeldung zu jeder Folie nennt Übergang, Aufbau und Klicks.`,
  ].join('\n\n')
}
