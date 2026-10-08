import { z } from 'zod'
import type { BuildPreset, Deck, FormatId, FrameId, Slide, Tone } from './deck'
import { EXTRA_LAYOUTS, FOCI, LOOKS, photo } from './layouts-extra' // Foto-Schema liegt dort, weil beide Kataloge es brauchen
export { FOCI, LOOKS, photo }

// Layout catalog without React: schemas + knowledge for the AI + samples.
// Components live in src/renderer/layouts.tsx (same ids). Samples feed three things:
// catalog thumbnails for the AI, the stress test (scripts: --check) and examples.

export interface LayoutDef<S extends z.ZodObject = z.ZodObject> {
  id: string
  name: string
  when: string
  variants?: string[]
  frames?: FrameId[] // erlaubte Kompositionen außer top
  schema: S
  defaultBuild: BuildPreset
  tone?: Tone // Standard-Ton der Folie
  footer: boolean
  sizes?: FormatId[] // nur in diesen Formaten sinnvoll (z. B. Dokumente in A4); der Stresstest prüft sie dort statt in 16:9
  samples: { min: z.infer<S>; typ: z.infer<S>; max: z.infer<S> }
}

// Deterministic "worst case" text of realistic German business words, at most `max` chars.
const WORDS =
  'Digitalisierung Kundenzufriedenheit steigt deutlich durch neue Prozesse im Vertrieb und Wachstumsstrategie für internationale Märkte mit messbarem Mehrwert'.split(' ')
export function words(max: number, offset = 0): string {
  let s = ''
  for (let i = offset; ; i++) {
    const w = WORDS[i % WORDS.length]
    const next = s ? `${s} ${w}` : w
    if (next.length > max) return s || w.slice(0, max)
    s = next
  }
}
const rep = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i))

const title = (max = 90) => z.string().min(3).max(max).describe('Action Title: die Kernaussage der Folie als ganzer Satz')
const eyebrow = z.string().max(28).optional().describe('Kleine Überzeile, z. B. Kapitelname')
const source = z.string().max(90).optional().describe('Quellenangabe / Fußnote')
const icon = z.string().max(40).optional().describe('lucide-Iconname in kebab-case, z. B. "shield-check"')

const noPhoto = { src: '' }

const cover = z.object({
  eyebrow,
  title: z.string().min(3).max(70),
  subtitle: z.string().max(120).optional(),
  meta: z.string().max(60).optional().describe('z. B. "Max Muster · Oktober 2026"'),
  image: photo.optional().describe('Vollbildfoto hinter dem Titel (mit Verlauf), bei Variante side rechts neben dem Text; weglassen = Theme-Dekor'),
})

const agenda = z.object({
  title: z.string().max(30),
  items: z.array(z.object({ title: z.string().max(40), desc: z.string().max(70).optional() })).min(3).max(6),
  active: z.number().int().min(0).max(5).optional().describe('Index des hervorgehobenen Punkts (wiederkehrende Agenda)'),
})

const section = z.object({
  number: z.string().max(3).optional().describe('Kapitelnummer, z. B. "02"; nur wenn der Nutzer Nummern will'),
  title: z.string().min(3).max(50),
  subtitle: z.string().max(100).optional(),
  image: photo.optional().describe('Foto rechts neben der Akzentfläche (Standard-Look duotone)'),
})

const statement = z.object({
  eyebrow,
  text: z.string().min(10).max(140).describe('Eine starke Aussage; **Wörter** in Sternchen werden in der Akzentfarbe hervorgehoben'),
  source: z.string().max(60).optional(),
})

const bullets = z.object({
  eyebrow,
  title: title(),
  items: z.array(z.object({ text: z.string().max(80), sub: z.string().max(110).optional(), icon })).min(2).max(5),
})

const column = z.object({
  heading: z.string().max(40),
  text: z.string().max(200).optional(),
  points: z.array(z.string().max(64)).max(4).optional(),
})
const twoColumn = z.object({ eyebrow, title: title(), left: column, right: column })

const imageText = z.object({
  eyebrow,
  title: title(80),
  text: z.string().max(240).optional(),
  points: z.array(z.string().max(64)).max(4).optional(),
  image: photo,
})

const kpiGrid = z.object({
  eyebrow,
  title: title(),
  kpis: z
    .array(
      z.object({
        value: z.string().max(8).describe('kurz! z. B. "+34 %", "2,4 Mio", "98 %"'),
        label: z.string().max(48),
        delta: z.string().max(18).optional().describe('z. B. "+12 % ggü. Vorjahr"'),
        sentiment: z.enum(['positive', 'negative', 'neutral']).optional().describe('Farbe des Deltas (grün/rot/neutral); Pfeilrichtung folgt dem Vorzeichen des Deltas'),
      }),
    )
    .min(2)
    .max(4),
  focus: z.number().int().min(0).max(3).optional().describe('Index (0-basiert) der Zahl, die der Titel meint. Fast immer setzen: Die Karte wird Akzentfläche und breiter, das Auge landet dort zuerst.'),
  source,
})

const chartSpec = z.object({
  type: z.enum(['bar', 'hbar', 'stacked', 'waterfall', 'line', 'donut']).describe(
    'bar: Vergleich weniger Werte · hbar: Ranking, absteigend sortiert, lange Namen · stacked: Zusammensetzung · ' +
    'waterfall: Brücke Start → Treiber → Ende (genau eine Serie; erster und letzter Wert = Summen, dazwischen Veränderungen mit Vorzeichen, Ende = Start + Summe der Veränderungen) · ' +
    'line: Trend über Zeit · donut: Anteile eines Ganzen (max. 6)'),
  categories: z.array(z.string().max(14)).min(2).max(12),
  series: z.array(z.object({ name: z.string().max(24), values: z.array(z.number()) })).min(1).max(4),
  unit: z.string().max(8).optional(),
  highlight: z.string().max(24).optional().describe('Name der Kategorie oder Serie, die die Aussage des Titels trägt: nur sie bekommt Farbe, der Rest wird grau. Fast immer setzen.'),
  annotate: z.enum(['cagr', 'delta']).optional().describe('Automatisch berechnete Beschriftung vom ersten zum letzten Wert der Fokus-Serie: cagr = jährliche Wachstumsrate (Kategorien sind Jahre), delta = Veränderung absolut und relativ'),
})
const chart = z.object({
  eyebrow,
  title: title(),
  chart: chartSpec,
  takeaway: z.object({ value: z.string().max(8).optional(), text: z.string().max(110) }).optional(),
  source,
})

const timeline = z.object({
  eyebrow,
  title: title(),
  items: z.array(z.object({ date: z.string().max(14), title: z.string().max(26), desc: z.string().max(80).optional() })).min(3).max(5),
})

const process = z.object({
  eyebrow,
  title: title(),
  steps: z.array(z.object({ title: z.string().max(26), desc: z.string().max(90).optional(), icon })).min(3).max(4),
})

const closing = z.object({
  title: z.string().min(3).max(60),
  subtitle: z.string().max(120).optional(),
  contact: z.array(z.string().max(48)).max(3).optional(),
  qr: z.string().max(300).optional().describe('URL als QR-Code unten rechts (z. B. Terminbuchung, Unterlagen)'),
  image: photo.optional().describe('Vollbildfoto hinter dem Schluss (mit Verlauf), bei Variante side rechts neben dem Text'),
})

const photoSlide = z.object({
  eyebrow,
  title: title(80),
  subtitle: z.string().max(140).optional(),
  image: photo,
})

const gallery = z.object({
  eyebrow,
  title: title(80),
  images: z.array(z.object({ image: photo, caption: z.string().max(40).optional() })).min(2).max(4),
  look: z.enum(LOOKS).optional().describe('einheitliche Bildsprache für alle Fotos der Folie (überschreibt look pro Bild)'),
})

const quote = z.object({
  text: z.string().min(10).max(180).describe('das Zitat ohne Anführungszeichen'),
  author: z.string().min(2).max(40),
  role: z.string().max(60).optional().describe('Funktion, Firma'),
  image: photo.optional().describe('Porträt (quadratisch oder Hochformat), wird rund maskiert'),
})

const L = <S extends z.ZodObject>(d: LayoutDef<S>) => d

export const LAYOUTS = {
  cover: L({
    id: 'cover', name: 'Titelfolie', when: 'Erste Folie. Titel = Versprechen des Decks. Variante bottom: übergroßer Titel unten links (Plakat, Stil mutig, stark mit Foto). Variante side: Foto randabfallend rechts auf etwa 7/12 der Breite, Text links auf dem Grund in schmaler Spalte, ohne Verlauf – bevorzugt statt Vollbild mit Verlauf, wenn das Foto keine ruhige Fläche für Text hat.', variants: ['left', 'center', 'bottom', 'side'],
    schema: cover, defaultBuild: 'none', footer: false,
    samples: {
      min: { title: 'Q3-Review' },
      typ: { eyebrow: 'Strategie 2027', title: 'Wie wir den Umsatz in 18 Monaten verdoppeln', subtitle: 'Wachstumsplan für die Geschäftsführung', meta: 'Max Muster · Oktober 2026' },
      max: { eyebrow: words(28), title: words(70), subtitle: words(120, 3), meta: words(60, 5) },
    },
  }),
  agenda: L({
    id: 'agenda', name: 'Agenda', when: 'Nach dem Cover bei Decks ab ca. 8 Folien; mit `active` als wiederkehrende Kapitel-Orientierung.',
    schema: agenda, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Agenda', items: rep(3, (i) => ({ title: ['Ausgangslage', 'Lösung', 'Nächste Schritte'][i] })) },
      typ: {
        title: 'Agenda',
        items: [
          { title: 'Ausgangslage', desc: 'Wo wir heute stehen' },
          { title: 'Marktchance', desc: 'Warum jetzt der richtige Zeitpunkt ist' },
          { title: 'Unser Plan', desc: 'Drei Hebel für Wachstum' },
          { title: 'Investition & Ask', desc: 'Was wir brauchen' },
        ],
        active: 1,
      },
      max: { title: words(30), items: rep(6, (i) => ({ title: words(40, i), desc: words(70, i + 2) })) },
    },
  }),
  section: L({
    id: 'section', name: 'Kapiteltrenner', when: 'Zwischen Kapiteln, alle 4–6 Folien. Kurzer Titel.',
    schema: section, defaultBuild: 'none', tone: 'accent', footer: false,
    samples: {
      min: { title: 'Lösung' },
      typ: { title: 'Unser Plan', subtitle: 'Drei Hebel, die sich gegenseitig verstärken' },
      max: { number: '12', title: words(50), subtitle: words(100, 4) },
    },
  }),
  statement: L({
    id: 'statement', name: 'Kernaussage', when: 'Eine einzige starke Botschaft, Zitat oder These. Maximal 1–2 pro Deck. Standard linksbündig; Variante center nur für kurze Sätze. Variante poster: 1–8 Wörter riesig, bricht bewusst den Rhythmus (Höhepunkt, einmal pro Deck, im Stil mutig bis zu dreimal).', variants: ['left', 'center', 'poster'],
    schema: statement, defaultBuild: 'fade', footer: false,
    samples: {
      min: { text: 'Kunden bleiben, wenn es **einfach** ist.' },
      typ: { eyebrow: 'Die Erkenntnis', text: '80 % unserer Neukunden kommen über Empfehlungen – **Zufriedenheit ist unser stärkster Vertriebskanal.**', source: 'Kundenbefragung 2026, n = 1.240' },
      max: { eyebrow: words(28), text: words(140), source: words(60, 3) },
    },
  }),
  bullets: L({
    id: 'bullets', name: 'Aufzählung', when: '2–5 gleichrangige Punkte als ruhige Liste. `icon` nur, wenn das Symbol selbst Information trägt (nie als Schmuck). Variante cards (Kartenreihe, bis 4 Punkte) nur ausnahmsweise: gleich große Karten wirken generiert.', variants: ['list', 'cards'],
    frames: ['split', 'band', 'center'], schema: bullets, defaultBuild: 'list', footer: true,
    samples: {
      min: { title: 'Zwei Gründe sprechen für den Wechsel', items: [{ text: 'Geringere Kosten' }, { text: 'Schnellere Abläufe' }] },
      typ: {
        eyebrow: 'Warum jetzt',
        title: 'Drei Entwicklungen machen den Markt jetzt attraktiv',
        items: [
          { text: 'Regulierung schafft Nachfrage', sub: 'Ab 2027 wird digitale Dokumentation Pflicht' },
          { text: 'Wettbewerb ist fragmentiert', sub: 'Kein Anbieter hat mehr als 8 % Marktanteil' },
          { text: 'Kunden sind wechselbereit', sub: '62 % planen einen Anbieterwechsel in 24 Monaten' },
        ],
      },
      max: { eyebrow: words(28), title: words(90), items: rep(5, (i) => ({ text: words(80, i), sub: words(110, i + 3), icon: 'check' })) },
    },
  }),
  'two-column': L({
    id: 'two-column', name: 'Zwei Spalten', when: 'Gegenüberstellung (vorher/nachher, Problem/Lösung, Option A/B). Standard rule: offene Spalten mit Kopflinie. highlight-right betont die rechte Seite als Fläche; equal = zwei graue Karten (nur auf Wunsch).',
    variants: ['rule', 'equal', 'highlight-right'], frames: ['band'], schema: twoColumn, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Heute gegenüber morgen', left: { heading: 'Heute' }, right: { heading: 'Morgen' } },
      typ: {
        title: 'Die neue Plattform halbiert den manuellen Aufwand',
        left: { heading: 'Heute', points: ['6 Systeme, keine Schnittstellen', 'Berichte per Excel', '3 Tage bis zur Freigabe'] },
        right: { heading: 'Mit Deckwerk', points: ['Eine Plattform für alles', 'Berichte in Echtzeit', 'Freigabe in 2 Stunden'] },
      },
      max: {
        eyebrow: words(28), title: words(90),
        left: { heading: words(40), text: words(200), points: rep(4, (i) => words(64, i)) },
        right: { heading: words(40, 2), text: words(200, 3), points: rep(4, (i) => words(64, i + 1)) },
      },
    },
  }),
  'image-text': L({
    id: 'image-text', name: 'Bild + Text', when: 'Produkt, Team, Ort oder Stimmung zeigen. Nur mit echtem Bild wirklich stark.',
    variants: ['image-left', 'image-right'], schema: imageText, defaultBuild: 'fade', footer: true,
    samples: {
      min: { title: 'So sieht es aus', image: noPhoto },
      typ: { eyebrow: 'Produkt', title: 'Ein Dashboard für alle Standorte', text: 'Alle Kennzahlen live an einem Ort. Abweichungen werden automatisch erkannt und gemeldet.', points: ['Echtzeit-Daten', 'Automatische Warnungen', 'Mobil verfügbar'], image: noPhoto },
      max: { eyebrow: words(28), title: words(80), text: words(240), points: rep(4, (i) => words(64, i)), image: noPhoto },
    },
  }),
  'kpi-grid': L({
    id: 'kpi-grid', name: 'Kennzahlen', when: '2–4 Zahlen, die für sich sprechen. Werte kurz halten (max. 8 Zeichen). Standard: Zahlenzeile mit Trennlinien, die `focus`-Zahl (Standard: die erste) groß und in Akzentfarbe, die übrigen ruhig. Die wichtigste Zahl deshalb nach vorn oder per focus wählen. Variante cards nur ausnahmsweise.',
    variants: ['plain', 'cards'],
    frames: ['band', 'center'], schema: kpiGrid, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Zwei Zahlen zeigen den Erfolg', kpis: [{ value: '98 %', label: 'Verfügbarkeit' }, { value: '4,8', label: 'Kundenbewertung' }] },
      typ: {
        eyebrow: 'Ergebnisse Q3',
        title: 'Wir wachsen schneller als der Markt – und profitabel',
        kpis: [
          { value: '+34 %', label: 'Umsatzwachstum', delta: '+12 % ggü. Plan', sentiment: 'positive' },
          { value: '2,4 Mio', label: 'Wiederkehrender Umsatz (ARR)', delta: '+0,6 Mio', sentiment: 'positive' },
          { value: '1,8 %', label: 'Monatliche Kündigungsrate', delta: '−0,4 Pp.', sentiment: 'positive' },
        ],
        focus: 0,
        source: 'Interne Finanzdaten, Stand 30.09.2026',
      },
      max: { eyebrow: words(28), title: words(90), kpis: rep(4, (i) => ({ value: '€ 12,4 M', label: words(48, i), delta: '+12,5 % ggü.', sentiment: 'positive' as const })), source: words(90) },
    },
  }),
  chart: L({
    id: 'chart', name: 'Diagramm', when: 'Trend (line), Vergleich (bar), Ranking (hbar), Zusammensetzung (stacked), Brücke von Start- zu Endwert (waterfall), Anteile (donut). Immer highlight auf die Aussage setzen; takeaway = die Interpretation.',
    frames: ['split', 'band'], schema: chart, defaultBuild: 'wipe', footer: true,
    samples: {
      min: { title: 'Preis und Menge tragen das EBIT-Plus', chart: { type: 'waterfall', categories: ['2025', 'Preis', 'Menge', 'Kosten', '2026'], series: [{ name: 'EBIT', values: [4.2, 1.1, 0.8, -0.9, 5.2] }], unit: 'Mio €' } },
      typ: {
        eyebrow: 'Umsatzentwicklung',
        title: 'Der Umsatz hat sich seit 2023 mehr als verdoppelt',
        chart: { type: 'bar', categories: ['2022', '2023', '2024', '2025', '2026e'], series: [{ name: 'Umsatz', values: [1.1, 1.4, 2.0, 2.6, 3.3] }, { name: 'Plan', values: [1.0, 1.5, 1.9, 2.4, 3.0] }], unit: 'Mio €', highlight: 'Umsatz', annotate: 'cagr' },
        takeaway: { value: '+136 %', text: 'Wachstum seit 2023 – getrieben durch das neue Abo-Modell' },
        source: 'Geschäftsberichte 2022–2025, 2026 Prognose',
      },
      max: {
        eyebrow: words(28), title: words(90),
        chart: { type: 'bar', categories: rep(12, (i) => `Kategorie ${i + 1}`), series: rep(4, (i) => ({ name: words(24, i), values: rep(12, (j) => 10 + ((i * 7 + j * 13) % 40)) })), unit: 'Mio €' },
        takeaway: { value: '+136 %', text: words(110) },
        source: words(90),
      },
    },
  }),
  timeline: L({
    id: 'timeline', name: 'Zeitstrahl', when: 'Roadmap, Meilensteine, Historie. 3–5 Punkte in zeitlicher Reihenfolge.',
    frames: ['band'], schema: timeline, defaultBuild: 'wipe', footer: true,
    samples: {
      min: { title: 'Drei Meilensteine bis zum Launch', items: [{ date: 'Q1', title: 'Pilot' }, { date: 'Q2', title: 'Beta' }, { date: 'Q3', title: 'Launch' }] },
      typ: {
        eyebrow: 'Roadmap',
        title: 'In vier Schritten zur Marktreife bis Ende 2027',
        items: [
          { date: 'Q4 2026', title: 'Pilot mit 3 Kunden', desc: 'Validierung der Kernfunktionen' },
          { date: 'Q1 2027', title: 'Beta-Programm', desc: '25 Kunden, Feedback-Schleifen' },
          { date: 'Q2 2027', title: 'Marktstart DACH', desc: 'Vertrieb und Partner an Bord' },
          { date: 'Q4 2027', title: 'Internationalisierung', desc: 'Start in Benelux und Nordics' },
        ],
      },
      max: { eyebrow: words(28), title: words(90), items: rep(5, (i) => ({ date: 'Q4 2027 ff.', title: words(26, i), desc: words(80, i + 2) })) },
    },
  }),
  process: L({
    id: 'process', name: 'Prozess', when: 'Ablauf oder Vorgehen in 3–4 Schritten.',
    frames: ['band'], schema: process, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'So funktioniert es', steps: [{ title: 'Anmelden' }, { title: 'Verbinden' }, { title: 'Loslegen' }] },
      typ: {
        eyebrow: 'Vorgehen',
        title: 'Vom Erstgespräch zum Go-live in sechs Wochen',
        steps: [
          { title: 'Analyse', desc: 'Workshops mit allen Fachbereichen' },
          { title: 'Konzept', desc: 'Zielbild und Umsetzungsplan' },
          { title: 'Umsetzung', desc: 'Einrichtung und Datenübernahme' },
          { title: 'Go-live', desc: 'Schulung und Begleitung im Betrieb' },
        ],
      },
      max: { eyebrow: words(28), title: words(90), steps: rep(4, (i) => ({ title: words(26, i), desc: words(90, i + 1), icon: 'check' })) },
    },
  }),
  closing: L({
    id: 'closing', name: 'Abschluss', when: 'Letzte Folie: klare Bitte/nächster Schritt statt nur „Danke“. Variante side: Foto randabfallend rechts auf etwa 7/12 der Breite, Text links auf dem Grund in schmaler Spalte, ohne Verlauf – bevorzugt statt Vollbild mit Verlauf, wenn das Foto keine ruhige Fläche für Text hat.',
    variants: ['left', 'side'],
    schema: closing, defaultBuild: 'none', footer: false,
    samples: {
      min: { title: 'Danke' },
      typ: { title: 'Lassen Sie uns den Pilot im November starten', subtitle: 'Entscheidung bis 15. Oktober – Budget 120.000 €', contact: ['Max Muster', 'max.muster@firma.de', '+49 170 1234567'] },
      max: { title: words(60), subtitle: words(120, 2), contact: rep(3, (i) => words(48, i)) },
    },
  }),
  photo: L({
    id: 'photo', name: 'Vollbildfoto', when: 'Emotionaler Einstieg, Produkt oder Ort groß zeigen, Kapitelwechsel mit Bild. Braucht ein starkes Querformat-Foto. Variante side: Foto randabfallend rechts auf etwa 7/12 der Breite, Text links auf dem Grund in schmaler Spalte, ohne Verlauf – bevorzugt statt Vollbild mit Verlauf, wenn das Foto keine ruhige Fläche für Text hat.',
    variants: ['text-bottom', 'text-left', 'card', 'side'],
    schema: photoSlide, defaultBuild: 'fade', footer: false,
    samples: {
      min: { title: 'Hier fängt es an', image: noPhoto },
      typ: { eyebrow: 'Vor Ort', title: 'Jede dritte Schule arbeitet schon digital – der Rest wartet auf Lösungen', subtitle: 'Besuch an der Grundschule Nord, September 2026', image: noPhoto },
      max: { eyebrow: words(28), title: words(80), subtitle: words(140, 2), image: noPhoto },
    },
  }),
  gallery: L({
    id: 'gallery', name: 'Bildergalerie', when: '2–4 Fotos nebeneinander: Standorte, Produktvarianten, Vorher/Nachher, Eindrücke.',
    variants: ['row', 'mosaic'],
    frames: ['band', 'center'], schema: gallery, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Zwei Standorte', images: rep(2, () => ({ image: noPhoto })) },
      typ: { eyebrow: 'Eindrücke', title: 'Drei Pilotschulen zeigen, wie es im Alltag aussieht', images: ['Grundschule Nord', 'Realschule Mitte', 'Gymnasium Süd'].map((caption) => ({ image: noPhoto, caption })) },
      max: { eyebrow: words(28), title: words(80), images: rep(4, (i) => ({ image: noPhoto, caption: words(40, i) })) },
    },
  }),
  quote: L({
    id: 'quote', name: 'Zitat', when: 'Stimme eines Kunden, Nutzers oder Experten als Beleg. Mit Porträt wirkt es glaubwürdiger.',
    schema: quote, defaultBuild: 'fade', footer: false,
    samples: {
      min: { text: 'Das hat uns wirklich Zeit gespart.', author: 'Anna Berg' },
      typ: { text: 'Seit dem Pilot korrigieren meine Schüler ihre Texte selbst – und verstehen endlich, warum.', author: 'Julia Hartmann', role: 'Deutschlehrerin, Grundschule Nord', image: noPhoto },
      max: { text: words(180), author: words(40), role: words(60, 3), image: noPhoto },
    },
  }),
  ...EXTRA_LAYOUTS,
} satisfies Record<string, LayoutDef<any>>

export type LayoutId = keyof typeof LAYOUTS

// Canva „Andere Gestaltung“: Kombinationen aus Variante × Komposition × Ton, Inhalt bleibt gleich.
// Layouts mit eigenem Standard-Ton (section) wechseln nur Variante und Komposition.
type Look = Pick<Slide, 'variant' | 'frame' | 'tone'>
function allLooks(def: LayoutDef): Look[] {
  const looks: Look[] = []
  for (const variant of def.variants ?? [undefined])
    for (const frame of [undefined, ...(def.frames ?? [])])
      for (const tone of def.tone ? [undefined] : [undefined, 'invert' as const]) looks.push({ variant, frame, tone })
  return looks
}
const lookKey = (def: LayoutDef, l: Look) => `${l.variant ?? def.variants?.[0]}|${l.frame ?? 'top'}|${!l.tone || l.tone === 'normal' ? '' : l.tone}`

export function nextLook(s: Slide): Look {
  const def = LAYOUTS[s.layout as LayoutId] as LayoutDef | undefined
  if (!def) return {}
  const looks = allLooks(def)
  return looks[(looks.findIndex((l) => lookKey(def, l) === lookKey(def, s)) + 1) % looks.length]
}

// Alle anderen Kombinationen für die Vorschau-Auswahl; gleicher Ton (also sichtbar andere Komposition/Variante) vor bloßem Tonwechsel.
export function looksOf(s: Slide): Look[] {
  const def = LAYOUTS[s.layout as LayoutId] as LayoutDef | undefined
  if (!def) return []
  const cur = lookKey(def, s)
  const sameTone = (l: Look) => lookKey(def, l).split('|')[2] === cur.split('|')[2]
  const rest = allLooks(def).filter((l) => lookKey(def, l) !== cur)
  return [...rest.filter(sameTone), ...rest.filter((l) => !sameTone(l))]
}

// Build einer Folie: eigener build > Bewegungsstil des Decks > Standard des Layouts.
// calm = alles nur einblenden, lively = Karten nacheinander, Zahlen zoomen, auch Titelfolien blenden ein.
export function buildOf(deck: Deck, i: number): BuildPreset {
  const s = deck.slides[i]
  if (s.build) return s.build
  const def = LAYOUTS[s.layout as LayoutId]?.defaultBuild ?? 'none'
  if (deck.motion === 'none') return 'none'
  if (deck.motion === 'calm') return def === 'none' ? 'none' : 'fade'
  // lebhaft: Folien mit Foto bekommen den Canva-Foto-Zoom (Galerie ausgenommen, die Bilder stehen dort in Rastern)
  if (deck.motion === 'lively' && s.layout !== 'gallery' && /"src":"(asset|file|https?):/.test(JSON.stringify(s.content?.image ?? ''))) return 'photo'
  if (deck.motion === 'lively') return def === 'none' ? (s.layout === 'blank' ? 'none' : 'fade') : def === 'fade' && s.layout !== 'statement' && s.layout !== 'quote' ? 'stagger' : def
  return def
}
export const LAYOUT_IDS = Object.keys(LAYOUTS) as LayoutId[]
