// Dreiseitiges Zusammenführen für „Gemeinsam bearbeiten“: npx esbuild scripts/check-merge3.ts --bundle --platform=node --format=esm --outfile=out/check-merge3.mjs && node out/check-merge3.mjs
import { deepStrictEqual as eq, ok, throws } from 'node:assert'
import { pathToFileURL } from 'node:url'
import type { Deck, Slide } from '../src/shared/deck'
import { canonJson, isAssetRel, merge3, mergeDeck, portableDeck, portablePath, rebase, sanitize } from '../src/shared/merge3'

const dir = '/home/anna/Gemeinsam/Pitch Ä'
const url = (abs: string) => `asset://local${pathToFileURL(abs).pathname}` // wie assetUrl in tools.ts
const slide = (id: string, content: any = { title: id }, extra: Partial<Slide> = {}): Slide => ({ id, layout: 'statement', content, ...extra })
const deck = (...slides: Slide[]): Deck => ({ title: 'Pitch', theme: { id: 'beratung' }, transition: 'fade', mode: 'click', slides })
const ids = (d: Deck) => d.slides.map((s) => s.id)
const m = (b: Deck, l: Deck, t: Deck) => mergeDeck(b, l, t, dir)
let faelle = 0
const fall = (f: () => void) => { f(); faelle++ }

// portablePath: Datei im Deck-Ordner → assets/<name>, fremde Datei → assets/<fnv>-<name>, Rest unverändert
fall(() => {
  eq(portablePath(url(`${dir}/assets/foto ü.png`), dir), 'assets/foto ü.png')
  const fremd = portablePath(url('/home/anna/Deckwerk/assets/foto ü.png'), dir)
  ok(/^assets\/[0-9a-f]{8}-foto ü\.png$/.test(fremd), fremd)
  ok(fremd !== portablePath(url('/home/bert/Deckwerk/assets/foto ü.png'), dir), 'gleicher Name, anderer Ordner muss anders heißen')
  eq(portablePath(url(`${dir}/assets/sub/x.png`), dir), portablePath(url(`${dir}/assets/sub/x.png`), dir))
  ok(portablePath(url(`${dir}/assets/sub/x.png`), dir) !== 'assets/sub/x.png')
  for (const v of ['assets/x.png', 'data:image/png;base64,AAAA', 'Titel', '', 'https://x.de/a.png']) eq(portablePath(v, dir), v)
  eq(portablePath(url('C:\\Daten\\Pitch\\assets\\a.png'.replace(/\\/g, '/').replace(/^/, '/')), 'C:\\Daten\\Pitch'), 'assets/a.png') // Windows-Ordner
})

// portableDeck: Kopie, Eingabe unverändert, auch Logo und eigene Schrift
fall(() => {
  const d: Deck = { ...deck(slide('a', { title: 'A', image: { src: url(`${dir}/assets/f.jpg`) } }, { bg: { image: url('/tmp/hg.png') }, items: [{ id: 'i', kind: 'video', x: 0, y: 0, w: 1, h: 1, src: url(`${dir}/assets/v.mp4`), poster: url(`${dir}/assets/v.jpg`) }] })),
    theme: { id: 'x', brand: { primary: '#000000', logo: url(`${dir}/assets/logo.svg`) }, customFont: { family: 'F', regular: url(`${dir}/assets/f.ttf`) } } }
  const vorher = JSON.stringify(d)
  const p = portableDeck(d, dir)
  eq(JSON.stringify(d), vorher)
  eq(p.slides[0].content.image.src, 'assets/f.jpg')
  ok(/^assets\/[0-9a-f]{8}-hg\.png$/.test(p.slides[0].bg!.image!))
  eq([p.slides[0].items![0].src, p.slides[0].items![0].poster, p.theme.brand!.logo, p.theme.customFont!.regular], ['assets/v.mp4', 'assets/v.jpg', 'assets/logo.svg', 'assets/f.ttf'])
})

// canonJson: Schlüsselreihenfolge egal, undefined wie fehlend, Pfade portabel
fall(() => {
  eq(canonJson({ b: 1, a: [1, { y: 2, x: 'z' }] }, dir), canonJson({ a: [1, { x: 'z', y: 2 }], b: 1 }, dir))
  eq(canonJson({ a: 1, b: undefined }, dir), canonJson({ a: 1 }, dir))
  ok(canonJson({ a: 1 }, dir) !== canonJson({ a: '1' }, dir))
  eq(canonJson({ src: url(`${dir}/assets/x.png`) }, dir), canonJson({ src: 'assets/x.png' }, dir))
  const o = { a: 1 }
  eq(canonJson(o, dir), canonJson(o, dir)) // Cache
})

const B = deck(slide('a', { title: 'A', text: 'eins', bullets: ['x', 'y'] }), slide('b'), slide('c'))

// verschiedene Folien geändert → beide drin
fall(() => {
  const l = deck(slide('a', { ...B.slides[0].content, title: 'A neu' }), B.slides[1], B.slides[2])
  const t = deck(B.slides[0], B.slides[1], slide('c', { title: 'C neu' }))
  const r = m(B, l, t)
  eq([r.deck.slides[0].content.title, r.deck.slides[2].content.title, r.konflikte], ['A neu', 'C neu', 0])
  ok(r.deck.slides[0] === l.slides[0] && r.deck.slides[2] === t.slides[2], 'unveränderte Teilbäume per Referenz')
})

// gleiche Folie, verschiedene Felder → beide drin; gleiches Feld verschieden → mine gewinnt
fall(() => {
  const l = deck(slide('a', { ...B.slides[0].content, title: 'mein Titel' }), B.slides[1], B.slides[2])
  const t = deck(slide('a', { ...B.slides[0].content, text: 'fremder Text' }), B.slides[1], B.slides[2])
  const r = m(B, l, t)
  eq([r.deck.slides[0].content.title, r.deck.slides[0].content.text, r.konflikte], ['mein Titel', 'fremder Text', 0])
  const t2 = deck(slide('a', { ...B.slides[0].content, title: 'fremder Titel' }), B.slides[1], B.slides[2])
  const r2 = m(B, l, t2)
  eq([r2.deck.slides[0].content.title, r2.konflikte], ['mein Titel', 1])
  const pfade: string[] = []
  merge3(B, l, t2, { onConflict: (p) => pfade.push(p) })
  eq(pfade, ['/slides/a/content/title'])
})

// Folie eingefügt, gelöscht, beidseitig gelöscht, gelöscht vs. geändert
fall(() => {
  const x = slide('x')
  eq(ids(m(B, B, deck(B.slides[0], x, B.slides[1], B.slides[2])).deck), ['a', 'x', 'b', 'c'])
  eq(ids(m(B, deck(B.slides[0], B.slides[2]), deck(x, ...B.slides)).deck), ['x', 'a', 'c']) // in mine gelöscht, theirs fügt vorne ein
  eq(ids(m(B, deck(B.slides[0], B.slides[2]), deck(B.slides[0], B.slides[2])).deck), ['a', 'c'])
  eq(ids(m(B, B, deck(B.slides[0], B.slides[2])).deck), ['a', 'c']) // nur theirs löscht
  const geaendert = deck(B.slides[0], slide('b', { title: 'B neu' }), B.slides[2])
  const r1 = m(B, deck(B.slides[0], B.slides[2]), geaendert) // mine löscht, theirs ändert → mine gewinnt
  eq([ids(r1.deck), r1.konflikte], [['a', 'c'], 1])
  const r2 = m(B, geaendert, deck(B.slides[0], B.slides[2])) // mine ändert, theirs löscht → bleibt
  eq([ids(r2.deck), r2.deck.slides[1].content.title, r2.konflikte], [['a', 'b', 'c'], 'B neu', 1])
})

// Reihenfolge: nur theirs → theirs, nur mine → mine, beide → mine; neue Folien an ihrer Stelle
fall(() => {
  const [a, b, c] = B.slides
  eq(ids(m(B, deck(a, slide('b', { title: 'B neu' }), c), deck(c, a, b)).deck), ['c', 'a', 'b'])
  eq(m(B, deck(a, slide('b', { title: 'B neu' }), c), deck(c, a, b)).deck.slides[2].content.title, 'B neu')
  eq(ids(m(B, deck(b, a, c), deck(a, b, slide('c', { title: 'C neu' }))).deck), ['b', 'a', 'c'])
  eq(ids(m(B, deck(b, a, c), deck(c, b, a)).deck), ['b', 'a', 'c'])
  eq(ids(m(B, deck(a, b, c, slide('m')), deck(c, a, b)).deck), ['c', 'm', 'a', 'b']) // eigene neue Folie bleibt hinter ihrem Vorgänger
  eq(ids(m(B, deck(b, a, c), deck(a, b, slide('t'), c)).deck), ['b', 't', 'a', 'c'])
})

// items: Element nur in theirs verschoben, in mine Text geändert → beides
fall(() => {
  const it = { id: 'i1', kind: 'text' as const, x: 10, y: 10, w: 100, h: 20, text: 'Hallo' }
  const b = deck(slide('a', { title: 'A' }, { items: [it, { ...it, id: 'i2' }] }))
  const l = deck(slide('a', { title: 'A' }, { items: [{ ...it, text: 'Servus' }, { ...it, id: 'i2' }] }))
  const t = deck(slide('a', { title: 'A' }, { items: [{ ...it, x: 300, y: 200 }, { ...it, id: 'i2' }] }))
  const r = m(b, l, t)
  eq([r.deck.slides[0].items![0], r.konflikte], [{ ...it, text: 'Servus', x: 300, y: 200 }, 0])
})

// Listen ohne IDs: gleich lang → je Index, andere Länge → als Ganzes (mine)
fall(() => {
  const [, b, c] = B.slides
  const a = (bullets: string[], text = 'eins') => slide('a', { title: 'A', text, bullets })
  const r = m(B, deck(a(['x neu', 'y']), b, c), deck(a(['x', 'y neu']), b, c))
  eq([r.deck.slides[0].content.bullets, r.konflikte], [['x neu', 'y neu'], 0])
  const r2 = m(B, deck(a(['x', 'y', 'z']), b, c), deck(a(['x', 'y neu']), b, c))
  eq([r2.deck.slides[0].content.bullets, r2.konflikte], [['x', 'y', 'z'], 1])
  eq(m(B, deck(a(['x', 'y']), b, c), deck(a(['x']), b, c)).deck.slides[0].content.bullets, ['x']) // nur theirs ändert
  // doppelte IDs → als Ganzes
  const d = (...v: number[]) => v.map((x) => ({ id: 'z', v: x }))
  let k = 0
  eq(merge3(d(1, 2), d(1, 3), d(4, 2), { onConflict: () => k++ }), d(1, 3))
  eq(k, 1)
})

// Idempotenz und Eingaben unverändert
fall(() => {
  const l = deck(slide('a', { ...B.slides[0].content, title: 'mein' }), slide('m'), B.slides[2])
  const t = deck(slide('t'), B.slides[0], B.slides[1], slide('c', { title: 'C neu' }))
  const vorher = JSON.stringify([B, l, t])
  const r = m(B, l, t)
  eq(JSON.stringify([B, l, t]), vorher)
  eq(ids(r.deck), ['t', 'a', 'm', 'c'])
  eq(m(B, r.deck, t), { deck: r.deck, konflikte: 0 })
  eq(merge3({ a: 1 }, { a: 1 }, { a: 1 }), { a: 1 })
  eq(merge3(1, 2, 3), 2)
})

// Bilder: lokaler Pfad in mine und heruntergeladene Kopie in base/theirs gelten als gleich
fall(() => {
  const lokal = url('/home/x/Deckwerk/assets/foto.png')
  const kopie = url(`${dir}/${portablePath(lokal, dir)}`)
  const mit = (src: string, title = 'A') => deck(slide('a', { title, image: { src } }))
  const r = m(mit(kopie), mit(lokal, 'mein'), mit(kopie))
  eq([r.deck.slides[0].content.image.src, r.deck.slides[0].content.title, r.konflikte], [lokal, 'mein', 0])
  const neu = url(`${dir}/assets/anders.png`)
  const r2 = m(mit(kopie), mit(lokal, 'mein'), mit(neu))
  eq([r2.deck.slides[0].content.image.src, r2.konflikte], [neu, 0])
})

// rebase: Undo-Snapshot vor der fremden Änderung bekommt sie, eigene alte Werte bleiben
fall(() => {
  const s0 = B
  const s1 = deck(slide('a', { ...B.slides[0].content, title: 'mein' }), B.slides[1], B.slides[2])
  const t = deck(B.slides[0], B.slides[1], slide('c', { title: 'C fremd' }))
  const [r0, r1] = rebase([s0, s1], B, t, dir)
  eq([r0.slides[0].content.title, r0.slides[2].content.title], ['A', 'C fremd'])
  eq([r1.slides[0].content.title, r1.slides[2].content.title], ['mein', 'C fremd'])
  ok(r0.slides[1] === B.slides[1], 'geteilte Folien bleiben geteilt')
})

// sanitize: fremde deck.json mit relativen Pfaden
fall(() => {
  const roh = JSON.parse(JSON.stringify({
    ...deck(
      slide('a', { title: 'asset://local/home/besitzer/privat.jpg', image: { src: 'assets/foto.jpg' }, logos: [{ name: 'X', src: 'file:///etc/passwd' }, { name: 'Y', src: 'assets/../x.png' }] },
        { bg: { image: '../x.png' }, items: [{ id: 'i', kind: 'image', x: 0, y: 0, w: 1, h: 1, src: 'assets/sub/x.png' }, { id: 'j', kind: 'video', x: 0, y: 0, w: 1, h: 1, src: 'assets/x.exe', poster: 'data:image/png;base64,AAAA' }] }),
      slide('b', { title: 'FILE:///etc/hosts', image: { src: 'ASSET://local/x.png' }, text: ' \nfile:///x', quote: 'Datei: file:///x' }, { bg: { image: 'https://tracker.example/p.png' } })),
    theme: { id: 'x', brand: { primary: '#000000', logo: 'assets/logo.svg', logoDark: '/etc/logo.png' }, customFont: { family: 'F', regular: 'assets/f.ttf', bold: 'assets/f.ttf.sh' } },
  }))
  const s = sanitize(roh)
  const [a, b] = s.slides
  eq([a.content.title, a.content.image.src, a.content.logos[0].src, a.content.logos[1].src, a.bg!.image], ['', 'assets/foto.jpg', '', '', ''])
  eq([a.items![0].src, a.items![1].src, a.items![1].poster], ['', '', 'data:image/png;base64,AAAA'])
  eq([b.content.title, b.content.image.src, b.content.text, b.content.quote, b.bg!.image], ['', '', '', 'Datei: file:///x', ''])
  eq([s.theme.brand!.logo, s.theme.brand!.logoDark, s.theme.customFont!.regular, s.theme.customFont!.bold], ['assets/logo.svg', '', 'assets/f.ttf', ''])
  eq(Object.keys(sanitize(JSON.parse('{"theme":{"id":"x"},"slides":[{"id":"a","content":{"__proto__":{"x":1}}}]}')).slides[0].content), [])
  // Videopfade (clip.video, Einblendung video) und Excel-Link: fremde absolute Pfade landeten sonst im MP4-Export bzw. würden gelesen
  const v = sanitize(JSON.parse(JSON.stringify(deck(slide('v', { video: '/home/u/privat.mp4', parts: [], overlays: [{ video: 'assets/b.mp4' }, { video: 'C:\\Users\\u\\x.mp4' }], chart: { link: { file: '/home/u/Zahlen.xlsx', range: 'A1:B2' } } })))))
  eq([v.slides[0].content.video, v.slides[0].content.overlays[0].video, v.slides[0].content.overlays[1].video, v.slides[0].content.chart.link.file], ['', 'assets/b.mp4', '', ''])
  // relative Asset-Namen: kein \ (Windows-Trenner), kein .., Endung aus MEDIA_EXT (gilt für sanitize und die Bilder-Liste in mitarbeit.ts)
  eq(['assets/x.png', 'assets/..\\..\\x.png', 'assets/a\\b.png', 'assets/../x.png', 'assets/x.exe', 'assets/sub/x.png'].map(isAssetRel), [true, false, false, false, false, false])
  throws(() => sanitize({ theme: { id: 'x' } }), /deck\.json/)
  throws(() => sanitize({ slides: [] }), /deck\.json/)
  throws(() => sanitize({ theme: { id: 'x' }, slides: [{ id: 3 }] }), /Folie/)
  throws(() => sanitize(null), /deck\.json/)
})

// Tempo: 100 Undo-Snapshots mit geteilten Folien
fall(() => {
  const viele = deck(...Array.from({ length: 60 }, (_, i) => slide(`s${i}`, { title: `T${i}`, bullets: Array.from({ length: 8 }, (_, j) => `Punkt ${j}`) })))
  const stack = Array.from({ length: 100 }, (_, i) => ({ ...viele, slides: viele.slides.map((s, j) => (j === i % 60 ? { ...s, content: { ...s.content, title: `mein ${i}` } } : s)) }))
  const t = { ...viele, slides: viele.slides.map((s, j) => (j === 59 ? { ...s, notes: 'fremd' } : s)) }
  const t0 = performance.now()
  const r = rebase(stack, viele, t, dir)
  const ms = performance.now() - t0
  ok(r.every((d) => d.slides[59].notes === 'fremd'))
  ok(ms < 500, `rebase über 100 Snapshots: ${ms.toFixed(0)} ms`)
})

console.log(`check-merge3: ok (${faelle} Fälle)`)
