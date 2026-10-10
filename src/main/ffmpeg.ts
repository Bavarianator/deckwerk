// ffmpeg für den Video-Schnitt: Binary finden oder laden, Aufrufe mit Fortschritt, Probe, Standbilder, PCM für Whisper.
// Ohne Electron, damit Selbsttests es unter Node nutzen können.
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { cropRect, partsLength, type Fit, type Part, type Quiet, type VideoInfo } from '../shared/video'
import { download } from './download'

// Statische Builds mit libass und libx264 (ffmpeg-static, GPL); darwin-arm64 für den Mac-Fork
const BUILDS: Record<string, { url: string; sha256: string }> = {
  'linux-x64': { url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz', sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa' },
  'darwin-arm64': { url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz', sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa' },
}

const home = () => process.env.DECKWERK_HOME ?? join(homedir(), 'Deckwerk')

export type RunOpts = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** stdout als Text; ersetzt das Sammeln in out */
  onOut?: (s: string) => void
  /** stdout roh (Binärdaten); ersetzt das Sammeln in out. Nur für große Ströme, das Dekodieren zu Text entfällt. */
  onBin?: (c: Buffer) => void
  /** stderr-Chunks, zusätzlich zum gemerkten Ende in err */
  onErr?: (s: string) => void
}

/** Ein Aufruf ohne Shell; stdout gesammelt (oder an onOut/onBin), von stderr nur das Ende */
export function run(bin: string, args: string[], o: RunOpts = {}) {
  return new Promise<{ code: number | null; out: Buffer; err: string }>((resolve, reject) => {
    const p = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    p.stdout.on('data', (c: Buffer) => (o.onBin ? o.onBin(c) : o.onOut ? o.onOut(c.toString()) : out.push(c)))
    p.stderr.on('data', (c: Buffer) => { err = (err + c).slice(-65536); o.onErr?.(c.toString()) })
    p.on('error', reject)
    p.on('close', (code) => resolve({ code, out: Buffer.concat(out), err }))
  })
}

// Untertitel brauchen den Filter ass (libass), das Encoding libx264
async function usable(bin: string) {
  try {
    const [f, e] = await Promise.all([run(bin, ['-hide_banner', '-filters']), run(bin, ['-hide_banner', '-encoders'])])
    return /\sass\s+V->V/.test(f.out.toString()) && /\slibx264\s/.test(e.out.toString())
  } catch { return false } // nicht im PATH
}

async function locate(): Promise<string> {
  if (await usable('ffmpeg')) return 'ffmpeg'
  const build = BUILDS[`${process.platform}-${process.arch}`]
  if (!build) throw new Error('ffmpeg fehlt. Bitte ffmpeg mit libass und libx264 installieren (z. B. über den Paketmanager) und den Export noch einmal starten.')
  const file = join(home(), 'models', 'ffmpeg-6.1.1')
  if (existsSync(file) && (await usable(file))) return file
  await rm(file, { force: true }) // halb geladen oder beschädigt: einmal neu laden
  await mkdir(dirname(file), { recursive: true })
  // Zwischennamen je Prozess: App und MCP-Server können gleichzeitig laden; rename ersetzt atomar
  const tmp = `${file}.${process.pid}`
  try {
    console.log('[ffmpeg] lade', build.url)
    await download(build.url, build.sha256, `${tmp}.gz`)
    await pipeline(createReadStream(`${tmp}.gz`), createGunzip(), createWriteStream(tmp))
    await chmod(tmp, 0o755)
    await rename(tmp, file)
  } finally {
    await Promise.all([rm(`${tmp}.gz`, { force: true }), rm(tmp, { force: true })])
  }
  if (!(await usable(file))) throw new Error(`Das geladene ffmpeg (${file}) kann keine Untertitel einbrennen (libass fehlt). Bitte ffmpeg mit libass und libx264 installieren.`)
  return file
}

let bin: Promise<string> | undefined
/** Pfad zu einem ffmpeg mit libass und libx264: aus dem PATH, sonst einmalig geladen. Ergebnis gemerkt, Fehler nicht. */
export const ffmpegBin = () => (bin ??= locate().catch((e) => { bin = undefined; throw e }))

async function ff(args: string[], o: RunOpts = {}) {
  const r = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-y', ...args], o)
  if (r.code !== 0) throw new Error(`ffmpeg fehlgeschlagen (Code ${r.code}):\n${r.err.trim().split('\n').slice(-15).join('\n')}`)
  return r.out
}

/** ffmpeg-Aufruf; mit duration (s) und onProgress meldet er 0–100 über -progress. */
export async function runFfmpeg(args: string[], o: { cwd?: string; duration?: number; onProgress?: (pct: number) => void } = {}): Promise<void> {
  const { duration, onProgress } = o
  if (!duration || !onProgress) return void (await ff(['-nostats', ...args], { cwd: o.cwd }))
  let last = -1 // nur steigend melden: mit loudnorm (Vorlauf) springt out_time zurück
  await ff(['-nostats', '-progress', 'pipe:1', ...args], { cwd: o.cwd, onOut: (s) => {
    for (const m of s.matchAll(/out_time_us=(\d+)\n/g)) {
      const pct = Math.min(100, Math.floor(Number(m[1]) / 1e4 / duration))
      if (pct > last) onProgress((last = pct))
    }
  } })
}

/** Dauer und Maße, wie das Video angezeigt wird (Drehung 90/270 tauscht w und h), dazu ob es Ton hat. Aus der stderr von `ffmpeg -i`, weil ffmpeg-static kein ffprobe mitbringt. */
export async function probe(file: string): Promise<VideoInfo & { audio: boolean }> {
  const { err } = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-i', file]) // endet ohne Ausgabedatei immer mit Code 1
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(err)
  if (!d) throw new Error(`Video nicht lesbar: ${basename(file)}${/No such file/i.test(err) ? ' (Datei nicht gefunden)' : ''}`)
  const streams = err.split(/\n(?=\s*Stream #)/).filter((s) => /^\s*Stream #/.test(s))
  const video = streams.find((s) => / Video: /.test(s.split('\n')[0]) && !/attached pic/.test(s.split('\n')[0])) // Cover-Bild in Audiodateien zählt nicht
  const size = video && /, (\d{2,5})x(\d{2,5})[\s,]/.exec(video.split('\n')[0])
  if (!size) throw new Error(`Keine Videospur in ${basename(file)}`)
  // ponytail: SAR ≠ 1 (anamorph, DV/DVD) bleibt gestaucht; Upgrade: Breite × SAR hier und scale=iw*sar:ih vor dem crop
  const rot = Math.round(Number(/rotation of (-?[\d.]+)/i.exec(video)?.[1] ?? /rotate\s*:\s*(-?\d+)/.exec(video)?.[1] ?? 0))
  const [w, h] = Math.abs(rot) % 180 === 90 ? [+size[2], +size[1]] : [+size[1], +size[2]]
  // Dauer steht im Container der fremden Datei: riesige Werte sprengten die Arrays in loudness und der Chunk-Planung
  const duration = +d[1] * 3600 + +d[2] * 60 + +d[3]
  if (duration > 48 * 3600) throw new Error(`Video ist länger als 48 Stunden (${basename(file)}). So lange Videos kann Deckwerk nicht verarbeiten.`)
  return { duration, w, h, audio: streams.some((s) => / Audio: /.test(s.split('\n')[0])) }
}

/** Je Zeitpunkt (s) ein JPEG in width px Breite (Höhe proportional, gerade); -ss vor -i springt direkt hin. */
export async function frames(file: string, times: number[], width = 640): Promise<Buffer[]> {
  const out: Buffer[] = []
  for (const t of times) {
    const jpg = await ff(['-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `scale=${Math.round(width)}:-2`, '-q:v', '4', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'])
    if (!jpg.length) throw new Error(`Kein Bild bei ${t} s in ${basename(file)} (Video zu kurz?)`)
    out.push(jpg)
  }
  return out
}

/** Stillen ab min Sekunden zwischen from und to, in Sekunden des Quellvideos. ponytail: feste Schwelle −35 dB; bei lautem Grundrauschen findet sie nichts und der Clip bleibt ungekürzt. Upgrade: Schwelle relativ zum gemessenen Pegel. */
export async function silences(file: string, from: number, to: number, min: number): Promise<Quiet[]> {
  const r = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-ss', from.toFixed(3), '-t', (to - from).toFixed(3), '-i', file, '-vn', '-af', `silencedetect=noise=-35dB:d=${min}`, '-f', 'null', '-'])
  if (r.code !== 0) throw new Error(`Pausen in ${basename(file)} nicht messbar:\n${r.err.trim().split('\n').slice(-5).join('\n')}`)
  // Zeiten ab 0 = from; eine Stille bis zum Ende hat bei älterem ffmpeg kein silence_end
  const out: Quiet[] = []
  for (const m of r.err.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const t = Math.min(to, Math.max(from, from + Number(m[2])))
    if (m[1] === 'start') out.push([t, to])
    else if (out.length) out[out.length - 1][1] = t
  }
  return out
}

/** Harte Bildwechsel (scdet) zwischen from und to, in Sekunden des Quellvideos: je Wechsel die Zeit seines ersten Frames, 5 ms früher (sec() rundet auf ms:
 *  ein Teil ab dieser Zeit beginnt sicher mit dem neuen Bild, einer bis dahin endet sicher davor, bis 200 fps). Auf 320 px verkleinert: schneller, die Wertung bleibt.
 *  Schwelle 12, gemessen (check-video): harte Schnitte 14–44 (14 zwischen ähnlichen Bildausschnitten), heftiges Wackeln bis 11, Rauschen bis 6.
 *  ponytail: feste Schwelle; ein Fotoblitz zählt als Wechsel, eine Überblendung nicht (blitzt auch nicht). */
export async function scenes(file: string, from: number, to: number): Promise<number[]> {
  const ss = from.toFixed(3)
  const out = await ff(['-nostats', '-ss', ss, '-t', (to - from).toFixed(3), '-i', file, '-an', '-sn', '-vf', 'scale=320:-2,scdet=threshold=12,metadata=mode=print:key=lavfi.scd.time:file=-', '-f', 'null', '-'])
  return [...out.toString().matchAll(/lavfi\.scd\.time=([\d.]+)/g)].map((m) => +ss + Number(m[1]) - 0.005) // Zeiten ab 0 = from
}

/** Ton als Float32 mono 16 kHz, so wie Whisper ihn erwartet; mit from/dur (s) nur dieser Bereich. Mit dur wird der Zielpuffer vorab angelegt (8 h = 1,8 GB, ein Buffer.concat verdoppelte die Spitze). */
export async function pcm16k(file: string, from?: number, dur?: number): Promise<Float32Array> {
  const args = [...(from ? ['-ss', from.toFixed(3)] : []), ...(dur ? ['-t', dur.toFixed(3)] : []), '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']
  let pre: Float32Array | undefined, n = 0 // Bytes in pre
  const o: RunOpts = {}
  if (dur) {
    const f = pre = new Float32Array(Math.ceil(dur * 16000) + 16000) // +1 s Reserve, falls ffmpeg etwas mehr liefert
    const view = Buffer.from(f.buffer) // Float32Array ist ausgerichtet, ein Buffer-Pool wäre es nicht
    o.onBin = (c) => { n += c.copy(view, n, 0, Math.min(c.length, view.length - n)) }
  }
  const b = await ff(args, o).catch((e: Error) => {
    throw /does not contain any stream|matches no streams/i.test(e.message) ? new Error(`${basename(file)} hat keine Tonspur, es gibt nichts zu transkribieren.`) : e
  })
  if (pre) return pre.subarray(0, n >> 2)
  const k = b.length >> 2
  return b.byteOffset % 4 ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + k * 4)) : new Float32Array(b.buffer, b.byteOffset, k)
}

/** RMS-Pegel in dBFS je Sekunde über die ganze Tonspur (Stille → −100), Länge = Videodauer gerundet; ohne Tonspur −100. Braucht eine Videospur (probe). Dekodiert nur den Ton, die Werte kommen über stdout (ametadata) statt aus einer stderr-Flut. */
export async function loudness(file: string, onProgress?: (pct: number) => void): Promise<number[]> {
  const info = await probe(file)
  const n = Math.max(1, Math.round(info.duration)) // Resttrümmer < 0,5 s (Encoder-Padding, aac liefert gern etwas mehr) fallen weg
  if (!info.audio) return new Array(n).fill(-100)
  const db: number[] = []
  let rest = '', t = 0, last = -1
  const line = (l: string) => {
    const m = /pts_time:([\d.]+)/.exec(l)
    if (m) return void (t = Math.floor(+m[1]))
    const v = /RMS_level=(\S+)/.exec(l)
    if (!v) return
    const x = parseFloat(v[1])
    while (db.length < t) db.push(-100) // Lücken (fehlende Fenster) als Stille
    db[t] = Number.isFinite(x) ? Math.max(-100, x) : -100 // -inf bei digitaler Stille
    const pct = Math.min(100, Math.floor((t * 100) / info.duration))
    if (onProgress && pct > last) onProgress((last = pct))
  }
  await ff(['-nostats', '-i', file, '-map', '0:a:0', '-vn', '-af', 'aresample=16000,asetnsamples=n=16000:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'], {
    onOut: (s) => { const ls = (rest + s).split('\n'); rest = ls.pop()!; ls.forEach(line) },
  })
  line(rest)
  return Array.from({ length: n }, (_, i) => db[i] ?? -100)
}

/** Je Zeitpunkt (s) ein rohes bgr24-Bild, side×side: Video seitenverhältnistreu so skaliert, dass die längere Seite = side ist, oben links eingepasst, Rest schwarz (Eingang für YuNet, 640×640 BGR).
 *  Zurückrechnen auf Videopixel: scale = side / max(w, h) (w/h aus probe, also schon gedreht); x_video = x_bild / scale, y_video = y_bild / scale. */
export async function rawFrames(file: string, times: number[], side = 640): Promise<Buffer[]> {
  const out: Buffer[] = []
  for (const t of times) {
    const raw = await ff(['-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `scale=${side}:${side}:force_original_aspect_ratio=decrease,format=bgr24,pad=${side}:${side}:0:0:black`, '-pix_fmt', 'bgr24', '-f', 'rawvideo', 'pipe:1'])
    if (raw.length !== side * side * 3) throw new Error(`Kein Bild bei ${t} s in ${basename(file)} (Video zu kurz?)`)
    out.push(raw)
  }
  return out
}

/** Kontaktabzug: n Standbilder (3 Spalten) gleichmäßig über die Clip-Zeitachse aller parts, je Kachel so zugeschnitten wie im Export, unten links die Clipzeit.
 *  Ein ffmpeg-Aufruf mit n Eingängen und xstack. times = Quellzeiten der Kachelmitten. ponytail: blur zeigt nur contain mit dunklem Rand (kein Weichzeichner); Upgrade: Filterkette aus export-video übernehmen. */
export async function contactSheet(file: string, parts: Part[], o: { size: { w: number; h: number }; fit?: Fit; n?: number; width?: number }): Promise<{ jpg: Buffer; times: number[] }> {
  const n = Math.max(2, o.n ?? 9), tw = Math.max(2, Math.round((o.width ?? 240) / 2) * 2), th = Math.max(2, Math.round((tw * o.size.h) / o.size.w / 2) * 2) // xstack braucht mindestens 2 Eingänge
  const total = partsLength(parts)
  if (!parts.length || total <= 0) throw new Error('Kontaktabzug: keine Ausschnitte')
  const info = await probe(file)
  const at: number[] = [], times: number[] = [], ps: Part[] = []
  for (let i = 0; i < n; i++) {
    let c = ((i + 0.5) * total) / n // Clipzeit der Kachelmitte
    at.push(c)
    const p = parts.find((q) => (c -= q.end - q.start) < 0) ?? parts[parts.length - 1]
    ps.push(p)
    times.push(Math.min(Math.max(0, p.start + c + (p.end - p.start)), Math.max(0, info.duration - 0.1)))
  }
  const blur = o.fit === 'blur' && Math.abs(info.w / info.h - o.size.w / o.size.h) > 0.01
  const build = (label: boolean) => {
    const g = times.map((_, i) => {
      const c = cropRect(info, o.size, ps[i].focus)
      const fit = blur ? `scale=${tw}:${th}:force_original_aspect_ratio=decrease,pad=${tw}:${th}:(ow-iw)/2:(oh-ih)/2:0x101010` : `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=${tw}:${th}`
      const txt = label ? `,drawtext=text='${at[i].toFixed(1)} s':fontsize=${Math.max(10, Math.round(tw / 16))}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=3:x=4:y=h-th-4` : ''
      return `[${i}:v]${fit},setsar=1${txt}[t${i}]`
    })
    const layout = times.map((_, i) => `${(i % 3) * tw}_${Math.floor(i / 3) * th}`).join('|')
    g.push(`${times.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${n}:layout=${layout}:fill=0x101010[v]`)
    return ['-filter_complex', g.join(';')]
  }
  const args = (label: boolean) => [...times.flatMap((t) => ['-threads', '1', '-ss', t.toFixed(3), '-i', file]), ...build(label), '-map', '[v]', '-frames:v', '1', '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']
  // drawtext braucht eine Schrift (fontconfig); fehlt sie oder der Filter, ohne Beschriftung
  const jpg = await ff(args(true)).catch(() => ff(args(false)))
  if (!jpg.length) throw new Error(`Kein Kontaktabzug aus ${basename(file)}`)
  return { jpg, times }
}
