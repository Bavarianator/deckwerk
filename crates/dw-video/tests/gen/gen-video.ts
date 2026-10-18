// Gebündelt und ausgeführt von gen.mjs (Aufruf dort in Zeile 1). Fixtures für den Differenztest Rust ↔ TS (tests/video_diff.rs):
// Schnittliste, Filtergraphen und ffmpeg-Argumente der Exporte (ffmpeg als Attrappe, die die Argumente aufzeichnet), Film, Farbkorrektur,
// xmeml, Musik-Filter, Transkript-Chunks. Zufällige Fälle mit festem Seed; Eingaben auf 15 Stellen gerundet, Zahlen im Ergebnis als String(x).
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as V from '../../../../src/shared/video'
import type { Part, Transcript, Word, Overlay, Quiet, Cue } from '../../../../src/shared/video'
import * as FX from '../../../../src/main/video-fx'
import * as E from '../../../../src/main/export-video'
import * as X from '../../../../src/main/export-xmeml'
import * as FI from '../../../../src/shared/film'
import { planScene } from '../../../../src/main/export-film'
import * as G from '../../../../src/shared/grade'
import * as M from '../../../../src/main/music'
import * as C from '../../../../src/main/video-cache'

const TMP = process.env.DW_GEN_TMP!
type Case = Record<string, unknown> & { name: string; expected: unknown }
const fx: Record<string, Case[]> = {}
const hasNaN = (x: unknown): boolean => (typeof x === 'number' ? !Number.isFinite(x) : x && typeof x === 'object' ? Object.values(x).some(hasNaN) : false)
const p15 = <T>(x: T): T => (typeof x === 'number' ? (+x.toPrecision(15) as T) : Array.isArray(x) ? (x.map(p15) as T) : x && typeof x === 'object' ? (Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined).map(([k, v]) => [k, p15(v)])) as T) : x)
const enc = (x: unknown): unknown => (typeof x === 'number' ? String(x) : Array.isArray(x) ? x.map(enc) : x instanceof Uint8Array ? Array.from(x, String) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined).map(([k, v]) => [k, enc(v)])) : x)
// Transkripte einmal ablegen (fx.transcripts), Fälle verweisen per {"$ref": n} darauf
const pool = new Map<string, number>()
const refify = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(refify)
  if (!x || typeof x !== 'object') return x
  if (Array.isArray((x as Transcript).segments)) {
    const key = JSON.stringify(x)
    let k = pool.get(key)
    if (k === undefined) pool.set(key, (k = pool.size))
    return { $ref: k }
  }
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, refify(v)]))
}
const rec = (kind: string, input: Record<string, unknown>, run: (i: any) => unknown) => {
  if (hasNaN(input)) return
  const i = p15(input)
  const list = (fx[kind] ??= [])
  list.push({ name: `${kind} ${list.length}`, ...(refify(i) as object), expected: enc(run(i)) })
}
const recA = async (kind: string, input: Record<string, unknown>, run: (i: any) => Promise<unknown>) => {
  if (hasNaN(input)) return
  const i = p15(input)
  const list = (fx[kind] ??= [])
  let out: unknown
  try { out = await run(i) } catch (e) { out = { error: (e as Error).message } }
  list.push({ name: `${kind} ${list.length}`, ...(refify(i) as object), expected: enc(out) })
}

// Zufall mit festem Seed (mulberry32)
let seed = 0x5eed
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1))
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
const maybe = <T>(p: number, f: () => T): T | undefined => (rnd() < p ? f() : undefined)
const r2 = (x: number) => Math.round(x * 100) / 100
const r3 = (x: number) => Math.round(x * 1000) / 1000

const VOCAB = ['Wir', 'sind', 'gut.', 'klar', 'Das', 'ist', 'wichtig.', 'äh', 'Ähm,', 'um', 'also', 'Heute', 'zeigen', 'ich', 'euch', 'drei', 'Dinge.', 'Und', 'dann?', 'Ja!', 'weiter', '42', '„Zitat“', 'hmm…', 'Straße', 'z.', 'B.', '{x}', 'a\\b', 'Größe']
function transcript(D: number): Transcript {
  const segments: Transcript['segments'] = []
  for (let t = r2(rnd() * 2); t < D - 1;) {
    const len = r2(1 + rnd() * 7), end = Math.min(D, r2(t + len))
    const n = int(1, 10), words: Word[] = []
    let w = t
    for (let k = 0; k < n && w < end; k++) { const d = r2(0.1 + rnd() * 0.6); words.push({ w: (k ? ' ' : '') + pick(VOCAB), start: r2(w), end: r2(Math.min(end, w + d)) }); w = r2(w + d + rnd() * 0.4) }
    const text = words.map((x) => x.w).join('')
    segments.push(rnd() < 0.15 ? { start: t, end, text } : { start: t, end, text, words, ...(rnd() < 0.3 ? { speaker: int(0, 2) } : {}) })
    t = r2(end + rnd() * 1.5)
  }
  return { duration: D, lang: pick(['de', 'en', 'auto', 'en-US']), segments }
}
const TRANS = [...V.CUT_TRANSITIONS, 'slide', 'morph', undefined]
function parts(D: number, max: number): Part[] {
  const out: Part[] = []
  let t = r2(rnd() * 5)
  const n = int(1, max)
  for (let k = 0; k < n; k++) {
    const len = r2(0.6 + rnd() * 7)
    if (t + len > D - 1) break
    const p: Part = { start: t, end: r2(t + len) }
    if (rnd() < 0.15) p.speed = pick([0.5, 2, 1.5, 0.25, 4, 3, 1, 0.75])
    if (rnd() < 0.15) p.volume = pick([0, 0.5, 1, 1.8, 3])
    if (rnd() < 0.15) p.music = pick([0, 0.3, 1, 0.8])
    if (rnd() < 0.2) p.transition = pick(TRANS) as Part['transition']
    if (rnd() < 0.1) p.zoom = pick([1, 1.2, 1.5, 2])
    if (rnd() < 0.1) p.freeze = pick([0.2, 0.5, 1, 4])
    if (rnd() < 0.2) p.focus = r2(rnd())
    if (rnd() < 0.08) p.track = [[p.start, r2(rnd())], [r2(p.start + len / 2), r2(rnd())], [p.end, r2(rnd())]]
    out.push(p)
    const g = rnd()
    t = g < 0.25 ? p.end : g < 0.35 ? r2(p.end + 20 + rnd() * 10) : g < 0.4 ? Math.max(0, r2(p.start - 15)) : r2(p.end + rnd() * 2)
  }
  return out.length ? out : [{ start: 0, end: Math.min(D - 1, 3) }]
}
function overlays(D: number): Overlay[] {
  return Array.from({ length: int(0, 4) }, () => {
    const start = r2(rnd() * D * 0.8), end = r2(start + 0.5 + rnd() * 12)
    const o: Overlay = { start, end }
    const kind = rnd()
    if (kind < 0.45) { o.art = pick([...V.OVERLAY_ARTS, undefined]) as Overlay['art']; o.text = pick(['Anna Muster', 'Drei Punkte', ' ', '„Gut“', 'Zahl {42}', 'Zeile\nzwei', 'Sehr langer Titel über mehrere Zeilen hinweg, damit der Umbruch greift']) }
    else if (kind < 0.6) o.image = pick(['/bild/a.png', '/bild/b.jpg'])
    else if (kind < 0.7) { o.video = '/v/b.mp4'; if (rnd() < 0.5) o.from = r2(rnd() * 5) }
    else if (kind < 0.78) { o.slide = int(1, 3); o.image = '/job/einblendung.png' }
    else { o.art = pick(['verpixeln', 'markierung'] as const); o.box = [r2(rnd() * 0.8), r2(rnd() * 0.8), r2(0.05 + rnd() * 0.5), r2(0.05 + rnd() * 0.5)] }
    if (rnd() < 0.4) o.sub = pick(['Rolle', 'Quelle: Amt', ' '])
    if (o.art === 'liste' || rnd() < 0.05) o.items = Array.from({ length: int(0, 5) }, (_, k) => pick([`Punkt ${k + 1}`, ' ', 'Mehr']))
    if (rnd() < 0.5) o.pos = pick(V.OVERLAY_POS)
    if (rnd() < 0.3) o.size = pick(['klein', 'mittel', 'gross'] as const)
    if (o.art === 'markierung' && !o.box && rnd() < 0.5) o.box = [0.1, 0.02, 0.3, 0.2]
    return o
  })
}
const SIZES = [{ w: 1080, h: 1920 }, { w: 1920, h: 1080 }, { w: 1080, h: 1350 }, { w: 1080, h: 1080 }, { w: 720, h: 1280 }]
const SRCS = [{ w: 1920, h: 1080 }, { w: 1080, h: 1920 }, { w: 1280, h: 720 }, { w: 3840, h: 2160 }, { w: 640, h: 480 }]

// ASS-Zeit und Escape wie in export-video.ts (dort nicht exportiert)
const n2 = (i: number) => String(i).padStart(2, '0')
const at = (s: number) => { const cs = Math.max(0, Math.round(s * 100)); return `${Math.floor(cs / 360000)}:${n2(Math.floor(cs / 6000) % 60)}:${n2(Math.floor(cs / 100) % 60)}.${n2(cs % 100)}` }
const esc = (s: string) => s.replace(/\\/g, '＼').replace(/[{}]/g, (c) => `\\${c}`).replace(/\r\n|\r|\n/g, '\\N')

// ---------- video.ts ----------
const ts = Array.from({ length: 16 }, () => transcript(int(20, 160)))
for (let k = 0; k < 80; k++) {
  const t = pick(ts), ps = parts(t.duration, 12)
  const quiet: Quiet[] = Array.from({ length: int(0, 6) }, () => { const a = r2(rnd() * t.duration); return [a, r2(a + rnd() * 2)] })
  rec('tighten', { parts: ps, quiet }, (i) => V.tighten(i.parts, i.quiet))
  rec('fillerQuiet', { t, from: r2(rnd() * 20), to: r2(20 + rnd() * t.duration) }, (i) => V.fillerQuiet(i.t, i.from, i.to))
  const cuts = Array.from({ length: int(0, 12) }, () => r3(rnd() * t.duration))
  rec('snapToScenes', { parts: ps, cuts, t: rnd() < 0.2 ? null : t, max: pick([0.3, 0.1, 1]) }, (i) => V.snapToScenes(i.parts, i.cuts, i.t, i.max))
  const words = V.clipWords(t, ps, quiet)
  rec('clipWords', { t, parts: ps, quiet }, (i) => V.clipWords(i.t, i.parts, i.quiet))
  rec('cues', { words, mode: pick(['wort', 'satz']) }, (i) => V.cues(i.words, i.mode))
  rec('cutIndex', { parts: ps, i: int(0, ps.length) }, (i) => V.cutIndex(i.parts, i.i))
  const turns = Array.from({ length: int(0, 8) }, () => { const s = r2(rnd() * t.duration); return { start: s, end: r2(s + rnd() * 8), speaker: int(0, 3) } })
  const sx: [number, number][] = [[0, 0.3], [1, 0.7], ...(rnd() < 0.5 ? [[2, 0.5] as [number, number]] : [])]
  rec('followParts', { parts: ps.map((p) => (rnd() < 0.8 ? { ...p, focus: undefined } : p)), turns, sx, min: pick([2, 0.5, 5]) }, (i) => V.followParts(i.parts, i.turns, new Map(i.sx), i.min))
  rec('transcriptLines', { t }, (i) => V.transcriptLines(i.t))
}
for (let k = 0; k < 60; k++) {
  const size = { w: int(100, 4000), h: int(100, 4000) }, res = pick([undefined, '720p', '1080p', '1440p', '4k', '8k'])
  rec('outSize', { size, res }, (i) => V.outSize(i.size, i.res))
  const sources = Array.from({ length: int(0, 3) }, () => pick(SRCS))
  rec('videoSize', { size, res, sources }, (i) => V.videoSize(i.size, i.res, i.sources))
  const src = pick(SRCS), out = pick(SIZES), focus = r2(rnd())
  rec('cropRect', { src, out, focus }, (i) => V.cropRect(i.src, i.out, i.focus))
  const cam: [number, number, number, number] = [r2(rnd() * 0.8), r2(rnd() * 0.8), r2(0.1 + rnd() * 0.4), r2(0.1 + rnd() * 0.4)]
  rec('splitRects', { src, out, cam, focus }, (i) => V.splitRects(i.src, i.out, i.cam, i.focus))
  rec('joinOf', { t: pick(TRANS) ?? 'none', still: rnd() < 0.5 }, (i) => V.joinOf(i.t, i.still))
  rec('ovPos', { art: pick([...V.OVERLAY_ARTS, undefined]), pos: pick([...V.OVERLAY_POS, undefined]) }, (i) => V.ovPos(i))
}

// ---------- video-fx.ts ----------
for (let k = 0; k < 60; k++) {
  const size = pick(SIZES), c = { x: int(0, 400), y: int(0, 300), w: int(100, 1920), h: int(100, 1080) }
  rec('progressBar', { size, accent: '&H2E57E4&', off: r2(rnd() * 20), dur: r2(1 + rnd() * 20), total: r2(30 + rnd() * 30) }, (i) => FX.progressBar(i.size, i.accent, { off: i.off, dur: i.dur, total: i.total }, at))
  rec('hookBox', { style: `Style: Hook,Archivo,${int(20, 90)},&H00FFFFFF,&H00FFFFFF,&H40000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,2,7,86,86,230,1`, pad: int(5, 30) }, (i) => FX.hookBox(i.style, i.pad))
  rec('zoomCrop', { c, zoom: pick([1, 1.08, 1.2, 1.5, 0.9]) }, (i) => FX.zoomCrop(i.c, i.zoom))
  const keys = rnd() < 0.5 ? Array.from({ length: int(0, 4) }, (_, j) => [r2(j * 2 + rnd()), r2(rnd())]) : undefined
  rec('cropFilter', { c, size, zoom: pick([1, 1.08, 1.3]), track: keys && { src: pick(SRCS), keys, start: r2(rnd() * 3) } }, (i) => FX.cropFilter(i.c, i.size, i.zoom, i.track))
  rec('splitFilter', { r: V.splitRects(pick(SRCS), size, [0.1, 0.1, 0.3, 0.3], 0.4), size, k: pick(['', '0', '7']) }, (i) => FX.splitFilter(i.r, i.size, i.k))
  const spans = Array.from({ length: int(0, 5) }, () => { const a = r2(rnd() * 60); return [a, r2(a + rnd() * 10), pick([0, 0.3, 1, 0.25])] })
  rec('levelExpr', { base: pick([0.25, 0, 1, 0.5]), spans, ramp: pick([0.5, 0.2, 2]) }, (i) => FX.levelExpr(i.base, i.spans, i.ramp))
  rec('autoLook', { avg: r2(rnd() * 255), low: r2(rnd() * 100), high: r2(100 + rnd() * 155) }, (i) => FX.autoLook(i))
  const art = pick(FX.ART_KINDS)
  rec('artEvents', { size, accent: pick(['&H2E57E4&', '&HFFFFFF&']), art, text: pick([undefined, 'Anna', ' „Zitat“ ', 'Sehr langer Text, der mehrere Zeilen braucht und weiter geht']), sub: pick([undefined, ' ', 'Rolle']),
    items: art === 'liste' ? ['Eins', ' ', 'Zwei', 'Drei'].slice(0, int(0, 4)) : undefined, box: maybe(0.5, () => [r2(rnd() * 0.5), r2(rnd() * 0.5), r2(rnd() * 0.5), r2(rnd() * 0.5)]),
    el: maybe(0.3, () => r2(rnd() * 3)), len: maybe(0.3, () => r2(rnd() * 10)), al: int(1, 9), top: r2(rnd() * 200), low: r2(rnd() * 600), start: r2(rnd() * 5), end: r2(5 + rnd() * 10),
    fade: [rnd() < 0.5, rnd() < 0.5], fadeMs: 200 }, (i) => FX.artEvents(i, at, esc))
}
for (let k = 0; k < 50; k++) {
  const t = pick(ts), cs = V.cues(V.clipWords(t, parts(t.duration, 8), []), pick(['satz', 'wort']))
  rec('srt', { cs: rnd() < 0.1 ? [] : cs.map((c) => (rnd() < 0.1 ? { ...c, start: r3(c.start + 3600 * int(0, 2)) } : c)) }, (i) => FX.srt(i.cs))
}

// ---------- export-video.ts: reine Teile ----------
for (let k = 0; k < 40; k++) {
  const t = pick(ts), ps = parts(t.duration, 20)
  rec('padParts', { parts: ps, duration: t.duration, cuts: Array.from({ length: int(0, 8) }, () => r3(rnd() * t.duration)) }, (i) => E.padParts(i.parts, i.duration, i.cuts))
  rec('sfxGraph', { main: 'as', fx: Array.from({ length: int(0, 3) }, (_, j) => ({ input: 3 + j, at: r3(rnd() * 20 - 1), gain: maybe(0.5, () => int(-12, 6)) })), out: 'a' }, (i) => E.sfxGraph(i.main, i.fx, i.out))
  const vol = pick([undefined, 0.3, 2, -1, 'expr'])
  rec('duckMusic', { volume: vol === 'expr' ? `${FX.levelExpr(0.25, [[1, 3, 0.8]])}:eval=frame` : vol, dur: r2(rnd() * 60) }, (i) => E.duckMusic('0:a', '1:a', i.volume, i.dur, 'mx'))
  rec('presetFor', { s: pick([10, 600, 601, 3600]), big: rnd() < 0.5 }, (i) => E.presetFor(i.s, i.big))
  const words = V.clipWords(t, ps, [])
  const mode = pick(['wort', 'satz', 'aus'] as const)
  rec('assSubs', { o: { size: pick(SIZES), font: 'Archivo', bold: rnd() < 0.5, accent: pick(['#e4572e', '#0a3d62', '#fff', 'xyz']), hook: pick([undefined, ' ', 'Drei Dinge {heute}']), hookDur: r2(rnd() * 4),
    cues: mode === 'aus' ? [] : V.cues(words, mode), mode, style: pick([undefined, 'ruhig', 'lebendig']), bar: maybe(0.7, () => ({ off: r2(rnd() * 10), dur: r2(1 + rnd() * 10), total: 30 })),
    overlays: maybe(0.6, () => overlays(30).map((x) => ({ ...x, fade: maybe(0.5, () => [rnd() < 0.5, rnd() < 0.5]), el: maybe(0.3, () => r2(rnd())), len: maybe(0.3, () => r2(rnd() * 8)) }))),
    captionPos: pick([undefined, 'unten', 'mitte', 'oben']) } }, (i) => E.assSubs(i.o))
}

// ---------- export-video.ts: Exporte mit ffmpeg-Attrappe ----------
// relativer Job-Ordner (im TMP-Ordner), damit keine lokalen Pfade in die Fixture geraten
const ROOT = process.cwd()
process.chdir(TMP)
const DIR = 'job'
type Call = { args: string[]; cwd?: string; duration?: number }
const S = (globalThis as any).__dw = { probe: null as any, calls: [] as Call[], runs: [] as string[][], err: '', out: '', quiet: [] as { from: number; to: number; out: Quiet[] }[],
  run(args: string[]) { S.runs.push(args); return { code: 0, out: Buffer.from(S.out), err: S.err } },
  silences(from: number, to: number) { const out: Quiet[] = []; for (let j = int(0, 2); j > 0; j--) { const a = r3(from + rnd() * (to - from)); out.push([a, Math.min(to, r3(a + 0.6 + rnd() * 1.5))]) } out.sort((a, b) => a[0] - b[0]); S.quiet.push({ from, to, out }); return out } }
const reset = () => { rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true }); S.calls = []; S.runs = []; S.quiet = [] }
const files = () => Object.fromEntries(readdirSync(DIR).filter((f) => /\.(ass|txt)$/.test(f)).map((f) => [f, readFileSync(join(DIR, f), 'utf8')]))
const LOUD = (v: string[]) => `[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "${v[0]}",\n\t"input_tp" : "${v[1]}",\n\t"input_lra" : "${v[2]}",\n\t"input_thresh" : "${v[3]}",\n\t"output_i" : "-14.00",\n\t"normalization_type" : "dynamic",\n\t"target_offset" : "${v[4]}"\n}\n`
function job() {
  const D = int(30, 150), info = { duration: D, ...pick(SRCS), ...(rnd() < 0.7 ? { fps: pick([30, 29.97002997002997, 25, 60]) } : {}), audio: rnd() < 0.85 }
  const t = rnd() < 0.7 ? transcript(D) : null
  const j = { file: '/quelle/video.mp4', parts: parts(D, pick([5, 12, 45])), hook: pick([undefined, ' ', 'Drei Dinge, die keiner weiß']), captions: pick(['wort', 'satz', 'aus']), transcript: t,
    size: pick(SIZES), font: { name: 'Archivo', files: [], bold: rnd() < 0.7 }, accent: pick(['#e4572e', '#0a3d62']), pauses: pick([undefined, 'kurz', 'lassen']),
    fit: pick([undefined, 'crop', 'blur', 'split']), style: pick([undefined, 'ruhig', 'lebendig']), cuts: maybe(0.4, () => Array.from({ length: int(1, 10) }, () => r3(rnd() * D))),
    ton: pick([undefined, 'klar', 'original']), overlays: overlays(D), look: pick([undefined, 'neutral', 'warm', 'kuehl', 'kontrast', 'matt', 'sw']), stabil: rnd() < 0.1,
    captionPos: pick([undefined, 'unten', 'oben', 'mitte']), cam: maybe(0.5, () => [0.05, 0.05, 0.3, 0.3]), sfx: Array.from({ length: int(0, 2) }, () => ({ file: '/sfx/ding.wav', at: r2(rnd() * 40), gain: maybe(0.5, () => int(-6, 3)) })) }
  return { j, info }
}
for (let k = 0; k < 100; k++) {
  const { j, info } = job()
  const o = { preset: pick(['veryfast', 'superfast']), fadeIn: rnd() < 0.3, fadeOut: rnd() < 0.3, hevc: rnd() < 0.2 }
  await recA('clipSegs', { job: j, info, o, name: 'szene-01', dir: DIR }, async (i) => {
    reset(); S.probe = i.info
    const segs = await E.clipSegs(i.job, i.name, i.dir, i.o, () => {})
    return { segs, calls: S.calls, quiet: S.quiet, files: files() }
  })
  if (k % 3 === 0) await recA('cover', { job: j, info, t: maybe(0.6, () => r2(rnd() * info.duration * 1.2)), out: join(DIR, 'gesamt.jpg'), dir: DIR }, async (i) => {
    reset(); S.probe = i.info
    if (!i.job.parts.length) return null
    await E.encodeCover(i.job, i.t, i.out, i.dir)
    return { calls: S.calls, files: files() }
  })
}
for (let k = 0; k < 40; k++) {
  const segs = Array.from({ length: int(1, 4) }, (_, j) => ({ file: join(DIR, `szene-${n2(j + 1)}.mkv`), dur: r3(1 + rnd() * 30), ...(rnd() < 0.4 ? { music: [[r2(rnd() * 2), r2(2 + rnd() * 5), pick([0, 0.5, 1, 2])]] } : {}) }))
  const music = maybe(0.6, () => ({ file: '/musik/lied.mp3', ...(rnd() < 0.5 ? { volume: pick([0.1, 0.25, 1.5]) } : {}), ...(rnd() < 0.6 ? { gain: pick([0.5, 1, 2.5, 4]) } : {}) }))
  const err = pick([LOUD(['-23.45', '-3.10', '5.20', '-33.90', '0.01']), LOUD(['-inf', '-inf', '0.00', '-70.00', '0.00']), 'kaputt', LOUD(['-19', '-1.5', '11', '-29.123', '-0.25'])])
  const o = { loudnorm: rnd() < 0.7, music, hevc: rnd() < 0.3 }
  await recA('finish', { segs, out: join(DIR, 'gesamt.mp4'), o, err, dir: DIR }, async (i) => {
    reset(); S.err = i.err
    await E.finish(i.segs, i.out, i.dir, { ...i.o, onProgress: () => {} })
    return { calls: S.calls, runs: S.runs, files: files() }
  })
  const seg = () => ({ file: join(DIR, `s${int(1, 9)}.mkv`), dur: r3(0.2 + rnd() * 20), ...(rnd() < 0.5 ? { music: [[1, 2, 0.5]] } : {}), ...(rnd() < 0.5 ? { cues: [{ start: 0.5, end: 1.5, words: [{ w: 'Hallo', start: 0.5, end: 1.5 }] }] } : {}),
    ...(rnd() < 0.3 ? { xml: [{ at: 0, src: '/quelle/video.mp4', info: { duration: 10, w: 1920, h: 1080, audio: true }, parts: [{ start: 0, end: 4 }] }] } : {}) })
  await recA('joinSegs', { a: seg(), b: seg(), t: pick(['fade', 'slideleft', 'circleopen']), out: join(DIR, 'x.mkv'), preset: 'veryfast', hevc: rnd() < 0.3, dir: DIR }, async (i) => {
    reset()
    const s = await E.joinSegs(i.a, i.b, i.t, i.out, i.dir, i.preset, undefined, i.hevc)
    return { seg: s, calls: S.calls }
  })
  await recA('still', { png: join(DIR, 'folie.png'), out: join(DIR, 'f.mkv'), o: { preset: 'veryfast', fadeIn: rnd() < 0.5, fadeOut: rnd() < 0.5, hevc: rnd() < 0.3 }, dir: DIR }, async (i) => {
    reset()
    const s = await E.encodeStill(i.png, i.out, i.dir, i.o)
    return { seg: s, calls: S.calls }
  })
}

// ---------- film ----------
const TEXTS = ['', 'Hallo Welt. Das ist gut.', 'Erst das.[klick]Dann das! Und z. B. Kunden mit 3. Platz.', '[klick][klick]Zwei leere.', 'Was? „Zitat“ folgt. 1. Mai ist frei. Prof. Meier kommt.', 'Lange   Leerzeichen\nund Zeilen.  [KLICK] Danach (in Klammern) weiter… Ende.']
for (let k = 0; k < 40; k++) {
  const text = pick(TEXTS) + (rnd() < 0.5 ? ` ${pick(VOCAB)} ${pick(VOCAB)}.` : '')
  rec('voiceChunks', { text }, (i) => FI.voiceChunks(i.text))
  rec('estimateVoice', { text, speed: pick([1, 0.8, 1.3]) }, (i) => FI.estimateVoice(i.text, i.speed))
  const chunks = FI.voiceChunks(text)
  rec('voiceTiming', { chunks, durs: chunks.map((b) => b.map(() => (rnd() < 0.8 ? r2(rnd() * 4) : undefined))).map((b) => b.map((x) => x ?? 0.05)) }, (i) => FI.voiceTiming(i.chunks, i.durs))
  const scene = { steps: Array.from({ length: int(0, 4) }, () => r2(rnd() * 2)), words: int(0, 40), endless: maybe(0.3, () => true), media: maybe(0.3, () => r2(rnd() * 20)) }
  const voice = maybe(0.6, () => FI.estimateVoice(text))
  const duration = maybe(0.4, () => r2(rnd() * 15))
  rec('sceneTimeline', { o: { ...scene, voice, duration, lead: pick([0, 0.5]) } }, (i) => FI.sceneTimeline(i.o))
  const tr = pick(['fade', 'none', 'morph', 'push'])
  const deck = { slides: [{ layout: 'title', content: {} }, { layout: 'title', content: {}, transition: tr, duration }] }
  rec('planScene', { scene: { ...scene, voice, duration }, blend: tr !== 'none' }, (i) => planScene(deck as any, 1, i.scene, i.scene.voice))
  const zooms = Array.from({ length: int(0, 4) }, () => { const s = r2(rnd() * 20); return { start: s, end: r2(s + rnd() * 4), x: r2(rnd()), y: r2(rnd()), ...(rnd() < 0.5 ? { scale: pick([1, 1.5, 2, 4]) } : {}) } })
  for (let j = 0; j < 4; j++) rec('zoomAt', { zooms, t: r2(rnd() * 25) }, (i) => FI.zoomAt(i.zooms, i.t))
}

// ---------- grade ----------
for (let k = 0; k < 50; k++) {
  const v = () => [r3(rnd() * 3 - 1), r3(rnd() * 3 - 1), r3(rnd() * 3 - 1)]
  const g = k < 6 ? G.GRADE_PRESETS[Object.keys(G.GRADE_PRESETS)[k]] : { ...(rnd() < 0.6 ? { lift: v() } : {}), ...(rnd() < 0.6 ? { gamma: v().map((x) => x + 1) } : {}), ...(rnd() < 0.6 ? { gain: v().map((x) => x + 1) } : {}), ...(rnd() < 0.6 ? { sat: r2(rnd() * 3) } : {}), ...(rnd() < 0.6 ? { temp: r2(rnd() * 3 - 1.5) } : {}) }
  rec('grade', { g }, (i) => ({ neutral: G.isNeutral(i.g), tables: G.gradeTables(i.g).map((t) => Array.from(t)), sat: G.satMatrix(i.g.sat), filter: G.satFilter(i.g.sat), cube: G.cube1d(i.g), svg: G.svgTables(i.g) }))
  const px = Array.from({ length: 32 }, () => int(0, 255))
  rec('applyTables', { g, px }, (i) => { const d = Uint8ClampedArray.from(i.px); G.applyTables(d, G.gradeTables(i.g), i.g.sat); return Array.from(d) })
}

// ---------- xmeml ----------
for (let k = 0; k < 50; k++) {
  const scenes = Array.from({ length: int(1, 3) }, (_, j) => {
    const { j: jb, info } = job()
    const src = pick(['/quelle/video.mp4', '/quelle/zwei & drei.mov', '/q/Ü 100%#?.mp4', `/q/v${j}.mp4`])
    return { at: r3(j * 20 + rnd() * 5), src, info, parts: jb.parts, marks: X.clipMarks(jb.hook, jb.overlays, jb.parts) }
  })
  rec('clipMarks', { hook: pick([undefined, ' ', 'Hook']), overlays: overlays(100), parts: parts(100, 10) }, (i) => X.clipMarks(i.hook, i.overlays, i.parts))
  rec('xmeml', { o: { name: pick(['clip-01', 'A & <B>']), size: pick(SIZES), duration: r2(10 + rnd() * 100), scenes } }, (i) => X.xmeml(i.o))
}

// ---------- music ----------
for (let k = 0; k < 60; k++) {
  const h = { id: `id${k}abcdef`, title: pick([undefined, '', 'Lied']), creator: pick([undefined, 'Band']), url: pick([undefined, 'https://cdn.x/a.mp3', 'http://x/a.mp3', 'https://x/track?id=1', 'https://x/a.FLAC#frag', 'https://x/a.toolong', 'nix', 'https://x/a.mp3/']),
    filetype: pick([undefined, '', 'mp32', 'MP3', 'wav', 'exe', 'mp3x']), duration: pick([undefined, null, 0, 12000, 30000, 200000]), license: pick(['cc0', 'by', 'by-nc', 'pdm']), foreign_landing_url: pick([undefined, 'https://jamendo/1']),
    tags: pick([undefined, null, [{ name: 'a' }, { name: 'b' }], Array.from({ length: 10 }, (_, j) => ({ name: `t${j}` }))]) }
  rec('music', { h }, (i) => ({ ext: M.extOf(i.h), usable: M.usable(i.h), kurz: M.usable(i.h, true), track: trackOf(i.h) }))
}
function trackOf(h: any) { // music.ts exportiert track nicht: über fetchMusic nicht erreichbar, gleiche Formel
  return { id: h.id, title: h.title || 'Ohne Titel', artist: h.creator || 'unbekannt', duration: Math.round((h.duration ?? 0) / 1000), license: h.license, tags: (h.tags ?? []).map((t: any) => t.name).slice(0, 8), url: h.foreign_landing_url ?? `https://openverse.org/audio/${h.id}` }
}

// ---------- video-cache ----------
for (let k = 0; k < 25; k++) {
  const D = r2(rnd() * 4000)
  rec('engineFor', { lang: pick([undefined, '', 'de', 'EN-us', 'fr', 'ja_JP']), langs: ['de', 'en', 'fr'], only: rnd() < 0.5 }, (i) => C.engineFor(i.lang, i.langs, i.only) ?? null)
  rec('chunkWindow', { k: int(0, 14), duration: D }, (i) => C.chunkWindow(i.k, i.duration))
  rec('chunksIn', { ranges: Array.from({ length: int(0, 3) }, () => { const a = r2(rnd() * D); return [a, r2(a + rnd() * 900)] }), duration: D, size: pick([300, 60]), back: pick([30, 0]) }, (i) => C.chunksIn(i.ranges, i.duration, i.size, i.back))
  const segs = transcript(int(20, 150)).segments.flatMap((s) => (rnd() < 0.2 ? [s, { ...s, start: r2(s.start + 0.3), end: r2(s.end + 0.2) }] : [s]))
  rec('inChunk', { segs, k: int(0, 3) }, (i) => C.inChunk(i.segs, i.k))
  rec('mergeSegments', { segs }, (i) => C.mergeSegments(i.segs))
  rec('coveredOf', { ks: Array.from({ length: int(0, 5) }, () => int(0, 10)), duration: D }, (i) => C.coveredOf(i.ks, i.duration))
  const turns = Array.from({ length: int(0, 10) }, () => { const s = r2(rnd() * 200); return { start: s, end: r2(s + rnd() * 20), speaker: int(0, 3) } })
  rec('withSpeakers', { segs: segs.slice(0, 30), turns }, (i) => C.withSpeakers(i.segs, i.turns))
  rec('chatPerSecond', { chat: [{ t: 1.5, w: 2 }, { t: -1, w: 1 }, { t: 'x', w: 1 }, null, { t: 3, w: '1' }, { t: 9.99, w: 0.5 }, { t: int(0, 20), w: int(0, 5) }], n: 10 }, (i) => C.chatPerSecond(i.chat, i.n))
  rec('loudRanges', { loud: Array.from({ length: int(0, 80) }, () => (rnd() < 0.1 ? -10 : r2(-30 + rnd() * 5))) }, (i) => C.loudRanges(i.loud))
}

rmSync(DIR, { recursive: true, force: true })
process.chdir(ROOT)
const path = 'crates/dw-video/tests/fixtures/video.json'
const json = JSON.stringify({ transcripts: [...pool.keys()].map((k) => JSON.parse(k)), ...fx })
writeFileSync(path, json + '\n')
console.log(`${path}: ${(json.length / 1e6).toFixed(2)} MB, ${Object.entries(fx).map(([k, v]) => `${k} ${v.length}`).join(', ')}`)
