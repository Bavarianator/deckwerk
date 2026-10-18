// Layout-Wechsel: npx esbuild scripts/check-layout-switch.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=${TMPDIR:-/tmp}/check-layout-switch.mjs && node ${TMPDIR:-/tmp}/check-layout-switch.mjs
import assert from 'node:assert/strict'
import { LAYOUTS, type LayoutId } from '../src/shared/layouts'
import { switchLayout } from '../src/shared/layout-switch'

const PAIRS: [LayoutId, LayoutId][] = [['bullets', 'image-text'], ['bullets', 'process'], ['kpi-grid', 'bullets'], ['image-text', 'bullets'], ['two-column', 'bullets'], ['timeline', 'process'], ['bullets', 'chart']]
for (const [a, b] of PAIRS) {
  const content = structuredClone(LAYOUTS[a].samples.typ) as Record<string, unknown>
  const r = switchLayout({ id: 's', layout: a, content } as never, b)
  const ok = LAYOUTS[b].schema.safeParse(r.content)
  assert.ok(ok.success, `${a} → ${b}: ungültig ${!ok.success && ok.error.message}`)
  assert.equal((r.content as { title: string }).title, content.title, `${a} → ${b}: Titel verloren`)
  console.log(`${a} → ${b}: ok, verloren: ${r.lost.join(', ') || '–'}`)
}
// Liste wird übernommen statt aus dem Muster gefüllt
const bl = { id: 's', layout: 'bullets', content: { title: 'Drei Gründe für den Umstieg', items: [{ text: 'Eins schnell' }, { text: 'Zwei billig' }, { text: 'Drei gut' }] } } as never
const it = switchLayout(bl, 'image-text').content as { points?: string[] }
assert.deepEqual(it.points, ['Eins schnell', 'Zwei billig', 'Drei gut'])
// unbekanntes Feld wird als verloren gemeldet
assert.ok(switchLayout({ id: 's', layout: 'x', content: { title: 'Ein Titel hier', zitat: 'weg' } } as never, 'bullets').lost.includes('zitat'))
// Zeit: auch große Inhalte (Video-Folien, lange Listen) dürfen die UI nicht hängen lassen
const big = { id: 's', layout: 'x', content: { title: 'Viele Punkte auf einer Folie', items: Array.from({ length: 400 }, (_, i) => ({ text: `Punkt ${i} mit etwas Text`, sub: 'x'.repeat(200) })), parts: Array.from({ length: 300 }, (_, i) => ({ from: i, to: i + 1 })) } } as never
for (const [name, slide] of [['clip', { id: 's', layout: 'clip', content: LAYOUTS.clip.samples.max }], ['schnitt', { id: 's', layout: 'schnitt', content: LAYOUTS.schnitt.samples.max }], ['groß', big]] as const)
  for (const to of ['bullets', 'image-text', 'process', 'kpi-grid', 'agenda', 'gallery', 'timeline'] as LayoutId[]) {
    const t = performance.now()
    switchLayout(slide as never, to)
    const ms = performance.now() - t
    assert.ok(ms < 50, `${name} → ${to}: ${ms.toFixed(0)} ms`)
  }
console.log('check-layout-switch: ok')
