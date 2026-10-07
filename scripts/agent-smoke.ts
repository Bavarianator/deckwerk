// Smoke-Test für Tools + Systemprompt ohne API (Mock-Engine). Mit --live und ANTHROPIC_API_KEY zusätzlich ein echter Agent-Turn.
// Aufruf: npx esbuild scripts/agent-smoke.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/agent-smoke.mjs && node out/agent-smoke.mjs [--live]
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeckAgent, buildSystemPrompt, toRunnable, type Engine } from '../src/main/agent'
import { z } from 'zod'
import { assetUrl, buildTools, imageSettings, lookTyp, recentLooks, webpSize, imageSize, type ToolDef } from '../src/main/tools'
import type { Deck } from '../src/shared/deck'
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

assert.equal(tools.length, 16)
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
await fails(run('propose_looks', { looks: [look('Hell', '#F6F1E7'), look('Dunkel', '#12261E')] }), /unterscheiden sich kaum/) // nur umgefärbt
await fails(run('propose_looks', { looks: [look('Hell', '#F6F1E7'), look('Dunkel', '#12261E', { headFont: 'Space Grotesk', titleSize: 'large', rule: 'over' })] }), /Standardschrift/)
const looks = await run('propose_looks', { looks: [look('Hell', '#F6F1E7'), look('Dunkel', '#12261E', { headFont: 'Inter', titleSize: 'large', rule: 'over' })] }) as { text: string; images: Buffer[] }
assert.equal(looks.images.length, 2); assert.match(looks.text, /Hell[\s\S]*Dunkel/)
await fails(run('add_slides', { slides: [{ layout: 'cover', content: { title: 'x' } }] }), /create_deck/)
// KI-Klischees in create_deck/update_deck: Hinweis statt Ablehnung (der Nutzer darf sie wünschen)
assert.match((await run('create_deck', { title: 'Test', customTheme: look('Tech', '#0E0E0E', { headFont: 'Space Grotesk', accent: '#C6F432' }) })).text, /^Hinweis: Space Grotesk[\s\S]*Hinweis: Säuregrün/)
assert.match((await run('update_deck', { customTheme: { accent: '#7C3AED', headFont: 'Fraunces' } })).text, /^Hinweis: Akzent #7C3AED/)
assert.doesNotMatch((await run('update_deck', { customTheme: { accent: '#C4552D' } })).text, /Hinweis/)
const created = await run('create_deck', { title: 'Test', theme: 'midnight' })
assert.equal(deck!.theme.id, 'midnight'); assert.equal(deck!.transition, 'fade')
assert.equal(deck!.style, undefined); assert.match(created.text, /Stil nicht gewählt/)
// Stil-Regler: mutig setzen und zurück; vivid hält den kräftigen Grund (nur aus dem mittleren Helligkeitsband geschoben)
await run('update_deck', { style: 'mutig', customTheme: look('Koralle', '#FFD100', { vivid: true }) })
assert.equal(deck!.style, 'mutig'); assert.equal(resolveTheme(deck!.theme).c.bg.toLowerCase(), '#ffd100')
await run('update_deck', { style: 'sachlich', customTheme: { vivid: false } })
assert.equal(deck!.style, 'sachlich'); assert.notEqual(resolveTheme(deck!.theme).c.bg.toLowerCase(), '#ffd100', 'ohne vivid dämpft die Engine')
await run('update_deck', { theme: 'midnight' })
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
await run('delete_slides', { ids: [c.id] })
assert.equal(deck!.slides.length, 2)
assert.equal(events, 13, 'setDeck nur bei echten Änderungen') // 6 + 3 aus dem Stil-Test + 3 aus dem Klischee-Test + 1 Feinsatz-Test

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
  const make = (input: unknown) => T4.create_deck.run(T4.create_deck.inputSchema.parse(input))
  const same = await make({ title: 'Neu', style: 'sachlich', brand: null, customTheme: look('Papier', '#FFFFFF', { headFont: 'Lora', titleWeight: 'regular' }) })
  assert.equal(d!.style, 'sachlich'); assert.match(same.text, /^Hinweis: Dieses Design gleicht im Typ deinen letzten Decks „Alt \d“, „Alt \d“ \(hell, Serif-Titel regular, Grund neutral, Bauteile Linie\)/)
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
  await upd(look('Ganz neu', '#F2ECE0')); assert.equal(d!.theme.custom?.elements, 'line')
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
