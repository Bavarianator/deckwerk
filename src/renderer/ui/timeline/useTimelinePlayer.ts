// Wiedergabe der Pro-Timeline: Uhr per rAF, je Spur ein Elementpaar (A spielt, B steht auf dem nächsten Clip), Ton über Web Audio (audioGraph)
import { useEffect, useRef, useState } from 'react'
import { activeAt, clipEnd, snapFrame, speedOfClip, tlDuration, type TLClip, type TLTrack, type TimelineContent } from '../../../shared/timeline'
import { chainFor } from './audioGraph'
import { clipUrl } from '../clipPlayer'

const DRIFT = 0.15 // s: darüber hart nachsetzen, darunter per Tempo nachregeln
const NUDGE = 0.03 // höchstens ±3 % Tempo zum Nachregeln

/** Je sichtbarer/hörbarer Spur der Clip zur Zeit t und seine Quellsekunde (von unten nach oben) */
export function plan(tl: Pick<TimelineContent, 'tracks'>, t: number): { track: number; clip: string; src: number }[] {
  return activeAt(tl, t).filter((a) => !isStill(a.clip.src)).map((a) => ({ track: a.index, clip: a.clip.id, src: a.src }))
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
    const vids = p.filter((x) => cur.tracks[x.track].kind === 'video')
    // ponytail: höchstens 2 Videos dekodieren (unterste sichtbare + oberste); dazwischen stehen pausiert auf ihrem Bild, ihr Ton fehlt beim Abspielen
    const decode = new Set([vids[0]?.track, vids[vids.length - 1]?.track])
    const seen = new Set<string>()
    let swapped = false
    for (const x of p) {
      const track = cur.tracks[x.track], clip = track.clips.find((c) => c.id === x.clip)!
      const pair = pairFor(track)
      seen.add(track.id)
      let fresh = false
      if (pair.aClip !== clip.id) {
        fresh = true
        if (pair.bClip === clip.id) { // B steht schon auf diesem Clip: B wird A
          ;[pair.a, pair.b] = [pair.b, pair.a]
          ;[pair.aClip, pair.bClip] = [pair.bClip, pair.aClip]
          swapped = true
        } else { load(pair.a, clip, x.src); pair.aClip = clip.id }
        pair.a.pause()
      }
      const next = track.clips.filter((c) => c.at >= clipEnd(clip) - 1e-6 && c.id !== clip.id && !isStill(c.src)).sort((a, b) => a.at - b.at)[0]
      if (next && pair.bClip !== next.id) { pair.b.pause(); load(pair.b, next, next.in); pair.bClip = next.id }
      const el = pair.a
      const d = x.src - el.currentTime
      if (fresh && Math.abs(d) > half) el.currentTime = x.src
      if ((fresh || pair.dirty) && ax) {
        const vol = track.mute ? 0 : track.volume ?? 1 // wie im Export: Spur stumm = 0; clip.mute setzt chainFor auf 0, Quellen ohne Ton bleiben still
        chainFor(ax.ctx, el, ax.master).apply(clip, vol, time, ax.ctx.currentTime)
        pair.dirty = false
      }
      if (!go || (track.kind === 'video' && !decode.has(x.track))) {
        if (!el.paused) el.pause()
        if (!go && Math.abs(d) > half) el.currentTime = x.src // Standbild genau auf das Bild
        continue
      }
      if (Math.abs(d) > DRIFT) el.currentTime = x.src
      el.playbackRate = speedOfClip(clip) * (1 + Math.min(NUDGE, Math.max(-NUDGE, d)))
      if (el.paused) el.play().catch(() => {})
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
  }
}
