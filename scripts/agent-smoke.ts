// Smoke-Test für Tools + Systemprompt ohne API (Mock-Engine). Mit --live und ANTHROPIC_API_KEY zusätzlich ein echter Agent-Turn.
// Aufruf: npx esbuild scripts/agent-smoke.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/agent-smoke.mjs && node out/agent-smoke.mjs [--live]
import assert from 'node:assert/strict'
import { DeckAgent, buildSystemPrompt, type Engine } from '../src/main/agent'
import { buildTools, type ToolDef } from '../src/main/tools'
import type { Deck } from '../src/shared/deck'

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

assert.equal(tools.length, 15)
const look = (name: string, bg: string) => ({ name, bg, accent: '#C4552D', headFont: 'Fraunces', bodyFont: 'Manrope', radius: 4, decor: 'rings' })
const looks = await run('propose_looks', { looks: [look('Hell', '#F6F1E7'), look('Dunkel', '#12261E')] }) as { text: string; images: Buffer[] }
assert.equal(looks.images.length, 2); assert.match(looks.text, /Hell[\s\S]*Dunkel/)
await fails(run('add_slides', { slides: [{ layout: 'cover', content: { title: 'x' } }] }), /create_deck/)
await run('create_deck', { title: 'Test', theme: 'midnight' })
assert.equal(deck!.theme.id, 'midnight'); assert.equal(deck!.transition, 'fade')
await fails(run('add_slides', { slides: [{ layout: 'cover', content: { title: 'Okay' } }, { layout: 'agenda', content: { title: 'Agenda', items: [] } }] }), /slides\[1\] \(agenda\)[\s\S]*items/)
assert.equal(deck!.slides.length, 0, 'Batch mit Fehler ändert nichts')
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
assert.match((await run('export_deck', { format: 'pptx' })).text, /deck\.pptx/)
await run('delete_slides', { ids: [c.id] })
assert.equal(deck!.slides.length, 2)
assert.equal(events, 6, 'setDeck nur bei echten Änderungen')

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
