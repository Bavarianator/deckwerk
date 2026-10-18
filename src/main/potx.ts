// Deckwerk Pro: Firmenvorlage (.potx/.pptx/.thmx) → Brand-Kit. Liest nur das Office-Theme (Akzentfarben, Schriftpaar). Electron-frei.
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'
import type { BrandKit } from '../shared/deck'
import { fontName } from '../shared/items'

const MAX_THEME = 5 << 20
const attr = (xml: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1]
// Inhalt des ersten Elements <a:tag …>…</a:tag>
const block = (xml: string, tag: string) => new RegExp(`<a:${tag}\\b[^>]*>([\\s\\S]*?)</a:${tag}>`).exec(xml)?.[1]

function color(theme: string, slot: string): string | undefined {
  const b = block(theme, slot)
  if (!b) return undefined
  const v = /<a:srgbClr\b[^>]*>/.exec(b)?.[0]
  const hex = (v && attr(v, 'val')) ?? ((s) => s && attr(s, 'lastClr'))(/<a:sysClr\b[^>]*>/.exec(b)?.[0])
  return hex && /^[0-9a-f]{6}$/i.test(hex) ? `#${hex.toUpperCase()}` : undefined
}

function latin(theme: string, group: 'majorFont' | 'minorFont'): string | undefined {
  const t = /<a:latin\b[^>]*>/.exec(block(theme, group) ?? '')?.[0]
  const face = t && attr(t, 'typeface')
  return face && !face.startsWith('+') ? face : undefined // „+mj-lt“ ist nur ein Verweis
}

export async function brandFromPotx(file: string): Promise<{ kit: BrandKit; skipped: string[] }> {
  const name = file.split(/[\\/]/).pop()
  const zip = await JSZip.loadAsync(await readFile(file)).catch(() => {
    throw new Error(`„${name}“ ist keine gültige PowerPoint-Vorlage (.potx, .pptx oder .thmx).`)
  })
  // Das vom Folienmaster referenzierte Theme bevorzugen, sonst die erste theme*.xml
  const themes = Object.keys(zip.files).filter((p) => /(^|\/)theme\d*\.xml$/.test(p) && !zip.files[p]!.dir).sort()
  const rels = await zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels')?.async('string')
  const ref = rels && /Target="([^"]*theme\d*\.xml)"/.exec(rels)?.[1]
  const path = (ref && themes.find((p) => p.endsWith(ref.replace(/^(\.\.\/)+/, '')))) || themes[0]
  if (!path) throw new Error(`„${name}“ enthält kein Farb- und Schriftschema (keine Theme-Datei).`)
  const f = zip.file(path)!
  const theme = (await f.async('string')).slice(0, MAX_THEME)

  const primary = color(theme, 'accent1')
  if (!primary) throw new Error(`Im Theme von „${name}“ fehlt die erste Akzentfarbe (accent1).`)
  const kit: BrandKit = { primary }
  const secondary = color(theme, 'accent2')
  if (secondary) kit.secondary = secondary

  const skipped: string[] = []
  for (const [key, group] of [['headFont', 'majorFont'], ['bodyFont', 'minorFont']] as const) {
    const face = latin(theme, group)
    if (!face) continue
    if (fontName.safeParse(face).success) kit[key] = face
    else skipped.push(face)
  }
  return { kit, skipped: [...new Set(skipped)] }
}
