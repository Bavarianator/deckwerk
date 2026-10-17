// Video-Werkzeuge von Hand (Pro): dieselben Tools wie die KI über window.api.runTool. Ändernde Tools (edit_timeline) melden das
// neue Deck über 'deck:synced' an App.tsx; Ausschnitte und Clips aus Treffern setzt das Panel selbst über patchSlide.
import { useEffect, useRef, useState } from 'react'
import { type Deck, type Slide } from '../../shared/deck'
import { MAX_PARTS, type ClipContent } from '../../shared/video'
import { clipEnd, deliverOf, type TimelineContent } from '../../shared/timeline'
import { addClip, addTrack } from '../../shared/timeline-edit'
import { clipUrl } from './clipPlayer'
import { confirmDialog } from './kit'
import './videotools.css'

export interface Hit { from: number; to: number; line: string }
// Zeilen mit „from=12.3 to=45.6“ (search_transcript, video_highlights) → Quellzeiten; die Zeile ohne den from/to-Anhang als Text
export const parseHits = (text: string): Hit[] => text.split('\n').flatMap((l) => {
  const m = l.match(/from=(\d+(?:\.\d+)?) to=(\d+(?:\.\d+)?)/)
  return m && +m[2] > +m[1] ? [{ from: +m[1], to: +m[2], line: l.replace(/\s*·\s*from=.*$/, '') }] : []
})
// import_video und transcribe_video beginnen mit „Video: asset://…“
export const parseVideo = (text: string) => text.match(/^Video: (asset:\/\/\S+)/m)?.[1] ?? null
// Lange Jobs antworten „… läuft noch (37 %)“, dann denselben Aufruf wiederholen
export const runningPct = (text: string) => { const m = text.match(/läuft noch \((\d+) %\)/); return m ? +m[1] : null }

// Clip ans Ende einer Spur: top = oberste Spur der Art (Datei), sonst die erste (V1 für Treffer); fehlt die Art, neue Spur
export function appendClip(tl: TimelineContent, kind: 'video' | 'audio', top: boolean, clip: { src: string; in: number; out: number }, fps: number): TimelineContent {
  if (!tl.tracks.some((t) => t.kind === kind)) tl = addTrack(tl, kind)
  const ts = tl.tracks.filter((t) => t.kind === kind), track = top ? ts[ts.length - 1] : ts[0]
  const end = track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
  return addClip(tl, track.id, { ...clip, at: Math.ceil(end * fps - 1e-6) / fps }, fps) // aufrunden: addClip rundet aufs Bild, abgerundet läge er im Vorgänger
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const IMAGE_LEN = 5 // Standbilder ohne eigene Länge
const STALL_MS = 30 * 60_000 // so lange ohne Fortschritt: Polling aufgeben (der Job im Main läuft weiter)
const lengthOf = (src: string, audio: boolean) => new Promise<number>((ok, fail) => {
  const m = document.createElement(audio ? 'audio' : 'video')
  m.preload = 'metadata'
  m.onloadedmetadata = () => (Number.isFinite(m.duration) && m.duration > 0 ? ok(m.duration) : fail(new Error('Länge der Datei unbekannt')))
  m.onerror = () => fail(new Error('Datei lässt sich nicht lesen'))
  m.src = clipUrl(src)
})

interface Out { text: string; images: string[]; video?: string }

export function VideoTools({ deck, slide, index, patchSlide, newTimeline }: { deck: Deck | null; slide: Slide | undefined; index: number; patchSlide: (i: number, p: Partial<Slide>) => void; newTimeline?: () => void }) {
  const clip = slide?.layout === 'clip' ? (slide.content as ClipContent) : null
  const cut = slide?.layout === 'schnitt' ? (slide.content as TimelineContent) : null
  const [imported, setImported] = useState<string | null>(null)
  // Quelle: Video der Clip-Folie, sonst der erste Videoclip der Timeline, sonst das zuletzt importierte Video
  const src = clip?.video || cut?.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips).find((c) => c.src)?.src || imported
  const timeline = deck?.slides.find((s) => s.layout === 'schnitt')
  const hasClips = !!deck?.slides.some((s) => s.layout === 'clip' && !s.hidden)
  const [url, setUrl] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [out, setOut] = useState<Out | null>(null)
  const [pick, setPick] = useState(false)
  const [polling, setPolling] = useState(false)
  const alive = useRef(true)
  const gen = useRef(0) // Abbrechen/Unmount: laufende Polling-Schleife erkennt die neue Nummer und hört auf
  useEffect(() => () => { alive.current = false; gen.current++ }, [])

  const run = async (label: string, name: string, input: Record<string, unknown>) => {
    const my = ++gen.current
    setBusy(`${label} läuft …`); setErr(null)
    let last = -1, since = Date.now()
    try {
      for (;;) {
        const r = await window.api.runTool(name, input)
        if (gen.current !== my) return
        const pct = runningPct(r.text)
        if (pct === null) {
          setOut({ ...r, video: typeof input.video === 'string' ? input.video : undefined })
          const v = name === 'import_video' ? parseVideo(r.text) : null
          if (v) setImported(v)
          return
        }
        if (pct !== last) { last = pct; since = Date.now() }
        if (Date.now() - since > STALL_MS) { setErr(`${label}: seit 30 min kein Fortschritt (${pct} %) – Abfrage beendet, später erneut starten.`); return }
        setPolling(true)
        setBusy(`${label} läuft … ${pct} %`)
        await new Promise((ok) => setTimeout(ok, 2000))
        if (gen.current !== my) return
      }
    } catch (e) { if (gen.current === my) setErr(errText(e)) } finally { if (gen.current === my) { setBusy(null); setPolling(false) } }
  }
  const cancel = () => { gen.current++; setBusy(null); setPolling(false); setErr('Abfrage abgebrochen; der Auftrag läuft im Hintergrund weiter und lässt sich erneut abrufen.') }

  // Kontaktabzug: 8 Zeitpunkte über die Ausschnitte der Clip-Folie, die Länge des Timeline-Clips oder das ganze Video
  const frames = async () => {
    if (!src) return
    let spans: [number, number][]
    if (clip) spans = clip.parts.map((p) => [p.start, p.end])
    else {
      const c = cut?.tracks.flatMap((t) => t.clips).find((x) => x.src === src)
      try { spans = [c ? [c.in, c.out] : [0, await lengthOf(src, false)]] } catch (e) { setErr(errText(e)); return }
    }
    const total = spans.reduce((s, [a, b]) => s + b - a, 0), times: number[] = []
    if (!(total > 0)) return setErr('Kontaktabzug: kein Ausschnitt mit Länge')
    for (let k = 0; k < 8; k++) {
      let t = ((k + 0.5) * total) / 8
      const sp = spans.find(([a, b]) => (t -= b - a) < 0)!
      times.push(Math.round((sp[1] + t) * 10) / 10)
    }
    await run('Kontaktabzug', 'video_frames', { video: src, times })
  }

  // Treffer → Ausschnitt der Clip-Folie bzw. Clip auf V1 am Ende
  const takeHit = (h: Hit) => {
    setErr(null)
    if (clip) {
      if (clip.parts.length >= MAX_PARTS) return setErr(`Höchstens ${MAX_PARTS} Ausschnitte je Clip`)
      patchSlide(index, { content: { ...clip, parts: [...clip.parts, { start: h.from, end: h.to }] } })
    } else if (cut) {
      try { patchSlide(index, { content: appendClip(cut, 'video', false, { src: out!.video!, in: h.from, out: h.to }, deliverOf(cut).fps) }) } catch (e) { setErr(errText(e)) }
    }
  }
  const canHit = (clip && out?.video === clip.video) || (cut && out?.video)

  const addFile = async (kind: 'video' | 'audio' | 'image') => {
    setPick(false); setErr(null)
    if (!cut) return
    try {
      const f = kind === 'image' ? await window.api.pickImage() : await window.api.pickMedia(kind)
      if (!f) return
      const audio = kind === 'audio'
      const len = kind === 'image' ? IMAGE_LEN : await lengthOf(f, audio)
      const fps = deliverOf(cut).fps
      patchSlide(index, { content: appendClip(cut, audio ? 'audio' : 'video', true, { src: f, in: 0, out: Math.floor(len * fps) / fps }, fps) })
    } catch (e) { setErr(errText(e)) }
  }

  const off = !!busy
  return (
    <details className="vt">
      <summary>Werkzeuge</summary>
      <form className="vt-row" onSubmit={(e) => { e.preventDefault(); if (url.trim()) void run('Import', 'import_video', { url: url.trim() }) }}>
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Video per Link importieren" aria-label="Link zum Video" />
        <button className="pill" disabled={off || !url.trim()}>Laden</button>
      </form>
      <div className="vt-row">
        <button className="pill" disabled={off || !src} onClick={() => void run('Transkription', 'transcribe_video', { video: src })}>Transkribieren</button>
        <button className="pill" disabled={off || !src} onClick={() => void run('Highlight-Suche', 'video_highlights', { video: src })}>Highlights finden</button>
        <button className="pill" disabled={off || !src} onClick={() => void frames()}>Kontaktabzug</button>
        {clip && <button className="pill" disabled={off} onClick={() => void run('Clip-Prüfung', 'check_clip', { slide: slide!.id })}>Clip prüfen</button>}
      </div>
      <form className="vt-row" onSubmit={(e) => { e.preventDefault(); if (src && query.trim().length >= 2) void run('Suche', 'search_transcript', { video: src, query: query.trim() }) }}>
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Im Transkript suchen" aria-label="Im Transkript suchen" />
        <button className="pill" disabled={off || !src || query.trim().length < 2}>Suchen</button>
      </form>
      {(cut || (hasClips && timeline) || (!timeline && newTimeline)) && (
        <div className="vt-row">
          {cut && <button className="pill" disabled={off} aria-expanded={pick} onClick={() => setPick(!pick)}>Clip hinzufügen …</button>}
          {pick && <>
            <button className="plain" onClick={() => void addFile('video')}>Video</button>
            <button className="plain" onClick={() => void addFile('audio')}>Ton</button>
            <button className="plain" onClick={() => void addFile('image')}>Bild</button>
          </>}
          {!timeline && newTimeline && <button className="pill" disabled={off} title="Mehrspur-Schnitt mit Farbkorrektur, Ton-EQ und Ausgabe bis 4K/ProRes" onClick={newTimeline}>Neue Timeline</button>}
          {hasClips && timeline && (
            <button className="pill" disabled={off} title="Ersetzt den Inhalt der Timeline durch alle sichtbaren Clip-Folien"
              onClick={() => void (async () => {
                const has = (timeline.content as TimelineContent).tracks?.some((t) => t.clips.length)
                if (has && !await confirmDialog({ title: 'Timeline ersetzen?', text: 'Die Timeline hat schon Clips. Sie werden durch die Clip-Folien ersetzt.', ok: 'Ersetzen', danger: true })) return
                await run('Übernahme', 'edit_timeline', { slide: timeline.id, ops: [{ op: 'from_clips' }] })
              })()}>Clip-Folien in Timeline übernehmen</button>
          )}
        </div>
      )}
      {(busy || err) && <p className={err ? 'vt-msg err' : 'vt-msg'} role="status">{err ?? busy}{polling && busy && <button className="plain" onClick={cancel}>Abbrechen</button>}</p>}
      {out && (
        <div className="vt-out">
          <div className="vt-text">
            {out.text.split('\n').map((l, k) => {
              const h = canHit ? parseHits(l)[0] : undefined
              return h ? <button key={k} className="vt-hit" title={clip ? 'Als Ausschnitt anfügen' : 'Als Clip ans Ende von V1'} onClick={() => takeHit(h)}>{h.line}</button> : <div key={k}>{l || ' '}</div>
            })}
          </div>
          {out.images.length > 0 && <div className="vt-imgs">{out.images.map((s, k) => <img key={k} src={s} alt={`Bild ${k + 1}`} />)}</div>}
        </div>
      )}
    </details>
  )
}
