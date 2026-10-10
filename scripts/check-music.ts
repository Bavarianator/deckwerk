// Musiksuche (Openverse): npx esbuild scripts/check-music.ts --bundle --platform=node --format=esm --outfile=$TMPDIR/check-music.mjs && node $TMPDIR/check-music.mjs   (Netz-Teil mit DW_NET=1)
import { deepStrictEqual as eq, ok } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEDIA_EXT } from '../src/shared/deck'
import { fetchMusic, findMusic, usable, type Hit } from '../src/main/music'

// Offline: Lizenz-, Format- und Längenfilter
const base: Hit = { id: 'a'.repeat(36), url: 'https://x.example/t.mp3', filetype: 'mp3', duration: 120_000, license: 'by' }
eq(usable(base), true)
for (const l of ['cc0', 'pdm']) eq(usable({ ...base, license: l }), true)
for (const l of ['by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'sampling+', '']) eq(usable({ ...base, license: l }), false, l)
eq(usable({ ...base, duration: 10_000 }), false, 'Jingle')
eq(usable({ ...base, duration: null }), true, 'Dauer unbekannt')
eq(usable({ ...base, filetype: 'mp32', url: 'https://x.example/?trackid=1&format=mp32' }), true, 'Jamendo-mp32')
eq(usable({ ...base, filetype: undefined, url: 'https://x.example/a.exe' }), false, 'Endung')
for (const f of ['../x.mp3', 'x/../../evil.mp3', 'png', 'mp4', 'svg']) eq(usable({ ...base, filetype: f }), false, f)
eq(usable({ ...base, filetype: undefined, url: 'kaputt' }), false, 'kaputte URL wirft nicht')
eq(usable({ ...base, license: 'toString' }), false, 'Prototyp-Schlüssel')
eq(usable({ ...base, url: 'http://x.example/t.mp3' }), false, 'nur https')
console.log('offline ok')

if (process.env.DW_NET === '1') {
  const found = await findMusic('calm piano')
  ok(found.length >= 1, 'keine Treffer')
  for (const t of found) { ok(['cc0', 'pdm', 'by'].includes(t.license), t.license); ok(t.duration === 0 || t.duration >= 30) }
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'music-'))
  const a = await fetchMusic(found[0].id, dir)
  ok(MEDIA_EXT.test(a.file) && statSync(a.file).size > 10_000 && a.credit.length > 10, a.credit)
  ok(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', a.file]).toString().includes('audio'), 'ffprobe')
  const m1 = statSync(a.file).mtimeMs
  const b = await fetchMusic(found[0].id, dir)
  eq([b.file, statSync(b.file).mtimeMs], [a.file, m1], 'zweiter Aufruf lädt neu')
  console.log('netz ok:', a.file, '\n', a.credit)
}
