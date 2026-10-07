import { wcagContrast } from 'culori'
import type { Box, BoxEl, Deck, El, FormatId, Gradient, ImgEl, Measured, TextEl } from './deck'
import { FORMATS, morphKey, morphNames, profileOf, sizeOf, transitionOf } from './deck'
import { LAYOUTS, buildOf } from './layouts'

export interface Issue {
  slide: number // 0-based index
  slideId: string
  slot?: string
  severity: 'error' | 'warn'
  rule: string
  message: string
}

const MARGIN = 24 // no text closer to the slide edge than this
export const AIRY = ['cover', 'section', 'statement', 'big-number', 'photo', 'quote', 'closing', 'blank'] // absichtlich luftig
// Grenzen je Profil (aus der Foliengröße): Folien werden projiziert, Social-Posts aufs Handy skaliert, A4 gedruckt und gelesen.
// Nur Folien haben Struktur-, Rhythmus- und Leere-Regeln; Karussells wiederholen Layouts mit Absicht, Dokumente sind dichter und ruhiger.
const PROFILE = {
  slides: { minPx: () => 13, words: 50, goal: 40, unit: 'Folie', deckRules: true },
  social: { minPx: (w: number) => w / 60, words: 30, goal: 25, unit: 'Folie', deckRules: false },
  doc: { minPx: () => 12, words: 350, goal: 300, unit: 'Seite', deckRules: false },
}
const SPARSE = 0.67 // Füllgrad des Satzspiegels, darunter wirkt eine Inhaltsfolie leer (kalibriert an echten KI-Decks: Prozess 65 %, Zeitstrahl 58 % leer; Tabelle 72 %, Pro/Contra 77 % gut)
const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
const wordsOf = (t: TextEl) => t.runs.map((r) => r.text).join(' ').split(/\s+/).filter(Boolean)

// ---------- KI-Merkmale im Text ----------
// Floskeln generierter Texte; Wortstamm + beliebige Endung, damit Flexionen greifen. „Hebel“ fehlt bewusst (oft legitim).
const FLOSKELN = /(?<![\p{L}\d])(nahtlos\p{L}*|ganzheitlich\p{L}*|innovativ(?:e[rnms]?)?|revolution[äa]r\p{L}*|maßgeschneidert\p{L}*|synergie\p{L}*|mehrwert(?!steuer)\p{L}*|auf (?:das |die )?nächsten? (?:level|stufe)|game[- ]?changer|in der heutigen (?:schnelllebigen )?(?:welt|zeit)|schnelllebig\p{L}*|entfessel\p{L}*|transformativ\p{L}*|potenzial\p{L}* (?:\p{L}+ )?(?:entfalt|freisetz|freizusetz|freigesetzt)\p{L}*|aus einer hand|zukunftssicher\p{L}*|state of the art|leuchtturm(?:projekt\p{L}*)?)(?![\p{L}\d])/giu
const EMOJI = /\p{Emoji_Presentation}/u // nur Bild-Emoji; Pfeile, Häkchen und ©®™ sind Satzzeichen
const NO_TEXT = new Set(['src', 'url', 'image', 'icon', 'qr']) // Bild-, Link- und Icon-Felder sieht niemand als Text
const textsOf = (v: unknown, key = ''): string[] =>
  NO_TEXT.has(key) ? [] : typeof v === 'string' ? [v.replace(/\*\*/g, '').replace(/\]\([^)]*\)/g, ']')]
    : Array.isArray(v) ? v.flatMap((x) => textsOf(x, key))
    : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => textsOf(x, k)) : []

// ---------- Text auf Foto: Kontrast gegen das Overlay über dem ungünstigsten Foto ----------
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const toHex = (c: number[]) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
const over = (base: string, color: string, alpha: number) => toHex(rgb(base).map((v, i) => v * (1 - alpha) + rgb(color)[i] * alpha))

// Farbe/Deckkraft des Verlaufs an Punkt (x, y); Verlaufslinie wie in CSS (Winkel 0 = nach oben).
function gradientAt(g: Gradient, b: Box, x: number, y: number): { color: string; alpha: number } {
  const r = (g.angle * Math.PI) / 180, sx = Math.sin(r), sy = -Math.cos(r)
  const len = Math.abs(b.w * sx) + Math.abs(b.h * sy)
  const p = Math.max(0, Math.min(1, ((x - b.x - b.w / 2) * sx + (y - b.y - b.h / 2) * sy) / len + 0.5))
  const i = Math.max(0, g.stops.findIndex((s) => s.pos >= p) - 1)
  const a = g.stops[i], z = g.stops[Math.min(i + 1, g.stops.length - 1)]
  const k = z.pos > a.pos ? Math.max(0, Math.min(1, (p - a.pos) / (z.pos - a.pos))) : 0
  return { color: over(a.color, z.color, k), alpha: a.alpha + (z.alpha - a.alpha) * k }
}

// Worst Case: helle Schrift über weißem, dunkle über schwarzem Foto, darüber alle Overlays (Scrim/Verlauf) in DOM-Reihenfolge.
// Ausgewertet an den vier Ecken der Textbox, zurück kommt die schlechteste Hintergrundfarbe.
function bgOverPhoto(t: TextEl, photo: ImgEl, els: El[]): string {
  const light = wcagContrast(t.runs[0]?.color ?? '#000000', '#000000') > wcagContrast(t.runs[0]?.color ?? '#000000', '#FFFFFF')
  const overlays = els.slice(els.indexOf(photo) + 1).filter((e): e is BoxEl => e.kind === 'box' && (!!e.fill || !!e.gradient) && overlapArea(e.box, t.box) > 0)
  const b = t.box
  const corners: [number, number][] = [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]
  const bgs = corners.map(([x, y]) =>
    overlays.reduce((acc, o) => {
      if (x < o.box.x || x > o.box.x + o.box.w || y < o.box.y || y > o.box.y + o.box.h) return acc
      const c = o.gradient ? gradientAt(o.gradient, o.box, x, y) : o.fill!
      return over(acc, c.color, c.alpha)
    }, light ? '#FFFFFF' : '#000000'),
  )
  return bgs.reduce((w, c) => (wcagContrast(t.runs[0]?.color ?? '#000000', c) < wcagContrast(t.runs[0]?.color ?? '#000000', w) ? c : w))
}

export function lintSlide(deck: Deck, i: number, m: Measured): Issue[] {
  const s = deck.slides[i]
  const prof = PROFILE[profileOf(deck)]
  const out: Issue[] = []
  const add = (severity: Issue['severity'], rule: string, message: string, slot?: string) =>
    out.push({ slide: i, slideId: s.id, slot, severity, rule, message })

  const def = LAYOUTS[s.layout as keyof typeof LAYOUTS]
  if (!def) {
    add('error', 'layout', `Unbekanntes Layout "${s.layout}". Erlaubt: ${Object.keys(LAYOUTS).join(', ')}`)
    return out
  }
  const sizes = (def as { sizes?: FormatId[] }).sizes
  const { w: pw, h: ph } = sizeOf(deck)
  if (sizes && !sizes.some((f) => FORMATS[f].w === pw && FORMATS[f].h === ph))
    add('warn', 'format', `Layout "${s.layout}" ist für ${sizes.map((f) => FORMATS[f].name).join(' oder ')} gedacht, das Deck hat ${pw}×${ph}. Format mit update_deck umstellen oder ein anderes Layout wählen.`)
  const parsed = def.schema.safeParse(s.content)
  if (!parsed.success)
    for (const e of parsed.error.issues) add('error', 'schema', `${e.path.join('.') || 'content'}: ${e.message}`, String(e.path[0] ?? ''))

  for (const o of m.fit.overflow) {
    const what = o.kind === 'lines' ? 'hat zu viele Zeilen' : o.kind === 'width' ? 'hat ein zu langes Wort' : `läuft um ${Math.round(o.overPx)} px über`
    add('error', 'overflow', `"${o.slot}" ${what}, auch in der kleinsten Schriftstufe. Text kürzen oder Inhalt auf zwei Folien verteilen.`, o.slot)
  }

  const texts = m.els.filter((e): e is TextEl => e.kind === 'text')
  // freie Elemente (items.*) platziert der Mensch bewusst, auch überlappend
  const solids = m.els.filter((e): e is Exclude<El, { kind: 'box' }> => e.kind !== 'box' && !(e.kind === 'img' && e.under) && !e.slot.startsWith('items.'))
  const photos = m.els.filter((e): e is ImgEl => e.kind === 'img' && !!e.under)
  for (const t of texts) {
    const b = t.box
    if (!t.slot.startsWith('items.') && (b.x < MARGIN || b.y < MARGIN || b.x + b.w > sizeOf(deck).w - MARGIN || b.y + b.h > sizeOf(deck).h - MARGIN))
      add('error', 'frame', `"${t.slot}" ragt in den Rand der Folie.`, t.slot)
    if (t.sizePx < prof.minPx(sizeOf(deck).w)) add('error', 'min-size', `"${t.slot}" ist mit ${Math.round(t.sizePx * 0.75)} pt zu klein.`, t.slot)
    const photo = photos.find((p) => overlapArea(p.box, b) > 4)
    const bg = photo ? bgOverPhoto(t, photo, m.els) : t.bg
    if (bg) {
      const big = t.sizePx >= 24 || (t.sizePx >= 18.6 && t.runs.some((r) => r.bold))
      for (const r of t.runs) {
        const ratio = wcagContrast(r.color, bg)
        if (ratio < (big ? 3 : 4.5)) {
          // freie Elemente: Hintergrund darunter (eigene Formen) kennt der DOM-Test nicht, daher nur Warnung
          add(t.slot.startsWith('items.') ? 'warn' : 'error', photo ? 'photo-contrast' : 'contrast', photo
            ? `"${t.slot}" liegt auf dem Foto und ist im ungünstigsten Fall kaum lesbar (${ratio.toFixed(1)}:1). Overlay verstärken oder Text auf eine Karte setzen.`
            : `"${t.slot}" hat zu wenig Kontrast (${ratio.toFixed(1)}:1).`, t.slot)
          break
        }
      }
    }
    if (t.font === 'head' && t.lines > 1) {
      const last = t.runs.map((r) => r.text + (r.breakAfter ? '\n' : ' ')).join('').trim().split('\n').pop() ?? ''
      if (last.trim().split(/\s+/).length === 1) add('warn', 'widow', `"${t.slot}" endet mit einem einzelnen Wort in der letzten Zeile – umformulieren.`, t.slot)
    }
  }
  for (let a = 0; a < solids.length; a++)
    for (let b = a + 1; b < solids.length; b++)
      if (overlapArea(solids[a].box, solids[b].box) > 4)
        add('error', 'overlap', `"${solids[a].slot}" überlappt "${solids[b].slot}".`, solids[a].slot)

  const count = texts.filter((t) => !t.slot.startsWith('_footer')).reduce((n, t) => n + wordsOf(t).length, 0) // Fußzeile (Kapitel, Seitenzahl) zählt nicht
  if (count > prof.words) add('warn', 'density', prof === PROFILE.slides
    ? `${count} Wörter auf der Folie – in 3 Sekunden nicht erfassbar (Ziel: unter 40). Kürzen, Rest in die Speaker Notes.`
    : `${count} Wörter auf der ${prof.unit} – zu viel für dieses Format (Ziel: unter ${prof.goal}). Kürzen oder auf eine weitere ${prof.unit} verteilen.`)
  if (/"(src|image)":""/.test(JSON.stringify(s.content ?? {}))) add('warn', 'image', 'Kein Bild gesetzt – es wird ein Platzhalter angezeigt. Mit find_images ein Foto suchen oder eigenes Bild einsetzen.')
  // Druck: Ein Querformat-Foto mit 2560 px, das per cover eine A4-Seite füllt, hat nur ~146 ppi. Logos (_-Slots) und kleine Bilder zählen nicht.
  if (profileOf(deck) === 'doc')
    for (const e of m.els) {
      if (e.kind !== 'img' || !e.src || !e.nat?.w || !e.nat.h || e.slot.startsWith('_') || e.box.w * e.box.h < (pw * ph) / 12) continue
      const c = e.crop ?? { w: 1, h: 1 } // Zuschnitt (freie Bilder): nur der Ausschnitt füllt die Box
      const r = [e.box.w / c.w / e.nat.w, e.box.h / c.h / e.nat.h] // CSS-px pro Bildpixel
      const ppi = Math.round(96 / (e.fit === 'cover' || e.crop ? Math.max(...r) : Math.min(...r)))
      if (ppi < 250) add('warn', 'print-res', `Foto für den Druck zu klein: ca. ${ppi} ppi bei A4-Größe (Druckereien verlangen 250–300 ppi). Hochformat-Foto nehmen (find_images orientation portrait), ein größeres Bild wählen oder das Foto kleiner einsetzen.`, e.slot)
    }
  // Live-Test: die KI lässt highlight trotz Schema-Hinweis weg, dann trägt keine Farbe die Aussage des Titels
  const chart = s.content?.chart
  if (chart && !chart.highlight && chart.categories?.length > 2 && chart.type !== 'waterfall')
    add('warn', 'highlight', 'Diagramm ohne highlight: Alle Werte sind gleich stark. Die Kategorie oder Serie, die der Titel meint, als highlight setzen.', 'chart')
  // Wirkt leer: Die Hülle aller Inhalte samt Titel (ohne Fußzeile, Fußnoten wie source/note, die unten stehen, und randlose
  // Hintergründe) bedeckt nur einen kleinen Teil des Satzspiegels. Der Nutzer empfand solche Folien als „sehr leer“; die KI sieht sie sonst nur im Bild.
  // Agenda ist Navigation; bei split füllt die Akzentfläche links, die nicht als Element gemessen wird; ein Bildfeld füllt seine
  // Hälfte auch als Platzhalter (dafür gibt es die Regel image)
  // Nicht zusammen mit density: Dann ist zu viel Text klein gesetzt, nicht zu wenig Inhalt da
  if (!AIRY.includes(s.layout) && s.layout !== 'agenda' && s.frame !== 'split' && !('image' in (s.content ?? {})) && count <= prof.words && prof.deckRules) {
    const { w: W, h: H } = sizeOf(deck)
    const used = m.els.filter((e) => !/^(_footer|source$|note$)/.test(e.slot) && e.box.w * e.box.h < 0.6 * W * H)
    if (used.length) {
      const [x0, y0] = [Math.min(...used.map((e) => e.box.x)), Math.min(...used.map((e) => e.box.y))]
      const [x1, y1] = [Math.max(...used.map((e) => e.box.x + e.box.w)), Math.max(...used.map((e) => e.box.y + e.box.h))]
      const fill = ((Math.min(x1, W - 72) - Math.max(x0, 72)) * (Math.min(y1, H - 72) - Math.max(y0, 60))) / ((W - 144) * (H - 132))
      if (fill < SPARSE) add('warn', 'sparse', `Folie wirkt leer: Titel und Inhalt füllen nur ${Math.round(fill * 100)} % des Satzspiegels. Mehr Substanz ergänzen (Zahl, Beispiel, Beleg), ein Foto dazunehmen (image-text), auf eine luftige Form wechseln (statement, big-number) oder mit der Nachbarfolie zusammenlegen.`)
    }
  }
  const found = new Set<string>()
  for (const t of textsOf(s.content)) {
    for (const f of t.matchAll(FLOSKELN)) found.add(`„${f[0]}“`)
    if (/\bnicht nur\b[^.!?]*\bsondern\b/i.test(t)) found.add('„nicht nur … sondern“')
    if (EMOJI.test(t)) found.add('Emoji')
  }
  if (found.size) add('warn', 'ki-sprache', `Klingt generiert: ${[...found].join(', ')}. Stattdessen konkret werden (Zahl, Name, Beispiel aus dem Material) und in eigenen Worten sagen, was passiert.`)
  return out
}

export function lintDeck(deck: Deck, measured: Measured[]): Issue[] {
  const out = deck.slides.flatMap((_, i) => lintSlide(deck, i, measured[i]))
  if (!PROFILE[profileOf(deck)].deckRules) return [...out, ...lintMotion(deck, measured)]
  const s = deck.slides
  const warn = (i: number, rule: string, message: string) => out.push({ slide: i, slideId: s[i].id, severity: 'warn', rule, message })
  if (s.length && s[0].layout !== 'cover') warn(0, 'structure', 'Das Deck beginnt nicht mit einer Titelfolie (cover).')
  if (s.length > 3 && s[s.length - 1].layout !== 'closing') warn(s.length - 1, 'structure', 'Das Deck endet nicht mit einer Abschlussfolie (closing).')
  for (let i = 2; i < s.length; i++)
    if (s[i].layout === s[i - 1].layout && s[i].layout === s[i - 2].layout)
      warn(i, 'rhythm', `Drittes "${s[i].layout}" in Folge – Layout abwechseln, damit das Deck lebendig bleibt.`)
  // Canva-Wirkung: drei gleich aufgebaute Folien ohne Bild hintereinander wirken wie eine Vorlage
  const look = (x: (typeof s)[number]) => !(LAYOUTS[x.layout as keyof typeof LAYOUTS] as { frames?: unknown })?.frames ? `-${x.id}` : `${x.frame ?? 'top'}|${x.tone ?? ''}|${JSON.stringify(x.content ?? {}).includes('"src":"asset') || !!x.bg?.image}`
  for (let i = 2; i < s.length; i++)
    if (look(s[i]).endsWith('false') && look(s[i]) === look(s[i - 1]) && look(s[i]) === look(s[i - 2]))
      warn(i, 'monotone', 'Dritte Folie in Folge mit gleicher Komposition, gleichem Ton und ohne Foto – ein Foto, eine luftige Folie (statement, big-number) oder einen anderen frame einsetzen.')
  // Merkmale generierter Decks: Kartenraster hintereinander, Icons als Schmuck, keine luftigen Folien
  const cards = (x: (typeof s)[number]) => x.variant === 'cards' || ['icon-grid', 'process', 'pricing', 'team'].includes(x.layout)
  for (let i = 1; i < s.length; i++)
    if (cards(s[i]) && cards(s[i - 1])) warn(i, 'cards', 'Zweites Kartenraster in Folge – wirkt wie generiert. Eine der Folien als Liste, Zahlenzeile, Statement oder Chart setzen.')
  const iconSlides = s.map((x, i) => (JSON.stringify(x.content ?? {}).includes('"icon":') ? i : -1)).filter((i) => i >= 0)
  if (iconSlides.length > 2) warn(iconSlides[2], 'icons', `Icons auf ${iconSlides.length} Folien – als Schmuck wirken sie generiert. Nur behalten, wo das Symbol selbst Information trägt.`)
  for (let i = 0, run = 0; i < s.length; i++) {
    run = AIRY.includes(s[i].layout) ? 0 : run + 1
    if (run === 5) warn(i, 'breath', 'Fünf dichte Folien in Folge – eine luftige Folie einschieben (statement, big-number oder photo mit einem Satz).')
  }
  // Generierte Dramaturgie: immer drei Punkte, Doppelpunkt- und Gedankenstrich-Titel
  const LISTS = ['bullets', 'process', 'timeline', 'kpi-grid', 'icon-grid', 'image-text', 'two-column'] // Stichpunkt-Layouts; Diagramme, Galerien, Preise zählen nicht
  const LIST_SKIP = ['columns', 'rows', 'criteria', 'options', 'quadrants', 'contact'] // Tabellen-/Matrixdaten, Kontaktzeilen
  const mainList = (x: (typeof s)[number]) => Object.entries(x.content ?? {}).find(([k, v]) => Array.isArray(v) && !LIST_SKIP.includes(k) && v.every((e) => typeof e === 'string' || (e && typeof e === 'object')))?.[1] as unknown[] | undefined
  const threes = s.map((x, i) => (LISTS.includes(x.layout) && mainList(x)?.length === 3 ? i : -1)).filter((i) => i >= 0)
  if (threes.length > 2) warn(threes[2], 'ki-muster', `Auf ${threes.length} Folien genau drei Punkte – immer genau drei wirkt generiert. So viele Punkte nehmen, wie das Material hergibt: zwei, vier, oder einen einzigen als Statement.`)
  const titles = s.map((x, i) => [i, x.content?.title] as const).filter((t): t is readonly [number, string] => typeof t[1] === 'string')
  const pattern = (re: RegExp, message: string) => {
    const hits = titles.filter(([, t]) => re.test(t))
    if (titles.length >= 3 && hits.length > titles.length / 3) warn(hits[0][0], 'ki-muster', `${hits.length} von ${titles.length} Titeln ${message}`)
  }
  pattern(/^[^:]{1,40}:\s+\S/, 'nach dem Muster „Stichwort: Aussage“ – wirkt generiert. Die Aussage als ganzen Satz schreiben, ohne Vorspann.')
  pattern(/ – |—/, 'mit Gedankenstrich – eine Häufung wirkt generiert. Lieber Punkt oder Komma, oder zwei Sätze daraus machen.')
  // Vorlagen-Muster: Ornamente ohne Information, gespiegelter Schluss, alle Titel gleich gebaut
  const plain = (v: unknown) => String(v ?? '').replace(/\*\*/g, '')
  const inhalt = s.map((x, i) => [i, x] as const).filter(([, x]) => !AIRY.includes(x.layout))
  const brows = inhalt.filter(([, x]) => plain(x.content?.eyebrow).trim())
  if (s.length >= 6 && brows.length > inhalt.length / 3)
    warn(brows[0][0], 'ornament', `Eyebrow auf ${brows.length} von ${inhalt.length} Inhaltsfolien – eine Überzeile über jedem Titel wirkt wie Vorlage. Nur dort setzen, wo es Orientierung gibt (Kapitel, Stand), sonst eyebrow weglassen.`)
  const src = (x?: (typeof s)[number]) => { const v = x?.content?.image; return typeof v === 'string' ? v : v?.src }
  const cover = src(s.find((x) => x.layout === 'cover'))
  s.forEach((x, i) => {
    if (cover && x.layout === 'closing' && src(x) === cover)
      warn(i, 'echo', 'Schluss wiederholt das Cover-Foto – der Bogen wirkt wie Vorlage. Ein anderes Bild (find_images) oder einen rein typografischen Schluss ohne image setzen.')
  })
  // ponytail: Titellänge in Zeichen statt gemessener Zeilen; über measured[i] (Zeilen des Slots title) genauer, falls die Regel daneben liegt
  const heads = inhalt.filter(([, x]) => typeof x.content?.title === 'string')
  const formel = heads.filter(([, x]) => plain(x.content.title).length >= 45 && plain(x.content.title).length <= 90)
  const stage = s.some((x) => x.layout === 'big-number' || (x.layout === 'statement' && plain(x.content?.text).length < 45) || (x.layout === 'photo' && plain(x.content?.title).length < 45))
  if (s.length >= 8 && heads.length && formel.length >= 0.8 * heads.length && !stage)
    warn(formel[0][0], 'titel-formel', `${formel.length} von ${heads.length} Titeln sind gleich gebaute Zwei- bis Dreizeiler – wirkt wie Vorlage. Ein bis zwei Folien mit kurzem Titel (höchstens 5 Wörter) bauen oder als Bühnenfolie (statement mit kurzem Satz, big-number, photo).`)
  // Mut: ein Mensch bricht mindestens einmal den Rhythmus
  const bold = (x: (typeof s)[number]) =>
    ((x.tone === 'accent' || x.tone === 'invert') && x.layout !== 'section') || x.layout === 'photo' ||
    (x.variant === 'poster' && ((x.layout === 'big-number' && !x.content?.image?.src) || (x.layout === 'statement' && String(x.content?.text ?? '').replace(/\*\*/g, '').length <= 60))) || // wie im Renderer: sonst fällt poster auf normal zurück
    (x.layout === 'cover' && x.variant === 'bottom' && !!x.content?.image?.src)
  if (s.length >= 8 && !s.some(bold))
    warn(0, 'mut', 'Kein mutiger Moment im Deck – alle Folien im gleichen Ton. Ein Mensch würde einmal den Rhythmus brechen: riesige Zahl auf Akzentfläche (big-number, tone accent oder Variante poster), eine Frage auf dunklem Grund (statement, tone invert), ein Vollbildfoto (photo).')
  return [...out, ...lintMotion(deck, measured)]
}

// Animation: Morph braucht gemeinsame Elemente, ein Übergangstyp pro Deck, der Vortrag soll nicht im Klicken stocken
export function lintMotion(deck: Deck, measured: Measured[]): Issue[] {
  const out: Issue[] = []
  const warn = (i: number, rule: string, message: string) => out.push({ slide: i, slideId: deck.slides[i].id, severity: 'warn', rule, message })
  const own = (k: number) => measured[k].els.map((e) => ({ slot: e.slot, key: morphKey(e) }))
  deck.slides.forEach((s, i) => {
    const t = transitionOf(deck, i)
    if (t === 'morph' && i > 0 && measured[i] && measured[i - 1]) {
      // Zuordnung wie in App und PPTX; Titel und Rahmen (Fußzeile) zählen nicht, die hat fast jede Folie
      const prev = own(i - 1)
      const before = new Set(prev.map((e) => e.slot))
      if (!morphNames(prev, own(i)).some((n) => before.has(n) && n !== 'title' && !n.startsWith('_')))
        warn(i, 'morph', 'Morph ohne gemeinsames Element mit der vorigen Folie (außer dem Titel) – wirkt nur wie Überblenden. Morph braucht wörtlich denselben Text (Agenda-Punkt = Kapiteltitel, Kennzahl = große Zahl), dasselbe Foto oder dasselbe Layout mit anderem focus/highlight; sonst transition weglassen.')
    }
    if (s.transition && !['morph', 'none', deck.transition].includes(s.transition))
      warn(i, 'transition', `Übergang ${s.transition} weicht vom Deck-Übergang ${deck.transition} ab. Ein Übergangstyp pro Deck; pro Folie nur morph.`)
    const m = measured[i]
    if (deck.mode !== 'click' || !m) return
    const groups = new Set(m.els.flatMap((e) => (e.build === undefined ? [] : [e.build]))).size
    const clicks = (buildOf(deck, i) === 'list' ? groups : 0) + m.els.filter((e) => e.anim && e.anim !== 'none' && e.anim !== 'breathe').length
    if (clicks > 5) warn(i, 'clicks', `${clicks} Klicks, bis die Folie steht – der Vortrag stockt. Aufbau stagger statt list, weniger animierte Elemente oder Folie teilen.`)
  })
  return out
}
