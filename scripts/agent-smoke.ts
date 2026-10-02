// Smoke-Test für Tools + Systemprompt ohne API (Mock-Engine). Mit --live und ANTHROPIC_API_KEY zusätzlich ein echter Agent-Turn.
// Aufruf: npx esbuild scripts/agent-smoke.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/agent-smoke.mjs && node out/agent-smoke.mjs [--live]
import assert from 'node:assert/strict'
import { DeckAgent, buildSystemPrompt, toRunnable, type Engine } from '../src/main/agent'
import { z } from 'zod'
import { buildTools, imageSettings, webpSize, type ToolDef } from '../src/main/tools'
import type { Deck } from '../src/shared/deck'
import { resolveTheme } from '../src/shared/themes'
import { autoPick } from '../src/shared/models'

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
assert.deepEqual(webp('524946463610000057454250565038202a100000f010019d012ad20437023e6d'), { width: 1234, height: 567 })
assert.deepEqual(webp('52494646a6030000574542505650384c9a0300002fe8035300063169b2fef5c5'), { width: 1001, height: 333 })
assert.deepEqual(webp('524946463c0a000057454250565038580a000000100000000803002a0200414c'), { width: 777, height: 555 })
assert.equal(webp('ffd8ffe000104a46494600010100000100010000ffdb0043000302020302020303'), null)
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
await run('create_deck', { title: 'Test', theme: 'midnight' })
assert.equal(deck!.theme.id, 'midnight'); assert.equal(deck!.transition, 'fade')
// Stil-Regler: mutig setzen und zurück; vivid hält den kräftigen Grund (nur aus dem mittleren Helligkeitsband geschoben)
await run('update_deck', { style: 'mutig', customTheme: look('Koralle', '#FFD100', { vivid: true }) })
assert.equal(deck!.style, 'mutig'); assert.equal(resolveTheme(deck!.theme).c.bg.toLowerCase(), '#ffd100')
await run('update_deck', { style: 'sachlich', customTheme: { vivid: false } })
assert.equal(deck!.style, undefined); assert.notEqual(resolveTheme(deck!.theme).c.bg.toLowerCase(), '#ffd100', 'ohne vivid dämpft die Engine')
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
  assert.match(r.text, /asset:\/\/local\/.*unsplash-abc\.jpg — 1920×1280 px, teacher in classroom \(Foto: Jane/)
  assert.ok(calls.includes('https://img/r?ixid=1&w=1920&q=82&fm=jpg'), '1920-px-Download')
  assert.ok(existsSync(join(assetDir, 'unsplash-abc.jpg')) && r.images!.length === 1 && r.images![0][0] === 0xff)
  assert.ok(calls.some((u) => u.includes('per_page=3&orientation=landscape')) && calls.includes('https://api/dl'), 'Suche + Download-Meldung')
  assert.match((await T2.find_images.run(T2.find_images.inputSchema.parse({}))).text, /unsplash-abc\.jpg/, 'danach lokal auffindbar')
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
await run('delete_slides', { ids: [c.id] })
assert.equal(deck!.slides.length, 2)
assert.equal(events, 9, 'setDeck nur bei echten Änderungen') // 6 + 3 aus dem Stil-Test

const sys = buildSystemPrompt()
assert.ok(sys.includes('# Design-Guide') && sys.includes('### kpi-grid') && sys.includes('"maxLength"'))
assert.equal(sys, buildSystemPrompt(), 'Systemprompt stabil (Caching)')
console.log(`Tools OK · Systemprompt ${sys.length} Zeichen`)

if (process.argv.includes('--live')) {
  const agent = new DeckAgent({ engine, thumbnails: false, onEvent: (e) => (e.type === 'text' ? process.stdout.write(e.delta) : console.log('\n[' + e.type + ']', 'name' in e ? `${e.name} ${e.status} ${e.summary ?? ''}` : 'message' in e ? e.message : '')) })
  await agent.send('Baue ein Deck mit 3 Folien (cover, statement, closing) zum Thema „Vier-Tage-Woche im Team“. Keine Rückfragen, kein Export.')
  assert.equal(agent.deck?.slides.length, 3)
  console.log('\nLive OK')
}
