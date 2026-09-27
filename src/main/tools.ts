// Die 12 KI-Tools, SDK-frei: DeckAgent (agent.ts) und MCP-Server hängen an derselben Definition.
// Fehler werfen ein Error mit konkreter Meldung; der Aufrufer macht daraus is_error / isError.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { icons } from 'lucide-react'
import { BUILDS, DECORS, FORMATS, FRAMES, MOTIONS, sizeOf, TONES, TRANSITIONS, type Deck, type FormatId, type FrameId, type Item, type Slide } from '../shared/deck'
import { GRAPHICS, itemSchema, newId, resizeDeck } from '../shared/items'
import { LAYOUTS, LAYOUT_IDS, type LayoutId } from '../shared/layouts'
import { FONT_NAMES, THEMES, resolveTheme, type FontName } from '../shared/themes'
import type { Issue } from '../shared/lint'
import type { Engine } from './agent'

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
export interface ToolOutput { text: string; images?: Buffer[] } // PNG oder JPEG, siehe mimeOf
export const mimeOf = (b: Buffer): 'image/png' | 'image/jpeg' => (b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : 'image/png')
export const assetUrl = (abs: string) => `asset://local${pathToFileURL(abs).pathname}` // Format wie ipc.ts
export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  inputSchema: S
  run(input: z.infer<S>): Promise<ToolOutput>
}

const format = z.enum(Object.keys(FORMATS) as [FormatId, ...FormatId[]]).describe(Object.entries(FORMATS).map(([k, f]) => `${k} = ${f.name} (${f.w}×${f.h})`).join(', '))
const THEME_IDS = THEMES.map((t) => t.id) as [string, ...string[]]
const layoutId = z.enum(LAYOUT_IDS as [LayoutId, ...LayoutId[]])
const build = z.enum(BUILDS).describe('Animations-Preset; weglassen = Default des Layouts')
const brand = z.object({
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe('Markenfarbe #RRGGBB'),
  secondary: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logo: z.string().optional().describe('Pfad zum Logo (aus find_images)'),
  headFont: z.enum(FONT_NAMES as [FontName, ...FontName[]]).optional().describe('Headline-Schrift; Office: Arial, Calibri, Georgia; Premium (eingebettet): alle übrigen, siehe customTheme.headFont'),
})
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)
// Zeichen jeder Schrift, damit die KI Paare nach Stimmung wählt
const FONT_MOOD: Record<FontName, string> = {
  Fraunces: 'warme Display-Serif mit Charakter: editorial, Magazin, Handwerk, Kultur',
  'DM Serif Display': 'elegante, kontrastreiche Serif (nur ein Schnitt): Luxus, Premium, ruhig',
  'Space Grotesk': 'markante technische Grotesk: Tech, Startup, Daten, große Zahlen',
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
  'Instrument Serif': 'schmale, elegante Display-Serif (nur ein Schnitt): Design, Architektur, Premium',
  Archivo: 'kräftige, sachliche Grotesk: Industrie, Logistik, Sport, klare Ansagen',
}
const themeSpec = z.object({
  name: z.string().min(2).max(40).describe('Name, z. B. "Nordlicht Finance"'),
  bg: hexColor.describe('Hintergrund: sehr hell (Weiß, Creme, zartes Pastell) oder sehr dunkel (Nachtblau, Anthrazit, Tannengrün). Keine mittleren Töne.'),
  text: hexColor.optional().describe('Textfarbe; weglassen = automatisch passend'),
  accent: hexColor.describe('Hauptakzent mit Charakter (Zahlen, Hervorhebungen, Akzentflächen); wird bei Bedarf für Kontrast nachgedunkelt/aufgehellt'),
  accent2: hexColor.optional().describe('Zweitakzent für Diagramme, Verläufe, Duotone; weglassen = Komplementärton'),
  headFont: z.enum(FONT_NAMES as [FontName, ...FontName[]]).describe('Titelschrift'),
  bodyFont: z.enum(FONT_NAMES as [FontName, ...FontName[]]).describe('Textschrift (Sans empfohlen)'),
  radius: z.number().int().min(0).max(28).describe('Eckenradius in px: 0 = streng/edel, 6–12 = sachlich, 16–24 = freundlich/verspielt'),
  decor: z.enum(DECORS).describe('Hintergrundmotiv: blobs = weich, glow = Tech/Nacht, rings = editorial, grid = technisch, stripe = streng/edel, dots = verspielt, none = pur'),
  texture: z.enum(['grain']).optional().describe('feine Papierkörnung für warme, editoriale Themes'),
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
export function validateContent(layout: string, content: unknown, where: string): Record<string, unknown> {
  const def = LAYOUTS[layout as LayoutId]
  if (!def) throw new Error(`${where}: Unbekanntes Layout "${layout}". Erlaubt: ${LAYOUT_IDS.join(', ')}`)
  const r = def.schema.safeParse(content)
  if (!r.success) throw new Error(`${where} (${layout}): Inhalt ungültig.\n${z.prettifyError(r.error)}\nKürzen oder Folie teilen, dann erneut senden.`)
  return r.data as Record<string, unknown>
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
      const head = `Folie ${i + 1} (${s.id}, ${s.layout}): ${errors ? `${errors} FEHLER` : 'OK'} · ${fit}`
      return own.length ? `${head}\n${fmtIssues(own)}` : head
    })
    .join('\n')
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
        customTheme: themeSpec.optional().describe('Eigenes Theme passend zu Thema, Branche und Publikum (empfohlen, damit jedes Deck eigenständig aussieht)'),
        brand: brand.optional(),
        transition: z.enum(TRANSITIONS).default('fade'),
        mode: z.enum(['click', 'auto']).default('click').describe('click = Vortrag (Builds per Klick), auto = Selbstlauf'),
        motion: z.enum(MOTIONS).optional().describe('Bewegungsstil wie Canva „Magic Animate“: calm = nur Einblenden (Vorstand, Behörde), standard = Layout-Standard, lively = Karten nacheinander, Zahlen zoomen (Pitch, Event)'),
        format: format.optional().describe('Folienformat; weglassen = 16:9-Präsentation'),
      }),
      async run(i) {
        const deck: Deck = { title: i.title, brief: i.brief, theme: { id: i.customTheme ? 'custom' : i.theme, brand: i.brand, custom: i.customTheme }, transition: i.transition, mode: i.mode, motion: i.motion === 'standard' ? undefined : i.motion, slides: [], ...(i.format && i.format !== '16:9' && { size: { w: FORMATS[i.format].w, h: FORMATS[i.format].h } }) }
        ctx.setDeck(deck)
        return { text: `Deck "${deck.title}" angelegt (Theme ${deck.theme.custom ? `eigenes: ${deck.theme.custom.name}` : deck.theme.id}, Übergang ${deck.transition}, Modus ${deck.mode}). ${PREVIEW_HINT}`, images: await themePreview(ctx, deck) }
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
        motion: z.enum(MOTIONS).optional().describe('Bewegungsstil wie Canva „Magic Animate“: calm = nur Einblenden (Vorstand, Behörde), standard = Layout-Standard, lively = Karten nacheinander, Zahlen zoomen (Pitch, Event)'),
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
        if (i.shuffle !== undefined) deck.theme.shuffle = i.shuffle || undefined
        if (i.fonts !== undefined) deck.theme.fonts = i.fonts ?? undefined
        if (i.format) Object.assign(deck, resizeDeck(deck, i.format))
        ctx.setDeck(deck)
        const look = i.theme || i.customTheme || i.brand !== undefined || i.shuffle !== undefined || i.fonts !== undefined // Theme geändert → neue Vorschau
        return {
          text: `Deck aktualisiert: ${JSON.stringify({ title: deck.title, theme: deck.theme, transition: deck.transition, mode: deck.mode })}${look ? `\n${PREVIEW_HINT}` : ''}`,
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
          id: '', layout: s.layout, variant: s.variant, build: s.build, tone: s.tone, decor: s.decor, frame: (checkFrame(s.layout, s.frame, `slides[${k}]`), s.frame), notes: s.notes, items: withIds(s.items as Item[]), bg: s.bg,
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
      description: 'Canva-Akzent auf eine Layout-Folie setzen, ohne Koordinaten: Sticker, Form oder Icon in einer freien Ecke. Die Engine sucht dort freien Platz, der nichts überdeckt. Höchstens ein Akzent pro Folie, nur auf luftigen Folien (cover, statement, section, big-number, quote, closing).',
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
      description: 'Zwei bis drei deutlich verschiedene eigene Themes zur Auswahl rendern (je Cover, Kennzahlen, Diagramm, Kapiteltrenner). Für neue Decks ohne feste Markenvorgabe, vor create_deck. Der Nutzer wählt; danach create_deck bzw. update_deck mit genau diesem customTheme.',
      inputSchema: z.object({ looks: z.array(themeSpec).min(2).max(3).describe('verschiedene Design-Richtungen, nicht nur andere Akzentfarbe; mindestens einer frei für genau dieses Thema entworfen statt aus der Richtungstabelle') }),
      async run(i) {
        const title = ctx.getDeck()?.title ?? 'Vorschau'
        const images = (await Promise.all(i.looks.map((custom) => themePreview(ctx, { title, theme: { id: 'custom', custom }, transition: 'fade', mode: 'click', slides: [] })))).map((b) => b[0])
        if (images.some((b) => !b)) throw new Error('Vorschau fehlgeschlagen, bitte einzeln mit create_deck prüfen.')
        const names = i.looks.map((l, k) => `${k + 1}. ${l.name}`).join('\n')
        if (!ctx.choice) return { text: `Looks (Bilder in dieser Reihenfolge):\n${names}\nZeig dem Nutzer die Namen und frag, welchen er möchte.`, images }
        ctx.choice({ question: 'Welcher Look soll es werden?', options: i.looks.map((l, k) => ({ label: l.name, image: `data:${mimeOf(images[k])};base64,${images[k].toString('base64')}` })) })
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
      description: 'Bilder finden: eigene Dateien im Asset-Ordner und (wenn konfiguriert) Unsplash-Fotos. Unsplash-Treffer werden heruntergeladen und als Vorschau mitgeliefert. Rückgabe: asset://-Pfade für `image.src`, mit Maßen und Bildnachweis für die Notes. Setze `image.focus` nach dem Vorschaubild (wo Gesicht oder Motiv sitzt), wenn es nicht mittig ist.',
      inputSchema: z.object({
        query: z.string().max(80).optional().describe('lokal: Teil des Dateinamens; Unsplash: englische Suchbegriffe, z. B. "teacher classroom"'),
        source: z.enum(['auto', 'local', 'unsplash']).default('auto').describe('auto = lokal, bei Treffern ohne Ergebnis Unsplash'),
        limit: z.number().int().min(1).max(5).default(3),
        orientation: z.enum(['landscape', 'portrait', 'squarish']).default('landscape').describe('Unsplash: landscape für Vollbild/Cover/Galerie, portrait für Porträts (quote), squarish für Kacheln'),
      }),
      async run(i) {
        const q = i.query?.toLowerCase()
        let local: string[] = []
        try { local = readdirSync(ctx.assetDir).filter((f) => /\.(png|jpe?g|svg|webp)$/i.test(f) && (!q || f.toLowerCase().includes(q))).map((f) => assetUrl(join(ctx.assetDir, f))) } catch {}
        if (i.source === 'local' || (i.source === 'auto' && local.length)) return { text: local.length ? local.join('\n') : `Keine passenden Bilder in ${ctx.assetDir}.` }
        if (!ctx.unsplashKey) return { text: `${local.length ? '' : 'Keine lokalen Bilder. '}Unsplash ist nicht konfiguriert (UNSPLASH_ACCESS_KEY fehlt). Bild leer lassen ("") oder den Nutzer um ein Bild bitten.` }
        if (!i.query) throw new Error('Für Unsplash braucht find_images eine query.')
        return unsplash(ctx, i.query, i.limit, i.orientation)
      },
    }),
    tool({
      name: 'export_deck',
      description: 'Deck exportieren: pptx (editierbar, mit Animationen), pdf (pixelgenau) oder png (eine Datei pro Folie).',
      inputSchema: z.object({ format: z.enum(['pptx', 'pdf', 'png']) }),
      async run(i) {
        const deck = needDeck(ctx)
        if (!deck.slides.length) throw new Error('Das Deck hat noch keine Folien.')
        const paths = await ctx.engine.exportDeck(deck, i.format, ctx.outDir)
        return { text: `Exportiert (${i.format}):\n${paths.join('\n')}` }
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
    const file = join(ctx.assetDir, `unsplash-${h.id}.jpg`)
    writeFileSync(file, Buffer.from(full))
    get(h.links.download_location).catch(() => {}) // Unsplash-Richtlinie: Download zählen
    lines.push(`${assetUrl(file)} — 1920×${Math.round((1920 * h.height) / h.width)} px, ${h.alt_description ?? h.description ?? query} (Foto: ${h.user.name} / Unsplash, ${h.user.links.html})`)
    images.push(Buffer.from(thumb))
  }
  return { text: `${hits.length} Unsplash-Fotos geladen (Reihenfolge wie die Vorschaubilder). Bildnachweis in die Speaker Notes übernehmen:\n${lines.join('\n')}`, images }
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
    'Entwirf für jedes Deck ein eigenes Theme (create_deck.customTheme), passend zu Thema, Branche, Marke und Publikum – sonst sehen alle Decks gleich aus. Die Engine leitet Flächen, Ränder, Sekundärtext und Diagrammfarben ab und sichert Kontraste. Katalog-Themes nur, wenn der Nutzer es wünscht oder maximale Office-Kompatibilität zählt.',
    'Schriften (Premium-Schriften werden in die PPTX eingebettet):',
    FONT_NAMES.map((f) => `- ${f}: ${FONT_MOOD[f]}`).join('\n'),
    'Katalog-Themes:',
    THEMES.map((t) => `- ${t.id}: ${t.name}${t.dark ? ' (dunkel)' : ''}`).join('\n'),
    '## Folien-Ton und Dekor',
    'Pro Folie optional `tone`: normal | accent (Akzentfläche, Standard bei section) | invert (Hell/Dunkel getauscht). Für Rhythmus: Kapiteltrenner, Kernaussage oder den Höhepunkt des Decks auf accent/invert setzen, höchstens jede 3.–4. Folie. `decor` wählt das Hintergrundmotiv (none, blobs, glow, rings, grid, stripe, dots); Standard kommt vom Theme, nur gezielt abweichen.',
    '## Animationen',
    `Builds: ${BUILDS.join(', ')} · Übergänge: ${TRANSITIONS.join(', ')} (ein Übergangstyp pro Deck, morph nur gezielt).`,
  ].join('\n\n')
}
