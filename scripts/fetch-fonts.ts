// Lädt die Premium-Schriften als statische TTF (Google-Fonts-CSS-API liefert Nicht-Browsern TTF-Instanzen) nach assets/fonts/.
// Dieselbe Datei misst im Renderer (@font-face in src/renderer/fonts.css) und wird in die PPTX eingebettet → identische Umbrüche.
// Aufruf: npm run fonts:fetch   (Ergebnis wird eingecheckt; nur nötig, wenn FAMILIES sich ändert)
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fontFamilyOf } from '../src/main/embed-fonts'

// family → CSS-API-Achsen. Nur 400/700 (+ Italic, wo vorhanden): weitere Schnitte bräuchten eigene EOT-Familien.
const FAMILIES: Record<string, string> = {
  Fraunces: 'ital,wght@0,400;0,700;1,400;1,700',
  Manrope: 'wght@400;700',
  'Space Grotesk': 'wght@400;700',
  Inter: 'ital,wght@0,400;0,700;1,400;1,700',
  'DM Serif Display': 'ital@0;1',
  'DM Sans': 'ital,wght@0,400;0,700;1,400;1,700',
  'Playfair Display': 'ital,wght@0,400;0,700;1,400;1,700',
  'Source Sans 3': 'ital,wght@0,400;0,700;1,400;1,700',
  'Plus Jakarta Sans': 'ital,wght@0,400;0,700;1,400;1,700',
  Lora: 'ital,wght@0,400;0,700;1,400;1,700',
  'Instrument Serif': 'ital@0;1',
  Archivo: 'ital,wght@0,400;0,700;1,400;1,700',
}
const DIR = 'assets/fonts'
const face = (weight: string, style: string) => (weight === '700' ? 'Bold' : 'Regular').replace(/^Regular$/, style === 'italic' ? 'Italic' : 'Regular') + (weight === '700' && style === 'italic' ? 'Italic' : '')

mkdirSync(DIR, { recursive: true })
for (const [family, axes] of Object.entries(FAMILIES)) {
  const stem = family.replace(/ /g, '')
  const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${axes}`, { headers: { 'User-Agent': 'deckwerk' } })).text()
  const faces = [...css.matchAll(/font-style: (\w+);\s*font-weight: (\d+);[\s\S]*?src: url\((\S+?\.ttf)\)/g)]
  assert.ok(faces.length, `${family}: keine TTF in der CSS-Antwort`)
  for (const [, style, weight, url] of faces) {
    const ttf = Buffer.from(await (await fetch(url)).arrayBuffer())
    assert.equal(fontFamilyOf(ttf), family, `${family}: Familienname im TTF weicht ab`)
    const file = join(DIR, `${stem}-${face(weight, style)}.ttf`)
    writeFileSync(file, ttf)
    console.log(`${file}  ${Math.round(ttf.length / 1024)} kB`)
  }
  const slug = family.toLowerCase().replace(/ /g, '')
  const ofl = await fetch(`https://raw.githubusercontent.com/google/fonts/main/ofl/${slug}/OFL.txt`)
  assert.ok(ofl.ok, `${family}: OFL.txt nicht gefunden`)
  writeFileSync(join(DIR, `OFL-${stem}.txt`), await ofl.text())
}
