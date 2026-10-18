// npx esbuild crates/dw-lint/tests/gen/gen-video.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/gen-video.mjs && node ${TMPDIR:-/tmp}/gen-video.mjs
// Fixtures für den Differenztest Rust ↔ TS (tests/video_diff.rs): Selbsttest-Fälle aus clip-lint/retakes/transcript-search/highlights plus
// zufällige Fälle mit festem Seed. Eingaben auf 15 Stellen gerundet (serde_json liest sie dann bitgenau), Zahlen im Ergebnis als String(x).
import { writeFileSync } from 'node:fs'
import { lintClip as realLint, snapToWords as realSnap, MUSIC, type ClipInfo, type ClipIssue } from '../../../../src/shared/clip-lint'
import { retakes as realRetakes } from '../../../../src/shared/retakes'
import { highlights as realHighlights, type Signals } from '../../../../src/shared/highlights'
import { searchTranscript as realSearch, overview as realOverview } from '../../../../src/shared/transcript-search'
import { clipSpans, estimateWords, mmss, partsLength, type ClipContent, type Overlay, type Part, type Quiet, type Segment, type Transcript, type Word } from '../../../../src/shared/video'

type Case = Record<string, unknown> & { name: string; expected: unknown }
const fx: Record<string, Case[]> = { lintClip: [], snap: [], retakes: [], highlights: [], search: [], overview: [], estimateWords: [], clipSpans: [], partsLength: [], mmss: [] }
let label = 'selbsttest'
const hasNaN = (x: unknown): boolean => (typeof x === 'number' ? !Number.isFinite(x) : x && typeof x === 'object' ? Object.values(x).some(hasNaN) : false)
// Eingaben: 15 signifikante Stellen, damit serde_json ohne float_roundtrip exakt dieselbe Zahl liest
const p15 = <T>(x: T): T => (typeof x === 'number' ? (+x.toPrecision(15) as T) : Array.isArray(x) ? (x.map(p15) as T) : x && typeof x === 'object' ? (Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined).map(([k, v]) => [k, p15(v)])) as T) : x)
// Ergebnis: Zahlen als String(x), Rust vergleicht mit js::num – bitgenau ohne Umweg über den Zahlparser
const enc = (x: unknown): unknown => (typeof x === 'number' ? String(x) : Array.isArray(x) ? x.map(enc) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined).map(([k, v]) => [k, enc(v)])) : x)
// Transkripte einmal ablegen (fx.transcripts), die Fälle verweisen per {"$ref": n} darauf – sonst wüchse die Fixture auf Megabytes
const pool = new Map<string, number>()
const refify = (x: unknown): unknown => {
  if (Array.isArray(x)) return x.map(refify)
  if (!x || typeof x !== 'object') return x
  if (Array.isArray((x as Transcript).segments)) {
    const key = JSON.stringify(x)
    let k = pool.get(key)
    if (k === undefined) pool.set(key, k = pool.size)
    return { $ref: k }
  }
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, refify(v)]))
}
const rec = (kind: string, input: Record<string, unknown>, run: (i: any) => unknown) => {
  if (hasNaN(input)) return
  const i = p15(input)
  fx[kind].push({ name: `${label} ${kind} ${fx[kind].length}`, ...(refify(i) as object), expected: enc(run(i)) })
}

const lintClip = (c: ClipContent, size: { w: number; h: number }, info: ClipInfo, others: { video: string; parts: Part[] }[] = [], self?: number): ClipIssue[] => {
  rec('lintClip', { c, size, info, others, self }, (i) => realLint(i.c, i.size, i.info, i.others, i.self))
  return realLint(c, size, info, others, self)
}
const snapToWords = (parts: Part[], t: Transcript, max?: number) => {
  rec('snap', { parts, t, max }, (i) => realSnap(i.parts, i.t, i.max))
  return realSnap(parts, t, max)
}
const retakes = (t: Transcript) => {
  rec('retakes', { t }, (i) => realRetakes(i.t))
  return realRetakes(t)
}
const searchTranscript = (t: Transcript, query: string, n = 8) => {
  rec('search', { t, query, n }, (i) => realSearch(i.t, i.query, i.n))
  return realSearch(t, query, n)
}
const overview = (t: Transcript | null, s: Parameters<typeof realOverview>[1], duration: number, win = 90) => {
  rec('overview', { t, s, duration, win }, (i) => realOverview(i.t ?? null, i.s ?? null, i.duration, i.win))
  return realOverview(t, s, duration, win)
}
// Signale auf 1 Dezimale (Größe der Fixture), das Ergebnis aus den gerundeten
const r1 = (x?: number[]) => x?.map((v) => Math.round(v * 10) / 10)
const highlights = (s: Signals, o: { len?: number; n?: number; gap?: number } = {}) => {
  const sr: Signals = { loud: r1(s.loud)!, chat: r1(s.chat), events: r1(s.events), heat: r1(s.heat) }
  rec('highlights', { s: sr, o }, (i) => realHighlights(i.s, i.o))
}
const QUOTE = 100

// ---------- Selbsttests (wörtlich aus den Quelldateien, Prüfungen unverändert) ----------
{ // clip-lint.ts
  const eq = (got: unknown, want: unknown, what: string) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: ${JSON.stringify(got)}`) }
  const rules = (xs: ClipIssue[]) => xs.map((x) => `${x.severity}:${x.rule}`).sort()
  const msgs = (xs: ClipIssue[], rule: string) => xs.filter((x) => x.rule === rule).map((x) => x.message)
  const tall = { w: 720, h: 1280 }, wide = { w: 1280, h: 720 }
  // sauberes Transkript: je Sekunde ein Wort (k+0,1 bis k+0,5), Sätze „Wir sind gut.“, „Wir sind klar.“ … – derselbe Satz erst nach 21 s wieder (kein Neuansatz)
  const clean: Transcript = { duration: 100, lang: 'de', segments: [{ start: 0, end: 100, text: '',
    words: Array.from({ length: 100 }, (_, k) => ({ w: k % 3 < 2 ? ['Wir', 'sind'][k % 3] : ['gut.', 'klar.', 'stark.', 'bereit.', 'hier.', 'wach.', 'da.'][Math.floor(k / 3) % 7], start: k + 0.1, end: k + 0.5 })) }] }
  // 10 Stücke à 5,9 s mit Schnitt dazwischen (sonst clip-ruhe), je zwei ganze Sätze
  const ok: ClipContent = { video: 'asset://a.mp4', hook: 'Drei Wörter hier', post: 'Titel\nSatz. #a #b #c', parts: Array.from({ length: 10 }, (_, j) => ({ start: 6 * j, end: 6 * j + 5.9 })) }
  eq(lintClip(ok, tall, { duration: 100, transcript: clean }), [], 'sauberer Clip')

  // Video, ungültige Zeiten, Ende, Länge, Hook
  eq(rules(lintClip({ ...ok, video: ' ' }, tall, { transcript: clean })), ['error:clip-video'], 'video leer')
  const inv = lintClip({ ...ok, parts: [{ start: 0, end: 60 }, { start: 5, end: 5 }, { start: NaN, end: 3 }, { start: -1, end: 4 }] }, wide, { duration: 100, transcript: null })
  eq([rules(inv), msgs(inv, 'clip-zeit'), inv.some((x) => x.message.includes('NaN'))], [['warn:clip-transkript', 'warn:clip-zeit'],
    ['Ausschnitte 2, 3, 4 ohne gültige Zeiten (start ≥ 0, end nach start) – Zeiten aus dem Transkript nehmen'], false], 'ungültige parts')
  eq(rules(lintClip({ ...ok, parts: [{ start: 0, end: 30 }, { start: 110, end: 115 }] }, tall, { duration: 100, transcript: clean })).filter((r) => r.includes('ende')), ['error:clip-ende'], 'start hinter Ende')
  eq(rules(lintClip({ ...ok, parts: [{ start: 69, end: 105 }] }, tall, { duration: 100, transcript: clean })).filter((r) => r.includes('ende')), ['warn:clip-ende'], 'end hinter Ende')
  const len = (end: number, size = tall) => rules(lintClip({ ...ok, parts: [{ start: 0, end }] }, size, { transcript: clean })).filter((r) => r.includes('laenge'))
  eq([len(12)[0], len(95)[0], len(21)[0], len(54)[0], len(95, wide)[0]], ['warn:clip-laenge', 'warn:clip-laenge', 'info:clip-laenge', 'info:clip-laenge', undefined], 'Länge')
  eq(msgs(lintClip({ ...ok, pauses: 'kurz', parts: [{ start: 0, end: 96 }] }, tall, { transcript: clean }), 'clip-laenge'), ['Länge 96 s vor dem Pausenkürzen – für einen Short 20–90 s; kürzen'], 'Länge pauses kurz')
  eq([len(30), rules(lintClip({ ...ok, parts: [{ start: 0, end: 30, speed: 0.5 }] }, tall, { transcript: clean })).filter((r) => r.includes('laenge'))], [['info:clip-laenge'], []], 'Länge mit Tempo: 30 s Zeitlupe = 60 s')
  eq(rules(lintClip({ ...ok, hook: undefined }, tall, { transcript: clean })), ['info:clip-hook'], 'Hook fehlt')
  eq(rules(lintClip({ ...ok, hook: undefined }, wide, { transcript: clean })).includes('info:clip-hook'), false, 'Hook quer')
  eq(rules(lintClip({ ...ok, hook: 'eins zwei drei vier fünf sechs sieben acht neun zehn' }, tall, { transcript: clean })), ['info:clip-hook'], 'Hook lang')

  // Post-Text und Cover
  eq(rules(lintClip({ ...ok, post: ' ' }, tall, { transcript: clean })), ['info:clip-post'], 'post fehlt')
  eq(rules(lintClip({ ...ok, post: undefined }, wide, { transcript: clean })), [], 'post quer')
  eq(rules(lintClip({ ...ok, cover: 30 }, tall, { duration: 100, transcript: clean })), [], 'cover im Video')
  eq(msgs(lintClip({ ...ok, cover: 120 }, wide, { duration: 100, transcript: clean }), 'clip-post'), ['cover bei 120 s liegt nicht im Video (0–100 s) – Sekunde aus dem Kontaktabzug nehmen'], 'cover hinter Ende')
  eq(rules(lintClip({ ...ok, cover: -1 }, tall, { transcript: clean })), ['warn:clip-post'], 'cover negativ')

  // Wort, Satz, Einstieg
  const talk: Transcript = { duration: 100, lang: 'de', segments: [{ start: 0, end: 6, text: '', words: [
    { w: ' Aber', start: 1.5, end: 1.9 }, { w: ' das', start: 2, end: 2.3 }, { w: ' ist', start: 2.4, end: 2.6 }, { w: ' wichtig.', start: 2.7, end: 3.3 },
    { w: ' Es', start: 3.6, end: 3.8 }, { w: ' geht', start: 3.9, end: 4.4 }, { w: ' weiter.', start: 4.5, end: 5 }] }] }
  const a = lintClip({ ...ok, parts: [{ start: 0, end: 2.8 }] }, wide, { transcript: talk })
  eq(a.map((x) => x.message), ['Ausschnitt 1 endet mitten in „wichtig.“ – Ende auf 3,3 s legen', 'Ausschnitt 1 beginnt mit „Aber“ – Start früher legen, damit der Clip für sich steht',
    'Ausschnitt 1: Stille am Anfang (1,5 s) – Start auf 1,5 s legen'], 'Wort/Satz/Einstieg, kein Satzende-Doppel')
  eq(rules(lintClip({ ...ok, parts: [{ start: 3.5, end: 4.3 }] }, wide, { transcript: talk })), ['warn:clip-satz'], 'Kante bis PAD im Wort: nur Satzende')
  eq(rules(lintClip({ ...ok, parts: [{ start: 3.5, end: 4.1 }] }, wide, { transcript: talk })), ['warn:clip-satz'], 'Kante bis SNAP im Wort: rastet der Export ein')
  eq(msgs(lintClip({ ...ok, parts: [{ start: 1.95, end: 3.4 }] }, wide, { transcript: talk }), 'clip-satz'), ['Ausschnitt 1 beginnt mit „das“ – Start früher legen, damit der Clip für sich steht'], 'Pronomen mitten im Satz')
  eq(rules(lintClip({ ...ok, parts: [{ start: 3.5, end: 5.1 }] }, wide, { transcript: talk })), [], 'Pronomen am Satzanfang')

  // viele parts: gebündelt; Querformat nur Anfang und Ende
  const many = { ...ok, parts: Array.from({ length: 5 }, (_, j) => ({ start: 3 * j, end: 3 * j + 1.8 })) } // enden je nach „sind“
  eq(msgs(lintClip(many, tall, { transcript: clean }), 'clip-satz'), ['5 von 5 Ausschnitten enden ohne Satzende: 1 (bis 1,8 s), 2 (bis 4,8 s), 3 (bis 7,8 s) … – Enden hinter das Satzende legen'], 'gebündelt')
  eq(msgs(lintClip(many, wide, { transcript: clean }), 'clip-satz'), ['Ausschnitt 5 endet ohne Satzende („…Wir sind“) – Ende hinter das Satzende legen'], 'quer nur Ende')

  // Transkript fehlt
  const part = { start: 70, end: 95 }
  eq(lintClip({ ...ok, parts: [part] }, wide, { transcript: { ...clean, covered: [[0, 80]] } }).map((x) => x.message), ['Kein Transkript für 80–95 s: erst transcribe_video mit from/to, sonst keine Untertitel'], 'covered')
  eq(lintClip({ ...ok, parts: [{ start: 70, end: 96 }] }, wide, { transcript: { ...clean, covered: [[0, 80], [80.3, 100]] } }), [], 'Mini-Lücke')
  eq(msgs(lintClip({ ...ok, parts: [part] }, wide, { duration: 90, transcript: null }), 'clip-transkript'), ['Kein Transkript für 70–90 s: erst transcribe_video mit from/to, sonst keine Untertitel'], 'nur bis Videoende')
  eq(rules(lintClip({ ...ok, parts: [part] }, wide, { transcript: null })), ['warn:clip-transkript'], 'ohne Transkript')
  eq(rules(lintClip({ ...ok, parts: [part], captions: 'aus' }, wide, { transcript: null })), [], 'captions aus')

  // Überschneidungen
  eq(rules(lintClip({ ...ok, parts: [{ start: 0, end: 39 }, { start: 36, end: 63 }] }, wide, { transcript: clean })), ['warn:clip-overlap'], 'parts überlappen')
  eq(msgs(lintClip({ ...ok, parts: [{ start: 0, end: 15 }, { start: 12, end: 27 }, { start: 20, end: 30 }] }, tall, { transcript: clean }), 'clip-overlap'),
    ['2 Paare von Ausschnitten überschneiden sich: 1/2 (3 s), 2/3 (7 s) – Bereiche trennen, sonst laufen Stellen doppelt'], 'Überlappung gebündelt')
  const others = [{ video: 'asset://a.mp4', parts: [{ start: 40, end: 100 }] }, { video: 'asset://b.mp4', parts: [{ start: 0, end: 30 }] }, { video: 'asset://a.mp4', parts: [{ start: 57, end: 63 }] }, { video: ok.video, parts: [{ start: 0, end: 60 }] }]
  eq(lintClip(ok, tall, { transcript: clean }, others, 3).map((x) => x.message), ['überschneidet sich 20 s mit Clip 1 (gleiches Video) – andere Stelle wählen'], 'andere Clips, self')
  eq(msgs(lintClip(ok, tall, { transcript: clean }, others), 'clip-overlap').length, 2, 'andere Clips ohne self')

  // Musik: Sekunden der Ausschnitte mit Musik ≥ MUSIC, überlappende Ausschnitte zählen einmal, ab 5 s
  const music = Array.from({ length: 100 }, (_, k) => (k >= 62 && k < 74 ? 0.8 : k >= 40 && k < 45 ? MUSIC : 0.05))
  const strike = (s: number, at: string) => [`Musik im Hintergrund (${s} s, u. a. bei ${at}) – bei fremder Musik droht ein Copyright-Strike; Stelle meiden oder Musik prüfen`]
  eq(msgs(lintClip({ ...ok, parts: [{ start: 60, end: 70.5 }, { start: 65, end: 80 }] }, wide, { transcript: clean, music }), 'clip-musik'), strike(12, '1:02'), 'Musik überlappend')
  eq(msgs(lintClip({ ...ok, parts: [{ start: 30, end: 58 }] }, tall, { transcript: clean, music }), 'clip-musik'), strike(5, '0:40'), 'Musik 5 s')
  eq(msgs(lintClip({ ...ok, parts: [{ start: 30, end: 44 }] }, tall, { transcript: clean, music }), 'clip-musik'), [], 'Musik 4 s')
  eq(msgs(lintClip({ ...ok, parts: [{ start: 40.5, end: 50 }] }, tall, { transcript: clean, music }), 'clip-musik'), [], 'Musik nach innen gerundet')
  eq(msgs(lintClip({ ...ok, parts: [{ start: 95, end: 1e9 }] }, wide, { transcript: clean, music: music.map(() => 0.9).slice(0, 98) }), 'clip-musik'), [], 'Musik nur bis Signalende')

  // snapToWords
  const s = snapToWords([{ start: 1.6, end: 4.2, focus: 0.3 }], talk)
  eq(s, { parts: [{ start: 1.5, end: 4.4, focus: 0.3 }], moved: [{ i: 0, edge: 'start', from: 1.6, to: 1.5 }, { i: 0, edge: 'end', from: 4.2, to: 4.4 }] }, 'snap')
  eq(snapToWords([{ start: 1.6, end: 4.2 }], talk, 0.15).moved.map((m) => m.edge), ['start'], 'snap max')
  eq(snapToWords([{ start: 1.6, end: 2.5 }, { start: 2.5, end: 4.2 }], talk), { parts: [{ start: 1.5, end: 2.5 }, { start: 2.5, end: 4.4 }],
    moved: [{ i: 0, edge: 'start', from: 1.6, to: 1.5 }, { i: 1, edge: 'end', from: 4.2, to: 4.4 }] }, 'snap nahtlos')
  eq(msgs(lintClip({ ...ok, parts: [{ start: 0, end: 2.5 }, { start: 2.5, end: 2.8 }] }, wide, { transcript: talk }), 'clip-wort'), ['Ausschnitt 2 endet mitten in „wichtig.“ – Ende auf 3,3 s legen'], 'nahtlos kein clip-wort')
  eq(snapToWords([{ start: 3, end: 4.2 }], { duration: 10, lang: 'de', segments: [{ start: 0, end: 6, text: 'Aber das ist wichtig. Wir machen weiter.' }] }), { parts: [{ start: 3, end: 4.2 }], moved: [] }, 'snap ohne words')

  // Neuansatz: erster Anlauf 0–4 s, neuer ab 4 s
  const re: Transcript = { duration: 100, lang: 'de', segments: [['Heute zeige ich euch drei Tricks.', 0], ['Heute zeige ich euch drei Tricks für Excel.', 4], ['Ich ich klappe das immer.', 10]].map(([s, t0]) => {
    const words = (s as string).split(' ').map((w, m) => ({ w: ' ' + w, start: +((t0 as number) + m * 0.4).toFixed(2), end: +((t0 as number) + m * 0.4 + 0.3).toFixed(2) }))
    return { start: t0 as number, end: words[words.length - 1].end, text: s as string, words }
  }) }
  const neu = (parts: Part[]) => msgs(lintClip({ ...ok, parts }, wide, { transcript: re }), 'clip-neuansatz')
  eq(neu([{ start: 0, end: 7.2 }]), ['Ausschnitt 1 enthält einen Neuansatz („Heute zeige ich euch drei Tricks“) – 0–4 s herausschneiden'], 'Neuansatz')
  eq(neu([{ start: 0, end: 3.9 }, { start: 4, end: 7.2 }]), ['Ausschnitt 2 enthält einen Neuansatz („Heute zeige ich euch drei Tricks“) – 0–4 s herausschneiden'], 'Neuansatz über zwei parts')
  eq([neu([{ start: 4, end: 7.2 }]), neu([{ start: 0, end: 3.9 }]), neu([{ start: 2.5, end: 7.2 }])], [[], [], []], 'Anlauf geschnitten')
  eq(neu([{ start: 0, end: 12 }]), ['2 Neuansätze in den Ausschnitten: 1 (0–4 s), 1 (10–10,4 s) – jeweils den ersten Anlauf herausschneiden'], 'Neuansatz gebündelt')

  // Ruhe: Shorts ohne Schnitt über 8 s, nahtlose parts zählen als ein Stück
  const ruhe = (parts: Part[], o: Partial<ClipContent> = {}, size = tall) => lintClip({ ...ok, ...o, parts }, size, { transcript: clean }).filter((x) => x.rule === 'clip-ruhe').map((x) => `${x.severity}:${x.message}`)
  eq(ruhe([{ start: 0, end: 29.9 }]), ['info:Ausschnitt 1 läuft 29,9 s ohne Schnitt – teilen (Füllsatz raus) oder style lebendig für Zoom-Wechsel'], 'Ruhe')
  eq(ruhe([{ start: 0, end: 5 }, { start: 5, end: 11.9 }]), ['info:Ausschnitt 1 läuft 11,9 s ohne Schnitt – teilen (Füllsatz raus) oder style lebendig für Zoom-Wechsel'], 'Ruhe nahtlos')
  eq(ruhe([{ start: 0, end: 29.9 }], { style: 'lebendig' }), ['info:Ausschnitt 1 läuft 29,9 s ohne Schnitt – teilen (Füllsatz raus)'], 'Ruhe lebendig')
  eq([ruhe([{ start: 0, end: 8 }, { start: 9, end: 17 }]), ruhe([{ start: 0, end: 29.9 }], {}, wide)], [[], []], 'Ruhe 8 s, quer')
  eq(ruhe([{ start: 0, end: 11.9 }, { start: 12, end: 23.9 }]), ['info:2 von 2 Stücken laufen über 8 s ohne Schnitt: 1 (11,9 s), 2 (11,9 s) – teilen (Füllsatz raus) oder style lebendig für Zoom-Wechsel'], 'Ruhe gebündelt')

  // Effekte: Tempo über Sprache, Effekt-Übergänge, Musikpegel ohne Deck-Musik, Einblendungen
  eq(msgs(lintClip({ ...ok, parts: [{ start: 0, end: 5.9, speed: 0.5 }, ...ok.parts.slice(1)] }, tall, { transcript: clean }), 'clip-tempo'),
    ['Ausschnitt 1 läuft mit speed 0,5 über Sprache – Sprache in Zeitlupe/Zeitraffer klingt unnatürlich; meist nur bei Aktion ohne Sprache, sonst speed weglassen'], 'Tempo über Sprache')
  eq(msgs(lintClip({ ...ok, captions: 'aus', parts: [{ start: 0, end: 5.9, speed: 0.5 }, ...ok.parts.slice(1)] }, tall, { transcript: clean }), 'clip-tempo'), [], 'Tempo captions aus')
  const fx = (ts: (Part['transition'])[]) => rules(lintClip({ ...ok, parts: ok.parts.map((p, j) => ({ ...p, transition: ts[j] })) }, tall, { transcript: clean })).filter((r) => r.includes('uebergang'))
  eq([fx([undefined, 'wipe', 'zoom', 'push', 'split']), fx([undefined, 'wipe', 'zoom']), fx(['wipe', 'zoom', 'push', 'fade', 'dissolve', 'fade', 'fade', 'fade', 'fade', 'fade'])], [['info:clip-uebergang'], [], []], 'Übergänge sparsam')
  // 8 parts, die ersten 3 nahtlos: 5 echte Schnitte, 2 mit Effekt (> 5/3; mit nahtlosen wären es 2 von 7)
  const seam = [0, 5, 10, 16, 22, 28, 34, 40].map((st, j) => ({ start: st, end: j < 2 ? st + 5 : st + 5.5, transition: j === 1 ? 'wipe' as const : j === 3 ? 'zoom' as const : j === 4 ? 'push' as const : undefined }))
  eq(rules(lintClip({ ...ok, parts: seam }, wide, { transcript: clean })).filter((r) => r.includes('uebergang')), ['info:clip-uebergang'], 'Übergänge ohne nahtlose')
  const mus = { ...ok, parts: ok.parts.map((p, j) => (j === 2 ? { ...p, music: 0.8, volume: 0 } : p)) }
  eq([msgs(lintClip(mus, tall, { transcript: clean, deckMusic: false }), 'clip-musik'), rules(lintClip(mus, tall, { transcript: clean, deckMusic: true })), rules(lintClip(mus, tall, { transcript: clean }))],
    [['Ausschnitt 3 setzt music, das Deck hat keine Hintergrundmusik – erst find_music und update_deck music, sonst music weglassen'], [], []], 'Musikpegel ohne Deck-Musik')
  eq(lintClip({ ...ok, overlays: [{ start: 1, end: 4, text: 'Anna, Hamburg' }, { start: 95, end: 98, image: 'asset://logo.png' }, { start: 5, end: 5.8, text: 'Ein sehr langer Text, der viel zu viel sagt' }] }, tall, { transcript: clean })
    .map((x) => `${x.severity}:${x.message}`), ['warn:Einblendung 2 (95–98 s) liegt in keinem Ausschnitt und ist nie zu sehen – Zeiten in einen Ausschnitt legen (Quellsekunden wie parts)',
    'info:Einblendung 3 hat 43 Zeichen in einer Zeile – kürzer (höchstens 40: Name, Funktion, Ort, Zahl)'], 'Einblendungen')
  const ein = (ov: ClipContent['overlays'], o: Partial<ClipContent> = {}, inf: Partial<ClipInfo> = {}) => lintClip({ ...ok, ...o, overlays: ov }, tall, { transcript: clean, ...inf }).filter((x) => x.rule === 'clip-einblendung').map((x) => `${x.severity}:${x.message}`)
  eq(ein([{ start: 1, end: 4, text: 'Anna' }, { start: 3, end: 5, image: 'asset://x.png' }, { start: 1, end: 5, art: 'verpixeln', box: [0, 0, 0.2, 0.2] }]),
    ['warn:Einblendung 1 und 2 stehen gleichzeitig – höchstens eine Einblendung zur Zeit, Zeiten trennen'], 'gleichzeitig, verpixeln ausgenommen')
  eq(ein([{ start: 6, end: 17, image: 'asset://x.png', pos: 'voll' }]), ['info:Einblendung 1 (pos voll) verdeckt 10,9 s den Sprecher – B-Roll 2–6 s, höchstens 8 s'], 'B-Roll zu lang')
  eq([ein([{ start: 1, end: 4, video: 'asset://b.mp4', pos: 'voll' }]), ein([{ start: 1, end: 4, video: 'asset://b.mp4', pos: 'voll' }], { hook: undefined }), ein([{ start: 4, end: 7, video: 'asset://b.mp4', pos: 'voll' }])],
    [['warn:Einblendung 1 (pos voll) steht in den ersten 3 s – dort hält das Gesicht mit dem Hook den Zuschauer, später einblenden'], [], []], 'B-Roll im Hook')
  eq(ein([{ start: 1, end: 4, art: 'bauchbinde', text: 'Anna', sub: 'Leiterin der Abteilung für besondere Aufgaben' }]), ['info:Einblendung 1 hat 45 Zeichen in einer Zeile – kürzer (höchstens 40: Name, Funktion, Ort, Zahl)'], 'sub zu lang')
  const deckSl = [{ layout: 'clip' }, { layout: 'kpi-grid', hidden: true }, { layout: 'chart' }]
  eq([ein([{ start: 1, end: 3, slide: 2 }], {}, { slides: deckSl }), ein([{ start: 1, end: 3, slide: 1 }, { start: 6, end: 8, slide: 9 }], {}, { slides: deckSl }), ein([{ start: 1, end: 3, slide: 3 }], {}, { slides: deckSl }), ein([{ start: 1, end: 3, slide: 9 }])],
    [[], ['error:2 Einblendungen verweisen auf keine passende Folie: 1 (Folie 1), 2 (Folie 9) – Nummer einer ausgeblendeten Folie aus dem Katalog eintragen'],
      ['warn:Einblendung 1: Folie 3 ist nicht ausgeblendet und läuft zusätzlich als eigene Folie – update_slide hidden: true'], []], 'Folie einblenden')
  ein([{ start: 1, end: 3, slide: 1 }], {}, { slides: deckSl }) // einzeln: „Folie 1 ist ein Clip“
  const fz = (end: number) => msgs(lintClip({ ...ok, parts: [{ ...ok.parts[0], end, freeze: 1 }, ...ok.parts.slice(1)] }, tall, { transcript: clean }), 'clip-standbild')
  eq([fz(5.9), fz(4.8), fz(5.3)], [[], ['Ausschnitt 1 hält ein Standbild (freeze) mitten im Satz – nur am Satzende, Ende hinter das Satzende legen oder freeze weglassen'],
    ['Ausschnitt 1 hält ein Standbild (freeze) mitten im Satz – nur am Satzende, Ende hinter das Satzende legen oder freeze weglassen']], 'Standbild am Satzende')
  const zm = (zs: (number | undefined)[]) => msgs(lintClip({ ...ok, parts: ok.parts.map((p, j) => ({ ...p, zoom: zs[j] })) }, tall, { transcript: clean }), 'clip-zoom')
  eq([zm([undefined, 1.15, undefined, 1.2]), zm([1.1, 1.15, 1.2]), zm([1.1, 1.1, 1.1, 1.1, 1.1, 1.1])],
    [[], ['zoom an 3 von 10 Ausschnitten, 3 Stufen – Punch-in nur an Pointen (1.1–1.2), höchstens zwei Stufen'], ['zoom an 6 von 10 Ausschnitten, 1 Stufe – Punch-in nur an Pointen (1.1–1.2), höchstens zwei Stufen']], 'Zoom-Übertreibung')
  console.log('clip-lint ok')
}
{ // retakes.ts
  const eq = (got: unknown, want: unknown, what: string) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: ${JSON.stringify(got)}`) }
  // Stücke [Text, Start]: Wörter im Abstand 0,4 s, je 0,3 s lang
  const mk = (...chunks: [string, number][]): Transcript => ({ duration: 100, lang: 'de', segments: chunks.map(([s, t0]) => {
    const words = s.split(' ').map((w, m) => ({ w: ' ' + w, start: +(t0 + m * 0.4).toFixed(2), end: +(t0 + m * 0.4 + 0.3).toFixed(2) }))
    return { start: t0, end: words[words.length - 1].end, text: s, words }
  }) })
  eq(retakes(mk(['Heute zeige ich euch drei Tricks.', 0], ['Heute zeige ich euch drei Tricks für Excel.', 4])),
    [{ drop: [0, 4], keep: 4, text: 'Heute zeige ich euch drei Tricks' }], 'Neuansatz deutsch')
  eq(retakes(mk(['So today I want to show you.', 0], ['So today I want to show you three things.', 5])),
    [{ drop: [0, 5], keep: 5, text: 'So today I want to show you' }], 'Neuansatz englisch')
  eq(retakes(mk(['Ich wollte euch', 0], ['ich wollte euch heute etwas zeigen.', 1.5])), [{ drop: [0, 1.5], keep: 1.5, text: 'ich wollte euch' }], 'abgebrochen')
  eq(retakes(mk(['Das Projekt', 0], ['Das Projekt läuft gut.', 1])), [{ drop: [0, 1], keep: 1, text: 'Das Projekt' }], 'abgebrochen 2 Wörter')
  eq(retakes(mk(['Heute zeige', 0], ['Heute zeige ich', 1], ['Heute zeige ich euch drei Tricks.', 2.5])).map((r) => r.drop), [[0, 1], [1, 2.5]], 'mehrere Anläufe')
  eq(retakes(mk(['Ich ich ich zeige das das das Projekt.', 0])), [{ drop: [0, 0.8], keep: 0.8, text: 'Ich' }, { drop: [1.6, 2.4], keep: 2.4, text: 'das' }], 'Stottern')
  eq(retakes(mk(['Leute die die Arbeit machen.', 0])), [], 'die die ohne Komma: Grammatik')
  eq(retakes(mk(['Die, die ich kenne.', 0])), [], 'die, die')
  eq(retakes(mk(['Heute zeige ich euch drei Tricks.', 0], ['Heute zeige ich euch drei Tricks.', 60])), [], 'nach 60 s')
  eq(retakes(mk(['Dann gehen wir los.', 0], ['Dann kommt der Rest.', 3])), [], '1 Wort')
  eq(retakes(mk(['und dann', 0], ['und dann kommt der Rest.', 1])), [], 'nur Funktionswörter')
  eq(retakes(mk(['Wir wollen mehr Schulen.', 0], ['Wir wollen mehr Lehrer.', 2])), [], 'Anapher')
  eq(retakes(mk(['Wir wollen mehr Schulen und', 0], ['wir wollen mehr Lehrer.', 2])), [], 'Aufzählung mit und')
  eq(retakes(mk(['Wir brauchen Mut, wir brauchen Zeit.', 0])), [], 'Anapher mit Komma')
  eq(retakes(mk(['Es geht um Schulen, es geht um Lehrer.', 0])), [], 'Anapher mit Komma 3 Wörter')
  const two = mk(['Das Projekt', 0], ['Das Projekt läuft gut.', 1])
  two.segments[1].speaker = 1
  eq(retakes(two), [], 'anderer Sprecher')
  eq(retakes({ duration: 10, lang: 'de', segments: [{ start: 0, end: 5, text: 'Heute zeige ich. Heute zeige ich euch was.' }] }), [], 'ohne words')
  console.log('retakes ok')
}
{ // transcript-search.ts (ohne Zeitgrenze: die Aufzeichnung läuft mit)
  const ok = (_c: unknown, _m: string) => {}
  const mk = (txt: string, start: number) => { // 0,5 s je Wort, mit Leerzeichen vorn wie bei Whisper
    const words = txt.split(' ').map((w, i) => ({ w: ' ' + w, start: start + i * 0.5, end: start + i * 0.5 + 0.4 }))
    return { start, end: start + words.length * 0.5, text: txt, words }
  }
  const t: Transcript = { duration: 100, lang: 'de', segments: [
    mk('Hallo und willkommen zum Stream', 0),
    mk('Das ist ein Test für die Suche', 10),
    mk('Äpfel und Birnen schmecken Größe über alles', 20),
    mk('der kleine braune Hund läuft schnell durch den Wald', 30),
  ] }
  let h = searchTranscript(t, 'ein test für die suche')
  ok(h.length === 1 && h[0].score === QUOTE && h[0].start === 11 && Math.abs(h[0].end - 13.4) < 1e-9 && h[0].seg === 1, 'Zitat exakt ' + JSON.stringify(h))
  h = searchTranscript(t, 'ÄPFEL, und birnen!')
  ok(h[0]?.score === QUOTE && h[0].start === 20 && h[0].seg === 2, 'Zitat Umlaut ' + JSON.stringify(h))
  h = searchTranscript(t, 'grosse UBER Alles')
  ok(h[0]?.score === QUOTE && h[0].start === 22, 'Zitat ß/Umlaut ' + JSON.stringify(h))
  h = searchTranscript(t, 'der kleine weisse Hund läuft schnell durch den Wald')
  ok(h.length === 1 && h[0].score > 50 && h[0].score < QUOTE && h[0].seg === 3, 'Zitat unscharf ' + JSON.stringify(h))
  // BM25 über 1000 Segmente
  const fill = 'heute gibt es viel zu erzählen über das Wetter und die Stadt wegen den Nachbarn'.split(' ')
  const big: Transcript = { duration: 6000, lang: 'de', segments: Array.from({ length: 1000 }, (_, i) => ({ start: i * 6, end: i * 6 + 5, text: Array.from({ length: 8 }, (_, j) => fill[(i * 7 + j * 3) % fill.length]).join(' ') })) }
  big.segments[640].text = 'und dann haben wir über Kernfusion und Plasmaphysik gesprochen'
  const c0 = process.cpuUsage() // CPU- statt Wanduhrzeit, damit eine ausgelastete Maschine den Test nicht kippt
  h = searchTranscript(big, 'Kernfusion Plasma')
  const u = process.cpuUsage(c0), ms = (u.user + u.system) / 1000
  ok(h.length && h[0].seg === 640 && h[0].start === 639 * 6 && h[0].end === 641 * 6 + 5 && h[0].score > 0, 'BM25 ' + JSON.stringify(h[0]))
  ok(ms < 50, 'BM25 zu langsam: ' + ms)
  ok(searchTranscript(big, 'zzzzqq').length === 0 && searchTranscript(big, '  ').length === 0, 'kein Treffer')
  // Überblick 8 h
  const D = 8 * 3600, loud = Array.from({ length: D }, (_, i) => -30 + (i % 7) * 0.2)
  for (let i = 12 * 60; i < 12 * 60 + 90; i++) loud[i] += 9
  const ev = new Array<number>(D).fill(0); ev[100] = 0.9
  const long: Transcript = { duration: D, lang: 'de', covered: [[0, 3600]], segments: [{ start: 12 * 60 + 5, end: 12 * 60 + 20, text: 'Jetzt kommt der wichtigste Teil des ganzen Abends und ihr solltet gut zuhören weil es um alles geht' }] }
  const ov = overview(long, { loud, events: ev }, D)
  ok(ov.length === 320 && ov.every((l) => l.length < 160), 'overview Zeilen ' + ov.length + ' ' + Math.max(...ov.map((l) => l.length)))
  ok(/^12:00–13:30 · laut \+9 dB · „Jetzt kommt .* …“$/.test(ov[8]), 'overview Fenster ' + ov[8])
  ok(ov[1].includes('Lachen/Jubel') && ov[100].endsWith('(noch kein Transkript)') && ov[0].includes('(keine Sprache)') && !ov[2].includes('laut'), 'overview Signale ' + ov[1] + ' | ' + ov[100])
  ok(overview(null, null, 180).join() === '0:00–1:30 · (noch kein Transkript),1:30–3:00 · (noch kein Transkript)', 'overview ohne alles')
  console.log(`transcript-search ok (BM25 ${ms.toFixed(1)} ms)`)
}

// highlights: Szenarien (a)–(d) aus dem Selbsttest, (e) 8 h misst video_diff.rs selbst
{
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const noise = (n: number, base: number, amp: number) => Array.from({ length: n }, () => base + (rnd() - 0.5) * 2 * amp)
  const chat = Array.from({ length: 3600 }, () => (rnd() < 0.3 ? 1 : 0))
  for (let i = 1015; i < 1025; i++) chat[i] += 8
  highlights({ loud: noise(3600, -25, 2), chat }, { n: 1 })
  const loud = noise(1200, -25, 2), events = new Array(1200).fill(0)
  for (let i = 0; i < 6; i++) loud[300 + i] = loud[800 + i] = -13, events[800 + i] = 0.9
  highlights({ loud, events }, { n: 1 })
  const many = chat.slice()
  for (let t = 100; t < 3500; t += 45) for (let i = 0; i < 5; i++) many[t + i] += 4 + (t % 7)
  highlights({ loud: noise(3600, -25, 2), chat: many }, { n: 8, gap: 30 })
  highlights({ loud })
}

// ---------- Zufall mit festem Seed ----------
label = 'zufall'
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
const r2 = (x: number) => Math.round(x * 100) / 100
const VOCAB = ['Wir', 'sind', 'gut', 'heute', 'zeige', 'ich', 'euch', 'drei', 'Tricks', 'für', 'Excel', 'das', 'Projekt', 'läuft', 'Größe', 'Äpfel', 'Straße', 'Kernfusion',
  'und', 'aber', 'also', 'dann', 'weil', 'die', 'der', 'es', 'sie', 'this', 'that', 'it', 'äh', 'ähm', 'hmm', 'Hund', 'Wald', 'schnell', 'wichtig', 'Lehrer', 'Schulen',
  'mehr', 'brauchen', 'Zeit', 'Mut', 'Stream', 'Chat', 'today', 'show', 'you', 'things', 'Ich', 'Die', 'Und', 'Kunden', 'Angebot', 'Preis', 'Zahlen', 'Wetter', 'Stadt']
const PUNCT = ['', '', '', '', '.', '.', '!', '?', ',', ',', '…', '."', '.»', ';', ':', '–', '-', ')']

function transcript(D: number): Transcript {
  const segments: Segment[] = []
  let t = rnd() * 2, prev: string[] = []
  const twoSpk = rnd() < 0.3
  while (t < D - 3) {
    let toks: string[] = Array.from({ length: int(2, 12) }, () => pick(VOCAB))
    if (prev.length >= 2 && rnd() < 0.3) toks = [...prev.slice(0, int(2, Math.min(6, prev.length))), ...toks] // Neuansatz
    if (rnd() < 0.15) { const k = int(0, toks.length - 1); toks.splice(k, 0, ...Array(int(1, 2)).fill(toks[k])) } // Stottern
    const ws = toks.map((w, m) => w + (m === toks.length - 1 ? pick(['.', '.', '!', '?', '', '…']) : pick(PUNCT)))
    prev = toks
    const words: Word[] = []
    let x = t
    for (const w of ws) {
      const d = 0.15 + rnd() * 0.5
      const lead = rnd() < 0.7 ? ' ' : ''
      words.push({ w: lead + w, start: r2(x), end: r2(x + d) })
      x += d + (rnd() < 0.1 ? 0.6 + rnd() * 1.5 : 0.03 + rnd() * 0.25)
    }
    const seg: Segment = { start: r2(t), end: r2(x), text: ws.join(' ') }
    if (rnd() < 0.85) seg.words = words
    if (twoSpk) seg.speaker = rnd() < 0.7 ? 0 : 1
    segments.push(seg)
    t = x + (rnd() < 0.2 ? rnd() * 6 : rnd() * 0.5)
  }
  const out: Transcript = { duration: D, lang: pick(['de', 'en', 'auto']), segments }
  if (rnd() < 0.3) {
    const cov: [number, number][] = []
    let a = 0
    while (a < D) { const b = Math.min(D, a + 10 + rnd() * 60); if (rnd() < 0.7) cov.push([r2(a), r2(b)]); a = b + rnd() * 20 }
    out.covered = cov
  }
  return out
}

const TRANS = ['none', 'fade', 'dissolve', 'push', 'wipe', 'circle', 'zoom', 'split', 'stack', 'color'] as const
const ARTS = ['text', 'bauchbinde', 'titel', 'zahl', 'liste', 'zitat', 'markierung', 'abspann', 'verpixeln'] as const
const POS = ['oben', 'mitte', 'unten', 'oben-links', 'oben-rechts', 'unten-links', 'unten-rechts', 'voll'] as const
const LONG = 'Leiterin der Abteilung für besondere Aufgaben und Projekte'

function parts(D: number, max: number): Part[] {
  const out: Part[] = []
  let at = rnd() * D * 0.3
  for (let k = int(1, max); k > 0; k--) {
    const mode = rnd()
    const start = mode < 0.25 && out.length ? out[out.length - 1].end : mode < 0.35 ? r2(rnd() * D) : mode < 0.4 ? r2(D + rnd() * 5) : r2(at)
    let end = r2(start + 0.3 + rnd() * (rnd() < 0.2 ? 30 : 9))
    if (rnd() < 0.05) end = start - rnd() // ungültig
    const p: Part = { start: rnd() < 0.03 ? -1 : start, end }
    if (rnd() < 0.1) p.speed = pick([0.1, 0.5, 1, 1.5, 2, 5])
    if (rnd() < 0.1) p.freeze = pick([0, 0.2, 1, 4])
    if (rnd() < 0.15) p.zoom = pick([0, 1, 1.1, 1.15, 1.2, 1.3])
    if (rnd() < 0.25) p.transition = pick(TRANS)
    if (rnd() < 0.08) p.music = pick([0, 0.5])
    if (rnd() < 0.05) p.volume = 0
    if (rnd() < 0.05) p.focus = 0.3
    out.push(p)
    at = end + (rnd() < 0.5 ? rnd() * 3 : rnd() * 20)
  }
  return out
}

function clip(D: number): ClipContent {
  const c: ClipContent = { video: pick(['asset://a.mp4', 'asset://a.mp4', 'asset://b.mp4', ' ', '']), parts: parts(D, pick([3, 8, 25])) }
  if (rnd() < 0.1) delete (c as Partial<ClipContent>).video
  c.hook = pick([undefined, '', ' ', 'Drei Wörter hier', 'eins zwei drei vier fünf sechs sieben acht neun zehn'])
  c.post = pick([undefined, ' ', 'Titel\nSatz. #a #b #c'])
  c.captions = pick([undefined, 'wort', 'satz', 'aus'])
  c.pauses = pick([undefined, 'kurz', 'lassen'])
  c.style = pick([undefined, 'ruhig', 'lebendig'])
  c.cover = maybe(0.3, () => r2(rnd() * (D + 40) - 10))
  const ov: Overlay[] = Array.from({ length: pick([0, 0, 1, 3, 6]) }, () => {
    const start = r2(rnd() * D), o: Overlay = { start, end: r2(start + 0.5 + rnd() * 14) }
    if (rnd() < 0.7) o.art = pick(ARTS)
    if (rnd() < 0.6) o.text = pick(['Anna', 'Anna, Hamburg', LONG, ' ', 'Ein sehr langer Text, der viel zu viel sagt'])
    if (rnd() < 0.2) o.sub = pick(['Leiterin', LONG])
    if (rnd() < 0.2) o.image = pick(['asset://logo.png', ''])
    if (rnd() < 0.1) o.video = 'asset://b.mp4'
    if (rnd() < 0.15) o.slide = pick([0, 1, 2, 3, 4, 9, 1.5])
    if (rnd() < 0.4) o.pos = pick(POS)
    return o
  })
  if (ov.length) c.overlays = ov
  return c
}

const transcripts = Array.from({ length: 60 }, () => transcript(int(40, 260)))
for (const t of transcripts) retakes(t)
for (let k = 0; k < 220; k++) {
  const t = pick(transcripts), D = t.duration
  const info: ClipInfo = {}
  const tr = rnd()
  if (tr < 0.75) info.transcript = t
  else if (tr < 0.85) info.transcript = null
  const du = rnd()
  if (du < 0.5) info.duration = D
  else if (du < 0.6) info.duration = 0
  else if (du < 0.7) info.duration = D - 10
  if (rnd() < 0.3) info.music = Array.from({ length: Math.floor(D) - int(0, 5) }, () => (rnd() < 0.2 ? r2(0.1 + rnd() * 0.7) : 0.05))
  if (rnd() < 0.4) info.deckMusic = rnd() < 0.5
  if (rnd() < 0.3) info.slides = [{ layout: 'clip' }, { layout: 'kpi-grid', hidden: true }, { layout: 'chart' }, { layout: 'title', hidden: false }]
  const others = Array.from({ length: pick([0, 0, 2, 4]) }, () => ({ video: pick(['asset://a.mp4', 'asset://b.mp4']), parts: parts(D, 5) }))
  const self = others.length && rnd() < 0.5 ? int(0, others.length - 1) : undefined
  const size = pick([{ w: 720, h: 1280 }, { w: 1280, h: 720 }, { w: 1080, h: 1080 }, { w: 1080, h: 1350 }])
  lintClip(clip(D), size, info, others, self)
}
for (let k = 0; k < 60; k++) {
  const t = pick(transcripts)
  snapToWords(parts(t.duration, 10), t, pick([undefined, 0.15, 0.4, 1, 100]))
}

// Suche: Zitate (exakt, ein Wort getauscht, verdreht), Themen, Stoppwörter, leer
for (let k = 0; k < 120; k++) {
  const t = pick(transcripts)
  const all = t.segments.flatMap((s) => s.text.split(' '))
  const a = int(0, Math.max(0, all.length - 8)), q = all.slice(a, a + int(1, 8))
  const mode = rnd()
  let query = q.join(' ')
  if (mode < 0.25) { q[int(0, q.length - 1)] = pick(VOCAB); query = q.join(' ') }
  else if (mode < 0.35) query = [...q].reverse().join(' ')
  else if (mode < 0.55) query = Array.from({ length: int(1, 3) }, () => pick(VOCAB)).join(' ')
  else if (mode < 0.6) query = pick(['der die das', '  ', '', 'zzzzqq', 'GRÖSSE strasse', 'ÄPFEL, und!'])
  searchTranscript(t, query, pick([1, 3, 8]))
}

// Überblick: Fenster, Lautheit mit Stille, Chat, Ereignisse, Heatmap, covered
for (let k = 0; k < 40; k++) {
  const D = pick([0, 45, 180.5, 600, 1800, 3600]), n = Math.ceil(D)
  const s = rnd() < 0.15 ? null : {
    loud: maybe(0.9, () => Array.from({ length: n - int(0, 30) }, (_, i) => (rnd() < 0.05 ? -100 : r2(-30 + rnd() * 6 + (i % 600 < 40 ? 10 : 0))))),
    chat: maybe(0.5, () => Array.from({ length: n }, (_, i) => (rnd() < 0.3 ? int(0, 3) : 0) + (i % 900 < 30 ? 6 : 0))),
    events: maybe(0.5, () => Array.from({ length: n }, () => (rnd() < 0.01 ? 0.9 : r2(rnd() * 0.3)))),
    heat: maybe(0.4, () => Array.from({ length: n }, () => r2(rnd()))),
  }
  const t = rnd() < 0.2 ? null : { ...transcript(Math.min(D, 260) || 10), duration: D }
  overview(t, s, D, pick([90, 90, 30, 5, 60.5, 120, NaN]))
}

// Highlights: bis 2 h, Signale auf 1 Dezimale
for (let k = 0; k < 24; k++) {
  const D = k < 3 ? 7200 : int(200, 1800)
  const loud = Array.from({ length: D }, (_, i) => -28 + rnd() * 6 + (i % 437 < 8 ? 12 : 0))
  const chat = maybe(0.6, () => Array.from({ length: D - int(0, 50) }, (_, i) => (rnd() < 0.3 ? int(0, 2) : 0) + (i % 611 < 10 ? int(3, 9) : 0)))
  const events = maybe(0.4, () => Array.from({ length: D }, () => (rnd() < 0.005 ? 0.9 : rnd() * 0.2)))
  const heat = maybe(0.3, () => Array.from({ length: D }, (_, i) => (i % 1000 < 60 ? 0.8 : rnd() * 0.4)))
  highlights({ loud, chat, events, heat }, pick([{}, { n: 3 }, { len: 60, gap: 10 }, { n: 20, len: 30 }, { len: 5000 }]))
}

// Helfer aus video.ts
for (let k = 0; k < 60; k++) {
  const t = pick(transcripts), s = pick(t.segments)
  const quiet: Quiet[] = Array.from({ length: pick([0, 1, 3]) }, () => { const a = r2(s.start + rnd() * (s.end - s.start + 1) - 0.5); return [a, r2(a + rnd() * 2)] })
  rec('estimateWords', { seg: { start: s.start, end: s.end, text: rnd() < 0.1 ? ' ' : s.text }, quiet }, (i) => estimateWords(i.seg, i.quiet))
  const ps = parts(t.duration, 8), a = r2(rnd() * t.duration), b = r2(a + rnd() * 40)
  rec('clipSpans', { parts: ps, a, b }, (i) => clipSpans(i.parts, i.a, i.b))
  rec('partsLength', { parts: ps }, (i) => partsLength(i.parts))
  rec('mmss', { s: r2(rnd() * 40000) }, (i) => mmss(i.s))
}

const path = 'crates/dw-lint/tests/fixtures/video.json' // aus dem Repo-Wurzelverzeichnis aufrufen
const json = JSON.stringify({ transcripts: [...pool.keys()].map((k) => JSON.parse(k)), ...fx })
writeFileSync(path, json + '\n')
console.log(`${path}: ${(json.length / 1e6).toFixed(2)} MB, ${Object.entries(fx).map(([k, v]) => `${k} ${v.length}`).join(', ')}`)
