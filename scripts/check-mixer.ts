// Mixer-Helfer: npx esbuild scripts/check-mixer.ts --bundle --platform=node --format=esm --loader:.css=empty --outfile=${TMPDIR:-/tmp}/check-mixer.mjs && node ${TMPDIR:-/tmp}/check-mixer.mjs
import assert from 'node:assert/strict'
import { dbText } from '../src/renderer/ui/timeline/Mixer'

assert.equal(dbText(1), '0,0 dB')
assert.equal(dbText(0), '−∞')
assert.equal(dbText(2), '+6,0 dB')
assert.equal(dbText(0.999), '0,0 dB')
assert.equal(dbText(0.5), '−6,0 dB')
console.log('check-mixer ok')
