import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { assetUrl } from './tools'
import type { Deck, Slide, ThemeSpec } from '../shared/deck'
import { LAYOUTS } from '../shared/layouts'
import { lintSlide } from '../shared/lint'
import { THEMES } from '../shared/themes'
import type { Engine } from './agent'

// Stress test: every layout × variant × sample (min/typ/max) × theme must render without lint errors.
// Writes one PNG per combination to exports/check/ for visual review. Returns false on any error.
export async function checkLayouts(engine: Engine, outDir = 'exports/check'): Promise<boolean> {
  await mkdir(outDir, { recursive: true })
  const slides: Slide[] = []
  for (const def of Object.values(LAYOUTS))
    for (const variant of def.variants ?? [undefined])
      for (const sample of ['min', 'typ', 'max'] as const)
        slides.push({ id: `${def.id}${variant ? `.${variant}` : ''}.${sample}`, layout: def.id, variant, content: def.samples[sample] })
  // Foto-Layouts: typ-Sample zusätzlich mit echten Fotos (Porträt für Zitate), damit Zuschnitt, Overlay und Kontrast geprüft werden
  const sample = (name: string) => assetUrl(join(app.getAppPath(), 'assets/samples', `${name}.jpg`))
  for (const def of Object.values(LAYOUTS)) {
    let json = JSON.stringify(def.samples.typ)
    if (!json.includes('"src":""')) {
      if (!('image' in def.schema.shape)) continue
      json = JSON.stringify({ ...def.samples.typ, image: { src: '' } }) // optionales Foto (cover, section, closing)
    }
    const content = JSON.parse(json.replaceAll('"src":""', `"src":"${sample(def.id === 'quote' ? 'portrait' : 'landscape')}"`))
    for (const variant of def.variants ?? [undefined])
      slides.push({ id: `${def.id}${variant ? `.${variant}` : ''}.foto`, layout: def.id, variant, content })
  }
  // Kompositionen: jeder erlaubte Frame mit typ- und max-Sample
  for (const def of Object.values(LAYOUTS))
    for (const frame of (def as { frames?: Slide['frame'][] }).frames ?? [])
      for (const sample of ['typ', 'max'] as const) slides.push({ id: `${def.id}.${sample}.fr-${frame}`, layout: def.id, frame, content: def.samples[sample] })
  // Folien-Töne: jedes Layout einmal (typ) als accent und invert, damit Kontrast und Dekor in allen Tönen geprüft werden
  for (const def of Object.values(LAYOUTS))
    for (const tone of ['accent', 'invert'] as const)
      if ((def as { tone?: string }).tone !== tone) slides.push({ id: `${def.id}.typ.${tone}`, layout: def.id, tone, content: def.samples.typ })

  let errors = 0
  // Katalog-Themes plus zwei eigene Themes (wie die KI sie entwirft), damit themeFromSpec in hell und dunkel geprüft ist
  const refs: { id: string; name: string; custom?: ThemeSpec }[] = [
    ...THEMES.map((t) => ({ id: t.id, name: t.id })),
    { id: 'custom', name: 'custom-hell', custom: { name: 'Koralle', bg: '#FFF8F0', accent: '#E4572E', accent2: '#2E86AB', headFont: 'Space Grotesk', bodyFont: 'Inter', radius: 18, decor: 'dots' } },
    { id: 'custom', name: 'custom-dunkel', custom: { name: 'Tiefsee', bg: '#0C1B2A', accent: '#2EC4B6', headFont: 'Fraunces', bodyFont: 'Manrope', radius: 6, decor: 'rings', texture: 'grain' } },
  ]
  for (const theme of refs) {
    const deck: Deck = { title: 'Deckwerk Stresstest', theme: { id: theme.id, custom: theme.custom }, transition: 'fade', mode: 'click', slides }
    const measured = await engine.measure(deck)
    for (let i = 0; i < slides.length; i++) {
      const issues = lintSlide(deck, i, measured[i]).filter((x) => x.severity === 'error' && x.rule !== 'image')
      const fit = measured[i].fit
      const tag = `${theme.name.padEnd(13)} ${slides[i].id.padEnd(30)} fit h${fit.head}/b${fit.body}`
      if (issues.length) {
        errors += issues.length
        console.log(`✗ ${tag}`)
        for (const x of issues) console.log(`    [${x.rule}] ${x.message}`)
      } else console.log(`✓ ${tag}`)
    }
    const pngs = await engine.renderPng(deck, slides.map((_, i) => i), 1280)
    await Promise.all(pngs.map((p, i) => writeFile(join(outDir, `${theme.name}-${slides[i].id}.png`), p)))
  }
  console.log(errors ? `\n${errors} Fehler` : '\nAlle Kombinationen sauber.')
  return errors === 0
}
