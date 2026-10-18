// Wiedergabe der Pro-Timeline: Uhr per rAF, je Spur ein Elementpaar (A spielt, B steht auf dem nächsten Clip bzw. spielt in der Überblendung das to), Ton über Web Audio (audioGraph)
import { useEffect, useRef, useState } from 'react'
import { activeAt, clipEnd, fadeGain, snapFrame, speedOfClip, srcAt, tlDuration, xfades, type TLClip, type TLTrack, type TimelineContent, type XFade } from '../../../shared/timeline'
import { chainFor } from './audioGraph'
import { clipUrl } from '../clipPlayer'

const DRIFT = 0.15 // s: darüber hart nachsetzen, darunter per Tempo nachregeln
const NUDGE = 0.03 // höchstens ±3 % Tempo zum Nachregeln
const DECODE = 3 // Videos, die beim Abspielen gleichzeitig laufen
const FOLLOW = 250 // ms: so oft werden die übrigen Videospuren per currentTime nachgeführt

/** Deckkraft (alpha) und Pegelfaktor (gain) eines Clips zur Zeit t, wie im Export: fade × Überblendung (to: k, Ton from: 1−k) */
export function mixOf(c: TLClip, t: number, xs: XFade[]): { alpha: number; gain: number } {
  const f = fadeGain(c, t)
  let alpha = f, gain = f
  for (const x of xs) {
    if (t < x.a || t > x.b) continue // geschlossen: am Fensterende gilt der Grenzwert (from = 0), für die Ton-Rampen
    const k = (t - x.a) / (x.b - x.a)
    if (x.to.id === c.id) { alpha *= k; gain *= k } else if (x.from.id === c.id) gain *= 1 - k
  }
  return { alpha, gain }
}

export interface Mix { track: number; clip: TLClip; src: number; alpha: number; gain: number }
/** Je sichtbarer/hörbarer Spur die Clips zur Zeit t (von unten nach oben); im Überblend-Fenster from und darüber to */
export function mixAt(tl: Pick<TimelineContent, 'tracks'>, t: number, kind?: TLTrack['kind']): Mix[] {
  const out: Mix[] = []
  for (const a of activeAt(tl, t, kind)) {
    const xs = xfades(a.track), x = xs.find((x) => t >= x.a && t < x.b)
    // from läuft über out hinaus, to beginnt vor in (auf ≥ 0 geklemmt)
    for (const c of x ? [x.from, x.to] : [a.clip]) out.push({ track: a.index, clip: c, src: Math.max(0, srcAt(c, t)), ...mixOf(c, t, xs) })
  }
  return out
}

/** Was der Player zur Zeit t abspielt: Spur, Clip, Quellsekunde, Deckkraft, Pegelfaktor (ohne Standbilder) */
export function plan(tl: Pick<TimelineContent, 'tracks'>, t: number): { track: number; clip: string; src: number; alpha: number; gain: number }[] {
  return mixAt(tl, t).filter((m) => !isStill(m.clip.src)).map((m) => ({ track: m.track, clip: m.clip.id, src: m.src, alpha: m.alpha, gain: m.gain }))
}

/** Blend-Pegel ab t0 als lineare Rampenpunkte (t relativ zu t0); zwischen den Knicken Zwischenpunkte, weil fade × k quadratisch verläuft */
export function fadeRamps(c: TLClip, xs: XFade[], t0: number): { t: number; gain: number }[] {
  const [fi, fo] = c.fade ?? [0, 0], end = clipEnd(c)
  const mine = xs.filter((x) => x.from.id === c.id || x.to.id === c.id)
  if (!fi && !fo && !mine.length) return []
  const ks = [...new Set([c.at, c.at + fi, end - fo, end, ...mine.flatMap((x) => [x.a, x.b])])].filter((k) => k > t0).sort((a, b) => a - b)
  const ts = [t0]
  for (const k of ks) { const p = ts[ts.length - 1]; for (let i = 1; i <= 4; i++) ts.push(p + ((k - p) * i) / 4) }
  return ts.map((t) => ({ t: t - t0, gain: mixOf(c, t, xs).gain }))
}

/** Standbild-Clip (Bild auf einer Videospur): zeigt der Viewer als <img>, der Player lässt ihn aus */
export const isStill = (src: string) => /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(src)

type El = HTMLMediaElement
interface Pair { a: El; b: El; aClip: string | null; bClip: string | null; dirty: boolean }

function makeEl(kind: TLTrack['kind']): El {
  const el = document.createElement(kind === 'video' ? 'video' : 'audio')
  el.crossOrigin = 'anonymous' // asset:// antwortet mit CORS: sonst hört Web Audio nur Stille und die Scopes sehen kein Bild
  el.preload = 'auto'
  el.muted = false
  if (el instanceof HTMLVideoElement) el.playsInline = true
  return el
}
function load(el: El, c: TLClip, at: number) {
  const url = clipUrl(c.src)
  if (el.dataset.url !== url) { el.src = url; el.dataset.url = url }
  el.currentTime = at
}

function release(p: Pair) {
  for (const el of [p.a, p.b]) { el.pause(); el.removeAttribute('src'); delete el.dataset.url; el.load() }
}

export interface TimelinePlayer {
  t: number; playing: boolean
  play(): void; pause(): void; toggle(): void; seek(t: number): void; step(frames: number): void
  videoFor(trackIndex: number): HTMLVideoElement | null
  master: AudioNode | null
  /** Element der Spur, das gerade diesen Clip zeigt (A oder in der Überblendung B) */
  elFor(trackIndex: number, clipId: string): HTMLVideoElement | null
}

export function useTimelinePlayer(tl: TimelineContent, fps: number): TimelinePlayer {
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [master, setMaster] = useState<AudioNode | null>(null)
  const [, setGen] = useState(0) // A/B getauscht: Viewer muss das neue Element einhängen
  const tlRef = useRef(tl)
  tlRef.current = tl
  const fpsRef = useRef(fps)
  fpsRef.current = fps
  const tRef = useRef(0), run = useRef(false), clock = useRef({ t: 0, at: 0 })
  const pairs = useRef(new Map<string, Pair>())
  const audio = useRef<{ ctx: AudioContext; master: GainNode } | null>(null)
  const applied = useRef(new WeakMap<El, string>()) // Clip, dessen Bild und Ton-Kette das Element trägt
  const followed = useRef(0)

  const pairFor = (track: TLTrack) => {
    let p = pairs.current.get(track.id)
    if (!p) {
      p = { a: makeEl(track.kind), b: makeEl(track.kind), aClip: null, bClip: null, dirty: true }
      pairs.current.set(track.id, p)
    }
    return p
  }

  // Elemente auf Zeit t ausrichten; go = abspielen, sonst Standbild
  const sync = (time: number, go: boolean) => {
    const cur = tlRef.current, p = plan(cur, time), ax = audio.current, half = 0.5 / fpsRef.current
    const now = performance.now(), follow = now - followed.current >= FOLLOW
    if (go && follow) followed.current = now
    // ponytail: höchstens DECODE Videos dekodieren (unterste, dann von oben); die übrigen stehen pausiert und werden alle FOLLOW ms nachgeführt, ihr Ton fehlt beim Abspielen
    const vids = p.flatMap((x, i) => (cur.tracks[x.track].kind === 'video' ? [i] : []))
    const decode = new Set([vids[0], ...vids.slice(1).reverse()].slice(0, DECODE))
    const byTrack = new Map<number, number[]>()
    p.forEach((x, i) => byTrack.set(x.track, [...(byTrack.get(x.track) ?? []), i]))
    const seen = new Set<string>()
    let swapped = false
    for (const [ti, idx] of byTrack) {
      const track = cur.tracks[ti], pair = pairFor(track), xs = xfades(track)
      const clipOf = (i: number) => track.clips.find((c) => c.id === p[i].clip)!
      seen.add(track.id)
      if (pair.dirty) { applied.current.delete(pair.a); applied.current.delete(pair.b); pair.dirty = false }
      const [i0, i1] = idx // A = Clip bzw. from der Überblendung, B = to
      if (pair.aClip !== p[i0].clip) {
        if (pair.bClip === p[i0].clip) { // B steht schon auf diesem Clip (bzw. war das to): B wird A
          ;[pair.a, pair.b] = [pair.b, pair.a]
          ;[pair.aClip, pair.bClip] = [pair.bClip, pair.aClip]
          swapped = true
        } else { pair.a.pause(); load(pair.a, clipOf(i0), p[i0].src); pair.aClip = p[i0].clip; applied.current.delete(pair.a) }
      }
      if (i1 !== undefined) {
        if (pair.bClip !== p[i1].clip) { pair.b.pause(); load(pair.b, clipOf(i1), p[i1].src); pair.bClip = p[i1].clip; applied.current.delete(pair.b) }
      } else {
        if (!pair.b.paused) pair.b.pause() // war das from der Überblendung
        const clip = clipOf(i0)
        const next = track.clips.filter((c) => c.at >= clipEnd(clip) - 1e-6 && c.id !== clip.id && !isStill(c.src)).sort((a, b) => a.at - b.at)[0]
        if (next && pair.bClip !== next.id) {
          const xf = xs.find((x) => x.to.id === next.id) // mit Überblendung schon auf den Fensteranfang stellen
          pair.b.pause(); load(pair.b, next, Math.max(0, xf ? srcAt(next, xf.a) : next.in)); pair.bClip = next.id; applied.current.delete(pair.b)
        }
      }
      for (const [el, i] of [[pair.a, i0], [pair.b, i1]] as const) {
        if (i === undefined) continue
        const x = p[i], clip = clipOf(i), d = x.src - el.currentTime
        if (applied.current.get(el) !== clip.id) { // neu auf diesem Element: Bild setzen, Ton-Kette samt Blend-Rampen ab jetzt
          applied.current.set(el, clip.id)
          if (Math.abs(d) > half) el.currentTime = x.src
          if (ax) {
            const vol = track.mute ? 0 : track.volume ?? 1 // wie im Export: Spur stumm = 0; clip.mute setzt chainFor auf 0, Quellen ohne Ton bleiben still
            chainFor(ax.ctx, el, ax.master).apply(clip, vol, time, ax.ctx.currentTime, fadeRamps(clip, xs, time))
          }
        }
        if (!go || (track.kind === 'video' && !decode.has(i))) {
          if (!el.paused) el.pause()
          if ((!go || follow) && Math.abs(d) > half) el.currentTime = x.src // Standbild genau auf das Bild
          continue
        }
        if (Math.abs(d) > DRIFT) el.currentTime = x.src
        el.playbackRate = speedOfClip(clip) * (1 + Math.min(NUDGE, Math.max(-NUDGE, d)))
        if (el.paused) el.play().catch(() => {})
      }
    }
    const live = new Set(cur.tracks.map((tr) => tr.id))
    for (const [id, pair] of pairs.current) {
      if (!live.has(id)) { release(pair); pairs.current.delete(id) } // Spur gelöscht
      else if (!seen.has(id)) { pair.a.pause(); pair.b.pause() }
    }
    if (swapped) setGen((g) => g + 1)
  }

  const setTime = (x: number) => { tRef.current = x; setT(x) }
  const pause = () => {
    run.current = false
    setPlaying(false)
    for (const pair of pairs.current.values()) { pair.a.pause(); pair.b.pause(); pair.dirty = true }
    sync(tRef.current, false)
  }
  const play = () => {
    if (run.current) return
    if (!audio.current) { // erst hier: Autoplay-Regel verlangt eine Nutzergeste
      const ctx = new AudioContext(), m = ctx.createGain()
      m.connect(ctx.destination)
      audio.current = { ctx, master: m }
      setMaster(m)
    }
    void audio.current.ctx.resume()
    const dur = tlDuration(tlRef.current)
    if (tRef.current >= dur - 1e-3) setTime(0) // am Ende: von vorn
    for (const pair of pairs.current.values()) pair.dirty = true
    clock.current = { t: tRef.current, at: performance.now() }
    run.current = true
    setPlaying(true)
    sync(tRef.current, true)
  }
  const seek = (x: number) => {
    x = Math.max(0, Math.min(x, tlDuration(tlRef.current)))
    setTime(x)
    clock.current = { t: x, at: performance.now() }
    for (const pair of pairs.current.values()) pair.dirty = true
    sync(x, run.current)
  }

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const x = clock.current.t + (performance.now() - clock.current.at) / 1000
      const dur = tlDuration(tlRef.current)
      if (x >= dur) { setTime(dur); pause(); return }
      setTime(x)
      sync(x, true)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  // Timeline geändert (Schnitt, Inspector): im Stand das Bild neu setzen, Ton-Kette neu anwenden
  useEffect(() => {
    for (const pair of pairs.current.values()) pair.dirty = true
    if (!run.current) sync(tRef.current, false)
  }, [tl])

  useEffect(() => () => {
    run.current = false
    for (const pair of pairs.current.values()) release(pair)
    pairs.current.clear()
    void audio.current?.ctx.close()
  }, [])

  return {
    t, playing, master, play, pause, seek,
    toggle: () => (run.current ? pause() : play()),
    step: (frames: number) => seek(snapFrame(tRef.current + frames / fpsRef.current, fpsRef.current)),
    videoFor: (i: number) => {
      const track = tl.tracks[i]
      return track?.kind === 'video' ? (pairFor(track).a as HTMLVideoElement) : null
    },
    elFor: (i: number, id: string) => {
      const track = tl.tracks[i], p = track?.kind === 'video' ? pairs.current.get(track.id) : undefined
      return ((p?.aClip === id ? p.a : p?.bClip === id ? p.b : null) as HTMLVideoElement | null)
    },
  }
}
