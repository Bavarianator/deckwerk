// Feature „Animation“ (Videos in Remotion-Art): Zeitachse einer Szene, Sprechertext und Bildschirm-Zoom. Gemeinsam für
// Film-Renderer (renderer/film.ts), Export (main/export-film.ts), Player (ui/Film.tsx), Stimme (main/voice.ts) und KI (Lint, report).
// Zeiten in Sekunden. Ein Takt ist ein Klick-Schritt aus prepare() (PresentScreen.tsx); im Film starten Takte nach Zeitplan statt per Klick.
import type { Cue } from './video'

export const FPS = 30
export const VOICE_SPEED = { min: 0.8, max: 1.3 } // Sprechtempo (Deck.film.speed), 1 = normal
export const BEAT_MARK = /\[klick\]/gi // Marker im Sprechertext: der nächste Takt beginnt mit dem folgenden Satz
export const PAUSE = { sentence: 0.25, beat: 0.45 } // Stille zwischen Sätzen bzw. vor einem neuen Takt (voice.ts setzt die Tonspur genauso zusammen)
export const GAP = 1.2 // ohne Stimme: Pause nach einem Aufbau, bevor der nächste Takt beginnt
export const HOLD = 1.5 // ohne Stimme: Standbild nach dem letzten Aufbau
export const TAIL = 0.6 // nach dem letzten gesprochenen Wort
export const MIN_SCENE = 2
export const CHARS_PER_SEC = 14 // Schätzung fürs Sprechtempo (Piper Thorsten bei speed 1), solange die Stimme nicht synthetisiert ist

// Kein Satzende: einzelner Buchstabe („z.“, „B.“ aus „z. B.“), Ordinalzahl („1. Platz“, „3. Mai“) oder eine übliche Abkürzung
const ABBR = /(?:(?<![\p{L}\d])\p{L}|(?<![\d.,])\d+|\b(?:bzw|ca|vgl|Nr|Dr|Prof|etc|usw|inkl|ggf|evtl|vs|Mio|Mrd|Tsd))\.$/iu
/** Sprechertext → Takte (getrennt an [klick]) → Sätze. Leere Takte bleiben stehen ([klick][klick] = zwei Takte zur selben Zeit). */
export function voiceChunks(text: string): string[][] {
  return text.split(BEAT_MARK).map((beat) => {
    const out: string[] = []
    for (const part of beat.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…]["“»)]?)\s+(?=[\p{Lu}\d„"»(])/u)) {
      if (!part) continue
      // „z. B. Kunden“: Abkürzung am Ende → mit dem nächsten Stück zusammen lassen
      if (out.length && ABBR.test(out[out.length - 1])) out[out.length - 1] += ` ${part}`
      else out.push(part)
    }
    return out
  })
}

/** Geschätzte Sprechdauer eines Satzes (s) bei speed (1 = normal) */
export const estimateSec = (sentence: string, speed = 1) => sentence.replace(BEAT_MARK, '').trim().length / (CHARS_PER_SEC * speed)

export interface VoiceTiming {
  beats: number[] // Beginn jedes Takts in s ab Stimmbeginn; beats[0] = 0
  total: number // Länge der Tonspur in s
  cues: Cue[] // je Satz eine Zeile, Wortzeiten anteilig nach Buchstaben
}

/** Zeitplan der Stimme aus den Satzdauern (echt aus der TTS oder geschätzt): Sätze hintereinander mit PAUSE dazwischen.
 *  durs hat dieselbe Form wie chunks (Takt × Satz). Ein leerer Takt beginnt, wo der vorige aufhört. */
export function voiceTiming(chunks: string[][], durs: number[][]): VoiceTiming {
  const beats: number[] = [], cues: Cue[] = []
  let t = 0, first = true
  chunks.forEach((beat, b) => {
    if (b > 0 && beat.length && !first) t += PAUSE.beat - PAUSE.sentence // zusätzliche Atempause vor einem neuen Takt
    beats.push(t)
    beat.forEach((s, k) => {
      const d = Math.max(0.1, durs[b]?.[k] ?? estimateSec(s))
      cues.push(sentenceCue(s, t, t + d))
      t += d + PAUSE.sentence
      first = false
    })
  })
  return { beats, total: Math.max(0, t - (first ? 0 : PAUSE.sentence)), cues }
}

/** Geschätzter Zeitplan, solange die Stimme nicht synthetisiert ist (report, Lint, Player vor dem ersten Abspielen) */
export const estimateVoice = (text: string, speed = 1): VoiceTiming => {
  const chunks = voiceChunks(text)
  return voiceTiming(chunks, chunks.map((b) => b.map((s) => estimateSec(s, speed))))
}

/** Eine Untertitelzeile je Satz; Wortzeiten anteilig nach Buchstaben (ponytail: Schätzung; Upgrade: Parakeet über die TTS-Ausgabe) */
export function sentenceCue(sentence: string, start: number, end: number): Cue {
  const ws = sentence.split(/\s+/).filter(Boolean)
  const len = ws.reduce((n, w) => n + w.length + 1, 0) || 1
  let t = start
  return { start, end, words: ws.map((w) => { const d = ((w.length + 1) / len) * (end - start); const x = { w, start: t, end: t + d }; t += d; return x }) }
}

export interface SceneTimeline {
  beats: number[] // Beginn jedes Takts in s ab Szenenbeginn
  dur: number // Länge der Szene in s
  hold: number // ab hier ändert sich das Bild nicht mehr (Export hält das letzte Frame)
}

/** Zeitachse einer Szene. steps = Dauer der Animationen je Takt (s, aus prepare(); Takt 0 läuft ohne Klick), voice = Zeitplan der Stimme,
 *  duration = Wunschlänge (die Stimme wird nie abgeschnitten), words = Wörter auf der Folie (Lesezeit ohne Stimme),
 *  lead = Vorlauf (Überblendung von der Szene davor; Stimme und Takt 0 beginnen danach), endless = Atmen/Foto-Zoom/Video läuft bis zum Ende,
 *  media = Videomaterial ab Szenenbeginn (s): ohne duration läuft die Szene mindestens lead + media, die Aufnahme wird nicht abgeschnitten. */
export function sceneTimeline(o: { steps: number[]; voice?: VoiceTiming; duration?: number; words: number; lead: number; endless?: boolean; media?: number }): SceneTimeline {
  const n = Math.max(o.steps.length, o.voice?.beats.length ?? 0, 1)
  const beats: number[] = []
  for (let k = 0; k < n; k++) {
    const prev = k ? beats[k - 1] + (o.steps[k - 1] ?? 0) + GAP : o.lead
    const spoken = o.voice && k < o.voice.beats.length ? o.lead + o.voice.beats[k] : undefined
    beats.push(k === 0 ? o.lead : Math.max(beats[k - 1], spoken ?? prev))
  }
  const animEnd = Math.max(o.lead, ...beats.map((b, k) => b + (o.steps[k] ?? 0)))
  const voiceEnd = o.voice ? o.lead + o.voice.total + TAIL : 0
  const auto = Math.max(animEnd + (o.voice ? 0.3 : HOLD), voiceEnd, o.voice ? 0 : o.lead + 1 + o.words / 3, o.lead + (o.media ?? 0), MIN_SCENE)
  const dur = Math.max(o.duration ?? auto, voiceEnd, 0.5)
  return { beats, dur, hold: o.endless ? dur : Math.min(dur, animEnd) }
}

// Bildschirm-Zoom (Layout screen mit Video): Vergrößerung auf einen Punkt der Aufnahme, wie Screen Studio. Zeiten in Videosekunden.
export interface ScreenZoom { start: number; end: number; x: number; y: number; scale?: number } // x/y = Zielpunkt 0..1, scale Standard 2
export const ZOOM_SCALE = { min: 1.2, max: 3, def: 2 }
export const ZOOM_EASE = 0.6 // s Ein- und Ausfahren (vor start bzw. nach end)
export const smooth = (p: number) => { const x = Math.min(1, Math.max(0, p)); return x * x * (3 - 2 * x) }

/** Ausschnitt zum Zeitpunkt t: s = Vergrößerung (1 = ganzes Bild), x/y = Mitte des sichtbaren Ausschnitts (0..1 im Quellbild).
 *  Der Zielpunkt bleibt beim Zoomen stehen (Ursprung im Zielpunkt); der Ausschnitt wird an den Bildrand geklemmt.
 *  Liegen zwei Zooms enger als 2 × ZOOM_EASE beieinander, fährt die Kamera direkt vom einen zum anderen statt kurz heraus. */
export function zoomAt(zooms: ScreenZoom[], t: number): { s: number; x: number; y: number } {
  const zs = [...zooms].sort((a, b) => a.start - b.start)
  const scale = (z: ScreenZoom) => Math.min(ZOOM_SCALE.max, Math.max(ZOOM_SCALE.min, z.scale ?? ZOOM_SCALE.def))
  const view = (x: number, y: number, s: number) => {
    const at = (q: number) => { const c = q + (0.5 - q) / s, h = 0.5 / s; return Math.min(1 - h, Math.max(h, c)) }
    return { s, x: at(x), y: at(y) }
  }
  const on = zs.filter((z) => t >= z.start && t <= z.end).at(-1) // überlappend: der zuletzt begonnene
  if (on) return view(on.x, on.y, scale(on))
  const prev = zs.filter((z) => z.end < t).sort((a, b) => a.end - b.end).at(-1), next = zs.find((z) => z.start > t)
  if (prev && next && next.start - prev.end < 2 * ZOOM_EASE) {
    const p = smooth((t - prev.end) / (next.start - prev.end)), mix = (a: number, b: number) => a + (b - a) * p
    return view(mix(prev.x, next.x), mix(prev.y, next.y), mix(scale(prev), scale(next)))
  }
  const pIn = next ? smooth(1 - (next.start - t) / ZOOM_EASE) : 0, pOut = prev ? smooth(1 - (t - prev.end) / ZOOM_EASE) : 0
  const z = pIn >= pOut ? next : prev, p = Math.max(pIn, pOut)
  return z && p > 0 ? view(z.x, z.y, 1 + (scale(z) - 1) * p) : { s: 1, x: 0.5, y: 0.5 }
}
