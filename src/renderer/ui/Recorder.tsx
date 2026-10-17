// Bildschirmaufnahme (Animation, Demo-Szenen): Quelle wählen → 3-2-1 → Deckwerk minimiert sich → Rückkehr ins Fenster stoppt.
// Die Teile des MediaRecorders gehen sekündlich an Main (record.ts), das die Datei schreibt und am Ende remuxt.
import { useEffect, useRef, useState } from 'react'
import { AppWindow, Monitor } from 'lucide-react'
import type { RecordSource } from '../../preload'
import { Switch } from './kit'
import './recorder.css'

type Phase = 'wahl' | 'zaehlen' | 'laeuft' | 'speichern'

const sleep = (ms: number) => new Promise((go) => setTimeout(go, ms))
const mime = (audio: boolean) =>
  ['vp9', 'vp8'].map((v) => `video/webm;codecs=${v}${audio ? ',opus' : ''}`).find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm'
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function Recorder({ onDone, onClose }: { onDone: (file: string) => void; onClose: () => void }) {
  const [list, setList] = useState<{ portal: boolean; sources: RecordSource[] } | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [mic, setMic] = useState(false)
  const [phase, setPhase] = useState<Phase>('wahl')
  const [count, setCount] = useState(3)
  const [sec, setSec] = useState(0)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false) // Portal offen: kein zweiter Start
  const alive = useRef(true)
  const stopRef = useRef<((cut: boolean) => void) | null>(null)

  useEffect(() => {
    window.api.recordSources().then((l) => { setList(l); setPick(l.sources.find((s) => s.screen)?.id ?? l.sources[0]?.id ?? null) }, (e) => setErr(msg(e)))
    const off = window.api.onRecordBack((cut) => stopRef.current?.(cut))
    alive.current = true
    // Sheet zu: laufende Aufnahme verwerfen
    return () => { off(); alive.current = false; stopRef.current?.(false); void window.api.recordCancel() }
  }, [])

  const start = async () => {
    setErr('')
    setBusy(true)
    const tracks: MediaStreamTrack[] = []
    const gone = () => { if (!alive.current) throw new Error('abgebrochen') }
    try {
      await window.api.recordArm(list!.portal ? null : pick, mic)
      // vor dem Countdown: im Portal wählt der Nutzer hier noch die Quelle
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
      tracks.push(...screen.getVideoTracks())
      if (mic) tracks.push(...(await navigator.mediaDevices.getUserMedia({ audio: true })).getAudioTracks())
      gone()
      setPhase('zaehlen')
      for (const n of [3, 2, 1]) { setCount(n); await sleep(1000); gone() }
      await window.api.recordStart()
      gone()
      const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime(mic), videoBitsPerSecond: 8_000_000 })
      let sent = Promise.resolve(), cut = false, failed = ''
      const stop = (c: boolean) => { if (rec.state !== 'inactive') { cut = c; rec.stop() } }
      rec.ondataavailable = (e) => {
        if (!e.data.size) return
        sent = sent.then(async () => { if (!failed) await window.api.recordChunk(new Uint8Array(await e.data.arrayBuffer())) })
          .catch((x) => { failed = msg(x); stop(false) })
      }
      const stopped = new Promise((go) => { rec.onstop = go })
      tracks[0].onended = () => stop(false) // „Freigabe beenden“ des Systems
      stopRef.current = stop
      const t0 = Date.now()
      const tick = setInterval(() => setSec(Math.floor((Date.now() - t0) / 1000)), 500)
      rec.start(1000)
      setPhase('laeuft')
      await stopped
      clearInterval(tick)
      stopRef.current = null
      tracks.forEach((t) => t.stop())
      await sent
      gone()
      if (failed) throw new Error(failed)
      setPhase('speichern')
      onDone(await window.api.recordStop(cut))
    } catch (e) {
      tracks.forEach((t) => t.stop())
      await window.api.recordCancel().catch(() => {})
      if (!alive.current) return
      setPhase('wahl')
      setBusy(false)
      // Portal oder Systemdialog abgebrochen: kein Fehler
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) setErr(msg(e))
    }
  }

  return (
    <div className="rec" role="dialog" aria-modal="true" aria-labelledby="rec-title"
      onKeyDown={(e) => { if (e.key === 'Escape' && (phase === 'wahl' || phase === 'zaehlen')) onClose(); e.stopPropagation() }}>
      <div className="rec-card material">
        {phase === 'wahl' && <>
          <h1 id="rec-title">Bildschirm aufnehmen</h1>
          <p className="rec-sub">Nach 3 Sekunden tritt Deckwerk zur Seite. Zum Beenden holst du Deckwerk wieder nach vorn.</p>
          {!list ? <p className="rec-sub">Quellen werden gesucht …</p>
            : list.portal ? <p className="rec-sub">Welchen Bildschirm oder welches Fenster du aufnimmst, wählst du gleich im Dialog deines Systems.</p>
            : (
              <div className="rec-grid" role="radiogroup" aria-label="Quelle">
                {list.sources.map((s) => (
                  <button key={s.id} role="radio" aria-checked={pick === s.id} className={pick === s.id ? 'on' : ''} onClick={() => setPick(s.id)}>
                    <span className="rec-thumb">{s.thumb ? <img src={s.thumb} alt="" /> : s.screen ? <Monitor size={22} /> : <AppWindow size={22} />}</span>
                    <span className="rec-name">{s.screen ? <Monitor size={13} /> : <AppWindow size={13} />}<span>{s.name}</span></span>
                  </button>
                ))}
              </div>
            )}
          <Switch checked={mic} onChange={setMic} label="Mikrofon aufnehmen" hint="Deine Stimme kommt mit in die Aufnahme." />
          {err && <p className="rec-err" role="alert">{err}</p>}
          <div className="rec-nav">
            <button className="plain" onClick={onClose}>Abbrechen</button>
            <button className="pill tint" disabled={busy || !list || (!list.portal && !pick)} onClick={() => void start()}>
              {list?.portal ? 'Bildschirm wählen …' : 'Aufnahme starten'}
            </button>
          </div>
        </>}
        {phase === 'zaehlen' && <>
          <h1 id="rec-title" className="rec-count" aria-live="assertive">{count}</h1>
          <div className="rec-nav"><button className="plain" onClick={onClose}>Abbrechen</button></div>
        </>}
        {phase === 'laeuft' && <>
          <h1 id="rec-title"><span className="rec-dot" />Aufnahme läuft · {clock(sec)}</h1>
          <p className="rec-sub">Höchstens 30 Minuten.</p>
          <div className="rec-nav"><button className="pill tint" onClick={() => stopRef.current?.(false)}>Aufnahme beenden</button></div>
        </>}
        {phase === 'speichern' && <h1 id="rec-title">Aufnahme wird gespeichert …</h1>}
      </div>
    </div>
  )
}
