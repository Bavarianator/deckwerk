// Material für Demos (Zoom-Vorschläge unter Node, Website-Aufnahme unter Electron): npx esbuild scripts/check-demo-material.ts --bundle --platform=node --format=cjs --external:electron --outfile=out/check-demo-material.cjs && node out/check-demo-material.cjs && node_modules/.bin/electron --ozone-platform=x11 out/check-demo-material.cjs
// Ohne ffmpeg im PATH lädt ffmpeg.ts ffmpeg-static (~30 MB). Arbeitsordner unter ~/.cache, nie /tmp (tmpfs).
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = join(homedir(), '.cache', 'deckwerk-e2e', 'anim-t10')

// a) Zoom-Vorschläge aus synthetischen Aufnahmen: grauer Grund, darauf bewegte Kästen (overlay, weil drawbox keine Zeit kennt)
async function activity() {
  const { runFfmpeg } = await import('../src/main/ffmpeg')
  const { screenZooms } = await import('../src/main/screen-activity')
  await mkdir(dir, { recursive: true })
  const video = async (name: string, ...boxes: { w: number; h: number; x: string; y: string; on: string }[]) => {
    const file = join(dir, `${name}.mp4`)
    const args = ['-f', 'lavfi', '-i', 'color=c=0x808080:s=1280x720:r=25:d=8']
    const chain = boxes.map((b, i) => {
      args.push('-f', 'lavfi', '-i', `color=c=white:s=${b.w}x${b.h}:r=25:d=8`)
      return `[${i ? `v${i}` : '0'}][${i + 1}]overlay=x='${b.x}':y='${b.y}':enable='${b.on}'[v${i + 1}]`
    })
    if (chain.length) args.push('-filter_complex', chain.join(';'), '-map', `[v${chain.length}]`)
    await runFfmpeg([...args, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file])
    return file
  }

  // Kasten oben rechts, 2–4 s, wandert etwas nach rechts unten
  const z = await screenZooms(await video('kasten', { w: 160, h: 100, x: '1000+40*(t-2)', y: '80+20*(t-2)', on: 'between(t,2,4)' }))
  console.log('Kasten:', JSON.stringify(z))
  assert.equal(z.length, 1, 'genau ein Zoom am Kasten')
  assert.ok(Math.abs(z[0].start - 2) <= 0.5 && z[0].x > 0.6 && z[0].y < 0.4, `Zoom am Kasten: ${JSON.stringify(z[0])}`)
  assert.ok(z[0].end > 4.5 && z[0].scale! >= 1.2 && z[0].scale! <= 2.5)

  assert.deepEqual(await screenZooms(await video('still')), [], 'stilles Video: kein Zoom')
  // Vollbildwechsel (2 Blitze, ein Ereignis von 1,75 s): fällt über die Fläche weg, nicht über die Dauer
  assert.deepEqual(await screenZooms(await video('vollbild', { w: 1280, h: 720, x: '0', y: '0', on: 'between(t,3,3.5)+between(t,4,4.5)' })), [], 'Vollbildwechsel: kein Zoom')
  // Mauszeiger-großer Kasten, der 5 s über den Bildschirm wandert
  assert.deepEqual(await screenZooms(await video('zeiger', { w: 12, h: 18, x: '100+200*t', y: '100+60*t', on: 'between(t,1,6)' })), [], 'Mauszeiger: kein Zoom')
  // zwei Kästen mehr als 3 s auseinander: zwei Zooms; nur 2,5 s auseinander in entgegengesetzten Ecken: der gemeinsame Rahmen wäre zu groß, der spätere fällt weg
  const oben = { w: 160, h: 100, x: '1000', y: '80', on: 'between(t,1,2)' }, unten = (on: string) => ({ w: 160, h: 100, x: '40', y: '560', on })
  const zwei = await screenZooms(await video('zwei', oben, unten('between(t,5,6)')))
  assert.equal(zwei.length, 2, JSON.stringify(zwei))
  assert.ok(zwei[0].x > 0.6 && zwei[0].y < 0.4 && zwei[1].x < 0.4 && zwei[1].y > 0.6 && Math.abs(zwei[1].start - 5) <= 0.5, JSON.stringify(zwei))
  const nah = await screenZooms(await video('nah', oben, unten('between(t,3.5,4.5)')))
  assert.ok(nah.length === 1 && nah[0].x > 0.6 && nah[0].y < 0.4, `kein Mitte-Zoom: ${JSON.stringify(nah)}`)
  console.log('a) Zoom-Vorschläge: ok')
}

// b) Website-Aufnahme im abgeschotteten Offscreen-Fenster
async function capture() {
  const { app, nativeImage } = await import('electron')
  app.setPath('userData', join(dir, 'electron'))
  app.on('window-all-closed', () => {}) // sonst beendet sich Electron, sobald capturePage sein Fenster schließt
  await app.whenReady()
  const { capturePage } = await import('../src/main/capture')
  const hits: string[] = []
  const page = `<!doctype html><body style="margin:0"><div style="height:1500px;background:#f00"></div><div style="height:1500px;background:#00f"></div>
    <script>const w = window.open('/popup'); fetch(w ? '/geoeffnet' : '/verweigert')
      fetch('/breite/' + innerWidth + (/Mobile/.test(navigator.userAgent) ? '/mobil' : ''))</script></body>`
  const server = createServer((req, res) => {
    hits.push(req.url!)
    if (req.url === '/haengt') return // Fremdressource, die nie fertig wird
    res.setHeader('content-type', 'text/html')
    res.end(req.url === '/' ? page : req.url === '/langsam' ? '<body style="background:#0f0"><img src="/haengt">' : '')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  let windows = 0
  app.on('web-contents-created', () => windows++)
  const outDir = join(dir, 'seiten')
  await rm(outDir, { recursive: true, force: true })

  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@host/']) await assert.rejects(capturePage(bad, { outDir }), /http|Zugangsdaten/, bad)
  assert.equal(windows, 0, 'abgewiesene Adressen öffnen kein Fenster')

  const files = await capturePage(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { scroll: [0, 1], outDir })
  assert.equal(files.length, 2)
  // Mitte des Bilds; toBitmap liefert BGRA (Skia N32 auf Little-Endian)
  const color = (f: string) => {
    const img = nativeImage.createFromPath(f)
    assert.deepEqual(img.getSize(), { width: 2880, height: 1800 }, f)
    const [b, g, r] = img.crop({ x: 1440, y: 900, width: 1, height: 1 }).toBitmap()
    return r > 200 && g < 50 && b < 50 ? 'rot' : b > 200 && g < 50 && r < 50 ? 'blau' : `${r},${g},${b}`
  }
  assert.deepEqual(files.map(color), ['rot', 'blau'], 'oben rot, unten blau')
  assert.ok(files.every((f) => /seite-127\.0\.0\.1-\d\.png$/.test(f)), files.join())
  assert.equal(windows, 1, 'das Popup der Seite öffnet kein Fenster')
  assert.ok(hits.includes('/verweigert') && !hits.includes('/popup'), `window.open verweigert: ${hits}`)
  const [handy] = await capturePage(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, { device: 'handy', outDir })
  assert.equal(handy, join(outDir, 'seite-127.0.0.1-3.png'), 'eindeutige Namen')
  assert.deepEqual(nativeImage.createFromPath(handy).getSize(), { width: 1170, height: 2532 }, 'handy 390×844 bei Faktor 3')
  assert.deepEqual(hits.filter((h) => h.startsWith('/breite/')), ['/breite/1440', '/breite/390/mobil'], 'Seitenbreite in CSS-Pixeln und Mobil-Kennung')
  // Dokument steht, ein Bild hängt: nach der Frist den Stand aufnehmen statt abzubrechen
  const [langsam] = await capturePage(`http://127.0.0.1:${(server.address() as AddressInfo).port}/langsam`, { outDir, timeoutMs: 2000 })
  const [b, g, r] = nativeImage.createFromPath(langsam).crop({ x: 1440, y: 900, width: 1, height: 1 }).toBitmap()
  assert.ok(g > 200 && r < 50 && b < 50, `hängende Ressource: ${r},${g},${b}`)
  server.closeAllConnections()
  server.close()
  console.log('b) Website-Aufnahme: ok')
}

if (process.versions.electron) capture().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
else activity().catch((e) => { console.error(e); process.exit(1) })
