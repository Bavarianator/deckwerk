// Video-Schnitt (Layout clip): Transkript-Typ und die Rechnungen, die Export und KI-Tools teilen. Zeiten in Sekunden.
// Highlight-Kriterien, Transkriptformat und ASS-Untertitel sind angelehnt an BridgeClip (MIT, © 2026 BridgeMind).

export interface Word { w: string; start: number; end: number }
export interface Segment { start: number; end: number; text: string; words?: Word[]; speaker?: number } // words fehlen = aus text geschätzt; speaker aus der Sprechertrennung, 0-basiert
export interface Transcript { duration: number; lang: string; segments: Segment[]; covered?: [number, number][] } // covered: transkribierte Bereiche (s), sortiert; fehlt = ganzes Video
export interface VideoInfo { duration: number; w: number; h: number } // w/h so, wie das Video angezeigt wird (Drehung berücksichtigt)
export interface Part { start: number; end: number; focus?: number; track?: [t: number, focus: number][] } // focus: horizontaler Bildmittelpunkt 0..1; track: Kamerafahrt als Stützpunkte (Quellsekunde, focus), setzt nur der Export (autoFocus), nie die KI
export type Captions = 'wort' | 'satz' | 'aus'
export type Pauses = 'kurz' | 'lassen'
export type Fit = 'crop' | 'blur' // blur: ganzes Bild mittig auf unscharfem, abgedunkeltem Vollbild-Grund (Querformat in 9:16)
// follow: Zuschnitt folgt dem aktiven Sprecher (Podcast), die Engine teilt parts an Sprecherwechseln
// style: ruhig (Standard) = ohne Animation; lebendig = Wort-Pop, Hook mit Einblendung und Balken, Fortschrittsbalken, Zoom-Wechsel an Schnitten
export type ClipStyle = 'ruhig' | 'lebendig'
// cuts: harte Bildwechsel der Quelle (s); setzt nur der Export (prepareClips), nie die KI, nicht im Schema
// ton: klar = Sprachkette (Hochpass, Entrauschen, Kompressor, De-Esser) für Sprache aus Handy/Webcam; original = unverändert (Standard); bei Musik nie klar
// cover: Quellsekunde fürs Titelbild (Export legt es als .jpg neben das MP4), post: Text zum Posten – Titel in der ersten Zeile, dann Beschreibung und Hashtags (.txt)
export interface ClipContent { video: string; parts: Part[]; hook?: string; captions?: Captions; pauses?: Pauses; fit?: Fit; follow?: 'sprecher'; style?: ClipStyle; cuts?: number[]; cover?: number; post?: string; ton?: 'klar' | 'original' }
export type Quiet = [start: number, end: number] // Stille im Quellvideo (silencedetect)
export interface Cue { start: number; end: number; words: Word[] }

export const CAPTIONS: Captions[] = ['wort', 'satz', 'aus']
export const CLIP_STYLES: ClipStyle[] = ['ruhig', 'lebendig']
// Werte für style 'lebendig', gemeinsam für Export (ASS/ffmpeg) und Vorschau (CSS), damit beide gleich aussehen
export const FX = {
  pop: 1.08, popMs: 120, // gesprochenes Wort wächst kurz und geht zurück
  hookFadeMs: 200, // Hook blendet ein und aus
  zoom: 1.08, // jeder zweite Ausschnitt (ungerader Index) enger: kaschiert Jump-Cuts
  bar: 0.006, // Fortschrittsbalken: Höhe als Anteil der Bildhöhe, Akzentfarbe, unten
}
// Zahl der echten Schnitte bis Ausschnitt i: nahtlose Übergänge (Quelle läuft weiter) zählen nicht
export const cutIndex = (parts: Part[], i: number) => parts.slice(1, i + 1).filter((p, j) => Math.abs(parts[j].end - p.start) >= 1e-3).length
// Zoom nach dem part-ten Schnitt (cutIndex): nur lebendig und nur jeder zweite
export const zoomOf = (style: ClipStyle | undefined, part: number) => (style === 'lebendig' && part % 2 === 1 ? FX.zoom : 1)
export const PAD = 0.15 // Puffer an jedem Schnitt, damit kein Wort angeschnitten wird
export const STILL = 3 // Sekunden je Folie ohne Video im MP4
export const MIN_PAUSE = 0.6 // pauses 'kurz': Stillen ab dieser Länge fallen weg, padParts lässt je Seite PAD stehen
export const MAX_PARTS = 100 // Ausschnitte je Clip-Folie (ganzes Video kürzen braucht viele)
export const LONG_VIDEO = 600 // s: ab 10 min erst video_highlights, dann nur Fenster transkribieren (ganze lange Videos kosten Stunden und Speicher)
// Füllwort, geprüft gegen ein einzelnes Wort (Word.w): ganzes Wort, Satzzeichen und Groß/klein egal
export const FILLERS = /^[\p{P}\s]*(?:äh|ähm|öh|öhm|hm|hmm|mhm|uh|um|uhm|erm)[\p{P}\s]*$/iu

export const partsLength = (parts: Part[]) => parts.reduce((s, p) => s + Math.max(0, p.end - p.start), 0)

// start–end ohne die Stillen
function speech(start: number, end: number, quiet: Quiet[]): Quiet[] {
  const out: Quiet[] = []
  let t = start
  for (const [a, b] of [...quiet].sort((x, y) => x[0] - y[0])) {
    if (b <= t || a >= end) continue
    if (a > t) out.push([t, a])
    t = Math.max(t, b)
  }
  if (t < end) out.push([t, end])
  return out
}

/** Pausen kürzen: jeden part an den Stillen teilen, die Stille fällt weg. Ein part aus reiner Stille bleibt, wie er ist. */
export const tighten = (parts: Part[], quiet: Quiet[]): Part[] => parts.flatMap((p) => {
  const s = speech(p.start, p.end, quiet)
  return s.length ? s.map(([start, end]) => ({ ...p, start, end })) : [p]
})

/** Füllwörter in from–to als Stillen für tighten(). Nur Segmente mit echten Wortzeiten, geschätzte träfen Nachbarwörter.
 *  Je Seite PAD breiter: padParts gibt an jedem Schnitt PAD zurück, sonst bliebe ein kurzes „äh“ ganz stehen. */
export function fillerQuiet(t: Transcript, from: number, to: number): Quiet[] {
  const en = t.lang.startsWith('en') // „um“ ist nur im Englischen ein Füllwort, im Deutschen (und bei lang 'auto') meist Präposition
  return t.segments.flatMap((s) => s.words ?? [])
    .filter((w) => w.end > from && w.start < to && FILLERS.test(w.w) && (en || !/^um$/i.test(w.w.replace(/[\p{P}\s]/gu, ''))))
    .map((w): Quiet => [Math.max(from, w.start - PAD), Math.min(to, w.end + PAD)])
}

/** Kanten bis max s vor (Start) bzw. nach (Ende) einem harten Bildwechsel auf den Wechsel legen, sonst blitzen Frames der Nachbarszene auf.
 *  Bleibt, wenn dabei ein echtes Wort (nur echte Wortzeiten, Toleranz 0,05 s wie im Clip-Lint) angeschnitten würde oder wegfiele, an nahtlosen Übergängen und wenn der Teil unter 0,5 s fiele. */
export function snapToScenes(parts: Part[], cuts: number[], t?: Transcript | null, max = 0.3): { parts: Part[]; moved: number } {
  const ws = t?.segments.flatMap((s) => s.words ?? []) ?? []
  const joined = (j: number) => j > 0 && j < parts.length && Math.abs(parts[j - 1].end - parts[j].start) < 1e-3
  let moved = 0
  const out = parts.map((p, i) => {
    const q = { ...p }
    const start = Math.max(...cuts.filter((c) => c > p.start && c - p.start <= max)), end = Math.min(...cuts.filter((c) => c < p.end && p.end - c <= max))
    for (const [edge, to] of [['start', start], ['end', end]] as const) {
      if (!Number.isFinite(to) || joined(edge === 'start' ? i : i + 1)) continue
      const [a, b] = edge === 'start' ? [p.start, to] : [to, p.end] // was wegfällt
      if (ws.some((w) => w.end - 0.05 > a && w.start + 0.05 < b) || (edge === 'start' ? q.end - to : to - q.start) < 0.5) continue
      q[edge] = to
      moved++
    }
    return q
  })
  return { parts: out, moved }
}

/** Wortzeiten eines Segments nach Zeichenanteil, verteilt über die Sprechzeit ohne die Stillen in quiet. Ein Wort liegt ganz im Sprechstück seiner Mitte, sonst fiele es mit einer gekürzten Pause weg. ponytail: geschätzt (±0,3 s); echte Zeiten per DTW über Cross-Attention, falls die Wort-Hervorhebung sichtbar daneben liegt. */
export function estimateWords(seg: Segment, quiet: Quiet[] = []): Word[] {
  const ws = seg.text.trim().split(/\s+/).filter(Boolean)
  const chars = ws.reduce((s, w) => s + w.length + 1, 0)
  const spans = speech(seg.start, seg.end, quiet)
  if (!spans.length) spans.push([seg.start, Math.max(seg.start, seg.end)]) // nur Stille oder leeres Segment
  const total = spans.reduce((s, [a, b]) => s + b - a, 0)
  let t = 0 // Sprechzeit bis zum Wortanfang
  return ws.map((w) => {
    const d = (total * (w.length + 1)) / chars
    let mid = t + d / 2, k = 0
    while (k < spans.length - 1 && mid > spans[k][1] - spans[k][0]) mid -= spans[k][1] - spans[k][0], k++
    const [a, b] = spans[k]
    t += d
    return { w, start: Math.max(a, a + mid - d / 2), end: Math.min(b, a + mid + d / 2) }
  })
}

/** Wörter der parts auf der Zeitachse des fertigen Clips: part 2 beginnt dort, wo part 1 endet. Ein Wort gehört zum part, in dem seine Mitte liegt. */
export function clipWords(t: Transcript, parts: Part[], quiet: Quiet[] = []): Word[] {
  const all = t.segments.flatMap((s) => s.words?.length ? s.words : estimateWords(s, quiet))
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

type Turn = { start: number; end: number; speaker: number }

// Nachbarn desselben Sprechers verbinden, Stücke kürzer als min dem Vorgänger (am Anfang dem Nachfolger) zuschlagen
function settle(ts: Turn[], min: number): Turn[] {
  const merge = (xs: Turn[]) => xs.reduce<Turn[]>((o, t) => {
    const l = o[o.length - 1]
    if (l?.speaker === t.speaker) l.end = Math.max(l.end, t.end)
    else o.push({ ...t })
    return o
  }, [])
  let out = merge(ts), k: number
  while (out.length > 1 && (k = out.findIndex((t) => t.end - t.start < min)) >= 0) {
    if (k) out[k - 1].end = out[k].end
    else out[1].start = out[0].start
    out.splice(k, 1)
    out = merge(out)
  }
  return out
}

/** Zuschnitt folgt dem Sprecher: parts an Sprecherwechseln teilen, focus je Stück = speakerX des Sprechers. Ein Sprecher bleibt im Bild bis zum Einsatz des nächsten;
 *  Einwürfe kürzer als min (s) zählen zum Nachbarn, sonst zappelt das Bild. Sprecher ohne Eintrag in speakerX übernimmt der Nachbar. parts mit eigenem focus bleiben. */
export function followParts(parts: Part[], turns: Turn[], speakerX: Map<number, number>, min = 2): Part[] {
  const known = turns.filter((t) => speakerX.has(t.speaker)).sort((a, b) => a.start - b.start)
  if (!known.length) return parts
  const shots = settle(known.map((t, k) => ({ ...t, end: known[k + 1]?.start ?? t.end })), min)
  const at = (t: number) => shots.findLast((s) => s.start <= t) ?? shots[0]
  return parts.flatMap((p) => {
    if (p.focus !== undefined) return [p]
    const cuts = [p.start, ...shots.map((s) => s.start).filter((t) => t > p.start && t < p.end)]
    const pieces = cuts.map((start, k) => ({ start, end: cuts[k + 1] ?? p.end, speaker: at(start).speaker }))
    return settle(pieces, min).map((s) => ({ ...p, start: s.start, end: s.end, focus: speakerX.get(s.speaker) }))
  })
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Ausgabegröße eines Decks im MP4: 1,5-fach (9:16 → 1080×1920), längere Seite höchstens 3840 px (fremde deck.json), gerade Maße für yuv420p. */
export const outSize = (size: { w: number; h: number }) => {
  const k = Math.min(1.5, 3840 / Math.max(size.w, size.h))
  return { w: even(size.w * k), h: even(size.h * k) }
}

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

// Selbstprüfung: npx esbuild src/shared/video.ts --bundle --platform=node | DW_VIDEO_SELFTEST=1 node
if (typeof process !== 'undefined' && process.env.DW_VIDEO_SELFTEST) {
  const w = (x: string, start: number): Word => ({ w: x, start, end: start + 0.3 })
  const t: Transcript = { duration: 10, lang: 'de', segments: [
    { start: 0, end: 3, text: '', words: [w(' Also', 0), w(' Äh,', 1), w(' um', 1.5), w(' hmm…', 2)] },
    { start: 3, end: 5, text: 'ähm geschätzt' }, // ohne words: nie schneiden
  ] }
  const q = fillerQuiet(t, 0, 10)
  if (q.length !== 2 || q[0][0] !== 1 - PAD || q[1][1] !== 2.3 + PAD) throw new Error('fillerQuiet ' + JSON.stringify(q))
  if (fillerQuiet({ ...t, lang: 'en' }, 0, 10).length !== 3 || fillerQuiet(t, 1.6, 10).length !== 1) throw new Error('fillerQuiet en/Bereich')
  if (fillerQuiet({ ...t, lang: 'auto' }, 0, 10).length !== 2) throw new Error('fillerQuiet: „um“ bei unbekannter Sprache geschnitten')
  if (FILLERS.test('ähnlich') || FILLERS.test('Hummel') || !FILLERS.test('Ähm...')) throw new Error('FILLERS')
  console.log('video ok')
}
