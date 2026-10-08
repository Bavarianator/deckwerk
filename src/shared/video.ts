// Video-Schnitt (Layout clip): Transkript-Typ und die Rechnungen, die Export und KI-Tools teilen. Zeiten in Sekunden.
// Highlight-Kriterien, Transkriptformat und ASS-Untertitel sind angelehnt an BridgeClip (MIT, © 2026 BridgeMind).

export interface Word { w: string; start: number; end: number }
export interface Segment { start: number; end: number; text: string; words?: Word[] } // words fehlen = aus text geschätzt
export interface Transcript { duration: number; lang: string; segments: Segment[] }
export interface VideoInfo { duration: number; w: number; h: number } // w/h so, wie das Video angezeigt wird (Drehung berücksichtigt)
export interface Part { start: number; end: number; focus?: number } // focus: horizontaler Bildmittelpunkt 0..1
export type Captions = 'wort' | 'satz' | 'aus'
export interface ClipContent { video: string; parts: Part[]; hook?: string; captions?: Captions }
export interface Cue { start: number; end: number; words: Word[] }

export const CAPTIONS: Captions[] = ['wort', 'satz', 'aus']
export const PAD = 0.15 // Puffer an jedem Schnitt, damit kein Wort angeschnitten wird
export const STILL = 3 // Sekunden je Folie ohne Video im MP4

export const partsLength = (parts: Part[]) => parts.reduce((s, p) => s + Math.max(0, p.end - p.start), 0)

/** Wortzeiten eines Segments nach Zeichenanteil. ponytail: geschätzt (±0,3 s); echte Zeiten per DTW über Cross-Attention, falls die Wort-Hervorhebung sichtbar daneben liegt. */
export function estimateWords(seg: Segment): Word[] {
  const ws = seg.text.trim().split(/\s+/).filter(Boolean)
  const chars = ws.reduce((s, w) => s + w.length + 1, 0)
  const span = Math.max(0, seg.end - seg.start)
  let t = seg.start
  return ws.map((w) => {
    const d = (span * (w.length + 1)) / chars
    const word = { w, start: t, end: t + d }
    t += d
    return word
  })
}

/** Wörter der parts auf der Zeitachse des fertigen Clips: part 2 beginnt dort, wo part 1 endet. Ein Wort gehört zum part, in dem seine Mitte liegt. */
export function clipWords(t: Transcript, parts: Part[]): Word[] {
  const all = t.segments.flatMap((s) => s.words?.length ? s.words : estimateWords(s))
  const out: Word[] = []
  let offset = 0
  for (const p of parts) {
    for (const w of all) {
      const mid = (w.start + w.end) / 2
      if (mid < p.start || mid >= p.end) continue
      out.push({ w: w.w, start: offset + Math.max(0, w.start - p.start), end: offset + Math.min(p.end, w.end) - p.start })
    }
    offset += Math.max(0, p.end - p.start)
  }
  return out
}

/** Untertitel-Häppchen: wort = bis 3 Wörter (≤ 18 Zeichen), satz = bis ~42 Zeichen. Bruch auch an Satzende und Pausen > 0,6 s. */
export function cues(words: Word[], mode: Exclude<Captions, 'aus'>): Cue[] {
  const maxWords = mode === 'wort' ? 3 : 12, maxChars = mode === 'wort' ? 18 : 42
  const out: Cue[] = []
  let cur: Word[] = []
  const flush = () => { if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur }); cur = [] }
  for (const w of words) {
    const last = cur[cur.length - 1]
    const len = cur.reduce((s, x) => s + x.w.length + 1, 0) + w.w.length
    if (last && (cur.length >= maxWords || len > maxChars || w.start - last.end > 0.6 || /[.!?…]$/.test(last.w))) flush()
    cur.push(w)
  }
  flush()
  // Lücken bis 0,3 s schließen, sonst flackert der Untertitel zwischen zwei Häppchen
  for (let i = 0; i < out.length - 1; i++) if (out[i + 1].start - out[i].end < 0.3) out[i].end = out[i + 1].start
  return out
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Ausgabegröße eines Decks im MP4: 1,5-fach (9:16 → 1080×1920), gerade Maße für yuv420p. */
export const outSize = (size: { w: number; h: number }) => ({ w: even(size.w * 1.5), h: even(size.h * 1.5) })

/** Ausschnitt der Quelle (px), der das Zielformat füllt: horizontal um focus, vertikal mittig. */
export function cropRect(src: { w: number; h: number }, out: { w: number; h: number }, focus = 0.5) {
  const r = out.w / out.h
  if (src.w / src.h > r) {
    const w = Math.min(src.w, even(src.h * r))
    return { x: Math.round(Math.min(src.w - w, Math.max(0, focus * src.w - w / 2))), y: 0, w, h: src.h }
  }
  const h = Math.min(src.h, even(src.w / r))
  return { x: 0, y: Math.round((src.h - h) / 2), w: src.w, h }
}

/** Transkript für die KI: eine Zeile je Segment, „[s12] 61.2–66.8 Text“. */
export const transcriptLines = (t: Transcript) => t.segments.map((s, i) => `[s${i}] ${s.start.toFixed(1)}–${s.end.toFixed(1)} ${s.text.trim()}`)

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
