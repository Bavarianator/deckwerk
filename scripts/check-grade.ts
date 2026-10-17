// Pro-Timeline Farbkorrektur: npx esbuild scripts/check-grade.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-grade.mjs && node ${TMPDIR:-/tmp}/check-grade.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyTables, cube1d, GRADE_PRESETS, gradeTables, isNeutral, satFilter, satMatrix, svgTables } from '../src/shared/grade'
import type { Grade, RGB } from '../src/shared/timeline'

const id = gradeTables()
for (const t of id) t.forEach((v, i) => assert.equal(v, i))
assert.ok(isNeutral() && isNeutral({}) && isNeutral(GRADE_PRESETS.neutral) && !isNeutral({ sat: 0.5 }) && !isNeutral({ temp: 0.2 }))
const px = new Uint8ClampedArray(Array.from({ length: 64 }, (_, i) => (i * 37) % 256))
const px0 = px.slice()
applyTables(px, id, 1)
assert.deepEqual(px, px0)

const g2 = gradeTables({ gain: [2, 2, 2] })
for (let i = 128; i < 256; i++) assert.equal(g2[0][i], 255)
assert.ok(g2[0][127] < 255)

let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const r3 = (lo: number, hi: number): RGB => [0, 1, 2].map(() => lo + rnd() * (hi - lo)) as RGB
for (let n = 0; n < 200; n++) {
  const g: Grade = { lift: r3(-0.5, 0.5), gamma: r3(0.5, 2), gain: r3(0.5, 2), temp: rnd() * 2 - 1, sat: rnd() * 2 }
  for (const t of gradeTables(g)) for (let i = 1; i < 256; i++) assert.ok(t[i] >= t[i - 1], `monoton ${JSON.stringify(g)}`)
}

assert.ok(gradeTables({ lift: [0.1, 0.1, 0.1] })[0][0] > 0)
assert.ok(gradeTables({ gamma: [1.5, 1.5, 1.5] })[1][128] > 128)
const sw = new Uint8ClampedArray([200, 50, 120, 255, 10, 240, 30, 255])
applyTables(sw, id, 0)
for (let i = 0; i < sw.length; i += 4) assert.ok(sw[i] === sw[i + 1] && sw[i + 1] === sw[i + 2])
assert.deepEqual(satMatrix(1), [1, 0, 0, 0, 1, 0, 0, 0, 1])
assert.equal(satFilter(1), null)
assert.match(satFilter(0.5)!, /^colorchannelmixer=rr=[\d.]+:rg=[\d.]+:rb=[\d.]+:gr=.*:bb=[\d.]+$/)
const cube = cube1d({ temp: 0.3 }).trimEnd().split('\n')
assert.equal(cube[0], 'LUT_1D_SIZE 256')
assert.equal(cube.length, 257)
assert.match(cube[1], /^\d\.\d{6} \d\.\d{6} \d\.\d{6}$/)
assert.equal(svgTables().r.split(' ').length, 256)
const warm = gradeTables({ temp: 0.8 })
for (let i = 0; i < 256; i++) assert.ok(warm[0][i] >= warm[2][i])
for (const g of Object.values(GRADE_PRESETS)) gradeTables(g)

// Abgleich mit ffmpeg: lut1d + colorchannelmixer gegen applyTables auf demselben Eingangsbild
const bin = ['ffmpeg', join(homedir(), 'Deckwerk', 'models', 'ffmpeg-6.1.1')].find((b) => b === 'ffmpeg' ? spawnSync(b, ['-version']).status === 0 : existsSync(b))
if (!bin) console.log('check-grade: ffmpeg nicht gefunden, Abgleich übersprungen')
else {
  const dir = mkdtempSync(join(tmpdir(), 'check-grade-'))
  try {
    const frame = (vf: string) => {
      const r = spawnSync(bin, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x808040:s=16x16:d=0.04', '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 })
      assert.equal(r.status, 0, r.stderr.toString())
      return r.stdout
    }
    const src = frame('format=rgb24')
    for (const g of [{ lift: [0.05, 0, -0.05], gamma: [1.2, 1, 0.8], gain: [1.1, 1, 0.9], temp: 0.3, sat: 0.7 } as Grade, GRADE_PRESETS.matt, GRADE_PRESETS.sw]) {
      const file = join(dir, 'g.cube')
      writeFileSync(file, cube1d(g))
      const out = frame(['format=rgb24', `lut1d=file=${file}`, satFilter(g.sat)].filter(Boolean).join(','))
      const want = new Uint8ClampedArray([src[0], src[1], src[2], 255])
      applyTables(want, gradeTables(g), g.sat)
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(out[c] - want[c]) <= 3, `ffmpeg ${JSON.stringify(g)} Kanal ${c}: ${out[c]} statt ${want[c]}`)
    }
    console.log(`check-grade: ffmpeg-Abgleich ok (${bin})`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
console.log('check-grade: ok')
