// Repariert TTFs, deren name-Tabelle UTF-16 in falscher Byte-Reihenfolge enthält. Ursache war nameOf in
// src/main/embed-fonts.ts, das per swap16 den Puffer der Schrift selbst umdrehte; fetch-fonts.ts schrieb danach
// genau diesen Puffer nach assets/fonts. Aufruf: npm run fonts:repair [-- datei.ttf …]  (ohne Argument: assets/fonts/*.ttf)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inspectTtf } from '../src/main/embed-fonts'

// Windows-Namen (3/1, 3/10) sind UTF-16BE; Latin-Text hat dann das Nullbyte vorn. Umgedreht steht es hinten.
export function repairNames(ttf: Buffer): number {
  const n = ttf.readUInt16BE(4)
  let off = -1
  for (let i = 0; i < n; i++) if (ttf.toString('latin1', 12 + i * 16, 16 + i * 16) === 'name') off = ttf.readUInt32BE(20 + i * 16)
  if (off < 0) return 0
  const count = ttf.readUInt16BE(off + 2), base = off + ttf.readUInt16BE(off + 4), done = new Set<number>()
  let fixed = 0
  for (let i = 0; i < count; i++) {
    const r = off + 6 + i * 12, len = ttf.readUInt16BE(r + 8), at = base + ttf.readUInt16BE(r + 10)
    if (ttf.readUInt16BE(r) !== 3 || done.has(at) || len < 2 || len % 2) continue
    const s = ttf.subarray(at, at + len)
    let le = 0, be = 0
    for (let k = 0; k < len; k += 2) { if (s[k] === 0 && s[k + 1] !== 0) be++; if (s[k] !== 0 && s[k + 1] === 0) le++ }
    if (le > be) { s.swap16(); done.add(at); fixed++ } // bewusst in place: genau diese Bytes sind falsch
  }
  return fixed
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync('assets/fonts').filter((f) => f.endsWith('.ttf')).map((f) => join('assets/fonts', f))
  for (const file of files) {
    const ttf = readFileSync(file), fixed = repairNames(ttf)
    if (fixed) writeFileSync(file, ttf)
    console.log(`${fixed ? 'repariert' : 'ok       '}  ${file}  → ${inspectTtf(ttf).family} / ${inspectTtf(ttf).style}`)
  }
}
