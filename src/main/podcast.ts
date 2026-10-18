// Podcast-Export (mp3, m4a): Episode aus deck.podcast (shared/podcast.ts) oder den Clip-Folien als fertige Tondatei mit Kapiteln. Alles über ffmpeg, ohne Electron (Selbsttest scripts/check-podcast.ts).
// Kette: Spuren (gain) mischen → Schnitte (atrim + 10-ms-Blenden an jeder Naht) → Sprachkette (ton) → Intro/Outro überblendet → Soundeffekte → Musik geduckt → loudnorm −16 LUFS in zwei Durchgängen.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dataDir } from './clients'
import { basename, dirname, join, resolve } from 'node:path'
import type { Deck } from '../shared/deck'
import { LUFS, deckToEpisode, editedLength, inCut, keepRanges, normCuts, toEdited, type Episode } from '../shared/podcast'
import { DUCK, type ClipContent } from '../shared/video'
import { SPEECH, checkMusic, duckMusic, measuredNorm, mediaPath, sfxGraph, sweepStale } from './export-video'
import { ffmpegBin, probe, run, runFfmpeg } from './ffmpeg'

const XF = 1 // Überblendung Intro/Outro (s)
const SEAM = 0.01 // Blende an jeder Schnittnaht (s) gegen Knackser
const FMT = 'aformat=sample_rates=48000:channel_layouts=stereo'
const sec = (s: number) => s.toFixed(3)
const home = dataDir
// Caches im selben Punktordner wie die Video-Caches der Engine (baseOf in engine.ts), nicht gesynct
const cacheBase = async (file: string) => {
  const s = await stat(file)
  return join(home(), 'assets', '.video', createHash('sha1').update(file + s.size + s.mtimeMs).digest('hex'))
}

/** Zeitachse der fertigen Episode: off = Beginn der Sprache (Intro minus Überblendung), total = Gesamtlänge (s). */
function timing(ep: Episode, o: { introDur?: number; outroDur?: number }) {
  const len = editedLength(ep.cuts, ep.duration)
  if (ep.intro && o.introDur === undefined) throw new Error('Intro ohne Länge (introDur)')
  if (ep.outro && o.outroDur === undefined) throw new Error('Outro ohne Länge (outroDur)')
  const dI = ep.intro ? Math.min(XF, o.introDur!, len) : 0, dO = ep.outro ? Math.min(XF, o.outroDur!, len) : 0
  const off = ep.intro ? o.introDur! - dI : 0
  return { len, dI, dO, off, total: off + len + (ep.outro ? o.outroDur! - dO : 0) }
}

/** Filtergraph der Episode bis zum Label [pre] (ohne Lautheit). inputs = Quellen (src wie in der Episode) in Eingangsreihenfolge:
 *  nicht stumme Spuren, dann Intro, Outro, dann je Soundeffekt seine Datei. Mit o.music folgt als letzter Eingang die Musik (nicht in inputs; Aufrufer mit -stream_loop -1).
 *  Schnitte: einmal nach dem Mischen, alle Spuren teilen die Quellzeit; asplit + atrim je Bereich ist sampelgenau, der Graph gehört bei vielen Schnitten in eine Datei (-/filter_complex). */
export function buildGraph(ep: Episode, o: { music?: { volume: number }; introDur?: number; outroDur?: number }): { inputs: string[]; graph: string } {
  const tracks = ep.tracks.filter((t) => !t.mute)
  if (!tracks.length) throw new Error('Alle Spuren sind stumm, es gibt nichts zu exportieren.')
  const keep = keepRanges(ep.cuts, ep.duration)
  if (!keep.length) throw new Error('Die Schnitte entfernen die ganze Episode.')
  const t = timing(ep, o), inputs = tracks.map((x) => x.src), g: string[] = []
  tracks.forEach((x, i) => g.push(`[${i}:a]${FMT},volume=${x.gain ?? 0}dB[tr${i}]`))
  g.push(tracks.length > 1 ? `${tracks.map((_, i) => `[tr${i}]`).join('')}amix=inputs=${tracks.length}:normalize=0:duration=longest[mix]` : '[tr0]anull[mix]')
  // Zweistufig: erst grob in √n Fenster, dann je Fenster in seine Bereiche. Ein flaches asplit=n reicht jeden Frame n-mal weiter (1000 Schnitte: ~6× langsamer, gemessen)
  const K = Math.ceil(Math.sqrt(keep.length)), G = Math.ceil(keep.length / K)
  g.push(`[mix]asplit=${G}${Array.from({ length: G }, (_, i) => `[g${i}]`).join('')}`)
  for (let i = 0; i < G; i++) {
    const ks = keep.slice(i * K, i * K + K)
    g.push(`[g${i}]atrim=start=${sec(ks[0][0])}:end=${sec(ks[ks.length - 1][1])},asplit=${ks.length}${ks.map((_, j) => `[k${i * K + j}]`).join('')}`)
  }
  keep.forEach(([a, b], j) => {
    const d = Math.min(SEAM, (b - a) / 2), fade = `${j || a > 0 ? `,afade=t=in:d=${d}` : ''}${j < keep.length - 1 || b < ep.duration ? `,afade=t=out:st=${sec(b - a - d)}:d=${d}` : ''}`
    g.push(`[k${j}]atrim=start=${sec(a)}:end=${sec(b)},asetpts=PTS-STARTPTS${fade}[s${j}]`)
  })
  g.push(`${keep.map((_, j) => `[s${j}]`).join('')}concat=n=${keep.length}:v=0:a=1[cut]`)
  const ton = ep.ton ?? 'klar'
  g.push(`[cut]${ton === 'original' ? 'anull' : ton === 'stark' ? SPEECH.replace('nr=12', 'nr=20') : SPEECH}[sp]`)
  let cur = 'sp'
  if (ep.intro) { g.push(`[${inputs.length}:a]${FMT}[intro];[intro][${cur}]acrossfade=d=${t.dI}[wi]`); inputs.push(ep.intro); cur = 'wi' }
  if (ep.outro) { g.push(`[${inputs.length}:a]${FMT}[outro];[${cur}][outro]acrossfade=d=${t.dO}[wo]`); inputs.push(ep.outro); cur = 'wo' }
  const cuts = normCuts(ep.cuts, ep.duration) // sfx in einem Schnitt fallen weg (wie im Lint)
  const fx = (ep.sfx ?? []).filter((s) => !inCut(s.at, cuts)).map((s) => ({ input: inputs.push(s.src) - 1, at: toEdited(s.at, ep.cuts, ep.duration) + t.off, gain: s.gain }))
  g.push(sfxGraph(cur, fx, 'fx'))
  g.push(o.music ? duckMusic('fx', `${inputs.length}:a`, o.music.volume, t.total, 'pre') : '[fx]anull[pre]')
  return { inputs, graph: g.join(';\n') }
}

/** Episode des Decks: deck.podcast, sonst aus den Clip-Folien (eine Quelle, Länge per probe). */
async function episodeOf(deck: Deck): Promise<Episode> {
  if (deck.podcast) return deck.podcast
  const clip = deck.slides.find((s) => s.layout === 'clip' && !s.hidden)?.content as ClipContent | undefined
  if (!clip?.video) throw new Error('Das Deck hat keinen Podcast-Schnitt und keine Clip-Folie mit Video.')
  return deckToEpisode(deck, (await probe(mediaPath(clip.video, 'Clip-Video'))).duration)
}

const fileOf = (src: string) => {
  const f = mediaPath(src, `Podcast-Datei ${src}`)
  if (!existsSync(f)) throw new Error(`Podcast-Datei fehlt: ${basename(f)}`)
  return f
}

// ffmpeg 7 ersetzt -filter_complex_script durch -/filter_complex (9 kennt das alte nicht mehr), ffmpeg-static 6.1.1 kennt nur das alte
let script: Promise<string> | undefined
const scriptFlag = () => (script ??= ffmpegBin().then((b) => run(b, ['-hide_banner', '-version'])).then((r) => {
  const m = /version n?(\d+)\./.exec(r.out.toString())
  return m && +m[1] < 7 ? '-filter_complex_script' : '-/filter_complex'
}))
let lame: Promise<boolean> | undefined
const hasLame = () => (lame ??= ffmpegBin().then((b) => run(b, ['-hide_banner', '-encoders'])).then((r) => /\slibmp3lame\s/.test(r.out.toString())))

// FFMETADATA: = ; # \ und Zeilenumbruch mit Backslash schützen
const metaEsc = (s: string) => s.replace(/[=;#\\\n]/g, (c) => `\\${c}`)

let queue: Promise<unknown> = Promise.resolve()

/** Episode als `${outBase}.mp3|.m4a`, dazu `${outBase}.chapters.json` (Podcasting 2.0), wenn es Kapitel gibt; Audiodatei zuerst. Exporte laufen nacheinander. */
export function renderEpisode(deck: Deck, format: 'mp3' | 'm4a', outBase: string, onProgress?: (pct: number) => void): Promise<string[]> {
  const job = queue.then(() => renderOnce(deck, format, outBase, onProgress))
  queue = job.catch(() => {})
  return job
}

async function renderOnce(deck: Deck, format: 'mp3' | 'm4a', outBase: string, onProgress: (pct: number) => void = () => {}): Promise<string[]> {
  if (format === 'mp3' && !(await hasLame())) throw new Error('MP3 geht mit diesem ffmpeg nicht, nimm m4a.')
  const ep = await episodeOf(deck)
  const introDur = ep.intro ? (await probe(fileOf(ep.intro))).duration : undefined
  const outroDur = ep.outro ? (await probe(fileOf(ep.outro))).duration : undefined
  let music: string | undefined
  if (deck.music?.src) {
    try { music = fileOf(deck.music.src) } catch (e) { console.warn('[podcast] Musik fehlt, Episode ohne Musik:', (e as Error).message) }
    if (music) await checkMusic(music)
  }
  const o = { music: music ? { volume: deck.music?.volume ?? DUCK.volume } : undefined, introDur, outroDur }
  const { inputs, graph } = buildGraph(ep, o), t = timing(ep, o)
  const args = [...inputs.flatMap((s) => ['-i', fileOf(s)]), ...(music ? ['-stream_loop', '-1', '-i', resolve(music)] : [])]
  const meta = args.filter((a) => a === '-i').length // Eingangsnummer der Metadaten-Datei
  const chapters = (ep.chapters ?? []).map((c) => {
    const e = toEdited(c.at, ep.cuts, ep.duration) // liegt at in einem Schnitt: dessen Anfang
    return { start: e > 0 ? e + t.off : 0, title: c.title } // ein Kapitel ganz vorn umfasst das Intro
  }).sort((a, b) => a.start - b.start)
  const base = resolve(outBase), dir = join(dirname(base), `.podcast-tmp-${randomBytes(4).toString('hex')}`) // nicht /tmp: tmpfs
  await sweepStale(dirname(base), '.podcast-tmp-')
  await mkdir(dir, { recursive: true })
  try {
    const flag = await scriptFlag()
    let n = 0
    const g = (loud: string) => { const f = join(dir, `graph-${n++}.txt`); writeFileSync(f, `${graph};\n[pre]anull${loud}[a]`); return [flag, f] }
    const loud = await measuredNorm(LUFS, args, g, dir)
    await writeFile(join(dir, 'meta.txt'), [';FFMETADATA1', `title=${metaEsc(deck.title)}`, ...chapters.flatMap((c, i) => [
      '[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start * 1000)}`, `END=${Math.round((chapters[i + 1]?.start ?? t.total) * 1000)}`, `title=${metaEsc(c.title)}`,
    ]), ''].join('\n'))
    const enc = format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']
    const out = join(dir, `episode.${format}`)
    await runFfmpeg([...args, '-f', 'ffmetadata', '-i', 'meta.txt', ...g(loud), '-map', '[a]', '-map_metadata', String(meta), '-map_chapters', String(meta), ...enc, out], { cwd: dir, duration: t.total, onProgress })
    const files: [string, string][] = [[out, `${base}.${format}`]]
    if (chapters.length) {
      await writeFile(join(dir, 'chapters.json'), JSON.stringify({ version: '1.2.0', chapters: chapters.map((c) => ({ startTime: +c.start.toFixed(3), title: c.title })) }, null, 2))
      files.push([join(dir, 'chapters.json'), `${base}.chapters.json`])
    }
    for (const [from, to] of files) await rename(from, to) // Arbeitsordner liegt neben dem Ziel, also im selben Dateisystem
    onProgress(100)
    return files.map(([, to]) => to)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Wellenform: Betragsmaximum je 1/50 s (rate), Werte 0..1 auf 3 Stellen; gecacht je Datei (Pfad, Größe, Änderungszeit). Dekodiert mono mit 8 kHz, gestreamt. */
export async function peaks(file: string): Promise<{ duration: number; rate: number; data: number[] }> {
  const cache = `${await cacheBase(file)}.peaks.json`
  try { return JSON.parse(await readFile(cache, 'utf8')) } catch { /* noch nicht gerechnet */ }
  const SR = 8000, rate = 50, win = SR / rate, data: number[] = []
  let max = 0, n = 0, total = 0, rest: Buffer = Buffer.alloc(0)
  const r = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'], {
    onBin: (c) => {
      const b = rest.length ? Buffer.concat([rest, c]) : c, k = b.length >> 2
      for (let i = 0; i < k; i++) {
        const v = Math.abs(b.readFloatLE(i * 4))
        if (v > max) max = v
        if (++n === win) { data.push(Math.round(Math.min(1, max) * 1000) / 1000); max = 0; n = 0 }
      }
      total += k
      rest = b.subarray(k * 4)
    },
  })
  if (r.code !== 0) throw new Error(`Wellenform von ${basename(file)} nicht lesbar${/does not contain any stream|matches no streams/i.test(r.err) ? ' (keine Tonspur)' : ''}.`)
  if (n) data.push(Math.round(Math.min(1, max) * 1000) / 1000)
  const out = { duration: total / SR, rate, data }
  try {
    await mkdir(dirname(cache), { recursive: true })
    await writeFile(cache, JSON.stringify(out))
  } catch (e) { console.warn('[podcast] Wellenform-Cache nicht geschrieben:', e) }
  return out
}

/** Datei zum Abspielen im Renderer: eine nicht stumme Spur ohne gain = die Originaldatei; sonst alle nicht stummen Spuren ungeschnitten gemischt (Opus 64k mono), gecacht. */
export async function previewMix(deck: Deck): Promise<string> {
  const tracks = (await episodeOf(deck)).tracks.filter((t) => !t.mute)
  if (!tracks.length) throw new Error('Alle Spuren sind stumm.')
  const files = tracks.map((t) => fileOf(t.src))
  if (tracks.length === 1 && !tracks[0].gain) return files[0]
  const st = await Promise.all(files.map((f) => stat(f)))
  const key = createHash('sha1').update(JSON.stringify(tracks.map((t, i) => [files[i], t.gain ?? 0, st[i].size, st[i].mtimeMs]))).digest('hex')
  const out = join(home(), 'assets', '.video', `${key}.mix.ogg`)
  if (existsSync(out)) return out
  await mkdir(dirname(out), { recursive: true })
  const tmp = `${out}.${process.pid}.tmp.ogg` // App und MCP-Server können gleichzeitig mischen; rename ersetzt atomar
  const g = tracks.map((t, i) => `[${i}:a]${FMT},volume=${t.gain ?? 0}dB[t${i}]`).join(';') +
    (tracks.length > 1 ? `;${tracks.map((_, i) => `[t${i}]`).join('')}amix=inputs=${tracks.length}:normalize=0:duration=longest[a]` : ';[t0]anull[a]')
  try {
    await runFfmpeg([...files.flatMap((f) => ['-i', f]), '-filter_complex', g, '-map', '[a]', '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', tmp])
    await rename(tmp, out)
  } finally { await rm(tmp, { force: true }) }
  return out
}
