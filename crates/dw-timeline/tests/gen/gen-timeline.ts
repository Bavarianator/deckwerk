// npx esbuild crates/dw-timeline/tests/gen/gen-timeline.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/gen-timeline.mjs && node ${TMPDIR:-/tmp}/gen-timeline.mjs
// Fixtures für den Differenztest Rust ↔ TS (tests/timeline_diff.rs): Zufallsfälle mit festem Seed über Timeline, Bearbeitung, Lint, Farbe,
// Abschnitte und ffmpeg-Argumente, Umwandlung aus Clip-Folien, xmeml und Schema. Eingaben auf 15 Stellen gerundet, Zahlen im Ergebnis als String(x).
import { writeFileSync } from 'node:fs'
import { activeAt, cutPoints, fpsArg, xfades, type Grade, type TLClip, type TLTrack, type TimelineContent } from '../../../../src/shared/timeline'
import { applyOps, lintTimeline, snap, snapTargets, type TLOp } from '../../../../src/shared/timeline-edit'
import { fromClips } from '../../../../src/shared/timeline-from-clips'
import { timelineSchema } from '../../../../src/shared/layouts-timeline'
import { cube1d, isNeutral, satFilter } from '../../../../src/shared/grade'
import { audioArgs, encodeArgs, estimate, keyExpr, sections, size, videoArgs } from '../../../../src/main/timeline-ffmpeg'
import { xmemlTimeline } from '../../../../src/main/export-xmeml-tl'
import type { ClipContent } from '../../../../src/shared/video'

type Case = Record<string, unknown> & { name: string; expected: unknown }
const fx: Record<string, Case[]> = { edit: [], lint: [], snap: [], sections: [], args: [], keyExpr: [], encode: [], estimate: [], grade: [], fromClips: [], xmeml: [], validate: [], misc: [] }
const p15 = <T>(x: T): T => (typeof x === 'number' ? (+x.toPrecision(15) as T) : Array.isArray(x) ? (x.map(p15) as T) : x && typeof x === 'object' ? (Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined).map(([k, v]) => [k, p15(v)])) as T) : x)
const enc = (x: unknown): unknown => (typeof x === 'number' ? String(x) : Array.isArray(x) ? x.map(enc) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined).map(([k, v]) => [k, enc(v)])) : x)
const rec = (kind: string, input: Record<string, unknown>, run: (i: any) => unknown) => {
  const i = p15(input)
  let expected: unknown
  try { expected = { ok: enc(run(structuredClone(i))) } } catch (e) { expected = { err: (e as Error).message } }
  fx[kind].push({ name: `${kind} ${fx[kind].length}`, ...i, expected })
}

let seed = 20261018
const rnd = () => { // mulberry32
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1))
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
const maybe = <T>(p: number, f: () => T): T | undefined => (rnd() < p ? f() : undefined)
const r3 = (x: number) => Math.round(x * 1000) / 1000
// Zeiten mal auf dem Bildraster, mal krumm
const tm = (x: number) => (rnd() < 0.6 ? Math.round(x * 30) / 30 : r3(x))
const VSRC = ['/m/a.mp4', '/m/b.mov', '/m/Mein Film ä#1.mp4', '/m/logo.png']
const ASRC = ['/m/musik.wav', '/m/sprecher.m4a', '/m/a.mp4']
const rgb = (lo: number, hi: number): [number, number, number] => [0, 1, 2].map(() => r3(lo + rnd() * (hi - lo))) as [number, number, number]
const grade = (): Grade => p15({ lift: maybe(0.5, () => rgb(-0.5, 0.5)), gamma: maybe(0.4, () => rgb(0.5, 2)), gain: maybe(0.4, () => rgb(0.5, 2)), sat: maybe(0.5, () => pick([0, 0.5, 1, 1.3, 2, r3(rnd() * 2)])), temp: maybe(0.4, () => r3(rnd() * 2 - 1)) })

let nid = 0
function clip(kind: 'video' | 'audio', at: number): TLClip {
  const inn = tm(rnd() < 0.3 ? 0 : rnd() * 20), len = tm(0.05 + rnd() * 6)
  const c: TLClip = { id: `c${++nid}`, src: pick(kind === 'video' ? VSRC : ASRC), at, in: inn, out: r3(inn + len) }
  if (rnd() < 0.3) c.speed = pick([0.25, 0.5, 1, 1.5, 2, 3, 4, 0.3])
  if (rnd() < 0.3) c.volume = pick([0, 0.5, 1, 1.5, 2, r3(rnd() * 2)])
  if (rnd() < 0.25) c.keys = Array.from({ length: int(1, 4) }, () => [tm(inn + rnd() * len * 1.2 - 0.2 * len), pick([-60, -12, -6, 0, 6, 12, r3(rnd() * 72 - 60)])] as [number, number]).map(([s, d]) => [Math.max(0, s), d])
  if (rnd() < 0.2) c.eq = { low: maybe(0.6, () => pick([-12, -3, 0, 4, 12])), mid: maybe(0.6, () => pick([-6, 0, 2.5])), high: maybe(0.6, () => pick([0, 3, -12])) }
  if (rnd() < 0.3) c.grade = grade()
  if (rnd() < 0.15) c.mute = true
  if (rnd() < 0.3) c.fit = pick(['crop', 'contain'])
  if (rnd() < 0.2) c.focus = r3(rnd())
  if (kind === 'video' && rnd() < 0.2) c.box = [r3(rnd() * 0.6), r3(rnd() * 0.6), r3(0.05 + rnd() * 0.5)]
  if (rnd() < 0.3) c.fade = [pick([0, 0, 0.5, 1, r3(rnd() * 3)]), pick([0, 0.5, 2, r3(rnd() * 3)])]
  if (rnd() < 0.35) c.xfade = pick([0.5, 1, 2, r3(rnd() * 5), 0])
  return c
}
function timeline(): TimelineContent {
  nid = 0
  const tracks: TLTrack[] = []
  const nv = int(rnd() < 0.1 ? 0 : 1, 3), na = int(0, 2)
  for (let k = 0; k < nv + na; k++) {
    const kind = k < nv ? 'video' : 'audio'
    const clips: TLClip[] = []
    let t = tm(rnd() < 0.5 ? 0 : rnd() * 3)
    for (let j = int(0, 5); j > 0; j--) {
      const c = clip(kind, t)
      clips.push(c)
      const end = c.at + Math.max(0, c.out - c.in) / Math.min(4, Math.max(0.25, c.speed ?? 1))
      // anschließend (für Überblendungen), mit Lücke oder überlappend
      t = pick([end, end, end, tm(end + rnd() * 2), tm(end - rnd())])
      t = Math.max(0, t)
    }
    if (rnd() < 0.15) clips.reverse()
    const tr: TLTrack = { id: kind === 'video' ? `v${k + 1}` : `a${k + 1}`, kind, clips }
    if (rnd() < 0.15) tr.mute = true
    if (rnd() < 0.15) tr.hide = true
    if (rnd() < 0.2) tr.volume = pick([0, 0.5, 1.5, 2])
    tracks.push(tr)
  }
  const tl: TimelineContent = { tracks }
  if (rnd() < 0.3) tl.markers = Array.from({ length: int(1, 3) }, (_, i) => ({ t: tm(rnd() * 10), name: pick(['Start', 'A & B', `M${i}`, '<Ende>']) }))
  if (rnd() < 0.4) tl.deliver = p15({ res: maybe(0.7, () => pick([720, 1080, 1440, 2160] as const)), fps: maybe(0.7, () => pick([23.976, 24, 25, 29.97, 30, 50, 59.94, 60])), codec: maybe(0.7, () => pick(['h264', 'h264-10', 'prores', 'dnxhr'] as const)), lufs: maybe(0.5, () => pick([-14, -16, -23])) })
  if (rnd() < 0.3) tl.subs = Array.from({ length: int(1, 3) }, (_, i) => ({ start: tm(i * 2), end: tm(i * 2 + 0.5 + rnd() * 2), text: pick(['Hallo Welt', ' Zwei & drei ', 'Ende <gut>']) }))
  if (rnd() < 0.2) tl.captions = pick(['wort', 'satz', 'aus'])
  if (rnd() < 0.2) tl.overlays = [{ start: tm(rnd() * 3), end: tm(3 + rnd() * 3), text: 'Titel', art: pick(['titel', 'text', 'bauchbinde']) }]
  return p15(tl)
}
const allClips = (tl: TimelineContent) => tl.tracks.flatMap((t) => t.clips)
function op(tl: TimelineContent): TLOp {
  const cs = allClips(tl), c = cs.length ? pick(cs) : undefined, id = c?.id ?? 'x9'
  const t = c ? tm(c.at + (rnd() * 1.4 - 0.2) * Math.max(0.1, (c.out - c.in))) : tm(rnd() * 5)
  switch (pick(['split', 'split', 'trim', 'trim', 'move', 'lift', 'ripple_delete', 'add_clip', 'add_track', 'set', 'set'] as const)) {
    case 'split': return { op: 'split', clip: id, t }
    case 'trim': return { op: 'trim', clip: id, edge: pick(['in', 'out']), t, ripple: maybe(0.5, () => rnd() < 0.6) }
    case 'move': return { op: 'move', clip: id, at: pick([t, tm(rnd() * 20), -1, 0]), track: maybe(0.4, () => pick(tl.tracks)?.id ?? 'v9') }
    case 'lift': return { op: 'lift', clip: id }
    case 'ripple_delete': return { op: 'ripple_delete', clip: id }
    case 'add_clip': {
      const tr = pick(tl.tracks), { id: _, ...rest } = clip(tr?.kind ?? 'video', tm(rnd() * 15))
      return { op: 'add_clip', track: tr?.id ?? 'v1', clip: { ...rest, ...(rnd() < 0.5 ? { id: pick(['neu', id, 'v1', '']) } : {}) } }
    }
    case 'add_track': return { op: 'add_track', kind: pick(['video', 'audio']) }
    default: {
      const patch: Record<string, unknown> = {}
      if (rnd() < 0.4) patch.at = pick([tm(rnd() * 10), -0.5])
      if (rnd() < 0.3) patch.out = c ? tm(c.in + rnd() * 5 - 0.5) : 3
      if (rnd() < 0.3) patch.in = tm(rnd() * 5)
      if (rnd() < 0.3) patch.volume = 0.5
      if (rnd() < 0.3) patch.speed = pick([0.5, 2])
      if (rnd() < 0.3) patch.fade = [0.5, 0.5]
      if (rnd() < 0.2) patch.id = 'umbenannt'
      return { op: 'set', clip: id, patch: patch as TLOp extends { patch: infer P } ? P : never }
    }
  }
}

const N = Number(process.env.DW_TL_CASES ?? 150)
for (let k = 0; k < N; k++) {
  const tl = timeline(), fps = pick([30, 25, 24, 60, 29.97])
  // Bearbeitung: Folge von Ops; Zwischenstände zählen nicht, nur Ergebnis oder Fehler
  let cur = tl
  const ops: TLOp[] = []
  for (let j = int(1, 4); j > 0; j--) ops.push(p15(op(cur)))
  rec('edit', { tl, ops, fps }, (i) => applyOps(i.tl, i.ops, i.fps))
  // Einzelschritte, damit Fehler mitten in der Folge nicht alles verdecken
  for (const o of ops) {
    rec('edit', { tl: cur, ops: [o], fps }, (i) => applyOps(i.tl, i.ops, i.fps))
    try { cur = applyOps(cur, [o], fps) } catch { /* weiter mit cur */ }
  }
  rec('lint', { tl, fps }, (i) => lintTimeline(i.tl, i.fps))
  rec('snap', { tl, except: maybe(0.5, () => allClips(tl)[0]?.id), extra: [tm(rnd() * 5)], t: tm(rnd() * 10), tol: pick([0.1, 0.5, 2]) }, (i) => {
    const ts = snapTargets(i.tl, i.except, i.extra)
    return { ts, s: snap(i.t, ts, i.tol) }
  })
  rec('validate', { tl }, (i) => timelineSchema.safeParse(i.tl).success)
  rec('misc', { tl, t: tm(rnd() * 8) }, (i) => ({
    cuts: cutPoints(i.tl),
    active: activeAt(i.tl, i.t).map((a) => [a.index, a.clip.id, a.src]),
    activeV: activeAt(i.tl, i.t, 'video').map((a) => a.index),
    xf: i.tl.tracks.map((t: TLTrack) => xfades(t).map((x) => [x.from.id, x.to.id, x.a, x.b])),
  }))
  if (!allClips(tl).length) continue
  // Abschnitte, Argumente, xmeml: hide nur zusammen mit mute (K17 nimmt in Rust auch den Ton der ausgeblendeten Spur, eigener Test)
  const xt = { ...tl, tracks: tl.tracks.map((t) => (t.hide ? { ...t, mute: true } : t)) }
  const sf = maybe(0.5, () => pick([25, 30, 60]))
  rec('sections', { tl: xt, fps: sf }, (i) => sections(i.tl, i.fps).map((s) => ({ start: s.start, end: s.end, video: s.video.map((a) => [a.index, a.clip.id, a.src]), audio: s.audio.map((a) => [a.index, a.clip.id, a.src]) })))
  const deliver = p15({ res: pick([720, 1080]), fps: pick([30, 25, 29.97, 60]), codec: pick(['h264', 'h264-10', 'prores', 'dnxhr'] as const), lufs: -14 })
  const aspect = pick([16 / 9, 9 / 16, 1, 4 / 5])
  if (k % 2 === 0) rec('args', { tl: xt, deliver, aspect }, (i) => sections(i.tl).map((s) => ({
    video: videoArgs(s, i.deliver, i.aspect, (c) => (c.grade && !isNeutral(c.grade) ? `/w/grade:${c.id}'.cube` : null), satFilter),
    audio: audioArgs(s),
  })))
  // estimate nur, wo TS dieselbe fps nimmt wie die Ausgabe (K15 prüft ein eigener Test)
  rec('estimate', { tl: { ...tl, deliver }, deliver }, (i) => estimate(i.tl, i.deliver))
  for (const c of allClips(tl).filter((c) => c.keys?.length).slice(0, 2)) rec('keyExpr', { keys: c.keys, clip: c, offset: tm(c.at + rnd()) }, (i) => keyExpr(i.keys, i.clip, i.offset))
  const info = Object.fromEntries([...VSRC, ...ASRC].map((s) => [s, rnd() < 0.15 ? undefined : p15({ duration: r3(20 + rnd() * 60), w: /\.(wav|m4a)$/.test(s) ? 0 : pick([1920, 3840, 1080]), h: /\.(wav|m4a)$/.test(s) ? 0 : pick([1080, 2160, 1920]), fps: maybe(0.7, () => pick([25, 29.97, 30, 59.94])) })]).filter(([, v]) => v))
  if (k % 3 === 0) rec('xmeml', { tl: xt, opts: { name: pick(['Schnitt', 'A & B <1>']), fps: deliver.fps, w: 1920, h: 1080, info } }, (i) => xmemlTimeline(i.tl, i.opts))
}
for (let k = 0; k < 30; k++) {
  const g = rnd() < 0.1 ? undefined : grade()
  rec('grade', { g }, (i) => ({ neutral: isNeutral(i.g), sat: satFilter(i.g?.sat), cube: cube1d(i.g) }))
}
for (const d of [{ res: 1080, fps: 30, codec: 'h264' }, { res: 720, fps: 29.97, codec: 'h264-10' }, { res: 2160, fps: 23.976, codec: 'prores' }, { res: 1440, fps: 59.94, codec: 'dnxhr' }, { res: 1080, fps: 25.0004, codec: 'h264' }] as const) {
  for (const aspect of [16 / 9, 9 / 16, 1, 4 / 5, 1.91]) rec('encode', { d: { ...d, lufs: -14 }, aspect }, (i) => ({ enc: encodeArgs(i.d), size: size(i.d, i.aspect), fps: fpsArg(i.d.fps) }))
}
// Clip-Folien → Timeline
for (let k = 0; k < 80; k++) {
  const slides: ClipContent[] = Array.from({ length: int(1, 3) }, () => {
    const parts = Array.from({ length: int(1, 4) }, () => {
      const s = tm(rnd() * 100)
      return p15({ start: s, end: r3(s + 0.5 + rnd() * 10), speed: maybe(0.3, () => pick([0.5, 1, 2])), volume: maybe(0.2, () => 0.5), focus: maybe(0.2, () => 0.3), freeze: maybe(0.1, () => 1), zoom: maybe(0.1, () => pick([1, 1.2])), transition: maybe(0.1, () => 'blende'), music: maybe(0.1, () => 0.2), track: maybe(0.05, () => [[0, 0.5]] as [number, number][]) })
    })
    const ov = Array.from({ length: int(0, 3) }, () => { const s = parts[0].start + rnd() * 8; return p15({ start: s, end: r3(s + rnd() * 6), text: 'Text', art: pick(['text', 'titel']), image: maybe(0.2, () => '/m/x.png'), slide: maybe(0.1, () => pick([0, 2])) }) })
    return p15({ video: pick(['/m/a.mp4', '/m/b.mp4']), parts, overlays: ov.length ? ov : undefined, look: maybe(0.5, () => pick(['auto', 'neutral', 'warm', 'sw', 'kontrast', 'kino'])), hook: maybe(0.2, () => pick(['', 'Hook'])), pauses: maybe(0.2, () => 'kurz'), ton: maybe(0.2, () => pick(['klar', 'original'])), fit: maybe(0.3, () => pick(['blur', 'crop', 'split'])), captions: maybe(0.3, () => pick(['wort', 'satz', 'aus'])), stabil: maybe(0.1, () => true), cover: maybe(0.1, () => 2) } as ClipContent)
  })
  rec('fromClips', { slides, fps: pick([30, 25, 60]) }, (i) => fromClips(i.slides, i.fps))
}

const path = 'crates/dw-timeline/tests/fixtures/timeline.json' // aus dem Repo-Wurzelverzeichnis aufrufen
const json = JSON.stringify(fx)
writeFileSync(path, json + '\n')
console.log(`${path}: ${(json.length / 1e6).toFixed(2)} MB, ${Object.entries(fx).map(([k, v]) => `${k} ${v.length}`).join(', ')}`)
