// Mehrspur-Timeline als Final-Cut-7-XML (xmeml version 5) für Premiere Pro und DaVinci Resolve, Gegenstück zu export-xmeml.ts (einspurig, Clip-Folien).
// Spuren: V1…Vn wie tl.tracks (Videospuren), dann je Videospur mit Ton ein Stereo-Paar (Ton der Clips, verlinkt mit dem Bild), dann je Audiospur ein Stereo-Paar.
// Stereo wie Premiere: je Kanal eine Spur. Zeiten in der Spur je Clip aus round(at·fps) und round(clipEnd·fps), nie als Summe gerundeter Längen: kein Drift.
// Rein, ohne ffmpeg und Electron. Grenzen: Quelle ohne fps gilt als 30 fps; jede Videoquelle gilt als mit Stereoton (info kennt kein audio);
// Blenden (fade, xfade) als transitionitem (fade[0] entfällt bei eingehender, fade[1] bei ausgehender Überblendung: sie belegt die Kante), Lautstärke (volume, keys), EQ, Farbe (grade), Zuschnitt (fit, focus), Bild-in-Bild (box), Einblendungen, Untertitel und captions kommen nicht mit;
// stummgeschaltete Clips verlieren ihren Ton-clipitem, ausgeblendete/stumme Spuren stehen mit enabled FALSE in der Datei.
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { clipEnd, speedOfClip, tlDuration, xfades, type TLClip, type TimelineContent } from '../shared/timeline'

type Info = { duration: number; w: number; h: number; fps?: number }

// ponytail: Kopie aus export-xmeml.ts (Datei gehört repo-setup), zusammenlegen, sobald dort exportiert
const FPS = 30
type Rate = { tb: number; ntsc: boolean; real: number }
function rateOf(fps = FPS): Rate {
  if (!Number.isFinite(fps) || fps <= 0) fps = FPS
  const tb = Math.max(1, Math.round(fps)), ntsc = Math.abs(fps - (tb * 1000) / 1001) < Math.abs(fps - tb)
  return { tb, ntsc, real: ntsc ? (tb * 1000) / 1001 : tb }
}
const rate = (r: Rate) => `<rate><timebase>${r.tb}</timebase><ntsc>${r.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`
const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const esc = (s: string) => s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[&<>"']/g, (c) => ENT[c])
const url = (p: string) => pathToFileURL(p).href.replace(/^file:\/\/\//, 'file://localhost/')
const param = (id: string, value: string | number, range?: [number, number]) =>
  `<parameter authoringApp="PremierePro"><parameterid>${id}</parameterid><name>${id}</name>${range ? `<valuemin>${range[0]}</valuemin><valuemax>${range[1]}</valuemax>` : ''}<value>${value}</value></parameter>`
const remap = (sp: number, video: boolean) =>
  `<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype>${video ? '<mediatype>video</mediatype>' : ''}` +
  `${param('variablespeed', 0, [0, 1])}${param('speed', +(sp * 100).toFixed(4), [-100000, 100000])}${param('reverse', 'FALSE')}${param('frameblending', 'FALSE')}</effect></filter>`
// Ende der Kopie

// Ein clipitem; track 0 = Bild, 1/2 = linker/rechter Kanal. group = alle verlinkten clipitems (Bild + Ton)
type Item = { id: string; c: TLClip; info: Info; r: Rate; sp: number; start: number; end: number; in: number; out: number; track: 0 | 1 | 2; tIdx: number; cIdx: number; group: Item[] }

export function xmemlTimeline(tl: TimelineContent, opts: { name: string; fps: number; w: number; h: number; info: Record<string, Info> }): string {
  const sr = rateOf(opts.fps), seq = rate(sr), fr = (t: number) => Math.round(t * sr.real)
  const fileIds = new Map<string, number>(), defined = new Set<number>()
  let n = 0
  const make = (c: TLClip, track: 0 | 1 | 2, tIdx: number, cIdx: number): Item => {
    const info = opts.info[c.src] ?? { duration: c.out, w: 0, h: 0 }
    const r = rateOf(info.fps), sp = speedOfClip(c), start = fr(c.at), end = fr(clipEnd(c))
    // in/out in Bildern der Quelle, mit Tempo in umgerechneter Zeit (Quellbild / Tempo) wie export-xmeml.ts
    const inF = Math.round((c.in * r.real) / sp)
    return { id: `clipitem-${++n}`, c, info, r, sp, start, end, in: inF, out: inF + Math.round(((end - start) * r.real) / sr.real), track, tIdx, cIdx, group: [] }
  }
  const sorted = (cs: TLClip[]) => [...cs].sort((a, b) => a.at - b.at).filter((c) => fr(clipEnd(c)) > fr(c.at))

  const vTracks = tl.tracks.filter((t) => t.kind === 'video'), aSrc = tl.tracks.filter((t) => t.kind === 'audio')
  const video = vTracks.map((t, i) => ({ t, items: sorted(t.clips).map((c, j) => make(c, 0, i + 1, j + 1)) }))
  // Stereo-Paare: Ton der Videoclips (ohne mute), danach die Audiospuren; pair = Index des Paars (A1/A2 = 0)
  type Pair = { enabled: boolean; l: Item[]; r: Item[] }
  const pairs: Pair[] = []
  const pairOf = (cs: TLClip[], enabled: boolean, bild?: Item[]) => {
    const p = pairs.length, l: Item[] = [], r: Item[] = []
    cs.forEach((c, j) => {
      const a = make(c, 1, 2 * p + 1, l.length + 1), b = make(c, 2, 2 * p + 2, l.length + 1)
      const v = bild?.[j]
      a.group = b.group = v ? (v.group = [v, a, b]) : [a, b]
      l.push(a); r.push(b)
    })
    if (l.length) pairs.push({ enabled, l, r })
  }
  for (const { t, items } of video) {
    const loud = items.filter((x) => !x.c.mute)
    pairOf(loud.map((x) => x.c), !t.mute, loud)
  }
  for (const t of aSrc) pairOf(sorted(t.clips).filter((c) => !c.mute), !t.mute)

  const link = (x: Item) => `<link><linkclipref>${x.id}</linkclipref><mediatype>${x.track ? 'audio' : 'video'}</mediatype><trackindex>${x.tIdx}</trackindex><clipindex>${x.cIdx}</clipindex>${x.track ? '<groupindex>1</groupindex>' : ''}</link>`
  // Erste Erwähnung beschreibt die Datei, danach nur die id
  const fileEl = (x: Item) => {
    const src = x.c.src
    if (!fileIds.has(src)) fileIds.set(src, fileIds.size + 1)
    const id = fileIds.get(src)!
    if (defined.has(id)) return `<file id="file-${id}"/>`
    defined.add(id)
    const { info, r } = x
    return `<file id="file-${id}"><name>${esc(basename(src))}</name><pathurl>${esc(url(src))}</pathurl>${rate(r)}<duration>${Math.round(info.duration * r.real)}</duration>` +
      `<timecode>${rate(r)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media>` +
      (info.w > 0 ? `<video><samplecharacteristics>${rate(r)}<width>${info.w}</width><height>${info.h}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>` : '') +
      '<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio></media></file>'
  }
  const clip = (x: Item) =>
    `<clipitem id="${x.id}"${x.track ? ' premiereChannelType="stereo"' : ''}><name>${esc(basename(x.c.src))}</name><enabled>TRUE</enabled>` +
    `<duration>${Math.round((x.info.duration * x.r.real) / x.sp)}</duration>${rate(x.r)}<start>${x.start}</start><end>${x.end}</end><in>${x.in}</in><out>${x.out}</out>` +
    `${fileEl(x)}${x.sp !== 1 ? remap(x.sp, !x.track) : ''}${x.track ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${x.track}</trackindex></sourcetrack>` : ''}${x.group.map(link).join('')}</clipitem>`
  // Blenden als transitionitem zwischen den clipitems (FCP7-Standard, Premiere und Resolve lesen das als Übergang).
  // Überblendung: mittig (center) über dem Schnitt, a/b in Bildern. fade: Übergang am Clip-Rand (start-black/end-black) statt Opacity-Keyframes:
  // gilt gleich für Bild und Ton, Keyframes würden pro Programm andere Filter-IDs brauchen. Die Lage der clipitems bleibt unberührt.
  const trans = (a: number, b: number, align: string, audio: boolean) => a >= b ? '' :
    `<transitionitem><start>${a}</start><end>${b}</end><alignment>${align}</alignment>${seq}<effect>` +
    (audio ? '<name>Cross Fade (+3dB)</name><effectid>KGAudioTransition</effectid><effectcategory>Crossfade</effectcategory><effecttype>transition</effecttype><mediatype>audio</mediatype>'
      : '<name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype><wipecode>0</wipecode><wipeaccuracy>100</wipeaccuracy><startratio>0</startratio><endratio>1</endratio><reverse>FALSE</reverse>') +
    '</effect></transitionitem>'
  const seqOf = (list: Item[], audio: boolean): string[] => {
    const xs = xfades({ clips: list.map((x) => x.c) })
    return list.flatMap((x) => {
      const into = xs.find((y) => y.to === x.c), out = xs.some((y) => y.from === x.c), [a, b] = x.c.fade ?? [0, 0]
      // fade-Längen proportional auf die Clip-Länge kürzen: ein- und ausblenden berühren sich höchstens
      const k = Math.min(1, (clipEnd(x.c) - x.c.at) / (a + b || 1)), fi = a * k, fo = b * k, mid = fr(x.c.at + fi)
      return [into ? trans(fr(into.a), fr(into.b), 'center', audio) : fi > 0 ? trans(x.start, Math.min(x.end, mid), 'start-black', audio) : '',
        clip(x), !out && fo > 0 ? trans(Math.max(x.start, mid, fr(clipEnd(x.c) - fo)), x.end, 'end-black', audio) : ''].filter(Boolean)
    })
  }
  const on = (b: boolean) => (b ? 'TRUE' : 'FALSE')
  const group = (k: number) => `<group><index>${k}</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>${k}</index></channel></group>`
  return [
    '<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE xmeml>', '<xmeml version="5">', '<sequence id="sequence-1">',
    `<name>${esc(opts.name)}</name>`, `<duration>${fr(tlDuration(tl))}</duration>`, seq, '<media>', '<video>',
    `<format><samplecharacteristics>${seq}<width>${opts.w}</width><height>${opts.h}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`,
    ...video.flatMap(({ t, items }) => ['<track>', ...seqOf(items, false), `<enabled>${on(!t.hide)}</enabled><locked>FALSE</locked></track>`]), '</video>',
    '<audio>', '<numOutputChannels>2</numOutputChannels>', '<format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>',
    `<outputs>${group(1)}${group(2)}</outputs>`,
    ...pairs.flatMap((p) => ([1, 2] as const).flatMap((k) => [`<track currentExplodedTrackIndex="${k - 1}" totalExplodedTrackCount="2" premiereTrackType="Stereo">`,
      ...seqOf(k === 1 ? p.l : p.r, true), `<enabled>${on(p.enabled)}</enabled><locked>FALSE</locked><outputchannelindex>${k}</outputchannelindex></track>`])),
    '</audio>', '</media>',
    `<timecode>${seq}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    ...[...(tl.markers ?? [])].sort((a, b) => a.t - b.t).map((m) => `<marker><comment></comment><name>${esc(m.name)}</name><in>${fr(m.t)}</in><out>-1</out></marker>`),
    '</sequence>', '</xmeml>', '',
  ].join('\n')
}
