// Bausteine für Clip-Stil 'lebendig' (ASS-Tags, Zuschnitt), ohne Node/Electron: export-video.ts setzt sie ein, check-video.ts prüft sie.
// Werte aus FX (src/shared/video.ts), die Vorschau baut dieselben in CSS nach.
import { FX } from '../shared/video'

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
