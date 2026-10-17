// Zoom-Vorschläge für Bildschirmaufnahmen: wo und wann sich im Bild etwas tut. Ohne Electron, damit der Selbsttest unter Node läuft.
import { basename } from 'node:path'
import { ZOOM_SCALE, type ScreenZoom } from '../shared/film'
import { ffmpegBin, run } from './ffmpeg'

// Gemessen wird auf 64×36 Graustufen bei 4 Bildern/s: genug für „wo ungefähr“, billig auch für lange Aufnahmen (~33 MB je Stunde)
const W = 64, H = 36, FPS = 4
const NOISE = 16 // Grauwert-Differenz (0–255) je Zelle; darunter Kompressionsrauschen und ein blinkender Textcursor
const SMALL = 10 // Zellen (von 2304): so viel ändert ein Mauszeiger an alter und neuer Stelle zusammen
const GAP = 0.75 // s Ruhe, bis ein Ereignis endet
const MIN_LEN = 0.5 // s kürzere Ereignisse: Flackern
const MAX_AREA = 0.6 // größere Rahmen: Seitenwechsel oder Scrollen, da hilft kein Zoom
const FILL = 0.6 // der Rahmen füllt so viel der Breite bzw. Höhe des Ausschnitts
const MAX_SCALE = 2.5 // unter ZOOM_SCALE.max: ein Vorschlag lässt etwas Umgebung stehen
const HOLD = 1 // s nach dem Ereignis bleibt der Zoom
const SPACING = 3 // s höchstens ein Zoom je so viel Zeit
const MAX_RUN = 10 * 60_000 // ms für ffmpeg; eine Stunde Aufnahme braucht wenige Minuten

type Box = { x0: number; y0: number; x1: number; y1: number } // Zellen, einschließlich
type Step = { i: number; n: number; box: Box } // Änderung von Bild i−1 zu Bild i

const union = (bs: Box[]): Box => bs.reduce((u, b) => ({ x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0), x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) }))
const area = (b: Box) => ((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1)) / (W * H)
const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d

/** Zoom-Vorschläge für eine Bildschirmaufnahme, sortiert. Ein Ereignis = Bilder mit Änderung, Lücken bis GAP; Ziel = Mitte des geänderten Bereichs.
 *  Mauszeiger: Ereignisse aus lauter kleinen Änderungen (≤ SMALL Zellen je Bild), nach denen das Bild bis auf ≤ SMALL Zellen wieder aussieht wie davor, fallen weg.
 *  Hat ein Ereignis auch größere Änderungen, zählen nur diese für Rahmen und Beginn: der Weg des Zeigers zum Knopf zieht den Zoom nicht mit.
 *  ponytail: Zeiger nur über Größe und Bleiben erkannt; ein kurzes Wort in einem Eingabefeld sieht genauso aus und fällt mit weg.
 *  Upgrade: Mausposition beim Aufnehmen mitschreiben und ihre Umgebung ausblenden. */
export async function screenZooms(file: string): Promise<ScreenZoom[]> {
  // setpts: Aufnahmen von OBS oder wf-recorder beginnen oft nicht bei 0, Zeiten sollen ab Videobeginn zählen
  const vf = `setpts=PTS-STARTPTS,fps=${FPS},scale=${W}:${H},format=gray`
  const res = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-an', '-sn', '-vf', vf, '-f', 'rawvideo', 'pipe:1'], { signal: AbortSignal.timeout(MAX_RUN) })
    .catch((e: Error) => { throw e.name === 'AbortError' ? new Error(`Die Analyse von ${basename(file)} dauerte länger als ${MAX_RUN / 60_000} min.`) : e })
  if (res.code !== 0) throw new Error(`Bildänderungen in ${basename(file)} nicht messbar:\n${res.err.trim().split('\n').slice(-5).join('\n')}`)
  const S = W * H, frames = Math.floor(res.out.length / S)
  const frame = (i: number) => res.out.subarray(i * S, (i + 1) * S)
  const change = (a: Buffer, b: Buffer) => {
    let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1
    for (let p = 0; p < S; p++) {
      if (Math.abs(a[p] - b[p]) <= NOISE) continue
      const x = p % W, y = (p - x) / W
      n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
    return { n, box: { x0, y0, x1, y1 } }
  }

  const events: Step[][] = []
  for (let i = 1; i < frames; i++) {
    const c = change(frame(i - 1), frame(i))
    if (!c.n) continue
    const ev = events.at(-1), last = ev?.at(-1)
    if (ev && last && (i - last.i - 1) / FPS <= GAP) ev.push({ i, ...c })
    else events.push([{ i, ...c }])
  }

  const found: { start: number; end: number; box: Box }[] = []
  for (const ev of events) {
    const big = ev.filter((s) => s.n > SMALL)
    if (!big.length && change(frame(ev[0].i - 1), frame(ev.at(-1)!.i)).n <= SMALL) continue // Zeiger
    const use = big.length ? big : ev
    const a = use[0].i, b = use.at(-1)!.i
    if ((b - a + 1) / FPS < MIN_LEN) continue
    const box = union(use.map((s) => s.box))
    if (area(box) > MAX_AREA) continue
    const prev = found.at(-1)
    if (prev && (a / FPS <= prev.end || a / FPS - prev.start < SPACING)) {
      // zu nah am vorigen: zusammenfassen, solange der gemeinsame Rahmen klein bleibt; sonst gewinnt der frühere (kein Mitte-Zoom mit 1,2)
      const u = union([prev.box, box])
      if (area(u) <= MAX_AREA) { prev.end = Math.max(prev.end, b / FPS + HOLD); prev.box = u }
    } else found.push({ start: a / FPS, end: b / FPS + HOLD, box })
  }

  return found.map(({ start, end, box }) => {
    const w = (box.x1 - box.x0 + 1) / W, h = (box.y1 - box.y0 + 1) / H
    const scale = Math.min(MAX_SCALE, Math.max(ZOOM_SCALE.min, FILL / Math.max(w, h)))
    return { start: r(start, 2), end: r(end, 2), x: r((box.x0 + box.x1 + 1) / 2 / W, 3), y: r((box.y0 + box.y1 + 1) / 2 / H, 3), scale: r(scale, 2) }
  })
}
