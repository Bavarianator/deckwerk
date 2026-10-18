// Chromium-Referenzen für dw-refcheck: je Layout × Variante × Sample eine Folie (Theme beratung, 16:9),
// geschrieben als <out>/<layout>-<variant>-<sample>.{measured.json,png} plus decks.json (Eingabe je Kombination).
// Wird in eine Kopie der alten Engine nach src/main/refs.ts gelegt und über DW_REFS=<out> aus checkLayouts gestartet (README).
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Deck } from '../shared/deck'
import { LAYOUTS, type LayoutDef } from '../shared/layouts'
import type { Engine } from './agent'

export async function writeRefs(engine: Engine, out: string): Promise<boolean> {
  await mkdir(out, { recursive: true })
  const decks: Record<string, Deck> = {}
  for (const id of ['cover', 'bullets', 'two-column']) {
    const def = (LAYOUTS as Record<string, LayoutDef>)[id]
    for (const variant of def.variants!)
      for (const sample of ['min', 'typ', 'max'] as const) {
        const stem = `${id}-${variant}-${sample}`
        // wie dw-scene samples::deck; transition/mode verlangt der TS-Typ, die Folien-Darstellung hängt nicht davon ab
        const deck: Deck = { title: 'Beispiel', theme: { id: 'beratung' }, transition: 'none', mode: 'click', slides: [{ id: 's1', layout: id, variant, content: def.samples[sample] }] }
        decks[stem] = deck
        const [m] = await engine.measure(deck)
        const [png] = await engine.renderPng(deck, [0], 2560) // 2× wie heute
        await writeFile(join(out, `${stem}.measured.json`), JSON.stringify(m, null, 2))
        await writeFile(join(out, `${stem}.png`), png)
        console.log(`${stem}: ok=${m.fit.ok} head=${m.fit.head} body=${m.fit.body}`)
      }
  }
  await writeFile(join(out, 'decks.json'), JSON.stringify(decks, null, 2))
  return true
}
