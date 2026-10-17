// Inspector der Pro-Timeline für den ausgewählten Clip (Teil Clip oder Ton; Farbe macht ColorPage) und für Titel.
// Regler melden live (final = false) und beim Loslassen (final = true)
import { useEffect, useRef, useState } from 'react'
import { EQ_HZ, TL, clipEnd, type Eq, type TLClip, type TLTrack, type TimelineContent } from '../../../shared/timeline'
import { applyOps } from '../../../shared/timeline-edit'
import { OVERLAY_ARTS, OVERLAY_POS, ovPos, type Overlay } from '../../../shared/video'
import { Select } from '../kit'

type Patch = Partial<Omit<TLClip, 'id'>>
const num = (v: number, d = 2) => (+v.toFixed(d)).toString().replace('.', ',').replace('-', '−')
const hz = (n: number) => (n >= 1000 ? `${n / 1000} kHz` : `${n} Hz`)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// Range-Regler: onInput live, natives change (Loslassen, Tastatur) final. React-onChange feuert bei range schon bei jeder Bewegung
function Slider({ label, value, min, max, step, fmt, onSet }: { label: string; value: number; min: number; max: number; step: number; fmt?: (v: number) => string; onSet: (v: number, final: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const cb = useRef(onSet)
  cb.current = onSet
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const fin = () => cb.current(+el.value, true)
    el.addEventListener('change', fin)
    return () => el.removeEventListener('change', fin)
  }, [])
  return (
    <label className="tl-field">
      <span>{label}</span>
      <input ref={ref} type="range" min={min} max={max} step={step} value={value} onInput={(e) => onSet(+e.currentTarget.value, false)} onChange={() => {}} />
      <output>{fmt ? fmt(value) : num(value)}</output>
    </label>
  )
}

// Zahlenfeld mit eigenem Text: übernimmt erst bei Blur oder Enter, damit Klemmen und Sortieren nicht beim Tippen springen
function NumField({ label, step, value, onCommit }: { label: string; step: number; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const done = () => { const v = parseFloat(text.replace(',', '.')); if (Number.isFinite(v) && v !== value) onCommit(v); setText(String(value)) }
  return <input type="number" aria-label={label} step={step} value={text} onChange={(e) => setText(e.currentTarget.value)} onBlur={done} onKeyDown={(e) => e.key === 'Enter' && done()} />
}

/** Direkt anschließender Clip davor auf derselben Spur (Voraussetzung für eine Überblendung, wie xfades) */
export const prevOf = (track: Pick<TLTrack, 'clips'>, clip: TLClip) => track.clips.find((o) => o !== clip && Math.abs(clipEnd(o) - clip.at) <= 1e-3)

export function Inspector({ tl, clipId, part, onChange }: { tl: TimelineContent; clipId: string | null; part: 'clip' | 'ton'; onChange: (tl: TimelineContent, final: boolean) => void }) {
  const ti = clipId ? tl.tracks.findIndex((x) => x.clips.some((c) => c.id === clipId)) : -1
  if (!clipId || ti < 0) return <section className="tl-insp"><p className="tl-hint">{part === 'ton' ? 'Clip auswählen, um EQ und Pegel einzustellen.' : 'Clip oder Titel in der Zeitleiste auswählen.'}</p></section>
  const track = tl.tracks[ti], clip = track.clips.find((c) => c.id === clipId)!
  const video = track.kind === 'video'
  const upper = video && tl.tracks.findIndex((x) => x.kind === 'video') !== ti // V2+

  const set = (patch: Patch, final: boolean) => {
    try { onChange(applyOps(tl, [{ op: 'set', clip: clipId, patch }]), final) } catch { if (final) onChange(tl, true) } // z. B. Überlappung durch Tempo: letzten gültigen Stand speichern
  }
  const eq: Eq = clip.eq ?? {}
  const box = clip.box ?? [0, 0, 1]
  const keys = clip.keys ?? []
  const setKeys = (k: [number, number][]) => set({ keys: [...k].sort((a, b) => a[0] - b[0]) }, true)
  const [fi, fo] = clip.fade ?? [0, 0]
  const setFade = (v: [number, number], f: boolean) => set({ fade: v[0] || v[1] ? v : undefined }, f)
  const sec = (v: number) => `${num(v, 1)} s`

  if (part === 'ton') return (
    <section className="tl-insp">
      <h3>Ton · Clip {clip.id}</h3>
      <Slider label="Lautstärke" value={clip.volume ?? 1} min={TL.volume.min} max={TL.volume.max} step={0.01} fmt={(v) => `${Math.round(v * 100)} %`} onSet={(v, f) => set({ volume: v }, f)} />
      <label className="tl-check"><input type="checkbox" checked={!!clip.mute} onChange={(e) => set({ mute: e.currentTarget.checked }, true)} /> Stumm</label>
      {(['low', 'mid', 'high'] as const).map((k) => (
        <Slider key={k} label={`${{ low: 'Tiefen', mid: 'Mitten', high: 'Höhen' }[k]} ${hz(EQ_HZ[k])}`} value={eq[k] ?? 0} min={TL.eq.min} max={TL.eq.max} step={0.5}
          fmt={(v) => `${num(v, 1)} dB`} onSet={(v, f) => set({ eq: { ...eq, [k]: v } }, f)} />
      ))}
      <div className="tl-keys">
        <span>Pegel-Keyframes (Quellsekunde, dB)</span>
        {keys.map(([s, db], i) => (
          <div key={i} className="tl-key">
            <NumField label="Quellsekunde" step={0.1} value={s} onCommit={(v) => setKeys(keys.map((k, j) => (j === i ? [clamp(v, clip.in, clip.out), k[1]] : k)))} />
            <NumField label="dB" step={0.5} value={db} onCommit={(v) => setKeys(keys.map((k, j) => (j === i ? [k[0], clamp(v, TL.db.min, TL.db.max)] : k)))} />
            <button className="plain" aria-label="Keyframe entfernen" onClick={() => set({ keys: keys.filter((_, j) => j !== i) }, true)}>Entfernen</button>
          </div>
        ))}
        <button className="plain" onClick={() => setKeys([...keys, [keys.length ? Math.min(clip.out, keys[keys.length - 1][0] + 1) : clip.in, 0]])}>+ Keyframe</button>
      </div>
    </section>
  )

  return (
    <section className="tl-insp">
      <h3>Clip {clip.id}</h3>
      <Slider label="Tempo" value={clip.speed ?? 1} min={TL.speed.min} max={TL.speed.max} step={0.05} fmt={(v) => `${num(v)}×`} onSet={(v, f) => set({ speed: v }, f)} />
      {video && <>
        <label className="tl-field">
          <span>Bild</span>
          <Select value={clip.fit ?? 'crop'} onChange={(e) => set({ fit: e.target.value as 'crop' | 'contain' }, true)}>
            <option value="crop">Füllen (beschneiden)</option>
            <option value="contain">Ganz zeigen</option>
          </Select>
        </label>
        {(clip.fit ?? 'crop') === 'crop' && <Slider label="Mittelpunkt" value={clip.focus ?? 0.5} min={0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)} %`} onSet={(v, f) => set({ focus: v }, f)} />}
      </>}
      {upper && <>
        {(['x', 'y', 'Breite'] as const).map((n, i) => (
          <Slider key={n} label={n === 'Breite' ? n : `Lage ${n}`} value={box[i]} min={i === 2 ? 0.05 : 0} max={1} step={0.01} fmt={(v) => `${Math.round(v * 100)} %`}
            onSet={(v, f) => set({ box: box.map((c, j) => (j === i ? v : c)) as [number, number, number] }, f)} />
        ))}
        {clip.box && <button className="plain" onClick={() => set({ box: undefined }, true)}>Vollbild</button>}
      </>}

      <h3>Blenden</h3>
      <Slider label="Einblenden" value={fi} min={TL.fade.min} max={TL.fade.max} step={0.1} fmt={sec} onSet={(v, f) => setFade([v, fo], f)} />
      <Slider label="Ausblenden" value={fo} min={TL.fade.min} max={TL.fade.max} step={0.1} fmt={sec} onSet={(v, f) => setFade([fi, v], f)} />
      {prevOf(track, clip)
        ? <Slider label="Überblendung" value={clip.xfade ?? 0} min={TL.xfade.min} max={TL.xfade.max} step={0.1} fmt={sec} onSet={(v, f) => set({ xfade: v || undefined }, f)} />
        : <p className="tl-hint">Überblendung braucht einen direkt anschließenden Clip davor auf derselben Spur.</p>}
    </section>
  )
}

const TEXT_ARTS = OVERLAY_ARTS.filter((a) => a !== 'liste' && a !== 'markierung' && a !== 'verpixeln') // brauchen items bzw. box
const ART_NAME: Record<string, string> = { text: 'Text', bauchbinde: 'Bauchbinde', titel: 'Titel', zahl: 'Zahl', zitat: 'Zitat', abspann: 'Abspann' }
const POS_NAME: Record<string, string> = { oben: 'Oben', mitte: 'Mitte', unten: 'Unten', 'oben-links': 'Oben links', 'oben-rechts': 'Oben rechts', 'unten-links': 'Unten links', 'unten-rechts': 'Unten rechts', voll: 'Vollbild' }
const OV_MIN = 0.3 // Schema: end > start + 0,3

// Textfeld: übernimmt bei Blur oder Enter, damit nicht jeder Tastendruck ein Undo-Schritt wird
function TextField({ label, value, max, onCommit }: { label: string; value: string; max: number; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const done = () => { if (text.trim() !== value) onCommit(text.trim()) }
  return (
    <label className="tl-field">
      <span>{label}</span>
      <input type="text" maxLength={max} value={text} onChange={(e) => setText(e.currentTarget.value)} onBlur={done} onKeyDown={(e) => e.key === 'Enter' && done()} />
    </label>
  )
}

/** Formular für den Titel tl.overlays[index]; Entfernen hebt die Auswahl auf */
export function TitleInspector({ tl, index, onChange, onSelect }: { tl: TimelineContent; index: number; onChange: (tl: TimelineContent, final: boolean) => void; onSelect: (i: number | null) => void }) {
  const ovs = tl.overlays ?? [], o = ovs[index]
  if (!o) return null
  const put = (p: Partial<Overlay>) => onChange({ ...tl, overlays: ovs.map((x, i) => (i === index ? { ...x, ...p } : x)) }, true)
  const fixed = ovPos({ art: o.art, pos: 'oben' }) !== 'oben' // titel, zitat, abspann stehen immer mittig
  return (
    <section className="tl-insp">
      <h3>Titel</h3>
      <TextField label="Text" value={o.text ?? ''} max={120} onCommit={(v) => v && put({ text: v })} />
      <TextField label="Zusatz" value={o.sub ?? ''} max={60} onCommit={(v) => put({ sub: v || undefined })} />
      <label className="tl-field">
        <span>Art</span>
        <Select value={o.art ?? 'text'} onChange={(e) => put({ art: e.target.value as Overlay['art'] })}>
          {TEXT_ARTS.map((a) => <option key={a} value={a}>{ART_NAME[a] ?? a}</option>)}
        </Select>
      </label>
      <label className="tl-field">
        <span>Lage</span>
        <Select value={o.pos ?? ''} disabled={fixed} onChange={(e) => put({ pos: (e.target.value || undefined) as Overlay['pos'] })}>
          <option value="">Standard</option>
          {OVERLAY_POS.map((p) => <option key={p} value={p}>{POS_NAME[p] ?? p}</option>)}
        </Select>
      </label>
      <label className="tl-field">
        <span>Größe</span>
        <Select value={o.size ?? ''} onChange={(e) => put({ size: (e.target.value || undefined) as Overlay['size'] })}>
          <option value="">Standard</option>
          <option value="klein">Klein</option>
          <option value="mittel">Mittel</option>
          <option value="gross">Groß</option>
        </Select>
      </label>
      <label className="tl-field">
        <span>Anfang (s)</span>
        <NumField label="Anfang" step={0.1} value={o.start} onCommit={(v) => { const s = Math.max(0, v); put({ start: s, end: Math.max(o.end, s + OV_MIN) }) }} />
      </label>
      <label className="tl-field">
        <span>Ende (s)</span>
        <NumField label="Ende" step={0.1} value={o.end} onCommit={(v) => put({ end: Math.max(v, o.start + OV_MIN) })} />
      </label>
      <button className="plain" onClick={() => { onChange({ ...tl, overlays: ovs.filter((_, i) => i !== index) }, true); onSelect(null) }}>Entfernen</button>
    </section>
  )
}
