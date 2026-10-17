// Animations-Ansicht für Film-Decks (deck.film, Feature „Animation“): Player wie der Remotion Player mit derselben Seek-Logik wie der
// Export (renderer/film.ts), Stimme über film:voice, Szenenleiste mit Dauern, Chat daneben. Aufbau und Chat wie Deckvid.
import { memo, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ArrowUp, ChevronLeft, Paperclip, Pause, Play, Settings, Share, Square, Undo2, Video } from 'lucide-react'
import { sizeOf, type Deck } from '../../shared/deck'
import { FPS, VOICE_SPEED, estimateVoice, sceneTimeline, type SceneTimeline, type VoiceTiming } from '../../shared/film'
import { mmss } from '../../shared/video'
import { filmPrepare, type FilmScene } from '../film'
import { SlideView } from '../slide'
import { ChatLog, ModelSelect, type Msg } from './Chat'
import { WorkSteps } from './DeckvidWork'
import { assetOf } from './itemOps'
import { Recorder } from './Recorder'
import { FILM_ASK, FILM_EXAMPLES, SourceChips, sourceContext, useSource } from './Start'
import { OpenSettings } from './settings/parts'
import type { Status } from './TopBar'
import './deckvid.css' // Chat, Fortschritt, Leerzustand und Abspielknopf wie in Deckvid
import './film-view.css'

type Metrics = Pick<FilmScene, 'steps' | 'endless' | 'words'>
type Voice = { url: string; timing: VoiceTiming }
// i = Folie, sure = Dauer steht fest (Animationen gemessen, Stimme echt oder keine)
interface Plan { i: number; tl: SceneTimeline; url?: string; sure: boolean }

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
// Ändert sich etwas davon, wird die Szene neu aufgebaut und gemessen
const sigOf = (deck: Deck, i: number) => JSON.stringify([i, deck.slides[i], deck.motion, deck.theme, deck.size])
const secs = (s: number) => `${s.toFixed(1).replace('.', ',')} s`

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
  onExport: (format: 'mp4') => void // die Engine nimmt für Decks mit film den Film-Export
  exporting: boolean
  onSlides: () => void // Ausweg in den normalen Folien-Editor
  canUndo: boolean
  onUndo: () => void
}

export function Film(p: Props) {
  const { deck, index, busy, onSend } = p
  const openSettings = useContext(OpenSettings)
  const size = sizeOf(deck)
  const slides = deck?.slides ?? []
  const scenes = slides.flatMap((s, i) => (s.hidden ? [] : [i])) // ausgeblendete Folien gehören nicht zum Film
  const { srcs, attach, remove, clear, err } = useSource()
  const [draft, setDraft] = useState('')
  const [ask, setAsk] = useState<string>() // ask des gewählten Beispiels, wie im Start
  const [recording, setRecording] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const line = useRef<HTMLElement>(null)
  useEffect(() => { const j = slides.findIndex((s) => !s.hidden); if (slides[index]?.hidden && j >= 0) p.onSelect(j) }, [index, slides]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { line.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [index])

  // Takte und Wörter misst die Szenenleiste beim Einhängen; die Stimme kommt im Hintergrund, eine Szene nach der anderen
  const [metrics, setMetrics] = useState<Record<string, Metrics>>({})
  const measure = useCallback((sig: string, m: Metrics) => setMetrics((x) => ({ ...x, [sig]: m })), [])
  const [voices, setVoices] = useState<Record<string, Voice | string>>({}) // string = Fehlermeldung
  const speed = Math.min(VOICE_SPEED.max, Math.max(VOICE_SPEED.min, deck?.film?.speed ?? 1))
  const vkey = (text: string) => JSON.stringify([text, deck?.film?.voice ?? 'de', speed])
  const texts = scenes.map((i) => slides[i].voice?.trim()).filter((t): t is string => !!t)
  const asked = useRef(new Set<string>()) // ponytail: ein Fehler (z. B. offline beim Modell-Download) wird erst bei geändertem Text neu versucht
  useEffect(() => {
    if (p.exporting) return // der Export erzeugt dieselben Stimmen (gemeinsamer Cache)
    void (async () => {
      for (const text of texts) {
        const k = vkey(text)
        if (asked.current.has(k)) continue
        asked.current.add(k)
        const v = await window.api.filmVoice(text, deck?.film).catch(errText)
        setVoices((m) => ({ ...m, [k]: v }))
      }
    })()
  }, [texts.map(vkey).join('\n'), p.exporting]) // eslint-disable-line react-hooks/exhaustive-deps

  const plan: Plan[] = scenes.map((i) => {
    const s = slides[i], m = deck ? metrics[sigOf(deck, i)] : undefined, text = s.voice?.trim()
    const v = text ? voices[vkey(text)] : undefined, real = typeof v === 'object' ? v : undefined
    const voice = text ? real?.timing ?? estimateVoice(text, speed) : undefined
    return { i, tl: sceneTimeline({ steps: m?.steps ?? [], words: m?.words ?? 0, endless: m?.endless, voice, duration: s.duration, lead: 0 }), url: real?.url, sure: !!m && (!text || !!real) }
  })
  const voiceErr = texts.map((t) => voices[vkey(t)]).find((v): v is string => typeof v === 'string')
  const k = plan.findIndex((x) => x.i === index)

  const names = srcs.length ? ` · ${srcs.map((s) => s.name).join(', ')}` : ''
  // Ohne Film-Deck (gerade erst aus dem Start) erfährt die KI bei jedem Auftrag, dass eine Animation entstehen soll
  const submit = () => {
    const text = draft.trim() || (srcs.length ? 'Nutze diese Dateien.' : '')
    const context = [deck?.film ? ask : ask ?? FILM_ASK, srcs.length > 0 && sourceContext(srcs)].filter(Boolean).join('\n\n') || undefined
    if (text && onSend(text + names, context)) { setDraft(''); setAsk(undefined); clear() }
  }
  const recorded = (file: string) => {
    setRecording(false)
    const text = `Bildschirmaufnahme: ${assetOf(file)}. Bitte daraus Demo-Szenen bauen (Layout screen, Zoom-Vorschläge mit screen_zooms).`
    if (!onSend(text, deck?.film ? undefined : FILM_ASK)) setDraft(text) // KI beschäftigt oder kein Zugang: der Auftrag wartet im Feld
  }

  const state = p.status?.text ?? (!deck ? '' : !p.saved ? 'Bearbeitet' : p.path ? 'Gespeichert' : 'Nicht gespeichert')
  const pct = p.status?.text.match(/(\d+) %$/)?.[1] // Video-Export meldet „… 37 %“
  const thumbW = Math.round(Math.min(140, (63 * size.w) / size.h))

  return (
    <>
      <header className="top">
        <div className="top-l"><button className="plain tint" onClick={p.onHome}><ChevronLeft size={16} />Decks</button></div>
        <div className="top-title" title={p.path ?? undefined}>
          <b>{deck?.title ?? 'Neue Animation'}</b>
          {state && <span className={p.status?.error ? 'error' : undefined} role="status">— {state}</span>}
        </div>
        <div className="top-r">
          {p.canUndo && <button className="plain tint" title="Den letzten Auftrag an die KI zurücknehmen" onClick={p.onUndo}><Undo2 size={14} />Rückgängig</button>}
          <button className="plain" disabled={busy} title="Bildschirm oder Fenster aufnehmen; die KI baut daraus Demo-Szenen" onClick={() => setRecording(true)}><Video size={16} />Bildschirm aufnehmen</button>
          <button className="plain" disabled={!deck} title="Alle Folien mit allen Werkzeugen bearbeiten" onClick={p.onSlides}>Folien-Ansicht</button>
          <button className="plain" title="Einstellungen" aria-label="Einstellungen" onClick={() => openSettings()}><Settings size={17} /></button>
          <button className="pill tint" disabled={!plan.length || busy || p.exporting} title="Film als MP4 exportieren" onClick={() => p.onExport('mp4')}><Share size={14} />Exportieren</button>
        </div>
        {pct && <i className="dv-progress" style={{ width: `${pct}%` }} aria-hidden />}
      </header>

      <div className="fv">
        {deck && k >= 0 ? <Player deck={deck} plan={plan} k={k} onSelect={p.onSelect} /> : (
          <section className="fv-main" aria-label="Vorschau">
            <div className="dv-empty">
              {busy ? <WorkSteps msgs={p.msgs} busy={busy} /> : <>
                <p>Sag der KI, was dein Video erklären oder zeigen soll, oder nimm deinen Bildschirm auf. Sie baut daraus Szene für Szene, mit Sprecherstimme.</p>
                <div>
                  {FILM_EXAMPLES.map(([label, full, a]) => <button key={label} className="pill" onClick={() => { setDraft(full); setAsk(a); input.current?.focus() }}>{label}</button>)}
                </div>
              </>}
            </div>
          </section>
        )}

        {/* ponytail: jede Szene misst sofort mit eigener SlideView + filmPrepare; ab ~40 Szenen erst bei Sichtbarkeit messen (IntersectionObserver) */}
        {deck && plan.length > 0 && (
          <nav className="fv-line" aria-label="Szenen" ref={line}>
            {plan.map((x, n) => (
              <button key={slides[x.i].id} className="fv-scene" aria-current={x.i === index} onClick={() => p.onSelect(x.i)}>
                <Thumb key={sigOf(deck, x.i)} deck={deck} i={x.i} sig={sigOf(deck, x.i)} width={thumbW} onMeasure={measure} />
                <span><b>Szene {n + 1}</b><small title={x.sure ? undefined : 'Geschätzt, bis die Stimme erzeugt ist'}>{x.sure ? '' : '≈ '}{secs(x.tl.dur)}</small></span>
              </button>
            ))}
            {voiceErr && <p className="fv-note" role="alert">{voiceErr} Die Zeiten sind geschätzt.</p>}
          </nav>
        )}

        <aside className="dv-chat" aria-label="KI">
          <ChatLog className="dv-log" msgs={p.msgs} busy={busy} onSend={onSend} />
          {!p.msgs.length && plan.length > 0 && (
            <p className="dv-hint">Die KI kennt deine Szenen. Sag zum Beispiel: „Mach Szene 2 ruhiger“ oder „Kürz den Sprechertext der ersten Szene“.</p>
          )}
          <form className="dv-ask" onSubmit={(e) => { e.preventDefault(); submit() }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { const f = [...e.dataTransfer.files]; if (f.length) { e.preventDefault(); attach(f.map(window.api.pathOf)) } }}>
            {(srcs.length > 0 || err) && <div className="dv-files"><SourceChips srcs={srcs} remove={remove} err={err} /></div>}
            <input ref={input} value={draft} onChange={(e) => { setDraft(e.target.value); setAsk(undefined) }} placeholder={busy ? 'Die KI arbeitet …' : 'Sag der KI, was sie ändern soll …'} aria-label="Wunsch an die KI" />
            <div className="dv-ask-bar">
              <button type="button" className="plain" aria-label="Datei anhängen" title="Datei anhängen (oder hierher ziehen)" disabled={busy} onClick={() => attach()}><Paperclip size={16} /></button>
              <ModelSelect value={p.model} onChange={p.onModel} />
              {busy
                ? <button type="button" className="round stop" aria-label="Stoppen" onClick={p.onAbort}><Square size={12} fill="currentColor" /></button>
                : <button type="submit" className="round" aria-label="Senden (Enter)" disabled={!draft.trim() && !srcs.length}><ArrowUp size={17} strokeWidth={2.4} /></button>}
            </div>
          </form>
        </aside>
      </div>
      {recording && <Recorder onDone={recorded} onClose={() => setRecording(false)} />}
    </>
  )
}

// Vorschaubild der Szenenleiste (Endzustand). Misst beim Einhängen Takte und Wörter mit derselben Vorbereitung wie Player und Export.
const Thumb = memo(function Thumb({ deck, i, sig, width, onMeasure }: { deck: Deck; i: number; sig: string; width: number; onMeasure: (sig: string, m: Metrics) => void }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const root = ref.current?.querySelector<HTMLElement>('.slide')
    if (!root) return
    const sc = filmPrepare(root, deck, i)
    onMeasure(sig, { steps: sc.steps, endless: sc.endless, words: sc.words })
    sc.dispose()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- key = sig
  return <span className="fv-thumb" ref={ref}><SlideView deck={deck} index={i} width={width} film /></span>
}, (a, b) => a.sig === b.sig && a.width === b.width)

// Szene in Originalgröße, die Bühne skaliert sie. Rendert nur beim Einhängen (key = Signatur): film.ts zerlegt Text und legt
// Animationen an, ein erneutes Rendern von SlideView käme dem in die Quere.
const Stage = memo(function Stage({ deck, i, onReady }: { deck: Deck; i: number; onReady: (s: FilmScene | null) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current?.querySelector<HTMLElement>('.slide')
    if (!root) return
    const sc = filmPrepare(root, deck, i)
    onReady(sc)
    return () => { onReady(null); sc.dispose() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={ref}><SlideView deck={deck} index={i} film /></div>
}, () => true)

// Spielt den Film Szene für Szene: rAF-Uhr → scene.seek(t), die Stimme läuft als <audio> mit. k = laufende Szene im plan.
// Übergänge im Player hart; die Überblendungen macht nur der Export.
function Player({ deck, plan, k, onSelect }: { deck: Deck; plan: Plan[]; k: number; onSelect: (i: number) => void }) {
  const size = sizeOf(deck), cur = plan[k]
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0) // Szenenzeit in s
  const time = useRef(0), base = useRef({ t0: 0, from: 0 }) // Uhr: from + (jetzt − t0)
  const latest = useRef({ plan, k })
  latest.current = { plan, k }
  const scene = useRef<FilmScene | null>(null)
  const audio = useRef<HTMLAudioElement>(null)
  // Szenenwechsel von außen (Leiste, Pfeiltasten, KI) beginnt bei 0; wechselt der Player selbst, steht die Zeit schon (goto)
  const goto = useRef<number | null>(null)
  const [shown, setShown] = useState(k)
  if (shown !== k) {
    setShown(k)
    if (goto.current !== k) { time.current = 0; setT(0) }
    goto.current = null
  }

  // seek ist asynchron (Videos): immer nur einer, danach der zuletzt gewünschte Zeitpunkt
  const seeking = useRef(false), pending = useRef<number | null>(null)
  const seek = useCallback((x: number) => {
    pending.current = x
    if (seeking.current) return
    seeking.current = true
    void (async () => {
      while (pending.current !== null && scene.current) {
        const y = pending.current
        pending.current = null
        await scene.current.seek(y).catch((e) => console.warn('[film] seek', e))
      }
      seeking.current = false
    })()
  }, [])
  const ready = useCallback((sc: FilmScene | null) => {
    scene.current = sc
    if (!sc) return
    const { plan, k } = latest.current
    sc.setBeats(plan[k]?.tl.beats ?? [0])
    seek(time.current)
  }, [seek])
  // echte Stimme da: neue Takte
  const beats = cur?.tl.beats.join(' ')
  useEffect(() => { if (scene.current && cur) { scene.current.setBeats(cur.tl.beats); seek(time.current) } }, [beats]) // eslint-disable-line react-hooks/exhaustive-deps

  const jump = (n: number, x: number) => {
    time.current = x
    base.current = { t0: performance.now(), from: x }
    setT(x)
    if (n === latest.current.k) return seek(x)
    goto.current = n
    onSelect(latest.current.plan[n].i)
  }
  // Stimme mitziehen: erst ab 0,25 s Abweichung nachstellen, sonst knackt es
  const sync = (x: number) => {
    const a = audio.current
    if (!a || x >= (a.duration || Infinity)) return
    if (Math.abs(a.currentTime - x) > 0.25) a.currentTime = x
    if (a.paused) void a.play().catch(() => {})
  }
  useEffect(() => { if (!playing) audio.current?.pause() }, [playing])
  useEffect(() => {
    if (!playing) return
    let raf = 0
    base.current = { t0: performance.now(), from: time.current }
    const tick = () => {
      const { plan, k } = latest.current, dur = plan[k]?.tl.dur ?? 0
      const x = base.current.from + (performance.now() - base.current.t0) / 1000
      if (x >= dur) {
        if (k + 1 < plan.length) return jump(k + 1, 0) // nächste Szene; die Uhr startet neu, sobald sie da ist
        time.current = dur
        setT(dur)
        seek(dur)
        return setPlaying(false)
      }
      time.current = x
      setT(x)
      seek(x)
      sync(x)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, k]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    if (playing) return setPlaying(false)
    const { plan, k } = latest.current
    if (k === plan.length - 1 && time.current >= (plan[k]?.tl.dur ?? 0) - 1e-3) jump(0, 0) // am Ende: von vorn
    setPlaying(true)
  }
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  // Leertaste: nicht beim Tippen (außer im leeren Chatfeld, dort steht der Cursor nach dem Senden), nicht auf Knöpfen, nicht in Dialogen
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const typing = el.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !(el.matches('.dv-ask input') && !(el as HTMLInputElement).value))
      if (e.key !== ' ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing || el.closest('button, [role=menu], [role=listbox]')
        || document.querySelector('[aria-modal="true"], dialog[open], .kit-menu, [role=menu]')) return
      e.preventDefault()
      toggleRef.current()
    }
    addEventListener('keydown', h)
    return () => removeEventListener('keydown', h)
  }, [])

  const box = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const w = Math.min(area.w, (area.h * size.w) / size.h)

  const starts = plan.reduce<number[]>((a, x, n) => [...a, n ? a[n - 1] + plan[n - 1].tl.dur : 0], [])
  const total = plan.length ? starts[plan.length - 1] + plan[plan.length - 1].tl.dur : 0
  const at = (starts[k] ?? 0) + Math.min(t, cur?.tl.dur ?? 0)
  const scrub = (T: number) => {
    const n = Math.max(0, starts.findLastIndex((s) => s <= T))
    jump(n, Math.min(Math.max(0, T - starts[n]), plan[n].tl.dur))
  }

  return (
    <section className="fv-main" aria-label="Vorschau">
      <div className="fv-stage" ref={box}>
        {w > 0 && cur && (
          <div className="fv-screen" style={{ width: w, height: (w * size.h) / size.w }} onClick={toggle}>
            <div style={{ transform: `scale(${w / size.w})` }}><Stage key={sigOf(deck, cur.i)} deck={deck} i={cur.i} onReady={ready} /></div>
            {!playing && <span className="dv-play" aria-hidden><Play size={26} fill="currentColor" /></span>}
          </div>
        )}
      </div>
      <div className="fv-transport">
        <button className="round" aria-label={playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)'} onClick={toggle}>
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
        </button>
        <div className="fv-seek">
          {starts.slice(1).map((s, n) => <i key={n} style={{ left: `${(s / Math.max(0.001, total)) * 100}%` }} aria-hidden />)}
          <input type="range" aria-label="Position im Film" min={0} max={total} step={1 / FPS} value={Math.min(at, total)} onChange={(e) => scrub(+e.currentTarget.value)}
            onPointerUp={(e) => e.currentTarget.blur()} /* danach greift die Leertaste wieder */ />
        </div>
        <span>{mmss(at)} / {mmss(total)}</span>
        {cur?.url && <audio key={`${k}|${cur.url}`} ref={audio} src={cur.url} preload="auto" />}
      </div>
    </section>
  )
}
