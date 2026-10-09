import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { assetUrl } from './tools'
import { FORMATS, type Deck, type FormatId, type Slide, type ThemeSpec, type ThemeTune } from '../shared/deck'
import { LAYOUTS, type LayoutDef } from '../shared/layouts'
import { lintSlide } from '../shared/lint'
import { THEMES } from '../shared/themes'
import type { Engine } from './agent'

// Stress test: every layout × variant × sample (min/typ/max) × theme must render without lint errors.
// Writes one PNG per combination to exports/check/ for visual review. Returns false on any error.
export async function checkLayouts(engine: Engine, outDir = 'exports/check'): Promise<boolean> {
  await mkdir(outDir, { recursive: true })
  // Gruppen je Format: Layouts mit `sizes` laufen nur in diesen Formaten, alle anderen in 16:9 und zusätzlich in DW_FORMATS (z. B. DW_FORMATS=4:5,a4)
  const all = (Object.values(LAYOUTS) as LayoutDef[]).filter((d) => !process.env.DW_LAYOUTS || process.env.DW_LAYOUTS.split(',').includes(d.id)) // z. B. DW_LAYOUTS=doc-text,offer
  const common = all.filter((d) => !d.sizes)
  const groups = new Map<FormatId | undefined, LayoutDef[]>([[undefined, common]])
  for (const f of (process.env.DW_FORMATS?.split(',') ?? []) as FormatId[]) groups.set(f, [...(groups.get(f) ?? []), ...common])
  for (const d of all) for (const f of d.sizes ?? []) groups.set(f, [...(groups.get(f) ?? []).filter((x) => x !== d), d])
  let ok = true
  for (const [format, defs] of groups) if (defs.length) ok = (await checkGroup(engine, outDir, defs, format)) && ok
  console.log(ok ? '\nAlle Kombinationen sauber.' : '\nFehler (siehe oben).')
  return ok
}

async function checkGroup(engine: Engine, outDir: string, defs: LayoutDef[], format?: FormatId): Promise<boolean> {
  const slides: Slide[] = []
  for (const def of defs)
    for (const variant of def.variants ?? [undefined])
      for (const sample of ['min', 'typ', 'max'] as const)
        slides.push({ id: `${def.id}${variant ? `.${variant}` : ''}.${sample}`, layout: def.id, variant, content: def.samples[sample] })
  // Foto-Layouts: typ-Sample zusätzlich mit echten Fotos (Porträt für Zitate), damit Zuschnitt, Overlay und Kontrast geprüft werden
  const sample = (name: string) => assetUrl(join(app.getAppPath(), 'assets/samples', `${name}.jpg`))
  for (const def of defs) {
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
  for (const def of defs)
    for (const frame of (def as { frames?: Slide['frame'][] }).frames ?? [])
      for (const sample of ['typ', 'max'] as const) slides.push({ id: `${def.id}.${sample}.fr-${frame}`, layout: def.id, frame, content: def.samples[sample] })
  // Folien-Töne: jedes Layout einmal (typ) als accent und invert, damit Kontrast und Dekor in allen Tönen geprüft werden
  for (const def of defs)
    for (const tone of ['accent', 'invert'] as const)
      if ((def as { tone?: string }).tone !== tone) slides.push({ id: `${def.id}.typ.${tone}`, layout: def.id, tone, content: def.samples.typ })

  let errors = 0
  // Katalog-Themes plus eigene Themes (wie die KI sie entwirft), damit themeFromSpec in hell und dunkel geprüft ist
  const refs: { id: string; name: string; custom?: ThemeSpec; tune?: ThemeTune }[] = [
    ...THEMES.map((t) => ({ id: t.id, name: t.id })),
    { id: 'custom', name: 'custom-hell', custom: { name: 'Sudhaus', bg: '#FFF8F0', accent: '#9A4A1C', headFont: 'Fraunces', bodyFont: 'DM Sans', radius: 0, decor: 'none', titleSize: 'large', titleWeight: 'regular', rule: 'over', sectionTone: 'invert', elements: 'line' } },
    { id: 'custom', name: 'custom-dunkel', custom: { name: 'Tiefsee', bg: '#0C1B2A', accent: '#2EC4B6', headFont: 'Archivo', bodyFont: 'Manrope', radius: 6, decor: 'rings', texture: 'grain', titleSize: 'large', rule: 'under', elements: 'plain' } },
    // Getöntes Papier und tiefer Dunkelton: calmBg lässt sie durch, Flächen und Kontraste müssen trotzdem halten
    { id: 'custom', name: 'custom-getönt', custom: { name: 'Salbei', bg: '#ECF0E8', accent: '#2F5D3A', headFont: 'Inter', bodyFont: 'Inter', radius: 2, decor: 'none', titleSize: 'normal', rule: 'under', sectionTone: 'accent', elements: 'plain' } },
    { id: 'custom', name: 'custom-tief', custom: { name: 'Nachtblau', bg: '#14213A', accent: '#E0A458', headFont: 'Lora', bodyFont: 'Inter', radius: 0, decor: 'none', titleSize: 'large', titleWeight: 'bold', sectionTone: 'invert', elements: 'line' } },
    // Stil mutig: kräftiger Grund mittlerer Helligkeit (vividBg muss ihn lesbar machen) und zweiter Akzent
    { id: 'custom', name: 'custom-mutig', custom: { name: 'Koralle', bg: '#E4572E', accent: '#111111', accent2: '#FFD100', headFont: 'DM Serif Display', bodyFont: 'DM Sans', radius: 0, decor: 'none', titleSize: 'large', sectionTone: 'invert', vivid: true, elements: 'solid' } },
    // Gestaltungs-Tokens an ihren Grenzen: wenig Satzfläche (Ränder, Satzbreite, Zeilenabstand) bzw. Bundsteg, Rahmen und Flächenfarbe
    { id: 'custom', name: 'custom-fundament', custom: { name: 'Fundament', bg: '#F7F6F2', accent: '#B3372E', headFont: 'IBM Plex Serif', bodyFont: 'IBM Plex Sans', radius: 0, decor: 'none', elements: 'line', margin: 'generous', measure: 'narrow', leading: 'open', titleSize: 'large', signature: { kind: 'edge', side: 'left' }, heroTone: 'invert', labels: 'caps' } },
    { id: 'custom', name: 'custom-fundament2', custom: { name: 'Fundament 2', bg: '#FAFAF7', text: '#1B1A18', accent: '#1F3A8A', field: '#F2C200', headFont: 'Inter', bodyFont: 'Inter', radius: 2, decor: 'none', elements: 'solid', margin: 'asymmetric', measure: 'wide', leading: 'tight', signature: { kind: 'passepartout' }, chart: 'tonal', images: 'mono' } },
    // Feinschliff über einem Katalog-Theme mit Kopflinie (rule over): Kante darf die Linie nicht verändern
    { id: 'magazin', name: 'magazin-tune', tune: { signature: { kind: 'edge', side: 'left' }, heroTone: 'field', field: '#F2E6D0', labels: 'sentence' } },
  ]
  for (const theme of refs) {
    if (process.env.DW_THEMES && !process.env.DW_THEMES.split(',').includes(theme.name)) continue // z. B. DW_THEMES=keynote,custom-hell
    const deck: Deck = { title: 'Deckwerk Stresstest', theme: { id: theme.id, custom: theme.custom, tune: theme.tune }, transition: 'fade', mode: 'click', slides, ...(format && { size: { w: FORMATS[format].w, h: FORMATS[format].h } }) }
    const measured = await engine.measure(deck)
    for (let i = 0; i < slides.length; i++) {
      const issues = lintSlide(deck, i, measured[i]).filter((x) => x.severity === 'error' && x.rule !== 'image')
      const fit = measured[i].fit
      const tag = `${theme.name.padEnd(13)} ${(format ? `${format} ` : '') + slides[i].id.padEnd(30)} fit h${fit.head}/b${fit.body}`
      if (issues.length) {
        errors += issues.length
        console.log(`✗ ${tag}`)
        for (const x of issues) console.log(`    [${x.rule}] ${x.message}`)
      } else console.log(`✓ ${tag}`)
    }
    const pngs = await engine.renderPng(deck, slides.map((_, i) => i), format ? FORMATS[format].w : 1280)
    await Promise.all(pngs.map((p, i) => writeFile(join(outDir, `${theme.name}${format ? `-${format.replace(':', 'x')}` : ''}-${slides[i].id}.png`), p)))
  }
  return errors === 0
}
