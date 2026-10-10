// Profi-Folientypen aus Consulting-Decks (Executive Summary, Optionsvergleich, 2×2-Matrix).
// Nur Typ-Import aus ./layouts, damit layouts.ts diese Datei zyklusfrei einbinden kann (EXTRA_LAYOUTS).
// Komponenten: src/renderer/layouts-extra.tsx (gleiche ids).
import { z } from 'zod'
import type { LayoutDef } from './layouts'
import { MASKS } from './deck'
import { MAX_PARTS } from './video'

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

// Videoclip (src/shared/video.ts): Ausschnitte eines Quellvideos, nacheinander abgespielt; Export als MP4 (export-video.ts)
const clip = z.object({
  video: z.string().describe('Quellvideo: asset://-Pfad aus dem Anhang oder absoluter Dateipfad; "" = Platzhalter'),
  parts: z.array(z.object({
    start: z.number().min(0).describe('Sekunden im Quellvideo (aus transcribe_video)'),
    end: z.number().min(0),
    focus: z.number().min(0).max(1).optional().describe('horizontaler Bildmittelpunkt für den Zuschnitt, 0 = links, 1 = rechts (aus video_frames); Standard 0.5'),
  }).refine((p) => p.end > p.start + 0.2, 'end muss nach start liegen')).min(1).max(MAX_PARTS).describe(`Ausschnitte, nacheinander abgespielt (Jump Cuts), Schnitte an Satzgrenzen. Short: zusammen ideal 55–75 s; ganzes Video kürzen: alles Behaltene, bis ${MAX_PARTS} Ausschnitte; Highlight: der Moment mit Anlauf und Auflösung`),
  hook: z.string().max(70).optional().describe('Einstiegszeile oben in den ersten Sekunden: macht neugierig, ohne Clickbait'),
  captions: z.enum(['wort', 'satz', 'aus']).optional().describe('Untertitel aus dem Transkript (nur im MP4): wort = wenige Wörter, aktuelles Wort in Akzentfarbe (Standard); satz = ganze Zeilen; aus'),
  pauses: z.enum(['kurz', 'lassen']).optional().describe('Sprechpausen (nur im MP4): kurz = Pausen ab 0,6 s auf 0,3 s kürzen, der Clip wirkt zügiger; lassen = unverändert (Standard)'),
  fit: z.enum(['crop', 'blur']).optional().describe('Bild im Format: crop = Bild füllt das Format, Zuschnitt um focus (Standard); blur = ganzes Bild mittig auf unscharfem Grund, wenn Gesten oder Folien am Rand wichtig sind'),
  follow: z.enum(['sprecher']).optional().describe('sprecher = Zuschnitt folgt dem, der gerade spricht (Podcast, Gespräch); nur bei mehreren Personen im Bild'),
  style: z.enum(['ruhig', 'lebendig']).optional().describe('Animation im Export: ruhig (Standard, ohne Bewegung) oder lebendig (Wort-Pop, Hook mit Einblendung, Fortschrittsbalken, Zoom-Wechsel an Schnitten) – lebendig für Shorts/Reels, ruhig für Vorträge und Fulltime'),
  ton: z.enum(['klar', 'original']).optional().describe('Ton im Export: klar = Sprache aufbereiten (Hochpass, Entrauschen, Kompressor, De-Esser) für Talking Head, Podcast, Vortrag, Aufnahmen mit Rauschen oder Hall vom Handy/Webcam; original = unverändert (Standard). Nie klar bei Musik, Gesang oder Vorführungen, deren Geräusche zählen'),
  cover: z.number().min(0).optional().describe('Quellsekunde fürs Titelbild (Export: .jpg neben dem MP4): ausdrucksstarkes Gesicht oder der Kernmoment, aus dem Kontaktabzug; muss im Video liegen, nicht der erste Frame, kein Schwarzbild'),
  post: z.string().max(2200).optional().describe('Text zum Posten (Export: .txt neben dem MP4): Zeile 1 Titel (≤ 100 Zeichen), dann 1–2 Sätze Beschreibung, dann 3–5 Hashtags; Sprache des Videos, kein Clickbait, keine Emoji-Ketten'),
})

// Bewerbung – Deckblatt (A4 hoch): oben Stelle und Unternehmen, unten Foto, Name und Kontakt, daneben der Inhalt der Mappe.
const applicationCover = z.object({
  eyebrow: z.string().max(30).optional().describe('kleine Überzeile, z. B. „Bewerbung“ oder „Bewerbung · Kennziffer 2026-14“'),
  title: z.string().min(3).max(70).describe('die Stelle, z. B. „als Pflegefachkraft“ (mit eyebrow „Bewerbung“) oder „Bewerbung als Pflegefachkraft“'),
  org: z.string().max(60).optional().describe('Unternehmen oder Einrichtung, z. B. „bei der Muster GmbH“'),
  name: z.string().min(2).max(40).describe('Vor- und Nachname der Bewerberin oder des Bewerbers; fehlt er, „[Vorname Nachname]“'),
  photo: photo.optional().describe('Bewerbungsfoto (Hochformat), nur ein eigenes Foto des Nutzers, nie ein Stockfoto; weglassen = ohne Foto'),
  contact: z.array(z.string().min(1).max(50)).max(4).optional().describe('Anschrift, Telefon, E-Mail; je eine Zeile, nie erfinden'),
  contents: z.array(z.string().min(1).max(40)).max(6).optional().describe('Inhalt der Mappe in Reihenfolge, z. B. „Anschreiben“, „Lebenslauf“, „Zeugnisse“; nur bei mehr als zwei Anlagen'),
})

// Brief (A4 hoch, DIN 5008 Form B): Anschriftfeld an fester Stelle für den Fensterumschlag, Text auf einer Seite.
const letter = z.object({
  sender: z.string().min(2).max(60).describe('Absender im Briefkopf: Name der Organisation oder Person, z. B. „Praxis am Markt“'),
  senderLine: z.string().max(50).optional().describe('Rücksendeangabe über der Anschrift, eine Zeile, z. B. „Praxis am Markt, Marktplatz 3, 12345 Musterstadt“'),
  to: z.string().min(3).max(180).regex(/^[^\n]*(?:\n[^\n]*){0,5}$/, 'höchstens 6 Zeilen')
    .describe('Anschrift, Zeilenumbruch (\\n) je Zeile: Firma oder Name, ggf. Abteilung oder Person, Straße und Hausnummer, PLZ Ort; höchstens 6 Zeilen'),
  info: z.array(z.object({
    label: z.string().min(1).max(20).describe('z. B. „Datum“, „Ihr Zeichen“, „Ansprechpartnerin“'),
    value: z.string().min(1).max(40),
  })).max(4).optional().describe('Informationsblock rechts neben der Anschrift, 1–4 Zeilen; das Datum gehört hierher'),
  subject: z.string().min(3).max(90).describe('Betreff als Aussage, wird fett gesetzt; ohne das Wort „Betreff“'),
  salutation: z.string().max(60).optional().describe('Anrede mit Komma, z. B. „Sehr geehrte Damen und Herren,“'),
  body: z.string().min(1).max(1100).describe('Brieftext in kurzen Absätzen, eine Seite; Zeilenumbruch (\\n) beginnt einen neuen Absatz (mit Leerzeile davor), **fett** hebt hervor'),
  closing: z.string().max(40).optional().describe('Grußformel, z. B. „Mit freundlichen Grüßen“'),
  signature: z.string().max(80).optional().describe('Name und Funktion unter dem Platz für die Unterschrift, Zeilenumbruch (\\n) erlaubt'),
  enclosures: z.array(z.string().min(1).max(40)).max(6).optional().describe('Anlagen, je eine Zeile, z. B. „Lebenslauf“, „Arbeitszeugnisse“; stehen unter „Anlagen“ nach der Unterschrift'),
  footer: z.array(z.string().max(100)).max(4).optional().describe('Fußzeile in Spalten, z. B. Anschrift, Kontakt, Bankverbindung, Register; je Spalte ein Eintrag, Zeilen mit \\n'),
})

// Urkunde (A4 quer): Art und Titel oben, Empfänger groß, Ort/Datum und Unterschriftsfelder unten.
const certificate = z.object({
  eyebrow: z.string().max(40).optional().describe('Art des Dokuments, z. B. „Teilnahmebescheinigung“, „Zertifikat“, „Auszeichnung“'),
  title: z.string().min(3).max(50).describe('„Urkunde“ oder die Leistung, z. B. „Erste-Hilfe-Kurs bestanden“'),
  recipient: z.string().min(2).max(50).describe('Name der Person oder des Teams ohne Anrede; steht am größten'),
  text: z.string().max(260).optional().describe('wofür, in ganzen Sätzen: Kurs oder Leistung, Umfang in Stunden, Zeitraum, Inhalte'),
  date: z.string().max(50).optional().describe('Ort und Datum, z. B. „Musterstadt, 8. Oktober 2026“'),
  signers: z.array(z.object({
    name: z.string().max(40).optional().describe('Name der unterzeichnenden Person; nur echte Namen, nie erfunden'),
    role: z.string().min(1).max(40).describe('Funktion, z. B. „Kursleitung“, „Schulleitung“'),
  })).max(2).optional().describe('0–2 Unterschriftsfelder: Linie zum Unterschreiben, darunter Name und Funktion'),
})

// Einladung (A4 hoch, oft als A5 oder A6 gedruckt): wer lädt wen wozu ein, wann und wo, Bitte um Antwort. Wenig Text, große Schrift.
const invitation = z.object({
  eyebrow: z.string().max(40).optional().describe('Anlass, z. B. „Einladung“ oder „Save the Date“'),
  title: z.string().min(3).max(60).describe('Anlass persönlich als Satz, z. B. „Wir feiern 25 Jahre Praxis am Markt“'),
  text: z.string().max(240).optional().describe('Einladungstext in zwei bis drei ganzen, persönlichen Sätzen'),
  facts: z.array(z.object({
    label: z.string().min(1).max(14).describe('z. B. Wann, Wo, Dresscode'),
    value: z.string().min(1).max(60).describe('z. B. „Samstag, 4. Juli, ab 18 Uhr“ oder die Adresse'),
  })).min(1).max(4).describe('Eckdaten: mindestens Wann (Wochentag, Datum, Uhrzeit) und Wo'),
  rsvp: z.string().max(80).optional().describe('Bitte um Antwort mit Frist und Weg, z. B. „Bitte sagt bis 1. Juli zu“'),
  host: z.string().max(60).optional().describe('wer einlädt, z. B. „Das Team der Praxis am Markt“'),
  image: photo.optional().describe('Foto oben (Ort, Menschen, Anlass); weglassen = typografische Karte'),
  qr: flyer.shape.qr.describe('vollständige, kurze URL mit https:// für den QR-Code (Zusage, Anfahrt); je kürzer, desto sicherer der Scan im Druck'),
})

// Visitenkarte (85 × 55 mm): Vorder- und Rückseite zeigen denselben Inhalt. Auf der Karte ist nur der Name größer als 12 px.
const businessCard = z.object({
  name: z.string().min(1).max(32).describe('Vor- und Nachname; unbekannt = Platzhalter „[Vorname Nachname]“'),
  role: z.string().max(40).optional().describe('Funktion oder Beruf, z. B. „Projektleitung“'),
  org: z.string().max(40).optional().describe('Organisation oder Firma; auf der Rückseite groß, solange das Brand-Kit kein Logo hat'),
  lines: z.array(z.string().min(1).max(36)).max(4).optional().describe('0–4 Kontaktzeilen, eine Angabe pro Zeile ohne Icons oder Kürzel davor: Telefon, E-Mail, Web, Adresse. Nie erfinden'),
  claim: z.string().max(60).optional().describe('ein Satz zur Leistung, steht nur auf der Rückseite'),
  qr: flyer.shape.qr.describe('vollständige, kurze URL mit https:// für den QR-Code auf der Rückseite (Webseite, Kontaktseite); je kürzer, desto gröber das Muster und desto sicherer der Scan'),
})

// Lebenslauf (A4 hoch): Stationen und Kenntnisse nur als Text. Die Gesamtzahl der Stationen begrenzt, was auf eine Seite passt.
const CV_ENTRIES = 5
const cv = z.object({
  name: z.string().min(2).max(40).describe('Vor- und Nachname'),
  role: z.string().max(60).optional().describe('Berufsbezeichnung oder Ziel, z. B. „Produktdesignerin“'),
  image: photo.optional().describe('Bewerbungsfoto (Porträt, focus top); weglassen = ohne Foto, auf Folgeseiten immer weglassen'),
  profile: z.string().max(300).optional().describe('Kurzprofil in 1–3 Sätzen: Erfahrung, Stärke, Ziel'),
  contact: z.array(z.string().max(40)).max(5).optional().describe('Anschrift, Telefon, E-Mail, Web; je eine Angabe'),
  sections: z.array(z.object({
    heading: z.string().min(1).max(30).describe('z. B. „Berufserfahrung“, „Ausbildung“, „Weiterbildung“'),
    entries: z.array(z.object({
      period: z.string().min(1).max(24).describe('Zeitraum knapp, z. B. „2021 – heute“ oder „09/2018 – 06/2021“'),
      title: z.string().min(1).max(60).describe('Funktion oder Abschluss'),
      place: z.string().max(60).optional().describe('Arbeitgeber oder Hochschule mit Ort'),
      text: z.string().max(140).optional().describe('höchstens ein Satz, am besten mit Ergebnis'),
    })).min(1).max(CV_ENTRIES).describe('antichronologisch: neueste Station zuerst'),
  })).min(1).max(4).describe(`insgesamt höchstens ${CV_ENTRIES} Stationen pro Seite, weitere auf eine zweite cv-Seite`),
  skills: z.array(z.object({
    label: z.string().min(1).max(24).describe('z. B. „Sprachen“, „Software“'),
    text: z.string().min(1).max(80).describe('z. B. „Deutsch (Muttersprache), Englisch (C1)“'),
  })).max(4).optional().describe('Kenntnisse als Text; keine Balken, Sterne oder Prozentangaben'),
  signed: z.string().max(50).optional().describe('Ort und Datum am Seitenende, z. B. „Musterstadt, 8. Oktober 2026“'),
}).refine((c) => c.sections.reduce((n, s) => n + s.entries.length, 0) <= CV_ENTRIES, `Höchstens ${CV_ENTRIES} Stationen pro Seite – weitere auf eine zweite cv-Seite (ohne Foto)`)

// Speisekarte (A4 hoch): Abschnitte mit Gerichten, Preis rechts auf der Zeile des Namens.
// Grenzen für den ungünstigsten Fall (alle Felder voll, 12 px): rund 12 Gerichte mit je einer Zeile Beschreibung; das max-Sample
// verteilt sie auf drei gleich lange Abschnitte (4+4+4), damit der Stresstest den Spaltenumbruch mitten im Abschnitt prüft.
const MENU_MAX = 12
const menu = z.object({
  eyebrow: z.string().max(40).optional().describe('Ort, Saison oder Anlass, z. B. „Mittagstisch · KW 41“'),
  title: z.string().min(3).max(40).describe('z. B. „Speisekarte“, „Herbstkarte“, „Getränke“'),
  intro: z.string().max(160).optional().describe('ein bis zwei Sätze zur Küche, z. B. Herkunft der Zutaten'),
  sections: z.array(z.object({
    heading: z.string().min(1).max(30).describe('z. B. „Vorspeisen“, „Hauptgerichte“, „Getränke“'),
    items: z.array(z.object({
      name: z.string().min(1).max(40).describe('Gericht kurz und konkret, z. B. „Kürbissuppe“'),
      text: z.string().max(80).optional().describe('Zutaten und Zubereitung statt Werbesprache, z. B. „Hokkaido, Ingwer, geröstete Kerne“'),
      price: z.string().min(1).max(10).describe('Preis, z. B. „12,50“ oder „12,50 €“; nie erfinden, fehlt er: „–,–“'),
      tag: z.string().max(20).optional().describe('dezenter Zusatz, z. B. „vegan“ oder Allergen-Kürzel „A, G“'),
    })).min(1).max(6),
  })).min(1).max(4),
  note: z.string().max(220).optional().describe('Hinweise klein unten: Allergene und Zusatzstoffe erklären, „Alle Preise in Euro inkl. MwSt.“'),
}).refine((c) => c.sections.reduce((n, s) => n + s.items.length, 0) <= MENU_MAX, `Höchstens ${MENU_MAX} Gerichte pro Seite; weitere auf eine zweite menu-Seite`)

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
    when: 'Nur A4 hoch: Flyer, Handzettel, Plakat (persönliche Einladung → invitation). Eine Seite, eine Botschaft: Schlagzeile mit Nutzen, ein Satz Unterzeile, 2–4 kurze Gründe, klare Handlungsaufforderung (cta), Kontakt und QR-Code zur Webseite oder Anmeldung. Variante top = Foto in der oberen Hälfte (Standard), full = Foto über die ganze Seite, Text unten auf dem Foto (nur mit ruhiger unterer Bildhälfte wie Himmel, Wand oder Tisch, sonst top). Ohne Foto typografisch: Schlagzeile übergroß; mit tone accent oder invert wird daraus ein farbiger Flyer.',
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
  'application-cover': L({
    id: 'application-cover', name: 'Bewerbung – Deckblatt (A4)', sizes: ['a4'],
    when: 'Nur A4 hoch: Deckblatt einer Bewerbungsmappe (optional, vor Anschreiben und Lebenslauf). Oben die Stelle (title, z. B. „als Pflegefachkraft“ mit eyebrow „Bewerbung“; Kennziffer gern dazu) und das Unternehmen (org), unten Name, Bewerbungsfoto und Kontakt. Reihenfolge der Bewerbung, alles in einem Deck und Theme: application-cover, dann letter (Anschreiben), dann cv (Lebenslauf). Kontaktdaten und Foto nie erfinden: fehlen sie, Platzhalter in eckigen Klammern setzen (z. B. „[Telefon]“, Foto mit src "") und nachfragen; als Foto nur ein eigenes Bild des Nutzers, nie ein Stockfoto. contents nur, wenn mehr als zwei Anlagen folgen. Für Online-Bewerbungen ist das Deckblatt verzichtbar.',
    schema: applicationCover, defaultBuild: 'fade', footer: false,
    samples: {
      min: { title: 'Bewerbung als Erzieherin', name: 'Mara' },
      typ: {
        eyebrow: 'Bewerbung', title: 'als Pflegefachkraft in der ambulanten Pflege', org: 'bei der Sozialstation Musterstadt',
        name: 'Vorname Nachname', photo: { src: '' },
        contact: ['Musterweg 1', '12345 Musterstadt', 'Telefon 0123 456789'],
        contents: ['Anschreiben', 'Lebenslauf', 'Examenszeugnis', 'Arbeitszeugnisse'],
      },
      max: { eyebrow: words(30), title: words(70), org: words(60), name: words(40), photo: { src: '' }, contact: rep(4, (i) => words(50, i)), contents: rep(6, (i) => words(40, i)) },
    },
  }),
  certificate: L({
    id: 'certificate', name: 'Urkunde (A4 quer)', sizes: ['a4-quer'],
    when: 'Nur A4 quer: Urkunde, Zertifikat, Teilnahmebescheinigung, Auszeichnung. recipient = Name der Person oder des Teams ohne Anrede (steht am größten), title = Leistung oder schlicht „Urkunde“, eyebrow = Art des Dokuments. text sagt konkret, wofür: Kurs oder Leistung, Umfang in Stunden, Datum oder Zeitraum. Unterschriftsfelder (signers) nur mit echten Namen und Funktionen, kennst du den Namen nicht, nur die Funktion. Mehrere Empfänger = mehrere Seiten mit gleichem Text. Das Logo kommt aus dem Brand-Kit.',
    schema: certificate, defaultBuild: 'fade', footer: false,
    samples: {
      min: { title: 'Urkunde', recipient: 'Mara' },
      typ: {
        eyebrow: 'Teilnahmebescheinigung', title: 'Erste-Hilfe-Kurs', recipient: 'Mara',
        text: 'hat am 8. Oktober 2026 erfolgreich am Erste-Hilfe-Kurs mit neun Unterrichtseinheiten teilgenommen. Inhalte: Notruf, stabile Seitenlage, Herz-Lungen-Wiederbelebung und der Einsatz eines Defibrillators.',
        date: 'Musterstadt, 8. Oktober 2026',
        signers: [{ name: 'Jonas', role: 'Kursleitung' }, { role: 'Geschäftsführung' }],
      },
      max: { eyebrow: words(40), title: words(50), recipient: words(50), text: words(260), date: words(50), signers: rep(2, (i) => ({ name: words(40, i), role: words(40, i + 1) })) },
    },
  }),
  invitation: L({
    id: 'invitation', name: 'Einladung (A4)', sizes: ['a4'],
    when: 'Nur A4 hoch: Einladung, Save the Date, Karte zu Feier, Jubiläum, Hochzeit, Sommerfest, Tag der offenen Tür. Titel nennt den Anlass persönlich („Wir feiern …“), facts mit Wann (Wochentag, Datum, Uhrzeit) und Wo, rsvp mit Frist und Weg (Nachricht, Telefon, QR-Code), host sagt, wer einlädt. Wenig Text: Einladungen werden oft als A5 oder A6 gedruckt (export print mit size a5/a6). Mit Foto steht es oben, ohne ist die Karte typografisch; mit tone accent oder invert wird sie farbig. Werbung mit Gründen und Handlungsaufforderung → lieber flyer.',
    schema: invitation, defaultBuild: 'fade', footer: false,
    samples: {
      min: { title: 'Sommerfest im Hof', facts: [{ label: 'Wann', value: 'Freitag, 3. Juli, 17 Uhr' }] },
      typ: {
        eyebrow: 'Einladung', title: 'Wir feiern 25 Jahre Praxis am Markt',
        text: 'Seit 25 Jahren sind wir für euch da. Das möchten wir mit allen feiern, die uns auf diesem Weg begleitet haben – mit Musik, Essen und guten Gesprächen.',
        facts: [{ label: 'Wann', value: 'Samstag, 4. Juli, ab 18 Uhr' }, { label: 'Wo', value: 'Praxis am Markt, Musterweg 1, 12345 Musterstadt' }, { label: 'Dresscode', value: 'Sommerlich' }],
        rsvp: 'Bitte sagt bis 20. Juni zu, gern über den QR-Code.', host: 'Das Team der Praxis am Markt', qr: 'https://example.com/zusage',
      },
      max: { eyebrow: words(40), title: words(60), text: words(240), facts: rep(4, (i) => ({ label: words(14, i), value: words(60, i) })), rsvp: words(80), host: words(60), image: { src: '' }, qr: 'https://example.com/zusage' },
    },
  }),
  letter: L({
    id: 'letter', name: 'Brief (A4, DIN 5008)', sizes: ['a4'],
    when: 'Nur A4 hoch: Geschäftsbrief nach DIN 5008 (Fensterumschlag DL bzw. C6/5); Anschriftfeld, Falz- und Lochmarken liegen fest. Anschrift (to) in der Reihenfolge Firma oder Name, ggf. Person, Straße und Hausnummer, PLZ Ort; Datum, Zeichen und Ansprechpartner in den Informationsblock (info); Betreff als Aussage; Text in kurzen Absätzen, eine Seite; Anlagen in enclosures. Das Logo kommt aus dem Brand-Kit. Bewerbungsanschreiben = letter: Absender ist die Bewerberin oder der Bewerber, Name im Briefkopf (sender), Kontakt in senderLine und info, footer kann leer bleiben; Betreff „Bewerbung als …“ mit Kennziffer, Anlagen wie Lebenslauf und Zeugnisse in enclosures, höchstens eine Seite. Absenderdaten (Anschrift, Kontakt, Bank) nie erfinden: fehlen sie, Platzhalter in eckigen Klammern wie „[Straße Nr.]“ setzen und den Nutzer fragen. Will der Nutzer weiterschreiben, als Word (docx) exportieren.',
    schema: letter, defaultBuild: 'fade', footer: false,
    samples: {
      min: { sender: 'Praxis am Markt', to: 'Muster GmbH\nMusterweg 1\n12345 Musterstadt', subject: 'Ihr Termin am 4. November steht', body: 'Wir bestätigen den Impftermin für Ihr Team am 4. November um 9 Uhr.' },
      typ: {
        sender: 'Praxis am Markt', senderLine: 'Praxis am Markt, Marktplatz 3, 12345 Musterstadt',
        to: 'Muster GmbH\nPersonalabteilung\nMusterweg 1\n12345 Musterstadt',
        info: [{ label: 'Ihr Zeichen', value: 'PA-2026-17' }, { label: 'Ansprechpartnerin', value: 'Sabine, Praxisleitung' }, { label: 'Telefon', value: '0123 456789' }, { label: 'Datum', value: '8. Oktober 2026' }],
        subject: 'Grippeschutzimpfung für Ihr Team am 4. November',
        salutation: 'Sehr geehrte Damen und Herren,',
        body: 'vielen Dank für Ihre Anfrage. Gern impfen wir Ihre Mitarbeitenden in Ihren Räumen gegen Grippe. Wir kommen am 4. November um 9 Uhr mit zwei Fachkräften und bringen den Impfstoff mit.\nBitte stellen Sie einen ruhigen Raum mit Tisch und zwei Stühlen bereit. Pro Person rechnen wir mit zehn Minuten, bei 40 Anmeldungen sind wir gegen 12 Uhr fertig.\nDie Kosten übernimmt in der Regel die Krankenkasse. Den Aufklärungsbogen legen wir bei; er sollte ausgefüllt mitgebracht werden.',
        closing: 'Mit freundlichen Grüßen', signature: 'Sabine\nPraxisleitung', enclosures: ['Aufklärungsbogen'],
        footer: ['Praxis am Markt\nMarktplatz 3\n12345 Musterstadt', 'Telefon 0123 456789\nexample.com', 'Sparkasse Musterstadt\nIBAN DE12 3456 7890 1234 5678 90', 'Sprechzeiten\nMo–Fr 8–18 Uhr'],
      },
      max: {
        sender: words(60), senderLine: words(50), to: rep(6, (i) => words(29, i)).join('\n'),
        info: rep(4, (i) => ({ label: words(20, i), value: words(40, i) })), subject: words(90), salutation: words(60),
        body: rep(4, (i) => words(274, i)).join('\n'), closing: words(40), signature: `${words(39)}\n${words(40, 2)}`, enclosures: rep(6, (i) => words(40, i)), footer: rep(4, (i) => words(100, i)),
      },
    },
  }),
  'business-card': L({
    id: 'business-card', name: 'Visitenkarte (85×55 mm)', variants: ['front', 'back'], sizes: ['visitenkarte'],
    when: 'Nur Format visitenkarte (85 × 55 mm): Visitenkarte, Vorder- und Rückseite. Zwei Seiten mit demselben content anlegen: Seite 1 variant front (Name und Funktion oben, Organisation und Kontaktzeilen unten), Seite 2 variant back (Logo aus dem Brand-Kit, sonst Organisation groß, dazu claim und optional QR-Code); die Rückseite gern mit tone accent. Höchstens 4 Kontaktzeilen, eine Angabe pro Zeile. Kontaktdaten nie erfinden: fehlen sie, Platzhalter in eckigen Klammern wie „[Telefon]“ setzen und nachfragen. Für die Druckerei mit export_deck format print exportieren (PDF mit Beschnitt).',
    schema: businessCard, defaultBuild: 'fade', footer: false,
    samples: {
      min: { name: 'Mara' },
      typ: {
        name: 'Vorname Nachname', role: 'Landschaftsarchitektin', org: 'Grünwerk Gartenplanung',
        lines: ['Telefon 0123 456789', 'example.com', 'Musterweg 1, 12345 Musterstadt'],
        claim: 'Gärten, die mit wenig Pflege durchs ganze Jahr tragen.', qr: 'https://example.com',
      },
      max: { name: words(32), role: words(40, 1), org: words(40, 2), lines: rep(4, (i) => words(36, i + 3)), claim: words(60, 4), qr: 'https://example.com/kontakt' },
    },
  }),
  cv: L({
    id: 'cv', name: 'Lebenslauf (A4)', variants: ['side', 'plain'], sizes: ['a4'],
    when: 'Nur A4 hoch: Lebenslauf (CV, Bewerbung). Name, Berufsbezeichnung, Kurzprofil, Kontakt, Stationen in Abschnitten (Berufserfahrung, Ausbildung …) und Kenntnisse als Text. Stationen antichronologisch, Zeitraum knapp („2021 – heute“), title = Funktion oder Abschluss, place = Arbeitgeber oder Hochschule mit Ort, text höchstens ein Satz mit Ergebnis. Variante side (Standard) = schmale Seitenspalte mit Foto, Kontakt und Kenntnissen; plain = tabellarisch wie in Deutschland üblich, Zeitraum links, Foto rechts neben dem Namen. Foto optional (in Deutschland üblich, nicht Pflicht). Passt es nicht auf eine Seite: zweite cv-Seite ohne Foto, Profil und Kontakt. In einer Bewerbung folgt der Lebenslauf auf das Anschreiben (letter), Name wie auf Deckblatt und Anschreiben; signed = Ort und Datum klein am Seitenende (optional, nur auf der letzten cv-Seite).',
    schema: cv, defaultBuild: 'fade', footer: false,
    samples: {
      min: { name: 'Vorname Nachname', sections: [{ heading: 'Berufserfahrung', entries: [{ period: '2021 – heute', title: 'Projektleitung' }] }] },
      typ: {
        name: 'Mara', role: 'Produktdesignerin mit Schwerpunkt Barrierefreiheit',
        profile: 'Acht Jahre Erfahrung in der Gestaltung digitaler Dienste für Verwaltung und Mittelstand. Ich verbinde Nutzerforschung mit sorgfältiger Umsetzung und suche eine Rolle mit Verantwortung für ein Designteam.',
        contact: ['Musterweg 1, 12345 Musterstadt', '0123 456789', 'example.com/mara'],
        sections: [
          { heading: 'Berufserfahrung', entries: [
            { period: '2021 – heute', title: 'Senior Produktdesignerin', place: 'Muster GmbH, Musterstadt', text: 'Gestaltung des Bürgerportals; die Abbruchquote im Antrag sank um 38 %.' },
            { period: '2018 – 2021', title: 'Produktdesignerin', place: 'Beispiel AG, Musterstadt', text: 'Aufbau eines Designsystems für zwölf Fachanwendungen.' },
            { period: '2016 – 2018', title: 'Junior UX-Designerin', place: 'Agentur Nord, Musterstadt' },
          ] },
          { heading: 'Ausbildung', entries: [
            { period: '2013 – 2016', title: 'B. A. Kommunikationsdesign', place: 'Hochschule Musterstadt', text: 'Abschlussarbeit über barrierefreie Formulare, Note 1,3.' },
          ] },
        ],
        skills: [
          { label: 'Sprachen', text: 'Deutsch (Muttersprache), Englisch (C1), Spanisch (B1)' },
          { label: 'Werkzeuge', text: 'Figma, HTML und CSS, Nutzertests, WCAG 2.2' },
        ],
        signed: 'Musterstadt, 8. Oktober 2026',
      },
      max: {
        name: words(40), role: words(60), image: { src: '' }, profile: words(300), contact: rep(5, (i) => words(40, i)),
        // Stationen an der Gesamtgrenze, verteilt auf die Höchstzahl der Abschnitte
        sections: [2, 1, 1, 1].map((n, i) => ({ heading: words(30, i), entries: rep(n, (j) => ({ period: words(24, i + j), title: words(60, i + j), place: words(60, j + 1), text: words(140, i + j) })) })),
        skills: rep(4, (i) => ({ label: words(24, i), text: words(80, i) })), signed: words(50),
      },
    },
  }),
  menu: L({
    id: 'menu', name: 'Speisekarte (A4)', variants: ['one', 'two'], sizes: ['a4'],
    when: `Nur A4 hoch: Speisekarte, Getränkekarte, Mittagstisch, Preisliste. Abschnitte (Vorspeisen, Hauptgerichte …) mit Gerichten: Name kurz und konkret, text = Zutaten statt Werbesprache, Preis rechts. Preise nie erfinden: fehlen sie, Platzhalter „–,–“ setzen und am Ende nachfragen. tag für „vegan“ oder Allergen-Kürzel, die Kürzel in note erklären (Allergene, Zusatzstoffe, Preise inkl. MwSt.). Variante one = eine Spalte (Standard), two = zwei Spalten ab ca. 8 Gerichten oder bei kurzen Einträgen wie Getränken. Höchstens ${MENU_MAX} Gerichte pro Seite; mehr = weitere menu-Seite (z. B. Getränke).`,
    schema: menu, defaultBuild: 'fade', footer: false,
    samples: {
      min: { title: 'Speisekarte', sections: [{ heading: 'Heute', items: [{ name: 'Linsensuppe', price: '6,50' }] }] },
      typ: {
        eyebrow: 'Herbst · ab 1. Oktober', title: 'Herbstkarte',
        intro: 'Wir kochen mit Gemüse aus dem Umland und Fleisch von Höfen, die wir kennen.',
        sections: [
          { heading: 'Vorspeisen', items: [
            { name: 'Kürbissuppe', text: 'Hokkaido, Ingwer, geröstete Kerne', price: '7,50', tag: 'vegan' },
            { name: 'Feldsalat', text: 'Birne, Walnuss, Ziegenkäse, Honig-Senf-Dressing', price: '9,80', tag: 'G, H' },
          ] },
          { heading: 'Hauptgerichte', items: [
            { name: 'Rinderroulade', text: 'Rotkohl, Kartoffelklöße, Schmorsauce', price: '21,50', tag: 'A, I' },
            { name: 'Kürbisrisotto', text: 'Salbeibutter, Bergkäse', price: '16,90', tag: 'G' },
            { name: 'Saibling', text: 'Aus dem Fichtelgebirge, mit Petersilienkartoffeln und Rahmspinat', price: '23,00', tag: 'D, G' },
          ] },
          { heading: 'Nachspeisen', items: [
            { name: 'Zwetschgendatschi', text: 'Mit geschlagener Sahne', price: '5,50', tag: 'A, C, G' },
          ] },
        ],
        note: 'Allergene: A Gluten, C Ei, D Fisch, G Milch, H Schalenfrüchte, I Sellerie. Alle Preise in Euro inkl. MwSt.',
      },
      max: {
        eyebrow: words(40), title: words(40), intro: words(160),
        sections: rep(3, (i) => ({ heading: words(30, i), items: rep(4, (j) => ({ name: words(40, i + j), text: words(80, j), price: '1.234,50 €', tag: words(20, j) })) })),
        note: words(220),
      },
    },
  }),
  clip: L({
    id: 'clip', name: 'Videoclip',
    when: 'Video aus Ausschnitten einer Quelle, eine Folie = ein Video. Short/Reel (9:16, ideal 55–75 s, Hook, Untertitel); ganzes Video kürzen (16:9, Füllsätze und Pausen raus); Stream-Highlights (je Moment eine Folie); Zusammenschnitt mehrerer Quellen (je Quelle eine clip-Folie, dazwischen Titel). Nur mit Video aus dem Anhang und Zeiten aus dem Transkript; Export über export_deck (mp4 = alles in einem Video, clips = je Folie eine MP4). Ablauf: read_guide § Video.',
    sizes: ['9:16', '4:5', '1:1', '16:9'], schema: clip, defaultBuild: 'none', footer: false,
    samples: {
      min: { video: '', parts: [{ start: 0, end: 4 }] },
      typ: { video: '', hook: 'Warum neun von zehn Pitches scheitern', parts: [{ start: 12.4, end: 21.8, focus: 0.5 }, { start: 40.1, end: 52 }, { start: 63, end: 70.5 }], captions: 'wort', cover: 45.2, post: 'Warum neun von zehn Pitches scheitern\nDer häufigste Fehler steckt in der ersten Minute. So vermeidest du ihn.\n#pitch #startup #gründen' },
      max: { video: '', hook: words(70), parts: rep(MAX_PARTS, (i) => ({ start: i * 10, end: i * 10 + 8, focus: 1 })), captions: 'satz', fit: 'blur', follow: 'sprecher', style: 'lebendig', ton: 'klar', cover: 5, post: words(2200) },
    },
  }),
} satisfies Record<string, LayoutDef<any>>
