import { nativeImage } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { MEDIA_EXT, formatSuffix, sizeOf, visibleSlides, type Deck, type Measured } from '../shared/deck'
import { handout } from '../shared/handout'
import { highlights, type Signals } from '../shared/highlights'
import { lintDeck } from '../shared/lint'
import { MAX_PARTS, followParts, type ClipContent, type Segment, type Transcript } from '../shared/video'
import type { Engine } from './agent'
import { buildDocx } from './export-docx'
import { buildPptx, fontsOf } from './export-pptx'
import { autoFocus, speakerFaces } from './faces'
import { ffmpegBin, frames, loudness, pcm16k, probe } from './ffmpeg'
import { renderOverview, renderPdf, renderPrintPdf, renderSlide, type Rendered } from './render'
import { PARAKEET_LANGS, asr, diarize, tag } from './sherpa'
import { localAsset } from './sync'
import { CHUNK, chatPerSecond, chunkWindow, chunksIn, coveredOf, engineFor, inChunk, loudRanges, mergeSegments, withSpeakers, type Turn } from './video-cache'

// asset://local/<pfad> oder absoluter Pfad → lokale Datei, wie videoPath in export-video.ts; null = keine Mediendatei
function mediaFile(src: unknown): string | null {
  try {
    const p = typeof src === 'string' && src.startsWith('asset://') ? decodeURIComponent(new URL(src).pathname) : src
    return typeof p === 'string' && isAbsolute(p) && MEDIA_EXT.test(p) ? localAsset(p) : null
  } catch { return null } // kaputte URL
}

const slug = (s: string) => s.toLowerCase().replace(/[äöüß]/g, (c) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' })[c]!).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'deck'

export function createEngine(): Engine {
  // ponytail: unbounded measure cache keyed by everything a slide render depends on; fine for a desktop session
  const cache = new Map<string, Measured>()
  const key = (deck: Deck, i: number) => JSON.stringify([deck.slides[i], deck.theme, deck.title, deck.size, i])

  async function measure(deck: Deck, indices = deck.slides.map((_, i) => i)): Promise<Measured[]> {
    const out: Measured[] = []
    for (const i of indices) {
      const k = key(deck, i)
      if (!cache.has(k)) cache.set(k, (await renderSlide(deck, i)).measured)
      out.push(cache.get(k)!)
    }
    return out
  }

  // Video-Caches je Datei (Pfad, Größe, Änderungszeit) im Punktordner, der nicht gesynct wird: <key>.t<k>.json je Transkript-Chunk,
  // .d<k>.json je Sprecher-Stück, .e<s>.json je Ereignis-Chunk, .signals.json; <key>.transcript.json ist der alte Ganzdatei-Cache (Whisper)
  const home = process.env.DECKWERK_HOME ?? join(homedir(), 'Deckwerk'), models = join(home, 'models')
  const baseOf = async (file: string) => {
    const s = await stat(file)
    return join(home, 'assets', '.video', createHash('sha1').update(file + s.size + s.mtimeMs).digest('hex'))
  }
  const readJson = async <T>(f: string): Promise<T | null> => { try { return JSON.parse(await readFile(f, 'utf8')) } catch { return null } }
  const save = async (f: string, v: unknown) => {
    try {
      await mkdir(dirname(f), { recursive: true })
      await writeFile(f, JSON.stringify(v))
    } catch (e) { console.warn('[video] Cache nicht geschrieben:', e) } // Ergebnis ist fertig, nur der Cache fehlt
  }
  // Rechenschritte (Chunk, Sprecher, Ereignisse) einer nach dem anderen: nie zwei Tonstücke oder Modelle zugleich im RAM.
  // Gleicher Schlüssel = dieselbe Arbeit, ein zweiter Aufruf wartet auf den ersten.
  let lane: Promise<unknown> = Promise.resolve()
  const running = new Map<string, Promise<unknown>>()
  const step = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    let p = running.get(key) as Promise<T> | undefined
    if (!p) {
      const q = lane.then(work)
      lane = q.catch(() => {})
      running.set(key, (p = q.finally(() => running.delete(key))))
    }
    return p
  }
  // Ergebnis in Datei f, sofort gespeichert (Abbruch macht beim nächsten Mal weiter). Erneut lesen: ein gleicher Schritt kann gerade fertig geworden sein.
  const cached = <T>(f: string, work: () => Promise<T>, ok: (c: T) => boolean = () => true) => step(f, async () => {
    const c = await readJson<T>(f)
    if (c !== null && ok(c)) return c
    const v = await work()
    await save(f, v)
    return v
  })

  class TagFailed extends Error { constructor(cause: unknown) { super('tag', { cause }) } } // Ereigniserkennung gescheitert, nicht der Rest
  type Chunk = { engine: 'parakeet' | 'whisper'; segments: Segment[] }
  let whisperOnly = false // sherpa grundsätzlich nicht nutzbar: Rest der Sitzung mit Whisper
  const wantFor = (lang?: string) => engineFor(lang, PARAKEET_LANGS, whisperOnly)

  // Ein Chunk: Parakeet (sherpa); Whisper nur für Sprachen außerhalb von Parakeet oder wenn sherpa nicht nutzbar ist
  async function recognize(file: string, k: number, duration: number, want: Chunk['engine'] | undefined, onProgress: (pct: number) => void): Promise<Chunk> {
    const { from, dur } = chunkWindow(k, duration), pcm = await pcm16k(file, from, dur)
    const whisper = async (): Promise<Chunk> => {
      // transcribePcm erkennt die Sprache selbst, eine Vorgabe nimmt es nicht an
      const { transcribePcm } = await import('./transcribe')
      const t = await transcribePcm(pcm, models, onProgress)
      return { engine: 'whisper', segments: inChunk(t.segments.map((s) => ({ ...s, start: s.start + from, end: s.end + from })), k) }
    }
    if (want === 'whisper' || whisperOnly) return whisper()
    try {
      return { engine: 'parakeet', segments: inChunk(await asr(pcm, { models, offset: from, onProgress }), k) }
    } catch (e) {
      if ((e as { code?: string }).code !== 'SHERPA_UNAVAILABLE') throw e
      console.warn('[video] sherpa-onnx nicht nutzbar, Spracherkennung mit Whisper:', (e as Error).message)
      whisperOnly = true
      return whisper()
    }
  }

  // Welche Chunks fehlen für ranges (null = ganzes Video); ein Chunk der falschen Erkennung zählt als fehlend
  async function chunkPlan(file: string, ranges: [number, number][] | null, lang?: string) {
    const [{ duration }, base] = await Promise.all([probe(file), baseOf(file)])
    const legacy = await readJson<Transcript>(`${base}.transcript.json`) // alter Ganzdatei-Cache (Whisper) deckt alles ab
    const all = chunksIn([[0, duration]], duration) // 0 … n−1, Index = k
    const have = legacy ? [] : await Promise.all(all.map((k) => readJson<Chunk>(`${base}.t${k}.json`)))
    // fits fragt whisperOnly bei jedem Aufruf neu: fällt sherpa mitten im Lauf aus, passen schon gecachte Whisper-Chunks
    const want = wantFor(lang), valid = (c: Chunk | null) => !!c && Array.isArray(c.segments), fits = (c: Chunk | null) => valid(c) && (!wantFor(lang) || c!.engine === wantFor(lang))
    const missing = legacy ? [] : chunksIn(ranges ?? [[0, duration]], duration).filter((k) => !fits(have[k]))
    return { duration, base, legacy, all, have, want, valid, fits, missing }
  }

  // ponytail: Sprechertrennung je 30-min-Stück, IDs gelten nur im Stück (Videos bis 30 min exakt); über Stückgrenzen kann
  // dieselbe ID verschiedene Personen meinen. Upgrade: Sprecher-Embeddings über alle Stücke clustern.
  const DIAR = 1800
  /** Sprecherwechsel: Stücke, die ranges berühren, rechnen (null = ganzes Video); Rückgabe aus allen vorhandenen Stücken. */
  async function speakersOf(file: string, duration: number, ranges: [number, number][] | null, onProgress: (pct: number) => void = () => {}): Promise<Turn[]> {
    const base = await baseOf(file), todo = chunksIn(ranges ?? [[0, duration]], duration, DIAR, 0), out: Turn[] = []
    for (const k of chunksIn([[0, duration]], duration, DIAR, 0)) {
      const f = `${base}.d${k}.json`, i = todo.indexOf(k)
      const turns = i < 0 ? await readJson<Turn[]>(f) : await cached(f, async () => {
        const a = k * DIAR
        return diarize(await pcm16k(file, a, Math.min(DIAR, duration - a)), { models, offset: a, onProgress: (p) => onProgress(Math.floor(((i + p / 100) / todo.length) * 100)) })
      }, Array.isArray)
      if (Array.isArray(turns)) out.push(...turns)
    }
    return out
  }

  /** Transkript der Chunks, die ranges berühren (null = ganzes Video); vorhandene Chunks aus dem Cache. Rückgabe: alle vorhandenen Chunks. */
  async function transcript(file: string, ranges: [number, number][] | null, o: { lang?: string; speakers?: boolean }, onProgress: (pct: number) => void = () => {}): Promise<Transcript> {
    const { duration, base, legacy, all, have, want, valid, fits, missing } = await chunkPlan(file, ranges, o.lang)
    const share = o.speakers ? 80 : 100 // Rest: Sprechertrennung
    let t = legacy
    if (!t) {
      for (const [i, k] of missing.entries())
        have[k] = await cached(`${base}.t${k}.json`, () => recognize(file, k, duration, want, (p) => onProgress(Math.floor(((i + p / 100) / missing.length) * share))), fits)
      const ok = all.filter((k) => valid(have[k])) // außerhalb von ranges zählt auch ein Chunk der anderen Erkennung
      t = { duration, lang: o.lang ?? 'auto', segments: mergeSegments(ok.flatMap((k) => have[k]!.segments)), covered: coveredOf(ok, duration) }
    }
    if (o.speakers) t = { ...t, segments: withSpeakers(t.segments, await speakersOf(file, duration, ranges, (p) => onProgress(share + Math.floor((p * (100 - share)) / 100)))) }
    return t
  }

  // Zuschnitt vor dem Video-Export, auf einer Kopie: follow 'sprecher' → parts je Sprecher, übrige parts ohne focus aufs Gesicht.
  // Fehler kosten nur den Zuschnitt (Bildmitte).
  async function prepareClips(deck: Deck, onProgress: (pct: number) => void): Promise<Deck> {
    const size = sizeOf(deck), slides = [...deck.slides], clips = slides.flatMap((s, i) => (s.layout === 'clip' ? [i] : []))
    for (const [n, i] of clips.entries()) {
      const c = slides[i].content as ClipContent, file = mediaFile(c.video)!
      const warn = (e: unknown) => console.warn(`[video] Folie ${i + 1}: Gesichts- oder Sprechererkennung fehlgeschlagen:`, (e as Error).message)
      try {
        const info = await probe(file)
        if (c.fit === 'blur' || Math.abs(info.w / info.h - size.w / size.h) <= 0.01) continue // ganzes Bild sichtbar, nichts zuzuschneiden
        let parts = c.parts
        if (c.follow === 'sprecher') try {
          const from = Math.min(...parts.map((p) => p.start)), to = Math.max(...parts.map((p) => p.end))
          const turns = (await speakersOf(file, info.duration, parts.map((p): [number, number] => [p.start, p.end]))).filter((t) => t.end > from && t.start < to)
          parts = followParts(parts, turns, await speakerFaces(file, turns, info))
        } catch (e) { warn(e) }
        if (parts.some((p) => p.focus === undefined)) parts = await autoFocus(file, parts, info) // auch, wenn follow keine Sprecher-Gesichter fand
        slides[i] = { ...slides[i], content: { ...c, parts } }
      } catch (e) { warn(e) } finally { onProgress(Math.floor(((n + 1) / clips.length) * 100)) }
    }
    return { ...deck, slides }
  }

  // Billige Vorprüfung: scheitert exportVideo ohnehin (Video fehlt, parts leer oder verdreht), vorab weder Sprecher, Gesichter noch Transkript rechnen
  const clipsOk = (deck: Deck) => deck.slides.every((s) => {
    if (s.layout !== 'clip') return true
    const c = s.content as ClipContent, file = mediaFile(c.video)
    return !!file && existsSync(file) && !!c.parts?.length && c.parts.length <= MAX_PARTS && c.parts.every((p) => p.end > p.start)
  })

  // Untertitel und Füllwörter brauchen das Transkript nur in den Ausschnitten: nur deren Chunks rechnen. Fehler → Clip ohne Untertitel.
  // Ergebnis je Datei gemerkt: die Vorbereitung rechnet mit Fortschritt, exportVideo holt es danach ab.
  function transcriptsOf(deck: Deck) {
    const need = new Map<string, [number, number][]>(), memo = new Map<string, Promise<Transcript | null>>()
    for (const s of deck.slides) {
      const c = s.content as ClipContent, file = s.layout === 'clip' ? mediaFile(c.video) : null
      if (file && ((c.captions ?? 'wort') !== 'aus' || c.pauses === 'kurz')) need.set(file, [...(need.get(file) ?? []), ...(c.parts ?? []).map((p): [number, number] => [p.start, p.end])])
    }
    const get = (file: string, onProgress?: (pct: number) => void) => {
      let p = memo.get(file)
      if (!p) memo.set(file, (p = transcript(file, need.get(file) ?? null, {}, onProgress).catch((e: Error): null => {
        console.warn(`[video] Kein Transkript für ${file}, Clip ohne Untertitel:`, e.message)
        return null
      })))
      return p
    }
    return { need, get }
  }

  // Hintergrundmusik (deck.music) als lokale Datei; fehlt sie, entsteht das Video ohne Musik
  function musicOf(deck: Deck): { music?: { file: string; volume?: number } } {
    if (!deck.music?.src) return {}
    const file = mediaFile(deck.music.src)
    if (file && existsSync(file)) return { music: { file, volume: deck.music.volume } }
    console.warn(`[video] Musik fehlt (${deck.music.src}), Video ohne Musik`)
    return {}
  }

  return {
    measure,
    async renderPng(deck, indices, width = 1024) {
      const out: Buffer[] = []
      for (const i of indices) {
        const r = await renderSlide(deck, i, { png: true })
        cache.set(key(deck, i), r.measured)
        out.push(nativeImage.createFromBuffer(r.png!).resize({ width, quality: 'best' }).toPNG())
      }
      return out
    },
    async renderOverview(deck) {
      const png = await renderOverview(deck)
      return nativeImage.createFromBuffer(png).resize({ width: 1600, quality: 'best' }).toPNG()
    },
    thumbnail(img, width) {
      const n = nativeImage.createFromBuffer(img)
      return n.isEmpty() ? null : n.resize({ width, quality: 'good' }).toJPEG(80)
    },
    async lint(deck) {
      return lintDeck(deck, await measure(deck))
    },
    async exportDeck(all, format, outDir, print, onProgress) {
      // Ausgeblendete Folien fehlen überall außer in PowerPoint, dort bleiben sie versteckt (export-pptx.ts)
      const deck = format === 'pptx' ? all : { ...all, slides: visibleSlides(all) }
      if (all.slides.length && !deck.slides.length) throw new Error('Alle Folien sind ausgeblendet. Blende mindestens eine ein, um zu exportieren.')
      await mkdir(outDir, { recursive: true })
      const base = join(outDir, slug(deck.title) + formatSuffix(deck.size)) // Format im Namen: gleiche Titel in 4:5 und A4 überschreiben sich nicht
      // Video: Zuschnitt 5 %, dann fehlende Transkript-Chunks der Ausschnitte (je Chunk 5 %, höchstens bis 60 %), Rest der Export
      if (format === 'mp4' || format === 'clips') {
        const report = onProgress ?? (() => {}), music = musicOf(deck), t = transcriptsOf(deck)
        const run = (ready: Deck, pre: number) => import('./export-video').then((m) => m.exportVideo(ready, base, format, (f) => t.get(f), (p) => report(pre + Math.floor((p * (100 - pre)) / 100)), music))
        if (!clipsOk(deck)) return run(deck, 0) // exportVideo meldet, was fehlt
        const files = [...t.need.keys()], miss = await Promise.all(files.map((f) => chunkPlan(f, t.need.get(f)!).then((p) => p.missing.length, () => 0)))
        const total = miss.reduce((a, b) => a + b, 0), pre = Math.min(60, 5 + 5 * total) // ponytail: Schätzung, ein Chunk (5 min Ton) wiegt so viel wie 5 % Export
        const ready = await prepareClips(deck, (p) => report(Math.floor(p * 0.05)))
        let done = 0
        for (const [k, f] of files.entries()) {
          await t.get(f, (p) => report(5 + Math.floor(((pre - 5) * (done + (miss[k] * p) / 100)) / (total || 1))))
          done += miss[k]
        }
        return run(ready, pre)
      }
      if (format === 'md') {
        await writeFile(`${base}.md`, handout(deck))
        return [`${base}.md`]
      }
      if (format === 'pdf') {
        await writeFile(`${base}.pdf`, await renderPdf(deck))
        return [`${base}.pdf`]
      }
      if (format === 'print') {
        // Name nach Druckformat: flyer-a5-druck.pdf, flyer-a4-quer-druck.pdf; ohne Format wie das Deck (flyer-a4-druck.pdf)
        const file = `${print?.size ? join(outDir, `${slug(deck.title)}-${print.size}${sizeOf(deck).w > sizeOf(deck).h ? '-quer' : ''}`) : base}-druck.pdf`
        await writeFile(file, await renderPrintPdf(deck, print))
        return [file]
      }
      if (format === 'zip') {
        const zip = new JSZip()
        for (let i = 0; i < deck.slides.length; i++) zip.file(`${String(i + 1).padStart(2, '0')}.png`, (await renderSlide(deck, i, { png: true })).png!)
        zip.file(`${slug(deck.title)}.pdf`, await renderPdf(deck))
        await writeFile(`${base}.zip`, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })) // PNG ist schon komprimiert
        return [`${base}.zip`]
      }
      const slides: Rendered[] = []
      // Word: nur der Text wird nativ (bearbeitbare Textfelder), Fotos, Flächen und Diagramme bleiben im Hintergrundbild
      for (let i = 0; i < deck.slides.length; i++) slides.push(await renderSlide(deck, i, { png: format === 'png', background: format === 'docx' ? 'text' : format === 'pptx' }))
      if (format === 'png') {
        await mkdir(base, { recursive: true })
        const files = slides.map((_, i) => join(base, `${String(i + 1).padStart(2, '0')}.png`))
        await Promise.all(files.map((f, i) => writeFile(f, slides[i].png!)))
        return files
      }
      if (format === 'docx') {
        await writeFile(`${base}.docx`, await buildDocx(deck, slides.map((s) => ({ measured: s.measured, background: s.background! })), fontsOf(deck)))
        return [`${base}.docx`]
      }
      await writeFile(`${base}.pptx`, await buildPptx(deck, slides.map((s) => ({ measured: s.measured, background: s.background! }))))
      return [`${base}.pptx`]
    },
    video: {
      probe,
      frames,
      transcribe: (file, onProgress, o = {}) => transcript(file, o.range ? [[o.range.from, o.range.to]] : null, o, onProgress),
      // Signale je Sekunde (gecacht), daraus die Highlights; Fortschritt: Lautheit ~15 %, Ereignisse den Rest
      async highlights(file, onProgress = () => {}) {
        const base = await baseOf(file)
        let s = await readJson<Signals>(`${base}.signals.json`)
        if (!s) {
          const { duration } = await probe(file)
          const loud = await loudness(file, (p) => onProgress(Math.floor(p * 0.15)))
          // Ereignisse (Lachen, Jubel, Applaus, Schreien) nur an lauten Stellen; Chunks ohne solche bleiben 0 und werden nicht dekodiert
          let tagFailed = false
          const events = new Array<number>(loud.length).fill(0), hot = loudRanges(loud), work: { a: number; len: number; only: [number, number][] }[] = []
          for (let a = 0; a < duration; a += CHUNK) {
            const len = Math.min(CHUNK, duration - a)
            const only = hot.filter(([x, y]) => y > a && x < a + len).map(([x, y]): [number, number] => [Math.max(0, x - a), Math.min(len, y - a)])
            if (only.length) work.push({ a, len, only })
          }
          for (const [i, { a, len, only }] of work.entries()) { // je Chunk gespeichert: 8-h-Streams machen nach einem Abbruch weiter
            let r: number[]
            try {
              r = await cached(`${base}.e${a}.json`, async () => {
                // tag kennt kein only: nur die lauten Abschnitte einzeln taggen (slice: ein subarray schickte den ganzen Puffer an den Worker)
                const pcm = await pcm16k(file, a, len), out = new Array<number>(Math.ceil(len)).fill(0)
                for (const [x, y] of only) {
                  try { (await tag(pcm.slice(x * 16000, y * 16000), { models })).forEach((v, j) => { if (x + j < out.length) out[x + j] = v }) }
                  catch (e) { throw new TagFailed(e) }
                }
                return out
              }, Array.isArray)
            } catch (e) { // Lautheit, Chat und Heatmap reichen für Highlights: dieser Chunk bleibt 0 und wird nicht gecacht, auch signals.json nicht (später nachholen)
              if (!(e instanceof TagFailed)) throw e
              if (!tagFailed) console.warn('[video] Ereigniserkennung fehlgeschlagen, Highlights ohne Ereignisse:', (e.cause as Error)?.message ?? e.cause)
              tagFailed = true
              r = []
            }
            onProgress(15 + Math.floor(((i + 1) / work.length) * 85))
            r.forEach((v, j) => { if (a + j < events.length) events[a + j] = v })
          }
          // Chat und Heatmap legt importUrl neben das Video
          const meta = await readJson<{ chat?: unknown; heat?: unknown }>(`${file}.meta.json`)
          // meta.chat nur aus dem Ordner des Videos lesen (die Datei kommt von der Platte, kein beliebiger Pfad)
          const chat = typeof meta?.chat === 'string' && dirname(resolve(meta.chat)) === dirname(resolve(file)) ? await readJson<unknown>(meta.chat) : null
          s = { loud, events, ...(Array.isArray(chat) && { chat: chatPerSecond(chat, loud.length) }), ...(Array.isArray(meta?.heat) && { heat: meta.heat as number[] }) }
          if (!tagFailed) await save(`${base}.signals.json`, s)
        }
        return highlights(s)
      },
      async importUrl(url, onProgress) {
        const r = await (await import('./ytdlp')).importUrl(url, join(home, 'assets', '.video', 'import'), { models, ffmpeg: await ffmpegBin(), onProgress })
        await save(`${r.file}.meta.json`, { title: r.title, duration: r.duration, chapters: r.chapters, heat: r.heat, chat: r.chat }) // für highlights
        return { file: r.file, title: r.title, duration: r.duration, chat: !!r.chat, chapters: r.chapters }
      },
    },
  }
}
