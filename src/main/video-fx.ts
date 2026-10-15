// Bausteine für Clip-Stil 'lebendig' (ASS-Tags, Zuschnitt), ohne Node/Electron: export-video.ts setzt sie ein, check-video.ts prüft sie.
// Werte aus FX (src/shared/video.ts), die Vorschau baut dieselben in CSS nach.
import { FX, type Cue, type Look } from '../shared/video'

/** Gesprochenes Wort: kurz größer, in popMs zurück. \t-Zeit relativ zum Event-Start, also nur im Event, in dem das Wort aktiv wird. */
export const POP = `\\fscx${Math.round(FX.pop * 100)}\\fscy${Math.round(FX.pop * 100)}\\t(0,${FX.popMs},\\fscx100\\fscy100)`

/** Hook blendet ein und aus. */
export const HOOK_FADE = `{\\fad(${FX.hookFadeMs},${FX.hookFadeMs})}`

/** Hook-Style als ruhiger Balken: BorderStyle 3 = opake Box in OutlineColour (Schwarz, &H59 ≈ 65 % deckend, wie die Vorschau), Outline = Innenabstand, kein Schatten. */
export function hookBox(style: string, pad: number): string {
  const f = style.split(',') // Format-Zeile in assSubs: [0] Name, [5] OutlineColour, [15] BorderStyle, [16] Outline, [17] Shadow
  f[0] = 'Style: HookBox'; f[5] = '&H59000000'; f[15] = '3'; f[16] = String(pad); f[17] = '0'
  return f.join(',')
}

/** Fortschrittsbalken unten in der Akzentfarbe: Style und ein Dialogue je Gruppe (Zeiten ab 0), der Clip wächst von off/total auf (off+dur)/total. */
export function progressBar(size: { w: number; h: number }, accent: string, g: { off: number; dur: number; total: number }, at: (s: number) => string) {
  const { w, h } = size, bh = Math.max(4, Math.round(FX.bar * h)), x = (t: number) => Math.round((w * t) / g.total)
  return {
    style: `Style: Bar,Arial,10,${accent},${accent},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
    event: `Dialogue: 0,${at(0)},${at(g.dur)},Bar,,0,0,0,,{\\pos(0,${h - bh})\\clip(0,0,${x(g.off)},${h})\\t(\\clip(0,0,${x(g.off + g.dur)},${h}))\\p1}m 0 0 l ${w} 0 ${w} ${bh} 0 ${bh}`,
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/** Zuschnitt um zoom enger, gleicher Mittelpunkt; zoom 1 = unverändert. */
export function zoomCrop(c: { x: number; y: number; w: number; h: number }, zoom: number) {
  if (zoom <= 1) return c
  const w = even(c.w / zoom), h = even(c.h / zoom)
  return { x: Math.round(c.x + (c.w - w) / 2), y: Math.round(c.y + (c.h - h) / 2), w, h }
}

const num = (v: number) => String(Math.round(v * 1000) / 1000)

// x der Kamerafahrt als ffmpeg-Ausdruck in t: je Abschnitt ein if, von hinten verschachtelt; gleiche Zeit = Sprung (Abschnitt fällt weg),
// max(0, …) hält vor dem ersten Stützpunkt. In '…', damit der Filtergraph die Kommas nicht als Filtertrenner liest.
function trackX(w: number, { src, keys, start }: { src: { w: number }; keys: [number, number][]; start: number }) {
  const pt = keys.map(([t, f]) => [t - start, f * src.w - w / 2])
  let e = num(pt[pt.length - 1][1])
  for (let k = pt.length - 2; k >= 0; k--) {
    const [ta, xa] = pt[k], [tb, xb] = pt[k + 1]
    if (tb > ta) e = `if(lt(t,${num(tb)}),${num(xa)}+(${num((xb - xa) / (tb - ta))})*max(0,t-${num(ta)}),${e})`
  }
  return `'clip(${e},0,${src.w - w})'`
}

/** ffmpeg-Filter für fit 'crop': Ausschnitt (ggf. gezoomt), dann auf die Zielgröße. Mit track fährt x: focus linear zwischen den
 *  Stützpunkten (Quellsekunden; t = 0 im Filter bei Quellsekunde start), davor und danach konstant; y wie ohne track. */
export function cropFilter(c: { x: number; y: number; w: number; h: number }, size: { w: number; h: number }, zoom = 1,
  track?: { src: { w: number; h: number }; keys: [t: number, focus: number][]; start: number }) {
  const z = zoomCrop(c, zoom)
  // Fahrt mit exact=1: sonst rundet crop x bei yuv420p auf gerade px, langsame Fahrten ruckeln in 2-px-Stufen
  return `crop=${z.w}:${z.h}:${track?.keys.length ? `${trackX(z.w, track)}:${z.y}:exact=1` : `${z.x}:${z.y}`},scale=${size.w}:${size.h}`
}

/** Musikpegel über die Zeit als ffmpeg-Ausdruck in t (für volume=…:eval=frame): Grundpegel base, in den Spans [von, bis, pegel] deren Pegel.
 *  An jeder Grenze eine lineare Rampe von ramp s, mittig auf der Grenze (kürzer, wenn die Nachbargrenze näher liegt); aneinanderstoßende Spans gehen direkt ineinander über. */
export function levelExpr(base: number, spans: [number, number, number][], ramp = 0.5) {
  const edges: [t: number, from: number, to: number][] = []
  for (const [a, b, v] of [...spans].sort((x, y) => x[0] - y[0])) {
    const l = edges[edges.length - 1]
    if (l && a - l[0] < 1e-3) l[2] = v
    else edges.push([a, base, v])
    edges.push([b, v, base])
  }
  const pt = edges.filter(([, f, to]) => f !== to).flatMap(([t, f, to], k, es) => {
    const h = Math.min(ramp / 2, k ? (t - es[k - 1][0]) / 2 : Infinity, k < es.length - 1 ? (es[k + 1][0] - t) / 2 : Infinity)
    return [[t - h, f], [t + h, to]]
  })
  if (!pt.length) return `'${num(base)}'`
  let e = num(pt[pt.length - 1][1])
  for (let k = pt.length - 2; k >= 0; k--) {
    const [ta, va] = pt[k], [tb, vb] = pt[k + 1]
    if (tb > ta) e = `if(lt(t,${num(tb)}),${num(va)}+(${num((vb - va) / (tb - ta))})*max(0,t-${num(ta)}),${e})`
  }
  return `'${e}'`
}

/** Farblook je Clip als ffmpeg-Filter (auf das Video vor den Einblendungen, Text bleibt unberührt); die Vorschau baut sie per CSS-filter nach.
 *  auto misst die Quelle (autoLook). Warm/kühl verschieben Schatten und Mitten; matt hebt das Schwarz an und nimmt Farbe heraus. */
export const LOOK_FILTER: Record<Exclude<Look, 'auto'>, string> = {
  neutral: '',
  warm: 'colorbalance=rs=0.06:gs=0.02:bs=-0.06:rm=0.04:bm=-0.04',
  kuehl: 'colorbalance=rs=-0.05:bs=0.06:rm=-0.03:bm=0.04',
  kontrast: 'eq=contrast=1.12:saturation=1.15',
  matt: "curves=all='0/0.06 1/0.94',eq=saturation=0.85",
  sw: 'hue=s=0,eq=contrast=1.08',
}

/** Look auto aus signalstats (8 bit, Mittel über einige Sekunden): Kontrast strecken, wenn 10.–90. Perzentil eng beieinander liegen (eq dreht um die Mitte),
 *  dann Gamma, bis das Mittel bei 45 % liegt – hellt dunkle Handy-Aufnahmen auf, ohne das Schwarz anzuheben. Gedeckelt; gut belichtet: kein Filter. */
export function autoLook(s: { avg: number; low: number; high: number }) {
  if (![s.avg, s.low, s.high].every(Number.isFinite)) return ''
  const c = Math.min(1.25, Math.max(1, 140 / Math.max(1, s.high - s.low))), mid = Math.min(0.95, Math.max(0.05, (s.avg / 255 - 0.5) * c + 0.5))
  const g = Math.min(1.6, Math.max(0.8, Math.log(mid) / Math.log(0.45)))
  return c < 1.02 && Math.abs(g - 1) < 0.05 ? '' : `eq=contrast=${num(c)}:gamma=${num(g)}`
}

/** Profi-Einblendungen (Anteile der kürzeren Seite m): Schriftgrößen, Akzentlinie [Breite, Höhe] mit Abstand gap zum Text, Abdunklung bei titel
 *  (ASS-Alpha, &H80 ≈ 50 % Schwarz), Einfahrt der Bauchbinde (slide · m in slideMs). Die Vorschau übernimmt dieselben Werte. */
export const ART = {
  bauchbinde: { text: 0.055, sub: 0.034, line: [0.07, 0.006] },
  titel: { text: 0.08, sub: 0.04 },
  zahl: { text: 0.12, sub: 0.04, line: [0.1, 0.006] },
  gap: 0.018, dim: '&H80&', slide: 0.03, slideMs: 400,
} as const

/** bauchbinde, titel, zahl als ASS-Dialogues (Zeiten ab Gruppenanfang). al: ASS-Lage (1–9), x/y daraus mit Rand: oben top, unten low (über den Untertiteln).
 *  Text weiß über dem Ov-Style (Kontur, Schatten), Akzent nur als kurze Linie über dem Text; Block-Höhe geschätzt (Zeilen nach Zeichenzahl).
 *  back: Abdunklung für titel, gehört unter die Untertitel. */
export function artEvents(o: { size: { w: number; h: number }; accent: string; art: 'bauchbinde' | 'titel' | 'zahl'; text: string; sub?: string; al: number; top: number; low: number; start: number; end: number; fade: [boolean, boolean]; fadeMs: number },
  at: (s: number) => string, esc: (s: string) => string) {
  const { w, h } = o.size, m = Math.min(w, h), a = ART[o.art], col = (o.al - 1) % 3, row = Math.floor((o.al - 1) / 3) // row 0 unten, 1 mitte, 2 oben
  const fs = Math.round(m * a.text), fs2 = Math.round(m * a.sub), line = 'line' in a ? a.line.map((v) => Math.max(2, Math.round(m * v))) : null
  const lines = (s: string, size: number) => Math.max(1, Math.ceil((s.length * size * 0.55) / (w * 0.84))) // Umbruch geschätzt: Zeichen ~0,55 em, Satzbreite 84 %
  const gap = line ? Math.round(m * ART.gap) : 0, textH = lines(o.text, fs) * fs * 1.2 + (o.sub ? lines(o.sub, fs2) * fs2 * 1.2 : 0)
  const blockH = (line ? line[1] + gap : 0) + textH
  const x = [Math.round(w * 0.08), Math.round(w / 2), Math.round(w * 0.92)][col]
  const top = Math.round(row === 2 ? o.top : row === 1 ? (h - blockH) / 2 : h - o.low - blockH), ty = top + (line ? line[1] + gap : 0)
  const fad = `\\fad(${o.fade[0] ? o.fadeMs : 0},${o.fade[1] ? o.fadeMs : 0})`
  // Bauchbinde gleitet von ihrer Seite ein (Mitte: nur Blende), nur an einem echten Anfang
  const dx = o.art === 'bauchbinde' && o.fade[0] && col !== 1 ? Math.round(m * ART.slide) * (col === 0 ? -1 : 1) : 0
  const place = (px: number, py: number) => (dx ? `\\move(${px + dx},${py},${px},${py},0,${ART.slideMs})` : `\\pos(${px},${py})`)
  const ev = (st: string, text: string) => `Dialogue: 0,${at(o.start)},${at(o.end)},${st},,0,0,0,,${text}`
  const style = `Ov${o.al}`, front: string[] = [], back: string[] = []
  if (o.art === 'titel') back.push(ev(style, `{\\an7\\pos(0,0)\\bord0\\shad0\\c&H000000&\\1a${ART.dim}${fad}\\p1}m 0 0 l ${w} 0 ${w} ${h} 0 ${h}`))
  if (line) {
    const lx = col === 0 ? x : col === 1 ? x - line[0] / 2 : x - line[0]
    front.push(ev(style, `{\\an7${place(Math.round(lx), top)}\\bord0\\shad0\\c${o.accent}${fad}\\p1}m 0 0 l ${line[0]} 0 ${line[0]} ${line[1]} 0 ${line[1]}`))
  }
  front.push(ev(style, `{\\an${7 + col}${place(x, ty)}${fad}\\fs${fs}}${esc(o.text.trim())}${o.sub?.trim() ? `\\N{\\fs${fs2}\\b0}${esc(o.sub.trim())}` : ''}`))
  return { back, front }
}

/** Ken-Burns bei Bild-Einblendung voll: Zoom je Sekunde, höchstens max über die ganze Dauer (ruhig). */
export const KEN_BURNS = { perSec: 0.015, max: 0.06 }

const srtTime = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000)), p = (v: number, n = 2) => String(v).padStart(n, '0')
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}
/** Untertitel als SRT (neben dem MP4, für Plattformen und Barrierefreiheit): je Häppchen ein Eintrag, Zeiten auf der Achse des fertigen Videos. */
export const srt = (cs: Cue[]) => cs.map((c, k) => `${k + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.words.map((x) => x.w.trim()).join(' ')}\n`).join('\n')
