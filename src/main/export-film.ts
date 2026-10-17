// Film-Export (Feature „Animation“): Deck mit film → ein MP4. Jede Szene Frame für Frame aus dem Film-Host (render.ts renderFilm), Rohbilder per stdin
// an ffmpeg, dazu Stimme (voice.ts), Originalton von Bildschirmaufnahmen und Untertitel. Nähte, Musik und Lautheit wie im Video-Export (export-video.ts).
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { sizeOf, transitionOf, type Deck, type Slide } from '../shared/deck'
import { FPS, sceneTimeline, type VoiceTiming } from '../shared/film'
import { resolveTheme } from '../shared/themes'
import { XFADE, outSize, type Cue } from '../shared/video'
import { PCM, assSubs, finish, joinSegs, presetFor, subFont, video, videoPath, type Music, type Seg } from './export-video'
import { ffmpegBin, probe } from './ffmpeg'
import { renderFilm, type FilmScene } from './render'
import { srt } from './video-fx'

const BLEND = 0.5 // Überblendung an einer Naht (joinSegs: 15 Frames)
const UNDER = 0.35 // Originalton einer Aufnahme unter der Stimme
const n2 = (i: number) => String(i).padStart(2, '0')
const sec = (s: number) => s.toFixed(3)

/** xfade-Typ der Naht vor Szene i, undefined = harter Schnitt. Im Film blenden auch Standbild-Szenen über, nie über Schwarz wie im Clip-Weg.
 *  ponytail: morph wird zur Überblendung, kein FLIP der gleichnamigen Elemente; Upgrade: Morph-Paare im Film-Host über die Naht animieren */
const blendOf = (deck: Deck, i: number) => { const t = transitionOf(deck, i); return t === 'morph' ? 'fade' : XFADE[t] }

/** Zeitachse der Szene i wie im Export (auch für Vorschau-Frames): lead = Überblendung davor, times = Frames ab 0 bis zum letzten bewegten Bild,
 *  danach hält der Export das Bild bis dur. */
export function planScene(deck: Deck, i: number, scene: FilmScene, voice?: VoiceTiming) {
  const lead = blendOf(deck, i) ? BLEND : 0
  const tl = sceneTimeline({ ...scene, voice, duration: deck.slides[i].duration, lead })
  const n = Math.min(Math.max(1, Math.round(tl.dur * FPS)), Math.ceil(tl.hold * FPS - 1e-6) + 1)
  return { ...tl, lead, times: Array.from({ length: n }, (_, k) => k / FPS) }
}

/** ffmpeg mit Rohbildern über stdin; write wartet, solange die Pipe voll ist. Stirbt ffmpeg, scheitern write und end mit seiner Meldung. */
async function encoder(args: string[], cwd: string) {
  const p = spawn(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-y', ...args], { cwd, stdio: ['pipe', 'ignore', 'pipe'] })
  let err = ''
  p.stderr.on('data', (c: Buffer) => { err = (err + c).slice(-65536) })
  p.stdin.on('error', () => {}) // EPIPE nach einem Abbruch: den Grund meldet done
  const done = new Promise<void>((ok, fail) => {
    p.on('error', fail)
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg fehlgeschlagen (Code ${code}):\n${err.trim().split('\n').slice(-15).join('\n')}`))))
  })
  done.catch(() => {}) // gemeldet über write/end
  return {
    write: async (b: Buffer) => { if (!p.stdin.write(b)) await Promise.race([once(p.stdin, 'drain').catch(() => done), done]) }, // EPIPE: ffmpegs Meldung statt „write EPIPE“
    end: () => (p.stdin.end(), done),
    kill: () => { if (p.exitCode === null) p.kill('SIGKILL') },
  }
}

type Voice = { wav: string; timing: VoiceTiming }

/** Film-Deck (nur sichtbare Folien) als `${base}.mp4`, daneben `${base}.srt`, wenn gesprochen wird. Fortschritt 0–100 nach Szenenlänge gewichtet. */
export async function exportFilm(deck: Deck, target: string, o: { voiceOf: (slide: Slide) => Promise<Voice | undefined>; music?: Music; onProgress?: (pct: number) => void }): Promise<string[]> {
  const base = resolve(target), parent = dirname(base), onProgress = o.onProgress ?? (() => {})
  const size = outSize(sizeOf(deck)), accent = resolveTheme(deck.theme).c.accent
  // Stimmen vorab: sie bestimmen die Szenenlängen, daraus Gewichte und Platzbedarf (Schätzung, die Takte kennt erst der Film-Host)
  const voices: (Voice | undefined)[] = []
  for (const s of deck.slides) voices.push(await o.voiceOf(s))
  const weights = deck.slides.map((s, i) => sceneTimeline({ steps: [], voice: voices[i]?.timing, duration: s.duration, words: 0, lead: 0 }).dur)
  const sum = weights.reduce((a, b) => a + b, 0), total = sum * 1.2, preset = presetFor(sum) // 0,2: Endschritt
  // Platz grob vorab wie im Video-Export (H.264 ~1,5 MB/s bei 1080p, PCM 0,19 MB/s, ×1,5 Reserve)
  await mkdir(parent, { recursive: true })
  const need = sum * ((1.5e6 * size.w * size.h) / (1920 * 1080) + 0.19e6) * 1.5, fs = await statfs(parent), free = fs.bavail * fs.bsize
  if (free < need) throw new Error(`Zu wenig freier Speicherplatz für den Video-Export: nötig sind rund ${Math.ceil(need / 1e8) / 10} GB, frei ${Math.floor(free / 1e8) / 10} GB.`)
  // Job-Ordner neben dem Ziel, nicht /tmp (tmpfs); Reste nach einem Absturz räumt der nächste Video-Export weg (exportOnce)
  const dir = join(parent, `.video-tmp-${randomBytes(4).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  let enc: Awaited<ReturnType<typeof encoder>> | undefined
  try {
    const satz = deck.film?.captions === 'satz' && voices.some(Boolean)
    const font = satz ? await subFont(deck) : undefined
    if (font) { // eigener Unterordner wie im Clip-Weg: libass lädt alles in fontsdir
      await mkdir(join(dir, 'fonts'), { recursive: true })
      await Promise.all(font.files.map((b, k) => writeFile(join(dir, 'fonts', `font-${k}.ttf`), b)))
    }
    const all: Seg[] = []
    let done = 0
    for (const [i, slide] of deck.slides.entries()) {
      const name = `szene-${n2(i + 1)}`, file = join(dir, `${name}.mkv`), v = voices[i]
      // Bildschirmaufnahme (Layout screen): Bild ab from, je Frame gespult ab Szenenbeginn (renderer/film.ts), der Originalton genauso
      const c = slide.layout === 'screen' ? (slide.content as { video?: string; from?: number; to?: number; muted?: boolean }) : {}
      const src = c.video && !c.muted ? videoPath(c.video, i + 1) : undefined
      const srcAudio = !!src && (await probe(src).catch((e: Error) => { throw new Error(`Folie ${i + 1}: ${e.message}`) })).audio
      let tl!: ReturnType<typeof planScene>, n = 0
      const t0 = Date.now()
      await renderFilm(deck, i, { width: size.w, plan: (scene) => (tl = planScene(deck, i, scene, v?.timing)) }, async (_t, img) => {
        if (!enc) { // erst beim ersten Bild: dessen Größe braucht rawvideo
          const { width, height } = img.getSize(), N = Math.max(1, Math.round(tl.dur * FPS)), D = N / FPS, pad = N - tl.times.length
          const cues: Cue[] = (v?.timing.cues ?? []).map((x) => ({ ...x, start: x.start + tl.lead, end: x.end + tl.lead }))
          if (satz && cues.length) await writeFile(join(dir, `${name}.ass`), assSubs({ size, font: font!.name, bold: font!.bold, accent, hookDur: 0, cues, mode: 'satz' }))
          // toBitmap: BGRA unter Linux und Windows (Skia N32)
          const inputs = ['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${width}x${height}`, '-framerate', String(FPS), '-i', 'pipe:0']
          const tracks: string[] = [], fmt = 'aformat=sample_rates=48000:channel_layouts=stereo'
          if (v) { tracks.push(`[1:a]${fmt},adelay=${Math.round(tl.lead * 1000)}:all=1`); inputs.push('-i', v.wav) } // Stimme nach der Blende
          if (srcAudio) {
            const from = c.from ?? 0
            tracks.push(`[${tracks.length + 1}:a]${fmt},volume=${v ? UNDER : 1}`)
            inputs.push('-ss', sec(from), '-t', sec(Math.min(D, (c.to ?? Infinity) - from)), '-i', src!)
          }
          const mix = tracks.length > 1 ? `${tracks[0]}[t0];${tracks[1]}[t1];[t0][t1]amix=inputs=2:normalize=0:duration=longest` : tracks[0] ?? 'anullsrc=r=48000:cl=stereo'
          const vf = [pad > 0 && `tpad=stop_mode=clone:stop=${pad}`, `scale=${size.w}:${size.h}`, 'setsar=1', 'format=yuv420p', satz && cues.length && `ass=${name}.ass:fontsdir=fonts`]
          enc = await encoder([...inputs, '-filter_complex', `[0:v]${vf.filter(Boolean).join(',')}[v];${mix},apad=whole_dur=${sec(D)},atrim=duration=${sec(D)}[a]`,
            '-map', '[v]', '-map', '[a]', ...video(preset), ...PCM, file], dir)
          all.push({ file, dur: D, ...(cues.length ? { cues } : {}) })
        }
        await enc.write(img.toBitmap())
        onProgress(Math.min(99, Math.floor(((done + (weights[i] * ++n) / tl.times.length) / total) * 100)))
      })
      await enc!.end()
      enc = undefined
      console.info(`[film] Szene ${i + 1}: ${n} Frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
      done += weights[i]
      const t = blendOf(deck, i)
      if (t) { // Naht mit Überblendung: beide Nahtstücke zu einem, die alten sofort weg
        const b = all.pop()!, a = all.pop()!
        all.push(await joinSegs(a, b, t, join(dir, `${name}-x.mkv`), dir, preset))
        await Promise.all([a, b].map((x) => rm(x.file, { force: true })))
      }
    }
    await finish(all, join(dir, 'gesamt.mp4'), dir, { loudnorm: true, music: o.music, onProgress: (p) => onProgress(Math.min(99, Math.floor(((sum + (sum * 0.2 * p) / 100) / total) * 100))) })
    let off = 0
    const subs = all.flatMap((x) => { const r = (x.cues ?? []).map((c) => ({ ...c, start: c.start + off, end: c.end + off })); off += x.dur; return r })
    if (subs.length) await writeFile(join(dir, 'gesamt.srt'), srt(subs), 'utf8')
    // erst am Ende umbenennen (Job-Ordner im selben Dateisystem): ein Abbruch lässt den letzten guten Export stehen
    if (subs.length) await rename(join(dir, 'gesamt.srt'), `${base}.srt`)
    else await rm(`${base}.srt`, { force: true }) // keine alte Fassung neben dem neuen Film
    await rename(join(dir, 'gesamt.mp4'), `${base}.mp4`)
    onProgress(100)
    return [`${base}.mp4`]
  } finally {
    enc?.kill()
    await rm(dir, { recursive: true, force: true })
  }
}
