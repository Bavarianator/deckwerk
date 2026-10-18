// Element-Animation Zeichnen im Film und in der PPTX: npx electron-vite build && npx esbuild scripts/check-draw.ts --bundle --platform=node --format=cjs --external:electron --loader:.md=text --log-level=warning --outfile=out/main/check-draw.cjs && DECKWERK_HOME=${TMPDIR:-/tmp}/check-draw ./node_modules/.bin/electron out/main/check-draw.cjs --ozone-platform=x11
// (Bündel in out/main, damit render.ts den Renderer unter ../renderer/index.html findet)
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import JSZip from 'jszip'
import { closeHosts, renderFilm, renderSlide } from '../src/main/render'
import { buildPptx } from '../src/main/export-pptx'
import { sceneTimeline } from '../src/shared/film'
import type { Deck, Item } from '../src/shared/deck'

const W = 1920, F = W / 1280
const home = process.env.DECKWERK_HOME ?? join(process.env.TMPDIR ?? '/tmp', 'check-draw')
mkdirSync(home, { recursive: true })

const draw = (it: Item): Item => ({ ...it, anim: 'draw', animStart: 'with' })
const items: Item[] = [
  { id: 'probe', kind: 'shape', shape: 'rect', x: 1200, y: 20, w: 40, h: 40, fill: '#FF0000' }, // Kanalreihenfolge
  draw({ id: 'linie', kind: 'shape', shape: 'line', x: 80, y: 600, w: 600, h: 40, stroke: '#FF00FF', strokeW: 8, lineEnd: 'arrow' }),
  draw({ id: 'zurueck', kind: 'shape', shape: 'line', x: 80, y: 660, w: 600, h: 40, stroke: '#00FFFF', strokeW: 8, animDir: 'left' }),
  draw({ id: 'kreis', kind: 'shape', shape: 'donut', x: 760, y: 420, w: 240, h: 240, stroke: '#00FF00', strokeW: 10 }),
  draw({ id: 'stern', kind: 'shape', shape: 'star', x: 760, y: 100, w: 220, h: 220, fill: '#FF8800', stroke: '#000080', strokeW: 6 }),
  draw({ id: 'icon', kind: 'icon', icon: 'house', x: 1040, y: 420, w: 200, h: 200, color: '#0000FF' }),
  draw({ id: 'flaeche', kind: 'shape', shape: 'rect', x: 1040, y: 100, w: 160, h: 100, fill: '#FFFF00' }), // div ohne Striche: Wischen
]
const deckOf = (its: Item[]): Deck => ({
  title: 'Zeichnen', theme: { id: 'beratung' }, transition: 'none', mode: 'click', film: {},
  slides: [{ id: 's1', layout: 'statement', build: 'none', content: { text: 'Zeichnen' }, items: its }],
})
const deck = deckOf(items)

const film = () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('#film'))!
const js = <T>(code: string): Promise<T> => film().webContents.executeJavaScript(code)
const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} statt ≈ ${b}`)
let order: 'BGRA' | 'RGBA' = 'BGRA'
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
const C = { linie: [255, 0, 255], zurueck: [0, 255, 255], kreis: [0, 255, 0], stern: [0, 0, 128], fuellung: [255, 136, 0], icon: [0, 0, 255], flaeche: [255, 255, 0] }
type Counts = Record<keyof typeof C, ReturnType<typeof find>>
const measure = (img: Electron.NativeImage) => Object.fromEntries(Object.entries(C).map(([k, rgb]) => [k, find(img, rgb)])) as Counts

async function main() {
  // 1) Film: alle Elemente „Zugleich“ in Takt 0, Bilder bei 0 / 0,1 / 0,4 s und am Ende; dazu der Stand ohne Animation
  let steps: number[] = [], paths = 0, rest: string[] = []
  const shots: Electron.NativeImage[] = []
  await renderFilm(deck, 0, {
    width: W,
    plan: (scene) => {
      steps = scene.steps
      const { dur } = sceneTimeline({ ...scene, lead: 0 })
      return { beats: [0], times: [0, 0.1, 0.4, dur] }
    },
  }, async (_, img) => {
    shots.push(img)
    if (shots.length === 1) paths = await js<number>(`document.querySelectorAll('[data-item="icon"] :is(path, line, polyline, polygon, circle, rect, ellipse)').length`)
    // am Ende: kein Dasharray und keine Teil-Füllung mehr (eigener Stil gilt wieder)
    if (shots.length === 4) rest = await js<string[]>(`[...document.querySelectorAll('[data-item] :is(path, line, polyline, polygon, circle, rect, ellipse)')]
      .map((g) => getComputedStyle(g)).filter((c) => c.strokeDasharray !== 'none' || c.fillOpacity !== '1').map((c) => c.strokeDasharray + ' ' + c.fillOpacity)`)
  })
  let ref: Electron.NativeImage | undefined
  await renderFilm(deckOf(items.map(({ anim, animStart, ...it }) => it)), 0, { width: W, plan: () => ({ beats: [0], times: [0] }) }, (_, img) => void (ref = img))

  const raw = shots[0].crop({ x: Math.round(1220 * F), y: Math.round(40 * F), width: 1, height: 1 }).toBitmap()
  order = raw[2] > 200 && raw[0] < 60 ? 'BGRA' : raw[0] > 200 && raw[2] < 60 ? 'RGBA' : assert.fail(`Prüfquadrat rot nicht gefunden: ${[...raw]}`)
  const [start, early, mid, end] = shots.map(measure), full = measure(ref!)

  assert.ok(paths > 1, `Icon besteht aus mehreren Strichen: ${paths}`)
  near(steps[0], 0.8 + (paths - 1) * 0.06, 0.01, 'Takt 0 = 800 ms + 60 ms je weiterem Icon-Strich')
  for (const k of Object.keys(C) as (keyof typeof C)[]) {
    assert.equal(start[k].n, 0, `t=0: ${k} noch unsichtbar`)
    assert.ok(full[k].n > 300, `ohne Animation: ${k} sichtbar (${full[k].n} px)`)
    near(end[k].n, full[k].n, full[k].n * 0.02 + 20, `Ende: ${k} vollständig`)
  }
  assert.deepEqual(rest, [], 'Ende: Striche ohne Dasharray, Füllung ganz')

  assert.ok(early.linie.n > 0 && early.linie.n < full.linie.n * 0.15, `t=0,1 s: Linie erst angezeichnet (${early.linie.n} von ${full.linie.n} px)`)
  near(early.linie.x, 80 * F, 3, 't=0,1 s: Linie beginnt links')
  // Mitte (weich: halber Weg): linke Hälfte der Linie ja, rechte nein, Pfeilspitze erst am Ende
  near(mid.linie.x, 80 * F, 3, 't=0,4 s: Linie beginnt links')
  assert.ok(mid.linie.x + mid.linie.w > 260 * F && mid.linie.x + mid.linie.w < 500 * F, `t=0,4 s: Linie bis etwa zur Mitte (rechts ${mid.linie.x + mid.linie.w})`)
  assert.ok(mid.linie.h < 14 * F, `t=0,4 s: Pfeilspitze noch nicht da (Höhe ${mid.linie.h})`)
  assert.ok(end.linie.h > 30 * F, `Ende: Pfeilspitze da (Höhe ${end.linie.h})`)
  near(mid.zurueck.x + mid.zurueck.w, 680 * F, 3, 'Richtung links: zeichnet vom rechten Ende')
  assert.ok(mid.zurueck.x > 260 * F && mid.zurueck.x < 500 * F, `Richtung links: linkes Stück fehlt noch (links ${mid.zurueck.x})`)
  assert.ok(mid.kreis.n > full.kreis.n * 0.3 && mid.kreis.n < full.kreis.n * 0.7, `t=0,4 s: halber Kreis (${mid.kreis.n} von ${full.kreis.n} px)`)
  assert.ok(mid.stern.n > full.stern.n * 0.2 && mid.stern.n < full.stern.n * 0.8, `t=0,4 s: Stern-Umriss halb (${mid.stern.n} von ${full.stern.n} px)`)
  assert.equal(mid.fuellung.n, 0, 't=0,4 s: Füllung erst im letzten Drittel')
  assert.ok(mid.icon.n > 0 && mid.icon.n < full.icon.n * 0.8, `t=0,4 s: Icon teilweise (${mid.icon.n} von ${full.icon.n} px)`)
  assert.ok(mid.flaeche.w > 0.2 * 160 * F && mid.flaeche.w < 0.8 * 160 * F, `t=0,4 s: Fläche ohne Striche wischt (Breite ${mid.flaeche.w})`)

  // 2) PPTX: Zeichnen wird Wischen (800 ms), von links bzw. bei Richtung links von rechts
  const r = await renderSlide(deck, 0, { background: true })
  const zip = await JSZip.loadAsync(await buildPptx(deck, [{ measured: r.measured, background: r.background! }]))
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const wipes = (from: string) => xml.match(new RegExp(`filter="wipe\\(${from}\\)"><p:cBhvr><p:cTn id="\\d+" dur="800"/>`, 'g'))?.length ?? 0
  assert.equal(wipes('left'), 5, 'PPTX: 5 × Wischen von links, 800 ms')
  assert.equal(wipes('right'), 1, 'PPTX: Richtung links = Wischen von rechts')

  console.log(`draw ok – Takt ${steps[0].toFixed(2)} s, Icon ${paths} Striche; Mitte: Linie ${mid.linie.w}/${full.linie.w} px breit, Kreis ${mid.kreis.n}/${full.kreis.n} px`)
}

app.whenReady().then(main).then(() => { closeHosts(); app.exit(0) }, (e) => { console.error(e); closeHosts(); app.exit(1) })
