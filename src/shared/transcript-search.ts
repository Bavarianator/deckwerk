// Stellen im Transkript finden (Zitat, Thema) und lange Videos grob überblicken. Rein (ohne Node/Electron), läuft in Main und Tests.
import { estimateWords, mmss, type Transcript } from './video'

export interface Hit { start: number; end: number; text: string; score: number; seg: number }

const QUOTE = 100 // exakter Zitat-Treffer; Fast-Treffer liegen darunter (50–90), BM25-Werte sind eine eigene Skala
const STOP = new Set(('der die das den dem des ein eine einen einem einer und oder aber nicht ist sind war es er sie wir ihr ich du zu im in an auf mit von für auch dass wie so noch nur ja nein ' +
  'the a an and or but not is are was it he she we you i to of in on at for with that this as so be').split(' '))

// klein, Umlaute/ß gefaltet, alles außer Buchstaben und Ziffern weg
const fold = (s: string) => s.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '')
// Wortschatz ist klein, die Regex-Faltung teuer: je Rohwort einmal (8 h = 70 000 Wörter)
const memo = <V>(f: (w: string) => V) => { const c = new Map<string, V>(); return (w: string) => { let r = c.get(w); if (r === undefined) { if (c.size > 50000) c.clear(); c.set(w, r = f(w)) } return r } }
const norm = memo((s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, ''))
// ponytail: Mini-Stemmer (eine Endung ab), fängt Fälle/Mehrzahl; echter Stemmer, falls Treffer bei Beugung fehlen
const stem = (k: string) => k.length > 5 ? k.replace(/(en|er|es|e|n|s)$/, '') : k
const term = memo((w: string) => { const k = norm(w); return STOP.has(k) ? '' : stem(k) })
const terms = (s: string) => s.split(/[^\p{L}\p{N}\p{M}]+/u).map(term).filter(Boolean)

/** Zitat: q als Wortfolge; exakt (100) oder mit 1–2 anderen Wörtern (Ordnung egal, 50–90). */
function quote(t: Transcript, q: string[], n: number): Hit[] {
  const m = q.length
  if (!m) return []
  // billiger Vorfilter: ohne genug Zitatwörter im Transkript lohnt das Schätzen der Wortzeiten nicht
  const have = new Set<string>()
  for (const s of t.segments) for (const w of s.words?.length ? s.words.map((x) => x.w) : s.text.split(/\s+/)) have.add(norm(w))
  if (q.filter((k) => have.has(k)).length < Math.max(m - 2, Math.ceil(m * 0.7))) return []
  const tok: string[] = [], ws: { w: { w: string; start: number; end: number }; seg: number }[] = []
  t.segments.forEach((s, seg) => {
    for (const w of s.words?.length ? s.words : estimateWords(s)) { const k = norm(w.w); if (k) { tok.push(k); ws.push({ w, seg }) } }
  })
  const qc = new Map<string, number>()
  for (const k of q) qc.set(k, (qc.get(k) ?? 0) + 1)
  const need = Math.max(m - 2, Math.ceil(m * 0.7))
  const cand: { i: number; j: number; score: number }[] = []
  for (let i = 0; i < tok.length; i++) {
    if (!qc.has(tok[i])) continue
    if (i + m <= tok.length && q.every((k, d) => tok[i + d] === k)) { cand.push({ i, j: i + m - 1, score: QUOTE }); continue }
    if (m < 4) continue // kürzere Zitate nur wörtlich, sonst trifft jeder Zufall
    let best: (typeof cand)[number] | null = null
    for (let L = Math.max(need, m - 2); L <= m + 2; L++) {
      const j = i + L - 1
      if (j >= tok.length || !qc.has(tok[j])) continue
      const left = new Map(qc)
      let hit = 0
      for (let k = i; k <= j; k++) { const c = left.get(tok[k]); if (c) { left.set(tok[k], c - 1); hit++ } }
      const score = 50 + (40 * hit) / Math.max(m, L)
      if (hit >= need && (!best || score > best.score)) best = { i, j, score }
    }
    if (best) cand.push(best)
  }
  const out: typeof cand = []
  for (const c of cand.sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (out.length >= n) break
    if (!out.some((o) => c.i <= o.j && o.i <= c.j)) out.push(c)
  }
  return out.map((c) => ({ start: ws[c.i].w.start, end: ws[c.j].w.end, text: ws.slice(c.i, c.j + 1).map((x) => x.w.w.trim()).join(' '), score: c.score, seg: ws[c.i].seg }))
}

/** Thema: BM25 über Segmente, Nachbarn ±1 gehen mit 0,3 in den Score ein und in den Treffer als Kontext. */
function bm25(t: Transcript, query: string, n: number): Hit[] {
  const segs = t.segments
  let q = terms(query)
  if (!q.length) return [] // nur Stoppwörter gefragt: die Dokumente kennen keine Stoppwörter, Zitate fand searchTranscript schon vorher
  q = [...new Set(q)]
  const docs = segs.map((s) => terms(s.text.trim() || (s.words ?? []).map((w) => w.w).join(' ')))
  const N = docs.length, avg = docs.reduce((a, d) => a + d.length, 0) / (N || 1) || 1
  const tf = docs.map((d) => { const m = new Map<string, number>(); for (const k of d) m.set(k, (m.get(k) ?? 0) + 1); return m })
  const raw = new Array<number>(N).fill(0)
  for (const k of q) {
    const df = tf.reduce((a, m) => a + (m.has(k) ? 1 : 0), 0)
    if (!df) continue
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
    tf.forEach((m, i) => { const f = m.get(k); if (f) raw[i] += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].length / avg)) })
  }
  const sc = raw.map((v, i) => v + 0.3 * ((raw[i - 1] ?? 0) + (raw[i + 1] ?? 0)))
  const out: Hit[] = []
  for (const i of sc.map((_, i) => i).filter((i) => raw[i] > 0).sort((a, b) => sc[b] - sc[a])) {
    if (out.length >= n) break
    if (out.some((h) => Math.abs(h.seg - i) <= 2)) continue
    const a = Math.max(0, i - 1), b = Math.min(N - 1, i + 1)
    out.push({ start: segs[a].start, end: segs[b].end, text: segs.slice(a, b + 1).map((s) => s.text.trim()).join(' '), score: sc[i], seg: i })
  }
  return out
}

/** Zitat zuerst (Wortzeiten), sonst Thema per BM25. */
export function searchTranscript(t: Transcript, query: string, n = 8): Hit[] {
  const q = query.split(/\s+/).map(norm).filter(Boolean)
  if (!q.length) return []
  const hits = quote(t, q, n)
  return hits.length ? hits : bm25(t, query, n)
}

const median = (v: number[]) => {
  const s = Float64Array.from(v).sort(), m = s.length >> 1
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0
}
// z gegen Median/MAD aller Fenster, Untergrenze für die Streuung, damit ein gleichmäßiger Verlauf nichts meldet
const z = (x: number, all: number[], minScale: number) => {
  const m = median(all)
  return (x - m) / Math.max(1.4826 * median(all.map((v) => Math.abs(v - m))), minScale)
}

/** Eine Zeile je Fenster (win s): Zeit, auffällige Signale, Anfang des Gesagten. */
export function overview(t: Transcript | null, s: { loud?: number[]; chat?: number[]; events?: number[]; heat?: number[] } | null, duration: number, win = 90): string[] {
  if (!(win >= 10)) win = 90 // Unsinn oder winzige Fenster (median je Fenster wäre quadratisch) auf den Standard
  const n = Math.max(0, Math.ceil(duration / win))
  const slice = (x: number[] | undefined, k: number) => x?.slice(k * win, Math.min(duration, (k + 1) * win)) ?? []
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / (v.length || 1)
  const loud = Array.from({ length: n }, (_, k) => { const v = slice(s?.loud, k).filter((d) => d > -100); return v.length ? mean(v) : NaN }) // −100 = still
  const chat = Array.from({ length: n }, (_, k) => slice(s?.chat, k).reduce((a, b) => a + b, 0))
  const loudAll = loud.filter((v) => !isNaN(v)), chatMed = median(chat)
  const words: string[][] = Array.from({ length: n }, () => [])
  for (const sg of t?.segments ?? []) {
    const k = Math.floor(sg.start / win)
    if (k >= 0 && k < n && words[k].length < 13) words[k].push(...sg.text.trim().split(/\s+/).filter(Boolean))
  }
  return Array.from({ length: n }, (_, k) => {
    const a = k * win, b = Math.min(duration, a + win)
    const parts = [`${mmss(a)}–${mmss(b)}`]
    if (loudAll.length > 2 && !isNaN(loud[k]) && z(loud[k], loudAll, 1) >= 2 && loud[k] - median(loudAll) >= 3) parts.push(`laut +${Math.round(loud[k] - median(loudAll))} dB`)
    if (s?.chat && chat[k] > 0 && z(chat[k], chat, 2) >= 2 && chat[k] >= 2 * Math.max(chatMed, 1)) parts.push(`Chat ×${Math.round(chat[k] / Math.max(chatMed, 1))}`)
    if (Math.max(0, ...slice(s?.events, k)) >= 0.6) parts.push('Lachen/Jubel')
    if (s?.heat && mean(slice(s.heat, k)) >= 0.7) parts.push('oft gesehen')
    if (words[k].length) parts.push(`„${words[k].slice(0, 12).join(' ').slice(0, 100)}${words[k].length > 12 ? ' …' : ''}“`)
    else parts.push(!t || (t.covered && !t.covered.some(([x, y]) => x < b && y > a)) ? '(noch kein Transkript)' : '(keine Sprache)')
    return parts.join(' · ')
  })
}

// Selbstprüfung: npx esbuild src/shared/transcript-search.ts --bundle --platform=node | DW_SEARCH_SELFTEST=1 node
if (typeof process !== 'undefined' && process.env.DW_SEARCH_SELFTEST) {
  const ok = (c: unknown, m: string) => { if (!c) throw new Error(m) }
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
