// Video-Export (mp4, clips): Clip-Folien als Jump Cuts mit Hook und Untertiteln, andere Folien als Standbild. Alles über ffmpeg, ohne Browser-Compositing.
// Filterketten und ASS-Untertitel angelehnt an BridgeClip (MIT, © 2026 BridgeMind).
// Ablauf: Szenen als Zwischenstände (mkv, PCM-Ton), je Ausgabedatei ein Endschritt (concat-Demuxer, Video kopiert, Ton einmal AAC + loudnorm + Musik).
// Electron-Teile (renderSlide, nativeImage, Schriften) lädt erst exportVideo: assSubs, clipSegs, encodeCover, finish und encodeClip laufen im Selbsttest unter Node.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { MEDIA_EXT, sizeOf, transitionOf, type Deck, type Size } from '../shared/deck'
import { resolveTheme } from '../shared/themes'
import { snapToWords } from '../shared/clip-lint'
import { CUT, DUCK, FX, MAX_PARTS, MIN_PAUSE, OVERLAY_W, PAD, STILL, XFADE, clipSpans, joinOf, cutFrames, clipWords, cropRect, cues, fillerQuiet, outSize, partLen, partsLength, speedOf, tighten, type Captions, type ClipContent, type ClipStyle, type Cue, type Fit, type Overlay, type Part, type Pauses, type Quiet, type Transcript, snapToScenes, zoomOf, cutIndex } from '../shared/video'
import { HOOK_FADE, POP, cropFilter, hookBox, levelExpr, progressBar } from './video-fx'
import { ffmpegBin, probe, run, runFfmpeg, silences } from './ffmpeg'
import { phoneFfmpeg } from './phone-ffmpeg'
import { localAsset } from './sync'

export interface SubFont { name: string; files: Buffer[]; bold: boolean } // name = Family in der TTF; files landen in <Job-Ordner>/fonts (fontsdir)
export interface Seg { file: string; dur: number; music?: [number, number, number][] } // Zwischenstand (mkv), Länge in s, Musikpegel [von, bis, pegel] ab Seg-Anfang (nur parts mit music)
export interface Music { file: string; volume?: number } // absoluter Pfad, volume 0–1 (Standard 0,25)

// Teilstücke je ffmpeg-Aufruf: je Teilstück ein Input mit eigenem Decoder, und der Filtergraph steht in argv (Linux: max. 128 KiB je Argument).
// ponytail: bis zu 20 Decoder gleichzeitig (4K braucht viel RAM); Upgrade: nahtlose Teilstücke eines parts aus einem Input per trim/atrim
const GROUP = 20
const FADE = 0.4 // Übergang aus/in Schwarz (s)
// Weicher Schnitt: Überblendung in Bild und Ton (Dauer je Schnitt aus cutFrames in shared/video.ts); je Seite die halbe Blende Material über die Naht
// hinaus, die Mitte der Blende liegt auf der alten Naht, Länge und Untertitel bleiben gleich. Wo das nicht geht (Gruppengrenze, Bildwechsel, Videoende): Tonblende AFADE.
const AFADE = 0.08
// Alle Zwischenstände eines Exports mit denselben Video-Parametern, sonst passt -c:v copy beim Verbinden nicht
const video = (preset: string) => ['-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30']
const PCM = ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'] // AAC in Zwischenständen verschöbe den Ton an jeder concat-Naht (Priming: Lücke oder Versatz)
const AUDIO = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000']
const FAST = ['-movflags', '+faststart']
// Lautheit in zwei Durchgängen: messen, dann mit den Messwerten linear anwenden (exakt −14 LUFS, kein Pumpen); ohne Messung dynamisch in einem Durchgang.
// Zeitstempel danach aus der Sample-Zahl: loudnorm (intern 192 kHz) verschiebt sie am Ende, die Tonspur wirkte bis 0,07 s länger als das Bild
const NORM = 'loudnorm=I=-14:TP=-1.5:LRA=11'
const LOUD = `${NORM},aresample=48000,asetpts=N/SR/TB`
// ton 'klar': Brummen/Trittschall unter 80 Hz weg; afftdn moderat (12 dB, folgt dem Rauschen), kräftiger klingt Sprache blechern; arnndn bräuchte eine Modelldatei.
// Kompressor 3:1 ab −26 dBFS mit 15 ms Attack: gleicht leise und laute Sätze an, Silbenanfänge bleiben; ohne Makeup, die Lautheit setzt loudnorm. Dann Zischlaute dämpfen.
// ponytail: feste Schwelle; Upgrade: relativ zum gemessenen Sprachpegel
// afftdn verzögert um 1200 Samples (25 ms bei 48 kHz): hinten Stille anhängen, damit das Ende durchkommt, vorn die Verzögerung abschneiden – sonst läge der Ton je Gruppe hinter dem Bild
const SPEECH = 'apad=pad_len=1200,highpass=f=80,afftdn=nr=12:nf=-40:tn=1,acompressor=threshold=0.05:ratio=3:attack=15:release=150,deesser,atrim=start_sample=1200,asetpts=N/SR/TB'

/** x264-Preset für einen ganzen Export (Gesamtlänge in s): 1080p mit veryfast läuft auf schwachen Rechnern mit ~10 fps, darum über 10 min superfast. */
export const presetFor = (seconds: number) => (seconds > 600 ? 'superfast' : 'veryfast')

const n2 = (i: number) => String(i).padStart(2, '0')
const sec = (s: number) => s.toFixed(3)

// ASS-Zeit H:MM:SS.cc
const at = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100))
  return `${Math.floor(cs / 360000)}:${n2(Math.floor(cs / 6000) % 60)}:${n2(Math.floor(cs / 100) % 60)}.${n2(cs % 100)}`
}
// Backslash als Vollbreiten-Zeichen (ASS kennt kein Escape dafür), Klammern per \{ \} (libass), Zeilenumbruch als \N (auch ein einzelnes \r, libass bricht dort um)
const esc = (s: string) => s.replace(/\\/g, '＼').replace(/[{}]/g, (c) => `\\${c}`).replace(/\r\n|\r|\n/g, '\\N')

// ASS-Farbe &HBBGGRR&. Dunkle Akzente (z. B. Petrol) gingen auf Video neben der dunklen Kontur unter → halb Richtung Weiß.
function assColor(hex: string) {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0)
  if (0.2126 * r + 0.7152 * g + 0.0722 * b < 110) [r, g, b] = [r, g, b].map((v) => Math.round((v + 255) / 2))
  return `&H${[b, g, r].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}&`
}

/** Untertitel-Datei: Hook oben linksbündig, Untertitel unten mittig, Lage nach Format. Hochformat (9:16): bei 33 % der Höhe, über der Plattform-Leiste
 *  (Reels/TikTok verdecken unten ~35 %); 4:5 und 1:1: 12 %; Querformat: kleiner, 7 %. Weiß mit dünner Kontur und Schatten, keine Kästen, kein Pop.
 *  style 'lebendig': Wort-Pop, Hook mit Einblendung auf dunklem Balken, Fortschrittsbalken (bar: Lage der Gruppe in der Szene, s). */
export function assSubs(o: { size: Size; font: string; bold: boolean; accent: string; hook?: string; hookDur: number; cues: Cue[]; mode: Captions; style?: ClipStyle; bar?: { off: number; dur: number; total: number }; overlays?: { start: number; end: number; text: string; pos?: Overlay['pos']; fade?: [boolean, boolean] }[] }): string {
  const { w, h } = o.size, m = Math.min(w, h), line = Math.max(1, Math.round(m * 0.002)), wide = w > h, wort = o.mode === 'wort', live = o.style === 'lebendig'
  const hookV = h * (wide ? 0.07 : 0.12), capV = capMargin(o.size)
  const style = (name: string, size: number, align: number, marginV: number) =>
    `Style: ${name},${o.font},${Math.round(size)},&H00FFFFFF,&H00FFFFFF,&H40000000,&H80000000,${o.bold ? -1 : 0},0,0,0,100,100,0,0,1,${line},${line},${align},${Math.round(w * 0.08)},${Math.round(w * 0.08)},${Math.round(marginV)},1`
  const dlg = (start: number, end: number, st: string, text: string) => `Dialogue: 0,${at(start)},${at(end)},${st},,0,0,0,,${text}`
  const events: string[] = [], bar = live && o.bar ? progressBar(o.size, assColor(o.accent), o.bar, at) : null
  if (bar) events.push(bar.event) // zuerst: liegt unter den Untertiteln
  if (o.hook?.trim()) events.push(live ? dlg(0, o.hookDur, 'HookBox', HOOK_FADE + esc(o.hook.trim())) : dlg(0, o.hookDur, 'Hook', esc(o.hook.trim())))
  if (o.mode === 'satz') for (const c of o.cues) events.push(dlg(c.start, c.end, 'Cap', c.words.map((x) => esc(x.w)).join(' ')))
  if (wort) {
    const accent = assColor(o.accent)
    // Ein Dialogue je Wortzustand: das gesprochene Wort in Akzentfarbe, der Rest des Häppchens weiß
    for (const c of o.cues) c.words.forEach((x, k) => {
      const text = c.words.map((y, j) => (j === k ? `{\\c${accent}${live ? POP : ''}}${esc(y.w)}{\\r}` : esc(y.w))).join(' ')
      events.push(dlg(k ? x.start : c.start, k < c.words.length - 1 ? c.words[k + 1].start : c.end, 'Cap', text))
    })
  }
  // Einblendungen: Style je Lage (ASS-Alignment), unten über der Untertitelzeile, oben auf Höhe des Hooks; blenden wie der Hook, nur an echten Enden (fade: [ein, aus])
  const ovs = (o.overlays ?? []).map((x) => ({ ...x, al: OV_ALIGN[x.pos ?? 'unten'] }))
  for (const x of ovs) events.push(dlg(x.start, x.end, `Ov${x.al}`, `{\\fad(${x.fade?.[0] === false ? 0 : FX.hookFadeMs},${x.fade?.[1] === false ? 0 : FX.hookFadeMs})}` + esc(x.text.trim())))
  const hookStyle = style('Hook', m * (wide ? 0.045 : 0.06), 7, hookV)
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    live ? hookBox(hookStyle, Math.round(m * 0.012)) : hookStyle,
    style('Cap', m * (wort ? (wide ? 0.065 : 0.075) : 0.055), 2, capV),
    ...(bar ? [bar.style] : []),
    ...[...new Set(ovs.map((x) => x.al))].map((al) => style(`Ov${al}`, m * 0.05, al, al === 2 ? capV + m * 0.16 : hookV)),
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events, '',
  ].join('\n')
}

// Abstand der Untertitelzeile von unten (ASS MarginV): Querformat 7 %, 9:16 33 % (über der Plattform-Leiste), sonst 12 %
const capMargin = ({ w, h }: Size) => h * (w > h ? 0.07 : h / w >= 1.6 ? 0.33 : 0.12)
const OV_ALIGN = { oben: 8, mitte: 5, unten: 2, 'oben-links': 7, 'oben-rechts': 9 } as const
// atempo je Instanz nur 0,5–2: Kette, z. B. 0,25 = 0,5 · 0,5
const atempo = (sp: number): string[] => (sp > 2 ? ['atempo=2', ...atempo(sp / 2)] : sp < 0.5 ? ['atempo=0.5', ...atempo(sp / 0.5)] : sp === 1 ? [] : [`atempo=${sp}`])

/** parts um PAD verlängern, aber nur bis zur Mitte der Lücke zum nächsten part im Quellvideo (keine Doppelung), nicht über das Video hinaus
 *  und nicht über einen harten Bildwechsel (cuts), sonst holte das Polster das Blitzbild der Nachbarszene zurück. */
export function padParts(parts: Part[], duration: number, cuts: number[] = []): Part[] {
  return parts.map((p) => {
    let start = Math.max(0, p.start - PAD), end = Math.min(duration, p.end + PAD)
    for (const q of parts) {
      if (q === p) continue
      if (q.end <= p.start) start = Math.max(start, (q.end + p.start) / 2)
      if (q.start >= p.end) end = Math.min(end, (p.end + q.start) / 2)
    }
    for (const c of cuts) {
      if (c > start && c <= p.start) start = c
      if (c >= p.end && c < end) end = c
    }
    return { ...p, start, end }
  })
}

/** Kanten, die mitten in einem Wort liegen, auf die Wortgrenze legen (höchstens 0,4 s); nur der Export, das Deck bleibt. Ohne Transkript oder echte Wortzeiten unverändert. */
export function snapParts(parts: Part[], t: Transcript | null): { parts: Part[]; moved: number } {
  if (!t) return { parts, moved: 0 }
  const r = snapToWords(parts, t, 0.4)
  return { parts: r.parts, moved: r.moved.length }
}

/** Schnitte, an denen das Quellvideo nahtlos weiterläuft (part i beginnt, wo part i−1 endet): dort kein Fade, sonst sinkt der Pegel mitten im Satz. */
export const seamless = (parts: Part[]) => parts.map((p, i) => i > 0 && Math.abs(parts[i - 1].end - p.start) < 1e-3)

// Leere oder verdrehte parts vor ffmpeg abfangen, dessen Filtergraph-Fehler versteht niemand
function checkParts(parts: Part[] | undefined, where: string) {
  if (!parts?.length) throw new Error(`${where}: Der Clip hat keine Ausschnitte (parts).`)
  const bad = parts.findIndex((p) => !(p.end > p.start))
  if (bad >= 0) throw new Error(`${where}: Ausschnitt ${bad + 1} endet nicht nach seinem Anfang (start ${parts[bad].start} s, end ${parts[bad].end} s).`)
  // Obergrenze gegen fremde deck.json; nahtlose Stücke zählen nicht extra (follow teilt Ausschnitte an Sprecherwechseln)
  const n = seamless(parts).filter((j) => !j).length
  if (n > MAX_PARTS) throw new Error(`${where}: Der Clip hat ${n} Ausschnitte, höchstens ${MAX_PARTS} gehen. Bitte zusammenfassen oder auf mehrere Clip-Folien verteilen.`)
}

export interface ClipJob { file: string; parts: Part[]; hook?: string; captions: Captions; transcript: Transcript | null; size: Size; font: SubFont; accent: string; loudnorm?: boolean; pauses?: Pauses; fit?: Fit; style?: ClipStyle; cuts?: number[]; ton?: ClipContent['ton']; overlays?: Overlay[] } // overlays: image als aufgelöster Pfad
/** Handy für die Clip-Gruppen (phone-ffmpeg.ts); failed: einmal gescheitert, rechnet für den Rest des Exports der PC */
export interface Phone { serial: string; models: string; failed?: boolean }
/** Warum das Handy im laufenden Export ausgestiegen ist (leer = nicht): die App verwirft console-Ausgaben, so sehen KI und Arbeitsansicht den Grund */
export const phoneFault = { reason: '' }
interface SegOpts { preset: string; fadeIn?: boolean; fadeOut?: boolean; phone?: Phone } // fadeIn/fadeOut: Übergang aus/in Schwarz am Anfang/Ende der Szene

/** Eine Clip-Szene als Zwischenstände, je GROUP Teilstücke ein mkv: Zuschnitt (crop um focus oder blur), Hook nur in der ersten Gruppe, Untertitel je Gruppe ab 0. Fortschritt über alle Gruppen. */
export async function clipSegs(job: ClipJob, name: string, dir: string, o: SegOpts, onProgress?: (pct: number) => void): Promise<Seg[]> {
  checkParts(job.parts, basename(job.file))
  const info = await probe(job.file)
  const late = job.parts.findIndex((p) => p.start >= info.duration - 0.2)
  if (late >= 0) throw new Error(`Ausschnitt ${late + 1} beginnt bei ${job.parts[late].start} s, das Video ist nur ${info.duration.toFixed(1)} s lang.`)
  // Pausen und Füllwörter kürzen vor padParts: an jedem Schnitt bleibt je Seite PAD stehen, ohne dass sich etwas doppelt. fillerQuiet nimmt nur echte Wortzeiten.
  const words = snapParts(job.parts, job.transcript)
  // Wortgrenzen können eine Kante wieder vor einen Bildwechsel ziehen (Transkript beim Einrasten in prepareClips noch nicht im Cache): erneut einrasten, jetzt mit Wortschutz
  const snapped = job.cuts?.length ? { ...words, parts: snapToScenes(words.parts, job.cuts, job.transcript).parts } : words
  if (snapped.moved) console.info(`[video] ${basename(job.file)}: ${snapped.moved} Schnittkante(n) an die Wortgrenze gelegt`)
  const quiet: Quiet[] = []
  if (job.pauses === 'kurz' && info.audio) for (const p of snapped.parts) {
    quiet.push(...(await silences(job.file, p.start, p.end, MIN_PAUSE)))
    if (job.transcript) quiet.push(...fillerQuiet(job.transcript, p.start, p.end))
  }
  // Übergang nur am ersten Stück eines geteilten parts: an gekürzten Pausen bleibt die übliche Blende
  const parts = padParts(snapped.parts.flatMap((p) => tighten([p], quiet).map((q, j) => (j && q.transition ? { ...q, transition: undefined } : q))), info.duration, job.cuts), joined = seamless(parts), total = partsLength(parts), { size } = job
  const blur = job.fit === 'blur' && Math.abs(info.w / info.h - size.w / size.h) > 0.01 // gleiches Seitenverhältnis: blur = crop
  const [bw, bh] = [size.w, size.h].map((v) => Math.max(2, Math.round(v / 24) * 2)) // Grund klein weichzeichnen, dann hochskalieren: billig und weich
  const captions = job.transcript && job.captions !== 'aus' ? job.captions : null
  const live = job.style === 'lebendig'
  if (job.hook?.trim() || captions || live || job.overlays?.some((x) => x.text?.trim())) {
    // Eigener Unterordner: libass lädt alles in fontsdir, auch fertige Szenen. Relativ zu cwd = dir: kein Pfad-Escaping im Filter.
    await mkdir(join(dir, 'fonts'), { recursive: true })
    await Promise.all(job.font.files.map((b, i) => writeFile(join(dir, 'fonts', `font-${i}.ttf`), b)))
  }
  const segs: Seg[] = []
  let done = 0
  for (let k0 = 0; k0 < parts.length; k0 += GROUP) {
    const ps = parts.slice(k0, k0 + GROUP), dur = partsLength(ps), first = !k0, last = k0 + GROUP >= parts.length
    const id = `${name}-${n2(segs.length + 1)}`, hook = first ? job.hook?.trim() : undefined
    const words = captions ? clipWords(job.transcript!, ps, quiet) : []
    // Einblendungen je sichtbarem Stück der Quelle über alle parts, auf die Gruppe (ab 0) beschnitten; Blende nur an echten Enden, nicht an Gruppenkanten
    const ovs = (job.overlays ?? []).flatMap((x) => clipSpans(parts, x.start, x.end).filter(([a, b]) => b > done && a < done + dur)
      .map(([a, b]) => ({ ...x, a: Math.max(0, a - done), b: Math.min(dur, b - done), fade: [a >= done - 1e-3, b <= done + dur + 1e-3] as [boolean, boolean] })))
    const texts = ovs.filter((x) => x.text?.trim()).map((x) => ({ start: x.a, end: x.b, text: x.text!, pos: x.pos, fade: x.fade })), imgs = ovs.filter((x) => x.image)
    const subs = !!hook || words.length > 0 || live || texts.length > 0
    if (subs) await writeFile(join(dir, `${id}.ass`), assSubs({ size, font: job.font.name, bold: job.font.bold, accent: job.accent, hook, hookDur: Math.min(4, dur), cues: captions && words.length ? cues(words, captions) : [], mode: job.captions, style: job.style, bar: { off: done, dur, total }, ...(texts.length ? { overlays: texts } : {}) }))
    // Überblendung je Naht i (zwischen ps[i-1] und ps[i]): halbe Länge in Frames, begrenzt durch Videoanfang/-ende und harte Bildwechsel (cuts)
    const room = (s: number, dir: 1 | -1) => Math.min(dir > 0 ? info.duration - s : s, ...(job.cuts ?? []).map((c) => (c - s) * dir).filter((d) => d > -1e-6))
    // Frames je Ausschnitt aus den aufsummierten Nahtzeiten, nicht je Ausschnitt abgerundet: so laufen Bild, Ton und Untertitel nicht auseinander
    // Zeiten auf der Clip-Achse (Quelllänge durch Tempo); Vorlauf/Nachlauf in der Quelle = Frames/30 · Tempo
    const at = ps.reduce<number[]>((s, p) => [...s, s[s.length - 1] + partLen(p)], [0]), sp = ps.map(speedOf), fr = (t: number) => Math.round(t * 30)
    const own = (i: number) => fr(at[i + 1]) - fr(at[i]) // Frames ohne Überblendung; zwei Blenden eines Ausschnitts dürfen sich nicht überlappen
    // je Naht i: Bild hv Frames je Seite (nach Art des Schnitts, eigener Übergang CUT.momentFrames, none hart), Ton ha ≤ CUT.jumpFrames/2; jede Naht zieht nur ihre eigene Überlappung ab, Bild und Ton bleiben gleich lang
    const blend = (p: Part, gap: number) => (p.transition === 'none' ? 0 : XFADE[p.transition ?? ''] ? CUT.momentFrames : cutFrames(gap))
    const hv = ps.map((p, i) => (i === 0 || joined[k0 + i] ? 0
      : Math.max(0, Math.min(Math.floor(blend(p, p.start - ps[i - 1].end) / 2), Math.floor(own(i - 1) / 2), Math.floor(own(i) / 2), Math.floor((room(ps[i - 1].end, 1) * 30) / sp[i - 1]), Math.floor((room(p.start, -1) * 30) / sp[i])))))
    const ha = hv.map((h) => Math.min(h, CUT.jumpFrames / 2))
    const graph = ps.map((p, i) => {
      const before = (hv[i] ?? 0) / 30, frames = own(i) + (hv[i] ?? 0) + (hv[i + 1] ?? 0), a0 = (ha[i] ?? 0) / 30
      const c = cropRect(info, size, p.focus), len = partLen(p) + a0 + (ha[i + 1] ?? 0) / 30, k = k0 + i // len: Ton (Clip-Zeit)
      const fit = blur
        ? `split[b${i}][f${i}];[b${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=4,lutyuv=y=val*0.55,scale=${size.w}:${size.h}[g${i}];` +
          `[f${i}]scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease:force_divisible_by=2[h${i}];[g${i}][h${i}]overlay=(W-w)/2:(H-h)/2`
        : cropFilter(c, size, job.fit === 'blur' ? 1 : zoomOf(job.style, cutIndex(parts, k)), p.track ? { src: info, keys: p.track, start: p.start - before * sp[i] } : undefined) // k über alle Gruppen; start = Anfang der Eingabe (mit Vorlauf); Zoom wechselt nur an echten Schnitten, nie bei blur
      // Ton ab p.start − a0: die Eingabe beginnt beim längeren Bild-Vorlauf (before)
      // Tempo nach dem Zuschnitt im Quellbereich, dann Lautstärke des Originaltons
      const vol = p.volume !== undefined && p.volume !== 1 ? `volume=${Math.min(2, Math.max(0, p.volume))},` : ''
      const a = info.audio ? `[${i}:a]atrim=start=${sec((before - a0) * sp[i])}:duration=${sec(len * sp[i])},asetpts=PTS-STARTPTS,${atempo(sp[i]).map((x) => `${x},`).join('')}${vol}` : `anullsrc=r=48000:cl=stereo,atrim=duration=${sec(len)},`
      // Tonblende nur an Kanten ohne Überblendung; nahtlose Kanten bleiben unberührt
      const fade = `${joined[k] || ha[i] ? '' : `,afade=t=in:d=${AFADE}`}${joined[k + 1] || ha[i + 1] ? '' : `,afade=t=out:st=${sec(Math.max(0, len - AFADE))}:d=${AFADE}`}`
      // Tempo: Zuschnitt (Kamerafahrt in Quellzeit) vor dem Umrechnen der Zeitstempel; ohne Tempo die alte Reihenfolge
      const v = sp[i] === 1 ? `[${i}:v]setpts=PTS-STARTPTS,fps=30,trim=end_frame=${frames},${fit},` : `[${i}:v]setpts=PTS-STARTPTS,${fit},setpts=PTS/${sp[i]},fps=30,trim=end_frame=${frames},`
      return `${v}setsar=1,format=yuv420p[v${i}];` +
        `${a}aformat=sample_rates=48000:channel_layouts=stereo${fade}[a${i}]`
    })
    // Bild und Ton getrennt verketten: an Nähten mit Überblendung xfade/acrossfade, sonst concat; offset = bisherige Frames minus Blende.
    // concat liefert die Zeitbasis 1/1000000, xfade verlangt bei beiden Eingängen dieselbe: darum settb zurück auf 1/30.
    // offset einen halben Frame vor der ersten Blendfläche: xfade beginnt beim ersten Frame mit pts ≥ offset, sec() rundet auf 1 ms
    let cv = '[v0]', ca = '[a0]', n = own(0) + (hv[1] ?? 0)
    for (let i = 1; i < ps.length; i++) {
      const h = hv[i], g = ha[i], frames = own(i) + h + (hv[i + 1] ?? 0)
      graph.push(h ? `${cv}[v${i}]xfade=transition=${XFADE[ps[i].transition ?? ''] ?? 'fade'}:duration=${sec((2 * h) / 30)}:offset=${sec((n - 2 * h - 0.5) / 30)}[xv${i}]` : `${cv}[v${i}]concat=n=2:v=1:a=0,settb=1/30[xv${i}]`,
        g ? `${ca}[a${i}]acrossfade=d=${sec((2 * g) / 30)}[xa${i}]` : `${ca}[a${i}]concat=n=2:v=0:a=1[xa${i}]`)
      cv = `[xv${i}]`; ca = `[xa${i}]`; n += frames - 2 * h
    }
    // Bild-Einblendungen vor den Untertiteln (die liegen oben): je Stück ein Input ab 0, weich per Alpha-Blende, Rand 4 % der Breite
    const r4 = Math.round(size.w * 0.04), low = Math.round(capMargin(size) + Math.min(size.w, size.h) * 0.16) // unten: über der Untertitelzeile wie der Text
    imgs.forEach((x, j) => {
      const d = sec(Math.min(0.2, (x.b - x.a) / 2)), pos = x.pos ?? 'unten'
      const ox = pos === 'oben-links' ? r4 : pos === 'oben-rechts' ? `W-w-${r4}` : '(W-w)/2', oy = pos.startsWith('oben') ? r4 : pos === 'mitte' ? '(H-h)/2' : `H-h-${low}`
      graph.push(`[${ps.length + j}:v]scale=${Math.round(OVERLAY_W[x.size ?? 'mittel'] * size.w)}:-1,format=rgba${x.fade[0] ? `,fade=t=in:st=${sec(x.a)}:d=${d}:alpha=1` : ''}${x.fade[1] ? `,fade=t=out:st=${sec(x.b - Number(d))}:d=${d}:alpha=1` : ''}[o${j}]`,
        `${cv}[o${j}]overlay=${ox}:${oy}:enable='between(t,${sec(x.a)},${sec(x.b)})'[ov${j}]`)
      cv = `[ov${j}]`
    })
    const vf = [subs && `ass=${id}.ass:fontsdir=fonts`, o.fadeIn && first && `fade=t=in:d=${FADE}`, o.fadeOut && last && `fade=t=out:st=${sec(Math.max(0, dur - FADE))}:d=${FADE}`]
    // Sprachkette nach dem concat: Entrauschen lernt über die ganze Gruppe; vor den Szenen-Blenden, sonst höbe der Kompressor sie an
    const af = [job.ton === 'klar' && info.audio && SPEECH, o.fadeIn && first && `afade=t=in:d=${FADE}`, o.fadeOut && last && `afade=t=out:st=${sec(Math.max(0, dur - FADE))}:d=${FADE}`]
    graph.push(`${cv}${vf.filter(Boolean).join(',') || 'null'}[v]`, `${ca}${af.filter(Boolean).join(',') || 'anull'}[a]`)
    // je Ausschnitt mit Vorlauf für die Überblendung; 0,1 s Reserve, damit trim die Frames sicher bekommt (atrim schneidet den Ton genau)
    const inputs = [...ps.flatMap((p, i) => ['-ss', sec(p.start - ((hv[i] ?? 0) / 30) * sp[i]), '-t', sec(p.end - p.start + (((hv[i] ?? 0) + (hv[i + 1] ?? 0)) / 30) * sp[i] + 0.1 * Math.max(1, sp[i])), '-i', job.file]), // Reserve 0,1 s Clip-Zeit auch bei Zeitraffer
      ...imgs.flatMap((x) => ['-loop', '1', '-framerate', '30', '-t', sec(x.b), '-i', x.image!])]
    const file = join(dir, `${id}.mkv`)
    const args = [...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', '-map', '[a]', ...video(o.preset), ...PCM, file]
    const ro = { cwd: dir, duration: dur, onProgress: onProgress && ((pct: number) => onProgress(Math.floor(((done + (dur * pct) / 100) / total) * 100))) }
    // Gruppe auf dem Handy, wenn eins mitrechnet (gleiche Parameter: -c:v copy beim Verbinden passt weiter); scheitert es, rechnet der PC
    const phone = o.phone && !o.phone.failed ? o.phone : undefined
    await (phone ? phoneFfmpeg(phone.serial, args, { ...ro, models: phone.models }).catch((e: Error) => {
      console.warn('[video] Export auf dem Handy fehlgeschlagen, der PC rechnet weiter:', e.message)
      phone.failed = true
      phoneFault.reason = e.message.trim().split('\n').slice(-1)[0].slice(0, 160)
      return runFfmpeg(args, ro)
    }) : runFfmpeg(args, ro))
    const music = ps.flatMap((p, i): [number, number, number][] => (p.music === undefined ? [] : [[at[i], at[i + 1], p.music]]))
    segs.push({ file, dur, ...(music.length ? { music } : {}) })
    done += dur
  }
  return segs
}

/** Titelbild (JPEG in Ausgabegröße) bei Quellsekunde t (Standard: Mitte des ersten parts): Zuschnitt wie der Clip, Hook eingebrannt, ohne Einblendung und Balken. */
export async function encodeCover(job: ClipJob, t: number | undefined, out: string, dir: string) {
  const info = await probe(job.file), p0 = job.parts[0]
  const at = Math.min(Math.max(0, t ?? (p0.start + p0.end) / 2), Math.max(0, info.duration - 0.1))
  const p = job.parts.find((x) => at >= x.start && at <= x.end) ?? p0
  // Kamerafahrt: focus linear zwischen den Stützpunkten, davor und danach konstant (wie cropFilter)
  const k = p.track?.findIndex(([kt]) => kt > at) ?? -1, tr = p.track
  const focus = !tr?.length ? p.focus : k < 0 ? tr[tr.length - 1][1] : k === 0 ? tr[0][1] : tr[k - 1][1] + ((tr[k][1] - tr[k - 1][1]) * (at - tr[k - 1][0])) / (tr[k][0] - tr[k - 1][0])
  const { size } = job, hook = job.hook?.trim(), name = basename(out).replace(/\.\w+$/, '')
  const [bw, bh] = [size.w, size.h].map((v) => Math.max(2, Math.round(v / 24) * 2))
  const fit = job.fit === 'blur' && Math.abs(info.w / info.h - size.w / size.h) > 0.01
    ? `split[b][f];[b]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=4,lutyuv=y=val*0.55,scale=${size.w}:${size.h}[g];` +
      `[f]scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease:force_divisible_by=2[h];[g][h]overlay=(W-w)/2:(H-h)/2`
    : cropFilter(cropRect(info, size, focus), size)
  if (hook) {
    await mkdir(join(dir, 'fonts'), { recursive: true })
    await Promise.all(job.font.files.map((b, i) => writeFile(join(dir, 'fonts', `font-${i}.ttf`), b)))
    // Einblendung weg: das Standbild läge sonst im Moment ganz durchsichtig
    await writeFile(join(dir, `${name}.ass`), assSubs({ size, font: job.font.name, bold: job.font.bold, accent: job.accent, hook, hookDur: 1, cues: [], mode: 'aus', style: job.style }).replace(HOOK_FADE, ''))
  }
  await runFfmpeg(['-ss', sec(at), '-i', job.file, '-frames:v', '1', '-update', '1', '-vf', `${fit},setsar=1${hook ? `,ass=${name}.ass:fontsdir=fonts` : ''}`, '-q:v', '2', out], { cwd: dir })
}

/** Standbild (PNG in Ausgabegröße) als Zwischenstand von STILL Sekunden mit stillem Ton, gleiche Video-Parameter wie die Clips. */
export async function encodeStill(png: string, out: string, dir: string, o: SegOpts, onProgress?: (pct: number) => void): Promise<Seg> {
  const vf = ['setsar=1', o.fadeIn && `fade=t=in:d=${FADE}`, o.fadeOut && `fade=t=out:st=${STILL - FADE}:d=${FADE}`].filter(Boolean).join(',')
  await runFfmpeg(['-loop', '1', '-framerate', '30', '-t', String(STILL), '-i', png, '-f', 'lavfi', '-t', String(STILL), '-i', 'anullsrc=r=48000:cl=stereo', '-vf', vf, ...video(o.preset), ...PCM, out], { cwd: dir, duration: STILL, onProgress })
  return { file: out, dur: STILL }
}

/** Endschritt je Ausgabedatei: Zwischenstände (alle in dir) per concat-Demuxer verbinden, Video kopiert, Ton einmal AAC.
 *  Musik läuft in Schleife über die ganze Länge (1 s Ein-, 2 s Ausblende) und weicht der Sprache (Sidechain-Kompressor), danach loudnorm. */
export async function finish(segs: Seg[], out: string, dir: string, o: { loudnorm?: boolean; music?: Music; onProgress?: (pct: number) => void } = {}) {
  const dur = segs.reduce((s, x) => s + x.dur, 0), list = `${basename(out)}.txt`
  await writeFile(join(dir, list), segs.map((s) => `file '${basename(s.file)}'`).join('\n'))
  // sidechaincompress endet mit dem ersten Eingang, der endet, und verwirft, was der andere noch hat: Musik darum endlos hinein, Länge gibt die Sprache vor.
  // Schwelle 0,006 statt 0,03: leise Handy-Sprache (−31 dBFS RMS) drückt die Musik sonst kaum (gemessen 11 dB statt 1 dB). ponytail: feste Schwelle; Upgrade: relativ zum gemessenen Sprachpegel
  // Musikpegel je Ausschnitt (Seg.music): Lautstärke als Ausdruck über die Zeit, sonst feste Zahl
  let off = 0
  const spans = segs.flatMap((x) => { const r = (x.music ?? []).map(([a, b, v]): [number, number, number] => [off + a, off + b, Math.min(1, Math.max(0, v))]); off += x.dur; return r })
  const vol = Math.min(1, Math.max(0, o.music?.volume ?? DUCK.volume))
  const graph = (loud: string) => o.music
    ? `[0:a]asplit[s][k];[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${spans.length ? `${levelExpr(vol, spans)}:eval=frame` : vol},afade=t=in:d=${DUCK.fadeIn}[m];` +
      `[m][k]sidechaincompress=threshold=${DUCK.threshold}:ratio=${DUCK.ratio}:attack=${DUCK.attackMs}:release=${DUCK.releaseMs},afade=t=out:st=${sec(Math.max(0, dur - DUCK.fadeOut))}:d=${DUCK.fadeOut}[d];[s][d]amix=inputs=2:normalize=0:duration=first${loud}[a]`
    : `[0:a]anull${loud}[a]`
  const music = o.music ? ['-stream_loop', '-1', '-i', resolve(o.music.file)] : []
  const input = ['-f', 'concat', '-safe', '0', '-i', list, ...music]
  let loud = ''
  if (o.loudnorm) {
    // Messlauf nur über den Ton (schnell); fällt er aus oder ist alles still (-inf), bleibt es beim dynamischen Durchgang
    const err = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', ...input, '-filter_complex', graph(`,${NORM}:print_format=json`), '-map', '[a]', '-f', 'null', '-'], { cwd: dir })
      .then((r) => (r.code === 0 ? r.err : ''), () => '')
    const v = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'].map((k) => Number(new RegExp(`"${k}" : "([^"]+)"`).exec(err)?.[1])) // "-inf" → NaN
    loud = v.every(Number.isFinite)
      ? `,${NORM}:measured_I=${v[0]}:measured_TP=${v[1]}:measured_LRA=${v[2]}:measured_thresh=${v[3]}:offset=${v[4]}:linear=true,aresample=48000,asetpts=N/SR/TB`
      : `,${LOUD}`
  }
  await runFfmpeg([...input, '-filter_complex', graph(loud), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...AUDIO, ...FAST, out], { cwd: dir, duration: dur, onProgress: o.onProgress })
}

/** Folienübergang im mp4: letzten Zwischenstand der Szene davor und ersten der Szene (beide in dir) per xfade (ffmpeg-Typ) und acrossfade zu einem neuen
 *  verbinden, Blende 0,5 s (höchstens die halbe Länge eines der beiden); Länge = Summe − Blende, Musikpegel des zweiten rücken mit. */
// ponytail: kodiert beide Nahtstücke ganz neu (bis GROUP parts), ohne Fortschritt und immer auf dem PC; Upgrade: nur die Blende neu kodieren und den Rest kopieren
export async function joinSegs(a: Seg, b: Seg, transition: string, out: string, dir: string, preset: string): Promise<Seg> {
  const fa = Math.round(a.dur * 30), d = Math.max(1, Math.min(15, Math.floor(fa / 2), Math.floor(Math.round(b.dur * 30) / 2))), off = (fa - d) / 30
  // offset einen halben Frame vor der Blende wie in clipSegs
  await runFfmpeg(['-i', basename(a.file), '-i', basename(b.file), '-filter_complex', `[0:v][1:v]xfade=transition=${transition}:duration=${sec(d / 30)}:offset=${sec((fa - d - 0.5) / 30)}[v];[0:a][1:a]acrossfade=d=${sec(d / 30)}[a]`,
    '-map', '[v]', '-map', '[a]', ...video(preset), ...PCM, out], { cwd: dir })
  const music = [...(a.music ?? []), ...(b.music ?? []).map(([x, y, v]): [number, number, number] => [x + off, y + off, v])]
  return { file: out, dur: a.dur + b.dur - d / 30, ...(music.length ? { music } : {}) }
}

/** Eine Clip-Szene fertig als MP4 (Zwischenstände + Endschritt). Gibt die Länge (s) zurück. */
export async function encodeClip(job: ClipJob, out: string, dir: string, onProgress?: (pct: number) => void, music?: Music): Promise<number> {
  const segs = await clipSegs(job, basename(out).replace(/\.\w+$/, ''), dir, { preset: presetFor(partsLength(job.parts ?? [])) }, onProgress && ((p) => onProgress(Math.floor(p * 0.9))))
  await finish(segs, out, dir, { loudnorm: job.loudnorm, music, onProgress: onProgress && ((p) => onProgress(90 + Math.floor(p / 10))) })
  return segs.reduce((s, x) => s + x.dur, 0)
}

// Head-Schrift des Themes als TTF (Premium- oder eigene Schrift), sonst Archivo Bold aus dem App-Paket. Buffer statt Pfad: im asar kann ffmpeg nicht lesen.
async function subFont(deck: Deck): Promise<SubFont> {
  const head = resolveTheme(deck.theme).head
  const f = (await import('./export-pptx')).fontsOf(deck).find((x) => x.family === head.pptx)
  if (f) return { name: f.family, files: [f.regular, ...(f.bold ? [f.bold] : [])], bold: !!f.bold }
  const { app } = await import('electron')
  return { name: 'Archivo', files: [await readFile(join(app.getAppPath(), 'assets/fonts/Archivo-Bold.ttf'))], bold: true }
}

// asset://local/<pfad> oder absoluter Pfad; auf einem anderen Gerät auf den lokalen Deckwerk-Ordner umleiten
function videoPath(src: string, slide: number, field = 'video') {
  const p = src.startsWith('asset://') ? decodeURIComponent(new URL(src).pathname) : src
  if (!isAbsolute(p)) throw new Error(`Folie ${slide}: „${field}“ muss ein asset://-Pfad oder ein absoluter Dateipfad sein.`)
  if (!MEDIA_EXT.test(p)) throw new Error(`Folie ${slide}: „${field}“ ist keine Mediendatei (${basename(p)}).`)
  return localAsset(p)
}

const MAX_SECONDS = 6 * 3600 // Material je Export
const STALE = 6 * 3600e3 // Job-Ordner älter als das (ms): Rest nach einem Absturz
let queue: Promise<unknown> = Promise.resolve()

/** Deck als Video: mp4 = alle Folien hintereinander in `${base}.mp4`, clips = je Clip-Folie `${base}-01.mp4` usw. Fortschritt 0–100 über alle Szenen.
 *  o.music: Hintergrundmusik (Pfad löst der Aufrufer auf), in jeder Ausgabedatei.
 *  Exporte laufen nacheinander: UI und KI-Tool export_deck können gleichzeitig starten, jeder öffnet bis zu GROUP Decoder. */
export function exportVideo(...a: Parameters<typeof exportOnce>): Promise<string[]> {
  const run = queue.then(() => exportOnce(...a))
  queue = run.catch(() => {})
  return run
}

async function exportOnce(deck: Deck, target: string, format: 'mp4' | 'clips', transcriptOf: (file: string) => Promise<Transcript | null>, onProgress: (pct: number) => void = () => {}, o: { music?: Music; phone?: Phone } = {}): Promise<string[]> {
  const base = resolve(target), parent = dirname(base)
  phoneFault.reason = ''
  // Job-Ordner abgestürzter Exporte wegräumen (mtime ändert sich mit jeder neuen Datei darin)
  await mkdir(parent, { recursive: true })
  for (const e of await readdir(parent, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('.video-tmp-')) continue
    const p = join(parent, e.name), st = await stat(p).catch(() => null)
    if (st && Date.now() - st.mtimeMs > STALE) await rm(p, { recursive: true, force: true })
  }
  const scenes = deck.slides.map((s, i) => ({ i, clip: s.layout === 'clip' ? (s.content as ClipContent) : undefined })).filter((x) => format === 'mp4' || x.clip)
  if (!scenes.length) throw new Error('Keine Clip-Folie im Deck: Einzelne Clips entstehen nur aus Folien mit dem Layout „clip“.')
  // Vorab prüfen, damit ein Fehler in Folie 5 nicht erst nach vier fertigen Szenen auffällt
  for (const { i, clip } of scenes) {
    if (!clip) continue
    if (!clip.video) throw new Error(`Folie ${i + 1}: Im Clip fehlt das Video. Erst ein Video anhängen und unter „video“ eintragen.`)
    videoPath(clip.video, i + 1)
    checkParts(clip.parts, `Folie ${i + 1}`)
    for (const x of clip.overlays ?? []) {
      const img = x.image && videoPath(x.image, i + 1, 'image')
      if (!img) continue
      if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(img)) throw new Error(`Folie ${i + 1}: Die Einblendung braucht ein Rasterbild (PNG, JPEG, WebP, BMP oder GIF), nicht ${basename(img)}.`)
      if (!(await stat(img).catch(() => null))) throw new Error(`Folie ${i + 1}: Das Bild der Einblendung fehlt (${basename(img)}).`)
    }
  }
  // Musik vorab einmal anspielen: probe() verlangt eine Videospur, und ffmpegs „Stream specifier [1:a]“ käme erst nach dem Encoden
  if (o.music) await runFfmpeg(['-v', 'error', '-i', resolve(o.music.file), '-map', '0:a:0', '-t', '0.1', '-f', 'null', '-']).catch((e: Error) => {
    throw new Error(`Die Musikdatei ${o.music!.file} ${/No such file/i.test(e.message) ? 'fehlt' : /matches no streams/i.test(e.message) ? 'hat keine Tonspur' : 'ist nicht lesbar'}.`)
  })
  const size = outSize(sizeOf(deck)), accent = resolveTheme(deck.theme).c.accent
  // Gewichte für den Fortschritt: Länge je Szene, dazu je Ausgabedatei der Endschritt (Video wird nur kopiert)
  const weights = scenes.map(({ clip }) => (clip ? partsLength(clip.parts) : STILL))
  const sum = weights.reduce((a, b) => a + b, 0), total = sum * 1.2, preset = presetFor(sum)
  if (sum > MAX_SECONDS) throw new Error(`Das Material ist zusammen ${(sum / 3600).toFixed(1)} h lang, ein Video-Export geht bis 6 h. Bitte Ausschnitte kürzen oder das Deck teilen.`)
  // Platz grob vorab (H.264 ~1,5 MB/s bei 1080p, PCM 0,19 MB/s, ×1,5 Reserve): sonst bricht ffmpeg erst nach Minuten am vollen Datenträger ab
  const need = sum * ((1.5e6 * size.w * size.h) / (1920 * 1080) + 0.19e6) * 1.5, fs = await statfs(parent), free = fs.bavail * fs.bsize
  if (free < need) throw new Error(`Zu wenig freier Speicherplatz für den Video-Export: nötig sind rund ${Math.ceil(need / 1e8) / 10} GB, frei ${Math.floor(free / 1e8) / 10} GB.`)
  let done = 0
  const step = (w: number) => (pct: number) => onProgress(Math.min(100, Math.floor(((done + (w * pct) / 100) / total) * 100)))
  // Übergang mit xfade-Typ (außer color): echte Überblendung, die Nahtstücke beider Szenen werden neu kodiert (joinSegs). Sonst ≠ none (morph = harter Schnitt):
  // Einblende aus Schwarz am Anfang der Folie, Abblende am Ende der Szene davor. Zwischentitel (Folien ohne Video) blenden immer: der harte Sprung auf ein Standbild wirkte abrupt (12.10.)
  const seam = (k: number) => (format === 'mp4' && k > 0 && k < scenes.length ? joinOf(transitionOf(deck, scenes[k].i), !scenes[k].clip || !scenes[k - 1].clip) : undefined)
  const xf = (k: number) => (seam(k) === 'blend' ? XFADE[transitionOf(deck, scenes[k].i)] : undefined)
  const fades = (k: number) => seam(k) === 'schwarz'
  const dir = join(parent, `.video-tmp-${randomBytes(4).toString('hex')}`) // nicht /tmp: tmpfs läuft bei langen Videos voll
  await mkdir(dir, { recursive: true })
  try {
    const font = scenes.some((x) => x.clip) ? await subFont(deck) : { name: 'Archivo', files: [], bold: true }
    const all: Seg[] = [], moves: [string, string][] = [] // erst im Job-Ordner, am Ende per rename: ein Abbruch lässt den letzten guten Export stehen
    // Titelbild (.jpg) und Post-Text (.txt) neben das MP4; ein Fehler beim Bild kostet nur das Bild
    const extras = async (name: string, to: string, cover?: { job: ClipJob; t?: number }, post?: string) => {
      if (cover) await encodeCover(cover.job, cover.t, join(dir, `${name}.jpg`), dir).then(
        () => moves.push([join(dir, `${name}.jpg`), `${to}.jpg`]), (e: Error) => console.warn(`[video] Titelbild ${basename(to)}.jpg fehlgeschlagen:`, e.message))
      if (post?.trim()) { await writeFile(join(dir, `${name}.txt`), post, 'utf8'); moves.push([join(dir, `${name}.txt`), `${to}.txt`]) }
    }
    const first: { cover?: { job: ClipJob; t?: number }; post?: string } = {} // mp4: Titelbild und Text der ersten Clip-Folie, die sie hat
    for (const [k, { i, clip }] of scenes.entries()) {
      const name = `szene-${n2(k + 1)}`, so: SegOpts = { preset, fadeIn: fades(k), fadeOut: fades(k + 1), phone: o.phone }
      let segs: Seg[], job: ClipJob | undefined
      if (clip) {
        const file = videoPath(clip.video, i + 1), captions = clip.captions ?? 'wort'
        const transcript = captions === 'aus' && clip.pauses !== 'kurz' ? null : await transcriptOf(file) // pauses kurz: Füllwörter aus dem Transkript
        if (!transcript && captions !== 'aus') console.warn(`[video] Kein Transkript für ${file}: Clip ohne Untertitel (erst transcribe_video aufrufen)`)
        const overlays = clip.overlays?.map((x) => (x.image ? { ...x, image: videoPath(x.image, i + 1, 'image') } : x))
        job = { file, parts: clip.parts, hook: clip.hook, captions, transcript, size, font, accent, pauses: clip.pauses, fit: clip.fit, style: clip.style, cuts: clip.cuts, ton: clip.ton, overlays }
        segs = await clipSegs(job, name, dir, so, step(weights[k]))
        if (!first.cover && clip.cover !== undefined) first.cover = { job, t: clip.cover }
        first.post ??= clip.post?.trim() ? clip.post : undefined
      } else {
        const [{ renderSlide }, { nativeImage }] = await Promise.all([import('./render'), import('electron')])
        const png = join(dir, `folie-${n2(k + 1)}.png`)
        await writeFile(png, nativeImage.createFromBuffer((await renderSlide(deck, i, { png: true })).png!).resize({ width: size.w, height: size.h, quality: 'best' }).toPNG())
        segs = [await encodeStill(png, join(dir, `${name}.mkv`), dir, so, step(weights[k]))]
      }
      done += weights[k]
      const t = xf(k)
      if (t) { // mp4: Nahtstücke zu einem verbinden, die beiden alten sofort weg
        const a = all.pop()!, b = segs[0]
        segs[0] = await joinSegs(a, b, t, join(dir, `${name}-x.mkv`), dir, preset)
        await Promise.all([a, b].map((x) => rm(x.file, { force: true })))
      }
      if (format === 'mp4') { all.push(...segs); continue }
      await finish(segs, join(dir, `${name}.mp4`), dir, { loudnorm: true, music: o.music, onProgress: step(weights[k] * 0.2) })
      await Promise.all(segs.map((x) => rm(x.file, { force: true }))) // Zwischenstände sofort weg: bei langen Exporten sonst viele GB
      done += weights[k] * 0.2
      moves.push([join(dir, `${name}.mp4`), `${base}-${n2(k + 1)}.mp4`])
      await extras(name, `${base}-${n2(k + 1)}`, { job: job!, t: clip!.cover }, clip!.post)
    }
    if (format === 'mp4') {
      await finish(all, join(dir, 'gesamt.mp4'), dir, { loudnorm: true, music: o.music, onProgress: step(sum * 0.2) })
      moves.push([join(dir, 'gesamt.mp4'), `${base}.mp4`])
      await extras('gesamt', base, first.cover, first.post)
    }
    for (const [from, to] of moves) await rename(from, to) // Job-Ordner liegt neben dem Ziel, also im selben Dateisystem
    onProgress(100)
    return moves.map(([, to]) => to).filter((f) => f.endsWith('.mp4')) // Nebendateien liegen daneben mit gleichem Stamm
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
