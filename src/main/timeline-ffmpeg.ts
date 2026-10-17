// Pro-Timeline → ffmpeg: baut Argumente je Abschnitt (zwischen zwei Schnittpunkten). Rein: startet kein ffmpeg, ohne Electron, damit Selbsttests es unter Node prüfen.
import { clipEnd, cutPoints, EQ_HZ, TL, fpsArg, speedOfClip, srcAt, tlAt, tlDuration, type Active, type Deliver, type TimelineContent, type TLClip } from '../shared/timeline'

export interface Section { start: number; end: number; video: Active[]; audio: Active[] }

const num = (v: number) => String(Math.round(v * 1e6) / 1e6)
// ponytail: Kopie aus src/shared/video.ts (even), gemeinsam machen, wenn sich die Formel ändert
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
// ponytail: Kopie aus src/main/export-video.ts (atempo), gemeinsam machen, wenn sich die Formel ändert
const atempo = (sp: number): string[] => (sp > 2 ? ['atempo=2', ...atempo(sp / 2)] : sp < 0.5 ? ['atempo=0.5', ...atempo(sp / 0.5)] : sp === 1 ? [] : [`atempo=${num(sp)}`])
// Wert einer Filteroption in filter_complex: erst für die Option (\ ' :), dann für den Graphen (\ ' [ ] , ;) escapen
// Standbilder (Logo, Foto auf V2+): laufen als Schleife, haben keinen Ton
const isImage = (src: string) => /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(src)
const escOpt = (s: string) => s.replace(/[\\':]/g, '\\$&').replace(/[\\'[\],;]/g, '\\$&')

/** Abschnitte zwischen allen Schnittpunkten mit den aktiven Clips: video von unten nach oben (ohne ausgeblendete Spuren),
 *  audio = Clips der Audiospuren und Ton der Videoclips, jeweils ohne stumme Spuren und ohne mute am Clip. src = Quellsekunde bei start */
export function sections(tl: Pick<TimelineContent, 'tracks'>): Section[] {
  const ts = cutPoints(tl), out: Section[] = []
  for (let k = 1; k < ts.length; k++) {
    const start = ts[k - 1], end = ts[k], mid = (start + end) / 2, sec: Section = { start, end, video: [], audio: [] }
    if (end - start < 1e-6) continue
    tl.tracks.forEach((track, index) => {
      // Mitte statt start: cutPoints rundet auf 1e-4, an der Kante könnte der Clip knapp fehlen
      const clip = track.clips.findLast((c) => mid >= c.at && mid < clipEnd(c)) // wie activeAt: bei Überlappung gewinnt der spätere
      if (!clip) return
      const a: Active = { track, clip, index, src: srcAt(clip, start) }
      if (track.kind === 'video' && !track.hide) sec.video.push(a)
      if (!track.mute && !clip.mute && !isImage(clip.src)) sec.audio.push(a)
    })
    out.push(sec)
  }
  return out
}

/** Ausgabegröße: res ist die kurze Seite, das Seitenverhältnis (w/h) kommt von der Folie; gerade px */
export function size(deliver: Pick<Deliver, 'res'>, aspect: number): { w: number; h: number } {
  return aspect >= 1 ? { w: even(deliver.res * aspect), h: deliver.res } : { w: deliver.res, h: even(deliver.res / aspect) }
}

// Eingang eines Clips für den Abschnitt: ab Quellsekunde src, so viel Quelle, wie der Abschnitt bei speed verbraucht; Bilder als Schleife über den Abschnitt
const input = (a: Active, sec: Section, fps: string) => isImage(a.clip.src)
  ? ['-loop', '1', '-framerate', fps, '-t', num(sec.end - sec.start), '-i', a.clip.src]
  : ['-ss', num(a.src), '-t', num((sec.end - sec.start) * speedOfClip(a.clip)), '-i', a.clip.src]

// crop füllt (horizontal um focus, wie cropRect in video.ts), contain zeigt alles mit schwarzem Rand
function fitFilter(c: TLClip, w: number, h: number) {
  if (c.fit === 'contain') return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:clip(${num(c.focus ?? 0.5)}*iw-ow/2\\,0\\,iw-ow):(ih-oh)/2`
}

/** ffmpeg-Argumente für die Bildspur eines Abschnitts (Eingänge, filter_complex, -map [vout]), ohne Codec und Ausgabedatei.
 *  Der Aufrufer hängt format=yuv420p bzw. encodeArgs an. lutPath/satFilter kommen aus grade.ts (cube1d, satFilter). */
export function videoArgs(sec: Section, deliver: Deliver, aspect: number, lutPath: (clip: TLClip) => string | null, satFilter: (sat?: number) => string | null): string[] {
  const { w: W, h: H } = size(deliver, aspect), r = fpsArg(deliver.fps), len = num(sec.end - sec.start), n = sec.video.length
  // Farbe in RGB wie die Vorschau (grade.ts): erst format, dann lut1d, dann Sättigung; 10-bit-Codecs in gbrp10le.
  // 10 bit: Grund und overlay ausdrücklich in 10 bit, sonst fällt die Kette am overlay auf 8 bit zurück
  const rgb = deliver.codec === 'h264' ? 'rgb24' : 'gbrp10le'
  const yuv = deliver.codec === 'h264' ? null : deliver.codec === 'h264-10' ? 'yuv420p10' : 'yuv422p10'
  const args = sec.video.flatMap((a) => input(a, sec, r))
  args.push('-f', 'lavfi', '-i', `color=black:s=${W}x${H}:r=${r}:d=${len}${yuv ? `,format=${yuv}le` : ''}`)
  const f: string[] = []
  let last = `[${n}:v]`
  sec.video.forEach((a, i) => {
    const c = a.clip, box = c.box
    const [w, h] = box ? [even(box[2] * W), even(box[2] * H)] : [W, H]
    const lut = lutPath(c), sat = satFilter(c.grade?.sat)
    const chain = [`setpts=(PTS-STARTPTS)/${num(isImage(c.src) ? 1 : speedOfClip(c))}`, `fps=${r}`, fitFilter(c, w, h), 'setsar=1', ...(lut || sat ? [`format=${rgb}`] : []), ...(lut ? [`lut1d=file=${escOpt(lut)}`] : []), ...(sat ? [sat] : [])]
    f.push(`[${i}:v]${chain.join(',')}[c${i}]`)
    const out = i === n - 1 ? '[vout]' : `[o${i}]`
    f.push(`${last}[c${i}]overlay=${box ? `${Math.round(box[0] * W)}:${Math.round(box[1] * H)}` : '0:0'}:eof_action=pass${yuv ? `:format=${yuv}` : ''}${out}`)
    last = out
  })
  if (!n) f.push(`${last}null[vout]`)
  return [...args, '-filter_complex', f.join(';'), '-map', '[vout]']
}

/** Pegel-Keys [Quellsekunde, dB] als Faktor für volume=…:eval=frame, t = Sekunde im Abschnitt (offset = sec.start).
 *  Zwischen den Keys linear in dB, davor/danach konstant; Kommas für filter_complex escapt. */
export function keyExpr(keys: [src: number, db: number][], clip: Pick<TLClip, 'at' | 'in' | 'speed'>, offset: number): string {
  const pt = [...keys].sort((a, b) => a[0] - b[0]).map(([s, db]) => [tlAt(clip, s) - offset, Math.min(TL.db.max, Math.max(TL.db.min, db))])
  if (!pt.length) return '1'
  let e = num(pt[pt.length - 1][1])
  for (let k = pt.length - 2; k >= 0; k--) {
    const [ta, va] = pt[k], [tb, vb] = pt[k + 1]
    if (tb > ta) e = `if(lt(t,${num(tb)}),${num(va)}+(${num((vb - va) / (tb - ta))})*max(0,t-(${num(ta)})),${e})`
  }
  return `pow(10,(${e})/20)`.replace(/,/g, '\\,')
}

/** ffmpeg-Argumente für den Ton eines Abschnitts (Eingänge, filter_complex, -map [aout]), ohne Codec und Ausgabedatei. 0 Clips = Stille.
 *  Nimmt an, dass jede Quelle Ton hat (der Aufrufer setzt mute bei Videos ohne Tonspur). */
export function audioArgs(sec: Section, sampleRate = 48000): string[] {
  const aud = sec.audio.filter((a) => !isImage(a.clip.src)), len = num(sec.end - sec.start), n = aud.length
  if (!n) return ['-f', 'lavfi', '-t', len, '-i', `anullsrc=r=${sampleRate}:cl=stereo`, '-filter_complex', `[0:a]atrim=0:${len}[aout]`, '-map', '[aout]']
  const args = aud.flatMap((a) => input(a, sec, ''))
  const f = aud.map((a, i) => {
    const c = a.clip, sp = speedOfClip(c), eq = c.eq ?? {}
    const delay = Math.round(Math.max(0, c.at - sec.start) * 1000)
    const chain = [
      `atrim=0:${num((sec.end - sec.start) * sp)}`, 'asetpts=PTS-STARTPTS', `aformat=sample_rates=${sampleRate}:channel_layouts=stereo`, ...atempo(sp),
      `volume=${num((c.volume ?? 1) * (a.track.volume ?? 1))}`,
      ...(c.keys?.length ? [`volume=${keyExpr(c.keys, c, sec.start)}:eval=frame`] : []),
      ...(eq.low ? [`lowshelf=f=${EQ_HZ.low}:g=${num(eq.low)}`] : []),
      ...(eq.mid ? [`equalizer=f=${EQ_HZ.mid}:t=q:w=1:g=${num(eq.mid)}`] : []),
      ...(eq.high ? [`highshelf=f=${EQ_HZ.high}:g=${num(eq.high)}`] : []),
      ...(delay ? [`adelay=${delay}:all=1`] : []),
    ]
    return `[${i}:a]${chain.join(',')}[a${i}]`
  })
  f.push(`${aud.map((_, i) => `[a${i}]`).join('')}amix=inputs=${n}:normalize=0:duration=longest,apad,atrim=0:${len}[aout]`)
  return [...args, '-filter_complex', f.join(';'), '-map', '[aout]']
}

/** Video-Codec der Ausgabe (Ton muxt der Aufrufer getrennt, siehe audioCodec) */
export function encodeArgs(deliver: Deliver): { args: string[]; ext: 'mp4' | 'mov'; encoder: string } {
  const r = ['-r', fpsArg(deliver.fps)]
  switch (deliver.codec) {
    case 'h264-10': return { ext: 'mp4', encoder: 'libx264', args: ['-c:v', 'libx264', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le', '-crf', '18', ...r] }
    case 'prores': return { ext: 'mov', encoder: 'prores_ks', args: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', ...r] }
    case 'dnxhr': return { ext: 'mov', encoder: 'dnxhd', args: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx', '-pix_fmt', 'yuv422p10le', ...r] }
    default: return { ext: 'mp4', encoder: 'libx264', args: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', ...r] }
  }
}

/** Ton-Codec passend zum Container: AAC in mp4, PCM 24 bit in mov */
export const audioCodec = (deliver: Deliver): string[] => (encodeArgs(deliver).ext === 'mov' ? ['-c:a', 'pcm_s24le'] : ['-c:a', 'aac', '-b:a', '256k'])

/** Grobe Exportdauer in s. ponytail: Annahme 16:9 und ~1,2e8 px/s (libx264 medium, 1080p ≈ 60 Bilder/s auf 2 Kernen), je Ebene ein Zuschlag von 30 %;
 *  ProRes/DNxHR sind schneller, die Schätzung liegt dort zu hoch. Bei Bedarf am echten Durchsatz kalibrieren. */
export function estimate(tl: Pick<TimelineContent, 'tracks'>, deliver: Deliver): number {
  const { w, h } = size(deliver, 16 / 9), layers = sections(tl).reduce((s, x) => s + (x.end - x.start) * Math.max(0, x.video.length - 1), 0)
  return (w * h * deliver.fps * (tlDuration(tl) + 0.3 * layers)) / 1.2e8
}
