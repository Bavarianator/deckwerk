// Deck: Titel, Briefing und Hintergrundmusik von Hand setzen – was sonst create_deck/update_deck und find_music der KI erledigen.
// Jede Änderung gilt sofort (Undo-fähig); Tippen in einem Feld ergibt einen Undo-Schritt.
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Music, Search, X } from 'lucide-react'
import { type Deck } from '../../shared/deck'
import { DUCK } from '../../shared/video'

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
type Brief = NonNullable<Deck['brief']>
type MusicSpec = NonNullable<Deck['music']>
interface Hit { id: string; info: string }
const BRIEF: [keyof Brief, string, string, number][] = [
  ['audience', 'Zielgruppe', 'z. B. Geschäftsführung, Klasse 9', 120],
  ['goal', 'Ziel', 'Was das Publikum danach tun oder wissen soll', 200],
  ['tone', 'Tonfall', 'z. B. sachlich, locker', 60],
]
const fileName = (src: string) => { try { return decodeURIComponent(src).split('/').pop() || src } catch { return src } }

interface Props { deck: Deck; onDeck: (patch: Partial<Deck>, final?: boolean) => void; onClose: () => void }

export function DeckSheet({ deck, onDeck, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.focus(), [])
  // leerer Titel wird nie übernommen; das Feld darf beim Tippen kurz leer sein
  const [title, setTitle] = useState(deck.title)
  useEffect(() => setTitle((t) => (t.trim() ? deck.title : t)), [deck.title])
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // „search“ oder die geladene id
  const [err, setErr] = useState('')
  const [loaded, setLoaded] = useState<Record<string, MusicSpec>>({}) // id → von find_music geladene Datei
  const music = deck.music
  const setMusic = (p: Partial<MusicSpec>, final?: boolean) => music && onDeck({ music: { ...music, ...p } }, final)
  const setBrief = (k: keyof Brief, v: string) => {
    const b: Brief = { ...deck.brief, [k]: v || undefined }
    onDeck({ brief: Object.values(b).some(Boolean) ? b : undefined })
  }

  const run = async (key: string, input: { query?: string; id?: string }) => {
    setBusy(key); setErr('')
    try { return (await window.api.runTool('find_music', input)).text } catch (e) { setErr(errText(e)); return null } finally { setBusy(null) }
  }
  const search = async () => {
    const text = await run('search', { query: q.trim() })
    if (text === null) return
    // Antwort: Kopfzeile, dann je Treffer „id · „Titel“ – Künstler · Länge · Lizenz · Tags“
    const rows = text.split('\n').slice(1).filter((l) => l.includes(' · ')).map((l) => { const [id, ...rest] = l.split(' · '); return { id, info: rest.join(' · ') } })
    setHits(rows)
    if (!rows.length) setErr(text)
  }
  const load = async (id: string) => {
    if (loaded[id]) return loaded[id]
    const text = await run(id, { id })
    // find_music empfiehlt der KI: update_deck mit music: {"src":"asset://…","credit":"…"}
    const m = text?.match(/music: (\{.*?\}) \(volume/)
    if (!m) { if (text) setErr(text); return null }
    const spec = JSON.parse(m[1]) as MusicSpec
    setLoaded((x) => ({ ...x, [id]: spec }))
    return spec
  }
  const take = async (id: string) => {
    const spec = await load(id)
    if (spec) onDeck({ music: { ...spec, volume: music?.volume } }, true)
  }
  const pick = async () => {
    const src = await window.api.pickMedia('audio')
    if (src) onDeck({ music: { src, volume: music?.volume } }, true)
  }

  return (
    <div className="look fmt" ref={box} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Deck"
      onKeyDown={(e) => {
        e.stopPropagation() // App blättert sonst die Folien oder löscht beim Tippen
        if (e.key === 'Escape') { e.preventDefault(); onClose() }
      }}>
      <header className="top">
        <div className="top-l" />
        <b>Deck</b>
        <div className="top-r"><button className="pill tint" onClick={onClose}>Fertig</button></div>
      </header>
      <div className="fmt-body dsheet-body">
        <aside className="fmt-side dsheet-form">
          <h1>Titel und Briefing</h1>
          <label>Titel
            <input type="text" maxLength={80} value={title} onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) onDeck({ title: e.target.value }) }}
              onBlur={() => { if (!title.trim()) setTitle(deck.title) }} />
          </label>
          <p>Der Ordner unter ~/DeckwerkPro behält seinen Namen; der Titel gilt für Fenster, Exportdateien und die Deckliste.</p>
          {BRIEF.map(([k, label, hint, max]) => (
            <label key={k}>{label}
              {k === 'goal'
                ? <textarea rows={3} maxLength={max} placeholder={hint} value={deck.brief?.[k] ?? ''} onChange={(e) => setBrief(k, e.target.value)} />
                : <input type="text" maxLength={max} placeholder={hint} value={deck.brief?.[k] ?? ''} onChange={(e) => setBrief(k, e.target.value)} />}
            </label>
          ))}
          <p>Das Briefing liest die KI bei jeder Änderung mit.</p>
        </aside>
        <main className="fmt-side dsheet-form">
          <h1>Musik</h1>
          <p>Hintergrundmusik im Video-Export (MP4), leise unter allem; unter Sprache wird sie automatisch leiser.</p>
          {music ? (
            <div className="fmt-list dsheet-music">
              <div className="dsheet-row">
                <Music size={16} />
                <span className="fmt-name"><b>{fileName(music.src)}</b></span>
                <button className="plain" aria-label="Musik entfernen" title="Musik entfernen" onClick={() => onDeck({ music: undefined }, true)}><X size={16} /></button>
              </div>
              <audio controls preload="none" src={music.src} />
              <label>Lautstärke {Math.round((music.volume ?? DUCK.volume) * 100)} %
                <input type="range" min={0} max={1} step={0.05} value={music.volume ?? DUCK.volume}
                  style={{ '--pct': `${(music.volume ?? DUCK.volume) * 100}%` } as CSSProperties}
                  onChange={(e) => setMusic({ volume: Number(e.target.value) })} />
              </label>
              <label>Nachweis
                <input type="text" maxLength={300} placeholder="Bei CC BY Pflicht: Titel, Künstler, Lizenz" value={music.credit ?? ''} onChange={(e) => setMusic({ credit: e.target.value || undefined })} />
              </label>
            </div>
          ) : <p>Keine Musik gewählt.</p>}
          <div><button className="plain tint" onClick={pick}>Datei wählen …</button></div>
          <form className="dsheet-row" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) void search() }}>
            <input type="search" maxLength={80} placeholder="Freie Musik suchen, englisch: calm piano instrumental" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="plain tint" type="submit" disabled={q.trim().length < 2 || !!busy}><Search size={15} />{busy === 'search' ? 'Sucht …' : 'Suchen'}</button>
          </form>
          {err && <p role="alert">{err}</p>}
          {!!hits?.length && (
            <div className="fmt-list dsheet-music">
              {hits.map((h) => (
                <div key={h.id} className="dsheet-hit">
                  <div className="dsheet-row">
                    <span className="fmt-name"><span>{h.info}</span></span>
                    {!loaded[h.id] && <button className="plain" disabled={!!busy} onClick={() => void load(h.id)}>{busy === h.id ? 'Lädt …' : 'Anhören'}</button>}
                    <button className="plain tint" disabled={!!busy || (!!loaded[h.id] && music?.src === loaded[h.id].src)} onClick={() => void take(h.id)}>Übernehmen</button>
                  </div>
                  {loaded[h.id] && <audio controls src={loaded[h.id].src} />}
                </div>
              ))}
            </div>
          )}
          <p>Openverse: nur CC0, Public Domain und CC BY. Den Nachweis bei CC BY zusätzlich in die Notizen der letzten Folie.</p>
        </main>
      </div>
    </div>
  )
}
