// Profi-Folientypen aus Consulting-Decks (Executive Summary, Optionsvergleich, 2×2-Matrix).
// Nur Typ-Import aus ./layouts, damit layouts.ts diese Datei zyklusfrei einbinden kann (EXTRA_LAYOUTS).
// Komponenten: src/renderer/layouts-extra.tsx (gleiche ids).
import { z } from 'zod'
import type { LayoutDef } from './layouts'
import { MASKS } from './deck'

// Foto: dasselbe Objekt in allen Layouts. Ein einfacher String wird als { src } akzeptiert (ältere Decks).
export const FOCI = ['center', 'top', 'bottom', 'left', 'right'] as const
export const LOOKS = ['natural', 'duotone', 'mono'] as const
export const photo = z.preprocess(
  (v) => (typeof v === 'string' ? { src: v } : v),
  z.object({
    src: z.string().describe('asset://local/<absoluter Pfad> aus find_images, oder "" für einen gestalteten Platzhalter'),
    focus: z.union([z.enum(FOCI), z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })]).optional().describe('wichtigster Bildteil (Gesicht, Horizont) für den Zuschnitt: Voreinstellung oder freier Punkt {x, y} von 0 bis 1 (0,0 = oben links); Standard center'),
    look: z.enum(LOOKS).optional().describe('natural = Originalfarben, duotone = in Theme-Farben eingefärbt, mono = schwarzweiß'),
    mask: z.enum(MASKS).optional().describe('Bildrahmen: circle, arch (Bogen), hexagon, diamond, octagon, star, heart; nur für freistehende Fotos (image-text, gallery, quote), nicht für Vollbild'),
  }),
)

const WORDS = 'Wettbewerbsfähigkeit Kundenbindung verbessert deutlich durch schnellere Abläufe im Vertrieb und klare Verantwortung für messbare Ergebnisse'.split(' ')
const words = (max: number, offset = 0) => {
  let s = ''
  for (let i = offset; ; i++) {
    const next = s ? `${s} ${WORDS[i % WORDS.length]}` : WORDS[i % WORDS.length]
    if (next.length > max) return s || next.slice(0, max)
    s = next
  }
}
const rep = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i))

const title = (max = 90) => z.string().min(3).max(max).describe('Action Title: die Kernaussage der Folie als ganzer Satz')
const eyebrow = z.string().max(28).optional().describe('Kleine Überzeile, z. B. Kapitelname')

const summary = z.object({
  eyebrow,
  title: title(),
  points: z.array(z.object({
    title: z.string().max(80).describe('Kernaussage als ganzer Satz – wie der Action Title der zugehörigen Folie'),
    text: z.string().max(130).optional().describe('Beleg in einem Satz, möglichst mit Zahl'),
  })).min(2).max(4),
  recommendation: z.string().max(150).optional().describe('Empfehlung oder Bitte an die Entscheider in einem Satz'),
})

const options = z.object({
  eyebrow,
  title: title(),
  criteria: z.array(z.string().max(32)).min(2).max(6).describe('Bewertungskriterien, wichtigstes zuerst'),
  options: z.array(z.object({
    name: z.string().max(24),
    scores: z.array(z.number().int().min(0).max(4)).describe('Harvey Ball je Kriterium, gleiche Reihenfolge wie criteria: 0 = schwach … 4 = sehr stark'),
    note: z.string().max(70).optional().describe('Fazit der Option in einem Halbsatz'),
  })).min(2).max(3),
  recommended: z.number().int().min(0).max(2).optional().describe('Index der empfohlenen Option (bekommt Rahmen und Plakette)'),
})

const matrix = z.object({
  eyebrow,
  title: title(),
  x: z.string().max(28).describe('Waagrechte Achse (wächst nach rechts), z. B. "Nutzen für Kunden"'),
  y: z.string().max(28).describe('Senkrechte Achse (wächst nach oben), z. B. "Umsetzbarkeit"'),
  quadrants: z.array(z.string().max(24)).length(4).optional().describe('Quadranten: oben links, oben rechts, unten links, unten rechts'),
  items: z.array(z.object({
    label: z.string().max(22),
    x: z.number().min(0).max(100),
    y: z.number().min(0).max(100).describe('0 = unten, 100 = oben'),
  })).min(1).max(8).describe('Positionen 0–100; nah beieinanderliegende Labels vermeiden (Lint meldet Überlappung)'),
  highlight: z.string().max(22).optional().describe('Label des Elements mit der Aussage: nur es bekommt Farbe'),
  takeaway: z.string().max(140).optional().describe('Interpretation neben der Matrix'),
})


const source = z.string().max(90).optional().describe('Quellenangabe / Fußnote')
const iconName = z.string().max(40).describe('lucide-Iconname in kebab-case, z. B. "shield-check"')

const table = z.object({
  eyebrow,
  title: title(),
  columns: z.array(z.string().max(24)).min(2).max(5).describe('Spaltenköpfe; erste Spalte = Zeilenbeschriftung'),
  rows: z.array(z.array(z.string().max(32)).min(2).max(5)).min(2).max(6).describe('Zellen je Zeile, gleiche Anzahl wie columns; Zahlen werden rechtsbündig gesetzt'),
  highlight: z.object({ row: z.number().int().min(0).max(6).optional(), col: z.number().int().min(1).max(4).optional() }).optional()
    .describe('Zeile (0-basiert, ohne Kopf) oder Spalte (1-basiert wie columns) mit der Aussage des Titels'),
  source,
}).refine((c) => c.rows.every((r) => r.length === c.columns.length), 'Jede Zeile braucht genau so viele Zellen wie columns')

const bigNumber = z.object({
  eyebrow,
  value: z.string().min(1).max(8).describe('die eine Zahl, z. B. "41 %", "3×", "2,4 Mio"'),
  label: z.string().min(3).max(90).describe('Aussage zur Zahl als ganzer Satz (wirkt wie der Action Title)'),
  context: z.string().max(160).optional().describe('Einordnung oder Vergleich in einem Satz'),
  source,
  image: photo.optional().describe('Foto rechts; weglassen = nur Zahl und Text'),
})

// Dokumente (A4): Fließtext und Angebot. Nur im Format a4/a4-quer sinnvoll (LayoutDef.sizes).
const docText = z.object({
  eyebrow,
  title: title(80),
  lead: z.string().max(300).optional().describe('Einleitung in einem Absatz, etwas größer gesetzt'),
  sections: z.array(z.object({
    heading: z.string().max(50).optional().describe('Zwischenüberschrift, kurz'),
    text: z.string().min(1).max(700).describe('Absatz in ganzen Sätzen; Zeilenumbruch (\\n) beginnt einen neuen Absatz, **fett** hebt hervor'),
  })).min(1).max(6),
  source,
})

const offer = z.object({
  eyebrow: z.string().max(40).optional().describe('z. B. Angebotsnummer'),
  title: z.string().min(3).max(60).describe('Gegenstand des Angebots, z. B. „Angebot Webseiten-Relaunch“'),
  to: z.string().max(120).optional().describe('Empfänger, Zeilenumbruch (\\n) für Anschrift'),
  meta: z.string().max(80).optional().describe('Datum und Gültigkeit, z. B. „04.10.2026 · gültig bis 03.11.2026“'),
  items: z.array(z.object({
    name: z.string().min(1).max(60),
    detail: z.string().max(100).optional().describe('Leistungsbeschreibung in einem Satz'),
    qty: z.string().max(12).optional().describe('Menge mit Einheit, z. B. „12 Std.“'),
    price: z.string().min(1).max(14).describe('Betrag der Position, z. B. „4.800 €“'),
  })).min(1).max(8),
  totals: z.array(z.object({ label: z.string().max(24), value: z.string().max(14) })).min(1).max(3)
    .describe('Summenzeilen (Netto, Umsatzsteuer, Gesamt); die letzte ist der Gesamtbetrag und wird hervorgehoben. Beträge nachrechnen, nie schätzen'),
  terms: z.string().max(260).optional().describe('Zahlungsziel, Gültigkeit, Hinweise'),
})

// Flyer (A4 hoch): eine Seite, die im Vorbeigehen wirkt – Foto, Schlagzeile, bis zu vier Gründe, Handlungsaufforderung, QR-Code.
const flyer = z.object({
  eyebrow: z.string().max(40).optional().describe('Anlass, Datum oder Zielgruppe, z. B. „Pitch Day · 14. Oktober“'),
  title: z.string().min(3).max(60).describe('Schlagzeile: Nutzen oder Versprechen in wenigen Wörtern, z. B. „Präsentationen in Minuten statt Stunden“'),
  subtitle: z.string().max(140).optional().describe('ein Satz, der die Schlagzeile einlöst: was, für wen, wie'),
  image: photo.optional().describe('ein starkes Foto (Mensch, Produkt, Ort); weglassen = typografischer Flyer'),
  points: z.array(z.object({
    head: z.string().min(1).max(40).describe('Grund oder Vorteil in 2–5 Wörtern, gern mit Zahl'),
    text: z.string().max(80).optional().describe('ein kurzer Satz dazu, höchstens ~40 Zeichen (eine Zeile neben dem Kopf)'),
  })).max(4).optional().describe('2–4 Gründe, Programmpunkte oder Fakten; weniger ist stärker'),
  cta: z.string().min(2).max(60).describe('Handlungsaufforderung, z. B. „Jetzt kostenlos testen“ oder „Anmelden bis 30. Oktober“'),
  contact: z.array(z.string().max(50)).max(3).optional().describe('Web, Mail, Ort oder Termin; je eine Zeile'),
  // nur vollständige URLs: sonst kodiert der QR-Code bloßen Text, und Handys öffnen nichts
  qr: z.string().max(120).regex(/^(https?:\/\/|mailto:|tel:)\S+$/i, 'vollständige URL mit https:// (kurz halten)').optional()
    .describe('vollständige, kurze URL mit https:// für den QR-Code (Anmeldung, Webseite, Demo); je kürzer, desto gröber das Muster und desto sicherer der Scan im Druck'),
})

// Flyer-Rückseite (A4 hoch, Seite 2 im beidseitigen Druck): Details, die vorn keinen Platz haben, und dieselbe Handlung wie vorn.
const flyerBack = z.object({
  eyebrow: z.string().max(40).optional().describe('Anlass und Datum, z. B. „Programm · 14. Oktober“'),
  title: z.string().min(3).max(60).describe('Aussage als Satz, z. B. „So läuft der Pitch Day“'),
  intro: z.string().max(200).optional().describe('ein bis zwei Sätze Einleitung'),
  items: z.array(z.object({
    head: z.string().min(1).max(24).describe('Uhrzeit, Stichwort oder Preis, z. B. „18:00“, „Live-Demo“, „49 €“'),
    text: z.string().max(110).describe('ein Satz dazu'),
  })).min(2).max(6).describe('2–6 Zeilen Programm, Leistungen, Preise oder Fakten'),
  facts: z.array(z.object({
    label: z.string().min(1).max(16).describe('z. B. Wann, Wo, Eintritt'),
    value: z.string().min(1).max(40),
  })).max(4).optional().describe('Eckdaten in einer Zeile, 2–4 Stück'),
  cta: flyer.shape.cta.describe('dieselbe Handlungsaufforderung wie auf der Vorderseite'),
  contact: flyer.shape.contact,
  qr: flyer.shape.qr,
  legal: z.string().max(160).optional().describe('Impressum oder Veranstalter, Bildnachweis; klein gesetzt'),
})

const iconGrid = z.object({
  eyebrow,
  title: title(),
  items: z.array(z.object({ icon: iconName, head: z.string().max(28), sub: z.string().max(90).optional() })).min(3).max(6),
})

const prosCons = z.object({
  eyebrow,
  title: title(),
  prosLabel: z.string().max(20).optional().describe('Überschrift links, Standard "Dafür"'),
  consLabel: z.string().max(20).optional().describe('Überschrift rechts, Standard "Dagegen"'),
  pros: z.array(z.string().max(70)).min(2).max(4),
  cons: z.array(z.string().max(70)).min(2).max(4),
  verdict: z.string().max(120).optional().describe('Abwägung oder Empfehlung in einem Satz'),
})

const side = z.object({ heading: z.string().max(28).optional(), text: z.string().max(140).optional(), points: z.array(z.string().max(70)).max(3).optional() })
const problemSolution = z.object({
  eyebrow,
  title: title(),
  problem: side.describe('Heute / Problem; heading Standard "Heute"'),
  solution: side.describe('Morgen / Lösung; heading Standard "Mit uns"'),
})

const team = z.object({
  eyebrow,
  title: title(),
  people: z.array(z.object({
    name: z.string().max(28), role: z.string().max(40),
    image: photo.optional().describe('Porträt; ohne Foto erscheinen die Initialen'),
    line: z.string().max(70).optional().describe('ein Satz: wofür die Person steht'),
  })).min(2).max(6),
})


const pricing = z.object({
  eyebrow,
  title: title(),
  tiers: z.array(z.object({
    name: z.string().max(20), price: z.string().max(12).describe('z. B. "49 €" oder "auf Anfrage"'), period: z.string().max(16).optional().describe('z. B. "pro Monat"'),
    features: z.array(z.string().max(36)).min(2).max(4), highlight: z.boolean().optional().describe('empfohlene Stufe (höchstens eine)'),
  })).min(2).max(4),
  note: z.string().max(100).optional().describe('Fußnote, z. B. "alle Preise zzgl. MwSt."'),
})

const funnel = z.object({
  eyebrow,
  title: title(),
  stages: z.array(z.object({ label: z.string().max(28), value: z.string().max(10) })).min(3).max(5).describe('von breit (oben) nach schmal (unten)'),
  takeaway: z.string().max(120).optional().describe('Interpretation, z. B. die größte Lücke'),
})

const marketSize = z.object({
  eyebrow,
  title: title(),
  tam: z.object({ value: z.string().max(10), label: z.string().max(60) }).describe('Gesamtmarkt'),
  sam: z.object({ value: z.string().max(10), label: z.string().max(60) }).describe('erreichbarer Markt'),
  som: z.object({ value: z.string().max(10), label: z.string().max(60) }).describe('realistischer Anteil in 3–5 Jahren'),
  source,
})

const logos = z.object({
  eyebrow,
  title: title(),
  logos: z.array(z.object({ name: z.string().max(22), src: z.string().optional().describe('Logo-Datei (asset://); ohne = Name als Schriftzug') })).min(3).max(12),
  mono: z.boolean().optional().describe('Logos einheitlich einfärben (ruhiger)'),
})

const L = <S extends z.ZodObject>(d: LayoutDef<S>) => d

export const EXTRA_LAYOUTS = {
  blank: L({
    id: 'blank', name: 'Leere Folie',
    when: 'Freies Design wie in Canva: nur Hintergrund, alles Weitere als freie Elemente (items). Nur wenn kein Layout passt oder der Nutzer frei gestalten will.',
    schema: z.object({}), defaultBuild: 'none', footer: false,
    samples: { min: {}, typ: {}, max: {} },
  }),
  summary: L({
    id: 'summary', name: 'Executive Summary',
    when: 'Direkt nach dem Cover bei Chef-Updates, Strategie und Entscheidungsvorlagen: 2–4 Kernaussagen (Antwort zuerst) plus Empfehlung. Wer nur diese Folie liest, weiß, worum es geht.',
    frames: ['band'], schema: summary, defaultBuild: 'list', footer: true,
    samples: {
      min: { title: 'Wir empfehlen den Pilot', points: [{ title: 'Der Bedarf ist belegt' }, { title: 'Das Risiko ist begrenzt' }] },
      typ: {
        eyebrow: 'Executive Summary',
        title: 'Wir empfehlen, den Pilot im November mit 20 Schulen zu starten',
        points: [
          { title: 'Jedes vierte Kind hat erhebliche Rechtschreibschwächen', text: 'Lehrkräfte fehlt die Zeit für Einzelförderung – der Bedarf wächst.' },
          { title: 'Ortho-Bot senkt die Fehlerquote in sechs Monaten um 41 %', text: 'Pilot mit 6 Schulen und 412 Kindern, bei gleicher Unterrichtszeit.' },
          { title: 'Eine Schullizenz kostet weniger als ein Klassensatz Hefte', text: '1.900 € pro Jahr statt rund 2.400 € für Arbeitshefte.' },
        ],
        recommendation: 'Pilot mit 20 Partnerschulen ab November freigeben – Budget 38.000 €, Entscheidung bis 15. Oktober.',
      },
      max: { eyebrow: words(28), title: words(90), points: rep(4, (i) => ({ title: words(80, i), text: words(130, i + 2) })), recommendation: words(150, 3) },
    },
  }),
  options: L({
    id: 'options', name: 'Optionsvergleich',
    when: 'Entscheidung zwischen 2–3 Optionen nach klaren Kriterien, mit Empfehlung. Die Folie endet in einer Entscheidung, nicht in einer Aufzählung.',
    frames: ['band'], schema: options, defaultBuild: 'fade', footer: true,
    samples: {
      min: { title: 'Option B ist die bessere Wahl', criteria: ['Kosten', 'Tempo'], options: [{ name: 'Option A', scores: [2, 1] }, { name: 'Option B', scores: [3, 4] }], recommended: 1 },
      typ: {
        eyebrow: 'Entscheidung',
        title: 'Die Partnerlösung bringt uns am schnellsten und günstigsten ans Ziel',
        criteria: ['Zeit bis zum Start', 'Kosten im ersten Jahr', 'Kontrolle über Daten', 'Risiko'],
        options: [
          { name: 'Eigenentwicklung', scores: [1, 1, 4, 2], note: 'Volle Kontrolle, aber 14 Monate Vorlauf' },
          { name: 'Partnerlösung', scores: [4, 3, 3, 3], note: 'Start in 8 Wochen, Daten bleiben in DE' },
          { name: 'Zukauf', scores: [3, 0, 2, 1], note: 'Schnell, aber teuer und schwer integrierbar' },
        ],
        recommended: 1,
      },
      max: {
        eyebrow: words(28), title: words(90), criteria: rep(6, (i) => words(32, i)),
        options: rep(3, (i) => ({ name: words(24, i), scores: rep(6, (j) => (i + j) % 5), note: words(70, i + 1) })), recommended: 2,
      },
    },
  }),
  matrix: L({
    id: 'matrix', name: '2×2-Matrix',
    when: 'Priorisieren oder Einordnen nach zwei Dimensionen (z. B. Aufwand/Nutzen, Attraktivität/Stärke). Der Zielquadrant ist oben rechts.',
    frames: ['split', 'band'], schema: matrix, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Zwei Themen gehen zuerst', x: 'Nutzen', y: 'Machbarkeit', items: [{ label: 'Self-Service', x: 70, y: 70 }, { label: 'Neues CRM', x: 70, y: 30 }] },
      typ: {
        eyebrow: 'Priorisierung',
        title: 'Self-Service und Rechnungsprozess bringen den größten Nutzen bei wenig Aufwand',
        x: 'Nutzen für Kunden',
        y: 'Umsetzbarkeit',
        quadrants: ['Später prüfen', 'Sofort umsetzen', 'Verwerfen', 'Groß planen'],
        items: [
          { label: 'Self-Service-Portal', x: 82, y: 78 },
          { label: 'Rechnungsprozess', x: 64, y: 88 },
          { label: 'Chatbot', x: 38, y: 64 },
          { label: 'Neues CRM', x: 76, y: 22 },
          { label: 'Filialumbau', x: 26, y: 18 },
        ],
        highlight: 'Self-Service-Portal',
        takeaway: 'Zwei Vorhaben liegen klar im Zielquadranten und lassen sich mit bestehenden Teams bis Q2 umsetzen.',
      },
      max: {
        eyebrow: words(28), title: words(90),
        x: words(28), y: words(28, 1),
        quadrants: rep(4, (i) => words(24, i)),
        items: rep(8, (i) => ({ label: words(22, i), x: [22, 50, 78][i % 3], y: [72, 50, 28][Math.floor(i / 3)] })),
        highlight: words(22, 3), takeaway: words(140),
      },
    },
  }),
  table: L({
    id: 'table', name: 'Tabelle',
    when: 'Mehrere Merkmale über mehrere Dinge hinweg (Preise, Kennzahlen je Region, Funktionsvergleich). Höchstens 5 Spalten und 7 Zeilen; highlight auf die Zeile oder Spalte der Aussage.',
    frames: ['band', 'center'], schema: table, defaultBuild: 'fade', footer: true,
    samples: {
      min: { title: 'Nord liegt vorn', columns: ['Region', 'Umsatz'], rows: [['Nord', '2,4 Mio'], ['Süd', '1,9 Mio']] },
      typ: {
        eyebrow: 'Regionen', title: 'Der Norden wächst am stärksten und trägt fast die Hälfte des Plus',
        columns: ['Region', 'Umsatz 2026', 'Wachstum', 'Marge'],
        rows: [['Nord', '2,4 Mio €', '+18 %', '31 %'], ['West', '2,1 Mio €', '+9 %', '28 %'], ['Süd', '1,9 Mio €', '+6 %', '26 %'], ['Ost', '1,2 Mio €', '+4 %', '22 %']],
        highlight: { row: 0 }, source: 'Controlling, Stand 30.09.2026',
      },
      max: { eyebrow: words(28), title: words(90), columns: rep(5, (i) => words(24, i)), rows: rep(6, (r) => rep(5, (i) => (i ? '€ 12.345,6' : words(32, r)))), highlight: { col: 2 }, source: words(90) },
    },
  }),
  'big-number': L({
    id: 'big-number', name: 'Große Zahl',
    when: 'Eine einzige Zahl trägt die Folie (Wirkung, Marktgröße, Ersparnis). Stärker als kpi-grid, wenn es nur eine Zahl gibt. Mit Foto für Emotion. Variante poster (ohne Foto): Zahl übergroß unten links, Label oben rechts; bricht bewusst den Rhythmus (Höhepunkt, einmal pro Deck, im Stil mutig bis zu dreimal).',
    variants: ['plain', 'poster'], schema: bigNumber, defaultBuild: 'zoom-kpi', footer: true,
    samples: {
      min: { value: '41 %', label: 'Weniger Fehler nach sechs Monaten' },
      typ: { eyebrow: 'Wirkung', value: '−41 %', label: 'Mit Ortho-Bot machen Kinder nach sechs Monaten deutlich weniger Fehler', context: 'Pilot mit 412 Kindern an 6 Grundschulen, gleiche Unterrichtszeit wie die Vergleichsgruppe.', source: 'Pilotauswertung 2026' },
      max: { eyebrow: words(28), value: '€ 12,4 M', label: words(90), context: words(160), source: words(90), image: { src: '' } },
    },
  }),
  'doc-text': L({
    id: 'doc-text', name: 'Fließtext (A4)', variants: ['one', 'two'], sizes: ['a4', 'a4-quer'],
    when: 'Nur A4: Seite mit Fließtext (Infoblatt, One-Pager, Konzept, Bericht). Titel, optional Einleitung, 1–6 Absätze mit Zwischenüberschriften. Variante one = eine Spalte (Standard), two = zwei Spalten (ab ca. 3 Abschnitten oder im Querformat). Ganze Sätze statt Stichpunkte.',
    schema: docText, defaultBuild: 'fade', footer: true,
    samples: {
      min: { title: 'Kurzinfo zum Vorhaben', sections: [{ text: 'Ein Absatz genügt.' }] },
      typ: {
        eyebrow: 'Projektinfo', title: 'Ortho-Bot startet im Herbst an 20 Pilotschulen',
        lead: 'Der Pilot läuft ein Schuljahr lang und wird wissenschaftlich begleitet. Die ersten Ergebnisse liegen im März 2027 vor.',
        sections: [
          { heading: 'Worum es geht', text: 'Ortho-Bot erkennt typische Fehlerarten in freien Texten und übt gezielt die passende Regel. Lehrkräfte sehen den Fortschritt pro Kind und Klasse.' },
          { heading: 'Was wir brauchen', text: 'Zwanzig Schulen mit je einer Klasse der Jahrgangsstufe 3 oder 4 und eine feste Ansprechperson im Kollegium.\nDie Anmeldung ist bis zum 15. Oktober möglich.' },
          { heading: 'Datenschutz', text: 'Alle Daten werden in Deutschland verarbeitet. Es gibt keine Klarnamen, die Zuordnung läuft über Kürzel der Lehrkraft.' },
        ],
        source: 'Stand Oktober 2026',
      },
      max: { eyebrow: words(28), title: words(80), lead: words(300), sections: rep(3, (i) => ({ heading: words(50, i), text: words(700, i) })), source: words(90) },
    },
  }),
  offer: L({
    id: 'offer', name: 'Angebot (A4)', sizes: ['a4'],
    when: 'Nur A4: Angebot oder Kostenvoranschlag mit Positionen, Summen und Konditionen. Beträge selbst nachrechnen; fehlen Preise, markierten Platzhalter statt erfundener Zahl.',
    schema: offer, defaultBuild: 'fade', footer: true,
    samples: {
      min: { title: 'Angebot Webseiten-Relaunch', items: [{ name: 'Konzept und Design', price: '4.800 €' }], totals: [{ label: 'Gesamt', value: '4.800 €' }] },
      typ: {
        eyebrow: 'Angebot 2026-041', title: 'Angebot Webseiten-Relaunch', to: 'Muster GmbH\nMusterweg 1\n12345 Musterstadt', meta: '04.10.2026 · gültig bis 03.11.2026',
        items: [
          { name: 'Konzept und Design', detail: 'Strukturplan, Gestaltung von fünf Seitentypen', qty: '1 Pauschale', price: '4.800 €' },
          { name: 'Umsetzung', detail: 'Programmierung, Anbindung an das Redaktionssystem', qty: '40 Std.', price: '3.600 €' },
          { name: 'Inhalte und Fotos', qty: '1 Pauschale', price: '1.200 €' },
          { name: 'Schulung', detail: 'Zwei Termine à zwei Stunden', qty: '4 Std.', price: '360 €' },
        ],
        totals: [{ label: 'Netto', value: '9.960 €' }, { label: 'Umsatzsteuer 19 %', value: '1.892,40 €' }, { label: 'Gesamt', value: '11.852,40 €' }],
        terms: 'Zahlbar innerhalb von 14 Tagen nach Rechnungsstellung. Lieferzeit: sechs Wochen ab Beauftragung.',
      },
      max: { eyebrow: words(40), title: words(60), to: words(120), meta: words(80), items: rep(8, (i) => ({ name: words(60, i), detail: words(100, i), qty: '120 Std.', price: '12.345,67 €' })), totals: rep(3, (i) => ({ label: words(24, i), value: '123.456,78 €' })), terms: words(260) },
    },
  }),
  flyer: L({
    id: 'flyer', name: 'Flyer (A4)', variants: ['top', 'full'], sizes: ['a4'],
    when: 'Nur A4 hoch: Flyer, Handzettel, Plakat, Einladung. Eine Seite, eine Botschaft: Schlagzeile mit Nutzen, ein Satz Unterzeile, 2–4 kurze Gründe, klare Handlungsaufforderung (cta), Kontakt und QR-Code zur Webseite oder Anmeldung. Variante top = Foto in der oberen Hälfte (Standard), full = Foto über die ganze Seite, Text unten auf dem Foto (nur mit ruhiger unterer Bildhälfte wie Himmel, Wand oder Tisch, sonst top). Ohne Foto typografisch: Schlagzeile übergroß; mit tone accent oder invert wird daraus ein farbiger Flyer.',
    schema: flyer, defaultBuild: 'fade', footer: false,
    samples: {
      min: { title: 'Sommerfest am Freitag', cta: 'Alle sind eingeladen' },
      typ: {
        eyebrow: 'Pitch Day · 14. Oktober', title: 'Präsentationen in Minuten statt Stunden',
        subtitle: 'Deckwerk baut aus Stichpunkten fertige Folien, prüft jede Seite und exportiert nach PowerPoint.',
        points: [
          { head: '10 Minuten', text: 'vom Briefing bis zum fertigen Deck' },
          { head: 'Kein KI-Look', text: 'ruhige Layouts, eine Akzentfarbe' },
          { head: 'PPTX, PDF, PNG', text: 'bearbeitbar in PowerPoint' },
        ],
        cta: 'Jetzt kostenlos testen', contact: ['deckwerk.app', 'hallo@deckwerk.app'], qr: 'https://example.com',
      },
      max: { eyebrow: words(40), title: words(60), subtitle: words(140), image: { src: '' }, points: rep(4, (i) => ({ head: words(40, i), text: words(80, i) })), cta: words(60), contact: rep(3, (i) => words(50, i)), qr: 'https://example.com/anmeldung' },
    },
  }),
  'flyer-back': L({
    id: 'flyer-back', name: 'Flyer-Rückseite (A4)', sizes: ['a4'],
    when: 'Nur A4 hoch: Rückseite zu flyer bei beidseitigem Druck (Seite 2). Details, die vorn keinen Platz haben: Programm, Leistungen oder Preise als Liste (head = Uhrzeit, Stichwort oder Preis), Eckdaten wie Wann, Wo, Eintritt, genau eine Handlung (dieselbe wie vorn) mit QR-Code und Kontakt, Impressum klein.',
    schema: flyerBack, defaultBuild: 'fade', footer: false,
    samples: {
      min: { title: 'So läuft der Abend', items: [{ head: '18:00', text: 'Ankommen' }, { head: '18:30', text: 'Live-Demo' }], cta: 'Jetzt anmelden' },
      typ: {
        eyebrow: 'Programm · 14. Oktober', title: 'So läuft der Pitch Day',
        intro: 'Ein Abend, fünf Teams, ein Werkzeug: Wir zeigen live, wie aus Stichpunkten ein fertiges Deck wird.',
        items: [
          { head: '18:00', text: 'Ankommen, Getränke und kurze Begrüßung im Foyer' },
          { head: '18:30', text: 'Live-Demo: vom Briefing bis zur fertigen PowerPoint in zehn Minuten' },
          { head: '19:15', text: 'Fünf Teams pitchen ihre Idee mit einem Deck aus Deckwerk' },
          { head: '20:00', text: 'Fragen und Antworten, danach offener Austausch' },
        ],
        facts: [{ label: 'Wann', value: '14. Oktober, 18 Uhr' }, { label: 'Wo', value: 'Stadtbibliothek, Saal 2' }, { label: 'Eintritt', value: 'frei' }],
        cta: 'Jetzt anmelden', contact: ['example.com/anmeldung', 'hallo@example.com'], qr: 'https://example.com/anmeldung',
        legal: 'Veranstalter: Deckwerk-Projekt, Musterweg 1, 12345 Musterstadt. Foto: Deckwerk.',
      },
      max: { eyebrow: words(40), title: words(60), intro: words(200), items: rep(6, (i) => ({ head: words(24, i), text: words(110, i) })), facts: rep(4, (i) => ({ label: words(16, i), value: words(40, i) })), cta: words(60), contact: rep(3, (i) => words(50, i)), qr: 'https://example.com/anmeldung', legal: words(160) },
    },
  }),
  'icon-grid': L({
    id: 'icon-grid', name: 'Icon-Raster',
    when: '3–6 gleichrangige Merkmale mit je einem Icon, das selbst Information trägt (z. B. Kanal, Gerät, Ort). Sparsam: Icon-Raster sind ein typisches Merkmal generierter Folien, im Zweifel bullets.',
    frames: ['band', 'center'], schema: iconGrid, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Drei Gründe', items: [{ icon: 'zap', head: 'Schnell' }, { icon: 'shield-check', head: 'Sicher' }, { icon: 'smile', head: 'Einfach' }] },
      typ: {
        eyebrow: 'Vorteile', title: 'Sechs Gründe, warum Schulen nach dem Pilot bleiben',
        items: [
          { icon: 'zap', head: 'Sofort startklar', sub: 'Keine Installation, läuft im Browser' },
          { icon: 'shield-check', head: 'DSGVO-konform', sub: 'Server in Deutschland, keine Werbung' },
          { icon: 'users', head: 'Für jede Klasse', sub: 'Passt sich dem Niveau jedes Kindes an' },
          { icon: 'chart-line', head: 'Sichtbarer Fortschritt', sub: 'Wochenbericht für Lehrkräfte' },
          { icon: 'clock', head: '10 Minuten am Tag', sub: 'Fügt sich in den Unterricht ein' },
          { icon: 'heart', head: 'Motivierend', sub: 'Kleine Erfolge statt roter Striche' },
        ],
      },
      max: { eyebrow: words(28), title: words(90), items: rep(6, (i) => ({ icon: 'sparkles', head: words(28, i), sub: words(90, i) })) },
    },
  }),
  'pros-cons': L({
    id: 'pros-cons', name: 'Pro und Contra',
    when: 'Abwägung einer Entscheidung: Argumente dafür und dagegen, am Ende ein klares Urteil (verdict).',
    frames: ['band'], schema: prosCons, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Der Umzug lohnt sich', pros: ['Mehr Platz', 'Bessere Lage'], cons: ['Höhere Miete', 'Umzugskosten'] },
      typ: {
        eyebrow: 'Abwägung', title: 'Der zweite Standort lohnt sich trotz höherer Miete',
        pros: ['60 zusätzliche Plätze in der Innenstadt', 'Mittagsgeschäft mit Büros in Laufweite', 'Küche entlastet den Stammladen'],
        cons: ['Miete 38 % über dem Stammladen', 'Sechs neue Stellen im Service', 'Umbau dauert vier Monate'],
        verdict: 'Ab 140 Gästen am Tag trägt sich der Standort – der Stammladen schafft heute 190.',
      },
      max: { eyebrow: words(28), title: words(90), prosLabel: words(20), consLabel: words(20, 2), pros: rep(4, (i) => words(70, i)), cons: rep(4, (i) => words(70, i + 3)), verdict: words(120) },
    },
  }),
  'problem-solution': L({
    id: 'problem-solution', name: 'Problem und Lösung',
    when: 'Vorher/nachher oder Problem/Lösung: links der schmerzhafte Ist-Zustand, rechts die Lösung (betont).',
    frames: ['band'], schema: problemSolution, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Aus Papier wird digital', problem: { text: 'Formulare auf Papier' }, solution: { text: 'Ein Klick im Portal' } },
      typ: {
        eyebrow: 'Unser Ansatz', title: 'Aus drei Wochen Papierweg wird ein Antrag in zehn Minuten',
        problem: { heading: 'Heute', text: 'Anträge wandern per Hauspost durch vier Abteilungen.', points: ['Ø 21 Tage Bearbeitung', 'Jeder fünfte Antrag unvollständig', 'Kein Status für Bürger'] },
        solution: { heading: 'Mit dem Portal', text: 'Bürger stellen den Antrag online, das System prüft sofort.', points: ['Ø 10 Minuten bis zur Eingangsbestätigung', 'Pflichtfelder verhindern Lücken', 'Status jederzeit online'] },
      },
      max: { eyebrow: words(28), title: words(90), problem: { heading: words(28), text: words(140), points: rep(3, (i) => words(70, i)) }, solution: { heading: words(28, 1), text: words(140, 2), points: rep(3, (i) => words(70, i + 2)) } },
    },
  }),
  team: L({
    id: 'team', name: 'Team',
    when: 'Die Menschen hinter dem Vorhaben: 2–6 Personen mit Rolle, gern mit Porträt. Im Pitch vor dem Ask.',
    frames: ['center'], schema: team, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Zwei Gründer, ein Ziel', people: [{ name: 'Anna Berg', role: 'CEO' }, { name: 'Tom Kraus', role: 'CTO' }] },
      typ: {
        eyebrow: 'Team', title: 'Ein Team aus Schule, Sprachforschung und Software',
        people: [
          { name: 'Julia Hartmann', role: 'CEO · Lehrerin a. D.', line: '12 Jahre Grundschule, kennt den Alltag' },
          { name: 'Dr. Emre Yilmaz', role: 'Forschung', line: 'Promotion in Sprachdidaktik' },
          { name: 'Lena Vogt', role: 'CTO', line: 'Baute Lernapps für 2 Mio Nutzer' },
          { name: 'Paul Neumann', role: 'Vertrieb Schulen', line: 'Kontakte zu 300 Schulträgern' },
        ],
      },
      max: { eyebrow: words(28), title: words(90), people: rep(6, (i) => ({ name: words(28, i), role: words(40, i + 1), line: words(70, i + 2), image: { src: '' } })) },
    },
  }),
  pricing: L({
    id: 'pricing', name: 'Preise',
    when: '2–4 Preisstufen oder Pakete nebeneinander; die empfohlene Stufe mit highlight.',
    frames: ['band'], schema: pricing, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Zwei Pakete', tiers: [{ name: 'Basis', price: '19 €', features: ['1 Klasse', 'E-Mail-Support'] }, { name: 'Schule', price: '149 €', features: ['Alle Klassen', 'Schulung'], highlight: true }] },
      typ: {
        eyebrow: 'Preise', title: 'Die Schullizenz rechnet sich schon ab vier Klassen',
        tiers: [
          { name: 'Klasse', price: '19 €', period: 'pro Monat', features: ['Eine Klasse bis 30 Kinder', 'Wochenbericht', 'E-Mail-Support'] },
          { name: 'Schule', price: '149 €', period: 'pro Monat', features: ['Alle Klassen', 'Schulung fürs Kollegium', 'Auswertung pro Jahrgang', 'Telefon-Support'], highlight: true },
          { name: 'Träger', price: 'auf Anfrage', features: ['Mehrere Schulen', 'Zentrale Verwaltung', 'Eigener Ansprechpartner'] },
        ],
        note: 'Alle Preise zzgl. MwSt., jährliche Abrechnung',
      },
      max: { eyebrow: words(28), title: words(90), tiers: rep(4, (i) => ({ name: words(20, i), price: '€ 1.234', period: words(16, i), features: rep(4, (j) => words(36, i + j)), highlight: i === 1 })), note: words(100) },
    },
  }),
  funnel: L({
    id: 'funnel', name: 'Trichter',
    when: 'Umwandlung über Stufen (Besucher → Leads → Kunden), Vertriebspipeline. Die Stufe mit dem größten Verlust gehört in den takeaway.',
    frames: ['band'], schema: funnel, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Jeder zehnte Lead wird Kunde', stages: [{ label: 'Leads', value: '400' }, { label: 'Angebote', value: '120' }, { label: 'Kunden', value: '40' }] },
      typ: {
        eyebrow: 'Vertrieb', title: 'Der größte Verlust liegt zwischen Demo und Angebot',
        stages: [{ label: 'Website-Besucher', value: '48.000' }, { label: 'Anfragen', value: '2.100' }, { label: 'Demos', value: '640' }, { label: 'Angebote', value: '190' }, { label: 'Neue Schulen', value: '84' }],
        takeaway: 'Nur 30 % der Demos führen zu einem Angebot – hier setzt das neue Pilotpaket an.',
      },
      max: { eyebrow: words(28), title: words(90), stages: rep(5, (i) => ({ label: words(28, i), value: '€ 1.234,5' })), takeaway: words(120) },
    },
  }),
  'market-size': L({
    id: 'market-size', name: 'Marktgröße',
    when: 'Pitch: Gesamtmarkt (TAM), erreichbarer Markt (SAM) und realistischer Anteil (SOM) als verschachtelte Kreise.',
    schema: marketSize, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Der Markt ist groß genug', tam: { value: '2 Mrd €', label: 'Gesamtmarkt' }, sam: { value: '400 Mio €', label: 'Erreichbar' }, som: { value: '20 Mio €', label: 'Unser Ziel' } },
      typ: {
        eyebrow: 'Markt', title: 'Schon 5 % der Grundschulen in DACH tragen ein profitables Geschäft',
        tam: { value: '1,2 Mrd €', label: 'Digitale Lernmittel an Schulen in DACH' },
        sam: { value: '180 Mio €', label: 'Deutsch und Rechtschreibung, Klasse 1–6' },
        som: { value: '9 Mio €', label: '5 % der Grundschulen bis 2029' },
        source: 'Bildungsbericht 2026, eigene Hochrechnung',
      },
      max: { eyebrow: words(28), title: words(90), tam: { value: '€ 12,3 Mrd', label: words(60) }, sam: { value: '€ 1,23 Mrd', label: words(60, 2) }, som: { value: '€ 123 Mio', label: words(60, 4) }, source: words(90) },
    },
  }),
  logos: L({
    id: 'logos', name: 'Logo-Wand',
    when: 'Kunden, Partner oder Förderer als Vertrauensbeweis. 3–12 Logos, gern mono für Ruhe.',
    frames: ['band', 'center'], schema: logos, defaultBuild: 'fade', footer: true,
    samples: {
      min: { title: 'Drei Partner', logos: [{ name: 'Stadt Nord' }, { name: 'Bildungswerk' }, { name: 'Lernfabrik' }] },
      typ: { eyebrow: 'Partner', title: 'Über 40 Schulen und drei Träger arbeiten bereits mit uns', logos: ['Stadt Nord', 'Bildungswerk Süd', 'Lernfabrik', 'Kreis Mitte', 'Grundschule am Park', 'Schulverbund West'].map((name) => ({ name })) },
      max: { eyebrow: words(28), title: words(90), logos: rep(12, (i) => ({ name: words(22, i) })), mono: true },
    },
  }),
} satisfies Record<string, LayoutDef<any>>
