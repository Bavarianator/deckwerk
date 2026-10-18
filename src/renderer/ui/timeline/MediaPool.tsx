// Medienpool der Pro-Timeline: alle Quellen der Timeline plus hier importierte; Einträge in die Spuren ziehen oder an den Abspielkopf setzen
import { useEffect, useState } from 'react'
import type { TimelineContent } from '../../../shared/timeline'
import { MEDIA_MIME, isAudioSrc, isImageSrc, probeMedia, srcFromDrop } from './media'
import './mediapool.css'

const nameOf = (src: string) => { try { return decodeURIComponent(src.split('/').pop() || src) } catch { return src } }
const kindOf = (src: string) => (isAudioSrc(src) ? 'Ton' : isImageSrc(src) ? 'Bild' : 'Video')
const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function MediaPool(p: { tl: TimelineContent; onAdd: (src: string) => void }) {
  const [imported, setImported] = useState<string[]>([])
  const [len, setLen] = useState<Record<string, number | null>>({}) // null = unlesbar
  const [err, setErr] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const list = [...new Set([...p.tl.tracks.flatMap((t) => t.clips.map((c) => c.src)), ...imported])].filter(Boolean)

  // Längen nachladen, je Quelle einmal
  useEffect(() => {
    for (const src of list) {
      if (src in len || isImageSrc(src)) continue
      setLen((l) => ({ ...l, [src]: null }))
      probeMedia(src).then((r) => setLen((l) => ({ ...l, [src]: r.duration })), () => {})
    }
  }, [list.join('\n')]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = (srcs: string[]) => setImported((a) => [...new Set([...a, ...srcs])])
  const pick = async (kind: 'video' | 'audio') => {
    setErr(null)
    try { const f = await window.api.pickMedia(kind); if (f) add([f]) } catch (e) { setErr((e as Error).message) }
  }

  return (
    <div className={over ? 'tl-pool tl-pool-over' : 'tl-pool'}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true) } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        const s = srcFromDrop(e.dataTransfer)
        s.length ? (add(s), setErr(null)) : setErr('Nur Video-, Ton- und Bilddateien')
      }}>
      <div className="tl-pool-head">
        <b>Medien</b>
        <button onClick={() => pick('video')}>Importieren …</button>
        <button onClick={() => pick('audio')}>Ton …</button>
      </div>
      {err && <p className="tl-pool-err">{err}</p>}
      {!list.length && <p className="tl-pool-empty">Dateien hierher ziehen oder importieren</p>}
      <ul>
        {list.map((src) => (
          <li key={src} draggable title={nameOf(src)} onDragStart={(e) => { e.dataTransfer.setData(MEDIA_MIME, src); e.dataTransfer.effectAllowed = 'copy' }}>
            <span className="tl-pool-name">{nameOf(src)}</span>
            <span className="tl-pool-meta">{kindOf(src)}{len[src] ? ` · ${time(len[src]!)}` : ''}</span>
            <button onClick={() => p.onAdd(src)} title="Am Abspielkopf in die Timeline setzen">An Abspielkopf</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
