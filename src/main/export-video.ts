// Video-Export (mp4, clips): Clip-Folien als Jump Cuts mit Hook und Untertiteln, andere Folien als Standbild. Alles über ffmpeg, ohne Browser-Compositing.
// Filterketten und ASS-Untertitel angelehnt an BridgeClip (MIT, © 2026 BridgeMind).
// Ablauf: Szenen als Zwischenstände (mkv, PCM-Ton), je Ausgabedatei ein Endschritt (concat-Demuxer, Video kopiert, Ton einmal AAC + loudnorm + Musik).
// Electron-Teile (renderSlide, nativeImage, Schriften) lädt erst exportVideo: assSubs, clipSegs, finish und encodeClip laufen im Selbsttest unter Node.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { MEDIA_EXT, sizeOf, transitionOf, type Deck, type Size } from '../shared/deck'
import { resolveTheme } from '../shared/themes'
import { MIN_PAUSE, PAD, STILL, clipWords, cropRect, cues, fillerQuiet, outSize, partsLength, tighten, type Captions, type ClipContent, type Cue, type Fit, type Part, type Pauses, type Quiet, type Transcript } from '../shared/video'
import { probe, runFfmpeg, silences } from './ffmpeg'
import { localAsset } from './sync'

export interface SubFont { name: string; files: Buffer[]; bold: boolean } // name = Family in der TTF; files landen in <Job-Ordner>/fonts (fontsdir)
export interface Seg { file: string; dur: number } // Zwischenstand (mkv) und seine Länge in s
export interface Music { file: string; volume?: number } // absoluter Pfad, volume 0–1 (Standard 0,25)

// Teilstücke je ffmpeg-Aufruf: je Teilstück ein Input mit eigenem Decoder, und der Filtergraph steht in argv (Linux: max. 128 KiB je Argument).
// ponytail: bis zu 20 Decoder gleichzeitig (4K braucht viel RAM); Upgrade: nahtlose Teilstücke eines parts aus einem Input per trim/atrim
const GROUP = 20
const FADE = 0.4 // Übergang aus/in Schwarz (s)
// Alle Zwischenstände eines Exports mit denselben Video-Parametern, sonst passt -c:v copy beim Verbinden nicht
const video = (preset: string) => ['-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30']
const PCM = ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'] // AAC in Zwischenständen verschöbe den Ton an jeder concat-Naht (Priming: Lücke oder Versatz)
const AUDIO = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000']
const FAST = ['-movflags', '+faststart']
// ponytail: loudnorm in einem Durchgang (dynamisch, kann leicht pumpen); exakt −14 LUFS per Messlauf + linear=true
// Zeitstempel danach aus der Sample-Zahl: loudnorm (intern 192 kHz) verschiebt sie am Ende, die Tonspur wirkte bis 0,07 s länger als das Bild
const LOUD = 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,asetpts=N/SR/TB'

/** x264-Preset für einen ganzen Export (Gesamtlänge in s): 1080p mit veryfast läuft auf schwachen Rechnern mit ~10 fps, darum über 10 min superfast. */
export const presetFor = (seconds: number) => (seconds > 600 ? 'superfast' : 'veryfast')

const n2 = (i: number) => String(i).padStart(2, '0')
const sec = (s: number) => s.toFixed(3)

// ASS-Zeit H:MM:SS.cc
const at = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100))
  return `${Math.floor(cs / 360000)}:${n2(Math.floor(cs / 6000) % 60)}:${n2(Math.floor(cs / 100) % 60)}.${n2(cs % 100)}`
}
// Backslash als Vollbreiten-Zeichen (ASS kennt kein Escape dafür), Klammern per \{ \} (libass), Zeilenumbruch als \N
const esc = (s: string) => s.replace(/\\/g, '＼').replace(/[{}]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\N')

// ASS-Farbe &HBBGGRR&. Dunkle Akzente (z. B. Petrol) gingen auf Video neben der dunklen Kontur unter → halb Richtung Weiß.
function assColor(hex: string) {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0)
  if (0.2126 * r + 0.7152 * g + 0.0722 * b < 110) [r, g, b] = [r, g, b].map((v) => Math.round((v + 255) / 2))
  return `&H${[b, g, r].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}&`
}

/** Untertitel-Datei: Hook oben linksbündig, Untertitel unten mittig, Lage nach Format. Hochformat (9:16): bei 33 % der Höhe, über der Plattform-Leiste
 *  (Reels/TikTok verdecken unten ~35 %); 4:5 und 1:1: 12 %; Querformat: kleiner, 7 %. Weiß mit dünner Kontur und Schatten, keine Kästen, kein Pop. */
export function assSubs(o: { size: Size; font: string; bold: boolean; accent: string; hook?: string; hookDur: number; cues: Cue[]; mode: Captions }): string {
  const { w, h } = o.size, m = Math.min(w, h), line = Math.max(1, Math.round(m * 0.002)), wide = w > h, wort = o.mode === 'wort'
  const style = (name: string, size: number, align: number, marginV: number) =>
    `Style: ${name},${o.font},${Math.round(size)},&H00FFFFFF,&H00FFFFFF,&H40000000,&H80000000,${o.bold ? -1 : 0},0,0,0,100,100,0,0,1,${line},${line},${align},${Math.round(w * 0.08)},${Math.round(w * 0.08)},${Math.round(marginV)},1`
  const dlg = (start: number, end: number, st: string, text: string) => `Dialogue: 0,${at(start)},${at(end)},${st},,0,0,0,,${text}`
  const events: string[] = []
  if (o.hook?.trim()) events.push(dlg(0, o.hookDur, 'Hook', esc(o.hook.trim())))
  if (o.mode === 'satz') for (const c of o.cues) events.push(dlg(c.start, c.end, 'Cap', c.words.map((x) => esc(x.w)).join(' ')))
  if (wort) {
    const accent = assColor(o.accent)
    // Ein Dialogue je Wortzustand: das gesprochene Wort in Akzentfarbe, der Rest des Häppchens weiß
    for (const c of o.cues) c.words.forEach((x, k) => {
      const text = c.words.map((y, j) => (j === k ? `{\\c${accent}}${esc(y.w)}{\\r}` : esc(y.w))).join(' ')
      events.push(dlg(k ? x.start : c.start, k < c.words.length - 1 ? c.words[k + 1].start : c.end, 'Cap', text))
    })
  }
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    style('Hook', m * (wide ? 0.045 : 0.06), 7, h * (wide ? 0.07 : 0.12)),
    style('Cap', m * (wort ? (wide ? 0.065 : 0.075) : 0.055), 2, h * (wide ? 0.07 : h / w >= 1.6 ? 0.33 : 0.12)),
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events, '',
  ].join('\n')
}

/** parts um PAD verlängern, aber nur bis zur Mitte der Lücke zum nächsten part im Quellvideo (keine Doppelung) und nicht über das Video hinaus. */
export function padParts(parts: Part[], duration: number): Part[] {
  return parts.map((p) => {
    let start = Math.max(0, p.start - PAD), end = Math.min(duration, p.end + PAD)
    for (const q of parts) {
      if (q === p) continue
      if (q.end <= p.start) start = Math.max(start, (q.end + p.start) / 2)
      if (q.start >= p.end) end = Math.min(end, (p.end + q.start) / 2)
    }
    return { ...p, start, end }
  })
}

/** Schnitte, an denen das Quellvideo nahtlos weiterläuft (part i beginnt, wo part i−1 endet): dort kein Fade, sonst sinkt der Pegel mitten im Satz. */
export const seamless = (parts: Part[]) => parts.map((p, i) => i > 0 && Math.abs(parts[i - 1].end - p.start) < 1e-3)

// Leere oder verdrehte parts vor ffmpeg abfangen, dessen Filtergraph-Fehler versteht niemand
function checkParts(parts: Part[] | undefined, where: string) {
  if (!parts?.length) throw new Error(`${where}: Der Clip hat keine Ausschnitte (parts).`)
  const bad = parts.findIndex((p) => !(p.end > p.start))
  if (bad >= 0) throw new Error(`${where}: Ausschnitt ${bad + 1} endet nicht nach seinem Anfang (start ${parts[bad].start} s, end ${parts[bad].end} s).`)
}

export interface ClipJob { file: string; parts: Part[]; hook?: string; captions: Captions; transcript: Transcript | null; size: Size; font: SubFont; accent: string; loudnorm?: boolean; pauses?: Pauses; fit?: Fit }
interface SegOpts { preset: string; fadeIn?: boolean; fadeOut?: boolean } // fadeIn/fadeOut: Übergang aus/in Schwarz am Anfang/Ende der Szene

/** Eine Clip-Szene als Zwischenstände, je GROUP Teilstücke ein mkv: Zuschnitt (crop um focus oder blur), Hook nur in der ersten Gruppe, Untertitel je Gruppe ab 0. Fortschritt über alle Gruppen. */
export async function clipSegs(job: ClipJob, name: string, dir: string, o: SegOpts, onProgress?: (pct: number) => void): Promise<Seg[]> {
  checkParts(job.parts, basename(job.file))
  const info = await probe(job.file)
  const late = job.parts.findIndex((p) => p.start >= info.duration - 0.2)
  if (late >= 0) throw new Error(`Ausschnitt ${late + 1} beginnt bei ${job.parts[late].start} s, das Video ist nur ${info.duration.toFixed(1)} s lang.`)
  // Pausen und Füllwörter kürzen vor padParts: an jedem Schnitt bleibt je Seite PAD stehen, ohne dass sich etwas doppelt. fillerQuiet nimmt nur echte Wortzeiten.
  const quiet: Quiet[] = []
  if (job.pauses === 'kurz' && info.audio) for (const p of job.parts) {
    quiet.push(...(await silences(job.file, p.start, p.end, MIN_PAUSE)))
    if (job.transcript) quiet.push(...fillerQuiet(job.transcript, p.start, p.end))
  }
  const parts = padParts(tighten(job.parts, quiet), info.duration), joined = seamless(parts), total = partsLength(parts), { size } = job
  const blur = job.fit === 'blur' && Math.abs(info.w / info.h - size.w / size.h) > 0.01 // gleiches Seitenverhältnis: blur = crop
  const [bw, bh] = [size.w, size.h].map((v) => Math.max(2, Math.round(v / 24) * 2)) // Grund klein weichzeichnen, dann hochskalieren: billig und weich
  const captions = job.transcript && job.captions !== 'aus' ? job.captions : null
  if (job.hook?.trim() || captions) {
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
    const subs = !!hook || words.length > 0
    if (subs) await writeFile(join(dir, `${id}.ass`), assSubs({ size, font: job.font.name, bold: job.font.bold, accent: job.accent, hook, hookDur: Math.min(4, dur), cues: captions && words.length ? cues(words, captions) : [], mode: job.captions }))
    const graph = ps.map((p, i) => {
      const c = cropRect(info, size, p.focus), len = p.end - p.start, k = k0 + i
      const fit = blur
        ? `split[b${i}][f${i}];[b${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=4,lutyuv=y=val*0.55,scale=${size.w}:${size.h}[g${i}];` +
          `[f${i}]scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease:force_divisible_by=2[h${i}];[g${i}][h${i}]overlay=(W-w)/2:(H-h)/2`
        : `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${size.w}:${size.h}`
      const a = info.audio ? `[${i}:a]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${sec(len)},`
      const fade = `${joined[k] ? '' : ',afade=t=in:d=0.02'}${joined[k + 1] ? '' : `,afade=t=out:st=${sec(Math.max(0, len - 0.02))}:d=0.02`}`
      // Video nie länger als der Ton (ganze Frames ≤ len): sonst füllt concat die Differenz mit Stille, hörbar als Loch am Schnitt
      return `[${i}:v]setpts=PTS-STARTPTS,fps=30,trim=end_frame=${Math.floor(len * 30 + 1e-6)},${fit},setsar=1[v${i}];` +
        `${a}aformat=sample_rates=48000:channel_layouts=stereo${fade}[a${i}]`
    })
    const vf = [subs && `ass=${id}.ass:fontsdir=fonts`, o.fadeIn && first && `fade=t=in:d=${FADE}`, o.fadeOut && last && `fade=t=out:st=${sec(Math.max(0, dur - FADE))}:d=${FADE}`]
    const af = [o.fadeIn && first && `afade=t=in:d=${FADE}`, o.fadeOut && last && `afade=t=out:st=${sec(Math.max(0, dur - FADE))}:d=${FADE}`]
    graph.push(`${ps.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${ps.length}:v=1:a=1[cv][ca]`,
      `[cv]${vf.filter(Boolean).join(',') || 'null'}[v]`, `[ca]${af.filter(Boolean).join(',') || 'anull'}[a]`)
    const inputs = ps.flatMap((p) => ['-ss', sec(p.start), '-t', sec(p.end - p.start), '-i', job.file])
    const file = join(dir, `${id}.mkv`)
    await runFfmpeg([...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', '-map', '[a]', ...video(o.preset), ...PCM, file],
      { cwd: dir, duration: dur, onProgress: onProgress && ((pct) => onProgress(Math.floor(((done + (dur * pct) / 100) / total) * 100))) })
    segs.push({ file, dur })
    done += dur
  }
  return segs
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
  const dur = segs.reduce((s, x) => s + x.dur, 0), list = `${basename(out)}.txt`, loud = o.loudnorm ? `,${LOUD}` : ''
  await writeFile(join(dir, list), segs.map((s) => `file '${basename(s.file)}'`).join('\n'))
  // sidechaincompress endet mit dem ersten Eingang, der endet, und verwirft, was der andere noch hat: Musik darum endlos hinein, Länge gibt die Sprache vor.
  // Schwelle 0,006 statt 0,03: leise Handy-Sprache (−31 dBFS RMS) drückt die Musik sonst kaum (gemessen 11 dB statt 1 dB). ponytail: feste Schwelle; Upgrade: relativ zum gemessenen Sprachpegel
  const graph = o.music
    ? `[0:a]asplit[s][k];[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${Math.min(1, Math.max(0, o.music.volume ?? 0.25))},afade=t=in:d=1[m];` +
      `[m][k]sidechaincompress=threshold=0.006:ratio=8:attack=20:release=300,afade=t=out:st=${sec(Math.max(0, dur - 2))}:d=2[d];[s][d]amix=inputs=2:normalize=0:duration=first${loud}[a]`
    : `[0:a]anull${loud}[a]`
  const music = o.music ? ['-stream_loop', '-1', '-i', resolve(o.music.file)] : []
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', list, ...music, '-filter_complex', graph, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...AUDIO, ...FAST, out], { cwd: dir, duration: dur, onProgress: o.onProgress })
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
function videoPath(src: string, slide: number) {
  const p = src.startsWith('asset://') ? decodeURIComponent(new URL(src).pathname) : src
  if (!isAbsolute(p)) throw new Error(`Folie ${slide}: „video“ muss ein asset://-Pfad oder ein absoluter Dateipfad sein.`)
  if (!MEDIA_EXT.test(p)) throw new Error(`Folie ${slide}: „video“ ist keine Mediendatei (${basename(p)}).`)
  return localAsset(p)
}

/** Deck als Video: mp4 = alle Folien hintereinander in `${base}.mp4`, clips = je Clip-Folie `${base}-01.mp4` usw. Fortschritt 0–100 über alle Szenen.
 *  o.music: Hintergrundmusik (Pfad löst der Aufrufer auf), in jeder Ausgabedatei. */
export async function exportVideo(deck: Deck, target: string, format: 'mp4' | 'clips', transcriptOf: (file: string) => Promise<Transcript | null>, onProgress: (pct: number) => void = () => {}, o: { music?: Music } = {}): Promise<string[]> {
  const base = resolve(target)
  const scenes = deck.slides.map((s, i) => ({ i, clip: s.layout === 'clip' ? (s.content as ClipContent) : undefined })).filter((x) => format === 'mp4' || x.clip)
  if (!scenes.length) throw new Error('Keine Clip-Folie im Deck: Einzelne Clips entstehen nur aus Folien mit dem Layout „clip“.')
  // Vorab prüfen, damit ein Fehler in Folie 5 nicht erst nach vier fertigen Szenen auffällt
  for (const { i, clip } of scenes) {
    if (!clip) continue
    if (!clip.video) throw new Error(`Folie ${i + 1}: Im Clip fehlt das Video. Erst ein Video anhängen und unter „video“ eintragen.`)
    videoPath(clip.video, i + 1)
    checkParts(clip.parts, `Folie ${i + 1}`)
  }
  // Musik vorab einmal anspielen: probe() verlangt eine Videospur, und ffmpegs „Stream specifier [1:a]“ käme erst nach dem Encoden
  if (o.music) await runFfmpeg(['-v', 'error', '-i', resolve(o.music.file), '-map', '0:a:0', '-t', '0.1', '-f', 'null', '-']).catch((e: Error) => {
    throw new Error(`Die Musikdatei ${o.music!.file} ${/No such file/i.test(e.message) ? 'fehlt' : /matches no streams/i.test(e.message) ? 'hat keine Tonspur' : 'ist nicht lesbar'}.`)
  })
  const size = outSize(sizeOf(deck)), accent = resolveTheme(deck.theme).c.accent
  // Gewichte für den Fortschritt: Länge je Szene, dazu je Ausgabedatei der Endschritt (Video wird nur kopiert)
  const weights = scenes.map(({ clip }) => (clip ? partsLength(clip.parts) : STILL))
  const sum = weights.reduce((a, b) => a + b, 0), total = sum * 1.2, preset = presetFor(sum)
  let done = 0
  const step = (w: number) => (pct: number) => onProgress(Math.min(100, Math.floor(((done + (w * pct) / 100) / total) * 100)))
  // Übergang ≠ none (morph = harter Schnitt): Einblende aus Schwarz am Anfang der Folie, Abblende am Ende der Szene davor.
  // ponytail: kein echter Crossfade (xfade), der bräuchte eine Neukodierung des Ganzen statt -c:v copy
  const fades = (k: number) => format === 'mp4' && k < scenes.length && !['none', 'morph'].includes(transitionOf(deck, scenes[k].i))
  const dir = join(dirname(base), `.video-tmp-${randomBytes(4).toString('hex')}`) // nicht /tmp: tmpfs läuft bei langen Videos voll
  await mkdir(dir, { recursive: true })
  try {
    const font = scenes.some((x) => x.clip) ? await subFont(deck) : { name: 'Archivo', files: [], bold: true }
    const all: Seg[] = [], moves: [string, string][] = [] // erst im Job-Ordner, am Ende per rename: ein Abbruch lässt den letzten guten Export stehen
    for (const [k, { i, clip }] of scenes.entries()) {
      const name = `szene-${n2(k + 1)}`, so: SegOpts = { preset, fadeIn: fades(k), fadeOut: fades(k + 1) }
      let segs: Seg[]
      if (clip) {
        const file = videoPath(clip.video, i + 1), captions = clip.captions ?? 'wort'
        const transcript = captions === 'aus' && clip.pauses !== 'kurz' ? null : await transcriptOf(file) // pauses kurz: Füllwörter aus dem Transkript
        if (!transcript && captions !== 'aus') console.warn(`[video] Kein Transkript für ${file}: Clip ohne Untertitel (erst transcribe_video aufrufen)`)
        segs = await clipSegs({ file, parts: clip.parts, hook: clip.hook, captions, transcript, size, font, accent, pauses: clip.pauses, fit: clip.fit }, name, dir, so, step(weights[k]))
      } else {
        const [{ renderSlide }, { nativeImage }] = await Promise.all([import('./render'), import('electron')])
        const png = join(dir, `folie-${n2(k + 1)}.png`)
        await writeFile(png, nativeImage.createFromBuffer((await renderSlide(deck, i, { png: true })).png!).resize({ width: size.w, height: size.h, quality: 'best' }).toPNG())
        segs = [await encodeStill(png, join(dir, `${name}.mkv`), dir, so, step(weights[k]))]
      }
      done += weights[k]
      if (format === 'mp4') { all.push(...segs); continue }
      await finish(segs, join(dir, `${name}.mp4`), dir, { loudnorm: true, music: o.music, onProgress: step(weights[k] * 0.2) })
      await Promise.all(segs.map((x) => rm(x.file, { force: true }))) // Zwischenstände sofort weg: bei langen Exporten sonst viele GB
      done += weights[k] * 0.2
      moves.push([join(dir, `${name}.mp4`), `${base}-${n2(k + 1)}.mp4`])
    }
    if (format === 'mp4') {
      await finish(all, join(dir, 'gesamt.mp4'), dir, { loudnorm: true, music: o.music, onProgress: step(sum * 0.2) })
      moves.push([join(dir, 'gesamt.mp4'), `${base}.mp4`])
    }
    for (const [from, to] of moves) await rename(from, to) // Job-Ordner liegt neben dem Ziel, also im selben Dateisystem
    onProgress(100)
    return moves.map(([, to]) => to)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
