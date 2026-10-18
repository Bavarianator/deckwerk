// Film-Renderer in Electron (Seek, Kamera, Zähler, Tippen, Video, Motion-Grafik, Frames/s): npx electron-vite build && npx esbuild scripts/check-frames.ts --bundle --platform=node --format=cjs --external:electron --log-level=warning --outfile=out/main/check-frames.cjs && DECKWERK_HOME=${TMPDIR:-/tmp}/check-frames ./node_modules/.bin/electron out/main/check-frames.cjs --ozone-platform=x11
// (Bündel in out/main, damit render.ts den Renderer unter ../renderer/index.html findet)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { closeHosts, renderFilm } from '../src/main/render'
import { FPS, sceneTimeline } from '../src/shared/film'
import type { Deck, Item } from '../src/shared/deck'

const W = 1920, F = W / 1280
const home = process.env.DECKWERK_HOME ?? join(process.env.TMPDIR ?? '/tmp', 'check-frames')
mkdirSync(home, { recursive: true })
const video = join(home, 'rot-blau.webm') // 1 s rot, dann 1 s blau
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30:d=1',
  '-filter_complex', '[0][1]concat=n=2:v=1', '-c:v', 'libvpx', '-b:v', '200k', video])

const text = (id: string, t: string, x: number, y: number, color: string, extra: Partial<Item>): Item => ({ id, kind: 'text', text: t, x, y, w: 400, h: 100, size: 72, bold: true, color, ...extra })
const deck: Deck = {
  title: 'Film-Test', theme: { id: 'beratung' }, transition: 'none', mode: 'click', film: {},
  slides: [
    { id: 's1', layout: 'statement', build: 'fade', content: { text: 'Ein kurzer Satz' }, camera: [{ step: 1, box: [0, 0, 0.5, 0.5] }],
      items: [
        { id: 'box', kind: 'shape', shape: 'rect', x: 80, y: 80, w: 100, h: 60, fill: '#00FF00' }, // bekannter Bereich für die Kamera
        { id: 'probe', kind: 'shape', shape: 'rect', x: 1200, y: 20, w: 40, h: 40, fill: '#FF0000' }, // Kanalreihenfolge
        text('pop', 'POP', 300, 200, '#FF00FF', { anim: 'pop', animStart: 'click' }),
        text('type', 'TIPPEN', 700, 560, '#222222', { anim: 'typewriter', animStart: 'click' }),
      ] },
    { id: 's2', layout: 'big-number', build: 'zoom-kpi', content: { value: '1.234,5 €', label: 'Umsatz im Quartal' } },
    { id: 's3', layout: 'kpi-grid', build: 'fade', content: { title: 'Zahlen', kpis: [{ value: '42 %', label: 'a' }, { value: '3,2 Mio.', label: 'b' }, { value: '+12', label: 'c' }, { value: 'Q3', label: 'd' }] } },
    { id: 's4', layout: 'statement', build: 'none', content: { text: 'Video' }, items: [{ id: 'vid', kind: 'video', src: `file://${video}`, x: 0, y: 0, w: 640, h: 360 }] },
    { id: 's5', layout: 'statement', build: 'none', content: { text: 'Defekt' }, items: [{ id: 'kaputt', kind: 'video', src: `file://${home}/fehlt.webm`, x: 0, y: 0, w: 640, h: 360 }] },
    { id: 's6', layout: 'statement', build: 'none', content: { text: 'Bewegung' },
      items: [
        { id: 'move', kind: 'shape', shape: 'rect', x: 100, y: 40, w: 100, h: 60, fill: '#00FF00', keys: [{ step: 1, x: 700 }, { step: 2, y: 120, w: 200, h: 30 }] },
        { id: 'spring', kind: 'shape', shape: 'rect', x: 100, y: 200, w: 100, h: 60, fill: '#0000FF', keys: [{ step: 1, x: 700, ease: 'feder' }] },
        { id: 'fade', kind: 'shape', shape: 'rect', x: 100, y: 560, w: 100, h: 60, fill: '#FF00FF', keys: [{ step: 1, opacity: 0, ease: 'linear' }] },
        { id: 'paint', kind: 'shape', shape: 'rect', x: 300, y: 560, w: 100, h: 60, fill: '#FFFF00', keys: [{ step: 1, fill: '#00FFFF' }] },
        { id: 'paint2', kind: 'shape', shape: 'diamond', x: 500, y: 540, w: 100, h: 100, fill: '#FFFF00', keys: [{ step: 1, fill: '#00FFFF' }] }, // SVG-fill
      ] },
    { id: 's7', layout: 'statement', build: 'none', content: { text: 'Wachsen' },
      items: [
        { id: 'bars', kind: 'chart', x: 700, y: 60, w: 500, h: 360, spec: { type: 'bar', categories: ['a', 'b', 'c'], series: [{ name: 'Umsatz', values: [2, 3, 5] }] } }, // c in Akzentfarbe
        text('mark', 'Ein **Wort**', 80, 520, '#222222', { w: 600, anim: 'fade', animStart: 'with' }),
      ] },
  ],
}

const film = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#film'))!
const js = <T>(code: string): Promise<T> => film().webContents.executeJavaScript(code)
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} statt ≈ ${b}`)
// NativeImage.toBitmap liefert je nach Plattform BGRA oder RGBA (Skia N32; Linux/x86: BGRA). Bestimmt am roten Prüfquadrat.
let order: 'BGRA' | 'RGBA' = 'BGRA'
const rgbAt = (img: Electron.NativeImage, x: number, y: number) => {
  const p = img.crop({ x: Math.round(x), y: Math.round(y), width: 1, height: 1 }).toBitmap()
  return order === 'RGBA' ? [p[0], p[1], p[2]] : [p[2], p[1], p[0]]
}
// Pixel einer Farbe zählen samt Rahmen (Gerätepixel); Toleranz wegen Kantenglättung
function find(img: Electron.NativeImage, rgb: number[]) {
  const { width, height } = img.getSize(), px = img.toBitmap()
  const [r, b] = order === 'RGBA' ? [0, 2] : [2, 0]
  let n = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    if (Math.abs(px[i + r] - rgb[0]) < 40 && Math.abs(px[i + 1] - rgb[1]) < 40 && Math.abs(px[i + b] - rgb[2]) < 40) n++, (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y))
  }
  return { n, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}
const GREEN = [0, 255, 0], MAGENTA = [255, 0, 255], BLUE = [0, 0, 255], YELLOW = [255, 255, 0], CYAN = [0, 255, 255]

async function main() {
  // 1) Aufbau, Element per Klick-Takt, Kamera, Tippen; dazu die ganze Szene mit 30 fps in 1920 px für die Frames/s
  let beats: number[] = [], dur = 0, n = 0, first = 0
  const shots = new Map<number, Electron.NativeImage>(), typed = new Map<number, number>()
  let probes: number[] = []
  await renderFilm(deck, 0, {
    width: W,
    plan: (scene) => {
      assert.equal(scene.steps.length, 3, 'Takte: Aufbau, Klick-Element mit Kamera, Tippen')
      near(scene.steps[0], 0.4, 0.01, 'Takt 0 = fade 400 ms')
      near(scene.steps[1], 0.8, 0.01, 'Takt 1 = Kamerafahrt 0,8 s (länger als pop)')
      near(scene.steps[2], 0.226, 0.01, 'Takt 2 = 6 Buchstaben × 45 ms')
      assert.equal(scene.endless, false)
      assert.ok(scene.words >= 4, `Wörter: ${scene.words}`)
      ;({ beats, dur } = sceneTimeline({ ...scene, lead: 0 }))
      probes = [0, beats[1] - 0.05, beats[1] + 0.4, beats[1] + 0.85, beats[2] + 0.1, dur]
      return { beats, times: [...probes, ...Array.from({ length: Math.round(dur * FPS) + 1 }, (_, k) => k / FPS)] }
    },
  }, async (t, img) => {
    if (++n > probes.length) return void (first ||= Date.now())
    assert.deepEqual(img.getSize(), { width: W, height: 1080 })
    shots.set(n, img)
    typed.set(n, await js<number>(`[...document.querySelectorAll('[data-item="type"] .dw-part')].filter((p) => getComputedStyle(p).opacity === '1').length`))
  })
  const fps = (n - probes.length - 1) / ((Date.now() - first) / 1000)
  const [start, before, mid, after, typing, end] = [1, 2, 3, 4, 5, 6].map((k) => shots.get(k)!)

  const raw = start.crop({ x: Math.round(1220 * F), y: Math.round(40 * F), width: 1, height: 1 }).toBitmap()
  order = raw[2] > 200 && raw[0] < 60 ? 'BGRA' : raw[0] > 200 && raw[2] < 60 ? 'RGBA' : assert.fail(`Prüfquadrat rot nicht gefunden: ${[...raw]}`)
  assert.equal(find(start, MAGENTA).n, 0, 't=0: Klick-Element noch unsichtbar')
  assert.equal(find(before, MAGENTA).n, 0, 'vor Takt 1: Klick-Element noch unsichtbar')
  const g0 = find(before, GREEN), g1 = find(mid, GREEN), g2 = find(after, GREEN)
  near(g0.w, 100 * F, 3, 'Rechteck vor der Kamerafahrt (Breite)')
  near(g0.x, 80 * F, 3, 'Rechteck vor der Kamerafahrt (x)')
  assert.ok(g1.w > g0.w + 10 && g1.w < 2 * g0.w - 10, `mitten in der Fahrt: Breite ${g1.w}`)
  near(g2.w, 200 * F, 4, 'nach Takt 1 + 0,8 s: Rechteck doppelt so breit')
  near(g2.h, 120 * F, 4, 'nach Takt 1 + 0,8 s: Rechteck doppelt so hoch')
  near(g2.x, 160 * F, 4, 'nach Takt 1 + 0,8 s: Rechteck verschoben (x)')
  near(g2.y, 160 * F, 4, 'nach Takt 1 + 0,8 s: Rechteck verschoben (y)')
  assert.ok(find(end, MAGENTA).n > 2000, `Szenenende: Klick-Element sichtbar (${find(end, MAGENTA).n} px)`)
  assert.equal(typed.get(4), 0, 'Tippen vor Takt 2: kein Buchstabe')
  assert.ok(typed.get(5)! > 0 && typed.get(5)! < 6, `Tippen nach 0,1 s: ${typed.get(5)} von 6 Buchstaben`)
  assert.equal(typed.get(6), 6, 'Tippen am Ende: alle Buchstaben')

  // 2) Zähler: Zahl läuft mit dem Aufbau (zoom-kpi, 400 ms) von 0 hoch; Format bleibt („1.234,5 €“, „3,2 Mio.“, „42 %“), „Q3“ bleibt stehen
  const texts: string[][] = []
  for (const [i, times] of [[1, [0, 0.2, 0.45, 3]], [2, [0, 0.2, 3]]] as const) {
    await renderFilm(deck, i, { width: 1280, plan: (s) => ({ beats: sceneTimeline({ ...s, lead: 0 }).beats, times: [...times] }) },
      async () => void texts.push(await js<string[]>(`[...document.querySelectorAll('.bign-value, .kpi-value')].map((e) => e.textContent)`)))
  }
  assert.deepEqual(texts[0], ['0,0 €'])
  assert.ok(texts[1][0] !== '1.234,5 €' && /^[1-9]\d{0,2}(\.\d{3})*,\d €$/.test(texts[1][0]), `halbe Aufbauzeit: ${texts[1][0]}`)
  assert.deepEqual([texts[2], texts[3]], [['1.234,5 €'], ['1.234,5 €']])
  assert.deepEqual(texts[4], ['0 %', '0,0 Mio.', '+0', 'Q3'])
  assert.ok(texts[5].slice(0, 3).every((v, k) => v !== texts[6][k]) && texts[5][3] === 'Q3' && /^\d+ %$/.test(texts[5][0]) && /^\d,\d Mio\.$/.test(texts[5][1]), `halbe Aufbauzeit: ${texts[5]}`)
  assert.deepEqual(texts[6], ['42 %', '3,2 Mio.', '+12', 'Q3'])

  // 3) Video: pausiert, je Frame gespult (auch rückwärts), Szene läuft bis zum Ende (endless)
  const colors: number[][] = []
  await renderFilm(deck, 3, {
    width: 1280,
    plan: (s) => (assert.equal(s.endless, true, 'Video → endless'), near(s.media ?? 0, 2, 0.1, 'Videomaterial (media)'), { beats: [0], times: [0.5, 1.5, 0.5, 5] }),
  }, (_, img) => void colors.push(rgbAt(img, 320, 180)))
  const is = (c: number[], rgb: number[], what: string) => assert.ok(c.every((v, k) => Math.abs(v - rgb[k]) < 60), `${what}: ${c}`)
  is(colors[0], [255, 0, 0], 'Video bei 0,5 s rot')
  is(colors[1], [0, 0, 255], 'Video bei 1,5 s blau')
  is(colors[2], [255, 0, 0], 'zurückgespult auf 0,5 s rot')
  is(colors[3], [0, 0, 255], 'nach dem Ende: letztes Bild steht')

  // 4) Video lädt nicht: kein Warten auf seeked (sonst 2 s je Frame)
  const t4 = Date.now()
  await renderFilm(deck, 4, { width: 1280, plan: () => ({ beats: [0], times: [0, 0.5, 1, 1.5, 2] }) }, () => {})
  assert.ok(Date.now() - t4 < 4000, `defektes Video bremst: ${Date.now() - t4} ms für 5 Frames`)

  // 5) Motion-Grafik: Bewegung je Takt (weich, Feder), Größe um die Mitte, Deckkraft und Füllung (Hintergrund und SVG)
  const kb: Electron.NativeImage[] = []
  let kt: number[] = []
  await renderFilm(deck, 5, {
    width: 1280,
    plan: (s) => {
      near(s.steps[1], 0.8, 0.01, 'Takt 1 = Key 800 ms')
      const { beats: b, dur: d } = sceneTimeline({ ...s, lead: 0 })
      return { beats: b, times: (kt = [b[1] - 0.05, b[1] + 0.4, b[2] - 0.02, d]) }
    },
  }, (_, img) => void kb.push(img))
  const [k0, k1, k2, k3] = kb, at = (img: Electron.NativeImage, rgb: number[]) => find(img, rgb)
  near(at(k0, GREEN).x, 100, 2, 'vor Takt 1: Rechteck links')
  assert.ok(at(k1, GREEN).x > 250 && at(k1, GREEN).x < 550, `weich zur Hälfte: x ${at(k1, GREEN).x}`)
  assert.ok(at(k1, BLUE).x > 700 + 15, `Feder schwingt über das Ziel: x ${at(k1, BLUE).x} (t ${kt[1].toFixed(2)})`)
  near(at(k2, BLUE).x, 700, 4, 'Feder am Ende von Takt 1 am Ziel')
  near(at(k2, GREEN).x, 700, 2, 'Ende Takt 1: Rechteck rechts')
  near(at(k2, GREEN).y, 40, 2, 'Ende Takt 1: y unverändert')
  const g = at(k3, GREEN)
  assert.deepEqual([g.x, g.y, g.w, g.h].map(Math.round), [700, 120, 200, 30], `Takt 2: x bleibt, y/w/h neu: ${[g.x, g.y, g.w, g.h]}`)
  assert.ok(at(k0, MAGENTA).n > 5000 && at(k3, MAGENTA).n === 0, `opacity-Key: ${at(k0, MAGENTA).n} → ${at(k3, MAGENTA).n} px`)
  assert.ok(at(k0, YELLOW).n > 8000 && at(k0, CYAN).n === 0, `vor dem fill-Key gelb: ${at(k0, YELLOW).n} px`)
  assert.ok(at(k3, YELLOW).n === 0 && at(k3, CYAN).n > 8000, `fill-Key (Rechteck und Raute): gelb ${at(k3, YELLOW).n}, cyan ${at(k3, CYAN).n} px`)

  // 6) Diagramm wächst ab Takt 0 in 1,2 s; Textmarker zieht sich nach dem Aufbau (fade 500 ms) unter dem **Wort** auf
  const cb: Electron.NativeImage[] = [], words: number[][] = []
  await renderFilm(deck, 6, { width: 1280, plan: (s) => ({ beats: [0], times: [0, 0.2, 0.45, sceneTimeline({ ...s, lead: 0 }).dur] }) }, async (_, img) => {
    cb.push(img)
    words.push(await js<number[]>(`(() => { const s = document.querySelector('[data-item="mark"] strong').getBoundingClientRect(), r = document.querySelector('.slide').getBoundingClientRect(); return [s.left - r.left, s.top - r.top, s.width, s.height].map((v) => v * 1280 / r.width) })()`))
  })
  const accent = await js<string>(`getComputedStyle(document.querySelector('.slide')).getPropertyValue('--accent').trim()`)
  const ACC = [1, 3, 5].map((i) => parseInt(accent.slice(i, i + 2), 16))
  const bar = (img: Electron.NativeImage) => find(img.crop({ x: 700, y: 60, width: 500, height: 360 }), ACC).n
  assert.ok(bar(cb[3]) > 5000 && bar(cb[1]) < bar(cb[3]) / 2, `Balken bei 0,2 s niedriger als am Ende: ${bar(cb[1])} < ${bar(cb[3])} px`)
  const [wx, wy, ww, wh] = words[3], under = (img: Electron.NativeImage) => find(img.crop({ x: Math.round(wx), y: Math.round(wy + wh * 0.8), width: Math.round(ww), height: Math.round(wh * 0.25) }), ACC)
  assert.equal(under(cb[0]).n, 0, 'Marker am Anfang: keine Akzentpixel unter dem Wort')
  assert.equal(under(cb[2]).n, 0, 'Marker erst nach dem Aufbau')
  assert.ok(under(cb[3]).n > 100 && under(cb[3]).w > ww - 6, `Marker am Ende: ${under(cb[3]).n} px, Breite ${under(cb[3]).w} von ${ww.toFixed(0)}`)

  console.log(`frames ok – toBitmap: ${order}, ${fps.toFixed(1)} Frames/s bei ${W}×1080 (${n - probes.length} Frames, Szene ${dur.toFixed(2)} s)`)
}

app.whenReady().then(main).then(() => { closeHosts(); app.exit(0) }, (e) => { console.error(e); closeHosts(); app.exit(1) })
