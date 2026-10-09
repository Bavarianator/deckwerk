/// <reference types="vite/client" />
// Design-Guide und Layout-Katalog als Module mit festen IDs: schlanker Kernprompt mit Index, dazu pro Auftrag die passenden
// Module (Router oder read_guide). SDK- und Electron-frei wie tools.ts, damit die Smoke-Tests es unter Node laufen lassen.
import type { FormatId, Profile } from '../shared/deck'
import { LAYOUTS, LAYOUT_IDS, type LayoutId } from '../shared/layouts'
import guide from './design-guide.md?raw'
import { buildCatalog, houseStyle, recentLooks } from './tools'

export interface GuideModule { id: string; title: string; kurz: string; text: string; always?: true }
// modules: Abschnitts- und layout:-IDs zusätzlich zum Kernprompt
export type Route = { modules: string[]; model?: string; effort?: 'low' | 'medium' | 'high'; source: 'haiku' | 'regel'; reason?: string }
export type RouteInput = { text: string; profile: Profile; layoutsInDeck: string[]; hasDeck: boolean }

const WORKFLOW = `## Arbeitsablauf
1. Höchstens 2–3 Rückfragen (mit ask_user, falls vorhanden), sonst sinnvolle Defaults annehmen.
2. Erst die Leitidee in einem Satz (Guide §2 „Die Idee“: Bild für das Ganze, Haken, ein mutiger Höhepunkt), dann die Storyline als Liste der Titel (Datenfolien als Aussage-Satz, Bühnenfolien kurz) (mit plan_storyline, falls vorhanden, sonst im Chat), dann create_deck und add_slides in Batches.
3. QA-Schleife (max. 3 Runden): Fehler aus den Tool-Rückmeldungen und lint_deck beheben → render_overview kritisch prüfen (Rhythmus, Dichte, Konsistenz) → nachbessern.
4. Animationen prüfen (ein Übergangstyp, maximal ein Build pro Folie, keine Animation auf Titeln), Speaker Notes ergänzen.
5. Kurze Zusammenfassung; exportieren nur, wenn der Nutzer es wünscht.
Antworte auf Deutsch, knapp.`

// Feste ID je Überschrift (Zeilenanfang), damit Umbenennungen keine ID ändern; eine Überschrift ohne Eintrag wirft
const HEADINGS: [id: string, heading: string, kurz: string, always?: true][] = [
  ['praeambel', '# Design-Guide', 'Deine Rolle neben der Engine.', true],
  ['grundregeln', '## 1. Grundregeln', 'Eine Botschaft pro Folie, Action Titles.', true],
  ['storyline', '## 2. Storyline', 'Pyramidenprinzip, SCQA und die Leitidee (Haken, Höhepunkt, Bogen) für neue Decks.'],
  ['geruest', '## 3. Deck-Gerüste', 'Gerüst als Startpunkt, Kapiteltrenner, keine Pflichtteile.'],
  ['geruest-praesentation', '### Präsentationen', 'Folgen für Pitch, Chef-Update, Projektstatus und Strategie; Agenda erst ab ca. 8 Folien.'],
  ['geruest-social', '### Social-Karussell', 'Instagram-Karussell und Story (4:5, 1:1, 9:16): Folge, Textmenge, passende Layouts.'],
  ['geruest-a4', '### A4-Dokumente', 'A4 und Druck: Infoblatt, Angebot, Flyer, Brief, Bewerbung, Lebenslauf, Einladung, Urkunde, Speisekarte, Druckdatei.'],
  ['geruest-visitenkarte', '### Visitenkarte', 'Visitenkarte 85 × 55 mm: Vorder- und Rückseite, Kontaktdaten, Druck.'],
  ['inhalt-layout', '## 4. Inhalt', 'Welches Layout zu welcher Form der Aussage passt.'],
  ['rhythmus', '## 5. Rhythmus', 'Dichte und luftige Folien im Wechsel, Wiederholungen vermeiden.'],
  ['gestaltung', '## 6. Gestaltung', 'Eigenes Design (customTheme): Charakter, Farbe, Grund, Schriftpaar, Struktur, Feinschliff, Theme-Lint, erprobte Richtungen, propose_looks.'],
  ['abwechslung', '### Abwechslung', 'Neues Deck im Designtyp anders als die zuletzt gebauten.'],
  ['stil', '### Stil des Decks', 'Stil sachlich oder mutig, mutige Richtungen, was KI-Folien verrät, was gute Decks tun, Mut wie ein Mensch.'],
  ['fotos', '### Fotos, Bilder, Marke', 'Fotos (Vollbild oder daneben, find_images, focus, Bildnachweis), Canva-Mittel nur auf Wunsch, QR-Code, Brand-Kit.'],
  ['ki-bilder', '### KI-Bilder', 'generate_image: wofür und wofür nie, Bildplan, Stilsatz, Prompt, Platz für den Titel.'],
  ['text', '## 7. Text', 'Titel, Bullets, Wortgrenzen, Zahlen, Links, Speaker Notes, was nach KI klingt.'],
  ['animation', '## 8. Animation', 'Builds, Übergänge, Morph, Bewegungsstil, Element-Animationen, Vortrag oder Selbstlauf.'],
  ['ablauf', '## 9. Arbeitsablauf', 'Briefing, Idee, Theme, Batches, QA-Schleife, Abschluss.', true],
  ['deck-auftraege', '### Aufträge fürs ganze Deck', 'Übersetzen, Notizen, Kürzen, als Text zusammenfassen, Rechtschreibung.'],
  ['fehler', '## 10. Häufige Fehler', 'Was oft schiefgeht.', true],
  ['katalog', '## Layout-Katalog', 'Layouts statt Koordinaten, freie Elemente (items).', true],
  ['katalog-themes', '## Themes', 'Katalog-Themes, Schriften mit Charakter und Schriftkatalog für headFont/bodyFont.'],
  ['katalog-ton', '## Folien-Ton und Dekor', 'tone pro Folie (normal, accent, invert) und Hintergrundmotive.'],
  ['katalog-animationen', '## Animationen', 'Liste der Builds und Übergänge.'],
]

const sizesOf = (id: LayoutId) => (LAYOUTS[id] as { sizes?: FormatId[] }).sizes
const short = (s: string, n = 110) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '')} …`)

// Text an Überschriften (#, ##, ###) in Module teilen; die Layouts des Katalogs heißen layout:<id>
function split(text: string): GuideModule[] {
  return text.split(/\n(?=#{1,3} )/).map((block) => {
    const body = block.trimEnd(), head = body.split('\n', 1)[0]
    const lay = /^### (\S+) – /.exec(head)?.[1]
    if (lay && lay in LAYOUTS) {
      const L = LAYOUTS[lay as LayoutId], sizes = sizesOf(lay as LayoutId)
      return { id: `layout:${lay}`, title: L.name, kurz: `${sizes ? `nur Format ${sizes.join('/')} – ` : ''}${short(L.when)}`, text: body }
    }
    const def = HEADINGS.find(([, h]) => head.startsWith(h))
    if (!def) throw new Error(`Überschrift ohne Modul-ID: „${head}“ (HEADINGS in guide-modules.ts ergänzen)`)
    return { id: def[0], title: head.replace(/^#+\s*/, ''), kurz: def[2], text: body, ...(def[3] && { always: true as const }) }
  })
}

// Arbeitsablauf, Hausstil und zuletzt gebaute Decks: immer im Prompt, Hausstil und Decks nur, wenn vorhanden
function extras(): GuideModule[] {
  const style = houseStyle(), recent = recentLooks()
  return [
    { id: 'workflow', title: 'Arbeitsablauf', kurz: 'Ablauf in Kürze.', text: WORKFLOW, always: true },
    ...(style ? [{ id: 'hausstil', title: 'Hausstil des Nutzers', kurz: 'Vorlieben des Nutzers.', text: `## Hausstil des Nutzers (gilt für jedes Deck, hat Vorrang vor dem Design-Guide)\n${style}`, always: true as const }] : []),
    ...(recent.length ? [{ id: 'zuletzt', title: 'Zuletzt gebaute Decks', kurz: 'Designtypen der letzten Decks.', always: true as const,
      text: `## Zuletzt gebaute Decks (nur für neue Decks: im Typ nicht wiederholen, Design-Guide §6 „Abwechslung“; bestehende Decks behalten ihr Design)\n${recent.map(({ title, typ: t }) => `- „${title}“: ${t.hell}, ${t.schrift}-Titel ${t.gewicht} (${t.font}), Grund ${t.grund}, Bauteile ${t.bauteile}, Akzent ${t.akzent}`).join('\n')}` }] : []),
  ]
}

// Alle Module in fester Reihenfolge: Guide, Katalog, Arbeitsablauf, Hausstil, zuletzt gebaute Decks
export function guideModules(): GuideModule[] {
  const mods = [...split(guide.trim()), ...split(buildCatalog()), ...extras()]
  const missing = HEADINGS.filter(([id]) => !mods.some((m) => m.id === id)).map(([, h]) => h)
  if (missing.length) throw new Error(`Überschrift fehlt in Guide oder Katalog: ${missing.join(', ')} (HEADINGS in guide-modules.ts anpassen)`)
  return mods
}

// Index aller Module, die nicht ohnehin im Kernprompt stehen
export function guideIndex(mods = guideModules()): string {
  const rest = mods.filter((m) => !m.always), isLayout = (m: GuideModule) => m.id.startsWith('layout:')
  return [
    '## Index: Module nach Bedarf',
    'Im App-Chat bekommst du zum Start eines Gesprächs die für den Auftrag gewählten Module mit; fehlen sie (z. B. über MCP), lade sie selbst. Brauchst du später weitere (andere Layouts, Animation, Gestaltung …), lade sie mit `read_guide({ module: [...] })`, bevor du sie nutzt, z. B. `read_guide({ module: ["animation", "layout:kpi-grid"] })`; `layout:<id>` liefert Felder und JSON-Schema eines Layouts. Felder nie raten.',
    `Abschnitte:\n${rest.filter((m) => !isLayout(m)).map((m) => `- ${m.id} – ${m.title}: ${m.kurz}`).join('\n')}`,
    `Layouts:\n${rest.filter(isLayout).map((m) => `- ${m.id} – ${m.title} – ${m.kurz}`).join('\n')}`,
  ].join('\n\n')
}

// Kernprompt: Module mit always und der Index (nach der Katalog-Einleitung). Stabil → Prompt-Caching.
export function corePrompt(): string {
  const mods = guideModules()
  return mods.filter((m) => m.always).flatMap((m) => (m.id === 'katalog' ? [m.text, guideIndex(mods)] : [m.text])).join('\n\n')
}

// Texte der Module in fester Reihenfolge; unbekannte IDs fallen weg
export function modulesText(ids: string[]): string {
  const want = new Set(ids)
  return guideModules().filter((m) => want.has(m.id)).map((m) => m.text).join('\n\n')
}

// Block der Router-Module für die erste Nachricht (API- und CLI-Weg gleich); leer ohne bekannte Module
export function leitfaden(route: Route | undefined): string {
  const mods = route ? modulesText(route.modules) : ''
  return mods && `<leitfaden>\nFür diesen Auftrag ausgewählt (Router): ${route!.modules.join(', ')}. Weitere Module mit read_guide.\n\n${mods}\n</leitfaden>`
}

// Voller Guide und voller Katalog (bisheriger Systemprompt): für read_guide in Teilen und als Rückfall
export function fullPrompt(): string {
  return [guide.trim(), buildCatalog(), ...extras().map((m) => m.text)].join('\n\n')
}

// Claude Code nimmt Tool-Ergebnisse nur bis zu einer Token-Grenze an (61.000 Zeichen am Stück waren zu viel): Teile an Abschnittsgrenzen
export function guideParts(max = 20000): string[] {
  const parts = ['']
  for (const block of fullPrompt().split(/\n(?=##+ )/)) {
    if (parts.at(-1) && parts.at(-1)!.length + block.length > max) parts.push('')
    parts[parts.length - 1] += (parts.at(-1) ? '\n' : '') + block
  }
  return parts
}

// Regel-Router ohne KI (Rückfall für den Haiku-Router): Layouts nach Format, Abschnitte nach Stichwörtern; lieber ein Modul zu viel
const SOCIAL_SKIP: LayoutId[] = ['agenda', 'section', 'table'] // Guide „Social-Karussell“: weglassen
const DOC_BASIS: LayoutId[] = ['cover', 'bullets', 'image-text', 'kpi-grid', 'chart', 'table', 'timeline', 'quote'] // Seiten zwischen A4-Dokumenten
const DATA = ['inhalt-layout', 'layout:chart', 'layout:kpi-grid', 'layout:table', 'layout:big-number']
const KEYWORDS: [name: string, re: RegExp, modules: string[]][] = [
  ['animation', /animation|animier|übergang|morph|\bbuild|einblend|bewegung|selbstlauf/, ['animation', 'katalog-animationen']],
  ['bild', /foto|bild|photo|image|unsplash|illustration|logo|qr/, ['fotos', 'ki-bilder']],
  ['design', /farbe|look|theme|design|stil|schrift|font|mutig|sachlich|gestalt|marke|brand|hintergrund|dunkel|edel|modern/, ['gestaltung', 'abwechslung', 'stil', 'katalog-themes', 'katalog-ton']],
  ['text', /text|titel|formulier|rechtschreib|tippfehler|übersetz|notiz|notes|sprache|schreib|kürz|zusammenfass/, ['text', 'deck-auftraege']],
  ['diagramm', /diagramm|chart|grafik|zahl|kennzahl|kpi|tabelle|daten|umsatz|prozent|%/, DATA],
  ['storyline', /storyline|aufbau|gliederung|idee|geschichte|dramaturgie|reihenfolge|roter faden/, ['storyline', 'geruest', 'rhythmus']],
  ['rhythmus', /rhythmus|abwechslung|eintönig|langweilig|luftig|überladen/, ['rhythmus', 'inhalt-layout']],
  ['bewerbung', /bewerbung|lebenslauf|anschreiben|\bcv\b/, ['geruest-a4', 'layout:application-cover', 'layout:letter', 'layout:cv']],
]
const KINDS = {
  karte: /visitenkarte/,
  a4: /\ba4\b|druckerei|druckdatei|drucksache|\bdrucken\b|flyer|plakat|brief(?!ing)|angebot|kostenvoranschlag|infoblatt|one-pager|handzettel|lebenslauf|bewerbung|einladung|save the date|urkunde|zertifikat|bescheinigung|speisekarte|getränkekarte|mittagstisch/,
  social: /instagram|karussell|carousel|social|\bstory\b|stories|linkedin|tiktok|\bpost(s|ing)?\b|1:1|4:5|9:16/,
  slides: /präsentation|vortrag|pitch|keynote|powerpoint|pptx|slides|16:9/,
}

export function ruleRoute(input: RouteInput): Route {
  const t = input.text.toLowerCase(), inDeck = input.layoutsInDeck.filter((id): id is LayoutId => id in LAYOUTS)
  // Format: Stichwörter, bei einem Deck auch sein Profil; ohne beides das übergebene Profil
  const kinds = new Set((Object.keys(KINDS) as (keyof typeof KINDS)[]).filter((k) => KINDS[k].test(t)))
  if (input.hasDeck || !kinds.size) kinds.add(input.profile === 'doc' ? (inDeck.includes('business-card') ? 'karte' : 'a4') : input.profile)
  const layouts = new Set<LayoutId>(inDeck)
  const add = (ids: LayoutId[]) => ids.forEach((id) => layouts.add(id))
  if (kinds.has('slides')) add(LAYOUT_IDS.filter((id) => !sizesOf(id)))
  if (kinds.has('social')) add(LAYOUT_IDS.filter((id) => !sizesOf(id) && !SOCIAL_SKIP.includes(id)))
  if (kinds.has('a4')) add([...LAYOUT_IDS.filter((id) => sizesOf(id)?.some((s) => s.startsWith('a4'))), ...DOC_BASIS])
  if (kinds.has('karte')) add(['business-card'])

  const mods: string[] = ['geruest']
  if (kinds.has('slides')) mods.push('geruest-praesentation')
  if (kinds.has('social')) mods.push('geruest-social')
  if (kinds.has('a4')) mods.push('geruest-a4')
  if (kinds.has('karte')) mods.push('geruest-visitenkarte')
  mods.push('inhalt-layout', 'text')
  if (!input.hasDeck) {
    mods.push('gestaltung', 'abwechslung', 'stil', 'katalog-themes', 'katalog-ton')
    if (kinds.size > 1 || !kinds.has('karte')) mods.push('storyline', 'rhythmus', 'fotos', 'ki-bilder') // eine Visitenkarte braucht keine Storyline
    else mods.push('fotos') // aber die Brand-Kit-Regeln (Logo)
    if (kinds.has('slides')) mods.push('animation', 'katalog-animationen')
  }
  const hits = KEYWORDS.filter(([, re]) => re.test(t))
  for (const [, , m] of hits) mods.push(...m)
  return {
    modules: [...new Set([...mods, ...[...layouts].map((id) => `layout:${id}`)])],
    source: 'regel',
    reason: `Regeln: ${[...kinds].join(', ')}${input.hasDeck ? '' : ', neues Deck'}${hits.length ? `; Stichwörter: ${hits.map(([n]) => n).join(', ')}` : ''}`,
  }
}
