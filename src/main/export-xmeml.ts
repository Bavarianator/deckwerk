// Schnittliste neben dem Video-Export als Final-Cut-7-XML (xmeml version 5): Premiere Pro liest nur dieses Format (kein FCPXML), DaVinci Resolve auch.
// Die Zeitleiste spiegelt das MP4: 30 fps, Ausgabegröße, die fertigen parts (nach Einrasten, Pausenkürzen, Polster), Spuren V1 + A1/A2 (Stereo je Kanal eine Spur wie Premiere).
// Rein, ohne ffmpeg und Electron. Grenzen: Quelle ohne fps gilt als 30 fps; variable Bildrate (Handy) zählt mit der mittleren fps, in/out können dort leicht danebenliegen;
// Blenden werden harte Schnitte; Zuschnitt, Look, Untertitel und Einblendungen stehen nicht als Effekt in der Spur, Hook, Einblendungen, Standbild und Zuschnitt als Marker.
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { clipSpans, freezeOf, partLen, partsLength, speedOf, type Overlay, type Part, type VideoInfo } from '../shared/video'

/** Marker in Sekunden ab Anfang der Szene; ohne end ein Punkt */
export interface Mark { t: number; end?: number; name: string; comment?: string }
/** Eine Clip-Szene in der Ausgabedatei: at = Anfang (s), parts wie exportiert */
export interface Scene { at: number; src: string; info: VideoInfo & { audio?: boolean }; parts: Part[]; marks?: Mark[] }

const FPS = 30 // Ausgabe wie export-video (-r 30)
type Rate = { tb: number; ntsc: boolean; real: number }
// timebase + ntsc wie FCP 7: 29,97 → 30 TRUE, 23,98 → 24 TRUE, 25 → 25 FALSE; real = Bilder je Sekunde. ponytail: krumme Raten ohne NTSC (12,5) runden auf ganze Bilder
function rateOf(fps = FPS): Rate {
  if (!Number.isFinite(fps) || fps <= 0) fps = FPS
  const tb = Math.max(1, Math.round(fps)), ntsc = Math.abs(fps - (tb * 1000) / 1001) < Math.abs(fps - tb)
  return { tb, ntsc, real: ntsc ? (tb * 1000) / 1001 : tb }
}
const rate = (r: Rate) => `<rate><timebase>${r.tb}</timebase><ntsc>${r.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`
const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
// Steuerzeichen sind in XML 1.0 verboten (Premiere lehnt die Datei sonst ab)
const esc = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[&<>"']/g, (c) => ENT[c])
const de = (n: number) => String(+n.toFixed(2)).replace('.', ',')
// Premiere schreibt file://localhost/ + Prozent-kodierten Pfad (Windows: file://localhost/C:/…)
const url = (p: string) => pathToFileURL(p).href.replace(/^file:\/\/\//, 'file://localhost/')
const param = (id: string, value: string | number, range?: [number, number]) =>
  `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${id}</name>${range ? `<valuemin>${range[0]}</valuemin><valuemax>${range[1]}</valuemax>` : ''}<value>${value}</value></parameter>`
// Konstantes Tempo als Time Remap, aufgebaut wie Premieres Export (speed in Prozent). Auf Ton-Clips ohne mediatype wie auto-editor, dessen Export Premiere so liest
const remap = (sp: number, video: boolean) =>
  `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype>${video ? '<mediatype>video</mediatype>' : ''}` +
  `${param('variablespeed', 0, [0, 1])}${param('speed', +(sp * 100).toFixed(4), [-100000, 100000])}${param('reverse', 'FALSE')}${param('frameblending', 'FALSE')}</effect></filter>`

/** Marker einer Clip-Szene: Hook ab 0, je Einblendung ihre sichtbaren Stücke auf der Clip-Achse (clipSpans über die fertigen parts) */
export const clipMarks = (hook: string | undefined, overlays: Overlay[] = [], parts: Part[]): Mark[] => [
  ...(hook?.trim() ? [{ t: 0, end: Math.min(4, partsLength(parts)), name: 'Hook', comment: hook.trim() }] : []),
  ...overlays.flatMap((x) => clipSpans(parts, x.start, x.end).map(([t, end]) => ({
    t, end, name: `Einblendung ${x.slide ? `Folie ${x.slide}` : x.video ? 'Video' : x.image ? 'Bild' : x.art ?? 'text'}`,
    comment: [x.text, x.sub, ...(x.items ?? [])].filter((s) => s?.trim()).join(' · '),
  }))),
]

/** xmeml-Dokument für eine Ausgabedatei (duration in s). Zeiten in der Spur kumulativ aus partLen gerundet, nie je Ausschnitt: kein Drift gegen das MP4. */
export function xmeml(o: { name: string; size: { w: number; h: number }; duration: number; scenes: Scene[] }): string {
  const fr = (t: number) => Math.round(t * FPS), seq = rate(rateOf(FPS))
  const files = new Map<string, number>()
  type Item = { sc: Scene; file: number; r: Rate; sp: number; start: number; end: number; in: number; out: number }
  const items: Item[] = [], marks: { in: number; out: number; name: string; comment: string }[] = []
  const len = (x: Item) => Math.round(((x.end - x.start) * x.r.real) / FPS) // Spurlänge in Bildern der Quelle
  for (const sc of o.scenes) {
    if (!files.has(sc.src)) files.set(sc.src, files.size + 1)
    const r = rateOf(sc.info.fps), file = files.get(sc.src)!
    const crop = sc.info.w / sc.info.h > o.size.w / o.size.h + 0.01 // nur dann wirkt focus (cropRect)
    let t = sc.at, focus: number | undefined
    for (const p of sc.parts) {
      // Standbild: Lücke in der Spur, so viele Bilder wie export-video hält
      const sp = speedOf(p), F = Math.round(freezeOf(p) * FPS), start = fr(t)
      t += partLen(p)
      const end = Math.max(start, fr(t) - F)
      // in/out in Bildern der Quelle; mit Tempo wie Premiere und FCP 7 in umgerechneter Zeit (Quellbild / Tempo), out − in = Länge in der Spur
      const x: Item = { sc, file, r, sp, start, end, in: Math.round((p.start * r.real) / sp), out: 0 }
      x.out = x.in + len(x)
      if (end > start) items.push(x)
      if (F) marks.push({ in: end, out: end + F, name: 'Standbild', comment: `Letztes Bild ${de(F / FPS)} s halten (Freeze Frame)` })
      if (crop && p.focus !== undefined && p.focus !== focus) marks.push({ in: start, out: -1, name: 'Zuschnitt', comment: `Bildmitte bei ${Math.round(p.focus * 100)} % der Breite` })
      if (p.zoom && p.zoom > 1) marks.push({ in: start, out: end, name: 'Zoom', comment: `${de(p.zoom)}×` })
      focus = p.focus
    }
    for (const m of sc.marks ?? []) marks.push({ in: fr(sc.at + m.t), out: m.end === undefined ? -1 : fr(sc.at + m.end), name: m.name, comment: m.comment ?? '' })
  }
  // Folienblende im mp4 (joinSegs): die nächste Szene beginnt vor dem Ende der vorigen; in der Spur harter Schnitt am Anfang der Blende
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1]
    if (items[i].start < a.end) { a.end = Math.max(a.start, items[i].start); a.out = a.in + len(a) }
  }
  const vs = items.filter((x) => x.end > x.start), as = vs.filter((x) => x.sc.info.audio !== false)
  const vid = (i: number) => `clipitem-${i + 1}`, aud = (k: 1 | 2, j: number) => `clipitem-${vs.length + (k - 1) * as.length + j + 1}`
  const link = (ref: string, type: string, track: number, idx: number) =>
    `<link><linkclipref>${ref}</linkclipref><mediatype>${type}</mediatype><trackindex>${track}</trackindex><clipindex>${idx}</clipindex>${type === 'audio' ? '<groupindex>1</groupindex>' : ''}</link>`
  const links = (x: Item) => {
    const i = vs.indexOf(x), j = as.indexOf(x)
    return link(vid(i), 'video', 1, i + 1) + (j < 0 ? '' : link(aud(1, j), 'audio', 1, j + 1) + link(aud(2, j), 'audio', 2, j + 1))
  }
  const defined = new Set<number>()
  // Erste Erwähnung beschreibt die Datei, danach nur die id (die Videospur steht vorn)
  const fileEl = (x: Item) => {
    if (defined.has(x.file)) return `<file id="file-${x.file}"/>`
    defined.add(x.file)
    const { info, src } = x.sc
    return `<file id="file-${x.file}"><name>${esc(basename(src))}</name><pathurl>${esc(url(src))}</pathurl>${rate(x.r)}<duration>${Math.round(info.duration * x.r.real)}</duration>` +
      `<timecode>${rate(x.r)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media>` +
      `<video><samplecharacteristics>${rate(x.r)}<width>${info.w}</width><height>${info.h}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>` +
      `${info.audio !== false ? '<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>' : ''}</media></file>`
  }
  // track: 0 = Video, 1/2 = linker/rechter Kanal
  const clip = (x: Item, id: string, track: 0 | 1 | 2) =>
    `<clipitem id="${id}"${track ? ' premiereChannelType="stereo"' : ''}><name>${esc(basename(x.sc.src))}</name><enabled>TRUE</enabled>` +
    `<duration>${Math.round((x.sc.info.duration * x.r.real) / x.sp)}</duration>${rate(x.r)}<start>${x.start}</start><end>${x.end}</end><in>${x.in}</in><out>${x.out}</out>` +
    `${fileEl(x)}${x.sp !== 1 ? remap(x.sp, !track) : ''}${track ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${track}</trackindex></sourcetrack>` : ''}${links(x)}</clipitem>`
  const aTrack = (k: 1 | 2) => [`<track currentExplodedTrackIndex="${k - 1}" totalExplodedTrackCount="2" premiereTrackType="Stereo">`,
    ...as.map((x, j) => clip(x, aud(k, j), k)), `<enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>${k}</outputchannelindex></track>`]
  const group = (k: number) => `<group><index>${k}</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>${k}</index></channel></group>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE xmeml>', '<xmeml version="5">', '<sequence id="sequence-1">',
    `<name>${esc(o.name)}</name>`, `<duration>${fr(o.duration)}</duration>`, seq, '<media>', '<video>',
    `<format><samplecharacteristics>${seq}<width>${o.size.w}</width><height>${o.size.h}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`,
    '<track>', ...vs.map((x, i) => clip(x, vid(i), 0)), '<enabled>TRUE</enabled><locked>FALSE</locked></track>', '</video>',
    '<audio>', '<numOutputChannels>2</numOutputChannels>', '<format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>',
    `<outputs>${group(1)}${group(2)}</outputs>`, ...aTrack(1), ...aTrack(2), '</audio>', '</media>',
    `<timecode>${seq}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    ...marks.sort((a, b) => a.in - b.in).map((m) => `<marker><comment>${esc(m.comment)}</comment><name>${esc(m.name)}</name><in>${m.in}</in><out>${m.out}</out></marker>`),
    '</sequence>', '</xmeml>', '',
  ].join('\n')
}
