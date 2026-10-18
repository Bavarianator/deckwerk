// npx esbuild crates/dw-podcast/tests/gen/gen-podcast.ts --bundle --platform=node --format=esm --loader:.md=text --external:./render --external:./export-pptx --external:electron --outfile=${TMPDIR:-/tmp}/gen-podcast.mjs && node ${TMPDIR:-/tmp}/gen-podcast.mjs
// Fixtures für den Differenztest Rust ↔ TS (tests/podcast_diff.rs): Zufallsfälle mit festem Seed über Schnitte, Zeitachsen, autoCuts,
// Lint, deckToEpisode, Zusammenfassung, Schema und den Export-Graphen. Eingaben auf 15 Stellen gerundet, Zahlen im Ergebnis als String(x).
import { writeFileSync } from 'node:fs'
import { autoCuts, deckToEpisode, editedLength, episodeSchema, episodeSummary, inCut, isFiller, keepRanges, lintEpisode, mergeTracks, normCuts, snapCut, toEdited, toSource, type Cut, type Episode } from '../../../../src/shared/podcast'
import { buildGraph } from '../../../../src/main/podcast'
import type { Transcript } from '../../../../src/shared/video'

type Case = Record<string, unknown> & { name: string; expected: unknown }
const fx: Record<string, Case[]> = { cuts: [], snapCut: [], filler: [], merge: [], auto: [], lint: [], deck: [], summary: [], graph: [], validate: [] }
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
const WORDS = [' Hallo', ' äh', ' ähm', ' Welt', ' um', ' ich', ' Ich', ' gehe', ' heute', ' nach', ' Hause.', ' Ähm...', ' hm', ' und', ' dann', ' so', ' weiter,', ' das', ' ist', ' gut!']

function transcript(dur: number, speakers: number): Transcript {
  const segments: Transcript['segments'] = []
  for (let s = 0; s < speakers; s++) {
    let t = r3(rnd() * 3)
    while (t < dur - 1) {
      const words = []
      const n = int(1, 12)
      const start = t
      for (let k = 0; k < n && t < dur; k++) {
        const len = r3(0.1 + rnd() * 0.5)
        words.push({ w: pick(WORDS), start: t, end: r3(t + len) })
        t = r3(t + len + (rnd() < 0.15 ? rnd() * 4 : rnd() * 0.2))
      }
      if (!words.length) break
      segments.push({ start, end: words[words.length - 1].end, text: words.map((w) => w.w).join(''), speaker: speakers > 1 && rnd() < 0.8 ? s : undefined, words: rnd() < 0.1 ? undefined : words })
      t = r3(t + rnd() * 5)
    }
  }
  return p15({ duration: dur, lang: pick(['de', 'de', 'en', 'en-US']), segments })
}
const cutsOf = (dur: number): Cut[] => Array.from({ length: int(0, 8) }, () => { const a = r3(rnd() * dur * 1.1 - dur * 0.05); return { start: a, end: r3(a + rnd() * dur * 0.2), why: maybe(0.7, () => pick(['pause', 'fuell', 'versprecher', 'hand'] as const)) } })
function episode(dur: number): Episode {
  return p15({
    duration: dur,
    tracks: Array.from({ length: int(1, 3) }, (_, k) => ({ src: `/p/spur${k}.wav`, name: maybe(0.3, () => `Mik ${k}`), gain: maybe(0.4, () => pick([-6, 0, 3, 12])), mute: maybe(0.15, () => true) })),
    cuts: cutsOf(dur),
    sfx: maybe(0.4, () => Array.from({ length: int(1, 4) }, () => ({ src: '/p/plopp.wav', at: r3(rnd() * dur), gain: maybe(0.5, () => -6) }))),
    intro: maybe(0.3, () => '/p/intro.mp3'), outro: maybe(0.3, () => '/p/outro.mp3'),
    chapters: maybe(0.5, () => Array.from({ length: int(1, 4) }, (_, i) => ({ at: r3(rnd() * dur), title: pick(['Start', 'Teil = 2', `K${i}`, 'Ende; #1']) }))),
    ton: maybe(0.6, () => pick(['original', 'klar', 'stark'] as const)),
  })
}

for (let k = 0; k < 150; k++) {
  const dur = pick([10, 30, 60, 120, 600])
  const cuts = cutsOf(dur)
  rec('cuts', { cuts, duration: dur, ts: Array.from({ length: 6 }, () => r3(rnd() * dur * 1.2 - 1)) }, (i) => ({
    norm: normCuts(i.cuts, i.duration), keep: keepRanges(i.cuts, i.duration), len: editedLength(i.cuts, i.duration),
    edited: i.ts.map((t: number) => toEdited(t, i.cuts, i.duration)), source: i.ts.map((t: number) => toSource(t, i.cuts, i.duration)), inCut: i.ts.map((t: number) => inCut(t, normCuts(i.cuts, i.duration))),
  }))
  const t = transcript(Math.min(dur, 120), int(1, 3))
  const ws = t.segments.flatMap((s) => s.words ?? []).slice(0, 30)
  rec('snapCut', { c: cuts[0] ?? { start: 1, end: 2 }, words: ws.map(({ start, end }) => ({ start, end })) }, (i) => snapCut(i.c, i.words))
  const ep = episode(dur)
  const quiet = Array.from({ length: int(0, 8) }, () => { const a = r3(rnd() * dur); return [a, r3(a + rnd() * 6)] })
  const o = { pauses: maybe(0.7, () => pick([0, 0.3, 0.6, 1, 2])), fillers: maybe(0.7, () => rnd() < 0.8), retakes: maybe(0.6, () => rnd() < 0.8) }
  rec('auto', { ep, t: rnd() < 0.15 ? null : t, quiet, o }, (i) => autoCuts(i.ep, i.t, i.quiet, i.o))
  rec('lint', { ep: { ...ep, duration: Math.max(dur, t.duration) }, t: rnd() < 0.15 ? null : t }, (i) => lintEpisode(i.ep, i.t))
  rec('summary', { ep: { ...ep, duration: pick([dur, 3700, 2530.4]) } }, (i) => episodeSummary(i.ep))
  rec('merge', { ts: Array.from({ length: int(1, 3) }, () => (rnd() < 0.25 ? null : transcript(int(5, 30), 1))) }, (i) => mergeTracks(i.ts))
  const go = { music: maybe(0.4, () => ({ volume: pick([0.25, 0.5, 1.5, -1]) })), introDur: maybe(0.8, () => r3(0.5 + rnd() * 5)), outroDur: maybe(0.8, () => r3(0.5 + rnd() * 5)) }
  rec('graph', { ep, o: go }, (i) => buildGraph(i.ep, i.o))
  rec('validate', { ep: rnd() < 0.2 ? { ...ep, tracks: [] } : rnd() < 0.1 ? { ...ep, duration: 0 } : ep }, (i) => episodeSchema.safeParse(i.ep).success)
}
for (const w of ['äh', 'Ähm...', ' um', 'Um,', 'ähnlich', 'Hummel', 'hmm', 'mhm', 'erm', ' uhm ', 'öh', '', '...']) for (const lang of ['de', 'en']) rec('filler', { w, lang }, (i) => isFiller(i.w, i.lang))
// Clip-Folien → Episode
for (let k = 0; k < 60; k++) {
  const slides = Array.from({ length: int(1, 4) }, (_, j) => {
    if (rnd() < 0.15) return { id: `s${j}`, layout: 'cover', content: {} }
    const parts = Array.from({ length: int(0, 3) }, () => { const s = r3(rnd() * 50); return { start: s, end: r3(s + rnd() * 10) } })
    return { id: `s${j}`, layout: 'clip', hidden: maybe(0.1, () => true), content: { video: rnd() < 0.1 ? '/v/b.mp4' : '/v/a.mp4', parts, hook: maybe(0.3, () => pick(['  Anfang ', '', 'Mitte'])), ton: maybe(0.3, () => pick(['klar', 'original'])), sfx: maybe(0.3, () => [{ src: '/p/p.wav', at: r3(rnd() * 12), gain: maybe(0.5, () => -3) }]) } }
  })
  rec('deck', { slides, duration: 60 }, (i) => deckToEpisode({ title: 'T', theme: { id: 'x' }, slides: i.slides } as never, i.duration))
}

const path = 'crates/dw-podcast/tests/fixtures/podcast.json' // aus dem Repo-Wurzelverzeichnis aufrufen
const json = JSON.stringify(fx)
writeFileSync(path, json + '\n')
console.log(`${path}: ${(json.length / 1e6).toFixed(2)} MB, ${Object.entries(fx).map(([k, v]) => `${k} ${v.length}`).join(', ')}`)
