// End-to-End: startet `electron . --mcp` (echte Engine, Offscreen-Chromium), baut per Tools ein Deck,
// lintet, rendert und exportiert eine PPTX, dazu ein Short aus einem Testvideo (braucht ffmpeg im PATH). Aufruf: npm run mcp:e2e  (baut vorher)
// E2E_HEADLESS=1: ohne DISPLAY über scripts/deckwerk.sh, so wie Vibe und Codex den Server starten.
// E2E_APP=<AppRun oder AppImage>: das Linux-Paket mit demselben sh-Aufruf wie mcpCmd in src/main/ipc.ts.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { PAD } from '../src/shared/video'

const home = mkdtempSync(join(tmpdir(), 'deckwerk-e2e-'))
const env = { ...process.env, DECKWERK_HOME: home } as Record<string, string>
if (process.env.E2E_HEADLESS) { delete env.DISPLAY; delete env.WAYLAND_DISPLAY }
const wrap = 'if [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then exec "$0" --ozone-platform=x11 --mcp; else exec "$0" --ozone-platform=headless --disable-gpu --mcp; fi'
const [command, args] = process.env.E2E_APP ? ['/bin/sh', ['-c', wrap, process.env.E2E_APP]]
  : process.env.E2E_HEADLESS ? ['sh', ['scripts/deckwerk.sh', '--mcp']]
  : [join(process.cwd(), 'node_modules/.bin/electron'), ['.', '--ozone-platform=x11', '--mcp']]
const transport = new StdioClientTransport({ command, args, env, stderr: 'inherit' })
const client = new Client({ name: 'e2e', version: '0' })
await client.connect(transport)

type Res = { content: { type: string; text?: string; data?: string }[]; isError?: boolean }
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as Res // Video-Tools warten bis 240 s
  assert.ok(!r.isError, `${name}: ${r.content[0]?.text}`)
  return r
}
const t0 = Date.now()
const lap = (what: string) => console.log(`${String(Date.now() - t0).padStart(6)} ms  ${what}`)

assert.equal((await client.listTools()).tools.length, 22)
await call('create_deck', { title: 'E2E Test', theme: 'corporate', brand: { primary: '#0A7C66' } })
let r = await call('add_slides', { slides: [
  { layout: 'cover', content: { eyebrow: 'E2E', title: 'Der MCP-Server rendert echte Folien', subtitle: 'Offscreen-Chromium im Electron-Main-Prozess' }, notes: 'Testfolie' },
  { layout: 'kpi-grid', content: { title: 'Drei Zahlen zeigen, dass alles läuft', kpis: [{ value: '15', label: 'Tools' }, { value: '3', label: 'Folien' }, { value: '1', label: 'PPTX', delta: '+1', sentiment: 'positive' }] } },
  { layout: 'closing', content: { title: 'Fertig', subtitle: 'Export prüfen' } },
] })
lap('add_slides')
assert.match(r.content[0].text!, /Folie 1 \(s[0-9a-f]{4}, cover\): OK/)
assert.match(r.content[0].text!, /Folie 2 .*: OK/)
const deck = JSON.parse((await call('get_deck')).content[0].text!)
assert.equal(deck.slides.length, 3)

r = await call('add_slides', { slides: [{ layout: 'bullets', content: { title: 'Zu lang '.repeat(20), items: [{ text: 'x' }, { text: 'y' }] } }] }).catch((e) => ({ content: [{ type: 'text', text: String(e.message) }], isError: true }))
assert.ok(r.isError && /Too big|ungültig/.test(r.content[0].text!), 'Schema-Fehler kommt zurück')

r = await call('lint_deck')
lap('lint_deck')
assert.doesNotMatch(r.content[0].text ?? '', /\[error\]/, r.content[0].text ?? '')

r = await call('render_slides', { ids: [deck.slides[1].id], width: 640 })
lap('render_slides')
const img = r.content.find((c) => c.type === 'image')!
assert.ok(img && Buffer.from(img.data!, 'base64').subarray(1, 4).toString() === 'PNG', 'PNG zurück')

r = await call('render_overview')
lap('render_overview')
assert.ok(r.content.some((c) => c.type === 'image'))

r = await call('export_deck', { format: 'pptx' })
lap('export_deck')
const file = r.content[0].text!.split('\n')[1]
assert.ok(existsSync(file) && statSync(file).size > 10_000, `PPTX fehlt: ${file}`)

r = await call('export_deck', { format: 'docx' })
lap('export_deck docx')
const docx = r.content[0].text!.split('\n')[1]
assert.ok(existsSync(docx) && statSync(docx).size > 10_000, `DOCX fehlt: ${docx}`)

r = await call('save_deck')
assert.ok(existsSync(join(home, 'e2e-test', 'deck.json')))

// Video-Schnitt: Testvideo (10 s, Ton), Deck 9:16 mit einer clip-Folie aus zwei Ausschnitten; captions aus, weil im CI kein Whisper-Modell liegt
const video = join(home, 'test.mp4')
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video])
await call('create_deck', { title: 'E2E Shorts', format: '9:16', brand: null })
await call('add_slides', { slides: [{ layout: 'clip', content: { video, hook: 'Zwei Ausschnitte, ein Short', parts: [{ start: 1, end: 3 }, { start: 5, end: 7, focus: 0.3 }], captions: 'aus' } }] })
const clip = JSON.parse((await call('get_deck')).content[0].text!).slides[0]
assert.match(clip.content.video, /^asset:\/\/local\//, 'absoluter Pfad wird zur asset://-URL')
r = await call('video_frames', { video, times: [1, 5] })
lap('video_frames')
assert.equal(r.content.filter((c) => c.type === 'image').length, 2)
r = await call('render_slides', { ids: [clip.id], width: 360 })
assert.ok(r.content.some((c) => c.type === 'image'))
for (let n = 0; ; n++) {
  r = await call('export_deck', { format: 'clips' })
  if (!/läuft noch/.test(r.content[0].text!)) break
  assert.ok(n < 5, `Export hängt: ${r.content[0].text}`)
}
lap('export_deck clips')
const mp4 = r.content[0].text!.split('\n')[1]
assert.ok(existsSync(mp4), `MP4 fehlt: ${mp4}`)
const [, hh, mm, ss] = spawnSync('ffmpeg', ['-i', mp4]).stderr.toString().match(/Duration: (\d+):(\d+):([\d.]+)/)!
const dur = +hh * 3600 + +mm * 60 + +ss
assert.ok(dur > 4 - 0.6 && dur < 4 + 4 * PAD + 0.6, `Short dauert ${dur} s statt ~4 s`)
await client.close()
console.log(`E2E OK · ${file} · ${mp4}`)
