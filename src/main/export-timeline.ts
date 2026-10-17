// Export der Pro-Timeline (Layout schnitt): je Abschnitt Ton und Bild einzeln kodieren, Ton zweistufig auf das Lautheitsziel, dann verbinden.
// Daneben Schnittliste (.xml) und Untertitel (.srt). Ohne Electron, damit der Selbsttest unter Node läuft.
import { copyFile, mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { cube1d, isNeutral, satFilter } from '../shared/grade'
import { deliverOf, tlDuration, type TimelineContent, type TLClip } from '../shared/timeline'
import { assSubs } from './export-video'
import { xmemlTimeline } from './export-xmeml-tl'
import { ffmpegBin, probe, run, runFfmpeg } from './ffmpeg'
import { audioArgs, audioCodec, encodeArgs, sections, size, videoArgs, type Section } from './timeline-ffmpeg'
import { measureR128 } from './timeline-media'
import { srt } from './video-fx'

type Info = { duration: number; w: number; h: number; fps?: number; audio: boolean }
const n3 = (k: number) => String(k).padStart(3, '0')
// Grobe Datenrate bei 1080p30 (Byte/s) für die Platzprüfung
const RATE: Record<string, number> = { h264: 1.5e6, 'h264-10': 2e6, prores: 27.5e6, dnxhr: 27.5e6 }

// probe verlangt eine Videospur; reine Tondateien (Musik, Sprecher) nur mit Dauer und Ton
async function info(file: string): Promise<Info> {
  try { return await probe(file) } catch (e) {
    const { err } = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-i', file])
    const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(err)
    if (!d || !/Stream #.* Audio: /.test(err)) throw e
    return { duration: +d[1] * 3600 + +d[2] * 60 + +d[3], w: 0, h: 0, audio: true }
  }
}

// Akzent für liste/markierung u. ä., solange die Timeline kein Theme kennt
const ACCENT = '#E8B04B'

// Archivo Bold wie subFont in export-video.ts; App-Pfad aus Electron, unter Node (Selbsttest) das Projekt. Ohne Datei nimmt libass eine Systemschrift.
async function font(dir: string) {
  const app = await import('electron').then((m) => m.app).catch(() => undefined)
  const f = await readFile(join(app?.getAppPath?.() ?? process.cwd(), 'assets/fonts/Archivo-Bold.ttf')).catch(() => null)
  await mkdir(join(dir, 'fonts'), { recursive: true })
  if (f) await writeFile(join(dir, 'fonts', 'font-0.ttf'), f)
}

// Quellen auflösen und prüfen: Kopie mit aufgelösten Pfaden; Clips aus Quellen ohne Ton gelten als stumm (audioArgs nimmt Ton an)
async function prepare(tl: TimelineContent, res: (src: string) => string) {
  const infos: Record<string, Info> = {}
  const rt: TimelineContent = { ...tl, tracks: tl.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, src: res(c.src) })) })) }
  for (const c of rt.tracks.flatMap((t) => t.clips)) infos[c.src] ??= await info(c.src)
  rt.tracks.forEach((t) => {
    t.clips.forEach((c) => {
      if (!infos[c.src].audio) c.mute = true
      if (t.kind === 'video' && !infos[c.src].w) throw new Error(`${basename(c.src)} hat kein Bild und kann nicht auf einer Videospur liegen. Tondateien gehören auf eine Audiospur.`)
    })
  })
  return { rt, infos }
}

const WAV = ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2']
// Ton je Abschnitt als WAV, dann zu work/mix.wav verbinden
async function mixAudio(secs: Section[], work: string) {
  // -t an der Ausgabe: amix+apad endet sonst nur über atrim, das hing einmal unter Last
  for (const [i, s] of secs.entries()) await runFfmpeg([...audioArgs(s), ...WAV, '-t', String(s.end - s.start), join(work, `a-${n3(i)}.wav`)])
  await writeFile(join(work, 'a.txt'), secs.map((_, i) => `file 'a-${n3(i)}.wav'`).join('\n'))
  await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'a.txt', '-c', 'copy', 'mix.wav'], { cwd: work })
  return join(work, 'mix.wav')
}

/** Nur den Ton-Mix rendern und messen (EBU R128), work danach weg. */
export async function measureTimeline(tl: TimelineContent, opts: { resolve: (src: string) => string; work: string }): Promise<{ i: number; tp: number; lra: number }> {
  if (!(tlDuration(tl) > 0)) throw new Error('Die Timeline ist leer: Erst Clips auf eine Spur legen.')
  const work = resolve(opts.work)
  await mkdir(work, { recursive: true })
  try {
    const { rt } = await prepare(tl, opts.resolve)
    const m = await measureR128(await mixAudio(sections(rt), work))
    return { i: m.i, tp: m.tp, lra: m.lra }
  } finally {
    if (!process.env.DW_KEEP_WORK) await rm(work, { recursive: true, force: true })
  }
}

export async function exportTimeline(tl: TimelineContent, opts: { out: string; aspect: number; resolve: (src: string) => string; onProgress?: (f: number, msg?: string) => void; work: string }): Promise<{ files: string[]; lufs: { before: number; after: number; target: number }; warnings: string[] }> {
  const deliver = deliverOf(tl), warnings: string[] = [], { w, h } = size(deliver, opts.aspect), enc = encodeArgs(deliver)
  const progress = opts.onProgress ?? (() => {})
  const dur = tlDuration(tl)
  if (!(dur > 0)) throw new Error('Die Timeline ist leer: Erst Clips auf eine Spur legen.')
  const work = resolve(opts.work) // ffmpeg läuft teils mit cwd = work
  await mkdir(work, { recursive: true })
  await mkdir(dirname(opts.out), { recursive: true })
  try {
    // 1) Quellen: Pfade auflösen, Ton erkennen
    const { rt, infos } = await prepare(tl, opts.resolve)
    const encoders = (await run(await ffmpegBin(), ['-hide_banner', '-encoders'])).out.toString()
    if (!new RegExp(`\\s${enc.encoder}\\s`).test(encoders)) throw new Error(`Das installierte ffmpeg kann nicht als ${deliver.codec} kodieren (Encoder ${enc.encoder} fehlt). Bitte ein ffmpeg mit ${enc.encoder} installieren oder H.264 wählen.`)
    // Platz grob vorab (Segmente + fertige Datei, WAV dreifach, ×1,2 Reserve): sonst bricht ffmpeg erst nach Minuten ab
    const vRate = (RATE[deliver.codec] * w * h * deliver.fps) / (1920 * 1080 * 30)
    const need = dur * (2 * vRate + 3 * 0.19e6) * 1.2, fs = await statfs(work), free = fs.bavail * fs.bsize
    if (free < need) throw new Error(`Zu wenig freier Speicherplatz für den Timeline-Export: nötig sind rund ${Math.ceil(need / 1e8) / 10} GB, frei ${Math.floor(free / 1e8) / 10} GB.`)

    // 2) LUT je Clip mit Farbkorrektur
    const luts = new Map<TLClip, string>()
    let k = 0
    for (const c of rt.tracks.flatMap((t) => t.clips)) {
      if (isNeutral(c.grade)) continue
      const f = join(work, `grade-${n3(++k)}.cube`)
      await writeFile(f, cube1d(c.grade))
      luts.set(c, f)
    }
    const secs = sections(rt)

    // 3) Ton je Abschnitt als WAV, dann verbinden
    progress(0, 'Ton')
    await mixAudio(secs, work)
    progress(0.08, 'Lautheit')

    // 4) Zweistufiges loudnorm wie finish() in export-video.ts; offset aus der Messung gilt für −23 LUFS und bleibt weg
    const target = deliver.lufs, m = await measureR128(join(work, 'mix.wav'))
    let mix = join(work, 'mix.wav'), after = m.i
    if ([m.i, m.tp, m.lra, m.thresh].every(Number.isFinite)) {
      mix = join(work, 'mixn.wav')
      await runFfmpeg(['-i', 'mix.wav', '-af', `loudnorm=I=${target}:TP=-1:LRA=11:measured_I=${m.i}:measured_TP=${m.tp}:measured_LRA=${m.lra}:measured_thresh=${m.thresh}:linear=true,aresample=48000`, ...WAV, 'mixn.wav'], { cwd: work })
      after = (await measureR128(mix)).i
    } else warnings.push('Der Ton ist still, die Lautheit wurde nicht angepasst.')
    progress(0.12, 'Bild')

    // 5) Bild je Abschnitt, Fortschritt anteilig nach Länge (12–92 %)
    // Einblendungen und Untertitel je Abschnitt auf ihn beschnitten (Zeiten ab Abschnittsanfang); Blende nur an echten Enden, el: schon gelaufene Zeit (liste)
    const ovs = (tl.overlays ?? []).filter((x) => x.text?.trim() || x.items?.length || (x.art === 'markierung' && x.box) || (x.art === 'verpixeln' && x.box))
    // ponytail: Untertitel immer als Zeile (satz), 'wort' bräuchte Wortzeiten in tl.subs
    const subs = tl.captions === 'aus' ? [] : tl.subs ?? []
    if (ovs.some((x) => x.art !== 'verpixeln') || subs.length) await font(work)
    const pix = enc.args[enc.args.indexOf('-pix_fmt') + 1]
    let done = 0
    for (const [i, s] of secs.entries()) {
      const len = s.end - s.start, a = videoArgs(s, deliver, opts.aspect, (c) => luts.get(c) ?? null, satFilter)
      const cut = <T extends { start: number; end: number }>(xs: T[]) => xs.filter((x) => x.end > s.start && x.start < s.end)
        .map((x) => ({ ...x, start: Math.max(0, x.start - s.start), end: Math.min(len, x.end - s.start), el: Math.max(0, s.start - x.start), len: x.end - x.start, fade: [x.start >= s.start - 1e-3, x.end <= s.end + 1e-3] as [boolean, boolean] }))
      const here = cut(ovs), texts = here.filter((x) => x.art !== 'verpixeln'), cues = cut(subs).map((x) => ({ start: x.start, end: x.end, words: [{ w: x.text, start: x.start, end: x.end }] }))
      // Verpixeln wie in export-video.ts: Bereich (Anteile des Bildes, gerade px) klein rechnen und blockig zurück
      const g: string[] = []
      let cv = '[vout]'
      here.filter((x) => x.art === 'verpixeln').forEach((x, j) => {
        const [bx, by, bw, bh] = x.box!, even = (v: number) => Math.max(2, Math.round(v / 2) * 2), blk = Math.max(4, Math.round(Math.min(w, h) / 36))
        const cw = Math.min(even(bw * w), w), ch = Math.min(even(bh * h), h), cx = Math.min(even(bx * w), w - cw), cy = Math.min(even(by * h), h - ch)
        g.push(`${cv}split[pa${j}][pb${j}]`, `[pb${j}]crop=${cw}:${ch}:${cx}:${cy},scale=${Math.max(1, Math.round(cw / blk))}:${Math.max(1, Math.round(ch / blk))}:flags=area,scale=${cw}:${ch}:flags=neighbor[pc${j}]`,
          `[pa${j}][pc${j}]overlay=${cx}:${cy}:enable='between(t,${x.start},${x.end})'[px${j}]`)
        cv = `[px${j}]`
      })
      let ass = ''
      if (texts.length || cues.length) {
        await writeFile(join(work, `s-${n3(i)}.ass`), assSubs({ size: { w, h }, font: 'Archivo', bold: true, accent: ACCENT, hookDur: 0, cues, mode: cues.length ? 'satz' : 'aus', ...(texts.length ? { overlays: texts } : {}) }))
        ass = `ass=s-${n3(i)}.ass:fontsdir=fonts,` // relativ zu cwd = work: kein Pfad-Escaping im Filter
      }
      const fi = a.indexOf('-filter_complex')
      a[fi + 1] += `;${[...g, `${cv}${ass}format=${pix}[vf]`].join(';')}`
      a[a.lastIndexOf('[vout]')] = '[vf]'
      await runFfmpeg([...a, ...enc.args, '-an', '-t', String(len), join(work, `v-${n3(i)}.${enc.ext}`)],
        { cwd: work, duration: len, onProgress: (p) => progress(0.12 + (0.8 * (done + (len * p) / 100)) / dur, 'Bild') })
      done += len
    }

    // 6) Segmente kopieren, Ton einmal kodieren
    progress(0.92, 'Verbinden')
    await writeFile(join(work, 'v.txt'), secs.map((_, i) => `file 'v-${n3(i)}.${enc.ext}'`).join('\n'))
    const tmp = join(work, `out.${enc.ext}`), file = `${opts.out}.${enc.ext}`
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', 'v.txt', '-i', mix, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...audioCodec(deliver),
      ...(enc.ext === 'mp4' ? ['-movflags', '+faststart'] : []), tmp], { cwd: work })
    await rename(tmp, file).catch(() => copyFile(tmp, file)) // work kann auf einem anderen Datenträger liegen
    const files = [file]

    // 7) Schnittliste und Untertitel daneben
    await writeFile(`${opts.out}.xml`, xmemlTimeline(rt, { name: basename(opts.out), fps: deliver.fps, w, h, info: infos }), 'utf8')
    files.push(`${opts.out}.xml`)
    if (tl.subs?.length) {
      await writeFile(`${opts.out}.srt`, srt(tl.subs.map((s) => ({ start: s.start, end: s.end, words: [{ w: s.text, start: s.start, end: s.end }] }))), 'utf8')
      files.push(`${opts.out}.srt`)
    }
    progress(1)
    return { files, lufs: { before: m.i, after, target }, warnings }
  } finally {
    if (!process.env.DW_KEEP_WORK) await rm(work, { recursive: true, force: true })
  }
}
