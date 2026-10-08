// Verlaufswinkel und Bildfilter: npx esbuild scripts/check-gradient.ts --bundle --platform=node --loader:.css=empty --loader:.md=text --log-level=warning --outfile=${TMPDIR:-/tmp}/check-gradient.cjs && node ${TMPDIR:-/tmp}/check-gradient.cjs
import assert from 'node:assert/strict'
import { gradFill } from '../src/main/patch-xml'
import { parseGradient } from '../src/renderer/measure'
import { IMG_PRESETS, presetOf } from '../src/renderer/ui/ItemInspector'

// CSS-Winkel (0 = nach oben) → OOXML <a:lin ang> (0 = nach rechts, 1/60000 Grad), beide im Uhrzeigersinn
const sp = '<p:sp><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:sp>'
const stops = [{ color: '#112233', alpha: 1, pos: 0 }, { color: '#AABBCC', alpha: 0.5, pos: 1 }]
for (const [css, ooxml] of [[0, 270], [45, 315], [90, 0], [135, 45], [180, 90], [270, 180], [360, 270], [-45, 225]]) {
  const xml = gradFill({ angle: css, stops })(sp)
  assert.equal(xml.match(/<a:lin ang="(\d+)"/)?.[1], String(ooxml * 60000), `CSS ${css}° → OOXML ${ooxml}°`)
  assert.ok(!xml.includes('<a:solidFill>'), 'Verlauf ersetzt die Füllung')
}

// So liefert Chromium den berechneten Stil: 180° (Standard) ohne Winkel, sonst mit
assert.equal(parseGradient('linear-gradient(90deg, rgb(17, 34, 51), rgba(170, 187, 204, 0.5))')?.angle, 90)
assert.equal(parseGradient('linear-gradient(45deg, rgb(17, 34, 51), rgb(170, 187, 204))')?.angle, 45)
assert.equal(parseGradient('linear-gradient(rgb(17, 34, 51), rgb(170, 187, 204))')?.angle, 180)
assert.deepEqual(parseGradient('linear-gradient(135deg, rgb(17, 34, 51), rgba(170, 187, 204, 0.5))')?.stops, stops)

// Aktives Preset: nur bei exakt passenden Werten; 0 und natural zählen wie nicht gesetzt
const name = (it: Parameters<typeof presetOf>[0]) => presetOf(it)?.name
assert.equal(name({}), 'Original')
assert.equal(name({ look: 'natural', adjust: { bright: 0 } }), 'Original')
assert.equal(name({ adjust: { contrast: 15, sat: 30 } }), 'Kräftig')
assert.equal(name({ adjust: { contrast: 15, sat: 31 } }), undefined)
assert.equal(name({ look: 'mono' }), 'Schwarz\u00adweiß')
assert.equal(name({ look: 'mono', adjust: { contrast: 30 } }), 'S/W hart')
assert.equal(name({ look: 'duotone', adjust: { blur: 10 } }), undefined)
for (const p of IMG_PRESETS) assert.equal(presetOf(p), p, `${p.name} erkennt sich selbst`)
assert.equal(new Set(IMG_PRESETS.map((p) => JSON.stringify([p.look, p.adjust]))).size, IMG_PRESETS.length, 'Presets eindeutig')

console.log('check-gradient: ok')
