// Medien-Helfer für die Pro-Timeline: Wellenform-Spitzen, Schnitt-Proxys, R128-Messung. Ohne Electron, damit Selbsttests unter Node laufen.
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ffmpegBin, probe, run, runFfmpeg } from './ffmpeg'

/** Wellenform: je 1/perSec s das Maximum |x| (mono 8 kHz) als 0..255. Gestreamt, das PCM liegt nie ganz im Speicher. */
export async function peaks(file: string, perSec = 100): Promise<Uint8Array> {
  const win = Math.max(1, Math.round(8000 / perSec))
  const out: number[] = []
  let rest: Buffer = Buffer.alloc(0), max = 0, n = 0
  const r = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], {
    onBin: (c) => {
      const b = rest.length ? Buffer.concat([rest, c]) : c // ein Float kann über die Chunk-Grenze reichen
      const end = b.length & ~3
      for (let o = 0; o < end; o += 4) {
        const x = Math.abs(b.readFloatLE(o))
        if (x > max) max = x
        if (++n === win) { out.push(Math.round(Math.min(1, max) * 255)); max = 0; n = 0 }
      }
      rest = b.subarray(end)
    },
  })
  if (r.code !== 0) throw new Error(`Wellenform von ${basename(file)} nicht lesbar:\n${r.err.trim().split('\n').slice(-5).join('\n')}`)
  if (n) out.push(Math.round(Math.min(1, max) * 255))
  return Uint8Array.from(out)
}

/** peaks mit Ablage in <cacheDir>/peaks-<perSec>.u8 (cacheDir z. B. assets/.video/<sha1>). */
export async function cachedPeaks(file: string, cacheDir: string, perSec = 100): Promise<Uint8Array> {
  const f = join(cacheDir, `peaks-${perSec}.u8`)
  if (existsSync(f)) return new Uint8Array(await readFile(f))
  const p = await peaks(file, perSec)
  await mkdir(cacheDir, { recursive: true })
  const tmp = `${f}.${process.pid}` // App und MCP-Server können parallel schreiben; rename ersetzt atomar
  await writeFile(tmp, p)
  await rename(tmp, f)
  return p
}

/** Proxy nötig: kurze Seite über 1080 oder ein schwer dekodierbarer Codec (ProRes, DNxHD, HEVC 10 bit). codec ist der Codec-Text, falls bekannt (z. B. die Stream-Zeile von ffmpeg). */
export function needsProxy(info: { w: number; h: number }, codec?: string): boolean {
  if (Math.min(info.w, info.h) > 1080) return true
  if (!codec) return false
  const c = codec.toLowerCase()
  return /prores|dnxh/.test(c) || (/hevc|h\.?265/.test(c) && /10le|main ?10|10[ -]?bit/.test(c))
}

/** Schnitt-Proxy: kurze Seite 540, H.264 ultrafast crf 28, AAC 128k, faststart. Liegt out schon da, sofort zurück. */
export async function proxy(file: string, out: string, onProgress?: (pct: number) => void): Promise<string> {
  if (existsSync(out)) return out
  const info = await probe(file)
  await mkdir(dirname(out), { recursive: true })
  const tmp = `${out}.${process.pid}.part` // halbe Proxys nie unter dem Zielnamen
  try {
    await runFfmpeg(['-i', file, '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)'",
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-f', 'mp4', tmp],
      { duration: info.duration, onProgress })
    await rename(tmp, out)
  } finally {
    await rm(tmp, { force: true })
  }
  return out
}

/** EBU R128 (loudnorm, erster Durchgang): integrierte Lautheit i (LUFS), lra (LU), True Peak tp (dBTP), Gate thresh (LUFS), offset (LU) zum Ziel −23 LUFS. */
export async function measureR128(file: string): Promise<{ i: number; lra: number; tp: number; thresh: number; offset: number }> {
  const r = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-map', '0:a:0', '-vn', '-af', 'loudnorm=I=-23:print_format=json', '-f', 'null', '-'])
  const m = r.code === 0 ? /\{[^{}]*"input_i"[^{}]*\}/.exec(r.err) : null
  if (!m) throw new Error(`Lautheit von ${basename(file)} nicht messbar:\n${r.err.trim().split('\n').slice(-5).join('\n')}`)
  const j = JSON.parse(m[0]) as Record<string, string>
  return { i: +j.input_i, lra: +j.input_lra, tp: +j.input_tp, thresh: +j.input_thresh, offset: +j.target_offset }
}
