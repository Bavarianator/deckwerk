// Abspiel-Bausteine für Clip-Folien, geteilt von Schneiden (ClipCutter) und Deckvid: Wiedergabe der Ausschnitte, Bild im Zielformat, Zeitleiste, Untertitel.
// Keine Tastenkürzel hier, die entscheidet die Ansicht.
import { useEffect, useRef, useState, type ReactNode, type RefObject, type PointerEvent as RPointerEvent } from 'react'
import { cues, partsLength, type Cue, type Fit, type Part, type Word } from '../../shared/video'
import { assetOf } from './itemOps'
import './cutter.css'

// Ausschnitt zur Quellzeit s: der laufende, wenn er s enthält (überlappende parts), sonst der erste, der s enthält, sonst der erste, der nach s endet (Lücke); -1 = hinter allen.
// parts stehen in Abspielreihenfolge, nicht unbedingt nach Quellzeit sortiert.
function locate(ps: Part[], k: number, s: number) {
  const has = (p?: Part) => !!p && s >= p.start && s < p.end
  if (has(ps[k])) return k
  const hit = ps.findIndex(has)
  return hit >= 0 ? hit : ps.findIndex((p) => s < p.end)
}

/** Spielt die parts nacheinander (Schnittfassung), am Ende Pause und zurück auf den Anfang. t/duration in Clipzeit, src in Quellzeit.
 *  playSource spielt die Quelle ohne Sprünge (Schneiden: „Quelle“), part = Index des Ausschnitts an der Abspielposition (-1 = hinter allen). */
export function useClipPlayer(video: RefObject<HTMLVideoElement | null>, parts: Part[]) {
  const [playing, setPlaying] = useState(false)
  const [src, setSrc] = useState(parts[0]?.start ?? 0)
  const ps = useRef(parts)
  ps.current = parts
  const idx = useRef(0) // Ausschnitt der Wiedergabe; bei überlappenden parts nicht aus der Zeit ableitbar
  const free = useRef(false)

  const part = locate(parts, idx.current, src)
  const duration = partsLength(parts)
  const t = part < 0 ? duration : partsLength(parts.slice(0, part)) + Math.min(Math.max(0, src - parts[part].start), parts[part].end - parts[part].start)

  const go = (s: number, k: number) => {
    idx.current = k
    if (video.current) video.current.currentTime = s
    setSrc(s)
  }
  const start = (v: HTMLVideoElement) => { v.play().catch(() => setPlaying(false)); setPlaying(true) }
  const play = () => {
    const v = video.current, l = ps.current
    if (!v || !l.length) return
    free.current = false
    const k = locate(l, idx.current, v.currentTime)
    if (k < 0) go(l[0].start, 0) // hinter dem Ende: von vorn
    else if (v.currentTime < l[k].start) go(l[k].start, k) // in einer Lücke: ab dem nächsten Ausschnitt
    else idx.current = k
    start(v)
  }
  const playSource = () => { const v = video.current; if (!v) return; free.current = true; start(v) }
  const pause = () => { const v = video.current; v?.pause(); setPlaying(false); if (v) setSrc(v.currentTime) }
  const seekSource = (s: number) => {
    const x = Math.max(0, Math.min(s, video.current?.duration || Infinity)) // duration ist NaN ohne Metadaten
    go(x, locate(ps.current, idx.current, x))
  }
  const seekClip = (c: number) => {
    const l = ps.current, len = (p: Part) => p.end - p.start
    let k = 0, o = 0
    while (k < l.length - 1 && c >= o + len(l[k])) o += len(l[k++])
    if (l[k]) go(l[k].start + Math.min(Math.max(0, c - o), len(l[k])), k)
  }

  // Abspielposition per rAF (timeupdate kommt nur ~4×/s); am Ende eines Ausschnitts zum nächsten springen
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const v = video.current, l = ps.current
      if (!v || v.paused) { setPlaying(false); if (v) setSrc(v.currentTime); return } // Videoende oder von außen angehalten
      const k = idx.current, p = l[k], c = v.currentTime
      if (free.current || (p && c >= p.start - 0.1 && c < p.end)) setSrc(c) // Toleranz: nach dem Spulen meldet das Video evtl. knapp davor
      else if (p && c < p.start) go(p.start, k) // beim Abspielen in eine Lücke gespult
      else if (p && l[k + 1]) go(l[k + 1].start, k + 1)
      else { v.pause(); go(l[0]?.start ?? 0, 0); setPlaying(false); return } // Ende, auch wenn der laufende Ausschnitt gelöscht wurde (!p)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  return { playing, t, duration, src, part, play, playSource, pause, toggle: () => (playing ? pause() : play()), seekClip, seekSource }
}

export const clipUrl = (video: string) => (video.startsWith('/') ? assetOf(video) : video) // assetOf kodiert auch # und ?

interface VideoProps {
  video: string; aspect: number; focus?: number; fit?: Fit; still?: number; videoRef: RefObject<HTMLVideoElement | null>; children?: ReactNode
  onBad?(): void; onMeta?(v: HTMLVideoElement): void; onClick?(): void
}

/** Video im Zielformat wie im MP4: crop füllt um focus, blur zeigt das ganze Bild auf unscharfem, abgedunkeltem Standbild. children liegen darüber (Hook, Untertitel).
 *  still: Sekunde, die vor dem ersten Abspielen steht; bei blur stabil halten, jeder neue Wert lässt den Main per ffmpeg ein Standbild ziehen. onBad: Chromium spielt den Codec nicht (HEVC, ProRes …) oder es gibt keine Videospur. */
export function ClipVideo({ video, aspect, focus = 0.5, fit = 'crop', still, videoRef, children, onBad, onMeta, onClick }: VideoProps) {
  const url = clipUrl(video)
  const [first] = useState(still) // Standbild nur vom ersten Wert: der Cutter reicht still live durch, jeder neue Wert startete ffmpeg
  return (
    <div className={`clip-video${fit === 'blur' ? ' blur' : ''}`} style={{ aspectRatio: aspect }} onClick={onClick}>
      {fit === 'blur' && <div className="clip-video-bg" style={{ backgroundImage: `url("${url}?frame=${first ?? 0}")` }} />}
      <video ref={videoRef} src={url} poster={first != null ? `${url}?frame=${first}` : undefined} preload="auto" playsInline style={fit === 'crop' ? { objectPosition: `${focus * 100}% 50%` } : undefined}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          if (!v.videoWidth) onBad?.() // nur Ton oder Videospur unbekannt
          if (still !== undefined) v.currentTime = still
          onMeta?.(v)
        }}
        onError={() => onBad?.()} />
      {children}
    </div>
  )
}

interface StripProps {
  from: number; to: number; parts: Part[]; label?: string; head?: number; onSeek?(s: number): void
  marks?: { start: number; end: number; label: string }[]; curve?: number[] // curve: gleichmäßig über from..to verteilt, 0..1
  on?(x: Part): boolean // ohne Griffe hervorgehoben (Deckvid: Ausschnitte des gewählten Clips)
  handles?: { sel: number; onSel(i: number): void; onEdge?(edge: 'start' | 'end', s: number): void; onDragEnd?(): void }
}

// Zeitleiste von from bis to: Klicken/Ziehen setzt die Abspielposition, Griffe (nur mit onEdge) verschieben Anfang und Ende des gewählten Ausschnitts.
// Dahinter dezent die Lautheit (curve) und nummerierte Marken (Highlights).
export function Strip({ from, to, parts, label, head, onSeek, marks, curve, on, handles: h }: StripProps) {
  const ref = useRef<HTMLDivElement>(null)
  const span = Math.max(0.001, to - from)
  const pct = (s: number) => `${((Math.max(from, Math.min(to, s)) - from) / span) * 100}%`
  const box = (x: { start: number; end: number }) => ({ left: pct(x.start), width: `calc(${pct(x.end)} - ${pct(x.start)})` })
  const at = (e: { clientX: number }) => { const r = ref.current!.getBoundingClientRect(); return from + ((e.clientX - r.left) / r.width) * span }
  const drag = (move: (s: number) => void, jump = true) => (e: RPointerEvent) => {
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    if (jump) move(at(e))
    el.onpointermove = (ev) => move(at(ev))
    el.onpointerup = el.onpointercancel = () => { el.onpointermove = el.onpointerup = el.onpointercancel = null; h?.onDragEnd?.() }
  }
  const shown = (x: { start: number; end: number }) => x.end > from && x.start < to
  return (
    <div className="cut-strip-wrap">
      {label && <span>{label}</span>}
      <div className="cut-strip" ref={ref} onPointerDown={(e) => {
        const s = at(e), inside = (x?: Part) => !!x && s >= x.start && s < x.end
        if (h && !inside(parts[h.sel])) { const hit = parts.findIndex(inside); if (hit >= 0) h.onSel(hit) }
        if (onSeek) drag(onSeek)(e)
      }}>
        {curve && curve.length > 0 && (
          <svg className="cut-curve" viewBox={`0 0 ${curve.length} 1`} preserveAspectRatio="none" aria-hidden>
            <path d={`M0 1${curve.map((v, i) => `V${(1 - (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)).toFixed(3)}H${i + 1}`).join('')}V1Z`} />
          </svg>
        )}
        {marks?.map((m, i) => shown(m) && (
          <div key={i} className="cut-mark" style={box(m)} title={m.label}><span>{i + 1}</span></div>
        ))}
        {parts.map((x, i) => shown(x) && (
          <div key={i} className={`cut-part${(h ? i === h.sel : on?.(x)) ? ' on' : ''}`} style={box(x)}>
            <span>{i + 1}</span>
            {h?.onEdge && i === h.sel && <>
              <i className="cut-grip l" aria-hidden onPointerDown={drag((s) => h.onEdge!('start', s), false)} />
              <i className="cut-grip r" aria-hidden onPointerDown={drag((s) => h.onEdge!('end', s), false)} />
            </>}
          </div>
        ))}
        {head !== undefined && <div className="cut-head" style={{ left: pct(head) }} />}
      </div>
    </div>
  )
}

/** Untertitel zur Clipzeit t wie im MP4: Häppchen aus cues(), active = gerade gesprochenes Wort (letztes mit start ≤ t). null = gerade kein Untertitel.
 *  words: clipWords() des Clips. */
const cueCache = new WeakMap<Word[], Partial<Record<'wort' | 'satz', Cue[]>>>() // je words-Array: captionAt läuft in jedem Frame
export function captionAt(words: Word[], t: number, mode: 'wort' | 'satz'): { words: string[]; active: number } | null {
  const m = cueCache.get(words) ?? {}
  cueCache.set(words, m)
  const c = (m[mode] ??= cues(words, mode)).find((x) => t >= x.start && t < x.end)
  return c ? { words: c.words.map((w) => w.w.trim()), active: Math.max(0, c.words.findLastIndex((w) => w.start <= t)) } : null
}

// Selbstprüfung: npx esbuild src/renderer/ui/clipPlayer.tsx --bundle --platform=node --loader:.css=empty | DW_CLIP_SELFTEST=1 node
if (typeof process !== 'undefined' && process.env.DW_CLIP_SELFTEST) {
  const w = (x: string, start: number, end = start + 0.25): Word => ({ w: x, start, end })
  const eq = (a: unknown, b: unknown, what: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} statt ${JSON.stringify(b)}`) }
  const ws = [w(' Hallo', 0, 0.4), w(' Welt.', 0.5, 0.9), w(' Neu', 2, 2.3)]
  eq(captionAt(ws, -0.1, 'wort'), null, 'vor dem ersten Wort')
  eq(captionAt(ws, 0, 'wort'), { words: ['Hallo', 'Welt.'], active: 0 }, 'Anfang')
  eq(captionAt(ws, 0.45, 'wort'), { words: ['Hallo', 'Welt.'], active: 0 }, 'zwischen zwei Wörtern bleibt das vorige')
  eq(captionAt(ws, 0.5, 'wort')?.active, 1, 'Wortwechsel an der Grenze')
  eq(captionAt(ws, 1, 'wort'), null, 'Pause zwischen Häppchen')
  eq(captionAt(ws, 2, 'satz'), { words: ['Neu'], active: 0 }, 'neues Häppchen')
  eq(captionAt(ws, 2.3, 'satz'), null, 'Ende exklusiv')
  const four = [w('a', 0), w('b', 0.3), w('c', 0.6), w('d', 0.9)]
  eq(captionAt(four, 0.87, 'wort'), { words: ['a', 'b', 'c'], active: 2 }, 'wort: Lücke unter 0,3 s geschlossen')
  eq(captionAt(four, 0.9, 'wort'), { words: ['d'], active: 0 }, 'wort: höchstens 3 Wörter')
  eq(captionAt(four, 0.9, 'satz'), { words: ['a', 'b', 'c', 'd'], active: 3 }, 'satz: ein Häppchen')
  eq(captionAt([], 0, 'wort'), null, 'ohne Wörter')
  const un: Part[] = [{ start: 10, end: 20 }, { start: 0, end: 5 }] // Abspielreihenfolge ≠ Quellreihenfolge
  eq([locate(un, 0, 3), locate(un, 0, 12), locate(un, 1, 7), locate(un, 0, 25)], [1, 0, 0, -1], 'locate unsortiert')
  eq(locate([{ start: 0, end: 10 }, { start: 5, end: 15 }], 1, 7), 1, 'locate: laufender Ausschnitt bei Überlappung')
  console.log('clipPlayer ok')
}
