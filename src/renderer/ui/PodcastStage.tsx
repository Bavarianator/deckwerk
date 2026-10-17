// Deckvid im Podcast-Modus: Vorschau aller Spuren (überspringt die Schnitte), Wellenform, mitlaufendes Transkript, Detailspalte.
// Schneiden von Hand: Wörter markieren + Entf; Schnitt anklicken + Entf hebt ihn auf; Schnittkanten in der Wellenform ziehen. Alles Weitere über die KI.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { Check, Pause, Play } from 'lucide-react'
import type { Deck } from '../../shared/deck'
import { editedLength, isFiller, mergeTracks, episodeSummary, lintEpisode, normCuts, snapCut, toEdited, toSource, type Cut, type CutWhy, type Episode, type PodTon } from '../../shared/podcast'
import { estimateWords, mmss, type Transcript } from '../../shared/video'
import { Hints, keysFree, useKey } from './deckvid-parts'
import { Waveform, type Peaks, type WaveMark, type WaveSpan } from './Waveform'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const WHY: Record<CutWhy, string> = { pause: 'Pause', fuell: 'Füllwort', versprecher: 'Versprecher', hand: 'von Hand' }
const fileName = (src: string) => decodeURIComponent(src.split('/').pop() ?? src)

// Ein-Klick-Aufträge: Label, Satz im Chat, Ablauf nur für die KI
const POD_TASKS: [label: string, ask: string, hint: string][] = [
  ['Aufräumen', 'Räum die Folge auf: lange Pausen kürzen, Füllwörter und Versprecher raus.', 'edit_episode clean mit pauses 0.6, fillers und retakes; Schnitte von Hand bleiben.'],
  ['Kapitel setzen', 'Setz Kapitel an den Themenwechseln, mit kurzen Titeln.', 'Kapitel (chapters) in Quellzeit am Satzanfang, erstes bei 0:00, je Kapitel mindestens 30 s.'],
  ['Intro & Outro', 'Gib der Folge ein kurzes Intro und Outro.', 'find_music nach kurzen, dezenten Stücken (höchstens 10–15 s), als intro und outro setzen.'],
  ['Kürzer (Abschweifungen raus)', 'Mach die Folge kürzer: Abschweifungen und Wiederholungen raus, der Inhalt bleibt.', 'Schnitte mit why hand an Satzgrenzen (snapCut), Gestrichenes kurz nennen.'],
  ['Lautstärke angleichen', 'Gleich die Lautstärke der Spuren an, damit alle gleich laut klingen.', 'gain je Spur (−12…12 dB) setzen; der Export normalisiert danach auf −16 LUFS.'],
]

// Mehrere Spuren = je Person eine Spur: Sprecher = Spurnummer
// Index des Schnitts, in dem t liegt (cuts normalisiert: sortiert, ohne Überlappung); −1 = keiner
function cutAt(t: number, cuts: Cut[]) {
  let lo = 0, hi = cuts.length - 1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (t < cuts[m].start) hi = m - 1
    else if (t >= cuts[m].end) lo = m + 1
    else return m
  }
  return -1
}

interface PWord { w: string; start: number; end: number; speaker?: number }
interface Para { speaker?: number; label?: string; from: number; to: number } // Wortindizes [from, to)

interface Props {
  deck: Deck & { podcast: Episode }
  busy: boolean
  idle: boolean // weder KI noch Export: Vorschau und Transkript neu laden
  onSend: (text: string, context?: string) => boolean
  undo: ReactNode
  onPodcast: (fn: (ep: Episode) => Episode, tag?: string) => void
}

export function PodcastStage({ deck, busy, idle, onSend, undo, onPodcast }: Props) {
  const ep = deck.podcast
  const cuts = useMemo(() => normCuts(ep.cuts, ep.duration), [ep.cuts, ep.duration])
  const len = editedLength(cuts, ep.duration)
  const summary = useMemo(() => episodeSummary(ep), [ep]) // nicht je Abspiel-Bild neu rechnen
  const here = `Podcast-Folge (deck.podcast): ${summary}. Spuren: ${ep.tracks.map((x, k) => `${k + 1}. ${x.name ?? fileName(x.src)} (${x.src})`).join('; ')}`

  // Vorschau aller Spuren; neu, wenn sich Spuren ändern, und nach jedem KI-Zug
  const audio = useRef<HTMLAudioElement | null>(null)
  const [media, setMedia] = useState<HTMLAudioElement | null>(null)
  const audioRef = useCallback((el: HTMLAudioElement | null) => { audio.current = el; setMedia(el) }, [])
  const [url, setUrl] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [peaks, setPeaks] = useState<Peaks | null>(null)
  const mixKey = JSON.stringify(ep.tracks)
  useEffect(() => {
    if (!idle) return
    let off = false
    const h = setTimeout(() => window.api.podcastPreview(deck).then((u) => { if (!off) { setUrl(u); setErr('') } }, (e) => { if (!off) { setErr(errText(e)); setUrl(null); setPeaks(null) } }), 400)
    return () => { off = true; clearTimeout(h) }
  }, [mixKey, idle])
  useEffect(() => {
    if (!url) return
    let off = false
    window.api.podcastPeaks(url).then((p) => { if (!off && p) setPeaks(p) }, () => {})
    return () => { off = true }
  }, [url])

  // Transkript je Spur aus dem Cache (rechnet nie)
  const [ts, setTs] = useState<(Transcript | null)[] | null>(null)
  const srcKey = ep.tracks.map((x) => x.src).join('\n')
  useEffect(() => {
    if (!idle) return
    let off = false
    Promise.all(ep.tracks.map((x) => window.api.videoCached(x.src).then((d) => d?.transcript ?? null, () => null))).then((r) => { if (!off) setTs(r) })
    return () => { off = true }
  }, [srcKey, idle])
  const transcript = useMemo(() => (ts ? mergeTracks(ts) : null), [ts])
  const { words, paras } = useMemo(() => {
    const words: PWord[] = [], paras: Para[] = []
    let last: number | undefined, prevEnd = -Infinity
    for (const s of transcript?.segments ?? []) {
      const ws = s.words?.length ? s.words : estimateWords(s)
      if (!ws.length) continue
      const change = s.speaker !== undefined && s.speaker !== last
      if (!paras.length || change || s.start - prevEnd > 2) paras.push({ speaker: s.speaker, label: change ? `S${s.speaker! + 1}` : undefined, from: words.length, to: words.length })
      for (const w of ws) words.push({ ...w, speaker: s.speaker })
      paras[paras.length - 1].to = words.length
      last = s.speaker ?? last
      prevEnd = s.end
    }
    return { words, paras }
  }, [transcript])

  // Abspielen: per rAF; liegt die Zeit in einem Schnitt, ans Schnittende springen
  const [t, setT] = useState(0)
  const tRef = useRef(0)
  tRef.current = t
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const a = audio.current
      if (!a) return
      if (a.paused) { setPlaying(false); setT(a.currentTime); return }
      const k = cutAt(a.currentTime + 0.02, cuts)
      if (k >= 0) { if (cuts[k].end >= ep.duration - 0.05) a.pause(); else a.currentTime = cuts[k].end }
      setT(a.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, cuts, ep.duration])
  const seek = useCallback((s: number) => {
    const a = audio.current, x = Math.max(0, s)
    if (a) a.currentTime = x
    setT(x)
  }, [])
  const toggle = () => {
    const a = audio.current
    if (!a || !url) return
    if (!a.paused) { a.pause(); setPlaying(false); return }
    if (toEdited(a.currentTime, cuts, ep.duration) >= len - 0.05) a.currentTime = toSource(0, cuts, ep.duration) // am Ende: von vorn
    a.play().then(() => setPlaying(true), () => setPlaying(false))
  }

  // Schnitte von Hand
  const [selCut, setSelCut] = useState<number | null>(null)
  useEffect(() => { setSelCut(null) }, [cuts])
  const script = useRef<HTMLDivElement>(null)
  const setCuts = (next: Cut[]) => onPodcast((e) => ({ ...e, cuts: normCuts(next, e.duration) }))
  useKey((e) => {
    if (!keysFree(e)) return
    if (e.key === ' ' && !e.repeat && !(e.target as Element).closest('button')) { e.preventDefault(); toggle() }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      seek(toSource(toEdited(tRef.current, cuts, ep.duration) + (e.key === 'ArrowLeft' ? -5 : 5), cuts, ep.duration))
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !busy) {
      const sel = getSelection()
      const box = script.current
      if (sel && !sel.isCollapsed && box && box.contains(sel.anchorNode)) {
        const hit = [...box.querySelectorAll<HTMLElement>('[data-i]')].filter((el) => sel.containsNode(el, true)).map((el) => Number(el.dataset.i))
        if (!hit.length) return
        e.preventDefault()
        const c = snapCut({ start: words[Math.min(...hit)].start, end: words[Math.max(...hit)].end, why: 'hand' }, words)
        setCuts([...cuts, c])
        sel.removeAllRanges()
      } else if (selCut !== null && cuts[selCut]) {
        e.preventDefault()
        setCuts(cuts.filter((_, i) => i !== selCut))
      }
    }
  })
  const onWord = useCallback((i: number) => {
    if (!getSelection()?.isCollapsed) return // Markieren zum Schneiden, kein Sprung
    const w = words[i]
    const k = cutAt((w.start + w.end) / 2, cuts)
    setSelCut(k >= 0 ? k : null)
    seek(w.start)
  }, [words, cuts, seek])

  // aktuelles Wort direkt im DOM markieren: das Transkript rendert beim Abspielen nicht neu
  const active = useMemo(() => {
    let lo = 0, hi = words.length - 1, r = -1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (words[m].start <= t) { r = m; lo = m + 1 } else hi = m - 1 }
    return r >= 0 && t < words[r].end + 0.6 ? r : -1
  }, [words, t])
  useEffect(() => {
    const box = script.current
    if (!box) return
    box.querySelector('.now')?.classList.remove('now')
    const el = active >= 0 ? box.querySelector(`[data-i="${active}"]`) : null
    if (!el) return
    el.classList.add('now')
    if (playing) {
      const r = el.getBoundingClientRect(), b = box.getBoundingClientRect()
      if (r.top < b.top || r.bottom > b.bottom) box.scrollTop += r.top - b.top - b.height / 3
    }
  }, [active, playing, words])

  const spans = useMemo<WaveSpan[]>(() => cuts.map((c, i) => ({ start: c.start, end: c.end, kind: 'cut', title: `Schnitt: ${WHY[c.why ?? 'hand']}`, sel: i === selCut })), [cuts, selCut])
  const marks = useMemo<WaveMark[]>(() => [
    ...(ep.chapters ?? []).map((c): WaveMark => ({ at: c.at, kind: 'chapter', title: c.title })),
    ...(ep.sfx ?? []).map((s): WaveMark => ({ at: s.at, kind: 'sfx', title: `Soundeffekt: ${fileName(s.src)}` })),
  ], [ep.chapters, ep.sfx])
  const onSpan = useCallback((i: number, start: number, end: number) => {
    if (cuts[i]) setCuts(cuts.map((c, j) => (j === i ? snapCut({ ...c, start, end, why: 'hand' }, words) : c)))
  }, [cuts, words, onPodcast])

  const issues = useMemo(() => (ts ? lintEpisode(ep, transcript).map((x) => ({ severity: x.level, message: x.msg })) : []), [ep, transcript, ts])

  // Aufräumen über die KI: clean rechnet nur die angegebenen Gründe neu, andere Schnitte bleiben
  const has = (w: CutWhy) => cuts.some((c) => c.why === w)
  const [pz, setPz] = useState<'0.6' | '0.3'>('0.6') // zuletzt gewählte Kürzung; aus den Schnitten nicht ablesbar
  const pauses = has('pause') ? pz : 'lassen'
  const fillers = has('fuell') ? 'raus' : 'lassen', retakes = has('versprecher') ? 'raus' : 'lassen'
  const clean = (text: string, o: string) => onSend(text, `${here}\n\nedit_episode clean { ${o} }`)
  const opt = <V extends string>(label: string, cur: V, set: (v: V) => void, opts: [v: V, text: string, title?: string][]) => (
    <div className="dv-opt">
      <span>{label}</span>
      <div className="seg" role="group" aria-label={label}>
        {opts.map(([v, text, title]) => <button key={v} aria-pressed={cur === v} disabled={busy} title={title} onClick={() => { if (cur !== v) set(v) }}>{text}</button>)}
      </div>
    </div>
  )
  const chapters = useMemo(() => [...(ep.chapters ?? [])].sort((a, b) => a.at - b.at).map((c) => ({ ...c, shown: mmss(toEdited(c.at, cuts, ep.duration)) })), [ep.chapters, cuts, ep.duration])

  return (
    <section className="dv-main dv-pod" aria-label="Folge">
      <audio ref={audioRef} src={url ?? undefined} preload="auto"
        onLoadedMetadata={(e) => { e.currentTarget.currentTime = tRef.current }} // neue Vorschau: an derselben Stelle weiter
        onTimeUpdate={(e) => { if (!playing) setT(e.currentTarget.currentTime) }} />
      <div className="dv-row">
        <div className="dv-view dv-pod-view">
          <div className="dv-head">
            <h2>{deck.title}</h2>
            <p>{summary}</p>
          </div>
          <div className="dv-transport">
            <button className="round" disabled={!url} aria-label={playing ? 'Pause (Leertaste)' : 'Abspielen (Leertaste)'} onClick={toggle}>
              {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
            </button>
            <span>{mmss(toEdited(t, cuts, ep.duration))} / {mmss(len)}</span>
            {!url && !err && <span className="dv-note">Vorschau wird gemischt …</span>}
            {err && <span className="dv-note error" role="alert">{err}</span>}
          </div>
          {peaks
            ? <Waveform peaks={peaks} media={media} spans={spans} marks={marks} onSeek={seek} onSpan={busy ? undefined : onSpan} onSpanClick={setSelCut} timeline label="Wellenform der Folge" />
            : <div className="dv-wave dv-wave-empty" aria-hidden />}
          {words.length
            ? <Script lang={transcript?.lang ?? 'auto'} ref_={script} words={words} paras={paras} cuts={cuts} selCut={selCut} onWord={onWord} />
            : <p className="dv-note">{ts ? 'Das Transkript erscheint, sobald die KI die Folge abgehört hat.' : ''}</p>}
          {words.length > 0 && <p className="dv-note">Wörter markieren und Entf drücken schneidet sie heraus. Einen Schnitt anklicken und Entf drücken holt ihn zurück.</p>}
        </div>

        <div className="dv-side">
          <div className="dv-opts">
            {opt('Pausen', pauses, (v) => { if (v !== 'lassen') setPz(v); clean(v === 'lassen' ? 'Pausen nicht mehr kürzen.' : `Lange Pausen auf ${v.replace('.', ',')} s kürzen.`, `pauses: ${v === 'lassen' ? 'false' : v}`) },
              [['lassen', 'Lassen'], ['0.6', 'Kurz', 'Pausen auf 0,6 s kürzen'], ['0.3', 'Knapp', 'Pausen auf 0,3 s kürzen']])}
            {opt('Füllwörter', fillers, (v) => clean(v === 'raus' ? 'Füllwörter raus.' : 'Füllwörter drinlassen.', `fillers: ${v === 'raus'}`), [['lassen', 'Lassen'], ['raus', 'Raus', 'Äh, ähm und Co. schneiden']])}
            {opt('Versprecher', retakes, (v) => clean(v === 'raus' ? 'Versprecher raus.' : 'Versprecher drinlassen.', `retakes: ${v === 'raus'}`), [['lassen', 'Lassen'], ['raus', 'Raus', 'Abgebrochene und wiederholte Sätze schneiden']])}
            {opt<PodTon>('Ton', ep.ton ?? 'klar', (v) => onPodcast((e) => ({ ...e, ton: v === 'klar' ? undefined : v })), [
              ['original', 'Original', 'Ton unverändert'], ['klar', 'Klar', 'Sprache aufbereiten: Rauschen weg, gleichmäßig laut'], ['stark', 'Stark', 'Wie Klar, dazu kräftiger entrauschen']])}
          </div>

          {chapters.length > 0 && (
            <div className="dv-sec">
              <h3>Kapitel</h3>
              <ul className="dv-pod-list">
                {chapters.map((c) => (
                  <li key={`${c.at}|${c.title}`}>
                    <button className="plain" title="Hierhin springen" onClick={() => seek(c.at)}>{c.shown}</button>
                    <input type="text" defaultValue={c.title} maxLength={80} aria-label={`Kapitel bei ${c.shown}`} disabled={busy}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = c.title; e.currentTarget.blur() } }}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== c.title) onPodcast((x) => ({ ...x, chapters: (x.chapters ?? []).map((y) => (y.at === c.at ? { ...y, title: v } : y)) })); else e.target.value = c.title }} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="dv-sec">
            <h3>Spuren</h3>
            <ul className="dv-pod-list dv-pod-tracks">
              {ep.tracks.map((x, k) => {
                const g = x.gain ?? 0
                const set = (p: Partial<Episode['tracks'][number]>, tag?: string) => onPodcast((e) => ({ ...e, tracks: e.tracks.map((y, j) => (j === k ? { ...y, ...p } : y)) }), tag)
                return (
                  <li key={`${k}|${x.name ?? ''}`}>
                    <input type="text" defaultValue={x.name ?? ''} placeholder={fileName(x.src)} maxLength={40} aria-label={`Name der Spur ${k + 1}`} disabled={busy}
                      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v !== (x.name ?? '')) set({ name: v || undefined }) }} />
                    <input type="range" min={-12} max={12} step={1} value={g} disabled={busy} aria-label={`Lautstärke Spur ${k + 1}`} aria-valuetext={`${g} dB`}
                      style={{ '--pct': `${((g + 12) / 24) * 100}%` } as CSSProperties}
                      onChange={(e) => set({ gain: Number(e.target.value) || undefined }, `gain-${k}`)} />
                    <span className="dv-pod-db">{g > 0 ? '+' : ''}{g} dB</span>
                    <button className={`plain${x.mute ? ' on' : ''}`} aria-pressed={!!x.mute} disabled={busy} onClick={() => set({ mute: x.mute ? undefined : true })}>Stumm</button>
                  </li>
                )
              })}
            </ul>
          </div>

          {ts && (
            <div className="dv-sec">
              <h3>Prüfung</h3>
              {issues.length > 0
                ? <Hints xs={issues} busy={busy} onFix={() => onSend('Behebe die Prüfhinweise dieser Folge.',
                    `${here}\n\nPrüfhinweise:\n${issues.filter((x) => x.severity !== 'info').map((x) => `- ${x.message}`).join('\n')}`)} />
                : <p className="dv-ok"><Check size={15} aria-hidden />Keine Hinweise.</p>}
            </div>
          )}
        </div>
      </div>

      <div className="dv-acts" role="group" aria-label="Auftrag an die KI">
        <span>Auftrag an die KI</span>
        {POD_TASKS.map(([label, text, hint]) => <button key={label} className="pill" disabled={busy} onClick={() => onSend(text, `${here}\n\n${hint}`)}>{label}</button>)}
        {!busy && undo}
      </div>
    </section>
  )
}

// Transkript: rendert nur bei neuen Wörtern oder Schnitten, nicht bei jedem Bild der Wiedergabe
const Script = memo(function Script({ ref_, words, paras, cuts, selCut, lang, onWord }: {
  ref_: RefObject<HTMLDivElement | null>; words: PWord[]; paras: Para[]; cuts: Cut[]; selCut: number | null; lang: string; onWord: (i: number) => void
}) {
  return (
    <div className="dv-script" ref={ref_} aria-label="Transkript"
      onClick={(e) => { const i = (e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i; if (i !== undefined) onWord(Number(i)) }}>
      {paras.map((p, k) => (
        <p key={k}>
          {p.label && <b className="dv-spk">{p.label}</b>}
          {words.slice(p.from, p.to).map((w, j) => {
            const i = p.from + j, c = cutAt((w.start + w.end) / 2, cuts)
            const cls = [c >= 0 && 'cut', c >= 0 && c === selCut && 'sel', c < 0 && isFiller(w.w, lang) && 'fill'].filter(Boolean).join(' ')
            return <span key={i} data-i={i} className={cls || undefined}>{w.w.trim()} </span>
          })}
        </p>
      ))}
    </div>
  )
})
