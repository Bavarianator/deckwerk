// ffmpeg für den Video-Schnitt: Binary finden oder laden, Aufrufe mit Fortschritt, Probe, Standbilder, PCM für Whisper.
// Ohne Electron, damit Selbsttests es unter Node nutzen können.
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import type { VideoInfo } from '../shared/video'
import { download } from './download'

// Statische Builds mit libass und libx264 (ffmpeg-static, GPL); darwin-arm64 für den Mac-Fork
const BUILDS: Record<string, { url: string; sha256: string }> = {
  'linux-x64': { url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz', sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa' },
  'darwin-arm64': { url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz', sha256: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa' },
}

const home = () => process.env.DECKWERK_HOME ?? join(homedir(), 'Deckwerk')

// Ein Aufruf ohne Shell; stdout gesammelt (oder an onOut), von stderr nur das Ende
function run(bin: string, args: string[], cwd?: string, onOut?: (s: string) => void) {
  return new Promise<{ code: number | null; out: Buffer; err: string }>((resolve, reject) => {
    const p = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    p.stdout.on('data', (c: Buffer) => (onOut ? onOut(c.toString()) : out.push(c)))
    p.stderr.on('data', (c: Buffer) => { err = (err + c).slice(-65536) })
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

async function ff(args: string[], cwd?: string, onOut?: (s: string) => void) {
  const r = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-y', ...args], cwd, onOut)
  if (r.code !== 0) throw new Error(`ffmpeg fehlgeschlagen (Code ${r.code}):\n${r.err.trim().split('\n').slice(-15).join('\n')}`)
  return r.out
}

/** ffmpeg-Aufruf; mit duration (s) und onProgress meldet er 0–100 über -progress. */
export async function runFfmpeg(args: string[], o: { cwd?: string; duration?: number; onProgress?: (pct: number) => void } = {}): Promise<void> {
  const { duration, onProgress } = o
  if (!duration || !onProgress) return void (await ff(['-nostats', ...args], o.cwd))
  let last = -1 // nur steigend melden: mit loudnorm (Vorlauf) springt out_time zurück
  await ff(['-nostats', '-progress', 'pipe:1', ...args], o.cwd, (s) => {
    for (const m of s.matchAll(/out_time_us=(\d+)\n/g)) {
      const pct = Math.min(100, Math.floor(Number(m[1]) / 1e4 / duration))
      if (pct > last) onProgress((last = pct))
    }
  })
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
  return { duration: +d[1] * 3600 + +d[2] * 60 + +d[3], w, h, audio: streams.some((s) => / Audio: /.test(s.split('\n')[0])) }
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

/** Ton als Float32 mono 16 kHz, so wie Whisper ihn erwartet. */
export async function pcm16k(file: string): Promise<Float32Array> {
  const b = await ff(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1']).catch((e: Error) => {
    throw /does not contain any stream|matches no streams/i.test(e.message) ? new Error(`${basename(file)} hat keine Tonspur, es gibt nichts zu transkribieren.`) : e
  })
  const n = b.length >> 2
  return b.byteOffset % 4 ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + n * 4)) : new Float32Array(b.buffer, b.byteOffset, n)
}
