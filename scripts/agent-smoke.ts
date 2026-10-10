// Smoke-Test für Tools + Systemprompt ohne API (Mock-Engine). Mit --live und ANTHROPIC_API_KEY zusätzlich ein echter Agent-Turn.
// Aufruf: npx esbuild scripts/agent-smoke.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/agent-smoke.mjs && node out/agent-smoke.mjs [--live]
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeckAgent, buildSystemPrompt, toRunnable, type Engine, type VideoTools } from '../src/main/agent'
import { z } from 'zod'
import { assetUrl, buildTools, imageSettings, JOB_WAIT, jobList, lookTyp, recentLooks, webpSize, imageSize, type ToolDef } from '../src/main/tools'
import type { Deck } from '../src/shared/deck'
import { lintDeck } from '../src/shared/lint'
import { resolveTheme } from '../src/shared/themes'
import { autoPick } from '../src/shared/models'
import { typeset } from '../src/shared/typo'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const engine: Engine = {
  measure: async (_d, idx = []) => idx.map(() => ({ els: [], fit: { ok: true, head: 0, body: 1, overflow: [] } })),
  renderPng: async (_d, idx) => idx.map(() => PNG),
  renderOverview: async () => PNG,
  lint: async (d) => d.slides.flatMap((s, i) => (s.layout === 'bullets' && s.content.items.length > 4 ? [{ slide: i, slideId: s.id, severity: 'warn' as const, rule: 'density', message: 'viele Punkte' }] : [])),
  exportDeck: async (_d, f, out) => [`${out}/deck.${f}`],
}

let deck: Deck | null = null
let events = 0
const tools = buildTools({ engine, getDeck: () => deck, setDeck: (d) => { deck = d; events++ }, assetDir: '/nonexistent', outDir: '/tmp/out' })
const T = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, ToolDef>
const run = (name: string, input: unknown) => T[name].run(T[name].inputSchema.parse(input))
const fails = async (p: Promise<unknown>, re: RegExp) => { try { await p } catch (e) { assert.match((e as Error).message, re); return } assert.fail('sollte werfen') }
const realHome = process.env.DECKWERK_HOME
process.env.DECKWERK_HOME = mkdtempSync(join(tmpdir(), 'dw-home-')) // ohne die echten Decks des Nutzers (recentLooks)
process.env.DECKWERK_OFFLINE = '1' // Katalogschriften nie aus dem Netz (webfonts.ts): Ersatz und Hinweis statt Download

assert.equal(tools.length, 23)
// laden aus dem Netz und schreiben Dateien: readOnly würde im MCP zu readOnlyHint, Claude Code liefe dann ohne Rückfrage
for (const n of ['import_video', 'find_music']) assert.equal(T[n].readOnly, undefined, n)
// API-Weg: Deck-Tools einer Antwort nacheinander (sonst geht eine Änderung verloren), readOnly-Tools gleichzeitig
{
  const log: string[] = [], lock = { tail: Promise.resolve() as Promise<unknown> }
  const slow = (name: string, readOnly?: true): ToolDef => ({ name, description: '', inputSchema: z.object({}), readOnly, run: async () => { log.push(`${name}+`); await new Promise((r) => setTimeout(r, 30)); log.push(`${name}-`); return { text: 'ok' } } })
  const both = (x: ToolDef, y: ToolDef) => Promise.all([toRunnable(x, () => {}, lock).run({}), toRunnable(y, () => {}, lock).run({})])
  await both(slow('a'), slow('b'))
  assert.deepEqual(log.splice(0), ['a+', 'a-', 'b+', 'b-'])
  await both(slow('c', true), slow('d', true))
  assert.deepEqual(log, ['c+', 'd+', 'c-', 'd-'])
}
// WebP-Maße aus dem Kopf (Kopfbytes von ImageMagick-Dateien: verlustbehaftet 1234×567, verlustfrei 1001×333, erweitert 777×555)
const webp = (hex: string) => webpSize(Buffer.from(hex, 'hex'))
// imageSize: PNG (IHDR), GIF, JPEG (Frame-Kopf hinter einem APP0-Segment), sonst null
const png1x2 = Buffer.from('89504e470d0a1a0a0000000d494844520000000300000002', 'hex')
assert.deepEqual(imageSize(png1x2), { width: 3, height: 2 })
assert.deepEqual(imageSize(Buffer.from('474946383961' + '0500' + '0700', 'hex')), { width: 5, height: 7 })
assert.deepEqual(imageSize(Buffer.from('ffd8' + 'ffe00004aaaa' + 'ffc0000b08' + '0280' + '01e0' + '0300', 'hex')), { width: 480, height: 640 })
assert.equal(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
assert.deepEqual(webp('524946463610000057454250565038202a100000f010019d012ad20437023e6d'), { width: 1234, height: 567 })
assert.deepEqual(webp('52494646a6030000574542505650384c9a0300002fe8035300063169b2fef5c5'), { width: 1001, height: 333 })
assert.deepEqual(webp('524946463c0a000057454250565038580a000000100000000803002a0200414c'), { width: 777, height: 555 })
assert.equal(webp('ffd8ffe000104a46494600010100000100010000ffdb0043000302020302020303'), null)
// Feinsatz: Anführungszeichen, Striche, geschützte Leerzeichen; URLs bleiben, Wiederholung ändert nichts
{
  const NB = '\u00a0'
  const eq = (a: string, b: string) => { assert.equal(typeset(a), b); assert.equal(typeset(b), b, 'idempotent') }
  eq('Umsatz +8% seit "Q1"', `Umsatz +8${NB}% seit „Q1“`)
  eq("Wie geht's", 'Wie geht’s')
  eq('Alpha - Beta', 'Alpha – Beta')
  eq('E-Mail und Video-Sprechstunde', 'E-Mail und Video-Sprechstunde'); eq('2024-05-01', '2024-05-01')
  eq('5 Mio. € und 3 km, 7 h', `5${NB}Mio.${NB}€ und 3${NB}km, 7${NB}h`)
  eq('z. B. Nr. 5', `z.${NB}B. Nr.${NB}5`)
  eq('siehe https://a.de/x-y?q=1-2 oder a-b@c.de', 'siehe https://a.de/x-y?q=1-2 oder a-b@c.de'); eq('/home/x/a-1.png', '/home/x/a-1.png')
  eq('left', 'left')
  // konservativ: Kennungen, Formeln, Minus, Zoll, URLs mit Anführungszeichen bleiben
  for (const x of ['SKU 12-345', 'Boeing 737-800', 'ISO 9001-2015', 'IBAN DE89 3704-0044', 'Stand 2024-05', 'Tel. 030 1234-0', 'Kurs 2024-26', 'x - 3', '5 - 3 = 2', 'a - b', `-31${NB}% und −5${NB}%`, '12" Monitor', 'Quote "offen', 'https://a.de/?q="1" ok'])
    eq(x, x)
  eq('von 8-10 Mio. € in 2-3 Jahren, 1,5-2 %', `von 8–10${NB}Mio.${NB}€ in 2–3 Jahren, 1,5–2${NB}%`)
  eq('Wachstum 2024-2026', 'Wachstum 2024–2026')
  eq('Ergebnis (ok) - gut und "Ja" - nein', 'Ergebnis (ok) – gut und „Ja“ – nein')
  eq('Er sagte "Hallo" (und "tschüss") bei 12" Zoll', 'Er sagte „Hallo“ (und „tschüss“) bei 12" Zoll')
}
// Auto-Modellwahl: neues Deck und Umbauten gründlich, gezielte Änderungen schnell
assert.equal(autoPick('Ein Pitch für unser Café', false).model, 'claude-opus-5-5')
assert.equal(autoPick('Überarbeite alle Folien im Ton', true).model, 'claude-opus-5-5')
assert.deepEqual(autoPick('Mach den Titel kürzer (Folie 3, Element title)', true), { model: 'claude-sonnet-5-5', effort: 'medium', why: 'Änderung' })
const look = (name: string, bg: string, more = {}) => ({ name, bg, accent: '#C4552D', headFont: 'Fraunces', bodyFont: 'Manrope', radius: 4, decor: 'none', ...more })
await fails(run('propose_looks', { looks: [look('Hell', '#F5F3EE'), look('Dunkel', '#12261E')] }), /unterscheiden sich kaum/) // nur umgefärbt
await fails(run('propose_looks', { looks: [look('Hell', '#F5F3EE'), look('Dunkel', '#12261E', { margin: 'generous' })] }), /unterscheiden sich kaum/) // ein neues Merkmal reicht nicht
await fails(run('propose_looks', { looks: [look('Hell', '#F5F3EE'), look('Dunkel', '#12261E', { headFont: 'Space Grotesk', titleSize: 'large', rule: 'over' })] }), /Look 2 Dunkel: Theme-Lint lehnt ab[\s\S]*Space Grotesk ist Standard generierter Designs/)
await fails(run('propose_looks', { looks: [look('Creme', '#F6F1E7'), look('Dunkel', '#12261E', { headFont: 'Inter', titleSize: 'large', rule: 'over' })] }), /bg-tint[\s\S]*cliche: Creme \+ Terrakotta/)
const looks = await run('propose_looks', { looks: [look('Hell', '#F5F3EE'), look('Dunkel', '#12261E', { headFont: 'Inter', titleSize: 'large', rule: 'over' })] }) as { text: string; images: Buffer[] }
assert.equal(looks.images.length, 2); assert.match(looks.text, /Hell[\s\S]*Dunkel/)
await fails(run('add_slides', { slides: [{ layout: 'cover', content: { title: 'x' } }] }), /create_deck/)
// Video-Decks: Clips folgen aufeinander ohne Titel- und Schlussfolie, fade nur an Zwischentiteln – keine Folien-Regeln dafür
{
  const m0 = { els: [], fit: { ok: true, head: 0, body: 1, overflow: [] } }
  const st = (id: string, transition?: 'fade') => ({ id, layout: 'statement', content: { text: 'Ein ruhiger Zwischentitel' }, transition })
  const cl = (id: string) => ({ id, layout: 'clip', content: { video: '', parts: [{ start: 0, end: 20 }] } })
  const rules = (slides: Deck['slides']) => lintDeck({ title: 'V', theme: { id: 'midnight' }, transition: 'none', mode: 'auto', slides }, slides.map(() => m0)).map((x) => x.rule).filter((x) => ['structure', 'rhythm', 'transition'].includes(x)).sort()
  assert.deepEqual(rules([st('a'), st('b'), st('c', 'fade'), st('d')]), ['rhythm', 'rhythm', 'structure', 'structure', 'transition'])
  assert.deepEqual(rules([cl('a'), cl('b'), cl('c'), st('d', 'fade'), cl('e')]), [])
}
// Theme-Lint in create_deck/update_deck: Klischees abgelehnt (mit Korrektur), mit override (Wunsch des Nutzers) nur Hinweis
await fails(run('create_deck', { title: 'Test', customTheme: look('Violett', '#FFFFFF', { accent: '#7C3AED' }) }), /customTheme: Theme-Lint lehnt ab:[\s\S]*cliche: KI-Violett[\s\S]*override/)
assert.equal(deck, null, 'abgelehntes Theme legt kein Deck an')
assert.match((await run('create_deck', { title: 'Test', customTheme: look('Violett', '#FFFFFF', { accent: '#7C3AED' }), override: 'Markenfarbe des Nutzers' })).text, /^Theme-Hinweise \(customTheme\):\n[\s\S]*\[warn\] cliche: KI-Violett/)
await fails(run('update_deck', { customTheme: { headFont: 'Space Grotesk' } }), /Space Grotesk ist Standard generierter Designs/)
assert.equal(deck!.theme.custom?.headFont, 'Fraunces', 'abgelehnte Änderung lässt das Deck stehen')
assert.doesNotMatch((await run('update_deck', { customTheme: { accent: '#1E5B3A' } })).text, /cliche|\[warn\]|sehr verbreitet/)
await fails(run('update_deck', { tune: { titleSize: 'huge', measure: 'narrow' } }), /overflow/) // tune über eigenem Theme wird mitgeprüft
assert.equal(Object.keys(deck!.theme.tune ?? {}).length, 0, 'abgelehntes tune bleibt draußen')
const created = await run('create_deck', { title: 'Test', theme: 'midnight' })
assert.equal(deck!.theme.id, 'midnight'); assert.equal(deck!.transition, 'fade')
assert.equal(deck!.style, undefined); assert.match(created.text, /Stil nicht gewählt/)
// tune: Feinschliff über dem Katalog-Theme, wird gemischt; null entfernt einen Wert
await run('update_deck', { tune: { margin: 'generous', signature: { kind: 'rule' } } })
assert.equal(deck!.theme.tune?.margin, 'generous')
await run('update_deck', { tune: { margin: null } })
assert.deepEqual(deck!.theme.tune, { signature: { kind: 'rule' } })
// Stil-Regler: mutig setzen und zurück; vivid hält den kräftigen Grund (nur aus dem mittleren Helligkeitsband geschoben)
await run('update_deck', { style: 'mutig', customTheme: look('Koralle', '#FFD100', { vivid: true }) })
assert.equal(deck!.style, 'mutig'); assert.equal(resolveTheme(deck!.theme).c.bg.toLowerCase(), '#ffd100')
await fails(run('update_deck', { customTheme: { vivid: false } }), /bg-mid/) // ohne vivid ist Signalgelb ein Mittelton
await run('update_deck', { style: 'sachlich', customTheme: { vivid: false }, override: 'Test: die Engine dämpft' })
assert.equal(deck!.style, 'sachlich'); assert.notEqual(resolveTheme(deck!.theme).c.bg.toLowerCase(), '#ffd100', 'ohne vivid dämpft die Engine')
await run('update_deck', { theme: 'midnight' })
assert.deepEqual(deck!.theme.tune, { signature: { kind: 'rule' } }, 'Theme-Wechsel behält tune')
await fails(run('add_slides', { slides: [{ layout: 'cover', content: { title: 'Okay' } }, { layout: 'agenda', content: { title: 'Agenda', items: [] } }] }), /slides\[1\] \(agenda\)[\s\S]*items/)
assert.equal(deck!.slides.length, 0, 'Batch mit Fehler ändert nichts')
// unbekannte Felder (Live-Test: kicker statt eyebrow, body statt sub) nicht still verwerfen, sondern die erlaubten nennen
await fails(run('add_slides', { slides: [{ layout: 'cover', content: { title: 'Okay', kicker: 'Q3' } }] }), /Unbekannte Felder: kicker \(erlaubt: [^)]*eyebrow/)
await fails(run('add_slides', { slides: [{ layout: 'agenda', content: { title: 'Agenda', items: [{ title: 'a', body: 'x' }, { title: 'b', body: 'y' }, { title: 'c' }] } }] }), /items\.\[\]\.body \(erlaubt: title, desc\)/)
const r = await run('add_slides', { slides: [{ layout: 'cover', content: { title: 'Ein Titel' } }, { layout: 'bullets', content: { title: 'Drei Gründe sprechen für den Start', items: [{ text: 'a' }, { text: 'b' }] } }] })
assert.match(r.text, /Folie 1 \(s[0-9a-f]{4}, cover\): OK · Autofit head 0\/body 1/)
const [c, b] = deck!.slides
assert.notEqual(c.id, b.id)
await run('add_slides', { slides: [{ layout: 'cover', content: { title: 'Umsatz +8% seit "Q1"' }, notes: 'ca. 5 Mio. €' }] })
assert.equal(deck!.slides.at(-1)!.content.title, 'Umsatz +8\u00a0% seit „Q1“'); assert.equal(deck!.slides.at(-1)!.notes, 'ca. 5\u00a0Mio.\u00a0€')
deck!.slides.pop()
await run('add_slides', { slides: [{ layout: 'section', content: { title: 'Kapitel eins' } }], at: 1 })
assert.equal(deck!.slides[1].layout, 'section')
const u = await run('update_slide', { id: b.id, content: { items: [{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }, { text: '5' }] } })
assert.match(u.text, /density/); assert.equal(deck!.slides[2].content.title, 'Drei Gründe sprechen für den Start', 'Patch behält Titel')
await fails(run('update_slide', { id: 'nope', notes: 'x' }), /gibt es nicht/)
await fails(run('reorder_slides', { order: [c.id] }), /genau alle IDs/)
await run('reorder_slides', { order: [b.id, deck!.slides[1].id, c.id] })
assert.equal(deck!.slides[0].id, b.id)
const px = await run('render_slides', { ids: [c.id, b.id] })
assert.equal(px.images!.length, 2)
assert.equal((await run('render_overview', {})).images!.length, 1)
assert.match((await run('lint_deck', {})).text, /1 Warnungen/)
assert.match((await run('search_icons', { query: 'shield' })).text, /shield-check/)
assert.match((await run('find_images', {})).text, /Keine .*Bilder|nicht konfiguriert/)

// Unsplash mit gemocktem fetch: Suche → Download nach assetDir → asset://-Pfad + JPEG-Thumb
{
  const { mkdtempSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const assetDir = join(mkdtempSync(join(tmpdir(), 'dw-assets-')), 'assets')
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
  const calls: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => {
    calls.push(url)
    if (url.includes('/search/photos')) return new Response(JSON.stringify({ results: [{ id: 'abc', width: 3000, height: 2000, alt_description: 'teacher in classroom', urls: { raw: 'https://img/r?ixid=1', small: 'https://img/s' }, user: { name: 'Jane', links: { html: 'https://unsplash.com/@jane' } }, links: { download_location: 'https://api/dl' } }] }))
    return new Response(jpeg)
  }) as typeof fetch
  const T2 = Object.fromEntries(buildTools({ engine, getDeck: () => deck, setDeck: () => {}, assetDir, outDir: '/tmp/out', unsplashKey: 'k' }).map((t) => [t.name, t])) as Record<string, ToolDef>
  const r = await T2.find_images.run(T2.find_images.inputSchema.parse({ query: 'teacher classroom' }))
  globalThis.fetch = realFetch
  assert.match(r.text, /asset:\/\/local\/.*unsplash-abc\.jpg — 2560×1707 px, teacher in classroom \(Foto: Jane/)
  assert.ok(calls.includes('https://img/r?ixid=1&w=2560&q=82&fm=jpg'), '2560-px-Download')
  assert.ok(existsSync(join(assetDir, 'unsplash-abc.jpg')) && r.images!.length === 1 && r.images![0][0] === 0xff)
  assert.ok(calls.some((u) => u.includes('per_page=3&orientation=landscape')) && calls.includes('https://api/dl'), 'Suche + Download-Meldung')
  assert.match((await T2.find_images.run(T2.find_images.inputSchema.parse({}))).text, /unsplash-abc\.jpg/, 'danach lokal auffindbar')
}
// Eigene Bilder: asset://-Pfad ansehen (nur im Asset-Ordner), lokale Suche neueste zuerst, nur die ersten `limit` mit Vorschau
{
  const assetDir = mkdtempSync(join(tmpdir(), 'dw-own-'))
  const T5 = Object.fromEntries(buildTools({ engine, getDeck: () => deck, setDeck: () => {}, assetDir, outDir: '/tmp/out' }).map((t) => [t.name, t])) as Record<string, ToolDef>
  const find = (input: unknown) => T5.find_images.run(T5.find_images.inputSchema.parse(input))
  const head = (w: number, h: number) => { const b = Buffer.from(png1x2); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b }
  mkdirSync(join(assetDir, 'import-x'))
  writeFileSync(join(assetDir, 'import-x', 'bild.png'), head(1600, 900))
  const own = await find({ url: assetUrl(join(assetDir, 'import-x', 'bild.png')) })
  assert.match(own.text, /^Bild: asset:\/\/local\/.*import-x\/bild\.png — 1600×900 px, quer\n.*update_deck mit brand/)
  assert.equal(own.images!.length, 1)
  for (const url of [assetUrl(join(tmpdir(), 'fremd.png')), `${assetUrl(assetDir)}-x/a.png`, `${assetUrl(assetDir)}/../fremd.png`, `${assetUrl(assetDir)}/import-x%2F..%2F..%2Ffremd.png`, assetUrl(join(assetDir, 'notiz.txt'))])
    await fails(find({ url }), /Nur Bilder aus dem Asset-Ordner/)
  writeFileSync(join(assetDir, 'alt.png'), head(800, 600)); writeFileSync(join(assetDir, 'neu.png'), head(1000, 1000)); writeFileSync(join(assetDir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  for (const [f, t] of Object.entries({ 'alt.png': 1, 'import-x/bild.png': 2, 'logo.svg': 3, 'neu.png': 4 })) utimesSync(join(assetDir, f), t, t)
  const list = await find({ source: 'local', limit: 2 })
  assert.equal(list.images!.length, 2)
  assert.deepEqual(list.text.match(/asset:\/\/local\S+/g)!.map((u) => u.split('/').pop()), ['neu.png', 'logo.svg', 'bild.png', 'alt.png'])
  assert.match(list.text, /neu\.png — 1000×1000 px, quadratisch\n.*logo\.svg — SVG\n.*bild\.png\n.*alt\.png$/)
  for (let n = 0; n < 28; n++) writeFileSync(join(assetDir, `x${n}.png`), head(10, 10))
  assert.match((await find({ source: 'local', limit: 1 })).text, /\n… und 2 weitere, query eingrenzen$/)
  // Logo im Brand-Kit: Pfad steht im Ergebnis (brand.json selbst ist hier nicht testbar: BRAND_FILE steht schon beim Import fest)
  const made = await T5.create_deck.run(T5.create_deck.inputSchema.parse({ title: 'Mit Logo', brand: { primary: '#0B5563', logo: 'asset://local/x/logo.svg' } }))
  assert.match(made.text, /Brand-Kit des Nutzers angewendet, Logo asset:\/\/local\/x\/logo\.svg auf Titel- und Schlussfolie \(A4: Seite 1\)\)/)
}
// generate_image: Mammouth über die Images-API (gemocktes fetch), Codex über ein Fake-CLI, das sein Bild nach $CODEX_HOME legt
{
  const { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const tmp = mkdtempSync(join(tmpdir(), 'dw-gen-')), assetDir = join(tmp, 'assets')
  const keep = { ...process.env }
  Object.assign(process.env, { HOME: tmp, PATH: `${join(tmp, 'bin')}:/usr/bin:/bin`, CODEX_HOME: join(tmp, 'codex') }) // kein echtes codex aus ~/.local/bin
  delete process.env.MAMMOUTH_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.IMAGE_MODEL
  const T3 = Object.fromEntries(buildTools({ engine, getDeck: () => deck, setDeck: () => {}, assetDir, outDir: '/tmp/out' }).map((t) => [t.name, t])) as Record<string, ToolDef>
  const gen = (input: unknown) => T3.generate_image.run(T3.generate_image.inputSchema.parse(input))
  assert.match((await gen({ prompt: 'a red apple on a table' })).text, /Keine Bild-KI eingerichtet/)

  process.env.MAMMOUTH_API_KEY = 'mk'
  let req: { url: string; auth: string; body: Record<string, unknown> } | undefined
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    req = { url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(init.body as string) }
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  }) as typeof fetch
  const m = await gen({ prompt: 'a red apple on a table', orientation: 'portrait' })
  globalThis.fetch = realFetch
  assert.equal(req!.url, 'https://api.mammouth.ai/v1/images/generations'); assert.equal(req!.auth, 'Bearer mk')
  assert.deepEqual(req!.body, { model: 'gpt-image-2', prompt: 'a red apple on a table', n: 1, size: '1024x1536' })
  assert.match(m.text, /mammouth · gpt-image-2\): asset:\/\/local\/.*\/ki-\w+\.png/); assert.equal(m.images!.length, 1)
  await fails(gen({ prompt: 'a red apple on a table', provider: 'openai' }), /openai ist nicht eingerichtet. Verfügbar: mammouth/)
  Object.assign(imageSettings, { openai: 'ak', provider: 'openai', model: 'gpt-image-x' }) // Einrichtung → Bilder schlägt die Umgebung
  globalThis.fetch = (async (url: string, init: RequestInit) => { req = { url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(init.body as string) }; return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })) }) as typeof fetch
  await gen({ prompt: 'a red apple on a table' })
  globalThis.fetch = realFetch
  assert.equal(req!.url, 'https://api.openai.com/v1/images/generations'); assert.equal(req!.auth, 'Bearer ak'); assert.equal(req!.body.model, 'gpt-image-x')
  for (const k of Object.keys(imageSettings)) delete imageSettings[k as keyof typeof imageSettings]

  mkdirSync(join(tmp, 'bin'))
  writeFileSync(join(tmp, 'bin', 'codex'), '#!/bin/sh\ncat > "$CODEX_HOME/prompt.txt"\nmkdir -p "$CODEX_HOME/generated_images/t1"\nprintf \'\\377\\330\\377\' > "$CODEX_HOME/generated_images/t1/a.jpg"\n', { mode: 0o755 })
  mkdirSync(join(tmp, 'codex'))
  const c = await gen({ prompt: 'a green pear', provider: 'codex' })
  assert.match(c.text, /Codex\): asset:\/\/local\/.*\/ki-\w+\.jpg/)
  assert.match(readFileSync(join(tmp, 'codex', 'prompt.txt'), 'utf8'), /landscape[\s\S]*a green pear/)
  assert.equal(readdirSync(assetDir).length, 3)
  for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k]
  Object.assign(process.env, keep)
}
assert.match((await run('export_deck', { format: 'pptx' })).text, /deck\.pptx/)
assert.match((await run('export_deck', { format: 'zip' })).text, /deck\.zip/)
assert.match((await run('export_deck', { format: 'docx' })).text, /deck\.docx/)
assert.match((await run('export_deck', { format: 'clips' })).text, /deck\.clips/)
// Video: ohne engine.video eine klare Meldung; mit Mock-Video laufen Transkript, Download und Highlights als Hintergrund-Job („läuft noch“, dann abholen)
{
  const dir = mkdtempSync(join(tmpdir(), 'dw-video-')), file = join(dir, 'talk.mp4')
  writeFileSync(file, '')
  await fails(run('transcribe_video', { video: file }), /^Video-Funktionen gibt es nur in der Deckwerk-App und im MCP-Server/)
  await fails(run('import_video', { url: 'https://example.com/v' }), /nur in der Deckwerk-App/)
  await fails(run('find_music', {}), /query \(suchen\) oder id/)
  await fails(run('find_music', { id: '../x' }), /Ungültige Openverse-ID/) // vor jedem Netzzugriff
  let finish = () => {}, loaded = () => {}
  const spoken = new Promise<void>((ok) => { finish = ok }), imported = new Promise<void>((ok) => { loaded = ok })
  const seen: unknown[] = []
  const segs = [{ start: 0, end: 4.2, text: ' Hallo zusammen.' }, { start: 61.2, end: 66.8, text: 'Der Kern.' }]
  let hl = [{ start: 2832, end: 2892, score: 6.24, why: 'Chat ×4,2 · laut +9 dB' }, { start: 3723, end: 3783, score: 3, why: 'oft gesehen' }]
  const video: VideoTools = {
    probe: async () => ({ duration: 75, w: 1920, h: 1080 }),
    frames: async (_f, times) => times.map(() => PNG),
    transcribe: async (_f, onProgress, o) => {
      seen.push(o)
      onProgress?.(43)
      await spoken
      return { duration: 75, lang: 'de', segments: o?.speakers ? segs.map((s, k) => ({ ...s, speaker: k })) : segs }
    },
    highlights: async () => hl,
    musicIn: async () => Array.from({ length: 75 }, (_, k) => (k < 10 ? 0.9 : 0)), // Musik in den ersten 10 s
    cached: async () => ({ signals: { loud: new Array(75).fill(-30) }, highlights: hl, transcript: { duration: 75, lang: 'de', segments: segs }, duration: 75 }),
    importUrl: async (_url, onProgress) => {
      onProgress?.(12)
      await imported
      return { file, title: 'Stream vom Freitag', duration: 3 * 3600 + 5, chat: true, chapters: Array.from({ length: 32 }, (_, k) => ({ start: k * 300, title: `Teil ${k + 1}` })) }
    },
  }
  let vd: Deck | null = null
  const T6 = Object.fromEntries(buildTools({ engine: { ...engine, video }, getDeck: () => vd, setDeck: (x) => { vd = x }, assetDir: dir, outDir: dir }).map((t) => [t.name, t])) as Record<string, ToolDef>
  const go = (name: string, input: unknown) => T6[name].run(T6[name].inputSchema.parse(input))
  JOB_WAIT.ms = 20
  assert.match((await go('transcribe_video', { video: assetUrl(file) })).text, /^Transkription läuft noch \(43 %\)/)
  assert.deepEqual(jobList().map(({ name, pct, done }) => ({ name, pct, done })), [{ name: 'transcribe', pct: 43, done: false }])
  finish()
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(jobList()[0].done, true)
  const tr = await go('transcribe_video', { video: file }) // anderer Weg zur selben Datei: derselbe Job
  assert.match(tr.text, /^Video: asset:\/\/local\/.*\/talk\.mp4 · 1:15 · 1920×1080 · Sprache de · 2 Segmente\n\[s0\] 0\.0–4\.2 Hallo zusammen\.\n\[s1\] 61\.2–66\.8 Der Kern\.\n\n.*video_frames/)
  assert.deepEqual(seen, [{ range: undefined, lang: undefined, speakers: undefined }])
  assert.deepEqual(jobList(), []) // abgeholt = vergessen
  // from/to bestimmen, was transkribiert wird (to höchstens bis zum Ende); Sprecher als S1, S2 …
  const win = await go('transcribe_video', { video: file, from: 60, to: 999, lang: 'de', speakers: true })
  assert.deepEqual(seen[1], { range: { from: 60, to: 75 }, lang: 'de', speakers: true })
  assert.match(win.text, /· 2 Segmente\n\[s1\] S2 61\.2–66\.8 Der Kern\.\n\n/)
  await fails(go('transcribe_video', { video: file, from: 10, to: 5 }), /to muss nach from/)
  await fails(go('transcribe_video', { video: file, from: 80 }), /hinter dem Ende/)
  // Download per Link: läuft noch, dann Pfad, Dauer, Chat, Kapitel (höchstens 30) und nächster Schritt nach Länge
  assert.match((await go('import_video', { url: 'https://www.twitch.tv/videos/123' })).text, /^Download läuft noch \(12 %\)/)
  loaded()
  const im = await go('import_video', { url: 'https://www.twitch.tv/videos/123' })
  assert.match(im.text, /^Video: asset:\/\/local\/.*\/talk\.mp4\nTitel: Stream vom Freitag\nDauer: 3:00:05\nChat: ja/)
  assert.match(im.text, /Kapitel \(32\):\n0:00:00 Teil 1\n0:05:00 Teil 2\n[\s\S]*\n2:25:00 Teil 30\n… und 2 weitere\n\nWeiter: video_highlights/)
  JOB_WAIT.ms = 240_000
  const hi = await go('video_highlights', { video: file })
  assert.match(hi.text, /^2 Kandidaten in asset:.*\n1\. 0:47:12–0:48:12 · Score 6,2 · Chat ×4,2 · laut \+9 dB · from=2832 to=2892\n2\. 1:02:03–1:03:03 · Score 3,0 · oft gesehen/)
  assert.match(hi.text, /transcribe_video mit from\/to[\s\S]*video_frames/)
  hl = []
  assert.match((await go('video_highlights', { video: file })).text, /keine deutlichen Spitzen/)
  const T7 = Object.fromEntries(buildTools({ engine: { ...engine, video: { ...video, highlights: undefined } }, getDeck: () => vd, setDeck: () => {}, assetDir: dir, outDir: dir }).map((t) => [t.name, t])) as Record<string, ToolDef>
  await fails(T7.video_highlights.run({ video: file }), /Highlight-Suche fehlt/)
  assert.match((await T7.video_highlights.run({ video: file, overview: true })).text, /^Überblick über/, 'Signale im Cache: Überblick ohne Highlight-Suche')
  // über 10 min ohne from/to: Verweis auf Überblick und Fenster statt alles zu transkribieren; all erzwingt das ganze Video
  const T9 = Object.fromEntries(buildTools({ engine: { ...engine, video: { ...video, probe: async () => ({ duration: 1290, w: 1920, h: 1080 }) } }, getDeck: () => vd, setDeck: () => {}, assetDir: dir, outDir: dir }).map((t) => [t.name, t])) as Record<string, ToolDef>
  assert.equal((await T9.transcribe_video.run({ video: file })).text, 'Video ist 21:30 lang – erst video_highlights (overview: true), dann transcribe_video mit from/to der besten Fenster; das ganze Video nur für einen Fulltime-Schnitt mit all: true.')
  assert.match((await T9.transcribe_video.run({ video: file, all: true })).text, /· 21:30 · 1920×1080 · Sprache de · 2 Segmente/)
  // Bereich über 10 min ebenso gesperrt, fehlendes to = Videoende
  assert.match((await T9.transcribe_video.run({ video: file, from: 600 })).text, /^Bereich 10:00–21:30 ist 11:30 lang – erst video_highlights/)
  assert.match((await T9.transcribe_video.run({ video: file, from: 0, to: 700 })).text, /^Bereich 0:00–11:40 ist 11:40 lang/)
  assert.match((await T9.transcribe_video.run({ video: file, from: 700 })).text, /· 21:30 · 1920×1080 · Sprache de/)
  await fails(go('transcribe_video', { video: join(dir, 'fehlt.mp4') }), /Video nicht gefunden/)
  await fails(go('transcribe_video', { video: 'talk.mp4' }), /absoluten Dateipfad/)
  await fails(go('video_frames', { video: join(dir, 'notiz.txt'), times: [1] }), /kein unterstütztes Video/)
  const fr = await go('video_frames', { video: file, times: [1, 500] })
  assert.equal(fr.images!.length, 2); assert.match(fr.text, /2\. 74\.9 s \(1:14\)[\s\S]*32 % der Bildbreite/)
  // absoluter Pfad in clip.video wird zur asset://-URL, damit der Renderer das Video laden kann
  await go('create_deck', { title: 'Shorts', format: '9:16', brand: null })
  const added = await go('add_slides', { slides: [{ layout: 'clip', content: { video: file, hook: 'Der Kern in 5 Sekunden', parts: [{ start: 61.2, end: 66.8 }] } }] })
  assert.equal(vd!.slides[0].content.video, assetUrl(file))
  // Clip-Prüfung in der Antwort: Länge statt Autofit, Meldung aus lintClip
  assert.match(added.text, /^Folie 1 \(s[0-9a-f]{4}, clip\): OK · Länge 5,6 s · 1 Ausschnitt · Transkript ok · Übergang/)
  assert.match(added.text, /\n  - \[warn\] clip-laenge: Länge 5,6 s – für einen Short 20–90 s; verlängern/)
  // Hintergrundmusik: absoluter Pfad wird asset://, nur Audiodateien, null entfernt
  const mp3 = join(dir, 'music', 'ruhig.mp3')
  await fails(go('update_deck', { music: { src: mp3 } }), /Musik nicht gefunden/)
  mkdirSync(join(dir, 'music')); writeFileSync(mp3, '')
  assert.match((await go('update_deck', { music: { src: mp3, credit: '„Ruhig“ von X, CC BY 4.0' } })).text, /"music":\{"src":"asset:\/\/local\/.*ruhig\.mp3"/)
  assert.deepEqual(vd!.music, { src: assetUrl(mp3), credit: '„Ruhig“ von X, CC BY 4.0' })
  await fails(go('update_deck', { music: { src: join(dir, 'notiz.txt') } }), /keine Audiodatei/)
  await fails(go('update_deck', { music: { src: 'ruhig.mp3' } }), /absoluten Dateipfad/)
  await go('update_deck', { music: { src: `asset:${mp3}` } }) // Kurzform ohne local wird zur Form, die die Engine kennt
  assert.equal(vd!.music!.src, assetUrl(mp3))
  await go('update_deck', { music: null })
  assert.equal(vd!.music, undefined)
  // mp4: Übergänge mit Abblende zählen (ausgeblendete Folien und morph nicht), fehlende Musik melden
  const s0 = vd!.slides[0]
  vd!.slides.push({ ...s0, id: 'f1', transition: 'fade' }, { ...s0, id: 'm1', transition: 'morph' }, { ...s0, id: 'h1', transition: 'fade', hidden: true }, { ...s0, id: 'n1', transition: 'none' })
  assert.match((await go('export_deck', { format: 'mp4' })).text, /\n1 Übergang mit Abblende \(Folien-transition; none = harter Schnitt\)$/)
  vd!.music = { src: assetUrl(join(dir, 'music', 'weg.mp3')) }
  assert.match((await go('export_deck', { format: 'clips' })).text, /deck\.clips\nMusik nicht gefunden – ohne Musik exportiert/)
  vd!.music = { src: assetUrl(mp3) }
  assert.doesNotMatch((await go('export_deck', { format: 'mp4' })).text, /Musik nicht gefunden/)
  // Transkript-Suche: Zitat → Zeiten; ohne Transkript klarer nächster Schritt
  const found = await go('search_transcript', { video: file, query: 'der Kern' })
  assert.match(found.text, /^1 Stelle zu „der Kern“ in asset:.*\n1:01–1:06 · „Der Kern\.“ · from=61\.2 to=66\.8$/)
  assert.match((await go('search_transcript', { video: file, query: 'Quantenphysik' })).text, /^Keine Stelle/)
  const T8 = Object.fromEntries(buildTools({ engine: { ...engine, video: { ...video, cached: async () => ({ signals: null, highlights: [], transcript: null, duration: null }) } }, getDeck: () => vd, setDeck: () => {}, assetDir: dir, outDir: dir }).map((t) => [t.name, t])) as Record<string, ToolDef>
  assert.match((await T8.search_transcript.run({ video: file, query: 'Kern' })).text, /^Noch kein Transkript – erst transcribe_video/)
  // Überblick: eine Zeile je 90 s mit dem Anfang des Gesagten
  assert.match((await go('video_highlights', { video: file, overview: true })).text, /^Überblick über asset:.*\n0:00–1:15 · „Hallo zusammen\. Der Kern\.“\n/)
  // check_clip: ohne Video die Prüfung und eine verständliche Meldung statt eines ffmpeg-Fehlers; lint_deck mischt die Clip-Prüfung ein
  const blank = await go('add_slides', { slides: [{ layout: 'clip', content: { video: '', parts: [{ start: 0, end: 30 }] } }] })
  assert.match(blank.text, /: 1 FEHLER · Länge 30 s · 1 Ausschnitt · Transkript fehlt[\s\S]*\[error\] clip-video[\s\S]*\[hinweis\] clip-hook/)
  const chk = await go('check_clip', { slide: vd!.slides.at(-1)!.id })
  assert.match(chk.text, /clip-video[\s\S]*\nMusik nicht geprüft\nKein Kontaktabzug: kein Video gesetzt/); assert.equal(chk.images, undefined)
  // Musik: check_clip taggt die Sekunden der parts frisch (musicIn), auch ohne Signale im Cache
  const s1 = vd!.slides[0]
  vd!.slides.push({ ...s1, id: 'mu1', content: { ...s1.content, video: assetUrl(join(dir, 'weg.mp4')), parts: [{ start: 0, end: 30 }] } })
  const mu = await go('check_clip', { slide: 'mu1' })
  assert.match(mu.text, /\[warn\] clip-musik: Musik im Hintergrund \(10 s, u\. a\. bei 0:00\)[\s\S]*\nKein Kontaktabzug: Video nicht gefunden/); assert.doesNotMatch(mu.text, /Musik nicht geprüft/)
  await fails(go('check_clip', { slide: 'nope' }), /gibt es nicht/)
  assert.match((await go('lint_deck', {})).text, /^\d+ Fehler, \d+ Warnungen, \d+ Hinweise:[\s\S]*\[warn\] clip-laenge[\s\S]*\[hinweis\] clip-hook/)
}
await run('delete_slides', { ids: [c.id] })
assert.equal(deck!.slides.length, 2)
assert.equal(events, 14, 'setDeck nur bei echten Änderungen') // 6 + 3 aus dem Stil-Test + 2 aus dem Theme-Lint-Test + 2 tune + 1 Feinsatz-Test

// Abwechslung: neues Deck im selben Typ wie die letzten Decks → Hinweis (eigenes Tool-Set, damit events stimmt)
{
  const home = process.env.DECKWERK_HOME!
  const put = (dir: string, json: string) => { mkdirSync(join(home, dir)); writeFileSync(join(home, dir, 'deck.json'), json) }
  const json = (title: string, custom: object) => JSON.stringify({ title, theme: { id: 'custom', custom }, transition: 'fade', mode: 'click', slides: [] })
  const serif = (title: string) => json(title, look(title, '#FFFFFF', { titleWeight: 'regular', elements: 'line' }))
  put('alt-1', serif('Alt 1')); put('alt-2', serif('Alt 2')); put('kaputt', '{'); put('versions', serif('Alt 3'))
  assert.deepEqual(recentLooks().map((r) => r.title).sort(), ['Alt 1', 'Alt 2'])
  assert.deepEqual(recentLooks('Alt 1').map((r) => r.title), ['Alt 2'])
  let d: Deck | null = null
  const T4 = Object.fromEntries(buildTools({ engine, getDeck: () => d, setDeck: (x) => { d = x }, assetDir: '/nonexistent', outDir: '/tmp/out' }).map((t) => [t.name, t])) as Record<string, ToolDef>
  const make = async (input: unknown) => T4.create_deck.run(T4.create_deck.inputSchema.parse(input))
  const same = await make({ title: 'Neu', style: 'sachlich', brand: null, customTheme: look('Papier', '#FFFFFF', { headFont: 'Lora', titleWeight: 'regular' }) })
  assert.equal(d!.style, 'sachlich'); assert.match(same.text, /^Hinweis: Dieses Design gleicht im Typ deinen letzten Decks „Alt \d“, „Alt \d“ \(hell, Serif-Titel regular, Grund neutral, Bauteile Linie\)/m)
  // anderes Bauteil-Vokabular = anderer Typ: kein Hinweis
  assert.doesNotMatch((await make({ title: 'Frei', brand: null, customTheme: look('Papier', '#FFFFFF', { headFont: 'Lora', titleWeight: 'regular', elements: 'plain' }) })).text, /gleicht im Typ/)
  assert.equal(d!.theme.custom?.elements, 'plain')
  assert.notEqual(lookTyp({ id: 'custom', custom: look('A', '#FFFFFF', { elements: 'line' }) as never }).bauteile, lookTyp({ id: 'custom', custom: look('A', '#FFFFFF', { elements: 'plain' }) as never }).bauteile)
  // Designs von vor dem Hebel behalten ihre Kästen, neue ohne Angabe bekommen line
  assert.equal(lookTyp({ id: 'custom', custom: look('Alt', '#FFFFFF') as never }).bauteile, 'solid')
  await make({ title: 'Neu', brand: null, customTheme: look('Neu', '#FFFFFF') })
  assert.equal(d!.theme.custom?.elements, 'line')
  // update_deck an einem alten Deck: Korrektur behält die Kästen, ein neues Design (neuer Name) bekommt line
  const upd = (customTheme: object) => T4.update_deck.run(T4.update_deck.inputSchema.parse({ customTheme }))
  d = { ...d!, theme: { id: 'custom', custom: look('Alt', '#FFFFFF') as never } }
  await upd({ accent: '#1F5E7A' }); assert.equal(d!.theme.custom?.elements, undefined)
  await upd(look('Ganz neu', '#F5F3EE')); assert.equal(d!.theme.custom?.elements, 'line')
  // Altes Deck mit Lint-Fehler (Creme + Terrakotta, von vor dem Theme-Lint): Feinschliff und Korrekturen gehen, der alte Fehler ist nur Hinweis
  d = { ...d!, theme: { id: 'custom', custom: look('Alt', '#F6F1E7') as never } }
  const tuned = await T4.update_deck.run(T4.update_deck.inputSchema.parse({ tune: { margin: 'generous' } }))
  assert.equal(d!.theme.tune?.margin, 'generous'); assert.match(tuned.text, /\[error, schon vorher\] bg-tint/)
  await upd({ radius: 2 }); assert.equal(d!.theme.custom?.radius, 2)
  await fails(upd({ accent: '#7C3AED' }), /KI-Violett/) // neue Fehler weiter abgelehnt
  assert.match((await upd({ margin: 'asymmetric' })).text, /tune überschreibt customTheme\.margin; mit tune \{ margin: null \} entfernen/)
  // Altlast Space Grotesk: kleine Korrektur geht, ein neuer Entwurf (anderer Name) mit derselben Schrift nicht
  d = { ...d!, theme: { id: 'custom', custom: look('Alt', '#FFFFFF', { headFont: 'Space Grotesk' }) as never } }
  await upd({ radius: 0 }); assert.equal(d!.theme.custom?.radius, 0)
  await fails(upd(look('Neuer Entwurf', '#FFFFFF', { headFont: 'Space Grotesk' })), /Space Grotesk ist Standard generierter Designs/)
  // Brand-Kit: Markenfarbe und -schrift sind Vorgabe, auch wenn sie wie ein Klischee aussehen
  await make({ title: 'Marke', brand: { primary: '#6366F1', headFont: 'Space Grotesk' }, customTheme: look('Marke', '#FFFFFF', { accent: '#6366F1', headFont: 'Space Grotesk' }) })
  assert.equal(d!.theme.brand?.primary, '#6366F1')
  // Plakat-Nachbau: Archivo Black auf kräftigem Grund
  await make({ title: 'Plakat', brand: null, style: 'mutig', customTheme: { name: 'Plakat', bg: '#FFD100', text: '#111111', accent: '#111111', headFont: 'Archivo Black', bodyFont: 'Archivo', radius: 0, decor: 'none', titleSize: 'huge', vivid: true, elements: 'solid' } })
  assert.equal(d!.theme.custom?.headFont, 'Archivo Black')
  // Katalogschriften: Tippfehler mit Vorschlag, offline Ersatz im Ergebnis, „sehr verbreitet“ nur bei Katalogschriften
  await fails(make({ title: 'Typo', brand: null, customTheme: look('Typo', '#FFFFFF', { headFont: 'Newsreder' }) }), /meintest du „Newsreader“/)
  assert.match((await make({ title: 'Zeitung', brand: null, customTheme: look('Zeitung', '#FFFFFF', { headFont: 'Newsreader', bodyFont: 'Roboto' }) })).text, /Roboto ist sehr verbreitet[\s\S]*Schriften: Newsreader: nicht verfügbar \(offline\), Ersatz Georgia/)
  const slide = async (font: string) => T4.add_slides.run(T4.add_slides.inputSchema.parse({ slides: [{ layout: 'blank', content: {}, items: [{ kind: 'text', text: 'x', font, x: 60, y: 60, w: 400, h: 40 }] }] }))
  await fails(slide('Inter Tigt'), /meintest du „Inter Tight“/)
  assert.match((await slide('Inter Tight')).text, /^Schriften: .*Inter Tight: nicht verfügbar \(offline\), Ersatz Inter\n/)
  assert.doesNotMatch((await slide('head')).text, /Schriften/, 'gleiche Schriften: kein neuer Ladeversuch')
  assert.doesNotMatch((await make({ title: 'Nacht', brand: null, customTheme: look('Nacht', '#12261E', { headFont: 'Inter' }) })).text, /gleicht im Typ/)
  put('nacht', json('Nacht', look('Nacht', '#12261E', { headFont: 'Inter', elements: 'line' })))
  await fails(T4.propose_looks.run(T4.propose_looks.inputSchema.parse({ looks: [look('Papier', '#FFFFFF', { titleWeight: 'regular', titleSize: 'large', rule: 'over' }), look('Nachtblau', '#12261E', { headFont: 'Inter' })] })), /Alle Looks gleichen im Typ/)
  await T4.update_deck.run(T4.update_deck.inputSchema.parse({ style: 'mutig' })); assert.equal(d!.style, 'mutig')
}

const sys = buildSystemPrompt()
assert.ok(sys.includes('# Design-Guide') && sys.includes('### kpi-grid') && sys.includes('"maxLength"'))
assert.match(sys, /## Zuletzt gebaute Decks \(nur für neue Decks[^\n]*\n(- .*\n)*- „Alt \d“: hell, Serif-Titel regular \(Fraunces\), Grund neutral, Bauteile line, Akzent #/)
assert.equal(sys, buildSystemPrompt(), 'Systemprompt stabil (Caching)')
if (realHome === undefined) delete process.env.DECKWERK_HOME
else process.env.DECKWERK_HOME = realHome
console.log(`Tools OK · Systemprompt ${sys.length} Zeichen`)

if (process.argv.includes('--live')) {
  const agent = new DeckAgent({ engine, thumbnails: false, onEvent: (e) => (e.type === 'text' ? process.stdout.write(e.delta) : console.log('\n[' + e.type + ']', 'name' in e ? `${e.name} ${e.status} ${e.summary ?? ''}` : 'message' in e ? e.message : '')) })
  await agent.send('Baue ein Deck mit 3 Folien (cover, statement, closing) zum Thema „Vier-Tage-Woche im Team“. Keine Rückfragen, kein Export.')
  assert.equal(agent.deck?.slides.length, 3)
  console.log('\nLive OK')
}
