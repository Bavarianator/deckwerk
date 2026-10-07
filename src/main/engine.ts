import { nativeImage } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { formatSuffix, sizeOf, type Deck, type Measured } from '../shared/deck'
import { handout } from '../shared/handout'
import { lintDeck } from '../shared/lint'
import type { Engine } from './agent'
import { buildDocx } from './export-docx'
import { buildPptx, fontsOf } from './export-pptx'
import { renderOverview, renderPdf, renderPrintPdf, renderSlide, type Rendered } from './render'

const slug = (s: string) => s.toLowerCase().replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c]!).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck'

export function createEngine(): Engine {
  // ponytail: unbounded measure cache keyed by everything a slide render depends on; fine for a desktop session
  const cache = new Map<string, Measured>()
  const key = (deck: Deck, i: number) => JSON.stringify([deck.slides[i], deck.theme, deck.title, deck.size, i])

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
    async exportDeck(deck, format, outDir, print) {
      await mkdir(outDir, { recursive: true })
      const base = join(outDir, slug(deck.title) + formatSuffix(deck.size)) // Format im Namen: gleiche Titel in 4:5 und A4 überschreiben sich nicht
      if (format === 'md') {
        await writeFile(`${base}.md`, handout(deck))
        return [`${base}.md`]
      }
      if (format === 'pdf') {
        await writeFile(`${base}.pdf`, await renderPdf(deck))
        return [`${base}.pdf`]
      }
      if (format === 'print') {
        // Name nach Druckformat: flyer-a5-druck.pdf, flyer-a4-quer-druck.pdf; ohne Format wie das Deck (flyer-a4-druck.pdf)
        const file = `${print?.size ? join(outDir, `${slug(deck.title)}-${print.size}${sizeOf(deck).w > sizeOf(deck).h ? '-quer' : ''}`) : base}-druck.pdf`
        await writeFile(file, await renderPrintPdf(deck, print))
        return [file]
      }
      if (format === 'zip') {
        const zip = new JSZip()
        for (let i = 0; i < deck.slides.length; i++) zip.file(`${String(i + 1).padStart(2, '0')}.png`, (await renderSlide(deck, i, { png: true })).png!)
        zip.file(`${slug(deck.title)}.pdf`, await renderPdf(deck))
        await writeFile(`${base}.zip`, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })) // PNG ist schon komprimiert
        return [`${base}.zip`]
      }
      const slides: Rendered[] = []
      // Word: nur der Text wird nativ (bearbeitbare Textfelder), Fotos, Flächen und Diagramme bleiben im Hintergrundbild
      for (let i = 0; i < deck.slides.length; i++) slides.push(await renderSlide(deck, i, { png: format === 'png', background: format === 'docx' ? 'text' : format === 'pptx' }))
      if (format === 'png') {
        await mkdir(base, { recursive: true })
        const files = slides.map((_, i) => join(base, `${String(i + 1).padStart(2, '0')}.png`))
        await Promise.all(files.map((f, i) => writeFile(f, slides[i].png!)))
        return files
      }
      if (format === 'docx') {
        await writeFile(`${base}.docx`, await buildDocx(deck, slides.map((s) => ({ measured: s.measured, background: s.background! })), fontsOf(deck)))
        return [`${base}.docx`]
      }
      await writeFile(`${base}.pptx`, await buildPptx(deck, slides.map((s) => ({ measured: s.measured, background: s.background! }))))
      return [`${base}.pptx`]
    },
  }
}
