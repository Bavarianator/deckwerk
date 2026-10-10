// Clip-Lint (Layout clip): prüft Länge, Schnitte, Transkript, Überschneidungen und Musik, damit sich die KI beim Schneiden selbst korrigiert. Ohne Electron/Node, läuft in Main und Renderer.
import type { Issue } from './lint'
import { retakes } from './retakes'
import { estimateWords, mmss, partsLength, type ClipContent, type Part, type Transcript, type Word } from './video'

export interface ClipInfo { duration?: number | null; transcript?: Transcript | null; music?: number[] } // music: je Quellsekunde 0..1 (Signals.music)
// lintClip kennt die Folie nicht (slide/slideId setzt der Aufrufer); 'info' gibt es nur hier
export type ClipIssue = Omit<Issue, 'slide' | 'slideId' | 'severity'> & { severity: Issue['severity'] | 'info' }

const TOL = 0.05 // s: Kante gilt erst so weit im Wort als Schnitt im Wort
export const SNAP = 0.4 // s: so weit rastet der Export (snapParts) Kanten selbst auf die Wortgrenze
const CALM = 8 // s: länger ohne sichtbaren Schnitt wirkt ein Short zäh
// Musik-Wahrscheinlichkeit (CED) ab der eine Sekunde als Musik zählt. Gemessen (check-sherpa): Sprache allein ≤ 0,05, Musik −12 dB unter Sprache 0,09–0,3, Musik pur 0,35–0,77
export const MUSIC = 0.15
const SENTENCE_END = /[.!?…]["'»«“”‘’)\]]*$/
// Bindewörter verweisen immer auf Vorheriges; Artikel/Pronomen nur mitten im Satz, am Satzanfang sind sie ein normaler Einstieg
const CONJ = new Set(['und', 'aber', 'also', 'dann', 'deshalb', 'weil', 'außerdem', 'denn', 'oder', 'sondern', 'and', 'but', 'because', 'then'])
const PRON = new Set(['die', 'der', 'das', 'es', 'er', 'sie', 'dies', 'this', 'that', 'it', 'he', 'she', 'they'])

const de = (x: number, d = 1) => String(+x.toFixed(d)).replace('.', ',')
const bare = (w: Word) => w.w.replace(/[\p{P}\s]/gu, '').toLowerCase()
const realWords = (t: Transcript) => t.segments.flatMap((s) => s.words ?? [])
const inWord = (ws: Word[], x: number, tol = TOL) => ws.find((w) => w.start + tol < x && x < w.end - tol)
const valid = (p: Part) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.start >= 0 && p.end > p.start

// Teile von a–b, die nicht in t.covered liegen (covered fehlt = ganzes Video, kein Transkript = alles)
function gaps(t: Transcript | null | undefined, a: number, b: number): [number, number][] {
  if (!t) return [[a, b]]
  if (!t.covered) return []
  const out: [number, number][] = []
  let x = a
  for (const [s, e] of t.covered) {
    if (e <= x || s >= b) continue
    if (s > x + TOL) out.push([x, s])
    x = Math.max(x, e)
  }
  if (x < b - TOL) out.push([x, b])
  return out
}

/** Kanten, die in einem Wort liegen, auf die Wortgrenze legen (Start vor das Wort, Ende hinter das Wort), höchstens max s weit. Nur echte Wortzeiten.
 *  Nahtlose Schnitte (part beginnt, wo der vorige endet, wie seamless im Export) bleiben: eingerastet überlappten beide um das Wort, es liefe doppelt. */
export function snapToWords(parts: Part[], t: Transcript, max = SNAP): { parts: Part[]; moved: { i: number; edge: 'start' | 'end'; from: number; to: number }[] } {
  const ws = realWords(t)
  const moved: { i: number; edge: 'start' | 'end'; from: number; to: number }[] = []
  const joined = (j: number) => j > 0 && j < parts.length && Math.abs(parts[j - 1].end - parts[j].start) < 1e-3
  const out = parts.map((p, i) => {
    const q = { ...p }
    for (const edge of ['start', 'end'] as const) {
      if (joined(edge === 'start' ? i : i + 1)) continue
      const w = inWord(ws, p[edge])
      if (!w) continue
      const to = edge === 'start' ? w.start : w.end
      if (Math.abs(to - p[edge]) > max) continue
      moved.push({ i, edge, from: p[edge], to })
      q[edge] = to
    }
    return q
  })
  return { parts: out, moved }
}

type Hit = { msg: string; ex: string }

/** Prüft eine clip-Folie. others: clip-Folien des Decks in Reihenfolge („Clip n“ = others[n-1]), self: Index der geprüften darin. */
export function lintClip(c: ClipContent, size: { w: number; h: number }, info: ClipInfo, others: { video: string; parts: Part[] }[] = [], self?: number): ClipIssue[] {
  const out: ClipIssue[] = []
  const add = (severity: ClipIssue['severity'], rule: string, message: string) => out.push({ severity, rule, message })
  // Je Regel eine Meldung: ein Treffer ausführlich, mehrere gebündelt mit höchstens 3 Beispielen (ganzes Video kürzen: bis 100 parts)
  const bundle = (rule: string, hits: Hit[], head: string, tail: string, severity: ClipIssue['severity'] = 'warn') => {
    if (hits.length === 1) add(severity, rule, hits[0].msg)
    else if (hits.length) add(severity, rule, `${hits.length} ${head}: ${hits.slice(0, 3).map((h) => h.ex).join(', ')}${hits.length > 3 ? ' …' : ''} – ${tail}`)
  }
  const n = (i: number) => `Ausschnitt ${i + 1}`
  const t = info.transcript
  const dur = info.duration || t?.duration || 0
  const short = size.w <= size.h
  const all = c.parts ?? []
  const use = all.map((p, i) => ({ p, i })).filter(({ p }) => valid(p)) // i = Nummer in c.parts, für die Meldungen
  const bad = all.flatMap((p, i) => (valid(p) ? [] : [i + 1]))

  if (!c.video?.trim()) add('error', 'clip-video', 'Kein Video gesetzt – Pfad aus dem Anhang in video eintragen')
  if (bad.length) add('warn', 'clip-zeit', `${bad.length > 1 ? 'Ausschnitte' : 'Ausschnitt'} ${bad.join(', ')} ohne gültige Zeiten (start ≥ 0, end nach start) – Zeiten aus dem Transkript nehmen`)

  if (dur > 0) for (const { p, i } of use) {
    if (p.start >= dur) add('error', 'clip-ende', `${n(i)} beginnt bei ${de(p.start)} s, das Video ist nur ${de(dur)} s lang – Zeiten aus dem Transkript nehmen`)
    else if (p.end > dur + TOL) add('warn', 'clip-ende', `${n(i)} endet bei ${de(p.end)} s, nach dem Videoende (${de(dur)} s) – wird gekappt`)
  }

  const len = partsLength(use.map((u) => u.p))
  const lenTxt = c.pauses === 'kurz' ? `Quellmaterial ${de(len)} s, ohne Pausen kürzer` : `Länge ${de(len)} s`
  if (short && (len < 20 || len > 90)) add('warn', 'clip-laenge', `${lenTxt} – für einen Short 20–90 s; ${len > 90 ? 'kürzen' : 'verlängern'}`)
  else if (short && (len < 55 || len > 75)) add('info', 'clip-laenge', `${lenTxt} – ideal für einen Short 55–75 s`)

  // Nahtlos anschließende parts zeigen keinen Schnitt, sie laufen als ein Stück; lebendig wechselt den Zoom nur an Schnitten
  if (short) {
    const runs: { i: number; len: number }[] = []
    use.forEach(({ p, i }, k) => {
      const prev = use[k - 1]
      if (prev && Math.abs(prev.p.end - p.start) < 1e-3) runs[runs.length - 1].len += p.end - p.start
      else runs.push({ i, len: p.end - p.start })
    })
    const fix = c.style === 'lebendig' ? 'teilen (Füllsatz raus)' : 'teilen (Füllsatz raus) oder style lebendig für Zoom-Wechsel'
    bundle('clip-ruhe', runs.filter((r) => r.len > CALM).map((r) => ({ msg: `${n(r.i)} läuft ${de(r.len)} s ohne Schnitt – ${fix}`, ex: `${r.i + 1} (${de(r.len)} s)` })),
      `von ${runs.length} Stücken laufen über ${CALM} s ohne Schnitt`, fix, 'info')
  }

  // Ohne Transkript: nur bis zum Videoende, Lücken unter 0,5 s zählen nicht
  const missing = (p: Part) => gaps(t, p.start, dur > 0 ? Math.min(p.end, dur) : p.end).filter(([a, b]) => b - a >= 0.5)

  if (t) {
    const real = realWords(t)
    const cut = new Set<string>() // Kanten mitten im Wort: dort keine zweite Meldung zur Satzgrenze
    bundle('clip-wort', snapToWords(use.map((u) => u.p), t, Infinity).moved.flatMap((m) => {
      const w = inWord(real, m.from)
      if (!w || Math.abs(m.to - m.from) <= SNAP) return [] // bis SNAP rastet der Export die Kante selbst ein
      const i = use[m.i].i, start = m.edge === 'start', edge = start ? 'Start' : 'Ende'
      cut.add(i + m.edge)
      return [{ msg: `${n(i)} ${start ? 'beginnt' : 'endet'} mitten in „${w.w.trim()}“ – ${edge} auf ${de(m.to, 2)} s legen`, ex: `${i + 1} ${edge} → ${de(m.to, 2)} s` }]
    }), `von ${use.length * 2} Schnitten liegen mitten im Wort`, 'Kanten auf die Vorschläge legen')

    // Satz- und Einstiegsprüfung auch mit geschätzten Wortzeiten (Segmente ohne words), wie clipWords
    const words = t.segments.flatMap((s) => s.words?.length ? s.words : estimateWords(s))
    const weak: Hit[] = [], open: Hit[] = [], quiet: Hit[] = []
    use.forEach(({ p, i }, k) => {
      if (missing(p).length) return
      const ws = words.filter((w) => (w.start + w.end) / 2 >= p.start && (w.start + w.end) / 2 < p.end)
      if (!ws.length) return
      const first = ws[0], last = ws[ws.length - 1]
      // Querformat (ganzes Video kürzen): Schnitte dazwischen sind gewollt, nur Anfang und Ende des Clips zählen
      if (short || k === 0) {
        const prev = words[words.indexOf(first) - 1], b = bare(first)
        if (!cut.has(i + 'start') && (CONJ.has(b) || (PRON.has(b) && prev && !SENTENCE_END.test(prev.w.trim()))))
          weak.push({ msg: `${n(i)} beginnt mit „${first.w.trim()}“ – Start früher legen, damit der Clip für sich steht`, ex: `${i + 1} (ab ${de(p.start)} s „${first.w.trim()}“)` })
        const g = first.start - p.start
        if (g > 0.8) quiet.push({ msg: `${n(i)}: Stille am Anfang (${de(g)} s) – Start auf ${de(first.start, 2)} s legen`, ex: `${i + 1} (${de(g)} s, Start auf ${de(first.start, 2)} s)` })
      }
      if ((short || k === use.length - 1) && !cut.has(i + 'end') && !SENTENCE_END.test(last.w.trim()))
        open.push({ msg: `${n(i)} endet ohne Satzende („…${ws.slice(-3).map((w) => w.w.trim()).join(' ')}“) – Ende hinter das Satzende legen`, ex: `${i + 1} (bis ${de(p.end)} s)` })
    })
    bundle('clip-satz', weak, `von ${use.length} Ausschnitten beginnen mitten im Gedanken`, 'Start früher legen, damit jeder für sich steht')
    bundle('clip-satz', open, `von ${use.length} Ausschnitten enden ohne Satzende`, 'Enden hinter das Satzende legen')
    bundle('clip-einstieg', quiet, `von ${use.length} Ausschnitten beginnen mit Stille`, 'Start auf das erste Wort legen')

    // Neuansatz: erster Anlauf läuft (über die Hälfte) mit, und der neue auch – dann hört man den Satz zweimal
    const inParts = (a: number, b: number) => use.reduce((s, { p }) => s + Math.max(0, Math.min(b, p.end) - Math.max(a, p.start)), 0)
    bundle('clip-neuansatz', retakes(t).flatMap((r) => {
      const [a, b] = r.drop, k = use.find(({ p }) => p.start <= r.keep && r.keep < p.end)
      if (!k || inParts(a, b) <= (b - a) / 2) return []
      return [{ msg: `${n(k.i)} enthält einen Neuansatz („${r.text}“) – ${de(a, 2)}–${de(b, 2)} s herausschneiden`, ex: `${k.i + 1} (${de(a, 2)}–${de(b, 2)} s)` }]
    }), 'Neuansätze in den Ausschnitten', 'jeweils den ersten Anlauf herausschneiden')
  }

  if (c.captions !== 'aus') {
    // Lücken unter 10 s zusammenfassen: ein transcribe_video mit from/to statt vieler kleiner
    const miss = use.flatMap(({ p }) => missing(p)).sort((a, b) => a[0] - b[0])
      .reduce<[number, number][]>((o, g) => {
        const l = o[o.length - 1]
        if (l && g[0] - l[1] < 10) l[1] = Math.max(l[1], g[1])
        else o.push([g[0], g[1]])
        return o
      }, [])
    if (miss.length) add('warn', 'clip-transkript', `Kein Transkript für ${miss.map(([a, b]) => `${Math.floor(a)}–${Math.ceil(b)} s`).join(', ')}: erst transcribe_video mit from/to, sonst keine Untertitel`)
  }

  const overlap = (a: Part, b: Part) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
  bundle('clip-overlap', use.flatMap((a, k) => use.slice(k + 1).flatMap((b) => {
    const o = overlap(a.p, b.p)
    return o > TOL ? [{ msg: `${n(a.i)} und ${b.i + 1} überschneiden sich (${de(o)} s) – Bereiche trennen, sonst läuft die Stelle doppelt`, ex: `${a.i + 1}/${b.i + 1} (${de(o)} s)` }] : []
  })), 'Paare von Ausschnitten überschneiden sich', 'Bereiche trennen, sonst laufen Stellen doppelt')
  others.forEach((x, k) => {
    if (k === self || x.video !== c.video) return
    const o = use.reduce((s, a) => s + x.parts.filter(valid).reduce((s2, b) => s2 + overlap(a.p, b), 0), 0)
    if (o > 5) add('warn', 'clip-overlap', `überschneidet sich ${de(o, 0)} s mit Clip ${k + 1} (gleiches Video) – andere Stelle wählen`)
  })

  // Fremde Hintergrundmusik bringt Copyright-Strikes; volle Quellsekunden zählen je einmal, auch in überlappenden Ausschnitten
  if (info.music) {
    const secs = new Set<number>()
    let first = Infinity // Schleife statt Math.min(...secs): Spread sprengt bei sehr vielen Sekunden den Stack
    for (const { p } of use) for (let s = Math.ceil(p.start); s < Math.min(Math.floor(p.end), info.music.length); s++) if (info.music[s] >= MUSIC) { secs.add(s); first = Math.min(first, s) }
    if (secs.size >= 5) add('warn', 'clip-musik', `Musik im Hintergrund (${secs.size} s, u. a. bei ${mmss(first)}) – bei fremder Musik droht ein Copyright-Strike; Stelle meiden oder Musik prüfen`)
  }

  const hookWords = c.hook?.trim().split(/\s+/).filter(Boolean).length ?? 0
  if (short && !hookWords) add('info', 'clip-hook', 'Kein Hook – für Shorts eine Einstiegszeile setzen (3–9 Wörter)')
  if (hookWords > 9) add('info', 'clip-hook', `Hook hat ${hookWords} Wörter – kürzer (3–9 Wörter)`)
  if (short && !c.post?.trim()) add('info', 'clip-post', 'Kein Post-Text – post mit Titel, 1–2 Sätzen und 3–5 Hashtags setzen')
  if (c.cover != null && (!Number.isFinite(c.cover) || c.cover < 0 || (dur > 0 && c.cover > dur))) add('warn', 'clip-post', `cover bei ${de(c.cover)} s liegt nicht im Video${dur > 0 ? ` (0–${de(dur)} s)` : ''} – Sekunde aus dem Kontaktabzug nehmen`)
  return out
}

// Selbstprüfung: npx esbuild src/shared/clip-lint.ts --bundle --platform=node | DW_CLIP_LINT_SELFTEST=1 node
if (typeof process !== 'undefined' && process.env.DW_CLIP_LINT_SELFTEST) {
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
  eq(msgs(lintClip({ ...ok, pauses: 'kurz', parts: [{ start: 0, end: 96 }] }, tall, { transcript: clean }), 'clip-laenge'), ['Quellmaterial 96 s, ohne Pausen kürzer – für einen Short 20–90 s; kürzen'], 'Länge pauses kurz')
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
  console.log('clip-lint ok')
}
