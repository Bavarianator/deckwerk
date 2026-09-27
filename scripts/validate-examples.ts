// Prüft examples/*.json gegen die Layout-Schemas (schnell, ohne Electron).
// Aufruf: npx esbuild scripts/validate-examples.ts --bundle --platform=node --format=esm --outfile=out/validate-examples.mjs && node out/validate-examples.mjs [datei…]
import { readdirSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { LAYOUTS, type LayoutId } from '../src/shared/layouts'
import type { Deck } from '../src/shared/deck'

const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('examples').filter((f) => f.endsWith('.json')).map((f) => `examples/${f}`)
let bad = 0
for (const file of files) {
  const deck: Deck = JSON.parse(readFileSync(file, 'utf8'))
  const ids = new Set<string>()
  for (const [i, s] of deck.slides.entries()) {
    const def = LAYOUTS[s.layout as LayoutId]
    if (!def) { console.log(`${file} #${i + 1}: unbekanntes Layout ${s.layout}`); bad++; continue }
    if (ids.has(s.id)) { console.log(`${file} #${i + 1}: doppelte ID ${s.id}`); bad++ }
    ids.add(s.id)
    const r = def.schema.safeParse(s.content)
    if (!r.success) { bad++; console.log(`${file} #${i + 1} ${s.layout}:\n${z.prettifyError(r.error)}`) }
  }
  console.log(`${file}: ${deck.slides.length} Folien, Layouts ${[...new Set(deck.slides.map((s) => s.layout))].join(' ')}`)
}
console.log(bad ? `${bad} ungültig` : 'alle gültig')
process.exit(bad ? 1 : 0)
