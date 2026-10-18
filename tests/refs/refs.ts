// Chromium-Referenzen für dw-refcheck: je Theme × Format × Layout × Variante × Sample eine Folie,
// geschrieben als <out>/<theme>/<format>/<layout>-<variant>-<sample>.{measured.json,png,lines.json} plus decks.json je Ordner.
// Wird in eine Kopie der alten Engine nach src/main/refs.ts gelegt und über DW_REFS=<out> aus checkLayouts gestartet (README).
import { BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FORMATS, type Deck, type FormatId } from '../shared/deck'
import { LAYOUTS, type LayoutDef } from '../shared/layouts'
import type { Engine } from './agent'

type Sample = 'min' | 'typ' | 'max'

// Sichtbare Zeilen je Text-Slot in Dokumentreihenfolge: Zeilen wie lineTops (measure.ts), jedes Zeichen der Zeile zugeordnet, in der seine Mitte liegt.
const LINES_JS = `(() => {
  const root = document.querySelector('.slide')
  const range = document.createRange()
  return [...root.querySelectorAll('[data-pptx="text"]')].map((el) => {
    range.selectNodeContents(el)
    const tol = (3 * el.getBoundingClientRect().width) / (el.offsetWidth || 1)
    const rects = [...range.getClientRects()].filter((r) => r.width > 0).sort((a, b) => b.height - a.height)
    const boxes = []
    for (const r of rects) if (!boxes.some((l) => r.top > l.top - tol && r.bottom < l.bottom + tol)) boxes.push(r)
    boxes.sort((a, b) => a.top - b.top)
    const text = boxes.map(() => '')
    let cur = 0
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      for (let i = 0; i < n.data.length; i++) {
        range.setStart(n, i); range.setEnd(n, i + 1)
        const r = [...range.getClientRects()].find((r) => r.height > 0)
        if (r) { const c = (r.top + r.bottom) / 2; const j = boxes.findIndex((l) => c >= l.top - tol && c <= l.bottom + tol); if (j >= 0) cur = j }
        if (boxes.length) text[cur] += n.data[i]
      }
    return { slot: el.dataset.slot ?? 'el', lines: text.map((t) => t.replace(/\\u00ad/g, '').replace(/\\s+/g, ' ').trim()) }
  })
})()`

// beratung: alle Samples in 16:9, typ in 4:5 und a4; keynote/corporate: typ in 16:9. Layouts mit sizes nur in ihren Formaten (beratung alle Samples, sonst typ).
function plan(def: LayoutDef, theme: string, format: FormatId): Sample[] {
  const all = theme === 'beratung'
  if (def.sizes) return def.sizes.includes(format) ? (all ? ['min', 'typ', 'max'] : ['typ']) : []
  if (format === '16:9') return all ? ['min', 'typ', 'max'] : ['typ']
  return all && (format === '4:5' || format === 'a4') ? ['typ'] : []
}

export async function writeRefs(engine: Engine, out: string): Promise<boolean> {
  const only = process.env.DW_LAYOUTS?.split(',') // z. B. DW_LAYOUTS=cover,bullets
  const defs = (Object.values(LAYOUTS) as LayoutDef[]).filter((d) => !only || only.includes(d.id))
  const formats = [...new Set<FormatId>(['16:9', '4:5', 'a4', ...defs.flatMap((d) => d.sizes ?? [])])]
  let n = 0
  for (const theme of ['beratung', 'keynote', 'corporate'])
    for (const format of formats) {
      const dir = join(out, theme, format.replace(':', 'x'))
      const decks: Record<string, Deck> = {}
      const { w, h } = FORMATS[format]
      for (const def of defs)
        for (const variant of def.variants ?? [undefined])
          for (const sample of plan(def, theme, format)) {
            const stem = `${def.id}-${variant ?? 'default'}-${sample}`
            // transition/mode verlangt der TS-Typ, die Folien-Darstellung hängt nicht davon ab; 16:9 ohne size wie bisher
            const deck: Deck = { title: 'Beispiel', theme: { id: theme }, transition: 'none', mode: 'click', ...(format !== '16:9' && { size: { w, h } }),
              slides: [{ id: 's1', layout: def.id, ...(variant && { variant }), content: def.samples[sample] }] }
            decks[stem] = deck
            // renderPng rendert immer neu und füllt den Cache, measure liest ihn; danach steht die Folie noch im Render-Fenster
            const [png] = await engine.renderPng(deck, [0], 2 * w)
            const win = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().endsWith('#render'))!
            const lines = await win.webContents.executeJavaScript(LINES_JS, true)
            const [m] = await engine.measure(deck)
            await mkdir(dir, { recursive: true })
            await writeFile(join(dir, `${stem}.measured.json`), JSON.stringify(m, null, 2))
            await writeFile(join(dir, `${stem}.lines.json`), JSON.stringify(lines, null, 2))
            await writeFile(join(dir, `${stem}.png`), png)
            n++
            console.log(`${theme}/${format} ${stem}: ok=${m.fit.ok} head=${m.fit.head} body=${m.fit.body}`)
          }
      if (n && Object.keys(decks).length) await writeFile(join(dir, 'decks.json'), JSON.stringify(decks, null, 2))
    }
  console.log(`${n} Referenzen`)
  return true
}
