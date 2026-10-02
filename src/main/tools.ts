// Die 12 KI-Tools, SDK-frei: DeckAgent (agent.ts) und MCP-Server hängen an derselben Definition.
// Fehler werfen ein Error mit konkreter Meldung; der Aufrufer macht daraus is_error / isError.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { icons } from 'lucide-react'
import { BUILDS, DECORS, FORMATS, FRAMES, MOTIONS, sizeOf, TONES, TRANSITIONS, transitionOf, type Deck, type Measured, type FormatId, type FrameId, type Item, type Slide } from '../shared/deck'
import { GRAPHICS, itemSchema, newId, resizeDeck } from '../shared/items'
import { LAYOUTS, LAYOUT_IDS, buildOf, type LayoutId } from '../shared/layouts'
import { CATALOG_THEMES, FONT_NAMES, THEMES, resolveTheme, type FontName } from '../shared/themes'
import type { Issue } from '../shared/lint'
import type { Engine } from './agent'
import { findCli } from './claude-agent' // dieselbe Suche wie für den Chat (der Mac-Fork patcht sie)

export interface ToolContext {
  engine: Engine
  getDeck(): Deck | null
  setDeck(deck: Deck): void // einziger Schreibpfad (UI-Update, Persistenz)
  assetDir: string // eigene Bilder für find_images; Unsplash-Downloads landen auch hier
  outDir: string // Exportziel
  unsplashKey?: string // Unsplash Access Key; ohne Key sucht find_images nur lokal
  ask?(q: { question: string; options: string[] }): void // nur im App-Chat: Rückfrage mit Antwort-Buttons
  storyline?(slides: { title: string; layout: string }[]): void // nur im App-Chat: geplante Folien für die Entstehen-Ansicht
  choice?(c: { question: string; options: { label: string; image: string }[] }): void // nur im App-Chat: Auswahl-Karten (image = PNG als data:-URL)
}
// Hausstil (Canva „Memory Library“): Vorlieben des Nutzers für alle Decks, von Hand oder per remember gepflegt
export const STYLE_FILE = join(homedir(), 'Deckwerk', 'hausstil.md')
export const houseStyle = () => { try { return readFileSync(STYLE_FILE, 'utf8').trim() } catch { return '' } }

export interface ToolOutput { text: string; images?: Buffer[] } // PNG oder JPEG, siehe mimeOf
export const mimeOf = (b: Buffer): 'image/png' | 'image/jpeg' => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : 'image/png')
export const assetUrl = (abs: string) => `asset://local${pathToFileURL(abs).pathname}` // Format wie ipc.ts
// Relative Bildpfade im Deck (z. B. "assets/foto.jpg" in examples/) gegen den Ordner der JSON-Datei auflösen
export function localizeDeck(deck: Deck, dir: string): Deck {
  const walk = (o: any): void => {
    for (const k of Object.keys(o ?? {})) {
      const v = o[k]
      if ((k === 'src' || k === 'image' || k === 'poster') && typeof v === 'string' && v && !/^(asset|data|file|https?):/.test(v)) o[k] = assetUrl(resolve(dir, v))
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
const slideTransition = z.enum(TRANSITIONS).describe('Übergang zu dieser Folie; weglassen = Deck-Übergang. Praktisch nur für morph: wörtlich gleicher Text, dasselbe Foto oder derselbe Platz im Layout wandert von der vorigen Folie herüber (Design-Guide §8)')
const brand = z.object({
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Markenfarbe #RRGGBB'),
  secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logo: z.string().optional().describe('Pfad zum Logo (aus find_images)'),
  headFont: z.enum(FONT_NAMES as [FontName, ...FontName[]]).optional().describe('Headline-Schrift; Office: Arial, Calibri, Georgia; Premium (eingebettet): alle übrigen, siehe customTheme.headFont'),
})
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const deckStyle = z.enum(['sachlich', 'mutig']).describe('Gestaltungsstil (Design-Guide §6 „Stil des Decks“): sachlich = Zurückhaltung (Standard), mutig = kräftige Farben, Plakat-Typo, mehr Farbflächen, markante Bilder. Wählt der Nutzer im Look-Bereich oder per Wunsch („mutiger“).')
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
}
// Standardschriften generierter Designs: nur auf ausdrücklichen Wunsch, nie in eigenen Vorschlägen (propose_looks)
const AI_FONTS: string[] = ['Space Grotesk', 'Instrument Serif']
const themeSpec = z.object({
  name: z.string().min(2).max(40).describe('Name, z. B. "Nordlicht Finance"'),
  bg: hexColor.describe('Hintergrund: fast weiß oder fast schwarz, höchstens leicht in Richtung der Akzentfarbe getönt (die Engine dämpft alles andere)'),
  text: hexColor.optional().describe('Textfarbe; weglassen = automatisch passend'),
  accent: hexColor.describe('Hauptakzent mit Charakter (Zahlen, Hervorhebungen, Akzentflächen); wird bei Bedarf für Kontrast nachgedunkelt/aufgehellt'),
  accent2: hexColor.optional().describe('Zweitfarbe für Vergleichsserien und Duotone; weglassen = neutrales Grau (empfohlen: eine Akzentfarbe reicht)'),
  headFont: z.enum(FONT_NAMES as [FontName, ...FontName[]]).describe('Titelschrift'),
  bodyFont: z.enum(FONT_NAMES as [FontName, ...FontName[]]).describe('Textschrift (Sans empfohlen)'),
  radius: z.number().int().min(0).max(28).describe('Eckenradius in px: 0–4 empfohlen; über 8 wirkt es schnell generiert'),
  decor: z.enum(DECORS).describe('Hintergrundmotiv; none empfohlen. blobs/glow (unscharfe Farbkreise) nur auf ausdrücklichen Wunsch'),
  texture: z.enum(['grain']).optional().describe('feine Papierkörnung, nur auf Wunsch'),
  titleSize: z.enum(['normal', 'large']).optional().describe('large = Plakat-Titel (Vortrag, Swiss, Editorial); normal = sachlich (Chef-Update, viele Daten)'),
  titleWeight: z.enum(['regular', 'bold']).optional().describe('regular wirkt edel und redaktionell (am besten mit Serif und titleSize large), bold sachlich und kräftig'),
  rule: z.enum(['none', 'over', 'under']).optional().describe('feine Linie: over = Kopflinie über dem Titel (Swiss, Redaktion), under = Trennlinie unter dem Kopf (Beratung), none = pur'),
  sectionTone: z.enum(TONES).optional().describe('Kapiteltrenner: accent = Akzentfläche (Standard), invert = Hell/Dunkel getauscht, normal = nur große Typo auf dem Grund'),
  vivid: z.boolean().optional().describe('nur im Stil mutig: bg als kräftiger Farbgrund übernehmen (z. B. Signalgelb, Tiefblau, Ziegelrot) statt ihn auf fast Weiß/Schwarz zu dämpfen; Textfarbe kommt automatisch mit Kontrast'),
})

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

// Validiert content gegen das Layout-Schema. Wirft mit konkretem Hinweis.
// Unbekannte Felder (z. B. „kicker“ statt „eyebrow“) würde zod still verwerfen; der Inhalt fehlte dann ohne Meldung.
export function validateContent(layout: string, content: unknown, where: string): Record<string, unknown> {
  const def = LAYOUTS[layout as LayoutId]
  if (!def) throw new Error(`${where}: Unbekanntes Layout "${layout}". Erlaubt: ${LAYOUT_IDS.join(', ')}`)
  const r = def.schema.safeParse(content)
  const json = z.toJSONSchema(def.schema) as JsonSchema
  const stray = [...new Set(strayKeys(json, content, ''))]
  if (r.success && !stray.length) return r.data as Record<string, unknown>
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

function fmtIssues(issues: Issue[]): string {
  return issues.map((i) => `  - [${i.severity}] ${i.rule}${i.slot ? ` @${i.slot}` : ''}: ${i.message}`).join('\n')
}

// Autofit + Lint für die Folien an `indices` – die Rückmeldung, mit der die KI korrigiert.
async function report(ctx: ToolContext, deck: Deck, indices: number[]): Promise<string> {
  let measured: Awaited<ReturnType<Engine['measure']>>, issues: Issue[]
  try {
    ;[measured, issues] = await Promise.all([ctx.engine.measure(deck, indices), ctx.engine.lint(deck)])
  } catch (e) {
    // Das Deck ist schon gespeichert: nicht als Tool-Fehler melden, sonst wiederholt die KI die Änderung
    return `Gespeichert (Folien ${indices.map((i) => i + 1).join(', ')}), aber die Messung ist fehlgeschlagen: ${(e as Error).message}. Später lint_deck aufrufen.`
  }
  return indices
    .map((i, k) => {
      const s = deck.slides[i]
      const m = measured[k]
      const own = issues.filter((x) => x.slide === i)
      const errors = own.filter((x) => x.severity === 'error').length
      const fit = m ? `Autofit head ${m.fit.head}/body ${m.fit.body}${m.fit.ok ? '' : ', Überlauf: ' + m.fit.overflow.map((o) => `${o.slot} +${Math.round(o.overPx)}px (${o.kind})`).join(', ')}` : 'nicht gemessen'
      const head = `Folie ${i + 1} (${s.id}, ${s.layout}): ${errors ? `${errors} FEHLER` : 'OK'} · ${fit}${m ? ` · ${motionOf(deck, i, m)}` : ''}`
      return own.length ? `${head}\n${fmtIssues(own)}` : head
    })
    .join('\n')
}

// Ablauf beim Präsentieren in Worten, damit die KI Animationen beurteilen kann, ohne sie zu sehen
function motionOf(deck: Deck, i: number, m: Measured): string {
  const preset = buildOf(deck, i)
  const groups = new Set(m.els.flatMap((e) => (e.build === undefined ? [] : [e.build]))).size
  const clicks = deck.mode === 'click' ? (preset === 'list' ? groups : 0) + m.els.filter((e) => e.anim && e.anim !== 'none' && e.anim !== 'breathe').length : 0
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

export function buildTools(ctx: ToolContext): ToolDef[] {
  return [
    tool({
      name: 'create_deck',
      description: 'Neues Deck anlegen (ersetzt ein vorhandenes). Briefing, Theme oder Brand-Kit, Titel.',
      inputSchema: z.object({
        title: z.string().max(80),
        brief: z.object({ audience: z.string().max(120), goal: z.string().max(200), tone: z.string().max(60) }).optional(),
        theme: z.enum(THEME_IDS).default(THEME_IDS[0]).describe('Katalog-Theme; wird ignoriert, wenn customTheme gesetzt ist'),
        customTheme: themeSpec.optional().describe('Eigenes Design für genau dieses Deck (Standard). Vorgehen und Regeln im Design-Guide §6'),
        brand: brand.optional(),
        transition: z.enum(TRANSITIONS).default('fade'),
        mode: z.enum(['click', 'auto']).default('click').describe('click = Vortrag (Builds per Klick), auto = Selbstlauf'),
        motion: z.enum(MOTIONS).optional().describe('Bewegungsstil wie Canva „Magic Animate“: none = keine Aufbauten, calm = nur Einblenden (Vorstand, Behörde), standard = Layout-Standard, lively = Karten nacheinander, Zahlen zoomen, Fotos mit Foto-Zoom (Pitch, Event)'),
        style: deckStyle.optional(),
        format: format.optional().describe('Folienformat; weglassen = 16:9-Präsentation'),
      }),
      async run(i) {
        const deck: Deck = { title: i.title, brief: i.brief, theme: { id: i.customTheme ? 'custom' : i.theme, brand: i.brand, custom: i.customTheme }, transition: i.transition, mode: i.mode, motion: i.motion === 'standard' ? undefined : i.motion, style: i.style === 'mutig' ? 'mutig' : undefined, slides: [], ...(i.format && i.format !== '16:9' && { size: { w: FORMATS[i.format].w, h: FORMATS[i.format].h } }) }
        ctx.setDeck(deck)
        return { text: `Deck "${deck.title}" angelegt (Theme ${deck.theme.custom ? `eigenes: ${deck.theme.custom.name}` : deck.theme.id}, Übergang ${deck.transition}, Modus ${deck.mode}, Stil ${deck.style ?? 'sachlich'}). ${PREVIEW_HINT}`, images: await themePreview(ctx, deck) }
      },
    }),
    tool({
      name: 'update_deck',
      description: 'Titel, Theme, Brand-Kit, Übergang, Modus oder Briefing des Decks ändern.',
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
        fonts: z.tuple([z.enum(FONT_NAMES as [FontName, ...FontName[]]), z.enum(FONT_NAMES as [FontName, ...FontName[]])]).nullable().optional().describe('Schriftpaar [Titel, Text] über das Theme legen; null = Theme-Schriften'),
        format: format.optional().describe('Magic Resize: Deck in ein anderes Format bringen; freie Elemente werden mitskaliert, Layouts ordnen sich neu an. Danach render_overview prüfen.'),
      }),
      async run(i) {
        const deck = needDeck(ctx)
        if (i.title) deck.title = i.title
        if (i.brief) deck.brief = { ...deck.brief, ...i.brief }
        if (i.theme) { deck.theme.id = i.theme; delete deck.theme.custom }
        if (i.customTheme === null) { delete deck.theme.custom; if (deck.theme.id === 'custom') deck.theme.id = THEME_IDS[0] }
        else if (i.customTheme) {
          const merged = { ...deck.theme.custom, ...i.customTheme }
          const r = themeSpec.safeParse(merged)
          if (!r.success) throw new Error(`customTheme unvollständig: ${z.prettifyError(r.error)}\nBeim ersten Setzen alle Pflichtfelder angeben.`)
          deck.theme.custom = r.data
          deck.theme.id = 'custom'
        }
        if (i.brand !== undefined) deck.theme.brand = i.brand ?? undefined
        if (i.transition) deck.transition = i.transition
        if (i.mode) deck.mode = i.mode
        if (i.motion) deck.motion = i.motion === 'standard' ? undefined : i.motion
        if (i.style) deck.style = i.style === 'mutig' ? 'mutig' : undefined
        if (i.shuffle !== undefined) deck.theme.shuffle = i.shuffle || undefined
        if (i.fonts !== undefined) deck.theme.fonts = i.fonts ?? undefined
        if (i.format) Object.assign(deck, resizeDeck(deck, i.format))
        ctx.setDeck(deck)
        const look = i.theme || i.customTheme || i.brand !== undefined || i.shuffle !== undefined || i.fonts !== undefined // Theme geändert → neue Vorschau
        return {
          text: `Deck aktualisiert: ${JSON.stringify({ title: deck.title, theme: deck.theme, transition: deck.transition, mode: deck.mode, style: deck.style ?? 'sachlich' })}${look ? `\n${PREVIEW_HINT}` : ''}`,
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
          id: '', layout: s.layout, variant: s.variant, build: s.build, transition: s.transition, tone: s.tone, decor: s.decor, frame: (checkFrame(s.layout, s.frame, `slides[${k}]`), s.frame), notes: s.notes, items: withIds(s.items as Item[]), bg: s.bg,
          content: validateContent(s.layout, s.content, `slides[${k}]`),
        }))
        for (const s of fresh) { s.id = newSlideId(deck); deck.slides.push(s) } // push nur für die ID-Vergabe
        deck.slides.splice(-fresh.length, fresh.length)
        const at = Math.min(i.at ?? deck.slides.length, deck.slides.length)
        deck.slides.splice(at, 0, ...fresh)
        ctx.setDeck(deck)
        return { text: await report(ctx, deck, fresh.map((_, k) => at + k)) }
      },
    }),
    tool({
      name: 'update_slide',
      description: 'Eine Folie ändern: Inhalt (Patch, wird mit dem Bestand gemischt), Layout, Variante, Build, Notes. Gibt Autofit und Lint zurück.',
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
        if (i.notes !== undefined) s.notes = i.notes ?? undefined
        if (i.items !== undefined) s.items = withIds((i.items ?? undefined) as Item[] | undefined)
        if (i.bg !== undefined) s.bg = i.bg ?? undefined
        ctx.setDeck(deck)
        return { text: await report(ctx, deck, [idx]) }
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
        return { text: `Neue Reihenfolge: ${deck.slides.map((s, k) => `${k + 1}:${s.layout}`).join(' ')}` }
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
        return { text: idx.map((k) => `Folie ${k + 1} (${deck.slides[k].id}, ${deck.slides[k].layout})`).join('\n'), images: bufs }
      },
    }),
    tool({
      name: 'propose_looks',
      description: 'Zwei bis drei deutlich verschiedene Looks zur Auswahl rendern (je Cover, Kennzahlen, Diagramm, Kapiteltrenner). Für neue Decks, vor create_deck. Der Nutzer wählt; danach create_deck mit genau diesem customTheme bzw. Katalog-Theme.',
      inputSchema: z.object({ looks: z.array(z.union([z.enum(CATALOG_THEMES.map((t) => t.id) as [string, ...string[]]), themeSpec])).min(2).max(3).describe('Eigene Entwürfe für dieses Thema (Design-Guide §6): einer hell und sachlich, einer dunkel oder plakativ; sie unterscheiden sich in Struktur (Serif/Sans, titleSize, rule, sectionTone), nicht nur in der Farbe. Ein Katalog-Theme als dritter Look ist erlaubt.') }),
      async run(i) {
        const title = ctx.getDeck()?.title ?? 'Vorschau'
        const refs = i.looks.map((l) => (typeof l === 'string' ? { id: l } : { id: 'custom', custom: l }))
        const tell = i.looks.flatMap((l) => (typeof l === 'string' ? [] : [l.headFont, l.bodyFont])).find((f) => AI_FONTS.includes(f))
        if (tell) throw new Error(`${tell} ist eine Standardschrift generierter Designs und gehört nicht in eigene Vorschläge. Andere Schrift wählen (Design-Guide §6); hat der Nutzer sie ausdrücklich gewünscht, direkt create_deck mit diesem customTheme.`)
        // Guide §6: Entwürfe unterscheiden sich in der Struktur, sonst sieht der Nutzer nur Umfärbungen desselben Looks
        const traits = refs.map((r) => { const t = resolveTheme(r); return { 'hell/dunkel': t.dark, 'Serif/Sans': !!t.head.serif, titleSize: (t.headScale ?? 1) > 1, titleWeight: t.head.weight, rule: t.rule ?? 'none', sectionTone: t.sectionTone ?? 'accent', Farbgrund: !!t.vivid } })
        for (let a = 0; a < traits.length; a++)
          for (let b = a + 1; b < traits.length; b++) {
            const same = Object.keys(traits[a]).filter((k) => traits[a][k as keyof (typeof traits)[0]] === traits[b][k as keyof (typeof traits)[0]])
            if (same.length > 3) throw new Error(`Look ${a + 1} und ${b + 1} unterscheiden sich kaum, gleich sind: ${same.join(', ')}. Ändere bei einem mindestens ${same.length - 3} davon, damit der Nutzer echte Alternativen sieht.`)
          }
        const images = (await Promise.all(refs.map((theme) => themePreview(ctx, { title, theme, transition: 'fade', mode: 'click', slides: [] })))).map((b) => b[0])
        if (images.some((b) => !b)) throw new Error('Vorschau fehlgeschlagen, bitte einzeln mit create_deck prüfen.')
        const label = (l: (typeof i.looks)[number]) => (typeof l === 'string' ? CATALOG_THEMES.find((t) => t.id === l)!.name : l.name)
        const names = i.looks.map((l, k) => `${k + 1}. ${label(l)}`).join('\n')
        if (!ctx.choice) return { text: `Looks (Bilder in dieser Reihenfolge):\n${names}\nZeig dem Nutzer die Namen und frag, welchen er möchte.`, images }
        ctx.choice({ question: 'Welcher Look soll es werden?', options: i.looks.map((l, k) => ({ label: label(l), image: `data:${mimeOf(images[k])};base64,${images[k].toString('base64')}` })) })
        return { text: `Looks zur Auswahl angezeigt:\n${names}\nBeende jetzt den Turn ohne weiteren Text; die Wahl kommt als nächste Nachricht (Name des Looks).`, images }
      },
    }),
    tool({
      name: 'render_overview',
      description: 'Kontaktbogen aller Folien als ein Bild – der Art-Director-Blick auf Rhythmus, Konsistenz und Dichte.',
      inputSchema: z.object({}),
      async run() {
        const deck = needDeck(ctx)
        if (!deck.slides.length) throw new Error('Das Deck hat noch keine Folien.')
        return { text: `Kontaktbogen: ${deck.slides.length} Folien, Reihenfolge ${deck.slides.map((s) => s.layout).join(' → ')}\n${ART_DIRECTOR}`, images: [await ctx.engine.renderOverview(deck)] }
      },
    }),
    tool({
      name: 'lint_deck',
      description: 'Alle Probleme des Decks (Fehler müssen weg, Warnungen sind Ermessen).',
      inputSchema: z.object({}),
      async run() {
        const deck = needDeck(ctx)
        const issues = await ctx.engine.lint(deck)
        const e = issues.filter((x) => x.severity === 'error').length
        if (!issues.length) return { text: 'Keine Probleme. Das Deck ist sauber.' }
        return { text: `${e} Fehler, ${issues.length - e} Warnungen:\n` + issues.map((x) => `  - Folie ${x.slide + 1} (${x.slideId}) [${x.severity}] ${x.rule}${x.slot ? ` @${x.slot}` : ''}: ${x.message}`).join('\n') }
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
      description: 'Bilder finden: eigene Dateien im Asset-Ordner, Fotos aus dem Netz (Unsplash mit Key, sonst Openverse: freie Bilder von Wikimedia Commons, Flickr u. a., ohne Key) oder ein Bild direkt per `url` (Link vom Nutzer oder aus der Websuche). Treffer werden heruntergeladen und als Vorschau mitgeliefert. Rückgabe: asset://-Pfade für `image.src`, mit Maßen, Lizenz und Bildnachweis für die Notes. Setze `image.focus` nach dem Vorschaubild (wo Gesicht oder Motiv sitzt), wenn es nicht mittig ist.',
      inputSchema: z.object({
        query: z.string().max(80).optional().describe('lokal: Teil des Dateinamens; Netz: englische Suchbegriffe, z. B. "teacher classroom"'),
        source: z.enum(['auto', 'local', 'unsplash', 'web']).default('auto').describe('auto = lokal, ohne lokalen Treffer aus dem Netz (Unsplash, sonst Openverse); web = Openverse'),
        url: z.string().url().max(2000).optional().describe('Bild direkt von dieser Adresse übernehmen. Nur Bilder, die der Nutzer genannt hat oder die verwendet werden dürfen (freie Lizenz, eigene Website); Quelle in die Notes'),
        limit: z.number().int().min(1).max(5).default(3),
        orientation: z.enum(['landscape', 'portrait', 'squarish']).default('landscape').describe('Unsplash: landscape für Vollbild/Cover/Galerie, portrait für Porträts (quote), squarish für Kacheln'),
      }),
      async run(i) {
        if (i.url) return fromUrl(ctx, i.url)
        const q = i.query?.toLowerCase()
        let local: string[] = []
        try { local = readdirSync(ctx.assetDir).filter((f) => /\.(png|jpe?g|svg|webp)$/i.test(f) && (!q || f.toLowerCase().includes(q))).map((f) => assetUrl(join(ctx.assetDir, f))) } catch {}
        if (i.source === 'local' || (i.source === 'auto' && local.length)) return { text: local.length ? local.join('\n') : `Keine passenden Bilder in ${ctx.assetDir}.` }
        if (!i.query) return { text: `${local.length ? '' : 'Keine lokalen Bilder. '}Für Fotos aus dem Netz eine englische query angeben.` }
        if (i.source === 'unsplash' && !ctx.unsplashKey) throw new Error('Unsplash ist nicht konfiguriert (UNSPLASH_ACCESS_KEY fehlt). source "web" sucht ohne Key.')
        return i.source !== 'web' && ctx.unsplashKey ? unsplash(ctx, i.query, i.limit, i.orientation) : openverse(ctx, i.query, i.limit, i.orientation)
      },
    }),
    tool({
      name: 'generate_image',
      readOnly: true, // ein Bild dauert 1–2 min; nacheinander wurden aus 4 Bildern über 6 min
      description: 'Bild per KI erzeugen (Szene, Stimmung, Illustration, ruhige Bildfläche), wenn find_images nichts Passendes liefert oder der Nutzer es will. Dauert 20–120 s und kostet: alle Bilder des Plans in einer Antwort gleichzeitig anfordern (sie laufen parallel), erst einen Bildplan machen (2–5 Schlüsselfolien wie Cover, Kapitelwechsel, Höhepunkt, Abschluss) und einen Stilsatz, der wörtlich an jeden Prompt kommt. Nie für echte Personen, Logos, Marken, echte Produkte oder Orte des Nutzers (das wären Fälschungen), Diagramme oder Text. Kein KI-Look (Neon, Roboter, Glühbirnen, glänzendes 3D). Regeln im Design-Guide §6 „KI-Bilder“. Rückgabe: asset://-Pfad für `image.src` plus Vorschau.',
      inputSchema: z.object({
        prompt: z.string().min(10).max(1500).describe('Englisch, in dieser Reihenfolge: Motiv und Handlung, Umgebung, Ausschnitt mit ruhiger Fläche für den Titel (z. B. "subject on the right, calm empty left half"), Licht und Stimmung, Stilsatz des Decks mit Theme-Farben als Wort plus Hex, zum Schluss "no text, no letters, no logos, no watermark". Konkrete Szene statt abstraktem Begriff.'),
        orientation: z.enum(['landscape', 'portrait', 'square']).default('landscape').describe('landscape für cover, photo, closing und gallery; square für image-text, section und big-number; portrait selten'),
        provider: z.enum(IMAGE_PROVIDERS).optional().describe('nur auf Wunsch des Nutzers; weglassen = der erste eingerichtete (Mammouth, OpenAI, Codex)'),
      }),
      async run(i) {
        return generateImage(ctx, i.prompt, i.orientation, i.provider)
      },
    }),
    tool({
      name: 'export_deck',
      description: 'Deck exportieren: pptx (editierbar, mit Animationen), pdf (pixelgenau), png (eine Datei pro Folie) oder md (Handout: Titel, Inhalte, Notizen).',
      inputSchema: z.object({ format: z.enum(['pptx', 'pdf', 'png', 'md']) }),
      async run(i) {
        const deck = needDeck(ctx)
        if (!deck.slides.length) throw new Error('Das Deck hat noch keine Folien.')
        const paths = await ctx.engine.exportDeck(deck, i.format, ctx.outDir)
        return { text: `Exportiert (${i.format}):\n${paths.join('\n')}` }
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
  const headers = { Authorization: `Client-ID ${ctx.unsplashKey}`, 'Accept-Version': 'v1' }
  const get = (url: string) => fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  const res = await get(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${limit}&orientation=${orientation}&content_filter=high`)
  if (!res.ok) throw new Error(`Unsplash antwortet ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const hits = ((await res.json()) as { results: { id: string; width: number; height: number; alt_description?: string; description?: string; urls: { raw: string; small: string }; user: { name: string; links: { html: string } }; links: { download_location: string } }[] }).results
  if (!hits.length) return { text: `Unsplash hat nichts zu "${query}". Andere englische Begriffe versuchen.` }
  mkdirSync(ctx.assetDir, { recursive: true })
  const lines: string[] = [], images: Buffer[] = []
  for (const h of hits) {
    // 1920 px statt „regular“ (1080): Vollbildfotos werden mit 2560 px exportiert
    const [full, thumb] = await Promise.all([get(`${h.urls.raw}&w=1920&q=82&fm=jpg`).then((r) => r.arrayBuffer()), get(h.urls.small).then((r) => r.arrayBuffer())])
    const file = join(ctx.assetDir, `unsplash-${h.id.replace(/[^\w-]/g, '')}.jpg`)
    writeFileSync(file, Buffer.from(full))
    get(h.links.download_location).catch(() => {}) // Unsplash-Richtlinie: Download zählen
    lines.push(`${assetUrl(file)} — 1920×${Math.round((1920 * h.height) / h.width)} px, ${h.alt_description ?? h.description ?? query} (Foto: ${h.user.name} / Unsplash, ${h.user.links.html})`)
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
export function webpSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null
  const chunk = b.toString('latin1', 12, 16)
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) }
  if (chunk === 'VP8L') { const v = b.readUInt32LE(21); return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 } }
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
  return null
}

// Vorschau, die ins Modell passt: JPEG/PNG verkleinert nativeImage in Millisekunden; andere Formate (WebP) rendert die Engine,
// gleich in Vorschaugröße (in Originalgröße, mit Render-Zoom 3840 px, dauerte jede Offscreen-Aufnahme 30–40 s).
async function preview(ctx: ToolContext, img: Buffer, src: string, w0: number, h0: number, width = 768): Promise<Buffer[]> {
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
// eingebautes image_gen. Einstellungen aus der App (Einrichtung → Bilder, image-settings.ts) haben Vorrang, sonst gilt die Umgebung;
// beides wird erst beim Aufruf gelesen.
export const IMAGE_PROVIDERS = ['mammouth', 'openai', 'codex'] as const
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number]
export const imageSettings: { mammouth?: string; openai?: string; provider?: ImageProvider; model?: string } = {}
const IMAGE_API = {
  mammouth: { url: 'https://api.mammouth.ai/v1', env: 'MAMMOUTH_API_KEY' },
  openai: { url: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY' },
}
const IMAGE_SIZE = { landscape: { w: 1536, h: 1024 }, portrait: { w: 1024, h: 1536 }, square: { w: 1024, h: 1024 } }
type Orientation = keyof typeof IMAGE_SIZE
const IMAGE_CHECK = 'Vorschau prüfen: Passt das Motiv zur Aussage der Folie? Sind Hände, Gesichter und Perspektive fehlerfrei, ist die Fläche für den Titel ruhig, passt der Stil zu den anderen Bildern? Wenn nicht, den Prompt gezielt ändern; nach zwei Fehlversuchen die Folie ohne Bild bauen. Sonst image.src setzen, focus nach der Vorschau wählen, die Folie mit render_slides ansehen und in die Notes „Bild: KI-generiert. Stil: <Stilsatz>“ schreiben (beim ersten KI-Bild des Decks, damit spätere Bilder dazu passen).'

// Codex nacheinander: codexImage nimmt das neueste Bild im gemeinsamen Ordner, parallel wäre es das falsche
let codexQueue: Promise<Buffer> = Promise.resolve(Buffer.alloc(0))

async function generateImage(ctx: ToolContext, prompt: string, orientation: Orientation, provider?: ImageProvider): Promise<ToolOutput> {
  const keyOf = (p: keyof typeof IMAGE_API) => imageSettings[p] || process.env[IMAGE_API[p].env]
  const ready = (p: ImageProvider) => (p === 'codex' ? !!findCli('codex') : !!keyOf(p))
  const p = provider ?? imageSettings.provider ?? IMAGE_PROVIDERS.find(ready)
  if (!p) return { text: 'Keine Bild-KI eingerichtet (Einrichtung → Bilder: Mammouth- oder OpenAI-Key, oder Codex installieren). Stattdessen find_images nutzen oder den Nutzer um ein Bild bitten.' }
  if (!ready(p)) throw new Error(`${p} ist nicht eingerichtet. Verfügbar: ${IMAGE_PROVIDERS.filter(ready).join(', ') || 'keiner'}`)
  const model = imageSettings.model || process.env.IMAGE_MODEL || 'gpt-image-2'
  const buf = p === 'codex' ? await (codexQueue = codexQueue.catch(() => {}).then(() => codexImage(prompt, orientation))) : await apiImage(p, keyOf(p)!, model, prompt, orientation)
  mkdirSync(ctx.assetDir, { recursive: true })
  const ext = buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg' : buf.subarray(8, 12).toString() === 'WEBP' ? 'webp' : 'png'
  const file = join(ctx.assetDir, `ki-${Date.now().toString(36)}${randomBytes(2).toString('hex')}.${ext}`)
  writeFileSync(file, buf)
  const src = assetUrl(file)
  const { w, h } = IMAGE_SIZE[orientation]
  const images = await preview(ctx, buf, src, w, h) // Codex liefert PNGs mit mehreren MB
  return { text: `Bild erzeugt (${p === 'codex' ? 'Codex' : `${p} · ${model}`}): ${src}\n${IMAGE_CHECK}`, images }
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
    'Entwirf für jedes Deck ein eigenes Design (create_deck.customTheme) nach Design-Guide §6: Farbe, Schriftpaar und Struktur (titleSize, titleWeight, rule, sectionTone) aus Thema, Branche und Anlass. Die Katalog-Themes sind erprobte Vorbilder dafür und die Wahl, wenn es schnell gehen soll: beratung (hell, Daten, Chef-Update), keynote (dunkel, Plakat-Titel), schweiz (streng, Kopflinie), redaktion (Serif regular, Kopflinie), zen (dunkel, Serif, fotolastig). Die Engine leitet Flächen, Ränder, Sekundärtext und Diagrammfarben ab, dämpft den Grund und sichert Kontraste.',
    'Schriften (Premium-Schriften werden in die PPTX eingebettet):',
    FONT_NAMES.map((f) => `- ${f}: ${FONT_MOOD[f]}`).join('\n'),
    'Katalog-Themes:',
    CATALOG_THEMES.map((t) => `- ${t.id}: ${t.name}${t.dark ? ' (dunkel)' : ''}`).join('\n'),
    '## Folien-Ton und Dekor',
    'Pro Folie optional `tone`: normal | accent (Akzentfläche, Standard bei section) | invert (Hell/Dunkel getauscht). Für Rhythmus: Kapiteltrenner, Kernaussage oder den Höhepunkt des Decks auf accent/invert setzen, höchstens jede 3.–4. Folie. `decor` wählt das Hintergrundmotiv (none, blobs, glow, rings, grid, stripe, dots); Standard kommt vom Theme (none). Motive nur auf ausdrücklichen Wunsch.',
    '## Animationen',
    `Builds: ${BUILDS.join(', ')} · Übergänge: ${TRANSITIONS.join(', ')}. Ein Übergangstyp pro Deck (create_deck/update_deck); \`transition\` an einer Folie nur für morph (Design-Guide §8). Die Rückmeldung zu jeder Folie nennt Übergang, Aufbau und Klicks.`,
  ].join('\n\n')
}
