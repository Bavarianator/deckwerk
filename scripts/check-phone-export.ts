// npx esbuild scripts/check-phone-export.ts --bundle --packages=external --platform=node --format=esm --outfile=out/check-phone-export.mjs && node out/check-phone-export.mjs [quellvideo]
// Video-Export auf dem Handy Ende zu Ende mit der echten Engine (electron . --mcp, Option „Android-Handy als Rechenhilfe“): braucht gebautes out/ und ein
// per adb freigegebenes Handy. Ohne Quelle ein Testvideo (60 s); mit einer großen Quelle (Stream) auch das Kopieren. Die Quelle kommt per Hardlink unter einen
// neuen Pfad (neuer Cache-Schlüssel: wirklich übertragen, kein Platz auf dem PC), deshalb TMPDIR auf dasselbe Dateisystem legen. Die Warnungen der Engine
// laufen mit (stderr), so steht ein Ausstieg des Handys samt Grund im Log.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { PAD } from '../src/shared/video'

const adb = (...a: string[]) => execFileSync('adb', a, { encoding: 'utf8' })
const serial = /^(\S+)\s+device\b/m.exec(adb('devices'))?.[1]
assert.ok(serial, 'Kein Handy per adb verbunden (USB-Debugging freigeben)')
// das Handy nicht mit einer laufenden Spracherkennung teilen (der Nutzer transkribiert evtl. parallel)
for (let n = 0; adb('-s', serial, 'shell', 'ps -A -o ARGS').includes('sherpa-onnx-offline'); n++) {
  assert.ok(n < 45, 'Handy rechnet seit 15 min eine Spracherkennung')
  await new Promise((r) => setTimeout(r, 20_000))
}

const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'deckwerk-phone-e2e-')), cfg = join(home, 'cfg')
mkdirSync(join(cfg, 'deckwerk'), { recursive: true })
// Handy rechnet ohne Marker (phoneMarker = aus) automatisch, sobald es verbunden ist
const ff = join(homedir(), 'Deckwerk', 'models', 'android', 'ffmpeg') // vorhandenes Handy-ffmpeg statt 123 MB Download (E2E_DOWNLOAD=1: den Download mitprüfen)
if (!process.env.E2E_DOWNLOAD && existsSync(ff)) { mkdirSync(join(home, 'models', 'android'), { recursive: true }); symlinkSync(ff, join(home, 'models', 'android', 'ffmpeg')) }

const video = join(home, 'quelle.mp4'), given = process.argv[2]
if (given) linkSync(given, video) // EXDEV: TMPDIR liegt auf einem anderen Dateisystem als die Quelle
else execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video])
const st = statSync(video), key = `/data/local/tmp/deckwerk/src/${createHash('sha1').update(`${video}|${st.size}|${st.mtimeMs}`).digest('hex')}.mp4` // wie phone-ffmpeg.ts
const dur = Number(/Duration: (\d+):(\d+):([\d.]+)/.exec(spawnSync('ffmpeg', ['-i', video]).stderr.toString())!.slice(1).reduce((s, x) => s * 60 + +x, 0))
const parts = [0.2, 0.5, 0.8].map((f) => ({ start: Math.round(dur * f), end: Math.round(dur * f) + 8 })) // drei echte Schnitte, weit auseinander

const env = { ...process.env, DECKWERK_HOME: home, XDG_CONFIG_HOME: cfg, DECKWERK_OFFLINE: '1' } as Record<string, string>
const transport = new StdioClientTransport({ command: join(process.cwd(), 'node_modules/.bin/electron'), args: ['.', '--ozone-platform=x11', '--mcp'], env, stderr: 'inherit' })
const client = new Client({ name: 'phone-e2e', version: '0' })
await client.connect(transport)
type Res = { content: { type: string; text?: string }[]; isError?: boolean }
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as Res
  assert.ok(!r.isError, `${name}: ${r.content[0]?.text}`)
  return r.content[0].text!
}
const t0 = Date.now(), lap = (what: string) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(5)} s  ${what}`)

try {
  await call('create_deck', { title: 'Handy-Export', format: '16:9', transition: 'none', brand: null })
  await call('add_slides', { slides: [{ layout: 'clip', content: { video, parts, captions: 'aus' } }] })
  lap(`Deck: ${(st.size / 1e9).toFixed(2)} GB Quelle, ${parts.length} Ausschnitte`)
  let text = '', seen = ''
  for (let n = 0; ; n++) {
    text = await call('export_deck', { format: 'mp4' })
    seen += `${text}\n`
    if (!/läuft noch/.test(text)) break
    lap(text.split('\n').filter((l) => /läuft noch|rechnet/.test(l)).map((l) => l.replace(/ Rufe dasselbe.*$/, '')).join(' · '))
    assert.ok(n < 30, 'Export hängt')
  }
  lap('fertig')
  assert.doesNotMatch(seen, /gescheitert/, `Das Handy ist ausgestiegen:\n${seen}`)
  assert.match(text, /\nGerechnet: Handy/, 'Export lief nicht über das Handy (Option, adb?)')
  const mp4 = text.split('\n')[1]
  assert.ok(existsSync(mp4), `MP4 fehlt: ${mp4}`)
  const out = Number(/Duration: (\d+):(\d+):([\d.]+)/.exec(spawnSync('ffmpeg', ['-i', mp4]).stderr.toString())!.slice(1).reduce((s, x) => s * 60 + +x, 0))
  assert.ok(Math.abs(out - (24 + 6 * PAD)) < 0.5, `MP4 dauert ${out} s statt ${24 + 6 * PAD} s`)
  assert.match(adb('-s', serial, 'shell', `ls -l ${key}`), new RegExp(`\\b${st.size}\\b`), 'Quelle liegt nicht vollständig im Cache auf dem Handy')
  console.log(`check-phone-export: ok (${out.toFixed(1)} s Video, ${Math.round((Date.now() - t0) / 1000)} s gesamt)`)
} finally {
  await client.close().catch(() => {})
  spawnSync('adb', ['-s', serial, 'shell', `rm -f ${key} ${key}.part`]) // Testkopie nicht im Cache des Nutzers lassen
}
process.exit(0)
