// Deckvid: Arbeitsansicht für Video-Decks (Folien im Layout clip). Fast alles läuft über die KI (Chat und Ein-Klick-Aufträge);
// von Hand gibt es nur, was einfacher ist als ein Satz: abspielen, Feinschnitt, Entfernen, Export.
import { Fragment, memo, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ArrowUp, Check, ChevronLeft, Paperclip, Pause, Play, RotateCcw, RotateCw, Settings, Share, Square, Undo2 } from 'lucide-react'
import { sizeOf, type Deck, type Size, type Slide } from '../../shared/deck'
import { lintClip, type ClipIssue } from '../../shared/clip-lint'
import { LAYOUTS, type LayoutId } from '../../shared/layouts'
import { resolveTheme } from '../../shared/themes'
import { CLIP_STYLES, CUT, DUCK, FX, OVERLAY_W, STILL, cutFrames, clipSpans, clipWords, fillerQuiet, mmss, partsLength, zoomOf, cutIndex, ovPos, listStep, type ClipContent, type Look, type Overlay, type Part } from '../../shared/video'
import { SlideView, loadCustomFont } from '../slide'
import { WIN, winOfTtf } from '../../shared/font-win'
import { ChatLog, ModelSelect, type Msg } from './Chat'
import { ClipCutter } from './ClipCutter'
import { TimelineEditor } from './timeline/TimelineEditor'
import { deliverOf, tlDuration, type TimelineContent } from '../../shared/timeline'
import { WorkSteps } from './DeckvidWork'
import { VideoTools } from './VideoTools'
import { ClipVideo, Strip, captionAt, clipUrl, useClipPlayer } from './clipPlayer'
import { confirmDialog } from './kit'
import { SourceChips, VIDEO_EXAMPLES, sourceContext, useSource } from './Start'
import { OpenSettings } from './settings/parts'
import type { Status } from './TopBar'
import './deckvid.css'

type Cached = NonNullable<Awaited<ReturnType<Window['api']['videoCached']>>>
type ClipSlide = Omit<Slide, 'content'> & { content: ClipContent } // Slide.content ist any

const isClip = (s: Slide | undefined): s is ClipSlide => s?.layout === 'clip' && !!s.content?.video && !!s.content.parts?.length
// Andere Folien: section ist ein Zwischentitel, sonst Titel oder Layoutname
const labelOf = (s: Slide) => {
  const t = typeof s.content?.title === 'string' ? s.content.title.trim() : ''
  return s.layout === 'section' ? `Zwischentitel${t ? `: ${t}` : ''}` : `Folie: ${t || (LAYOUTS[s.layout as LayoutId]?.name ?? s.layout)}`
}
const RANK = { error: 0, warn: 1, info: 2 }
const count = (xs: ClipIssue[]) => xs.filter((x) => x.severity !== 'info').length // Infos zählen nicht
const where = (s: ClipSlide, n: number) =>
  `Clip ${n} (Folie ${s.id}), Quelle ${s.content.video}, parts ${s.content.parts.map((p) => `${p.start}–${p.end}`).join(', ')}`

// Ein-Klick-Aufträge für einen Short (hoch, quadratisch): der Satz steht im Chat, der Bezug geht nur an die KI
const TASKS: [label: string, ask: string][] = [
  ['Kürzer', 'Mach diesen Clip kürzer: nur der stärkste Teil, ohne Anlauf.'],
  ['Stärkerer Einstieg', 'Lass diesen Clip direkt mit dem stärksten Satz beginnen.'],
  ['Neuer Hook', 'Schreib einen neuen, stärkeren Hook für diesen Clip.'],
  ['Ruhigere Untertitel', 'Mach die Untertitel dieses Clips ruhiger: ganze Sätze statt Wort für Wort.'],
  ['Andere Stelle', 'Nimm für diesen Clip eine andere starke Stelle aus demselben Video, die noch kein Clip nutzt.'],
  ['Post-Text', 'Schreib für diesen Clip den Post-Text (post): Titel, 1–2 Sätze, 3–5 Hashtags, und wähl ein Cover (cover).'],
]
// Ganzes Video (quer); Untertitel an/aus schaltet die Ansicht selbst
const WIDE_TASKS: [label: string, ask: string][] = [
  ['Straffer schneiden', 'Schneide dieses Video straffer: Füllsätze und Wiederholungen raus, der Inhalt bleibt.'],
  ['Kapitel als Zwischentitel', 'Füge vor jedem Themenwechsel einen kurzen Zwischentitel ein (Layout section) und teile den Clip dafür an diesen Stellen.'],
]

// Lautheit (dBFS je Sekunde) → 0..1, auf höchstens 600 Werte verdichtet (Maximum je Abschnitt): ein 8-h-Stream hätte sonst 28 800 Pfadpunkte
const loudCurve = (loud: number[]) => {
  const n = Math.min(600, loud.length), k = loud.length / n
  return Array.from({ length: n }, (_, i) => Math.min(1, Math.max(0, (Math.max(...loud.slice(Math.floor(i * k), Math.max(Math.floor(i * k) + 1, Math.floor((i + 1) * k)))) + 60) / 60)))
}

// Fenster-Tasten über eine Ref: ein Listener für die ganze Lebenszeit, der Handler sieht trotzdem den aktuellen Stand
function useKey(fn: (e: KeyboardEvent) => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const h = (e: KeyboardEvent) => ref.current(e)
    addEventListener('keydown', h)
    return () => removeEventListener('keydown', h)
  }, [])
}
// Tasten der Ansicht nicht beim Tippen, nicht mit Modifikator und nicht, solange ein Dialog, Menü oder Dropdown offen ist (Feinschnitt fängt seine Tasten selbst ab).
// emptyAsk: auch im leeren Chatfeld, dort steht der Cursor nach dem Senden (nur für die Leertaste, Buchstaben wären Text)
const keysFree = (e: KeyboardEvent, emptyAsk = false) => {
  const t = e.target as HTMLElement
  const typing = t.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !(emptyAsk && t.matches('.dv-ask input') && !(t as HTMLInputElement).value))
  return !(e.ctrlKey || e.metaKey || e.altKey || typing || t.closest('[role=menu], [role=listbox]')
    || document.querySelector('[aria-modal="true"], dialog[open], .kit-menu, [role=menu]'))
}

interface Props {
  deck: Deck | null
  index: number
  msgs: Msg[]
  busy: boolean
  status: Status | null
  saved: boolean
  path: string | null
  model: string
  onModel: (id: string) => void
  onSend: (text: string, context?: string) => boolean
  onAbort: () => void
  onSelect: (i: number) => void
  onHome: () => void
  onExport: (format: 'mp4' | 'clips') => void
  exporting: boolean // Video-Export läuft
  onSlides: () => void // Ausweg in den normalen Folien-Editor
  onDeckSheet?: () => void // Sheet „Deck“: Titel, Briefing, Musik
  patchSlide: (i: number, p: Partial<Slide>) => void
  newTimeline?: () => void // leere Pro-Timeline (Layout schnitt) am Ende anlegen
  delSlide: (i: number) => void
  canUndo: boolean // letzter KI-Zug lässt sich zurücknehmen
  onUndo: () => void
}

// Der Player rendert je Bild neu; er sitzt in ClipStage, damit Liste und Chat dabei stillstehen
export function Deckvid(p: Props) {
  const { deck, index, busy, onSend } = p
  const openSettings = useContext(OpenSettings)
  const size = sizeOf(deck)
  const wide = size.w > size.h // Querformat: ganzes Video statt Shorts
  const slides = deck?.slides ?? []
  const slide = slides[index]
  const clip = isClip(slide) ? slide : null
  const clips = slides.filter(isClip)
  const cut = slide?.layout === 'schnitt' ? (slide.content as TimelineContent) : null // Pro-Timeline
  const no = (s: Slide) => slides.slice(0, slides.indexOf(s) + 1).filter(isClip).length // Clip-Nummer wie in der Liste
  const here = clip ? where(clip, no(clip)) : undefined
  const { srcs, attach, remove, clear, err } = useSource()
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState(false)
  const [cutting, setCutting] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  // Ausgeblendete Folie gewählt (z. B. die erste, die nur als Einblendung dient): zur ersten sichtbaren springen
  useEffect(() => { const j = slides.findIndex((s) => !s.hidden); if (slides[index]?.hidden && j >= 0) p.onSelect(j) }, [index, slides]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setMenu(false) }
    addEventListener('pointerdown', close)
    return () => removeEventListener('pointerdown', close)
  }, [menu])
  useEffect(() => { if (!clip) setCutting(false) }, [!clip])
  useEffect(() => { list.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }) }, [index])

  // Cache je Quelle (Lautheit, Highlights, Transkript): beim ersten Zeigen geholt, nach jedem KI-Zug und Export neu; gerechnet wird dabei nie
  const [cache, setCache] = useState<Record<string, Cached | null>>({})
  const asked = useRef(new Set<string>()) // seit dem letzten KI-Zug oder Export schon angefragt
  const idle = !busy && !p.exporting
  const [fresh, setFresh] = useState<Record<string, boolean>>({}) // Cache der Quelle ist seit dem letzten KI-Zug/Export neu geladen
  const videos = [...new Set(clips.map((s) => s.content.video))].join('\n') // alle Quellen, damit die Punkte in der Liste für jeden Clip stimmen
  useEffect(() => {
    if (!idle) { asked.current.clear(); setFresh((f) => Object.keys(f).length ? {} : f); return }
    for (const video of videos.split('\n')) {
      if (!video || asked.current.has(video)) continue
      asked.current.add(video)
      window.api.videoCached(video).then((d) => { setCache((m) => ({ ...m, [video]: d })); setFresh((f) => ({ ...f, [video]: true })) }, () => asked.current.delete(video))
    }
  }, [videos, idle])

  // Prüfung je Clip; erst wenn der Cache seiner Quelle geladen ist (sonst flackert „Transkript fehlt“)
  const issues = useMemo(() => {
    const others = clips.map((s) => ({ video: s.content.video, parts: s.content.parts }))
    const out: Record<string, ClipIssue[]> = {}
    clips.forEach((s, k) => {
      const d = cache[s.content.video]
      if (d === undefined) return
      const info = { duration: d?.duration, transcript: d?.transcript, music: d?.signals?.music }
      out[s.id] = lintClip(s.content, size, info, others, k).sort((a, b) => RANK[a.severity] - RANK[b.severity])
    })
    return out
  }, [slides, cache, size.w, size.h])

  useKey((e) => {
    if (cut || !keysFree(e) || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || !slides.length) return // schnitt: ←/→ steppen im Editor Bilder
    e.preventDefault()
    p.onSelect(Math.max(0, Math.min(slides.length - 1, index + (e.key === 'ArrowLeft' ? -1 : 1))))
  })

  const names = srcs.length ? ` · ${srcs.map((s) => s.name).join(', ')}` : ''
  const withSrcs = (ctx?: string) => [ctx, srcs.length > 0 && sourceContext(srcs)].filter(Boolean).join('\n\n') || undefined
  const submit = () => {
    const text = draft.trim() || (srcs.length ? 'Nutze diese Videos.' : '')
    if (text && onSend(text + names, withSrcs(here))) { setDraft(''); clear() }
  }
  // Standardwert = Feld weglassen, wie die KI es schreibt
  const setClip = (x: Partial<ClipContent>) => {
    if (!clip) return
    const content: Partial<ClipContent> = { ...clip.content, ...x }
    for (const k of Object.keys(x) as (keyof ClipContent)[]) if (x[k] === undefined) delete content[k]
    p.patchSlide(index, { content })
  }
  const removeClip = async () => {
    if (clip && await confirmDialog({ title: 'Clip entfernen?', text: 'Der Clip verschwindet aus dem Video. Rückgängig mit Strg+Z.', ok: 'Entfernen', danger: true })) p.delSlide(index)
  }

  const state = p.status?.text ?? (!deck ? '' : !p.saved ? 'Bearbeitet' : p.path ? 'Gespeichert' : 'Nicht gespeichert')
  const pct = p.status?.text.match(/(\d+) %$/)?.[1] // Video-Export meldet „… 37 %“
  const thumbW = Math.min(96, (72 * size.w) / size.h)
  const undo = p.canUndo && <button className="plain tint" title="Den letzten Auftrag an die KI zurücknehmen" onClick={p.onUndo}><Undo2 size={14} />Rückgängig</button>

  return (
    <>
      <header className="top">
        <div className="top-l"><button className="plain tint" onClick={p.onHome}><ChevronLeft size={16} />Decks</button></div>
        <div className="top-title" title={p.path ?? undefined}>
          <b>{deck?.title ?? 'Neues Video'}</b>
          {state && <span className={p.status?.error ? 'error' : undefined} role="status">— {state}</span>}
        </div>
        <div className="top-r">
          {p.onDeckSheet && <button className="plain" disabled={!deck} title="Titel, Briefing und Musik" onClick={p.onDeckSheet}>Deck</button>}
          <button className="plain" disabled={!deck} title="Alle Folien mit allen Werkzeugen bearbeiten" onClick={p.onSlides}>Folien-Ansicht</button>
          <button className="plain" title="Einstellungen" aria-label="Einstellungen" onClick={() => openSettings()}><Settings size={17} /></button>
          <div className="top-export" ref={box}>
            <button className="pill tint" disabled={!(clips.length || slides.some((s) => s.layout === 'schnitt')) || !idle} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Share size={14} />Exportieren</button>
            {menu && (
              <div className="menu material" role="menu">
                <button role="menuitem" onClick={() => { setMenu(false); p.onExport('clips') }}>Shorts einzeln (MP4)</button>
                <button role="menuitem" onClick={() => { setMenu(false); p.onExport('mp4') }}>Ganzes Video (MP4)</button>
              </div>
            )}
          </div>
        </div>
        {pct && <i className="dv-progress" style={{ width: `${pct}%` }} aria-hidden />}
      </header>

      <div className="dv">
        <nav className="dv-list" aria-label="Clips" ref={list}>
          {clips.length > 0 && <div className="dv-list-head"><b>{wide ? 'Ablauf' : 'Shorts'}</b><span>{clips.length} · {mmss(clips.reduce((t, s) => t + partsLength(s.content.parts), 0))}</span></div>}
          {slides.map((s, i) => s.hidden ? null : isClip(s) ? ( // ausgeblendet: nicht im Video (Folien als Einblendung, overlays.slide)
            <button key={s.id} className="dv-item" aria-current={i === index} onClick={() => p.onSelect(i)}>
              <span className="dv-thumb" style={{ width: thumbW, aspectRatio: `${size.w} / ${size.h}`, backgroundImage: `url("${clipUrl(s.content.video)}?frame=${s.content.cover ?? s.content.parts[0].start}")`, backgroundPosition: `${(s.content.parts[0].focus ?? 0.5) * 100}% 50%` }} />
              <span><b>{s.content.hook || `Clip ${no(s)}`}</b><small>{mmss(partsLength(s.content.parts))}<Flag xs={issues[s.id]} /></small></span>
            </button>
          ) : s.layout === 'schnitt' ? (
            <button key={s.id} className="dv-item" aria-current={i === index} onClick={() => p.onSelect(i)}>
              <span><b>Timeline</b><small>{mmss(tlDuration(s.content as TimelineContent))}</small></span>
            </button>
          ) : (
            <button key={s.id} className="dv-item dv-sep" aria-current={i === index} onClick={() => p.onSelect(i)}>{labelOf(s)}</button>
          ))}
          {clips.length > 0 && !wide && (
            <button className="pill dv-more" disabled={busy} onClick={() => onSend('Mach weitere Shorts aus demselben Video: starke Stellen, die noch kein Clip nutzt.', `Vorhandene Clips: ${clips.map((s) => where(s, no(s))).join(' · ')}`)}>Weitere Shorts</button>
          )}
        </nav>

        {clip ? (
          <ClipStage key={clip.id} clip={clip} n={no(clip)} total={clips.length} here={here!} size={size} deck={deck} accent={deck ? resolveTheme(deck.theme).c.accent : 'var(--accent)'}
            parts={clips.filter((s) => s.content.video === clip.content.video).flatMap((s) => s.content.parts)} cached={cache[clip.content.video] ?? null} issues={issues[clip.id] ?? []} fresh={!!fresh[clip.content.video]}
            busy={busy} onSend={onSend} undo={undo} onCut={() => setCutting(true)} onRemove={() => void removeClip()} onContent={setClip} />
        ) : cut ? (
          <section className="dv-main" aria-label="Timeline">
            <TimelineEditor key={slide!.id} content={cut} onCommit={(c) => p.patchSlide(index, { content: c })} aspect={size.w / size.h} fps={deliverOf(cut).fps} />
          </section>
        ) : (
          <section className="dv-main" aria-label="Vorschau">
            <div className="dv-empty">
              {busy ? (
                <WorkSteps msgs={p.msgs} busy={busy} />
              ) : slide ? (
                <p>{labelOf(slide)} – steht im fertigen Video {STILL} Sekunden zwischen den Clips.</p>
              ) : (
                <>
                  <p>Häng ein Video an oder füg einen Link in den Chat ein und sag, was daraus werden soll.</p>
                  <div>
                    {VIDEO_EXAMPLES.map(([label, full, hint]) => (
                      <button key={label} className="pill" onClick={() => { if (onSend(full + names, withSrcs(hint))) clear() }}>{label}</button>
                    ))}
                  </div>
                </>
              )}
              {!busy && undo}
            </div>
          </section>
        )}

        <aside className="dv-chat" aria-label="KI">
          <VideoTools deck={deck} slide={slide} index={index} patchSlide={p.patchSlide} newTimeline={p.newTimeline} />
          <ChatLog className="dv-log" msgs={p.msgs} busy={busy} onSend={onSend} />
          {!p.msgs.length && clips.length > 0 && (
            <p className="dv-hint">{wide ? 'Die KI kennt dein Video. Sag zum Beispiel: „Schneid die Begrüßung raus“ oder „Kürz das Video auf zehn Minuten“.' : 'Die KI kennt dein Video. Sag zum Beispiel: „Mach den zweiten Clip spannender“ oder „Noch zwei Shorts mit den lustigsten Stellen“.'}</p>
          )}
          <form className="dv-ask" onSubmit={(e) => { e.preventDefault(); submit() }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { const f = [...e.dataTransfer.files]; if (f.length) { e.preventDefault(); attach(f.map(window.api.pathOf)) } }}>
            {(srcs.length > 0 || err) && <div className="dv-files"><SourceChips srcs={srcs} remove={remove} err={err} /></div>}
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={busy ? 'Die KI arbeitet …' : 'Sag der KI, was sie ändern soll …'} aria-label="Wunsch an die KI" />
            <div className="dv-ask-bar">
              <button type="button" className="plain" aria-label="Video anhängen" title="Video anhängen (oder hierher ziehen)" disabled={busy} onClick={() => attach()}><Paperclip size={16} /></button>
              <ModelSelect value={p.model} onChange={p.onModel} />
              {busy
                ? <button type="button" className="round stop" aria-label="Stoppen" onClick={p.onAbort}><Square size={12} fill="currentColor" /></button>
                : <button type="submit" className="round" aria-label="Senden (Enter)" disabled={!draft.trim() && !srcs.length}><ArrowUp size={17} strokeWidth={2.4} /></button>}
            </div>
          </form>
        </aside>
      </div>
      {cutting && clip && (
        <ClipCutter key={clip.id} content={clip.content} size={size} disabled={busy}
          onApply={(parts) => p.patchSlide(index, { content: { ...clip.content, parts } })} onClose={() => setCutting(false)} />
      )}
    </>
  )
}

// Kleiner Punkt + Zahl in der Clip-Liste; nur Fehler und Warnungen
function Flag({ xs }: { xs?: ClipIssue[] }) {
  const k = xs ? count(xs) : 0
  if (!k) return null
  const e = xs!.filter((x) => x.severity === 'error').length
  return <span className={`dv-flag${e ? ' err' : ''}`} role="img" aria-label={`${k} ${k === 1 ? 'Hinweis' : 'Hinweise'}${e ? `, davon ${e} Fehler` : ''}`}><i aria-hidden />{k}</span>
}

// Prüfhinweise des gewählten Clips: höchstens 4 sichtbar, Rest aufklappbar
function Hints({ xs, busy, onFix }: { xs: ClipIssue[]; busy: boolean; // busy: KI arbeitet oder Cache noch nicht neu geladen
   onFix: () => void }) {
  const [all, setAll] = useState(false)
  const shown = all ? xs : xs.slice(0, 4)
  return (
    <div className="dv-hints" role="group" aria-label="Prüfhinweise">
      <ul>{shown.map((x, k) => <li key={k} className={x.severity}><span className="dv-sr">{x.severity === 'error' ? 'Fehler: ' : 'Hinweis: '}</span>{x.message}</li>)}</ul>
      <div>
        {xs.length > 4 && <button className="plain" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Weniger' : `+ ${xs.length - 4} weitere`}</button>}
        {count(xs) > 0 && <button className="pill" disabled={busy} onClick={onFix}>Von der KI beheben lassen</button>}
      </div>
    </div>
  )
}

// Post-Text des Clips: Titelzeile hervorgehoben, lange Texte eingeklappt; Kopieren meldet sich per aria-live
function Post({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [title, ...rest] = text.trim().split('\n')
  const body = rest.join('\n').trim()
  const long = body.length > 160 || rest.length > 4
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <div className="dv-post" role="group" aria-label="Post-Text">
      <b>{title}</b>
      {body && <p className={long && !open ? 'clamp' : undefined}>{body}</p>}
      <div>
        {long && <button className="plain" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'weniger' : 'mehr'}</button>}
        <button className="pill" onClick={() => { void navigator.clipboard.writeText(text.trim()).then(() => setCopied(true), () => setCopied(false)) }}>Kopieren</button>
        <span role="status" aria-live="polite">{copied ? 'Kopiert' : ''}</span>
      </div>
    </div>
  )
}

// Schrift, die der MP4-Export brennt (subFont in export-video.ts): Head-Schrift des Themes, wenn einbettbar, sonst Archivo Bold.
// win = Zeilenhöhe in em wie in libass, hhea = Inhaltshöhe der Zeile in Chromium (für die Fläche hinter dem Hook).
function useSubFace(deck: Deck | null) {
  const head = deck ? resolveTheme(deck.theme).head : null
  const own = head && (head.embed || head.files) ? head : null
  const css = own?.css ?? 'Archivo', bold = !own || (own.files ? !!own.files.bold : !own.single), file = own?.files ? own.files.bold ?? own.files.regular : null
  const [m, setM] = useState<{ key: string; win?: number; hhea: number }>()
  const key = `${css}|${bold}|${file}`
  useEffect(() => {
    let off = false
    void (async () => {
      if (deck) await loadCustomFont(deck)
      const font = `${bold ? 700 : 400} 100px "${css}"`
      await document.fonts.load(font)
      const g = document.createElement('canvas').getContext('2d')!
      g.font = font
      const t = g.measureText('H')
      const win = file ? await fetch(file).then((r) => r.ok ? r.arrayBuffer() : undefined).then((b) => b && winOfTtf(b)).catch(() => undefined) : undefined
      if (!off) setM({ key, win, hhea: (t.fontBoundingBoxAscent + t.fontBoundingBoxDescent) / 100 })
    })().catch((e) => console.warn('[deckvid] Schriftmaße', e))
    return () => { off = true }
  }, [key])
  const ok = m?.key === key ? m : undefined, hhea = ok?.hhea ?? 1.2 // bis die Schrift geladen ist: Näherung
  return { css, weight: bold ? 700 : 400, win: ok?.win ?? (own ? (own.embed ? WIN[own.embed] : undefined) : WIN.Archivo) ?? hhea, hhea }
}

// Farblook der Vorschau als CSS-filter aufs Video (der Export nimmt ffmpeg-Filter mit derselben Absicht); auto misst erst der Export
const LOOK_CSS: Record<Look, string> = {
  neutral: '', warm: 'sepia(.15) saturate(1.1)', kuehl: 'hue-rotate(-8deg) saturate(.95) brightness(1.02)', kontrast: 'contrast(1.12) saturate(1.15)',
  matt: 'contrast(.9) brightness(1.04) saturate(.85)', sw: 'grayscale(1) contrast(1.05)', auto: '',
}

// Einblendungs-Video stumm, synchron zur Clipzeit: t = Sekunde im Einblend-Video; beim Abspielen erst ab 0,3 s Abweichung nachstellen (sonst ruckelt es)
function OvVideo({ src, t, run, w }: { src: string; t: number; run: boolean; w?: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (Math.abs(v.currentTime - t) > (run ? 0.3 : 0.05)) v.currentTime = t
    if (run && v.paused) void v.play().catch(() => {})
    else if (!run && !v.paused) v.pause()
  })
  return <video ref={ref} src={clipUrl(src)} muted playsInline preload="auto" style={{ width: w }} />
}

// Ausgeblendete Folie n (1-basiert) als Einblendung; memo, weil SlideView bei jedem Rendern misst und die Bühne je Bild neu rendert
const OvSlide = memo(function OvSlide({ deck, n, w }: { deck: Deck | null; n: number; w?: string }) {
  const ref = useRef<HTMLDivElement>(null), [px, setPx] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setPx(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return <div ref={ref} className="dv-ov-slide" style={{ width: w }}>{deck?.slides[n - 1]?.hidden && px > 0 && <SlideView deck={deck} index={n - 1} width={px} />}</div> // fehlt sie oder ist sichtbar: nichts (meldet die Clip-Prüfung)
})

// Einblendung wie im Export: on = ihre Quellzeit ist gerade im Clip zu sehen, at = Clip-Sekunden seit ihrem ersten Stück, len = bis zum Ende des letzten (langsamer Zoom bei voll)
function Ov({ o, on, at, len, playing, deck }: { o: Overlay; on: boolean; at: number; len: number; playing: boolean; deck: Deck | null }) {
  const art = o.art ?? 'text', op = { opacity: on ? 1 : 0 }
  if (art === 'verpixeln' || art === 'markierung') {
    const [x, y, w, h] = o.box ?? [0, 0, 0, 0], label = o.text && <span className={y > 0.08 ? 'over' : 'under'}>{o.text}</span>
    return <div className={art === 'verpixeln' ? 'dv-pix' : 'dv-mark'} style={{ ...op, left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }} aria-hidden>{art === 'markierung' && label}</div>
  }
  const pos = ovPos(o)
  const w = pos === 'voll' ? undefined : `${OVERLAY_W[o.size ?? 'mittel'] * 100}cqw`
  const rule = <i className="dv-rule" />, sub = o.sub && <small>{o.sub}</small>
  const body = o.image ? <img src={clipUrl(o.image)} alt="" style={{ width: w, '--dv-kb': Math.min(1, at / Math.max(0.001, len)) } as CSSProperties} />
    : o.video ? <OvVideo src={o.video} t={(o.from ?? 0) + at} run={on && playing} w={w} />
    : o.slide ? <OvSlide deck={deck} n={o.slide} w={w} />
    : art === 'bauchbinde' ? <>{rule}<b>{o.text}</b>{sub}</>
    : art === 'zahl' ? <><b>{o.text}</b>{rule}{sub}</>
    : art === 'titel' ? <><b>{o.text}</b>{sub}</>
    : art === 'zitat' ? <><b>„{o.text?.replace(/^[„“"»«]+|[„“"»«]+$/g, '')}“</b>{sub}</>
    : art === 'abspann' ? <>{rule}<b>{o.text}</b>{sub}</>
    : art === 'liste' ? <>{rule}{o.text && <b>{o.text}</b>}{sub}{o.items?.map((x, k) => <span key={k} className="dv-li" style={{ opacity: at >= k * listStep(o.items!.length, len) - 1e-3 ? 1 : 0 }}>{x}</span>)}</>
    : o.text
  return (
    <>
      {(art === 'titel' || art === 'zitat' || art === 'abspann') && <div className="dv-dim" style={op} aria-hidden />}
      <div className={`dv-ov ${pos} ${art}${on ? ' on' : ''}`} style={op} aria-hidden>{body}</div>
    </>
  )
}

interface StageProps {
  clip: ClipSlide; n: number; total: number; here: string; size: Size; accent: string; deck: Deck | null
  parts: ClipContent['parts'] // alle Ausschnitte aus derselben Quelle, für die Zeitleiste
  cached: Cached | null
  issues: ClipIssue[]; fresh: boolean
  busy: boolean; onSend: (text: string, context?: string) => boolean; undo: ReactNode; onCut: () => void; onRemove: () => void
  onContent: (x: Partial<ClipContent>) => void // undefined = Standard, Feld fällt weg
}

// Vorschau mit Detailspalte, Aufträge und Quell-Zeitleiste des gewählten Clips (Bereiche main und line im Grid). key = Folien-ID: ein anderer Clip startet frisch.
function ClipStage({ clip, n, total, here, size, accent, deck, parts, cached, issues, fresh, busy, onSend, undo, onCut, onRemove, onContent }: StageProps) {
  const c = clip.content
  const videoRef = useRef<HTMLVideoElement>(null), fadeRef = useRef<HTMLCanvasElement>(null), musicRef = useRef<HTMLAudioElement>(null)
  // Überblendung wie im Export (cutFrames: Jump-Cut kurz, neuer Moment länger): das letzte Bild vor dem Schnitt liegt über dem neuen und blendet aus
  // transition none = harter Schnitt; wipe, zoom … macht nur der Export (xfade), die Vorschau zeigt dafür diese Blende
  const dissolve = (gap: number, next: Part) => {
    const v = videoRef.current, cv = fadeRef.current
    if (!v || !cv || !v.videoWidth || next.transition === 'none') return
    const st = getComputedStyle(v)
    Object.assign(cv.style, { objectFit: st.objectFit, objectPosition: st.objectPosition, transform: st.transform, filter: st.filter })
    cv.width = v.videoWidth; cv.height = v.videoHeight
    cv.getContext('2d')?.drawImage(v, 0, 0)
    cv.getAnimations().forEach((a) => a.cancel())
    cv.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ((next.transition ? CUT.momentFrames : cutFrames(gap)) / 30) * 1000 }) // eigener Übergang: Länge wie im Export
  }
  const player = useClipPlayer(videoRef, c.parts, dissolve)
  const [bad, setBad] = useState(false) // Chromium spielt die Quelle nicht (HEVC, ProRes …)
  const jump = (d: number) => player.seekClip(Math.max(0, Math.min(player.duration - 0.05, player.t + d)))
  // Leertaste/K: Pause und Weiter, J/L: 10 s zurück/vor wie bei YouTube (←/→ wechseln den Clip)
  useKey((e) => {
    const k = e.key.toLowerCase()
    if (e.repeat || (k === ' ' && (e.target as Element).closest('button'))) return // Leertaste auf einem Knopf löst ihn selbst aus
    if (k === ' ' ? keysFree(e, true) : k === 'k' && keysFree(e)) { e.preventDefault(); player.toggle() }
    else if ((k === 'j' || k === 'l') && keysFree(e)) { e.preventDefault(); jump(k === 'j' ? -10 : 10) }
  })

  const mode = c.captions ?? 'wort' // Standard wie im Export
  // wie im Export: bei pauses kurz fallen Füllwörter weg, geschätzte Wortzeiten verteilen sich dann ohne sie
  const words = useMemo(() => {
    const t = cached?.transcript
    if (!t || mode === 'aus') return null
    return clipWords(t, c.parts, c.pauses === 'kurz' ? c.parts.flatMap((x) => fillerQuiet(t, x.start, x.end)) : [])
  }, [cached, c, mode])
  const cap = words && mode !== 'aus' ? captionAt(words, player.t, mode) : null
  // Hintergrundmusik wie im MP4 (finish in export-video.ts, Werte aus DUCK): Schleife über das ganze Video ab der Zeit der Folien davor (Standbilder STILL),
  // Ein-/Ausblende, Ducking per Sidechain auf dem echten Ton des Videos. ponytail: Pegel ohne loudnorm und ohne Ton „klar“; das Verhältnis Sprache/Musik stimmt
  const music = deck?.music?.src ? clipUrl(deck.music.src) : null, vol = Math.min(1, Math.max(0, deck?.music?.volume ?? DUCK.volume))
  const [before, videoLen] = useMemo(() => {
    const vis = (deck?.slides ?? []).filter((s) => !s.hidden), k = vis.findIndex((s) => s.id === clip.id)
    const len = (x: Slide) => (isClip(x) ? partsLength(x.content.parts) : STILL)
    return [vis.slice(0, Math.max(0, k)).reduce((s, x) => s + len(x), 0), vis.reduce((s, x) => s + len(x), 0)]
  }, [deck, clip.id])
  const mix = useRef<{ ctx: AudioContext; an: AnalyserNode; gain: GainNode; voice: GainNode; buf: Float32Array<ArrayBuffer>; env: number; at: number; base?: number; el?: HTMLAudioElement } | null>(null)
  useEffect(() => {
    const a = musicRef.current, v = videoRef.current
    if (!a || !v) return
    if (!mix.current) { // einmal je Clip: ein Medienelement lässt sich nur einmal an Web Audio hängen (crossOrigin, sonst käme nur Stille an)
      const ctx = new AudioContext(), an = ctx.createAnalyser(), gain = ctx.createGain(), voice = ctx.createGain()
      an.fftSize = 1024
      ctx.createMediaElementSource(v).connect(voice).connect(an).connect(ctx.destination) // voice: Originalton über 1 (bis 1 regelt useClipPlayer per video.volume)
      gain.connect(ctx.destination)
      mix.current = { ctx, an, gain, voice, buf: new Float32Array(an.fftSize), env: 0, at: 0 }
    }
    const m = mix.current, cur = c.parts[player.part]
    m.voice.gain.setTargetAtTime(Math.max(1, Math.min(2, cur?.volume ?? 1)), m.ctx.currentTime, 0.01) // weich, ein Sprung am Schnitt klickt
    if (m.el !== a) { m.ctx.createMediaElementSource(a).connect(m.gain); m.el = a } // andere Musik = neues <audio> (key)
    if (!player.playing) { a.pause(); m.at = 0; m.base = undefined; return }
    void m.ctx.resume()
    const pos = before + player.t, want = pos % (a.duration || Infinity)
    if (a.paused || Math.abs(a.currentTime - want) > 0.5) a.currentTime = want
    // wie sidechaincompress: Sprachpegel (RMS) mit Attack/Release geglättet, über der Schwelle im Verhältnis ratio leiser
    m.an.getFloatTimeDomainData(m.buf)
    const rms = Math.sqrt(m.buf.reduce((s, x) => s + x * x, 0) / m.buf.length), now = performance.now(), dt = m.at ? (now - m.at) / 1000 : 0
    m.at = now
    m.env += (rms - m.env) * (1 - Math.exp(-dt / ((rms > m.env ? DUCK.attackMs : DUCK.releaseMs) / 1000)))
    const duck = m.env > DUCK.threshold ? (m.env / DUCK.threshold) ** (1 / DUCK.ratio - 1) : 1
    const fade = Math.min(1, pos / DUCK.fadeIn, Math.max(0, (videoLen - pos) / DUCK.fadeOut))
    // Grundpegel je Ausschnitt (part.music), weich (Zeitkonstante 0,15 s, nach ~0,5 s am Ziel wie die Rampe im Export)
    const level = Math.min(1, Math.max(0, cur?.music ?? vol))
    m.base = m.base === undefined ? level : m.base + (level - m.base) * (1 - Math.exp(-dt / 0.15))
    m.gain.gain.setTargetAtTime(m.base * duck * fade, m.ctx.currentTime, 0.01)
    if (a.paused) void a.play().catch(() => {})
  }, [player.playing, player.t, before, videoLen, vol, music])
  useEffect(() => () => { void mix.current?.ctx.close() }, [])
  const curve = useMemo(() => cached?.signals?.loud.length ? loudCurve(cached.signals.loud) : undefined, [cached])

  const wide = size.w > size.h, m = Math.min(size.w, size.h)
  const live = c.style === 'lebendig' // ruhig/fehlend: keine Klasse, Darstellung wie bisher
  // Hook und Untertitel in Größe und Lage wie im MP4 (assSubs in export-video.ts), in cqw des Players.
  // ASS-Größe = Zeilenhöhe (win·em): CSS-Größe = Größe / win, Zeilenabstand win. Hook-Fläche (hookBox in video-fx.ts): Rand m·0,012 rundum, je Zeile eigene Breite.
  const face = useSubFace(deck), cq = (px: number) => (px / size.w) * 100
  const hookPx = m * (wide ? 0.045 : 0.06), pad = cq(m * 0.012)
  const screen = {
    '--dv-ratio': size.w / size.h,
    '--dv-font': `"${face.css}", "Archivo", sans-serif`,
    '--dv-weight': face.weight,
    '--dv-lh': face.win,
    '--dv-hook': `${cq(hookPx / face.win)}cqw`,
    '--dv-pad': `${pad}cqw`,
    '--dv-pad-y': `${pad + cq(hookPx / face.win) * ((face.win - face.hhea) / 2)}cqw`, // Inline-Fläche reicht nur über die Inhaltshöhe (hhea): auf Zeilenhöhe auffüllen
    '--dv-hook-y': wide ? '7%' : '12%',
    '--dv-sub': `${cq((m * (mode === 'satz' ? 0.055 : wide ? 0.065 : 0.075)) / face.win)}cqw`,
    '--dv-sub-y': wide ? '7%' : size.h / size.w >= 1.6 ? '33%' : '12%',
    '--dv-accent': accent,
    '--dv-ov': `${cq((m * 0.05) / face.win)}cqw`,
    '--dv-zoom': c.fit === 'blur' || c.fit === 'split' ? 1 : zoomOf(c.style, cutIndex(c.parts, Math.max(0, player.part))) * (c.parts[player.part]?.zoom ?? 1), // Punch-in mal Stil-Zoom wie im Export
    '--dv-look': LOOK_CSS[c.look ?? 'neutral'] || 'none',
    ...(live && { '--dv-pop': FX.pop, '--dv-pop-ms': `${FX.popMs}ms`, '--dv-fade': `${FX.hookFadeMs}ms`, '--dv-bar': FX.bar }),
  } as CSSProperties
  const focus = c.parts.find((x) => player.src >= x.start && player.src < x.end)?.focus ?? c.parts[0].focus
  const to = cached?.duration || Math.max(...parts.map((x) => x.end))
  const others = parts.length > c.parts.length // weitere Clips aus derselben Quelle
  const n1 = c.parts.length
  // Einblendungen nur, wo ihre Quellzeit im Clip zu sehen ist: Stücke in Clipzeit wie im Export (mit Tempo und Standbild)
  const spans = useMemo(() => (c.overlays ?? []).map((o) => clipSpans(c.parts, o.start, o.end)), [c])

  // Hook von Hand: Enter/Blur speichert, Escape verwirft (skip, weil das Verlassen des Felds auch blur auslöst)
  const [edit, setEdit] = useState<string | null>(null)
  const skip = useRef(false)
  const saveHook = (v: string) => {
    const t = v.trim()
    if (!skip.current && !busy && t !== (c.hook ?? '')) onContent({ hook: t || undefined })
    skip.current = false
    setEdit(null)
  }
  const startEdit = () => { if (!busy) setEdit(c.hook ?? '') }

  // Beschriftete Einstellung als Segmentschalter
  const opt = <V extends string>(label: string, cur: V, set: (v: V) => void, opts: [v: V, text: string, title?: string][]) => (
    <div className="dv-opt">
      <span>{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {opts.map(([v, text, title]) => <button key={v} aria-pressed={cur === v} disabled={busy} title={title} onClick={() => { if (cur !== v) set(v) }}>{text}</button>)}
      </div>
    </div>
  )

  return (
    <>
      <section className="dv-main" aria-label="Vorschau">
        <div className="dv-row">
          <div className="dv-view">
            <div className="dv-stage">
              <div className={`dv-screen${live ? ' live' : ''}${c.captionPos && c.captionPos !== 'unten' ? ` cap-${c.captionPos}` : ''}`} style={screen}>
                <ClipVideo video={c.video} aspect={size.w / size.h} focus={focus} fit={c.fit} still={c.parts[0].start} videoRef={videoRef}
                  onClick={player.toggle} onBad={() => setBad(true)}>
                  {c.hook && player.t < 4 && <p className="dv-hook" style={live ? { '--dv-hook-o': Math.min(1, ((Math.min(4, player.duration) - player.t) * 1000) / FX.hookFadeMs) } as CSSProperties : undefined}><span>{c.hook}</span></p>}
                  {cap && <p className="dv-sub">{cap.words.map((w, k) => <Fragment key={k}>{k > 0 && ' '}{k === cap.active && mode === 'wort' ? <em key={`${k}:${w}`}>{w}</em> : w}</Fragment>)}</p>}
                  {c.overlays?.map((o, k) => {
                    const sp = spans[k]?.find(([a, b]) => player.t >= a && player.t < b)
                    const all = spans[k] ?? [], a = all[0]?.[0] ?? 0 // fortlaufend ab dem ersten Stück: Einblend-Video läuft in Clip-Echtzeit wie im Export
                    return <Ov key={k} o={o} on={!!sp} at={sp ? player.t - a : 0} len={all.length ? all[all.length - 1][1] - a : 1} playing={player.playing} deck={deck} />
                  })}
                  {live && <i className="dv-bar" style={{ width: `${Math.min(100, (player.t / Math.max(0.001, player.duration)) * 100)}%` }} aria-hidden />}
                  <canvas ref={fadeRef} className="dv-fade" aria-hidden />
                  {!player.playing && !bad && <span className="dv-play" aria-hidden><Play size={26} fill="currentColor" /></span>}
                  {bad && <p className="dv-bad">Die Vorschau kann dieses Video nicht abspielen (etwa HEVC oder ProRes). Exportieren geht trotzdem.</p>}
                </ClipVideo>
              </div>
            </div>
            <div className="dv-transport">
              <button className="plain" aria-label="10 s zurück (J)" title="10 s zurück (J)" onClick={() => jump(-10)}><RotateCcw size={16} /></button>
              <button className="round" aria-label={player.playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)'} onClick={player.toggle}>
                {player.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
              </button>
              <button className="plain" aria-label="10 s vor (L)" title="10 s vor (L)" onClick={() => jump(10)}><RotateCw size={16} /></button>
              <input type="range" className="dv-seek" aria-label="Position im Clip" min={0} max={player.duration} step={0.1} value={Math.min(player.t, player.duration)} onChange={(e) => player.seekClip(+e.currentTarget.value)}
                onPointerUp={(e) => e.currentTarget.blur()} /* danach greifen Leertaste, J, K, L wieder */ />
              <span>{mmss(player.t)} / {mmss(player.duration)}</span>
              {music && <audio key={music} ref={musicRef} src={music} crossOrigin="anonymous" loop preload="auto" />}
              {mode !== 'aus' && cached && !cached.transcript && <span className="dv-note">Untertitel erscheinen, sobald die KI das Video abgehört hat.</span>}
            </div>
          </div>

          <div className="dv-side">
            <div className="dv-head">
              <div><small>Clip {n} von {total}</small>{!wide && edit === null && <button className="plain" aria-label="Hook bearbeiten" disabled={busy} onClick={startEdit}>Bearbeiten</button>}</div>
              {edit !== null
                ? <input type="text" value={edit} maxLength={70} aria-label="Hook" autoFocus onChange={(e) => setEdit(e.target.value)} onBlur={(e) => saveHook(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { skip.current = e.key === 'Escape'; e.currentTarget.blur() } }} />
                : <h2 className={!wide && !busy ? 'edit' : undefined} onClick={wide ? undefined : startEdit}>{c.hook || `Clip ${n}`}</h2>}
              <p>{mmss(partsLength(c.parts))} · {n1 === 1 ? '1 Ausschnitt' : `${n1} Ausschnitte`} aus {mmss(Math.min(...c.parts.map((x) => x.start)))}–{mmss(Math.max(...c.parts.map((x) => x.end)))}</p>
            </div>

            <div className="dv-opts">
              {opt('Untertitel', mode, (v) => onContent({ captions: v === 'wort' ? undefined : v }), [['wort', 'Wort'], ['satz', 'Satz'], ['aus', 'Aus']])}
              {opt('Stil', c.style ?? 'ruhig', (v) => onContent({ style: v === 'ruhig' ? undefined : v }),
                CLIP_STYLES.map((st) => [st, st === 'ruhig' ? 'Ruhig' : 'Lebendig', st === 'ruhig' ? 'Ohne Animation' : 'Wort-Pop, Hook-Einblendung, Fortschrittsbalken, Zoom an Schnitten']))}
              {opt('Pausen', c.pauses ?? 'lassen', (v) => onContent({ pauses: v === 'lassen' ? undefined : v }), [['lassen', 'Lassen'], ['kurz', 'Kürzen', 'Lange Pausen und Füllwörter fallen im Export weg']])}
              {opt('Bild', c.fit ?? 'crop', (v) => onContent({ fit: v === 'crop' ? undefined : v }),
                [['crop', 'Füllen', 'Bild füllt das Format, Zuschnitt aufs Gesicht'], ['blur', 'Ganz', 'Ganzes Bild auf unscharfem Grund'], ['split', 'Facecam', 'Stream: Kamera oben, Spiel unten (im Export)']])}
              {opt('Ton', c.ton ?? 'original', (v) => onContent({ ton: v === 'original' ? undefined : v }),
                [['original', 'Original', 'Ton unverändert'], ['klar', 'Klar', 'Sprache aufbereiten: Rauschen weg, gleichmäßig laut (im Export). Nicht bei Musik']])}
              {opt('Look', c.look ?? 'neutral', (v) => onContent({ look: v === 'neutral' ? undefined : v }),
                [['neutral', 'Neutral', 'Farben unverändert'], ['warm', 'Warm'], ['kuehl', 'Kühl'], ['kontrast', 'Kontrast', 'Kräftiger'], ['matt', 'Matt', 'Weich, gedämpft'], ['sw', 'S/W', 'Schwarzweiß'],
                  ['auto', 'Auto', 'Helligkeit und Kontrast ausgleichen (wirkt nur im Export)']])}
              {opt('Untertitel-Lage', c.captionPos ?? 'unten', (v) => onContent({ captionPos: v === 'unten' ? undefined : v }),
                [['unten', 'Unten'], ['mitte', 'Mitte'], ['oben', 'Oben', 'Wenn unten Wichtiges im Bild steht']])}
              {opt('Stabilisieren', c.stabil ? 'an' : 'aus', (v) => onContent({ stabil: v === 'an' || undefined }),
                [['aus', 'Aus'], ['an', 'An', 'Verwackeln glätten (nur im Export, kostet Zeit)']])}
              {(c.stabil || c.look === 'auto') && <p className="dv-note">{c.stabil && c.look === 'auto' ? 'Stabilisieren und Look „Auto“ wirken' : c.stabil ? 'Stabilisieren wirkt' : 'Look „Auto“ wirkt'} nur im Export.</p>}
            </div>

            <div className="dv-btns">
              <button className="pill" disabled={busy} title="Anfang und Ende von Hand nachschneiden" onClick={() => { player.pause(); onCut() }}>Feinschnitt</button>
              <button className="plain dv-quiet" disabled={busy} onClick={onRemove}>Entfernen</button>
            </div>

            {(issues.length > 0 || fresh) && (
              <div className="dv-sec">
                <h3>Prüfung</h3>
                {issues.length > 0
                  ? <Hints xs={issues} busy={busy || !fresh} onFix={() => onSend('Behebe die Prüfhinweise dieses Clips.',
                      `Clip ${n} (Folie ${clip.id}), Quelle ${c.video}, ${c.parts.map((x, i) => `Ausschnitt ${i + 1}: ${String(+x.start.toFixed(1)).replace('.', ',')}–${String(+x.end.toFixed(1)).replace('.', ',')} s`).join('; ')}\n\nPrüfhinweise:\n${issues.filter((x) => x.severity !== 'info').map((x) => `- ${x.message}`).join('\n')}`)} />
                  : <p className="dv-ok"><Check size={15} aria-hidden />Keine Hinweise.</p>}
              </div>
            )}
            {c.post?.trim() && (
              <div className="dv-sec">
                <h3>Post-Text</h3>
                <Post key={c.post} text={c.post} />
              </div>
            )}
          </div>
        </div>

        <div className="dv-acts" role="group" aria-label={`Clip ${n}: Auftrag an die KI`}>
          <span>Auftrag an die KI</span>
          {(wide ? WIDE_TASKS : TASKS).map(([label, text]) => <button key={label} className="pill" disabled={busy} onClick={() => onSend(text, here)}>{label}</button>)}
          {!busy && undo}
        </div>
      </section>

      <section className="dv-line" aria-label="Ganzes Video">
        <div className="dv-line-head">
          <b>Ganzes Video</b>
          <span>{mmss(to)}</span>
          <span className="dv-legend">
            <span><i className="part on" aria-hidden />dieser Clip</span>
            {others && <span><i className="part" aria-hidden />andere Clips</span>}
            {!!cached?.highlights.length && <span><i className="mark" aria-hidden />Highlight</span>}
          </span>
        </div>
        <Strip from={0} to={to} parts={parts} on={(x) => c.parts.includes(x)} head={player.src} onSeek={player.seekSource} curve={curve}
          marks={cached?.highlights.map((h) => ({ start: h.start, end: h.end, label: h.why }))} />
        <div className="dv-scale" aria-hidden>{[0, 1, 2, 3, 4].map((k) => <span key={k}>{mmss((to * k) / 4)}</span>)}</div>
        {!!cached?.highlights.length && (
          <div className="dv-marks" role="group" aria-label="Highlights">
            {cached.highlights.map((h, k) => (
              <button key={k} className="pill" disabled={busy} title={h.why} aria-label={`Aus Highlight ${k + 1} (${mmss(h.start)} bis ${mmss(h.end)}) einen Short machen`}
                onClick={() => onSend(`Mach aus ${mmss(h.start)}–${mmss(h.end)} einen Short`, `Quelle ${c.video}, Highlight ${h.start}–${h.end} s (${h.why}). Neue clip-Folie wie die anderen Shorts.`)}>
                <b>{k + 1}</b> {mmss(h.start)}–{mmss(h.end)} <span>{h.why}</span>
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
