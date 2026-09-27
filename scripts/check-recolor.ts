// Folie umfärben: npx esbuild scripts/check-recolor.ts --bundle --platform=node --outfile=out/check-recolor.cjs && node out/check-recolor.cjs
import assert from 'node:assert/strict'
import { colorsOf, recolor } from '../src/shared/items'

const items = [
  { id: 'a', kind: 'text', x: 0, y: 0, w: 1, h: 1, color: '#ff0000' },
  { id: 'b', kind: 'shape', x: 0, y: 0, w: 1, h: 1, fill: '#FF0000', stroke: '#00FF00' },
] as never[]
assert.deepEqual(colorsOf(items), ['#FF0000', '#00FF00'])
const out = recolor(items, '#FF0000', '#0000FF') as { color?: string; fill?: string; stroke?: string }[]
assert.equal(out[0].color, '#0000FF')
assert.equal(out[1].fill, '#0000FF')
assert.equal(out[1].stroke, '#00FF00')
assert.equal(recolor(items, '#123456', '#000000')[0], items[0])
console.log('recolor ok')
