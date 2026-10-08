// Video-Export (mp4, clips): Clip-Folien als Jump Cuts mit Hook und Untertiteln, andere Folien als Standbild. Alles über ffmpeg, ohne Browser-Compositing.
// Filterketten und ASS-Untertitel angelehnt an BridgeClip (MIT, © 2026 BridgeMind).
// Electron-Teile (renderSlide, nativeImage, Schriften) lädt erst exportVideo: assSubs und encodeClip laufen im Selbsttest unter Node.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { MEDIA_EXT, sizeOf, type Deck, type Size } from '../shared/deck'
import { resolveTheme } from '../shared/themes'
import { MIN_PAUSE, PAD, STILL, clipWords, cropRect, cues, outSize, partsLength, tighten, type Captions, type ClipContent, type Cue, type Part, type Pauses, type Quiet, type Transcript } from '../shared/video'
import { probe, runFfmpeg, silences } from './ffmpeg'
import { localAsset } from './sync'

export interface SubFont { name: string; files: Buffer[]; bold: boolean } // name = Family in der TTF; files landen in <Job-Ordner>/fonts (fontsdir)

const VIDEO = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30']
const AUDIO = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000']
const FAST = ['-movflags', '+faststart']
// ponytail: loudnorm in einem Durchgang (dynamisch, kann leicht pumpen); exakt −14 LUFS per Messlauf + linear=true
const LOUD = 'loudnorm=I=-14:TP=-1.5:LRA=11'

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

/** Untertitel-Datei: Hook oben (12 % von oben, linksbündig), Untertitel unten bei ~73 % der Höhe über der Plattform-UI. Weiß mit dünner Kontur und Schatten, keine Kästen, kein Pop. */
export function assSubs(o: { size: Size; font: string; bold: boolean; accent: string; hook?: string; hookDur: number; cues: Cue[]; mode: Captions }): string {
  const { w, h } = o.size, m = Math.min(w, h), line = Math.max(1, Math.round(m * 0.002))
  const style = (name: string, size: number, align: number, marginV: number) =>
    `Style: ${name},${o.font},${Math.round(size)},&H00FFFFFF,&H00FFFFFF,&H40000000,&H80000000,${o.bold ? -1 : 0},0,0,0,100,100,0,0,1,${line},${line},${align},${Math.round(w * 0.08)},${Math.round(w * 0.08)},${Math.round(marginV)},1`
  const dlg = (start: number, end: number, st: string, text: string) => `Dialogue: 0,${at(start)},${at(end)},${st},,0,0,0,,${text}`
  const events: string[] = []
  if (o.hook?.trim()) events.push(dlg(0, o.hookDur, 'Hook', esc(o.hook.trim())))
  if (o.mode === 'satz') for (const c of o.cues) events.push(dlg(c.start, c.end, 'Cap', c.words.map((x) => esc(x.w)).join(' ')))
  if (o.mode === 'wort') {
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
    style('Hook', m * 0.06, 7, h * 0.12),
    style('Cap', m * (o.mode === 'wort' ? 0.075 : 0.055), 2, h * 0.27),
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

export interface ClipJob { file: string; parts: Part[]; hook?: string; captions: Captions; transcript: Transcript | null; size: Size; font: SubFont; accent: string; loudnorm?: boolean; pauses?: Pauses }

/** Eine Clip-Szene als MP4: je part ein eigener Input (schnelles Suchen), Zuschnitt auf size, concat, Hook und Untertitel per libass. Gibt die Länge (s) zurück. */
export async function encodeClip(job: ClipJob, out: string, dir: string, onProgress?: (pct: number) => void): Promise<number> {
  checkParts(job.parts, basename(job.file))
  const info = await probe(job.file)
  const late = job.parts.findIndex((p) => p.start >= info.duration - 0.2)
  if (late >= 0) throw new Error(`Ausschnitt ${late + 1} beginnt bei ${job.parts[late].start} s, das Video ist nur ${info.duration.toFixed(1)} s lang.`)
  // Pausen kürzen vor padParts: an jeder gekürzten Pause bleibt je Seite PAD stehen, ohne dass sich etwas doppelt.
  // ponytail: jedes Teilstück wird ein eigener Input mit eigenem Decoder; bei Dutzenden Pausen in 4K wird das schwer. Upgrade: Teilstücke eines parts aus einem Input per trim/atrim + concat
  const quiet: Quiet[] = []
  if (job.pauses === 'kurz' && info.audio) for (const p of job.parts) quiet.push(...(await silences(job.file, p.start, p.end, MIN_PAUSE)))
  const parts = padParts(tighten(job.parts, quiet), info.duration), dur = partsLength(parts), { size } = job
  const words = job.transcript && job.captions !== 'aus' ? clipWords(job.transcript, parts, quiet) : []
  const joined = seamless(parts)
  const graph = parts.map((p, i) => {
    const c = cropRect(info, size, p.focus), len = p.end - p.start
    const a = info.audio ? `[${i}:a]` : `anullsrc=r=48000:cl=stereo,atrim=duration=${sec(len)},`
    const fade = `${joined[i] ? '' : ',afade=t=in:d=0.02'}${joined[i + 1] ? '' : `,afade=t=out:st=${sec(Math.max(0, len - 0.02))}:d=0.02`}`
    // Video nie länger als der Ton (ganze Frames ≤ len): sonst füllt concat die Differenz mit Stille, hörbar als Loch am Schnitt
    return `[${i}:v]setpts=PTS-STARTPTS,fps=30,trim=end_frame=${Math.floor(len * 30 + 1e-6)},crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${size.w}:${size.h},setsar=1[v${i}];` +
      `${a}aformat=sample_rates=48000:channel_layouts=stereo${fade}[a${i}]`
  })
  graph.push(`${parts.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${parts.length}:v=1:a=1[cv][ca]`)
  const hasSubs = !!job.hook?.trim() || words.length > 0
  const ass = `${basename(out, '.mp4')}.ass`
  if (hasSubs) {
    await writeFile(join(dir, ass), assSubs({ size, font: job.font.name, bold: job.font.bold, accent: job.accent, hook: job.hook, hookDur: Math.min(4, dur), cues: words.length && job.captions !== 'aus' ? cues(words, job.captions) : [], mode: job.captions }))
    // Eigener Unterordner: libass lädt alles in fontsdir, auch fertige Szenen. Relativ zu cwd = dir: kein Pfad-Escaping im Filter.
    await mkdir(join(dir, 'fonts'), { recursive: true })
    await Promise.all(job.font.files.map((b, i) => writeFile(join(dir, 'fonts', `font-${i}.ttf`), b)))
  }
  graph.push(`[cv]${hasSubs ? `ass=${ass}:fontsdir=fonts` : 'null'}[v]`, `[ca]${job.loudnorm ? LOUD : 'anull'}[a]`)
  const inputs = parts.flatMap((p) => ['-ss', sec(p.start), '-t', sec(p.end - p.start), '-i', job.file])
  await runFfmpeg([...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', '-map', '[a]', ...VIDEO, ...AUDIO, ...FAST, out], { cwd: dir, duration: dur, onProgress })
  return dur
}

// Standbild (PNG in Ausgabegröße) als Szene von STILL Sekunden mit stillem Ton, gleiche Parameter wie die Clips (concat ohne Neukodieren)
async function encodeStill(png: string, out: string, dir: string, onProgress?: (pct: number) => void) {
  await runFfmpeg(['-loop', '1', '-framerate', '30', '-t', String(STILL), '-i', png, '-f', 'lavfi', '-t', String(STILL), '-i', 'anullsrc=r=48000:cl=stereo', '-vf', 'setsar=1', ...VIDEO, ...AUDIO, ...FAST, out], { cwd: dir, duration: STILL, onProgress })
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

/** Deck als Video: mp4 = alle Folien hintereinander in `${base}.mp4`, clips = je Clip-Folie `${base}-01.mp4` usw. Fortschritt 0–100 über alle Szenen. */
export async function exportVideo(deck: Deck, target: string, format: 'mp4' | 'clips', transcriptOf: (file: string) => Promise<Transcript | null>, onProgress: (pct: number) => void = () => {}): Promise<string[]> {
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
  const size = outSize(sizeOf(deck)), accent = resolveTheme(deck.theme).c.accent
  // Gewichte für den Fortschritt: Länge je Szene, beim mp4 dazu der Zusammenschnitt (Video wird nur kopiert)
  const weights = scenes.map(({ clip }) => (clip ? partsLength(clip.parts) : STILL))
  const sum = weights.reduce((a, b) => a + b, 0), total = format === 'mp4' ? sum * 1.2 : sum
  let done = 0
  const step = (w: number) => (pct: number) => onProgress(Math.min(100, Math.floor(((done + (w * pct) / 100) / total) * 100)))
  const dir = join(dirname(base), `.video-tmp-${randomBytes(4).toString('hex')}`) // nicht /tmp: tmpfs läuft bei langen Videos voll
  await mkdir(dir, { recursive: true })
  try {
    const font = scenes.some((x) => x.clip) ? await subFont(deck) : { name: 'Archivo', files: [], bold: true }
    const files: string[] = []
    for (const [k, { i, clip }] of scenes.entries()) {
      const out = join(dir, `szene-${n2(k + 1)}.mp4`) // erst im Job-Ordner, am Ende per rename: ein Abbruch lässt den letzten guten Export stehen
      if (clip) {
        const file = videoPath(clip.video, i + 1), captions = clip.captions ?? 'wort'
        const transcript = captions === 'aus' ? null : await transcriptOf(file)
        if (!transcript && captions !== 'aus') console.warn(`[video] Kein Transkript für ${file}: Clip ohne Untertitel (erst transcribe_video aufrufen)`)
        await encodeClip({ file, parts: clip.parts, hook: clip.hook, captions, transcript, size, font, accent, loudnorm: format === 'clips', pauses: clip.pauses }, out, dir, step(weights[k]))
      } else {
        const [{ renderSlide }, { nativeImage }] = await Promise.all([import('./render'), import('electron')])
        const png = join(dir, `folie-${n2(k + 1)}.png`)
        await writeFile(png, nativeImage.createFromBuffer((await renderSlide(deck, i, { png: true })).png!).resize({ width: size.w, height: size.h, quality: 'best' }).toPNG())
        await encodeStill(png, out, dir, step(weights[k]))
      }
      files.push(out)
      done += weights[k]
    }
    if (format === 'mp4') {
      await writeFile(join(dir, 'liste.txt'), files.map((f) => `file '${basename(f)}'`).join('\n'))
      await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'liste.txt', '-map', '0:v', '-map', '0:a', '-c:v', 'copy', '-af', LOUD, ...AUDIO, ...FAST, 'gesamt.mp4'], { cwd: dir, duration: sum, onProgress: step(total - sum) })
    }
    const moves = format === 'mp4' ? [[join(dir, 'gesamt.mp4'), `${base}.mp4`]] : files.map((f, k) => [f, `${base}-${n2(k + 1)}.mp4`])
    for (const [from, to] of moves) await rename(from, to) // Job-Ordner liegt neben dem Ziel, also im selben Dateisystem
    onProgress(100)
    return moves.map(([, to]) => to)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
