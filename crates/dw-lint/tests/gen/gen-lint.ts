// npx esbuild crates/dw-lint/tests/gen/gen-lint.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=${TMPDIR:-/tmp}/gen-lint.mjs && node ${TMPDIR:-/tmp}/gen-lint.mjs
// Fixtures für die Differenztests von dw-lint (aus /home/bayernator/deckwerk-design ausführen): lintDeck/lintSlide/lintMotion,
// typeset, klartext, Suchen/Ersetzen, Serienbrief, Handout, Theme-Lint. Zufall mit festem Seed, damit die Fixtures stabil bleiben.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Deck, El, Measured, Slide, TextEl, ThemeSpec } from '../../../../src/shared/deck'
import { lintDeck } from '../../../../src/shared/lint'
import { lintFilm } from '../../../../src/shared/film-lint'
import { LAYOUTS } from '../../../../src/shared/layouts'
import { resolveTheme } from '../../../../src/shared/themes'
import { typeset } from '../../../../src/shared/typo'
import { klartext } from '../../../../src/shared/klartext'
import { findInDeck, replaceInDeck } from '../../../../src/shared/find'
import { fillDeck, parseCsv, placeholders } from '../../../../src/shared/merge'
import { fmtSec, handout, speakSec } from '../../../../src/shared/handout'
import { axesOf, lintLooks, lintTheme } from '../../../../src/shared/theme-lint'
import { THEME_REFS } from '../../../../src/shared/theme-refs'
import { FONT_CATALOG } from '../../../../src/shared/font-catalog'

const ROOT = process.cwd()
const OUT = join(ROOT, 'crates/dw-lint/tests/fixtures')
const REFS = join(ROOT, 'tests/refs/beratung/16x9')

let seed = 20261018
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
const chance = (p: number) => rnd() < p
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1))
const clone = <T>(x: T): T => structuredClone(x)
// Pool: gleiche Decks, Messungen und Schema-Aufrufe stehen einmal in `pool`, die Fälle verweisen per {"$ref": n}
let pool: unknown[] = [], poolIdx = new Map<string, number>()
const ref = (x: unknown) => { const k = JSON.stringify(x); let i = poolIdx.get(k); if (i === undefined) { i = pool.length; pool.push(x); poolIdx.set(k, i) } return { $ref: i } }
const recRef = (r: Rec) => ref({ ...r, content: ref(r.content) }) // Inhalt teilt sich den Pool mit den Folien
const takePool = () => { const p = pool; pool = []; poolIdx = new Map(); return p }
const write = (name: string, data: unknown) => { writeFileSync(join(OUT, name), JSON.stringify(data)); console.log(name, JSON.stringify(data).length) }

// Schema-Aufrufe mitschneiden: Rust bekommt die zod-Ergebnisse als Eingabe
type Rec = { layout: string; content: unknown; issues: { path: string[]; message: string }[] }
let rec: Rec[] | null = null
for (const [id, def] of Object.entries(LAYOUTS) as [string, { schema: { safeParse: (c: unknown) => any } }][]) {
  const orig = def.schema.safeParse.bind(def.schema)
  def.schema.safeParse = (c: unknown) => {
    const r = orig(c)
    if (rec && !rec.some((x) => x.layout === id && JSON.stringify(x.content) === JSON.stringify(c)))
      rec.push({ layout: id, content: clone(c), issues: r.success ? [] : r.error.issues.map((i: any) => ({ path: i.path.map(String), message: i.message })) })
    return r
  }
}
const layouts = Object.entries(LAYOUTS).map(([id, d]: [string, any]) => ({ id, sizes: d.sizes, frames: !!d.frames, defaultBuild: d.defaultBuild }))
const examples: [string, Deck][] = readdirSync(join(ROOT, 'examples')).filter((f) => f.endsWith('.json')).sort().map((f) => [f, JSON.parse(readFileSync(join(ROOT, 'examples', f), 'utf8'))])

// ---------- Lint ----------
const lintCases: unknown[] = []
const lintCase = (name: string, deck: Deck, measured: Measured[]) => {
  rec = []
  let expected, film
  try {
    film = deck.film ? lintFilm(deck, measured) : []
    expected = lintDeck(deck, measured)
  } catch (e) { rec = null; console.log('übersprungen', name, String(e).slice(0, 80)); return }
  lintCases.push({ name, deck: ref({ ...deck, slides: deck.slides.map((x) => ({ ...x, content: ref(x.content) })) }), measured: measured.map((m) => ref({ ...m, els: m.els.map(ref) })), schema: rec.map(recRef), margin: resolveTheme(deck.theme).margin ?? null, film, expected: expected.map(ref) })
  rec = null
}
const empty = (): Measured => ({ els: [], fit: { ok: true, head: 0, body: 0, overflow: [] } })

const decks: Record<string, Deck> = JSON.parse(readFileSync(join(REFS, 'decks.json'), 'utf8'))
const refs = Object.keys(decks).sort().map((k) => [k, decks[k], JSON.parse(readFileSync(join(REFS, `${k}.measured.json`), 'utf8')) as Measured] as const)
for (const [k, d, m] of refs) lintCase(`ref ${k}`, d, [m])
// alle Referenzfolien als ein Deck (Rhythmus, Karten, Motion)
const all = (pre: string, f: (d: Deck, i: number) => Slide) => ({ ...refs[0][1], slides: refs.map(([, d], i) => ({ ...f(d, i), id: `${pre}${i}` })) })
lintCase('refs zusammen', all('s', (d) => d.slides[0]), refs.map(([, , m]) => m))
lintCase('refs zusammen morph', { ...all('m', (d) => ({ ...d.slides[0], transition: pick(['morph', 'fade', 'none', 'push']) as any })), transition: 'fade' }, refs.map(([, , m]) => m))

// Messungen verändern: Rand, Größe, Farben, Foto mit Overlays, Überlauf, Witwen, Druckauflösung
const COLORS = ['#FFFFFF', '#EEEEEE', '#BBBBBB', '#999999', '#777777', '#555555', '#16202B', '#5A6470', '#C4552D', '#FFDD00', '#0B6E4F', '#000000']
const box = (W: number, H: number) => ({ x: Math.round(rnd() * W * 0.9 * 100) / 100 - 10, y: Math.round(rnd() * H * 0.9 * 100) / 100 - 10, w: Math.round(rnd() * W * 0.7 + 4), h: Math.round(rnd() * H * 0.5 + 4) })
const SIZES = [{ w: 1280, h: 720 }, { w: 1080, h: 1350 }, { w: 794, h: 1123 }, { w: 960, h: 720 }, { w: 1080, h: 1080 }]
function vary(m: Measured, W: number, H: number): Measured {
  const v = clone(m)
  for (const e of v.els) {
    if (chance(0.25)) e.box = box(W, H)
    if (e.kind === 'text') {
      if (chance(0.3)) e.sizePx = pick([9, 11.5, 12, 13, 14, 17, 18.6, 20, 24, 30])
      if (chance(0.3)) for (const r of e.runs) r.color = pick(COLORS)
      if (chance(0.3)) e.bg = pick([...COLORS, ''])
      if (chance(0.2)) { e.font = 'head'; e.lines = int(1, 3); e.runs = e.runs.map((r, j) => ({ ...r, breakAfter: chance(0.5) || undefined, text: chance(0.3) && j === e.runs.length - 1 ? 'Wort' : r.text })) }
      if (chance(0.1)) e.slot = pick(['items.t1', '_footer.page', 'source', 'note', e.slot])
      if (chance(0.15)) e.runs.forEach((r) => (r.bold = chance(0.5)))
    }
  }
  if (chance(0.5)) {
    const photo: El = { kind: 'img', slot: 'image', box: { x: 0, y: 0, w: W * pick([1, 0.5]), h: H }, src: 'asset://p.jpg', radius: 0, fit: 'cover', focus: { x: 0.5, y: 0.5 }, under: true, nat: { w: pick([800, 2560, 4000]), h: pick([600, 1707, 6000]) } }
    const overlays: El[] = Array.from({ length: int(0, 2) }, () => (chance(0.5)
      ? { kind: 'box', slot: '_scrim', box: chance(0.5) ? { x: 0, y: 0, w: W, h: H } : box(W, H), radius: 0, ellipse: false, fill: { color: pick(COLORS), alpha: Math.round(rnd() * 100) / 100 } }
      : { kind: 'box', slot: '_grad', box: chance(0.5) ? { x: 0, y: 0, w: W, h: H } : box(W, H), radius: 0, ellipse: false, gradient: { angle: pick([0, 45, 90, 135, 180, 200, 270]), stops: [{ color: pick(COLORS), alpha: Math.round(rnd() * 100) / 100, pos: 0 }, ...(chance(0.5) ? [{ color: pick(COLORS), alpha: 0.5, pos: 0.4 }] : []), { color: pick(COLORS), alpha: Math.round(rnd() * 100) / 100, pos: pick([0.6, 1]) }] } }) as El)
    v.els.unshift(photo, ...overlays)
  }
  if (chance(0.3)) v.els.push({ kind: 'img', slot: pick(['image', '_logo', 'items.i']), box: box(W, H), src: pick(['asset://x.jpg', '']), radius: 0, fit: pick(['cover', 'contain']), focus: { x: 0.5, y: 0.5 }, nat: { w: pick([400, 1200, 3000]), h: pick([300, 900, 0]) }, ...(chance(0.3) ? { crop: { x: 0, y: 0, w: 0.5, h: 0.8 } } : {}) } as El)
  if (chance(0.3)) v.fit.overflow.push({ slot: pick(['title', 'body', 'items.0']), overPx: Math.round(rnd() * 4000) / 100, kind: pick(['height', 'width', 'lines']) })
  return v
}
for (const [k, d, m] of refs) for (let j = 0; j < 5; j++) {
  const size = pick(SIZES)
  const deck = { ...clone(d), ...(size.w === 1280 ? {} : { size }) }
  lintCase(`var ${k} ${j}`, deck, [vary(m, size.w, size.h)])
}

// Beispiel-Decks ohne Messung (Inhalts- und Deck-Regeln) und mit erfundener Messung
for (const [f, d] of examples) lintCase(`ex ${f}`, d, d.slides.map(empty))

// erfundene Decks: Layoutfolge, Titelmuster, Eyebrows, Icons, Echo, Mut, Morph, Klicks, Links
const LAYS = ['cover', 'bullets', 'statement', 'closing', 'big-number', 'photo', 'section', 'kpi-grid', 'icon-grid', 'process', 'two-column', 'chart', 'agenda', 'quote', 'image-text', 'timeline', 'pricing', 'team', 'gallery', 'blank', 'nope']
const TITLES = ['Q3-Review', 'Umsatz: Wir wachsen schneller als der Markt', 'Kosten sinken – trotz Inflation', 'Digitalisierung — der nächste Schritt', 'Ein nahtloser Prozess mit echtem Mehrwert für alle Beteiligten im Haus', 'Nicht nur schneller, sondern auch günstiger',
  'Unsere innovative Lösung bringt euch auf das nächste Level 🚀', 'Mehrwertsteuer sinkt', 'Drei Gründe, warum der Vertrieb jetzt umbauen muss und warum das gut ist', 'Wir sind da', 'Gamechanger im Mittelstand', 'Potenzial voll entfalten und **Synergien** heben']
const TEXTS = ['Kurz.', 'Wir liefern pünktlich.', 'Eine Frage: warum?', 'Das ist ein sehr langer Satz, der weit über sechzig Zeichen hinausgeht und damit kein Poster ist.', 'In der heutigen schnelllebigen Welt zählt jede Sekunde', 'Siehe [Bericht](https://x.de/innovativ)']
const IMG = ['asset://a.jpg', 'asset://b.jpg', '', 'https://x/y.png']
function slide(i: number): Slide {
  const layout = pick(LAYS)
  const c: Record<string, unknown> = {}
  if (chance(0.9)) c.title = pick(TITLES)
  if (chance(0.3)) c.eyebrow = pick(['Kapitel 1', '', '**Stand**', ' '])
  if (layout === 'statement' || layout === 'quote' || chance(0.2)) c.text = pick(TEXTS)
  if (chance(0.5)) c[pick(['items', 'points', 'columns', 'kpis', 'steps'])] = Array.from({ length: int(0, 5) }, () => (chance(0.5) ? pick(TEXTS) : { title: pick(TITLES), text: pick(TEXTS), ...(chance(0.3) ? { icon: 'star' } : {}) }))
  if (chance(0.3)) c.image = chance(0.5) ? { src: pick(IMG), focus: 'center' } : pick(IMG)
  if (chance(0.15)) c.chart = { type: pick(['bar', 'waterfall', 'line']), categories: ['A', 'B', 'C', 'D'].slice(0, int(1, 4)), series: [{ name: 'S', values: [1, 2, 3, 4] }], ...(chance(0.3) ? { highlight: 'B' } : {}) }
  const s: any = { id: `x${i}`, layout, content: c }
  if (chance(0.3)) s.variant = pick(['cards', 'poster', 'bottom', 'list'])
  if (chance(0.3)) s.tone = pick(['accent', 'invert', 'normal'])
  if (chance(0.2)) s.frame = pick(['top', 'split', 'band'])
  if (chance(0.1)) s.bg = { image: pick(IMG) }
  if (chance(0.3)) s.transition = pick(['morph', 'fade', 'none', 'push'])
  if (chance(0.2)) s.build = pick(['list', 'stagger', 'fade'])
  if (chance(0.3)) s.notes = pick(['', 'Kurz erklären.', 'Hier erzählen wir die Geschichte vom Anfang bis zum Ende, ganz in Ruhe. '.repeat(int(1, 30))])
  if (chance(0.3)) s.items = Array.from({ length: int(1, 4) }, (_, k) => ({ id: `it${k}`, kind: pick(['text', 'image', 'shape']), x: 10, y: 10, w: 100, h: 50,
    ...(chance(0.5) ? { anim: pick(['fade', 'none', 'breathe', 'pop']) } : {}), ...(chance(0.3) ? { animStart: pick(['click', 'with', 'after']) } : {}),
    ...(chance(0.3) ? { link: pick(['#1', '#0', '#99', 'https://x.de', '#2']) } : {}), ...(chance(0.5) ? { alt: pick(['', ' ', 'Bild']) } : {}), text: pick(TEXTS) }))
  return s
}
const WORDS = ['Wir', 'wachsen', 'Umsatz', 'Q3', 'Kunden', 'innovativ', 'Plan', 'Ziel', 'Team']
function measure(s: Slide, W: number, H: number): Measured {
  const els: El[] = Array.from({ length: int(0, 6) }, (_, k) => {
    if (chance(0.15)) return { kind: 'img', slot: pick(['image', 'g.0', 'g.1']), box: box(W, H), src: pick(IMG), radius: 0, fit: 'cover', focus: { x: 0.5, y: 0.5 }, build: chance(0.5) ? int(0, 6) : undefined } as El
    const t: TextEl = { kind: 'text', slot: pick(['title', 'eyebrow', `body.${k}`, `items.${k}`, '_footer.page', 'kpi.0']), box: { x: 72, y: 60 + k * 60, w: int(100, 1000), h: 40 }, font: pick(['head', 'body']), role: 'body', sizePx: 20, lineHeightPx: 24, trackingPx: 0,
      align: 'left', upper: false, runs: [{ text: Array.from({ length: int(1, 12) }, () => pick(WORDS)).join(' '), bold: false, italic: false, color: '#16202B' }], lines: 1, bg: '#FFFFFF', ...(chance(0.6) ? { build: int(0, 8) } : {}) }
    if (chance(0.3)) t.runs[0].text = String((s.content as any)?.title ?? 'Titel')
    return t
  })
  return { els, fit: { ok: true, head: 0, body: 0, overflow: [] } }
}
for (let j = 0; j < 160; j++) {
  const n = int(1, 14), size = chance(0.8) ? SIZES[0] : pick(SIZES)
  const deck: any = { title: `Deck ${j}`, theme: { id: pick(['beratung', 'keynote', 'editorial']) }, transition: pick(['fade', 'none', 'push', 'morph']), mode: pick(['click', 'click', 'auto']), slides: Array.from({ length: n }, (_, i) => slide(i)) }
  if (size.w !== 1280) deck.size = size
  if (chance(0.4)) deck.motion = pick(['none', 'calm', 'lively'])
  if (chance(0.1)) deck.slides[0].layout = 'clip'
  if (chance(0.3)) deck.slides[0].layout = 'cover'
  if (chance(0.3)) deck.slides[n - 1].layout = 'closing'
  lintCase(`syn ${j}`, deck, deck.slides.map((s: Slide) => measure(s, size.w, size.h)))
}
// gezielt: Echo des Cover-Fotos, Klicks bis die Folie steht
const img = { src: 'asset://same.jpg' }
const echo: any = { title: 'Echo', theme: { id: 'beratung' }, transition: 'fade', mode: 'click', slides: [
  { id: 'a', layout: 'cover', variant: 'bottom', content: { title: 'Start', image: img } },
  { id: 'b', layout: 'bullets', build: 'list', content: { title: 'Punkte', items: ['a', 'b'] }, items: Array.from({ length: 3 }, (_, k) => ({ id: `i${k}`, kind: 'text', x: 0, y: 0, w: 10, h: 10, text: 'x', anim: 'fade' })) },
  { id: 'c', layout: 'closing', content: { title: 'Ende', image: img } },
  { id: 'd', layout: 'closing', content: { title: 'Ende', image: 'asset://same.jpg' } }] }
const clicks = (n: number): Measured => ({ els: Array.from({ length: n }, (_, k) => ({ kind: 'text', slot: `items.${k}`, box: { x: 72, y: 60 + k * 30, w: 300, h: 24 }, font: 'body', role: 'body', sizePx: 20, lineHeightPx: 24, trackingPx: 0, align: 'left', upper: false, runs: [{ text: `Punkt ${k}`, bold: false, italic: false, color: '#16202B' }], lines: 1, bg: '#FFFFFF', build: k } as El)), fit: { ok: true, head: 0, body: 0, overflow: [] } })
for (const n of [0, 2, 3, 6]) lintCase(`echo/klicks ${n}`, echo, [empty(), clicks(n), empty(), empty()])
write('lint.json', { layouts, pool: takePool(), cases: lintCases })

// ---------- typeset, klartext ----------
const strings = new Set<string>()
const walkStr = (v: unknown, f: (s: string) => void) => {
  if (typeof v === 'string') f(v)
  else if (Array.isArray(v)) v.forEach((x) => walkStr(x, f))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => walkStr(x, f))
}
for (const [, d] of examples) walkStr(d, (s) => strings.add(s))
const SENT = ['Er sagte "Hallo" und ging.', '"Zitat" am Anfang', 'Ein 24" Monitor', 'Unpaarig "offen', 'Das geht\'s gut', 'Rock \'n\' Roll', 'Ergebnis - gut', 'x - 3', 'Ziel – erreicht', 'Text (Klammer) - Rest',
  '50 %', '50%', '3 ‰', '10 €', '1,5 Mio. €', '3 Mrd. Euro', '5 km', '5 kmh', '5 Mio.x', '2 h', '20 Min. Pause', 'z.B. hier', 'z. B. dort', 'd.h. so', 'u. a. auch', 'Nr. 5', 'Nr.5', 'S. 12', 'S 12', 'NR. 5',
  '2019-2024', 'ISO 9001-2015', 'SKU 12-345', 'Tel. 2019-2020', '5-10 %', '10-12 Uhr', '3-4 Jahren', '3-4 Jahre', '2-3 Monate lang', '12-345', '1,5-2,5 Mio. Euro', '1000-2000 €', 'Seite 3-5 Seiten', 'Art. 3-5 Tage',
  'https://example.com/a-b "x"', 'Mail an max@firma.de - bitte', '/home/user/datei.txt', 'Pfad /usr/bin - hier', 'www.firma.de - Info', 'asset://bild-1.png', 'data:image/png;base64,AAA', 'Wert  seltsam', '"𝐀 nach Anführungszeichen"', '("𝐀") und "a"',
  'Die "Lösung" - endlich - da', '"A" und "B"', 'Er: "Ja"', '"', '""', 'a"b', '2020-2021-2022', '19-20 Uhr', '5-6 Schüler', '5-6 Schülerin', '3-5°C', '10-20 % mehr', '7 - 8 Stunden', 'Ende.']
for (const s of SENT) strings.add(s)
const FRAG = [...SENT, 'und', ' ', ' - ', '"', '\'', '5', ' %', 'Mio.', ' €', 'z.', 'B.', '-', '2020', '2021', 'Nr.', 'S.', ' h', '–', ' ', 'äöü', 'Straße']
for (let j = 0; j < 600; j++) strings.add(Array.from({ length: int(1, 5) }, () => pick(FRAG)).join(pick(['', ' '])))
const KLAR = ['400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  'Claude Code beendet (Code 1): Invalid API key · Please run /login', 'Not logged in · Please run /login', 'Codex ist nicht angemeldet. Einmal im Terminal `codex login` ausführen.', '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  '429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit', 'Claude AI usage limit reached|1759600000', 'TypeError: fetch failed', 'getaddrinfo ENOTFOUND api.anthropic.com', 'Anfrage abgelehnt', 'Antwort abgeschnitten (max_tokens). Bitte „weiter“ senden.',
  'Error 4010', 'HTTP 503 Service Unavailable', 'BILLING issue', 'insufficient_quota', 'rate limit', 'ratelimit', 'Network Error', 'networkerror', 'OAuth token has expired', 'oauth token expired', 'Unauthorized', 'x401y', 'ä401', '', 'rate\rlimit', 'rate limit', 'rate\nlimit', 'rate-limit', 'inſufficient credit', 'UNAUTHORIZED', 'insufficient quota']
write('text.json', { typeset: [...strings].map((s) => [s, typeset(s)]), klartext: KLAR.map((s) => [s, klartext(s)]) })

// ---------- Suchen & Ersetzen ----------
const findCases: unknown[] = []
for (const [f, d] of examples) {
  const words: string[] = []
  walkStr(d.slides.map((s) => s.content), (s) => words.push(...s.split(/\s+/).filter((w) => w.length > 2)))
  const qs = [...Array.from({ length: 6 }, () => pick(words.length ? words : ['x'])), 'e', 'Die', 'zzz', '', '(', 'https', '.']
  for (const q of qs) {
    const opts = { caseSensitive: chance(0.4), wholeWord: chance(0.4) }
    rec = []
    const hits = findInDeck(d, q, opts)
    const replacement = pick(['', 'X', 'Ersatz-Text', 'sehr '.repeat(int(20, 80)), q.toUpperCase()])
    const only = hits.length && chance(0.5) ? pick(hits) : undefined
    const r = replaceInDeck(d, q, replacement, opts, only && { slide: only.slide, where: only.where, n: only.n })
    // out: nur, was sich geändert hat (Titel, Folien nach Index)
    const out = r.deck === d ? null : { title: r.deck.title, slides: Object.fromEntries(r.deck.slides.flatMap((x, i) => (JSON.stringify(x) === JSON.stringify(d.slides[i]) ? [] : [[i, x]]))) }
    findCases.push({ deck: f, query: q, opts, hits, replacement, only: only ? { slide: only.slide, where: only.where, n: only.n } : null, out, skipped: r.skipped, schema: rec.map(ref) })
    rec = null
  }
}
write('find.json', { examples: Object.fromEntries(examples), pool: takePool(), cases: findCases })

// ---------- Serienbrief ----------
const CSV = ['Name,Firma\nAnna,ACME\nBen,"Müller, GmbH"\n', '﻿Name;Ort\r\nAnna;"Ber""lin"\r\n;\r\nCarl;Köln', 'a,b;c;d\n1,2;3;4', 'x\n', '', '"Na,me";Wert\n"a\nb";2', 'Name, Firma \n Anna , ACME ,extra\nBo', 'k,k\n1,2', 'a,"b"c,d\n1,2,3', 'Name\n"offen']
const CELL = ['Anna', 'Müller, GmbH', 'Ber"lin', 'x;y', 'Zeile\nneu', ' Leer ', '', '€', '{{Name}}']
for (let j = 0; j < 80; j++) {
  const sep = pick([',', ';']), nl = pick(['\n', '\r\n', '\r'])
  const q = (c: string) => (/[,;"\n\r]/.test(c) || chance(0.2) ? `"${c.replace(/"/g, '""')}"` : c)
  CSV.push(Array.from({ length: int(1, 5) }, () => Array.from({ length: int(1, 4) }, () => q(pick(CELL))).join(sep)).join(nl) + (chance(0.5) ? nl : ''))
}
const PHS = ['{{Name}}', '{{ Firma }}', '{{Ort}}', '{{Unbekannt}}', '{{ }}', '{{a{b}}', '{{Name}} und {{Firma}}']
const merges: unknown[] = []
for (const [f, d0] of examples) for (let j = 0; j < 3; j++) {
  const d = clone(d0)
  const inject = (s: string) => (chance(0.25) ? s + ' ' + pick(PHS) : s)
  d.title = inject(d.title)
  for (const s of d.slides) {
    const w = (v: any): any => (typeof v === 'string' ? inject(v) : Array.isArray(v) ? v.map(w) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, w(x)])) : v)
    s.content = w(s.content)
    if (s.notes !== undefined || chance(0.3)) s.notes = inject(s.notes ?? '')
    for (const it of s.items ?? []) { if (it.text) it.text = inject(it.text); if (it.cells) it.cells = it.cells.map((r) => r.map(inject)) }
  }
  const row: [string, string][] = [['Name', pick(['Anna', '', '$1 & $&'])], ['Firma', 'ACME'], ...(chance(0.5) ? [['Ort', 'Köln'] as [string, string]] : [])]
  merges.push({ deck: d, row, out: fillDeck(d, Object.fromEntries(row)), placeholders: placeholders(d) })
}
write('merge.json', { csv: CSV.map((t) => [t, parseCsv(t).map((r) => Object.entries(r))]), fill: merges })

// ---------- Handout ----------
const hand = examples.map(([f, d]) => ({ name: f, deck: d, md: handout(d) }))
for (let j = 0; j < 40; j++) {
  const d: any = { title: `H${j}`, theme: { id: 'beratung' }, slides: Array.from({ length: int(1, 6) }, (_, i) => slide(i)) }
  for (const s of d.slides) if (chance(0.3)) s.items = [...(s.items ?? []), { id: 'tb', kind: 'table', x: 0, y: 0, w: 10, h: 10, cells: [['A|b', 'Zeile\n\nzwei'], ['1', '2'], ['x']] }]
  hand.push({ name: `syn ${j}`, deck: d, md: handout(d) })
}
const notes = [undefined, '', 'eins zwei', ...examples.flatMap(([, d]) => d.slides.map((s) => s.notes)), 'Wort '.repeat(130), 'Wort '.repeat(65), 'Wort '.repeat(1000)]
write('handout.json', { cases: hand, speak: notes.map((n) => [n ?? null, speakSec(n), fmtSec(speakSec(n))]) })

// ---------- Theme ----------
const FONTS = FONT_CATALOG.map((f) => f.family)
const hex = () => '#' + Array.from({ length: 3 }, () => int(0, 255).toString(16).padStart(2, '0')).join('').toUpperCase()
const near = (h: string) => '#' + [1, 3, 5].map((i) => Math.max(0, Math.min(255, parseInt(h.slice(i, i + 2), 16) + int(-12, 12))).toString(16).padStart(2, '0')).join('')
const BGS = ['#FFFFFF', '#FAFAF8', '#F3F2EF', '#F6F1E7', '#EDE9FE', '#121214', '#0B0B0B', '#0B1B34', '#0F172A', '#8A8A8A', '#F7F3EC', '#101820']
const ACC = ['#C4552D', '#C6FF00', '#C9A227', '#22D3EE', '#6366F1', '#7C3AED', '#4472C4', '#0D6EFD', '#10B981', '#0B6E4F', '#151515', '#7FB800', '#8B5CF6', '#FF0055']
const specs: ThemeSpec[] = THEME_REFS.map((r) => r.spec)
for (let j = 0; j < 400; j++) {
  const accent = chance(0.5) ? near(pick(ACC)) : chance(0.5) ? pick(ACC) : hex()
  const s: any = { name: `T${j}`, bg: chance(0.6) ? (chance(0.5) ? near(pick(BGS)) : pick(BGS)) : hex(), accent, headFont: chance(0.9) ? pick(FONTS) : pick(['Interr', 'Comic Sans', 'newsreader', ' Inter ', 'Space Grotesque']), bodyFont: chance(0.9) ? pick(FONTS) : pick(['Publc Sans', 'Arail', 'Foo']),
    radius: pick([0, 2, 6, 8, 12]), decor: pick(['none', 'none', 'dots', 'waves']) }
  if (chance(0.3)) s.text = chance(0.5) ? pick(['#111111', '#16202B', '#777777', '#EEEEEE']) : hex()
  if (chance(0.3)) s.field = chance(0.5) ? near(accent) : hex()
  if (chance(0.3)) s.headWeight = pick([300, 400, 500, 600, 700, 800, 900])
  if (chance(0.3)) s.titleSize = pick(['normal', 'large', 'huge'])
  if (chance(0.3)) s.measure = pick(['narrow', 'standard', 'wide'])
  if (chance(0.3)) s.margin = pick(['standard', 'generous', 'asymmetric'])
  if (chance(0.2)) s.vivid = true
  if (chance(0.1)) s.texture = 'grain'
  if (chance(0.2)) s.accent2 = hex()
  if (chance(0.2)) s.chart = pick(['focus', 'duo', 'tonal'])
  if (chance(0.3)) s.signature = { kind: pick(['none', 'rule', 'edge', 'passepartout']) }
  if (chance(0.3)) s.heroTone = pick(['normal', 'field', 'invert'])
  specs.push(s)
}
const themeCases = specs.map((s) => {
  const opts = { override: chance(0.2), brand: chance(0.2) ? { accent: chance(0.5), headFont: chance(0.5), bodyFont: chance(0.5) } : {} }
  return { spec: s, opts, issues: lintTheme(s, opts), axes: axesOf(s) }
})
const groups = [THEME_REFS.map((r) => r.spec), ...Array.from({ length: 60 }, () => Array.from({ length: int(2, 5) }, () => pick(specs)))]
const fontCatalog = FONT_CATALOG.map(({ family, cat, role, weights, flag }) => ({ family, cat, role, weights, flag }))
write('theme.json', { fonts: fontCatalog, cases: themeCases, looks: groups.map((g) => ({ specs: g, issues: lintLooks(g.map(axesOf)) })) })
