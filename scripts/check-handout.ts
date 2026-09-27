// Handout-Export: npx esbuild scripts/check-handout.ts --bundle --platform=node --outfile=out/check-handout.cjs && node out/check-handout.cjs
import { readFileSync } from 'node:fs'
import { handout } from '../src/shared/handout'

const md = handout(JSON.parse(readFileSync('examples/pitch.json', 'utf8')))
for (const want of ['# Ortho-Bot', '## 1. Ortho-Bot bringt', '## 4. Jedes vierte Kind', '> Begrüßung']) if (!md.includes(want)) throw new Error(`fehlt: ${want}`)
if (/asset:|https?:\/\//.test(md)) throw new Error('Bildpfade im Handout')
console.log('handout ok')
