import { nativeImage } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Deck, Measured } from '../shared/deck'
import { handout } from '../shared/handout'
import { lintDeck } from '../shared/lint'
import type { Engine } from './agent'
import { buildPptx } from './export-pptx'
import { renderOverview, renderPdf, renderSlide, type Rendered } from './render'

const slug = (s: string) => s.toLowerCase().replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c]!).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck'

export function createEngine(): Engine {
  // ponytail: unbounded measure cache keyed by everything a slide render depends on; fine for a desktop session
  const cache = new Map<string, Measured>()
  const key = (deck: Deck, i: number) => JSON.stringify([deck.slides[i], deck.theme, deck.title, i])

  async function measure(deck: Deck, indices = deck.slides.map((_, i) => i)): Promise<Measured[]> {
    const out: Measured[] = []
    for (const i of indices) {
      const k = key(deck, i)
      if (!cache.has(k)) cache.set(k, (await renderSlide(deck, i)).measured)
      out.push(cache.get(k)!)
    }
    return out
  }

  return {
    measure,
    async renderPng(deck, indices, width = 1024) {
      const out: Buffer[] = []
      for (const i of indices) {
        const r = await renderSlide(deck, i, { png: true })
        cache.set(key(deck, i), r.measured)
        out.push(nativeImage.createFromBuffer(r.png!).resize({ width, quality: 'best' }).toPNG())
      }
      return out
    },
    async renderOverview(deck) {
      const png = await renderOverview(deck)
      return nativeImage.createFromBuffer(png).resize({ width: 1600, quality: 'best' }).toPNG()
    },
    thumbnail(img, width) {
      const n = nativeImage.createFromBuffer(img)
      return n.isEmpty() ? null : n.resize({ width, quality: 'good' }).toJPEG(80)
    },
    async lint(deck) {
      return lintDeck(deck, await measure(deck))
    },
    async exportDeck(deck, format, outDir) {
      await mkdir(outDir, { recursive: true })
      const base = join(outDir, slug(deck.title))
      if (format === 'md') {
        await writeFile(`${base}.md`, handout(deck))
        return [`${base}.md`]
      }
      if (format === 'pdf') {
        await writeFile(`${base}.pdf`, await renderPdf(deck))
        return [`${base}.pdf`]
      }
      const slides: Rendered[] = []
      for (let i = 0; i < deck.slides.length; i++) slides.push(await renderSlide(deck, i, { png: format === 'png', background: format === 'pptx' }))
      if (format === 'png') {
        await mkdir(base, { recursive: true })
        const files = slides.map((_, i) => join(base, `${String(i + 1).padStart(2, '0')}.png`))
        await Promise.all(files.map((f, i) => writeFile(f, slides[i].png!)))
        return files
      }
      await writeFile(`${base}.pptx`, await buildPptx(deck, slides.map((s) => ({ measured: s.measured, background: s.background! }))))
      return [`${base}.pptx`]
    },
  }
}
