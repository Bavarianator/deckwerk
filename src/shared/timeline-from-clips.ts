// Clip-Folien (Layout clip) in eine Timeline umwandeln: alle Ausschnitte hintereinander auf V1, Text-Einblendungen auf Timeline-Zeit
import { clipSpans, isMedia, type ClipContent, type Overlay, type Part } from './video'
import { snapFrame, type TLClip, type TimelineContent } from './timeline'
import { GRADE_PRESETS } from './grade'

export function fromClips(slides: { content: ClipContent }[] | ClipContent[], fps = 30): { tl: TimelineContent; dropped: string[] } {
  const contents = slides.map((s) => ('content' in s ? s.content : s))
  const dropped = new Set<string>()
  const clips: TLClip[] = []
  const overlays: Overlay[] = []
  let cum = 0
  for (const c of contents) {
    const grade = c.look && c.look !== 'auto' && c.look !== 'neutral' ? GRADE_PRESETS[c.look] : undefined
    if (c.look === 'auto') dropped.add('Farblook auto (automatische Korrektur)')
    if (c.hook) dropped.add('Hook-Zeile')
    if (c.pauses === 'kurz') dropped.add('Pausen kürzen')
    if (c.ton === 'klar') dropped.add('Tonaufbereitung klar')
    if (c.follow) dropped.add('Sprecher folgen')
    if (c.style === 'lebendig') dropped.add('Stil lebendig')
    if (c.stabil) dropped.add('Stabilisieren')
    if (c.captionPos) dropped.add('Lage der Untertitel')
    if (c.cover !== undefined || c.post) dropped.add('Titelbild und Post-Text')
    const ats: number[] = []
    for (const p of c.parts) {
      if (p.freeze) dropped.add('Standbilder (freeze)')
      if (p.zoom && p.zoom !== 1) dropped.add('Punch-in (zoom)')
      if (p.transition) dropped.add('Übergänge an Schnitten')
      if (p.music !== undefined) dropped.add('Musikpegel je Ausschnitt')
      if (p.track) dropped.add('Kamerafahrt (track)')
      // ceil statt round: ein abgerundetes at würde den Vorgänger überlappen
      const at = Math.max(0, Math.ceil(cum * fps - 1e-6) / fps)
      ats.push(at)
      const clip: TLClip = { id: `c${clips.length + 1}`, src: c.video, at, in: p.start, out: p.end }
      if (p.speed !== undefined && p.speed !== 1) clip.speed = p.speed
      if (p.volume !== undefined) clip.volume = p.volume
      if (p.focus !== undefined) clip.focus = p.focus
      if (c.fit) clip.fit = c.fit === 'blur' ? 'contain' : 'crop'
      if (grade) clip.grade = grade
      clips.push(clip)
      cum = at + (p.end - p.start) / (clip.speed ?? 1)
    }
    for (const o of c.overlays ?? []) {
      if (isMedia(o)) { dropped.add('Bild-, Video- und Folien-Einblendungen (als Clips auf V2+ anlegen)'); continue }
      const { image: _i, video: _v, from: _f, slide: _s, ...text } = o
      // je part einzeln, damit die tatsächliche Lage at (ohne freeze, auf Frames) gilt; aneinanderstoßende Stücke verbinden
      const spans: [number, number][] = []
      c.parts.forEach((p, i) => {
        const part: Part = { start: p.start, end: p.end, speed: p.speed }
        for (const [x, y] of clipSpans([part], o.start, o.end)) {
          const l = spans[spans.length - 1]
          if (l && ats[i] + x - l[1] < 1.5 / fps) l[1] = ats[i] + y
          else spans.push([ats[i] + x, ats[i] + y])
        }
      })
      for (const [x, y] of spans) {
        const start = snapFrame(x, fps), end = snapFrame(y, fps)
        if (end > start + 0.3) overlays.push({ ...text, start, end })
        else dropped.add('zu kurze Stücke von Einblendungen')
      }
    }
  }
  const tl: TimelineContent = { tracks: [{ id: 'v1', kind: 'video', clips }] }
  if (overlays.length) tl.overlays = overlays
  if (contents[0]?.captions) tl.captions = contents[0].captions
  return { tl, dropped: [...dropped] }
}
