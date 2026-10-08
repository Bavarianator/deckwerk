// „Andere Gestaltung“: npx esbuild scripts/check-looks.ts --bundle --platform=node --format=esm --outfile=out/check-looks.mjs && node out/check-looks.mjs
import { deepStrictEqual as eq, ok } from 'node:assert'
import { LAYOUTS, looksOf, nextLook, type LayoutId } from '../src/shared/layouts'
import type { Slide } from '../src/shared/deck'

const key = (def: (typeof LAYOUTS)[LayoutId], l: Partial<Slide>) => `${l.variant ?? def.variants?.[0]}|${l.frame ?? 'top'}|${l.tone ?? ''}`
let n = 0
for (const [id, def] of Object.entries(LAYOUTS) as [LayoutId, (typeof LAYOUTS)[LayoutId]][]) {
  if (!def.variants && !def.frames) continue
  const slide = { layout: id, content: {} } as Slide
  const looks = looksOf(slide)
  const keys = looks.map((l) => key(def, l))
  ok(looks.length > 0, `${id}: keine Alternativen`)
  eq(new Set(keys).size, keys.length, `${id}: doppelte Kombinationen`)
  ok(!keys.includes(key(def, slide)), `${id}: enthält die aktuelle Kombination`)
  for (const l of looks) {
    ok(!l.variant || def.variants?.includes(l.variant), `${id}: Variante ${l.variant}`)
    ok(!l.frame || def.frames?.includes(l.frame), `${id}: Komposition ${l.frame}`)
    ok(!l.tone || !def.tone, `${id}: Ton trotz eigenem Standard-Ton`)
  }
  // Zyklus: nextLook besucht alle Kombinationen und kehrt zum Start zurück.
  const seen = new Set([key(def, slide)])
  let cur = slide
  for (let i = 0; i <= keys.length; i++) {
    cur = { ...cur, ...nextLook(cur) }
    seen.add(key(def, cur))
  }
  eq(seen.size, keys.length + 1, `${id}: nextLook-Zyklus unvollständig`)
  eq(key(def, cur), key(def, slide), `${id}: nextLook kehrt nicht zurück`)
  // Ton „normal“ gilt wie kein Ton: aktuelle Kombination fehlt, Zyklus bleibt.
  eq(looksOf({ ...slide, tone: 'normal' }).map((l) => key(def, l)), keys, `${id}: tone normal`)
  eq(key(def, nextLook({ ...slide, tone: 'normal' })), key(def, nextLook(slide)), `${id}: nextLook bei tone normal`)
  // Von jeder Kombination aus: Alternativen enthalten nie sie selbst.
  for (const l of looks) ok(!looksOf({ ...slide, ...l }).some((x) => key(def, x) === key(def, l)), `${id}: eigene Kombination`)
  n++
}
ok(n > 0)
console.log(`check-looks: ${n} Layouts ok`)
