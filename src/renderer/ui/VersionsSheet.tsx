// Versionsverlauf (Canva): Stände, die Main beim Speichern etwa alle 10 min nach <deck>/versions sichert, ansehen und
// einen wiederherstellen. Das läuft über den normalen Öffnen-Weg (restore() in Main), der jetzige Stand bleibt als Version.
import { useEffect, useRef, useState } from 'react'
import type { Deck } from '../../shared/deck'
import { SlideView } from '../slide'
import { confirmDialog } from './kit'
import './versions.css'

type Version = Awaited<ReturnType<typeof window.api.versions>>[number]

const time = (t: number) => `${new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`
function day(t: number): string {
  const d = new Date(t).toDateString()
  const y = new Date()
  if (d === y.toDateString()) return 'Heute'
  y.setDate(y.getDate() - 1) // nicht −24 h: Tage mit Zeitumstellung haben 23 oder 25 Stunden
  if (d === y.toDateString()) return 'Gestern'
  return new Date(t).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

interface Props { onRestore: (file: string) => void; onClose: () => void }

export function VersionsSheet({ onRestore, onClose }: Props) {
  const [list, setList] = useState<Version[] | null>(null) // null = lädt
  const [pick, setPick] = useState<Version | null>(null)
  const [deck, setDeck] = useState<Deck | null>(null)
  const [broken, setBroken] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    box.current?.focus()
    window.api.versions().then((l) => { setList(l); setPick(l[0] ?? null) }, () => setList([]))
  }, [])
  useEffect(() => {
    setDeck(null)
    setBroken(false)
    if (!pick) return
    let live = true // schnelles Durchklicken: nur die zuletzt gewählte Version zeigen
    window.api.readVersion(pick.file).then((d) => { if (live) setDeck(d) }, () => { if (live) setBroken(true) })
    return () => { live = false }
  }, [pick])

  const groups = new Map<string, Version[]>()
  for (const v of list ?? []) groups.set(day(v.at), [...(groups.get(day(v.at)) ?? []), v])
  const restore = async () => {
    if (!pick || !(await confirmDialog({ title: 'Diese Version wiederherstellen?', text: 'Der jetzige Stand bleibt als Version erhalten.', ok: 'Wiederherstellen' }))) return
    onClose()
    onRestore(pick.file)
  }

  return (
    <div className="look" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Versionsverlauf"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }}>
      <header className="top">
        <div className="top-l" />
        <b>Versionsverlauf</b>
        <div className="top-r"><button className="plain tint" onClick={onClose}>Schließen</button></div>
      </header>
      {list && !list.length ? (
        <div className="versions-empty">
          <h1>Noch keine Versionen.</h1>
          <p>Deckwerk sichert beim Arbeiten etwa alle 10 Minuten einen Stand. Hier kannst du später zu jedem davon zurück.</p>
        </div>
      ) : (
        <div className="versions-body">
          <aside className="versions-list" aria-label="Versionen">
            {[...groups].map(([g, vs]) => (
              <section key={g}>
                <h2>{g}</h2>
                {vs.map((v) => (
                  <button key={v.file} className={v === pick ? 'on' : ''} aria-pressed={v === pick} onClick={() => setPick(v)}>
                    <b>{time(v.at)}</b>
                    <span>{v.slides} {v.slides === 1 ? 'Folie' : 'Folien'}</span>
                  </button>
                ))}
              </section>
            ))}
          </aside>
          <main className="versions-main">
            {pick && (
              <div className="versions-bar">
                <span><b>{day(pick.at)}, {time(pick.at)}</b> · {pick.title}</span>
                <button className="pill tint" disabled={!deck} onClick={restore}>Diese Version wiederherstellen</button>
              </div>
            )}
            {broken && <p className="versions-note">Diese Version lässt sich nicht lesen.</p>}
            {deck && (
              <div className="versions-grid">
                {deck.slides.map((s, i) => <div key={s.id ?? i} className="versions-thumb"><SlideView deck={deck} index={i} width={240} /></div>)}
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  )
}
