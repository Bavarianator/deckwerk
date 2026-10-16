// Chat-Replay als ASS (libass brennt es ein wie die Untertitel): Nachrichten aus der Quellzeit auf die Clip-Achse, gedrosselt, als Spalte der letzten Zeilen.
// Rein funktional, ohne Node/Electron; export-video.ts hängt style und events in seine ASS-Datei, check-chat-overlay.ts prüft.
import { partLen, speedOf, type Part } from '../shared/video'

export interface ChatMsg { t: number; n?: string; c?: string; x?: string }
export interface ChatOpts { pos?: 'links' | 'rechts'; zeilen?: number; namen?: boolean }

const STAND = 10, FAD = 150, GAP = 0.5, SAME = 5, MAXLEN = 60 // Standzeit s, Einblendung ms, Drossel s, Fenster für Wiederholungen s, Zeichen

const n2 = (i: number) => String(i).padStart(2, '0')
// Kopien aus export-video.ts (dort nicht exportiert): ASS-Zeit, Escape gegen eingeschleuste Override-Tags, Farbe &HBBGGRR& (dunkle aufgehellt)
const at = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100))
  return `${Math.floor(cs / 360000)}:${n2(Math.floor(cs / 6000) % 60)}:${n2(Math.floor(cs / 100) % 60)}.${n2(cs % 100)}`
}
const esc = (s: string) => s.replace(/\\/g, '＼').replace(/[{}]/g, (c) => `\\${c}`).replace(/\r\n|\r|\n/g, '\\N')
function assColor(hex: string) {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0)
  if (0.2126 * r + 0.7152 * g + 0.0722 * b < 110) [r, g, b] = [r, g, b].map((v) => Math.round((v + 255) / 2))
  return `&H${[b, g, r].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}&`
}

/** Style-Zeile (ASS „Style: Chat,…“) und Dialogue-Zeilen für den Chat eines Clips; leer, wenn keine Nachricht ins Clip-Fenster fällt. */
export function chatAss(msgs: ChatMsg[], parts: Part[], o: ChatOpts & { size: { w: number; h: number }; font: string }): { style: string; events: string[] } {
  const { w, h } = o.size, m = Math.min(w, h), wide = w >= h, zeilen = Math.min(8, Math.max(3, Math.round(o.zeilen ?? 6)))
  const size = Math.round(m * (wide ? 0.03 : 0.035)), line = Math.max(1, Math.round(m * 0.002)), lh = size * 1.3, right = o.pos === 'rechts'
  const style = `Style: Chat,${o.font},${size},&H00FFFFFF,&H00FFFFFF,&H40000000,&H80000000,0,0,0,0,100,100,0,0,1,${line},${line},${right ? 3 : 1},0,0,0,1`
  // ponytail: Zeichenbreite geschätzt (0,55 em), keine Glyphenmessung; bei breiten Schriften notfalls den Faktor anheben
  const maxLen = Math.min(MAXLEN, Math.floor((w * (wide ? 0.38 : 0.8)) / (size * 0.55)))
  // Quellzeit → Clip-Zeit wie clipWords: Nachricht gehört zum part, in dem t liegt; Standbild (freeze) steckt in partLen
  const timed: { t: number; m: ChatMsg; x: string }[] = []
  let off = 0
  for (const p of parts) {
    for (const c of msgs) if (c.x?.trim() && c.t >= p.start && c.t < p.end) timed.push({ t: off + (c.t - p.start) / speedOf(p), m: c, x: c.x.trim() })
    off += partLen(p)
  }
  timed.sort((a, b) => a.t - b.t)
  // Wiederholungen binnen SAME s zu einer Zeile mit ×N, danach höchstens eine neue Nachricht je GAP s
  // ponytail: ×N steht ab dem ersten Erscheinen mit der Endzahl, kein Hochzählen im Bild
  const shown: { t: number; m: ChatMsg; x: string; key: string; n: number }[] = []
  for (const e of timed) {
    const key = e.x.toLowerCase(), same = shown.findLast((s) => s.key === key && e.t - s.t <= SAME)
    if (same) same.n++
    else if (!shown.length || e.t - shown[shown.length - 1].t >= GAP) shown.push({ ...e, key, n: 1 })
  }
  // Spalte: Querformat unten über der Untertitelzeile (78 %), Hochformat bei 75 % (über der Plattform-Leiste), wächst nach oben bis ~55 %
  const x = Math.round(right ? w * 0.96 : w * 0.04), bottom = h * (wide ? 0.78 : 0.75)
  const events: string[] = []
  shown.forEach((s, i) => {
    const who = o.namen ? (s.m.n?.trim() ?? '').slice(0, 20) : '' // Name zählt zur Zeilenlänge, sonst läuft die Zeile aus dem Bild
    const tail = s.n > 1 ? ` ×${s.n}` : '', lim = maxLen - tail.length - (who ? who.length + 2 : 0)
    let text = s.x.replace(/\s+/g, ' ')
    if (text.length > lim) text = text.slice(0, lim - 1).trimEnd() + '…'
    text += tail
    const name = who ? `{\\c${assColor(s.m.c ?? '#FFFFFF')}}${esc(who)}{\\c&HFFFFFF&}: ` : ''
    const end = Math.min(s.t + STAND, shown[i + zeilen]?.t ?? Infinity), expires = end === s.t + STAND
    // Ein Dialogue je Platz k (0 = unten): von der k-ten neueren Nachricht bis zur nächsten oder zum Ende
    for (let k = 0; k < zeilen; k++) {
      const a = shown[i + k]?.t ?? Infinity, b = Math.min(end, shown[i + k + 1]?.t ?? Infinity), last = b === end
      if (a >= end) break
      const fad = `\\fad(${k ? 0 : FAD},${last && expires ? FAD : 0})`
      events.push(`Dialogue: 0,${at(a)},${at(b)},Chat,,0,0,0,,{\\q2\\pos(${x},${Math.round(bottom - k * lh)})${fad}}${name}${esc(text)}`)
    }
  })
  return { style, events }
}
