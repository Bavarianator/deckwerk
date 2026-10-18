// Film-Export (Feature „Animation“): Deck mit film → ein MP4. Jede Szene Frame für Frame aus dem Film-Host (render.ts renderFilm) als MJPEG-Datei,
// dann ein ffmpeg-Schritt mit Stimme (voice.ts), Originalton von Bildschirmaufnahmen und Untertiteln. Kodieren kann das Handy (Handy-Option wie
// im Clip-Weg), die Bilder rendert immer der PC. Nähte, Musik und Lautheit wie im Video-Export (export-video.ts).
import { randomBytes } from 'node:crypto'
import { appendFile, copyFile, mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { sizeOf, transitionOf, type Deck, type Slide } from '../shared/deck'
import { FPS, sceneTimeline, type VoiceTiming } from '../shared/film'
import { resolveTheme } from '../shared/themes'
import { XFADE, outSize, type Cue } from '../shared/video'
import { PCM, assSubs, ffx, finish, joinSegs, phoneFault, withMusicGain, presetFor, subFont, video, videoPath, type Music, type Phone, type Seg } from './export-video'
import { probe } from './ffmpeg'
import { renderFilm, type FilmScene } from './render'
import { srt } from './video-fx'

const BLEND = 0.5 // Überblendung an einer Naht (joinSegs: 15 Frames)
const UNDER = 0.35 // Originalton einer Aufnahme unter der Stimme
const JPEG = 92 // Qualität der Zwischenbilder; x264 (crf 20) kodiert sie danach ohnehin verlustbehaftet
const RENDER = 0.7 // Anteil des Renderns am Fortschritt einer Szene, der Rest ist Kodieren
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

// Untertitel im Film auf einem halbtransparenten dunklen Kasten (64 % Schwarz, ein Kasten je Untertitel: BorderStyle 4 in libass): Folien haben
// unten oft eigenen Text, darüber war die Kontur aus dem Clip-Weg schwer lesbar. Outline gibt den Innenabstand, die Kontur selbst ist durchsichtig.
const boxed = (ass: string, pad: number) => ass.replace(/^Style: Cap,.*$/m, (l) => {
  const f = l.split(',') // Format-Zeile in assSubs: OutlineColour, BackColour … BorderStyle, Outline, Shadow
  ;[f[5], f[6], f[15], f[16], f[17]] = ['&HFF000000', '&H5C000000', '4', String(pad), '0']
  return f.join(',')
})

type Voice = { wav: string; timing: VoiceTiming }

/** Film-Deck (nur sichtbare Folien) als `${base}.mp4`, daneben `${base}.srt`, wenn gesprochen wird. Fortschritt 0–100 nach Szenenlänge gewichtet.
 *  phone: Szenen, Nähte und Endschritt kodiert das Handy; scheitert es, rechnet der PC weiter (ffx, phoneFault). */
export async function exportFilm(deck: Deck, target: string, o: { voiceOf: (slide: Slide) => Promise<Voice | undefined>; music?: Music; onProgress?: (pct: number) => void; phone?: Phone }): Promise<string[]> {
  const base = resolve(target), parent = dirname(base), onProgress = o.onProgress ?? (() => {})
  phoneFault.reason = ''
  const size = outSize(sizeOf(deck)), accent = resolveTheme(deck.theme).c.accent
  // Stimmen vorab: sie bestimmen die Szenenlängen, daraus Gewichte und Platzbedarf (Schätzung, die Takte kennt erst der Film-Host)
  const voices: (Voice | undefined)[] = []
  for (const s of deck.slides) voices.push(await o.voiceOf(s))
  const weights = deck.slides.map((s, i) => sceneTimeline({ steps: [], voice: voices[i]?.timing, duration: s.duration, words: 0, lead: 0 }).dur)
  const sum = weights.reduce((a, b) => a + b, 0), total = sum * 1.2, preset = presetFor(sum) // 0,2: Endschritt
  // Platz grob vorab wie im Video-Export (H.264 ~1,5 MB/s bei 1080p, PCM 0,19 MB/s, ×1,5 Reserve), dazu die MJPEG-Bilder der längsten Szene (~300 kB je Bild bei 1080p)
  // ponytail: Szenenlänge geschätzt ohne Videomaterial (kennt erst der Film-Host); Upgrade: from/to bzw. probe der Aufnahmen einrechnen
  await mkdir(parent, { recursive: true })
  const px = (size.w * size.h) / (1920 * 1080)
  const need = sum * (1.5e6 * px + 0.19e6) * 1.5 + Math.max(0, ...weights) * FPS * 3e5 * px, fs = await statfs(parent), free = fs.bavail * fs.bsize
  if (free < need) throw new Error(`Zu wenig freier Speicherplatz für den Video-Export: nötig sind rund ${Math.ceil(need / 1e8) / 10} GB, frei ${Math.floor(free / 1e8) / 10} GB.`)
  // Job-Ordner neben dem Ziel, nicht /tmp (tmpfs); Reste nach einem Absturz räumt der nächste Video-Export weg (exportOnce)
  const dir = join(parent, `.video-tmp-${randomBytes(4).toString('hex')}`)
  await mkdir(dir, { recursive: true })
  try {
    const satz = deck.film?.captions === 'satz' && voices.some(Boolean)
    const font = satz ? await subFont(deck) : undefined
    const all: Seg[] = []
    let done = 0, sound = !!o.music || voices.some(Boolean)
    for (const [i, slide] of deck.slides.entries()) {
      // Arbeitsordner je Szene, Name eindeutig auch auf dem Handy: phoneFfmpeg schiebt den ganzen Ordner, so nur diese Szene statt aller Segmente
      const name = `szene-${n2(i + 1)}`, v = voices[i], w = weights[i], sub = join(dir, `${basename(dir)}-${n2(i + 1)}`), file = join(sub, `${name}.mkv`)
      await mkdir(sub)
      // Bildschirmaufnahme (Layout screen): Bild ab from, je Frame gespult ab Szenenbeginn (renderer/film.ts), der Originalton genauso
      const c = slide.layout === 'screen' ? (slide.content as { video?: string; from?: number; to?: number; muted?: boolean }) : {}
      const src = c.video && !c.muted ? videoPath(c.video, i + 1) : undefined
      const srcAudio = !!src && (await probe(src).catch((e: Error) => { throw new Error(`Folie ${i + 1}: ${e.message}`) })).audio
      let tl!: ReturnType<typeof planScene>, n = 0
      const t0 = Date.now()
      // Bilder als JPEG hintereinander (MJPEG): das Kodieren ist danach ein gewöhnlicher ffmpeg-Schritt, den auch das Handy rechnen kann
      await renderFilm(deck, i, { width: size.w, plan: (scene) => (tl = planScene(deck, i, scene, v?.timing)) }, async (_t, img) => {
        await appendFile(join(sub, 'bilder.mjpeg'), img.toJPEG(JPEG))
        onProgress(Math.min(99, Math.floor(((done + (w * RENDER * ++n) / tl.times.length) / total) * 100)))
      })
      const t1 = Date.now(), N = Math.max(1, Math.round(tl.dur * FPS)), D = N / FPS, pad = N - n
      const cues: Cue[] = (v?.timing.cues ?? []).map((x) => ({ ...x, start: x.start + tl.lead, end: x.end + tl.lead }))
      if (satz && cues.length) { // Schriften in fonts/ wie im Clip-Weg: libass lädt alles in fontsdir
        await writeFile(join(sub, `${name}.ass`), boxed(assSubs({ size, font: font!.name, bold: font!.bold, accent, hookDur: 0, cues, mode: 'satz' }), Math.round(Math.min(size.w, size.h) * 0.012)))
        await mkdir(join(sub, 'fonts'))
        await Promise.all(font!.files.map((b, k) => writeFile(join(sub, 'fonts', `font-${k}.ttf`), b)))
      }
      const inputs = ['-f', 'mjpeg', '-framerate', String(FPS), '-i', 'bilder.mjpeg']
      const tracks: string[] = [], fmt = 'aformat=sample_rates=48000:channel_layouts=stereo'
      if (v) { // Stimme nach der Blende; als Kopie im Szenenordner, sonst verdrängte sie die Quellvideos aus dem Handy-Cache
        await copyFile(v.wav, join(sub, 'stimme.wav'))
        tracks.push(`[1:a]${fmt},adelay=${Math.round(tl.lead * 1000)}:all=1`)
        inputs.push('-i', 'stimme.wav')
      }
      if (srcAudio) { // Quelle außerhalb des Ordners: phoneFfmpeg legt sie gecacht aufs Handy
        const from = c.from ?? 0
        sound = true
        tracks.push(`[${tracks.length + 1}:a]${fmt},volume=${v ? UNDER : 1}`)
        inputs.push('-ss', sec(from), '-t', sec(Math.min(D, (c.to ?? Infinity) - from)), '-i', src!)
      }
      const mix = tracks.length > 1 ? `${tracks[0]}[t0];${tracks[1]}[t1];[t0][t1]amix=inputs=2:normalize=0:duration=longest` : tracks[0] ?? 'anullsrc=r=48000:cl=stereo'
      const vf = [pad > 0 && `tpad=stop_mode=clone:stop=${pad}`, `scale=${size.w}:${size.h}`, 'setsar=1', 'format=yuv420p', satz && cues.length && `ass=${name}.ass:fontsdir=fonts`]
      await ffx([...inputs, '-filter_complex', `[0:v]${vf.filter(Boolean).join(',')}[v];${mix},apad=whole_dur=${sec(D)},atrim=duration=${sec(D)}[a]`, '-map', '[v]', '-map', '[a]', ...video(preset), ...PCM, file],
        { cwd: sub, duration: D, onProgress: (p) => onProgress(Math.min(99, Math.floor(((done + w * RENDER + (w * (1 - RENDER) * p) / 100) / total) * 100))) }, o.phone)
      await rm(join(sub, 'bilder.mjpeg'))
      let seg: Seg = { file, dur: D, ...(cues.length ? { cues } : {}) }
      const t = blendOf(deck, i)
      if (t) { // Naht mit Überblendung: das Stück davor in den Szenenordner, beide zu einem, die alten sofort weg
        const prev = all.pop()!, a = { ...prev, file: join(sub, basename(prev.file)) }
        await rename(prev.file, a.file)
        seg = await joinSegs(a, seg, t, join(sub, `${name}-x.mkv`), sub, preset, o.phone)
        await Promise.all([a.file, file].map((f) => rm(f, { force: true })))
      }
      await rename(seg.file, join(dir, basename(seg.file)))
      all.push({ ...seg, file: join(dir, basename(seg.file)) })
      await rm(sub, { recursive: true, force: true })
      console.info(`[film] Szene ${i + 1}: ${n} Frames gerendert in ${((t1 - t0) / 1000).toFixed(1)} s, kodiert in ${((Date.now() - t1) / 1000).toFixed(1)} s (${o.phone && !o.phone.failed ? 'Handy' : 'PC'})`)
      done += w
    }
    // stummer Film: nichts anzugleichen, und loudnorm macht aus Stille unter 3 s NaN (AAC bricht ab)
    await finish(all, join(dir, 'gesamt.mp4'), dir, { loudnorm: sound, music: o.music && await withMusicGain(o.music), phone: o.phone, onProgress: (p) => onProgress(Math.min(99, Math.floor(((sum + (sum * 0.2 * p) / 100) / total) * 100))) })
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
    await rm(dir, { recursive: true, force: true })
  }
}
