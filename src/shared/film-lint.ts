// Film-Lint (Deck.film, Feature „Animation“): Sprechtext, Szenenlänge, Kamera, Tippen und Bildschirm-Zoom, damit sich die KI beim Bauen
// eines Films selbst korrigiert. Nur Warnungen: Die Zeiten sind Schätzungen (film.ts), die Stimme ist beim Bauen noch nicht synthetisiert.
// Ohne Electron/Node, läuft in Main und Renderer. Nutzer: lintDeck (lint.ts) und report() in tools.ts (Zeitachse je Szene).
import type { Deck, Measured, Slide } from './deck'
import { itemClicks } from './deck'
import { BEAT_MARK, estimateVoice, sceneTimeline, TAIL, type ScreenZoom, type VoiceTiming } from './film'
import { buildOf } from './layouts'
import { CODE_MAX, codeLines } from './layouts-demo'
import type { Issue } from './lint'

export const TYPE_SEC = 0.045 // je Zeichen beim Tippen (GAP.typewriter in renderer/ui/PresentScreen.tsx)
const FADE = 0.5 // Einblenden einer Code-Zeile (ITEM_MOTION.fade)
// ponytail: Aufbaudauer je Takt geschätzt; genau kennt sie erst filmPrepare im Renderer. Upgrade: Schrittdauern aus measure() mitliefern
const STEP_SEC = 0.6
const MAX = { words: 40, voice: 25, typing: 8, box: 0.25 } // Wörter bzw. s Sprechtext je Szene, s Tippen, kleinste Kamera-Box (über 4× Vergrößerung)
const de = (x: number) => String(+x.toFixed(1)).replace('.', ',')

/** Aufbau des Layouts code wie in renderer/layouts-demo.tsx: Zeilen nacheinander, getippt je Zeichen 45 ms, sonst eingeblendet */
export function codeReveal(s: Slide): { typing: number; total: number } {
  const c = s.content as { code?: unknown; reveal?: string }
  if (s.layout !== 'code' || typeof c?.code !== 'string' || c.reveal === 'ganz') return { typing: 0, total: 0 }
  const terminal = s.variant === 'terminal', lines = codeLines(c.code).filter((l) => l.trim())
  const tippen = c.reveal === 'tippen' && lines.join('').replace(/\s/g, '').length <= CODE_MAX.typing // sonst Zeile für Zeile
  let typing = 0, total = 0
  for (const l of lines) {
    if (terminal ? l.startsWith('$ ') : tippen) typing += l.length * TYPE_SEC
    else total += terminal ? FADE : FADE + 0.1
  }
  return { typing, total: total + typing }
}

export interface SceneEstimate {
  dur: number // geschätzte Szenenlänge in s
  voice?: VoiceTiming // geschätzter Zeitplan der Stimme (fehlt = kein Sprechtext)
  beats: number // Takte der Szene samt Kamera-Takten
  content: number // Takte aus Sprechtext ([klick]), Aufbau, Klick-Elementen und Mauszeiger, ohne Kamera
  typing: number // s Tippen (Layout code)
}
/** Geschätzte Zeitachse der Szene i (wie sceneTimeline im Export, Aufbaudauer je Takt geschätzt). m = Messung der Folie (Aufbau-Gruppen, Wörter) */
export function sceneEstimate(deck: Deck, i: number, m?: Measured): SceneEstimate {
  const s = deck.slides[i]
  const voice = s.voice?.trim() ? estimateVoice(s.voice, deck.film?.speed ?? 1) : undefined
  // Takte wie prepare() im Film (immer Klick-Modus): Takt 0, bei list je Aufbau-Gruppe einer, dazu je Klick-Element einer
  const groups = m ? new Set(m.els.flatMap((e) => (e.build === undefined ? [] : [e.build]))).size : 0
  const clicks = 1 + (buildOf(deck, i) === 'list' ? groups : 0) + itemClicks(s)
  const cursor = s.layout === 'screen' ? ((s.content?.cursor ?? []) as { step?: number }[]).reduce((n, c, k) => Math.max(n, (c.step ?? k + 1) + 1), 0) : 0
  const content = Math.max(voice?.beats.length ?? 0, clicks, cursor)
  const beats = Math.max(content, ...(s.camera ?? []).map((c) => c.step + 1))
  const code = codeReveal(s)
  const steps = Array.from({ length: beats }, (_, k) => (k === 0 ? Math.max(STEP_SEC, code.total) : STEP_SEC))
  const words = m ? m.els.flatMap((e) => (e.kind === 'text' ? e.runs.map((r) => r.text) : [])).join(' ').split(/\s+/).filter(Boolean).length : 0
  return { dur: sceneTimeline({ steps, voice, duration: s.duration, words, lead: 0 }).dur, voice, beats, content, typing: code.typing }
}

const boxOk = (b: unknown): b is [number, number, number, number] =>
  Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1) && b[2] > 0 && b[3] > 0 && b[0] + b[2] <= 1 + 1e-9 && b[1] + b[3] <= 1 + 1e-9

/** Prüft die sichtbaren Szenen eines Films (nur bei deck.film aufrufen). measured[i] = Messung der Folie i, fehlt = ohne Aufbau-Gruppen */
export function lintFilm(deck: Deck, measured: Measured[] = []): Issue[] {
  const out: Issue[] = []
  const warn = (i: number, rule: string, message: string, slot?: string) => out.push({ slide: i, slideId: deck.slides[i].id, slot, severity: 'warn', rule, message })
  const mute: number[] = []
  deck.slides.forEach((s, i) => {
    if (s.hidden) return // keine Szene
    const e = sceneEstimate(deck, i, measured[i]), v = e.voice
    if (!v) mute.push(i)
    else {
      const words = s.voice!.replace(BEAT_MARK, ' ').split(/\s+/).filter(Boolean).length
      if (words > MAX.words || v.total > MAX.voice)
        warn(i, 'film-stimme', `Sprechtext ${words} Wörter (~${de(v.total)} s) – höchstens ~${MAX.words} Wörter bzw. ${MAX.voice} s je Szene. Kürzen oder auf zwei Szenen teilen.`)
      if (s.duration !== undefined && s.duration < v.total + TAIL)
        warn(i, 'film-dauer', `duration ${de(s.duration)} s ist kürzer als die Stimme (~${de(v.total)} s + ${de(TAIL)} s Nachlauf); die Szene dauert trotzdem ~${de(e.dur)} s. duration weglassen oder den Sprechtext kürzen.`)
    }
    for (const [k, c] of (s.camera ?? []).entries()) {
      if (c.box !== undefined && !boxOk(c.box)) warn(i, 'film-kamera', `camera[${k}].box ${JSON.stringify(c.box)} ist ungültig: [x, y, w, h] als Anteile 0..1 der Folie, x + w und y + h höchstens 1.`)
      else if (c.box && Math.max(c.box[2], c.box[3]) < MAX.box) warn(i, 'film-kamera', `camera[${k}].box ist winzig (${de(c.box[2])} × ${de(c.box[3])}): über 4× Vergrößerung verliert der Zuschauer die Orientierung. w oder h mindestens ${de(MAX.box)}.`)
      // ohne Stimme laufen Kamera-Takte nach Zeitplan (Rundgang ok); mit Stimme käme die Fahrt erst nach dem Gesprochenen
      if (v && c.step >= e.content)
        warn(i, 'film-kamera', `Kamera in Takt ${c.step}, die Szene hat nur ${e.content} ${e.content === 1 ? 'Takt' : 'Takte'} (0–${e.content - 1} aus [klick], Aufbau und Mauszeiger): Die Fahrt käme erst nach der Stimme. [klick] an der Stelle in den Sprechertext setzen oder step verkleinern.`)
    }
    if (e.typing > MAX.typing)
      warn(i, 'film-tippen', `Tippen dauert ~${de(e.typing)} s (${Math.round(e.typing / TYPE_SEC)} Zeichen × 45 ms) – höchstens ~${MAX.typing} s. Code kürzen${s.variant === 'terminal' ? ', weniger oder kürzere Befehle' : ' oder reveal zeilen'}.`, 'code')
    const c = s.content as { video?: unknown; from?: number; to?: number; zooms?: ScreenZoom[] }
    if (s.layout === 'screen' && c?.video) {
      const from = c.from ?? 0, bad = (c.zooms ?? []).filter((z) => z.start < from || (c.to !== undefined && z.end > c.to))
      if (bad.length) warn(i, 'film-zoom', `Zoom ${bad.map((z) => `${de(z.start)}–${de(z.end)} s`).join(', ')} liegt (teils) außerhalb des Ausschnitts ${de(from)}–${c.to === undefined ? 'Ende' : `${de(c.to)} s`}: Zoom-Zeiten sind Sekunden in der Datei wie from/to (aus screen_zooms unverändert), außerhalb wirken sie nicht.`, 'zooms')
    }
  })
  if (mute.length && mute.length < deck.slides.filter((s) => !s.hidden).length) // gemischt: manche Szenen sprechen, diese nicht
    warn(mute[0], 'film-ohne-stimme', `Hinweis: ${mute.length} ${mute.length === 1 ? 'Szene' : 'Szenen'} ohne Sprechtext (Folie ${mute.map((i) => i + 1).join(', ')}): Dort spricht niemand, die Szene läuft nach Aufbau und Lesezeit. Gewollt (Titel, Pause)? Sonst voice setzen.`)
  return out
}
