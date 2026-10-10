// Highlights in langen Videos und Streams aus Signalen je Sekunde. Rein (ohne Node/Electron), läuft in Main und Tests.
// Verfahren angelehnt an HotClip und die Literatur zu Twitch-Highlights (Chat-Ausbrüche, verzögerte Reaktion):
// robuster z-Wert je Signal gegen gleitenden Median/MAD, gewichtete Summe, Spitzen → Fenster → Top-n ohne Überlappung.

export interface Signals { loud: number[]; chat?: number[]; events?: number[]; heat?: number[]; music?: number[] } // je Sekunde: RMS dBFS (−100 = still), Chat-Gewicht (Nachrichten, Emotes zählen doppelt), Ereignis-Wahrscheinlichkeit 0..1 (Lachen/Jubel/Schreien/Applaus), YouTube-Heatmap 0..1, Musik-Wahrscheinlichkeit 0..1 (für den Clip-Lint, nicht für Highlights)
export interface Highlight { start: number; end: number; score: number; why: string } // why kurz deutsch, z. B. „Chat ×4,2 · Lachen/Jubel · laut +9 dB · oft gesehen“

const BLOCK = 60, BLOCKS = 10 // Median je 60-s-Block, gleitend über 10 Blöcke = 10 min
const LOUD_SMOOTH = 1 // Lautheit über ±1 s (3 s) mitteln
const CHAT_DELAY = 15, CHAT_SUM = 10 // Zuschauer reagieren ~15 s später; Chat über 10 s summieren
const MIN_SCALE = { loud: 1, chat: 2 } // Untergrenze für 1,4826·MAD (dB bzw. Chat-Gewicht), sonst teilt ein stiller Abschnitt durch 0
const Z_MAX = 8 // ein Ausreißer (Ton nach digitaler Stille, Spam) überstimmt nicht alles
const W = { chat: 1, loud: 0.6, events: 2, heat: 1.5 } // Chat zählt mehr als Lautheit; Ereignisse und Heatmap als Bonus
const MIN_SCORE = 1.5, MERGE = 12 // Spitzen ab diesem Score; näher als 12 s = ein Moment

const median = (v: number[]) => {
  const s = Float64Array.from(v).sort(), m = s.length >> 1 // Typed-Array-Sortierung ist numerisch und schneller
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Summe (bzw. Mittel) von x[i+a … i+b] je i, an den Rändern gekürzt
function win(x: number[], a: number, b: number, mean = false): number[] {
  const n = x.length, pre = [0]
  for (const v of x) pre.push(pre[pre.length - 1] + v)
  return x.map((_, i) => {
    const lo = Math.min(n, Math.max(0, i + a)), hi = Math.min(n, Math.max(0, i + b + 1))
    return mean ? (hi > lo ? (pre[hi] - pre[lo]) / (hi - lo) : 0) : pre[hi] - pre[lo]
  })
}

/** z = (x − Median) / (1,4826·MAD) gegen das 10-min-Umfeld. ponytail: Median der Block-Mediane statt echtem gleitendem Median
 *  (8 h = 480 Blöcke statt 28 800 Sortierungen über 600 Werte); Stufen an Blockgrenzen. Echt gleitend per Zwei-Heap, falls das stört. */
function robustZ(x: number[], minScale: number): { z: number[]; med: number[] } {
  const nb = Math.ceil(x.length / BLOCK), meds: number[] = [], mads: number[] = []
  for (let b = 0; b < nb; b++) {
    const v = x.slice(b * BLOCK, (b + 1) * BLOCK), m = median(v)
    meds.push(m)
    mads.push(median(v.map((y) => Math.abs(y - m))))
  }
  const z: number[] = [], med: number[] = []
  for (let b = 0; b < nb; b++) {
    const lo = Math.max(0, Math.min(b - BLOCKS / 2, nb - BLOCKS)), hi = Math.min(nb, lo + BLOCKS)
    const m = median(meds.slice(lo, hi)), scale = Math.max(minScale, 1.4826 * median(mads.slice(lo, hi)))
    for (let i = b * BLOCK; i < Math.min(x.length, (b + 1) * BLOCK); i++) z.push((x[i] - m) / scale), med.push(m)
  }
  return { z, med }
}

const de = (n: number) => n.toFixed(1).replace('.', ',')

/** Die n stärksten Momente: Fenster von len s um die Spitze (60 % davor, 40 % danach), mindestens gap s auseinander, zeitlich sortiert. */
export function highlights(s: Signals, o: { len?: number; n?: number; gap?: number } = {}): Highlight[] {
  const { len = 90, n = 8, gap = 30 } = o // len: Fenster für ein Reel von gut einer Minute samt Anlauf
  const dur = s.loud.length
  const fill = (x: number[]) => Array.from({ length: dur }, (_, i) => (Number.isFinite(x[i]) ? x[i] : 0)) // NaN vergiftete sonst alle Präfixsummen
  const clamp = (z: number) => Math.min(Z_MAX, Math.max(0, z))
  // −Infinity (ffmpeg bei digitaler Stille) machte alle Präfixsummen danach zu NaN
  const loud = win(s.loud.map((v) => (Number.isFinite(v) ? Math.max(-100, v) : -100)), -LOUD_SMOOTH, LOUD_SMOOTH, true), L = robustZ(loud, MIN_SCALE.loud)
  const chat = s.chat && win(fill(s.chat), CHAT_DELAY - CHAT_SUM / 2, CHAT_DELAY + CHAT_SUM / 2 - 1), C = chat && robustZ(chat, MIN_SCALE.chat)
  const ev = s.events && fill(s.events), heat = s.heat && fill(s.heat)
  const score = loud.map((_, i) => W.loud * clamp(L.z[i]) + (C ? W.chat * clamp(C.z[i]) : 0) + (ev ? W.events * ev[i] : 0) + (heat ? W.heat * heat[i] : 0))

  // Spitzen: lokale Maxima über MIN_SCORE; Spitzen näher als MERGE zu einer zusammenlegen, die höchste bleibt
  const peaks: number[] = []
  let prev = -Infinity
  for (let i = 0; i < dur; i++) {
    if (score[i] < MIN_SCORE || score[i] < (score[i - 1] ?? -Infinity) || score[i] < (score[i + 1] ?? -Infinity)) continue
    if (i - prev < MERGE) { if (score[i] > score[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i } else peaks.push(i)
    prev = i
  }

  const out: (Highlight & { p: number })[] = []
  for (const p of peaks.sort((a, b) => score[b] - score[a])) {
    if (out.length >= n) break
    const start = Math.max(0, Math.min(dur - len, p - 0.6 * len)), end = Math.min(dur, start + len) // am Rand verschieben statt kürzen
    if (out.some((h) => start < h.end + gap && end > h.start - gap)) continue
    const why = [
      C && C.z[p] >= 1 && (C.med[p] >= 1 ? `Chat ×${de(chat![p] / C.med[p])}` : `Chat ${Math.round(chat![p])} in 10 s`),
      ev && ev[p] >= 0.5 && 'Lachen/Jubel',
      loud[p] - L.med[p] >= 3 && `laut +${Math.round(loud[p] - L.med[p])} dB`,
      heat && heat[p] >= 0.5 && 'oft gesehen',
    ].filter(Boolean).join(' · ')
    out.push({ start, end, score: +score[p].toFixed(2), why: why || 'mehrere Signale leicht erhöht', p })
  }
  return out.sort((a, b) => a.start - b.start).map(({ p: _, ...h }) => h)
}

// Selbstprüfung: npx esbuild src/shared/highlights.ts --bundle --platform=node | DW_HIGHLIGHTS_SELFTEST=1 node
if (typeof process !== 'undefined' && process.env.DW_HIGHLIGHTS_SELFTEST) {
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const noise = (n: number, base: number, amp: number) => Array.from({ length: n }, () => base + (rnd() - 0.5) * 2 * amp)
  const inside = (h: Highlight | undefined, t: number) => !!h && h.start <= t && t <= h.end

  // (a) Rauschen + Chat-Spitze bei 1015 s → Top-1 enthält 1000 s
  const chat = Array.from({ length: 3600 }, () => (rnd() < 0.3 ? 1 : 0))
  for (let i = 1015; i < 1025; i++) chat[i] += 8
  const a = highlights({ loud: noise(3600, -25, 2), chat }, { n: 1 })
  if (!inside(a[0], 1000) || !a[0].why.startsWith('Chat ×')) throw new Error('(a) ' + JSON.stringify(a))

  // (b) gleich laute Spitzen bei 300 und 800 s, nur bei 800 Lachen → 800 gewinnt
  const loud = noise(1200, -25, 2), events = new Array(1200).fill(0)
  for (let i = 0; i < 6; i++) loud[300 + i] = loud[800 + i] = -13, events[800 + i] = 0.9
  const b = highlights({ loud, events }, { n: 1 })
  if (!inside(b[0], 802) || !b[0].why.includes('Lachen')) throw new Error('(b) ' + JSON.stringify(b))

  // (c) viele Spitzen: keine Überlappung, Abstand ≥ gap, zeitlich sortiert
  const many = chat.slice()
  for (let t = 100; t < 3500; t += 45) for (let i = 0; i < 5; i++) many[t + i] += 4 + (t % 7)
  const c = highlights({ loud: noise(3600, -25, 2), chat: many }, { n: 8, gap: 30 })
  if (c.length !== 8 || c.some((h, i) => i && h.start < c[i - 1].end + 30)) throw new Error('(c) ' + JSON.stringify(c))

  // (d) nur Lautheit
  const d = highlights({ loud })
  if (!d.some((h) => inside(h, 302)) || !d.some((h) => inside(h, 802)) || d.some((h) => !Number.isFinite(h.score))) throw new Error('(d) ' + JSON.stringify(d))

  // (e) 8 h mit allen Signalen < 1 s
  const N = 28800, big = { loud: noise(N, -25, 3), chat: Array.from({ length: N }, () => Math.floor(rnd() * 6)), events: noise(N, 0.1, 0.1), heat: noise(N, 0.3, 0.3) }
  const c0 = process.cpuUsage(), e = highlights(big), cpu = process.cpuUsage(c0), ms = Math.round((cpu.user + cpu.system) / 1000) // CPU-Zeit: Wanduhr schwankt mit der Last
  if (ms >= 1000 || !e.length) throw new Error(`(e) ${ms} ms`)
  console.log(`highlights ok (8 h in ${ms} ms CPU)`)
}
