// Gesichter für den Zuschnitt (Reels 9:16): YuNet 2023mar aus opencv_zoo (MIT-Lizenz, © 2020 Shiqi Yu) über onnxruntime-node.
// Das Modell (230 KB) lädt beim ersten Einsatz von Hugging Face nach <DECKWERK_HOME|~/Deckwerk>/models. Ohne Electron, damit
// der Selbsttest unter Node läuft (scripts/check-faces.ts). Bilder kommen aus rawFrames: bgr24, 640×640, oben links eingepasst.
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InferenceSession } from 'onnxruntime-node'
import { cropRect, type Part, type VideoInfo } from '../shared/video'
import { download } from './download'
import { rawFrames } from './ffmpeg'

// fester Commit + Prüfsumme (wie bg-remove.ts): ein nachträglich verändertes Modell landet nie im nativen ONNX-Parser
const MODEL_URL = 'https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx'
const MODEL_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
// ponytail: feste Eingabe 640×640, bei 16:9 rechnet das Modell ~40 % schwarzen Rand mit. Upgrade: face_detection_yunet_2026may
// (opencv_zoo, dynamische Eingabe) auf 640×384, falls die Erkennung bei vielen Ausschnitten spürbar bremst.
const S = 640
const MIN_SCORE = 0.6, NMS_IOU = 0.3 // Vorgaben aus opencv_zoo/yunet.py
const GAP = 0.12 // Anteil der Bildbreite, ab dem zwei Gesichtspositionen zu verschiedenen Personen gehören
// Kamerafahrt (cameraPath): erst ab LONG s lohnt sie; ein Bild je STEP s, höchstens MAX_SAMPLES je part (je Bild ein Seek + ~50 ms Erkennung)
const LONG = 4, STEP = 1, MAX_SAMPLES = 60
const MIN_HIT = 0.4 // Gesicht in weniger Bildern: kein Motiv (Maske, Randanschnitt, Fehltreffer) → Bildmitte statt Zuschnitt auf den Rand
const DEAD = 0.5 // Totzone: Kamera steht, solange das Gesicht in der mittleren Hälfte des Zuschnitts bleibt
export const MAX_SPEED = 0.25 // Zuschnittbreiten je Sekunde: schneller wirkt die Fahrt hektisch
const TOL = 0.01, MAX_KEYS = 20 // Stützpunkt fällt weg, solange die Fahrt um ≤ 1 % der Bildbreite abweicht; mehr als 20 → gröber

/** px im Video; mouth = Mundwinkel im Bild links und rechts (x1, y1, x2, y2) */
export interface Face { x: number; y: number; w: number; h: number; score: number; mouth: [number, number, number, number] }

let session: Promise<InferenceSession> | null = null

function load(): Promise<InferenceSession> {
  return (session ??= (async () => {
    const dir = join(process.env.DECKWERK_HOME ?? join(homedir(), 'Deckwerk'), 'models'), file = join(dir, 'face_detection_yunet_2023mar.onnx')
    if (!existsSync(file)) { await mkdir(dir, { recursive: true }); await download(MODEL_URL, MODEL_SHA256, file) }
    const ort = await import('onnxruntime-node')
    return ort.InferenceSession.create(file, { executionProviders: ['cpu'] })
  })().catch((e) => { session = null; throw e }))
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const round = (v: number) => Math.round(v * 1000) / 1000
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const centerX = (f: Face) => f.x + f.w / 2

function iou(a: Face, b: Face) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  const inter = Math.max(0, w) * Math.max(0, h)
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/** Gesichter in einem rawFrames-Bild (640×640, bgr24), umgerechnet auf Videopixel; nach score absteigend. */
export async function detect(frame: Buffer, src: { w: number; h: number }): Promise<Face[]> {
  const s = await load()
  const ort = await import('onnxruntime-node')
  const n = S * S, input = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) input[c * n + i] = frame[i * 3 + c] // BGR 0–255 → CHW, ohne Normieren
  const out = await s.run({ input: new ort.Tensor('float32', input, [1, 3, S, S]) })
  const k = S / Math.max(src.w, src.h) // Bild-px je Video-px
  const found: Face[] = []
  for (const st of [8, 16, 32]) {
    const [cls, obj, bbox, kps] = ['cls', 'obj', 'bbox', 'kps'].map((o) => out[`${o}_${st}`].data as Float32Array)
    const cols = S / st
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]))
      if (score < MIN_SCORE) continue
      const col = i % cols, row = Math.floor(i / cols)
      const w = Math.exp(bbox[i * 4 + 2]) * st, h = Math.exp(bbox[i * 4 + 3]) * st
      const px = (j: number) => ((col + kps[i * 10 + j]) * st) / k, py = (j: number) => ((row + kps[i * 10 + j]) * st) / k
      // Landmarken: rechtes Auge, linkes Auge, Nase, rechter Mundwinkel, linker Mundwinkel (der Person, also im Bild links, rechts)
      found.push({ x: ((col + bbox[i * 4]) * st - w / 2) / k, y: ((row + bbox[i * 4 + 1]) * st - h / 2) / k, w: w / k, h: h / k, score, mouth: [px(6), py(7), px(8), py(9)] })
    }
  }
  const keep: Face[] = []
  for (const f of found.sort((a, b) => b.score - a.score)) if (keep.every((g) => iou(f, g) <= NMS_IOU)) keep.push(f)
  return keep
}

/** Mittelpunkt des größten Gesichts je Bild, 0..1 der Videobreite; null = kein Gesicht. */
export async function faceX(frames: Buffer[], src: { w: number; h: number }): Promise<(number | null)[]> {
  const out: (number | null)[] = []
  for (const f of frames) { // nacheinander: eine Session, wenige Kerne
    const big = (await detect(f, src)).reduce<Face | null>((a, b) => (a && a.w * a.h >= b.w * b.h ? a : b), null)
    out.push(big && clamp01(centerX(big) / src.w))
  }
  return out
}

// Stützpunkte nur, wo sich das Tempo ändert: weglassen, solange die Gerade vom letzten behaltenen Punkt alle Zwischenpunkte auf tol trifft
function simplify(pts: [number, number][], tol: number) {
  const out = pts.slice(0, 1)
  for (let j = 2, a = 0; j < pts.length; j++) {
    const [ta, fa] = pts[a], [tj, fj] = pts[j]
    if (pts.slice(a + 1, j).some(([t, f]) => Math.abs(fa + ((fj - fa) * (t - ta)) / (tj - ta) - f) > tol)) out.push(pts[(a = j - 1)])
  }
  return pts.length > 1 ? [...out, pts[pts.length - 1]] : out
}

/** Kamerafahrt aus Gesichtspositionen (nach t sortiert; t = Quellsekunde, x = 0..1, null = kein Gesicht) → Stützpunkte [t, focus].
 *  cropW = Zuschnittbreite als Anteil der Quellbreite. Je Abschnitt zwischen cuts: Median über 3 gegen Ausreißer, Lücken halten
 *  die letzte Position; die Kamera steht, solange das Gesicht in der Totzone bleibt, sonst schiebt es sie mit ≤ MAX_SPEED.
 *  Am cut springt sie (End- und Startpunkt zur selben Zeit). Steht sie durchgehend: ein Stützpunkt.
 *  ponytail: lineare Fahrt ohne Anfahr-/Bremsrampe, Person bleibt nach dem Gehen am Rand der Totzone stehen.
 *  Upgrade: Pfad-Glättung mit Rampen (z. B. L1-Optimierung wie AutoFlip) und langsames Nachzentrieren, falls es ruckig wirkt. */
export function cameraPath(samples: { t: number; x: number | null }[], cuts: number[], cropW: number): [number, number][] {
  const D = (DEAD * cropW) / 2, at = (v: number) => Math.min(1 - cropW / 2, Math.max(cropW / 2, v)) // nur erreichbare Mitten
  const cs = [...cuts].sort((a, b) => a - b), seg = (t: number) => cs.filter((c) => c <= t).length
  const paths: [number, number][][] = []
  let carry = samples.find((s) => s.x !== null)?.x ?? 0.5
  // je Abschnitt mit Bildern; gesprungen wird am letzten cut vor dem ersten Bild des nächsten Abschnitts
  for (let i = 0; i < samples.length; ) {
    const k = seg(samples[i].t), g: typeof samples = []
    while (i < samples.length && seg(samples[i].t) === k) g.push(samples[i++])
    let last = g.find((s) => s.x !== null)?.x ?? carry // Lücke am Abschnittsanfang: erstes Gesicht im Abschnitt
    const xs = g.map((s) => (last = s.x ?? last))
    carry = last
    const sm = xs.map((_, j) => median(xs.slice(Math.max(0, j - 1), j + 2)))
    let cam = at(sm[0])
    const pts = g.map((s, j): [number, number] => {
      if (j) {
        const v = MAX_SPEED * cropW * (s.t - g[j - 1].t), want = Math.min(sm[j] + D, Math.max(sm[j] - D, cam))
        cam = at(cam + Math.min(v, Math.max(-v, want - cam)))
      }
      return [s.t, cam]
    })
    if (k && cs[k - 1] < g[0].t) pts.unshift([cs[k - 1], pts[0][1]])
    if (i < samples.length) pts.push([cs[seg(samples[i].t) - 1], cam])
    paths.push(pts)
  }
  let keys: [number, number][] = []
  for (let tol = TOL; tol < 0.1 && (!keys.length || keys.length > MAX_KEYS); tol *= 2) keys = paths.flatMap((p) => simplify(p, tol))
  keys = keys.map(([t, f]): [number, number] => [round(t), round(f)])
  return keys.every(([, f]) => f === keys[0][1]) ? keys.slice(0, 1) : keys
}

/** Setzt focus nur bei parts ohne focus: Median über Bilder bei 25/50/75 % des parts. Kein Gesicht → focus bleibt leer (Mitte).
 *  Ab LONG s und mit size (Zuschnitt schmaler als die Quelle): ein Bild je STEP s, focus = Median, track = cameraPath, falls die
 *  Kamera fährt. cuts = harte Bildwechsel (Quellsekunden): dort springt der Zuschnitt. */
export async function autoFocus(file: string, parts: Part[], info: VideoInfo, o: { cuts?: number[]; size?: { w: number; h: number } } = {}): Promise<Part[]> {
  const cropW = o.size ? cropRect(info, o.size).w / info.w : 1
  const out: Part[] = []
  for (const p of parts) {
    if (p.focus !== undefined) { out.push(p); continue }
    const len = p.end - p.start, n = len >= LONG && cropW < 1 ? Math.min(MAX_SAMPLES, Math.round(len / STEP)) : 0
    const times = (n ? Array.from({ length: n }, (_, i) => (i + 0.5) / n) : [0.25, 0.5, 0.75]).map((q) => Math.min(p.start + q * len, info.duration - 0.1))
    // kein Bild (Videospur kürzer als der Container): focus bleibt leer statt alle parts zu verwerfen
    const fr = await rawFrames(file, times).catch(() => null)
    const all = fr ? await faceX(fr, info) : [], xs = all.filter((x): x is number => x !== null)
    if (!xs.length || xs.length < MIN_HIT * all.length) { out.push(p); continue }
    const track = n ? cameraPath(times.map((t, i) => ({ t, x: all[i] })), (o.cuts ?? []).filter((c) => c > p.start && c < p.end), cropW) : []
    out.push({ ...p, focus: round(median(xs)), ...(track.length > 1 && { track }) })
  }
  return out
}

// Mittlere absolute Grauwertdifferenz zweier Bilder im Mund-Rechteck (Breite = Mundwinkel, Höhe halbe Mundbreite), in Bild-px.
// Mittel je Pixel: so unabhängig von der Gesichtsgröße.
function mouthMove(a: Buffer, b: Buffer, [x1, y1, x2, y2]: number[]) {
  const mw = Math.hypot(x2 - x1, y2 - y1), cy = (y1 + y2) / 2
  let sum = 0, n = 0
  for (let y = Math.max(0, Math.round(cy - mw / 4)); y <= Math.min(S - 1, Math.round(cy + mw / 4)); y++)
    for (let x = Math.max(0, Math.round(Math.min(x1, x2))); x <= Math.min(S - 1, Math.round(Math.max(x1, x2))); x++) {
      const i = (y * S + x) * 3
      sum += Math.abs(0.114 * (a[i] - b[i]) + 0.587 * (a[i + 1] - b[i + 1]) + 0.299 * (a[i + 2] - b[i + 2]))
      n++
    }
  return n ? sum / n : 0
}

/** Aktiver Sprecher → focus 0..1: je Sprecher bis zu 6 längste Turns, je Turn zwei Bilder 0,2 s auseinander in der Mitte;
 *  Sprecher = Gesicht (x-Gruppe), dessen Mund sich in seinen Turns im Mittel am stärksten bewegt. Ohne Gesicht fehlt der Sprecher.
 *  ponytail: Mund-Grauwertdifferenz statt Lippen-Modell, Kopfbewegung zählt mit; Zuordnung gierig nach Wert statt ungarischer
 *  Methode. Upgrade: Lippen-Sync-Modell (z. B. TalkNet), falls Zuhörer mit viel Mimik den Sprecher übertrumpfen. */
export async function speakerFaces(file: string, turns: { start: number; end: number; speaker: number }[], info: VideoInfo): Promise<Map<number, number>> {
  const k = S / Math.max(info.w, info.h)
  const obs: { x: number; move: number; speaker: number }[] = []
  // höchstens 6 Sprecher (meiste Redezeit): mehr Gesichter trennt die x-Gruppierung im 9:16-Zuschnitt ohnehin nicht sinnvoll
  const talk = new Map<number, number>()
  for (const t of turns) talk.set(t.speaker, (talk.get(t.speaker) ?? 0) + t.end - t.start)
  for (const speaker of [...talk.keys()].sort((a, b) => talk.get(b)! - talk.get(a)!).slice(0, 6)) {
    const longest = turns.filter((t) => t.speaker === speaker).sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, 6)
    for (const t of longest) {
      const mid = Math.min(Math.max((t.start + t.end) / 2, 0.1), info.duration - 0.2)
      const fr = await rawFrames(file, [mid - 0.1, mid + 0.1]).catch(() => null) // Ton länger als Bild: Turn auslassen
      if (!fr) continue
      const [a, b] = fr
      const fb = await detect(b, info)
      for (const f of await detect(a, info)) {
        // dieselbe Person im zweiten Bild: nächster Mittelpunkt, höchstens eine halbe Gesichtsbreite entfernt
        const g = fb.reduce<Face | null>((m, x) => (m && Math.abs(centerX(m) - centerX(f)) <= Math.abs(centerX(x) - centerX(f)) ? m : x), null)
        if (!g || Math.abs(centerX(g) - centerX(f)) > f.w / 2) continue
        obs.push({ x: clamp01((centerX(f) + centerX(g)) / 2 / info.w), move: mouthMove(a, b, f.mouth.map((v) => v * k)), speaker })
      }
    }
  }
  // nach x gruppieren: neue Gruppe, wo zwei benachbarte Positionen mehr als GAP auseinanderliegen
  obs.sort((p, q) => p.x - q.x)
  let c = 0
  const of = obs.map((o, i) => (c += i && o.x - obs[i - 1].x > GAP ? 1 : 0))
  const centers = Array.from({ length: c + 1 }, (_, j) => median(obs.filter((_, i) => of[i] === j).map((o) => o.x)))
  // Wert je (Sprecher, Gruppe) = mittlere Mundbewegung in seinen Turns × n/(n+1), damit eine Einzelbeobachtung (Fehltreffer)
  // weniger zählt; gierig vergeben, belegte Gruppe → nächstbeste
  const sum = new Map<string, { speaker: number; c: number; s: number; n: number }>()
  obs.forEach((o, i) => {
    const key = `${o.speaker}:${of[i]}`, e = sum.get(key) ?? { speaker: o.speaker, c: of[i], s: 0, n: 0 }
    e.s += o.move; e.n++; sum.set(key, e)
  })
  const pairs = [...sum.values()].sort((a, b) => b.s / (b.n + 1) - a.s / (a.n + 1))
  const res = new Map<number, number>(), used = new Set<number>()
  for (const p of pairs) if (!res.has(p.speaker) && !used.has(p.c)) { res.set(p.speaker, round(centers[p.c])); used.add(p.c) }
  for (const p of pairs) if (!res.has(p.speaker)) res.set(p.speaker, round(centers[p.c])) // mehr Sprecher als Gesichter: bestes, auch doppelt
  return res
}
