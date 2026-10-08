// Schriftkatalog für eigene Themes: kuratierte Google-Fonts-Familien (OFL/Apache), die die Engine bei Bedarf lädt
// (src/main/webfonts.ts), im Renderer misst und in die PPTX einbettet. Gebündelte Schriften (FONT_LIST in themes.ts)
// stehen ebenfalls hier, damit die KI eine einzige Liste mit Charakter und Markierung sieht.
// Gewichte und Namen prüft scripts/curate-fonts.ts gegen die Google-Fonts-API (npm run fonts:curate).
// flag: slop = Standard generierter Designs, nur auf ausdrücklichen Wunsch; common = überall zu sehen, neutral.

export type FontCat = 'grotesk' | 'humanist' | 'geometric' | 'condensed' | 'serif' | 'display-serif' | 'slab' | 'mono'
export interface FontInfo {
  family: string // exakt wie bei Google Fonts = Familienname (nameID 1) der Regular-TTF
  cat: FontCat
  mood: string // Charakter in wenigen Wörtern
  role: 'head' | 'body' | 'both'
  weights: number[] // statisch verfügbare Gewichte (400/700 = RIBBI, alles andere eigene Instanz-Familie)
  italic: boolean
  flag?: 'slop' | 'common'
  pairs?: string[] // bewährte Partner (Text zu Titel bzw. umgekehrt)
  fallback: string // gebündelte Schrift gleicher Anmutung (offline)
  license: 'OFL' | 'Apache'
  office?: true // Arial/Calibri/Georgia: in PowerPoint vorhanden, wird nicht geladen oder eingebettet
}

const W = (from: number, to: number) => [100, 200, 300, 400, 500, 600, 700, 800, 900].filter((w) => w >= from && w <= to)
const f = (family: string, cat: FontCat, mood: string, role: FontInfo['role'], weights: number[], italic: boolean, fallback: string, more: Partial<FontInfo> = {}): FontInfo =>
  ({ family, cat, mood, role, weights, italic, fallback, license: 'OFL', ...more })

export const FONT_CATALOG: FontInfo[] = [
  // Grotesk: sachlich, modern, die meisten Geschäftsdecks
  f('Inter', 'grotesk', 'neutral, präzise, Bildschirm-Standard', 'both', W(100, 900), true, 'Inter', { flag: 'common', pairs: ['Newsreader', 'Source Serif 4'] }),
  f('Inter Tight', 'grotesk', 'eng laufend, groß gesetzt markant', 'head', W(100, 900), true, 'Inter', { pairs: ['Inter', 'IBM Plex Sans'] }),
  f('IBM Plex Sans', 'grotesk', 'technisch-warm, Ingenieursklarheit', 'both', W(100, 700), true, 'Inter', { pairs: ['IBM Plex Serif', 'IBM Plex Mono'] }),
  f('Archivo', 'grotesk', 'robust, zeitungshaft, Plakatwucht in Schwarz', 'both', W(100, 900), true, 'Archivo'),
  f('Work Sans', 'grotesk', 'freundlich-sachlich, leicht grotesk-historisch', 'both', W(100, 900), true, 'Inter'),
  f('Public Sans', 'grotesk', 'amtlich neutral, verlässlich', 'both', W(100, 900), true, 'Inter'),
  f('Schibsted Grotesk', 'grotesk', 'redaktionell, kantig, starke fette Schnitte', 'both', W(400, 900), true, 'Archivo'),
  f('Hanken Grotesk', 'grotesk', 'ruhig, rund-sachlich, Produktdesign', 'both', W(100, 900), true, 'Inter'),
  f('Instrument Sans', 'grotesk', 'schlank, zeitgenössisch, Studio-Look', 'both', W(400, 700), true, 'Inter'),
  f('Geist', 'grotesk', 'kühl, technisch, Entwickler-Ästhetik', 'both', W(100, 900), true, 'Inter'),
  f('Host Grotesk', 'grotesk', 'offen, warm, menschlich', 'both', W(300, 800), true, 'Inter'),
  f('Onest', 'grotesk', 'klar, freundlich, gut lesbar', 'both', W(100, 900), false, 'Inter'),
  f('Familjen Grotesk', 'grotesk', 'skandinavisch-eigenwillig, markante Kurven', 'head', W(400, 700), true, 'Archivo', { pairs: ['Inter', 'Work Sans'] }),
  f('Archivo Black', 'grotesk', 'Plakat-Grotesk in Black, laute Ansagen', 'head', [400], false, 'Archivo Black', { pairs: ['Archivo'] }), // nur ein Schnitt (Black als 400)
  f('Libre Franklin', 'grotesk', 'amerikanische Zeitungsgrotesk, direkt', 'both', W(100, 900), true, 'Archivo'),
  f('Chivo', 'grotesk', 'kräftig, eigenständig, gut in Schwarz', 'both', W(100, 900), true, 'Archivo'),
  f('Albert Sans', 'grotesk', 'geometrisch-skandinavisch, hell und offen', 'both', W(100, 900), true, 'Inter'),
  f('Rethink Sans', 'grotesk', 'modern, leicht verspielt, Tech-Marke', 'both', W(400, 800), true, 'Inter'),
  f('Red Hat Display', 'grotesk', 'selbstbewusst, weite Formen, Titel', 'head', W(300, 900), true, 'Inter', { pairs: ['Red Hat Text'] }),
  f('Red Hat Text', 'grotesk', 'ruhig, lesefreundlich zu Red Hat Display', 'body', W(300, 700), true, 'Inter'),
  f('Figtree', 'grotesk', 'freundlich-rund, App-Look', 'both', W(300, 900), true, 'Inter', { flag: 'common' }),
  f('Bricolage Grotesque', 'grotesk', 'trendig-verformt, Startup-Plakat', 'head', W(200, 800), false, 'Archivo', { flag: 'common' }),
  f('Roboto', 'grotesk', 'Android-Standard, beliebig', 'both', W(100, 900), true, 'Inter', { flag: 'common' }),
  f('Open Sans', 'humanist', 'Web-Standard der 2010er, beliebig', 'both', W(300, 800), true, 'Source Sans 3', { flag: 'common' }),
  f('Lato', 'humanist', 'Web-Standard, weich, beliebig', 'both', [300, 400, 700, 900], true, 'Source Sans 3', { flag: 'common' }), // 100 heißt dort „Hairline“
  f('Space Grotesk', 'grotesk', 'technoid, Krypto- und KI-Ästhetik', 'head', W(300, 700), false, 'Inter', { flag: 'slop' }),
  f('Poppins', 'geometric', 'rund-geometrisch, Vorlagen-Standard', 'both', W(100, 900), true, 'DM Sans', { flag: 'slop' }),
  f('Montserrat', 'geometric', 'Plakat-Geometrie, überall in Vorlagen', 'both', W(100, 900), true, 'DM Sans', { flag: 'slop' }),

  // Humanistisch: menschlich, lesefreundlich, gut für längere Texte
  f('Source Sans 3', 'humanist', 'klar, unaufgeregt, Adobe-Klassiker', 'both', W(200, 900), true, 'Source Sans 3', { pairs: ['Source Serif 4'] }),
  f('Fira Sans', 'humanist', 'technisch-lesbar, Mozilla', 'both', W(100, 900), true, 'Source Sans 3'),
  f('Karla', 'humanist', 'eigenwillig-grotesk, sympathisch', 'both', W(200, 800), true, 'Source Sans 3'),
  f('Atkinson Hyperlegible Next', 'humanist', 'barrierearm, eindeutige Formen', 'both', W(200, 800), true, 'Source Sans 3'),
  f('Commissioner', 'humanist', 'elegant-flämisch, fein', 'both', W(100, 900), false, 'Source Sans 3'),
  f('Nunito Sans', 'humanist', 'weich, freundlich, zugänglich', 'both', W(200, 900), true, 'Source Sans 3'),
  f('Mulish', 'humanist', 'minimalistisch, leicht, luftig', 'both', W(200, 900), true, 'Source Sans 3'),
  f('Alegreya Sans', 'humanist', 'kalligrafisch, literarisch, warm', 'both', [100, 300, 400, 500, 700, 800, 900], true, 'Source Sans 3', { pairs: ['Alegreya'] }),

  // Geometrisch: Kreis, Quadrat, konstruiert
  f('DM Sans', 'geometric', 'geometrisch-freundlich, Startup', 'both', W(100, 900), true, 'DM Sans', { flag: 'common' }),
  f('Manrope', 'geometric', 'modern-technisch, halbgeometrisch', 'both', W(200, 800), false, 'Manrope', { flag: 'common' }),
  f('Plus Jakarta Sans', 'geometric', 'freundlich-modern, SaaS', 'both', W(200, 800), true, 'Plus Jakarta Sans', { flag: 'common' }),
  f('Urbanist', 'geometric', 'streng geometrisch, architektonisch', 'both', W(100, 900), true, 'DM Sans'),
  f('Outfit', 'geometric', 'rund, weich, Vorlagen-Standard', 'both', W(100, 900), false, 'DM Sans', { flag: 'slop' }),
  f('Sora', 'geometric', 'Krypto-Geometrie, Vorlagen-Standard', 'both', W(100, 800), false, 'DM Sans', { flag: 'slop' }),

  // Condensed: Plakat, Sport, Leitsystem – nur für Titel
  f('Archivo Narrow', 'condensed', 'schmal-sachlich, Tabellen und Titel', 'both', W(400, 700), true, 'Archivo'),
  f('Barlow Condensed', 'condensed', 'Beschilderung, Autobahn, Verkehr', 'head', W(100, 900), true, 'Archivo', { pairs: ['Barlow', 'Inter'] }),
  f('Barlow', 'grotesk', 'rund-technisch, Kalifornien-Beschilderung', 'both', W(100, 900), true, 'Inter'),
  f('Big Shoulders', 'condensed', 'Chicago, Industrie, laut', 'head', W(100, 900), false, 'Archivo'),
  f('Antonio', 'condensed', 'schmal, elegant-streng, Kino', 'head', W(100, 700), false, 'Archivo'),
  f('Oswald', 'condensed', 'Plakat-Grotesk, sehr verbreitet', 'head', W(200, 700), false, 'Archivo', { flag: 'common' }),
  f('Anton', 'condensed', 'maximal laut, Schlagzeile', 'head', [400], false, 'Archivo'),
  f('League Gothic', 'condensed', 'historische Zeitungs-Condensed', 'head', [400], false, 'Archivo'),
  f('Bebas Neue', 'condensed', 'Versal-Plakat, Vorlagen-Standard', 'head', [400], false, 'Archivo', { flag: 'slop' }),

  // Serif (Text): Buch, Zeitung, Wissenschaft – ernst, glaubwürdig
  f('Source Serif 4', 'serif', 'sachlich-literarisch, vielseitig', 'both', W(200, 900), true, 'Georgia', { pairs: ['Source Sans 3', 'Inter'] }),
  f('IBM Plex Serif', 'serif', 'technisch-warm, Unternehmensbericht', 'both', W(100, 700), true, 'Georgia', { pairs: ['IBM Plex Sans'] }),
  f('Newsreader', 'serif', 'Zeitung, Feuilleton, fein und klar', 'both', W(200, 800), true, 'Georgia', { pairs: ['Inter', 'Public Sans', 'Work Sans'] }),
  f('Literata', 'serif', 'Buchsatz, ruhig, lange Texte', 'both', W(200, 900), true, 'Georgia', { pairs: ['Inter', 'Hanken Grotesk'] }),
  f('Crimson Pro', 'serif', 'Garalde, klassisch-literarisch', 'both', W(200, 900), true, 'Georgia'),
  f('EB Garamond', 'serif', 'Renaissance, Geisteswissenschaft, edel', 'both', W(400, 800), true, 'Georgia', { pairs: ['Work Sans', 'Libre Franklin'] }),
  f('Libre Caslon Text', 'serif', 'englische Tradition, Verlag, Kanzlei', 'both', [400, 700], true, 'Georgia'),
  f('Spectral', 'serif', 'fein, leicht, digital-elegant', 'both', W(200, 800), true, 'Georgia', { pairs: ['Work Sans', 'Inter'] }),
  f('Vollkorn', 'serif', 'kräftig, bodenständig, deutsch', 'both', W(400, 900), true, 'Georgia'),
  f('Alegreya', 'serif', 'kalligrafisch, literarisch, Kultur', 'both', W(400, 900), true, 'Georgia', { pairs: ['Alegreya Sans'] }),
  f('PT Serif', 'serif', 'robust, sachlich, osteuropäisch', 'both', [400, 700], true, 'Georgia'),
  f('Petrona', 'serif', 'eigenwillig, markant, zeitgenössisch', 'both', W(100, 900), true, 'Georgia'),
  f('Brygada 1918', 'serif', 'historisch, polnische Staatsschrift, würdig', 'both', W(400, 700), true, 'Georgia'),
  f('Libre Baskerville', 'serif', 'Baskerville, klassisch-verlässlich', 'both', W(400, 700), true, 'Georgia'),
  f('Lora', 'serif', 'kalligrafisch-weich, verbreitet', 'both', W(400, 700), true, 'Lora', { flag: 'common' }),
  f('Merriweather', 'serif', 'robust, Bildschirm-Serif, verbreitet', 'both', W(300, 900), true, 'Georgia', { flag: 'common' }),
  f('Georgia', 'serif', 'Office-Klassiker, seriös', 'both', [400, 700], true, 'Georgia', { flag: 'common', office: true }),

  // Display-Serif: große Titel, Magazin, Luxus – nie für Text
  f('Bodoni Moda', 'display-serif', 'Didone, Mode, Magazin-Cover', 'head', W(400, 900), true, 'Playfair Display', { pairs: ['Libre Franklin', 'Inter'] }),
  f('Libre Caslon Display', 'display-serif', 'feine Caslon für große Titel', 'head', [400], false, 'Playfair Display'),
  f('Gloock', 'display-serif', 'kontrastreich, dramatisch, Buchcover', 'head', [400], false, 'DM Serif Display'),
  f('Young Serif', 'display-serif', 'warm, gewichtig, Verlag der 70er', 'head', [400], false, 'DM Serif Display'),
  f('Noto Serif Display', 'display-serif', 'klassisch-elegant, feine Haarstriche', 'head', W(100, 900), true, 'Playfair Display'),
  f('Fraunces', 'display-serif', 'weich, retro, sehr verbreitet', 'head', W(100, 900), true, 'Fraunces', { flag: 'common' }),
  f('DM Serif Display', 'display-serif', 'kontrastreich, verbreitet', 'head', [400], true, 'DM Serif Display', { flag: 'common' }),
  f('Playfair Display', 'display-serif', 'Didone, sehr verbreitet', 'head', W(400, 900), true, 'Playfair Display', { flag: 'common' }),
  f('Cormorant Garamond', 'display-serif', 'zart, Hochzeit und Luxus, verbreitet', 'head', W(300, 700), true, 'Playfair Display', { flag: 'common' }),
  f('Instrument Serif', 'display-serif', 'Standard generierter Designs', 'head', [400], true, 'DM Serif Display', { flag: 'slop' }),
  f('Abril Fatface', 'display-serif', 'fette Didone, Vorlagen-Standard', 'head', [400], false, 'Playfair Display', { flag: 'slop' }),
  f('Cinzel', 'display-serif', 'Römer-Versalien, Kitschgefahr', 'head', W(400, 900), false, 'Playfair Display', { flag: 'slop' }),

  // Slab: Schreibmaschine, Werkstatt, Sachbuch
  f('Zilla Slab', 'slab', 'Werkstatt, Mozilla, direkt', 'both', W(300, 700), true, 'Georgia'),
  f('Bitter', 'slab', 'robust, Bildschirm-Slab, sachlich', 'both', W(100, 900), true, 'Georgia'),
  f('Aleo', 'slab', 'weich-serifenbetont, freundlich', 'both', W(100, 900), true, 'Georgia'),
  f('Besley', 'slab', 'Clarendon, Western-Plakat, markant', 'head', W(400, 900), true, 'Georgia'),
  f('Roboto Slab', 'slab', 'verbreitet, beliebig', 'both', W(100, 900), false, 'Georgia', { flag: 'common', license: 'Apache' }),

  // Mono: Daten, Technik, Protokoll – als Titel eines Datenblatts oder für Kennzahlen
  f('IBM Plex Mono', 'mono', 'technisch-warm, Datenblatt', 'both', W(100, 700), true, 'Inter'),
  f('JetBrains Mono', 'mono', 'Code, Entwickler, präzise', 'both', W(100, 800), true, 'Inter'),
  f('DM Mono', 'mono', 'weich, gestalterisch, Studio', 'both', [300, 400, 500], true, 'Inter'),
  f('Martian Mono', 'mono', 'breit, technisch, Raumfahrt', 'head', W(100, 800), false, 'Inter'),
  f('Geist Mono', 'mono', 'kühl, Entwickler-Ästhetik', 'both', W(100, 900), true, 'Inter'),
  f('Red Hat Mono', 'mono', 'freundlich-technisch', 'both', W(300, 700), true, 'Inter'),
  f('Space Mono', 'mono', 'Retro-Tech, Vorlagen-Standard', 'head', [400, 700], true, 'Inter', { flag: 'slop' }),

  // Office: in PowerPoint vorhanden, sehr neutral
  f('Arial', 'grotesk', 'Office-Standard, beliebig', 'both', [400, 700], true, 'Arial', { flag: 'common', office: true }),
  f('Calibri', 'humanist', 'Office-Standard, beliebig', 'both', [400, 700], true, 'Calibri', { flag: 'common', office: true }),
]

const byName = new Map(FONT_CATALOG.map((i) => [i.family.toLowerCase(), i]))
export const fontInfo = (name: string): FontInfo | undefined => byName.get(name.trim().toLowerCase())

// Zwischengewichte liefert Google als eigene Familie („Inter SemiBold“, Stil Regular); 400 und 700 gehören zur Familie selbst
export const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' }
export const instanceFamily = (family: string, weight: number) => (weight === 400 || weight === 700 ? family : `${family} ${WEIGHT_NAMES[weight]}`)

// nächstes verfügbares Gewicht (bei Gleichstand das schwerere, Titel sollen tragen)
export const nearestWeight = (info: FontInfo, weight: number) =>
  info.weights.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) || (Math.abs(w - weight) === Math.abs(best - weight) && w > best) ? w : best), info.weights[0])

// für Fehlermeldungen: „meintest du ‚Inter Tight‘?“ (Levenshtein auf Kleinbuchstaben ohne Leerzeichen)
export function suggestFont(name: string): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '')
  const a = norm(name)
  const dist = (b: string) => {
    const d = Array.from({ length: b.length + 1 }, (_, j) => j)
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]
      d[0] = i
      for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t }
    }
    return d[b.length]
  }
  const best = FONT_CATALOG.map((i) => ({ i, d: dist(norm(i.family)) })).sort((x, y) => x.d - y.d)[0]
  return best && best.d <= Math.max(2, Math.floor(a.length / 3)) ? best.i.family : undefined
}

// Kurzliste für den Systemprompt: eine Zeile je Familie, nach Kategorie gruppiert
export function catalogPrompt(): string {
  const cats: Record<FontCat, string> = { grotesk: 'Grotesk', humanist: 'Humanistisch', geometric: 'Geometrisch', condensed: 'Condensed (nur Titel)', serif: 'Serif (Text und Titel)', 'display-serif': 'Display-Serif (nur Titel)', slab: 'Slab', mono: 'Mono' }
  return (Object.keys(cats) as FontCat[]).map((c) => `${cats[c]}: ` + FONT_CATALOG.filter((i) => i.cat === c)
    .map((i) => `${i.family} (${i.mood}${i.role === 'head' ? ', nur Titel' : i.role === 'body' ? ', nur Text' : ''}; ${i.weights.length > 2 ? `${i.weights[0]}–${i.weights.at(-1)}` : i.weights.join('/')}${i.flag === 'slop' ? '; SLOP, nur auf Wunsch' : i.flag === 'common' ? '; verbreitet' : ''})`).join(' · ')).join('\n')
}
