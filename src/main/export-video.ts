// Video-Export (mp4, clips): Clip-Folien als Jump Cuts mit Hook und Untertiteln, andere Folien als Standbild. Alles über ffmpeg, ohne Browser-Compositing.
// Filterketten und ASS-Untertitel angelehnt an BridgeClip (MIT, © 2026 BridgeMind).
// Ablauf: Szenen als Zwischenstände (mkv, PCM-Ton), je Ausgabedatei ein Endschritt (concat-Demuxer, Video kopiert, Ton einmal AAC + loudnorm + Musik).
// Electron-Teile (renderSlide, nativeImage, Schriften) lädt erst exportVideo: assSubs, clipSegs, encodeCover, finish und encodeClip laufen im Selbsttest unter Node.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { MEDIA_EXT, VIDEO_FILE, sizeOf, transitionOf, type Deck, type Size } from '../shared/deck'
import { resolveTheme } from '../shared/themes'
import { snapToWords } from '../shared/clip-lint'
import { CUT, DUCK, FX, MAX_PARTS, MIN_PAUSE, OVERLAY_W, PAD, STILL, XFADE, ZOOM, clipSpans, freezeOf, joinOf, cutFrames, clipWords, cropRect, splitRects, cues, fillerQuiet, outSize, videoSize, partLen, partsLength, speedOf, tighten, type Captions, type ClipContent, type Look, type ClipStyle, type Cue, type Fit, type Overlay, type Part, type Pauses, type Quiet, type Transcript, snapToScenes, zoomOf, cutIndex, ovPos } from '../shared/video'
import { HOOK_FADE, KEN_BURNS, LOOK_FILTER, POP, artEvents, autoLook, isArt, cropFilter, splitFilter, hookBox, levelExpr, progressBar, srt } from './video-fx'
import { ffmpegBin, hasEncoder, probe, run, runFfmpeg, silences } from './ffmpeg'
import { chatAss, type ChatMsg, type ChatOpts } from './chat-overlay'
import { phoneFfmpeg } from './phone-ffmpeg'
import { APP } from '../shared/app-id'
import { clipMarks, xmeml, type Scene } from './export-xmeml'
import { assetPath, localAsset } from './sync'

export interface SubFont { name: string; files: Buffer[]; bold: boolean } // name = Family in der TTF; files landen in <Job-Ordner>/fonts (fontsdir)
export interface Seg { file: string; dur: number; music?: [number, number, number][]; cues?: Cue[]; xml?: Scene[] } // Zwischenstand (mkv), Länge in s, Musikpegel [von, bis, pegel] ab Seg-Anfang (nur parts mit music), cues: Untertitel-Zeilen ab Seg-Anfang (fürs SRT), xml: Clip-Szenen ab Seg-Anfang (Schnittliste, an der ersten Seg der Szene)
export interface Music { file: string; volume?: number; gain?: number } // absoluter Pfad, volume 0–1 (Standard 0,25); gain: Angleich der Datei auf MUSIC_LUFS (exportOnce misst)
// Musikdateien liegen gemessen zwischen −25 und −12 LUFS: ohne Angleich war volume 0,25 je nach Titel kaum hörbar oder fast so laut wie die Sprache (13.10.)
export const MUSIC_LUFS = -16
/** Musik einmal anspielen und ihre Lautheit messen (erste 3 min reichen, Musik ist gleichmäßig) → gain auf MUSIC_LUFS, höchstens ×4.
 *  Vorab, weil probe() eine Videospur verlangt und ffmpegs „Stream specifier [1:a]“ erst nach dem Encoden käme. */
export async function withMusicGain(m: Music): Promise<Music> {
  const r = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-t', '180', '-i', resolve(m.file), '-map', '0:a:0', '-af', 'ebur128', '-f', 'null', '-'])
  if (r.code !== 0) throw new Error(`Die Musikdatei ${m.file} ${/No such file/i.test(r.err) ? 'fehlt' : /matches no streams/i.test(r.err) ? 'hat keine Tonspur' : 'ist nicht lesbar'}.`)
  const i = Number(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(r.err)?.[1]) // Zusammenfassung am Ende; -70 = still
  return { ...m, gain: Number.isFinite(i) && i > -60 ? Math.min(4, 10 ** ((MUSIC_LUFS - i) / 20)) : 1 }
}

// Teilstücke je ffmpeg-Aufruf: je Teilstück ein Input mit eigenem Decoder, und der Filtergraph steht in argv (Linux: max. 128 KiB je Argument).
// Bis 1080p 20 Decoder gleichzeitig, darüber weniger nach Pixelzahl (max. aus Quelle und Ausgabe), 4K: 5, 8K: 3 – sonst läuft der RAM voll.
// ponytail: Upgrade: nahtlose Teilstücke eines parts aus einem Input per trim/atrim
const groupFor = (px: number) => Math.max(3, Math.min(20, Math.round((20 * 1920 * 1080) / px)))
const FADE = 0.4 // Übergang aus/in Schwarz (s)
// Weicher Schnitt: Überblendung in Bild und Ton (Dauer je Schnitt aus cutFrames in shared/video.ts); je Seite die halbe Blende Material über die Naht
// hinaus, die Mitte der Blende liegt auf der alten Naht, Länge und Untertitel bleiben gleich. Wo das nicht geht (Gruppengrenze, Bildwechsel, Videoende): Tonblende AFADE.
const AFADE = 0.08
// Alle Zwischenstände eines Exports mit denselben Video-Parametern, sonst passt -c:v copy beim Verbinden nicht
// hevc (ab 4K): H.265 bei halber Datenrate; das hvc1-Tag setzt finish im mp4
export const video = (preset: string, hevc?: boolean) => [...(hevc ? ['-c:v', 'libx265', '-preset', preset, '-crf', '24'] : ['-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-crf', '20']), '-pix_fmt', 'yuv420p', '-r', '30']
export const PCM = ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2'] // AAC in Zwischenständen verschöbe den Ton an jeder concat-Naht (Priming: Lücke oder Versatz)
const AUDIO = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000']
const FAST = ['-movflags', '+faststart']
// Lautheit in zwei Durchgängen: messen, dann mit den Messwerten linear anwenden (exakt −14 LUFS, kein Pumpen); ohne Messung dynamisch in einem Durchgang.
// Zeitstempel danach aus der Sample-Zahl: loudnorm (intern 192 kHz) verschiebt sie am Ende, die Tonspur wirkte bis 0,07 s länger als das Bild
const norm = (i: number) => `loudnorm=I=${i}:TP=-1.5:LRA=11`
// ton 'klar': Brummen/Trittschall unter 80 Hz weg; afftdn moderat (12 dB, folgt dem Rauschen), kräftiger klingt Sprache blechern; arnndn bräuchte eine Modelldatei.
// Kompressor 3:1 ab −26 dBFS mit 15 ms Attack: gleicht leise und laute Sätze an, Silbenanfänge bleiben; ohne Makeup, die Lautheit setzt loudnorm. Dann Zischlaute dämpfen.
// ponytail: feste Schwelle; Upgrade: relativ zum gemessenen Sprachpegel
// afftdn verzögert um 1200 Samples (25 ms bei 48 kHz): hinten Stille anhängen, damit das Ende durchkommt, vorn die Verzögerung abschneiden – sonst läge der Ton je Gruppe hinter dem Bild
export const SPEECH = 'apad=pad_len=1200,highpass=f=80,afftdn=nr=12:nf=-40:tn=1,acompressor=threshold=0.05:ratio=3:attack=15:release=150,deesser,atrim=start_sample=1200,asetpts=N/SR/TB'

/** x264-Preset für einen ganzen Export (Gesamtlänge in s): 1080p mit veryfast läuft auf schwachen Rechnern mit ~10 fps, darum über 10 min superfast.
 *  big (ab 4K): eine Stufe schneller, 4K hat viermal so viele Pixel und x265 rechnet ohnehin langsamer. */
export const presetFor = (seconds: number, big?: boolean) => (seconds > 600 ? (big ? 'ultrafast' : 'superfast') : big ? 'superfast' : 'veryfast')

const n2 = (i: number) => String(i).padStart(2, '0')
const sec = (s: number) => s.toFixed(3)

/** Soundeffekte in einen Ton mischen: main = Label des Tons, fx[j].input = Eingangsnummer der Effektdatei, at = Sekunde im Ton, gain in dB → Label out.
 *  Je Effekt adelay (ms, beide Kanäle), Länge gibt main vor (amix duration=first, ohne Normalisieren). Ohne Effekte nur durchgereicht. */
export function sfxGraph(main: string, fx: { input: number; at: number; gain?: number }[], out: string): string {
  if (!fx.length) return `[${main}]anull[${out}]`
  const g = fx.map((f, j) => { const ms = Math.max(0, Math.round(f.at * 1000)); return `[${f.input}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${f.gain ?? 0}dB,adelay=${ms}|${ms}[fx${j}]` })
  return `${g.join(';')};[${main}]${fx.map((_, j) => `[fx${j}]`).join('')}amix=inputs=${fx.length + 1}:normalize=0:duration=first[${out}]`
}

/** Musik unter den Ton legen: speech und music sind Labels, die Musik läuft endlos hinein (-stream_loop -1), dur = Länge des Tons (s) für die Abblende → Label out.
 *  volume: Pegel 0–1 oder fertiger volume-Ausdruck (levelExpr …:eval=frame).
 *  sidechaincompress endet mit dem ersten Eingang, der endet, und verwirft, was der andere noch hat: Musik darum endlos hinein, Länge gibt die Sprache vor.
 *  Schwelle 0,006 statt 0,03: leise Handy-Sprache (−31 dBFS RMS) drückt die Musik sonst kaum (gemessen 11 dB statt 1 dB). ponytail: feste Schwelle; Upgrade: relativ zum gemessenen Sprachpegel */
export const duckMusic = (speech: string, music: string, volume: number | string | undefined, dur: number, out: string) =>
  `[${speech}]asplit[mus_s][mus_k];[${music}]aformat=sample_rates=48000:channel_layouts=stereo,volume=${typeof volume === 'string' ? volume : Math.min(1, Math.max(0, volume ?? DUCK.volume))},afade=t=in:d=${DUCK.fadeIn}[mus_m];` +
  `[mus_m][mus_k]sidechaincompress=threshold=${DUCK.threshold}:ratio=${DUCK.ratio}:attack=${DUCK.attackMs}:release=${DUCK.releaseMs},afade=t=out:st=${sec(Math.max(0, dur - DUCK.fadeOut))}:d=${DUCK.fadeOut}[mus_d];[mus_s][mus_d]amix=inputs=2:normalize=0:duration=first[${out}]`

/** Lautheit auf i LUFS, zweiter Durchgang: Messlauf über args + graph(Messfilter), Ergebnis ist die Filterkette (mit führendem Komma) für graph im Endlauf.
 *  Fällt die Messung aus oder ist alles still (-inf), dynamisch in einem Durchgang. Zeitstempel danach aus der Sample-Zahl: loudnorm (intern 192 kHz) verschiebt sie am Ende. */
// onProgress: Messlauf zählt bis 50 % von dur; ohne Meldung stand die Anzeige bei 15 min Material minutenlang still (13.10., „hängt bei 83 %“)
export async function measuredNorm(i: number, args: string[], graph: (loud: string) => string[], cwd: string, dur = 0, onProgress?: (pct: number) => void): Promise<string> {
  const err = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', ...args, ...graph(`,${norm(i)}:print_format=json`), '-map', '[a]', '-f', 'null', '-'], { cwd, onOut: (s) => {
    if (onProgress && dur > 0) for (const m of s.matchAll(/out_time_us=(\d+)/g)) onProgress(Math.min(50, Math.floor(Number(m[1]) / 2e4 / dur)))
  } })
    .then((r) => (r.code === 0 ? r.err : ''), () => '')
  const v = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'].map((k) => Number(new RegExp(`"${k}" : "([^"]+)"`).exec(err)?.[1])) // "-inf" → NaN
  return v.every(Number.isFinite)
    ? `,${norm(i)}:measured_I=${v[0]}:measured_TP=${v[1]}:measured_LRA=${v[2]}:measured_thresh=${v[3]}:offset=${v[4]}:linear=true,aresample=48000,asetpts=N/SR/TB`
    : `,${norm(i)},aresample=48000,asetpts=N/SR/TB`
}

// ASS-Zeit H:MM:SS.cc
const at = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100))
  return `${Math.floor(cs / 360000)}:${n2(Math.floor(cs / 6000) % 60)}:${n2(Math.floor(cs / 100) % 60)}.${n2(cs % 100)}`
}
// Backslash als Vollbreiten-Zeichen (ASS kennt kein Escape dafür), Klammern per \{ \} (libass), Zeilenumbruch als \N (auch ein einzelnes \r, libass bricht dort um)
const esc = (s: string) => s.replace(/\\/g, '＼').replace(/[{}]/g, (c) => `\\${c}`).replace(/\r\n|\r|\n/g, '\\N')

// ASS-Farbe &HBBGGRR&. Dunkle Akzente (z. B. Petrol) gingen auf Video neben der dunklen Kontur unter → halb Richtung Weiß.
function assColor(hex: string) {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0)
  if (0.2126 * r + 0.7152 * g + 0.0722 * b < 110) [r, g, b] = [r, g, b].map((v) => Math.round((v + 255) / 2))
  return `&H${[b, g, r].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}&`
}

/** Untertitel-Datei: Hook oben linksbündig, Untertitel unten mittig, Lage nach Format. Hochformat (9:16): bei 33 % der Höhe, über der Plattform-Leiste
 *  (Reels/TikTok verdecken unten ~35 %); 4:5 und 1:1: 12 %; Querformat: kleiner, 7 %. Weiß mit dünner Kontur und Schatten, keine Kästen, kein Pop.
 *  style 'lebendig': Wort-Pop, Hook mit Einblendung auf dunklem Balken, Fortschrittsbalken (bar: Lage der Gruppe in der Szene, s). */
export function assSubs(o: { size: Size; font: string; bold: boolean; accent: string; hook?: string; hookDur: number; cues: Cue[]; mode: Captions; style?: ClipStyle; bar?: { off: number; dur: number; total: number }; overlays?: { start: number; end: number; text?: string; pos?: Overlay['pos']; art?: Overlay['art']; sub?: string; items?: string[]; box?: Overlay['box']; el?: number; len?: number; fade?: [boolean, boolean] }[]; captionPos?: ClipContent['captionPos']; chat?: { style: string; events: string[] } }): string {
  const { w, h } = o.size, m = Math.min(w, h), line = Math.max(1, Math.round(m * 0.002)), wide = w > h, wort = o.mode === 'wort', live = o.style === 'lebendig'
  const hookV = h * (wide ? 0.07 : 0.12), capV = capMargin(o.size)
  const style = (name: string, size: number, align: number, marginV: number) =>
    `Style: ${name},${o.font},${Math.round(size)},&H00FFFFFF,&H00FFFFFF,&H40000000,&H80000000,${o.bold ? -1 : 0},0,0,0,100,100,0,0,1,${line},${line},${align},${Math.round(w * 0.08)},${Math.round(w * 0.08)},${Math.round(marginV)},1`
  const dlg = (start: number, end: number, st: string, text: string) => `Dialogue: 0,${at(start)},${at(end)},${st},,0,0,0,,${text}`
  const events: string[] = [], bar = live && o.bar ? progressBar(o.size, assColor(o.accent), o.bar, at) : null
  if (bar) events.push(bar.event) // zuerst: liegt unter den Untertiteln
  if (o.chat) events.push(...o.chat.events)
  if (o.hook?.trim()) events.push(live ? dlg(0, o.hookDur, 'HookBox', HOOK_FADE + esc(o.hook.trim())) : dlg(0, o.hookDur, 'Hook', esc(o.hook.trim())))
  if (o.mode === 'satz') for (const c of o.cues) events.push(dlg(c.start, c.end, 'Cap', c.words.map((x) => esc(x.w)).join(' ')))
  if (wort) {
    const accent = assColor(o.accent)
    // Ein Dialogue je Wortzustand: das gesprochene Wort in Akzentfarbe, der Rest des Häppchens weiß
    for (const c of o.cues) c.words.forEach((x, k) => {
      const text = c.words.map((y, j) => (j === k ? `{\\c${accent}${live ? POP : ''}}${esc(y.w)}{\\r}` : esc(y.w))).join(' ')
      events.push(dlg(k ? x.start : c.start, k < c.words.length - 1 ? c.words[k + 1].start : c.end, 'Cap', text))
    })
  }
  // Einblendungen: Style je Lage (ASS-Alignment), unten über der Untertitelzeile, oben auf Höhe des Hooks; blenden wie der Hook, nur an echten Enden (fade: [ein, aus])
  // bauchbinde/titel/zahl/liste/zitat/markierung/abspann: eigene Bausteine (artEvents), Lage nach ovPos; die Abdunklung von titel/zitat/abspann zuerst (unter allem)
  const ovs = (o.overlays ?? []).map((x) => ({ ...x, al: OV_ALIGN[ovPos(x)] }))
  const low = capV + m * 0.16, hookSize = m * (wide ? 0.045 : 0.06)
  for (const x of ovs) {
    if (isArt(x.art)) {
      const r = artEvents({ size: o.size, accent: assColor(o.accent), art: x.art, text: x.text, sub: x.sub, items: x.items, box: x.box, el: x.el, len: x.len, al: x.al, top: hookV, low, start: x.start, end: x.end, fade: [x.fade?.[0] !== false, x.fade?.[1] !== false], fadeMs: FX.hookFadeMs }, at, esc)
      events.unshift(...r.back); events.push(...r.front)
    } else events.push(dlg(x.start, x.end, `Ov${x.al}`, `{\\fad(${x.fade?.[0] === false ? 0 : FX.hookFadeMs},${x.fade?.[1] === false ? 0 : FX.hookFadeMs})}` + esc(x.text?.trim() ?? '')))
  }
  // Untertitel oben: unter der Hook-Zeile; mitte: Bildmitte
  const cap = o.captionPos === 'oben' ? [8, hookV + hookSize * 1.6] : o.captionPos === 'mitte' ? [5, 0] : [2, capV]
  const hookStyle = style('Hook', hookSize, 7, hookV)
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    live ? hookBox(hookStyle, Math.round(m * 0.012)) : hookStyle,
    style('Cap', m * (wort ? (wide ? 0.065 : 0.075) : 0.055), cap[0], cap[1]),
    ...(bar ? [bar.style] : []),
    ...(o.chat ? [o.chat.style] : []),
    ...[...new Set(ovs.map((x) => x.al))].map((al) => style(`Ov${al}`, m * 0.05, al, al <= 3 ? low : hookV)),
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events, '',
  ].join('\n')
}

// Abstand der Untertitelzeile von unten (ASS MarginV): Querformat 7 %, 9:16 33 % (über der Plattform-Leiste), sonst 12 %
const capMargin = ({ w, h }: Size) => h * (w > h ? 0.07 : h / w >= 1.6 ? 0.33 : 0.12)
const OV_ALIGN = { oben: 8, mitte: 5, unten: 2, 'oben-links': 7, 'oben-rechts': 9, 'unten-links': 1, 'unten-rechts': 3, voll: 5 } as const
// atempo je Instanz nur 0,5–2: Kette, z. B. 0,25 = 0,5 · 0,5
const atempo = (sp: number): string[] => (sp > 2 ? ['atempo=2', ...atempo(sp / 2)] : sp < 0.5 ? ['atempo=0.5', ...atempo(sp / 0.5)] : sp === 1 ? [] : [`atempo=${sp}`])

/** parts um PAD verlängern, aber nur bis zur Mitte der Lücke zum nächsten part im Quellvideo (keine Doppelung), nicht über das Video hinaus
 *  und nicht über einen harten Bildwechsel (cuts), sonst holte das Polster das Blitzbild der Nachbarszene zurück. */
export function padParts(parts: Part[], duration: number, cuts: number[] = []): Part[] {
  return parts.map((p) => {
    let start = Math.max(0, p.start - PAD), end = Math.min(duration, p.end + PAD)
    for (const q of parts) {
      if (q === p) continue
      if (q.end <= p.start) start = Math.max(start, (q.end + p.start) / 2)
      if (q.start >= p.end) end = Math.min(end, (p.end + q.start) / 2)
    }
    for (const c of cuts) {
      if (c > start && c <= p.start) start = c
      if (c >= p.end && c < end) end = c
    }
    return { ...p, start, end }
  })
}

/** Kanten, die mitten in einem Wort liegen, auf die Wortgrenze legen (höchstens 0,4 s); nur der Export, das Deck bleibt. Ohne Transkript oder echte Wortzeiten unverändert. */
export function snapParts(parts: Part[], t: Transcript | null): { parts: Part[]; moved: number } {
  if (!t) return { parts, moved: 0 }
  const r = snapToWords(parts, t, 0.4)
  return { parts: r.parts, moved: r.moved.length }
}

/** Schnitte, an denen das Quellvideo nahtlos weiterläuft (part i beginnt, wo part i−1 endet): dort kein Fade, sonst sinkt der Pegel mitten im Satz. */
export const seamless = (parts: Part[]) => parts.map((p, i) => i > 0 && Math.abs(parts[i - 1].end - p.start) < 1e-3)

// Leere oder verdrehte parts vor ffmpeg abfangen, dessen Filtergraph-Fehler versteht niemand
function checkParts(parts: Part[] | undefined, where: string) {
  if (!parts?.length) throw new Error(`${where}: Der Clip hat keine Ausschnitte (parts).`)
  const bad = parts.findIndex((p) => !(p.end > p.start))
  if (bad >= 0) throw new Error(`${where}: Ausschnitt ${bad + 1} endet nicht nach seinem Anfang (start ${parts[bad].start} s, end ${parts[bad].end} s).`)
  // Obergrenze gegen fremde deck.json; nahtlose Stücke zählen nicht extra (follow teilt Ausschnitte an Sprecherwechseln)
  const n = seamless(parts).filter((j) => !j).length
  if (n > MAX_PARTS) throw new Error(`${where}: Der Clip hat ${n} Ausschnitte, höchstens ${MAX_PARTS} gehen. Bitte zusammenfassen oder auf mehrere Clip-Folien verteilen.`)
}

/** Chat-Nachrichten zu einem importierten Video (<video>.meta.json → chat, nur aus dem Ordner des Videos wie in engine.ts); leer, wenn keiner da ist. */
export async function chatOf(file: string): Promise<ChatMsg[]> {
  const json = (f: string) => readFile(f, 'utf8').then(JSON.parse, () => null)
  const meta = await json(`${file}.meta.json`)
  if (typeof meta?.chat !== 'string' || dirname(resolve(meta.chat)) !== dirname(resolve(file))) return []
  const chat = await json(meta.chat)
  return Array.isArray(chat) ? chat.filter((c) => Number.isFinite(c?.t) && typeof c.x === 'string' && ['n', 'c'].every((k) => c[k] === undefined || typeof c[k] === 'string')) : []
}
export interface ClipJob { file: string; parts: Part[]; hook?: string; captions: Captions; transcript: Transcript | null; size: Size; font: SubFont; accent: string; loudnorm?: boolean; pauses?: Pauses; fit?: Fit; style?: ClipStyle; cuts?: number[]; ton?: ClipContent['ton']; overlays?: Overlay[]; look?: Look; stabil?: boolean; captionPos?: ClipContent['captionPos']; cam?: ClipContent['cam']; chat?: ChatOpts & { msgs: ChatMsg[] }; sfx?: { file: string; at: number; gain?: number }[] } // overlays: image/video als aufgelöster Pfad, slide schon als PNG in image; sfx: file absolut, at = Sekunde im fertigen Clip
/** Jeder ffmpeg-Schritt des Exports: auf dem Handy, wenn eins mitrechnet (gleiche Parameter, damit -c:v copy beim Verbinden passt); scheitert es, rechnet der PC */
export const ffx = (args: string[], ro: { cwd: string; duration?: number; onProgress?: (pct: number) => void }, phone?: Phone) => {
  if (!phone || phone.failed) return runFfmpeg(args, ro)
  return phoneFfmpeg(phone.serial, args, { ...ro, models: phone.models }).catch((e: Error) => {
    console.warn('[video] Export auf dem Handy fehlgeschlagen, der PC rechnet weiter:', e.message)
    phone.failed = true
    phoneFault.reason = e.message.trim().split('\n').slice(-1)[0].slice(0, 160)
    return runFfmpeg(args, ro)
  })
}
/** Handy für die Clip-Gruppen (phone-ffmpeg.ts); failed: einmal gescheitert, rechnet für den Rest des Exports der PC */
export interface Phone { serial: string; models: string; failed?: boolean }
/** Warum das Handy im laufenden Export ausgestiegen ist (leer = nicht): die App verwirft console-Ausgaben, so sehen KI und Arbeitsansicht den Grund */
export const phoneFault = { reason: '' }
interface SegOpts { preset: string; fadeIn?: boolean; fadeOut?: boolean; phone?: Phone; hevc?: boolean } // fadeIn/fadeOut: Übergang aus/in Schwarz am Anfang/Ende der Szene; hevc: H.265 statt H.264

/** Filter des Farblooks (leer = keiner); auto misst Helligkeit und Kontrast per signalstats. ponytail: misst nur bis 5 s am Anfang des ersten parts */
async function lookFilter(job: ClipJob): Promise<string> {
  if (job.look !== 'auto') return LOOK_FILTER[job.look ?? 'neutral'] ?? ''
  const p = job.parts[0], r = await run(await ffmpegBin(), ['-hide_banner', '-nostdin', '-nostats', '-ss', sec(p.start), '-t', sec(Math.min(5, p.end - p.start)), '-i', job.file, '-an', '-vf', 'scale=320:-2,signalstats,metadata=mode=print:file=-', '-f', 'null', '-'])
  const avg = (k: string) => { const v = [...r.out.toString().matchAll(new RegExp(`signalstats\\.${k}=([\\d.]+)`, 'g'))].map((x) => Number(x[1])); return v.reduce((a, b) => a + b, 0) / v.length }
  return autoLook({ avg: avg('YAVG'), low: avg('YLOW'), high: avg('YHIGH') })
}

/** Eine Clip-Szene als Zwischenstände, je groupFor Teilstücke ein mkv: Zuschnitt (crop um focus oder blur), Hook nur in der ersten Gruppe, Untertitel je Gruppe ab 0. Fortschritt über alle Gruppen. */
export async function clipSegs(job: ClipJob, name: string, dir: string, o: SegOpts, onProgress?: (pct: number) => void): Promise<Seg[]> {
  checkParts(job.parts, basename(job.file))
  const info = await probe(job.file)
  if (!info.w) throw new Error(`${basename(job.file)} hat kein Bild (reine Audiodatei): Ein Clip braucht ein Video.`)
  const late = job.parts.findIndex((p) => p.start >= info.duration - 0.2)
  if (late >= 0) throw new Error(`Ausschnitt ${late + 1} beginnt bei ${job.parts[late].start} s, das Video ist nur ${info.duration.toFixed(1)} s lang.`)
  // Pausen und Füllwörter kürzen vor padParts: an jedem Schnitt bleibt je Seite PAD stehen, ohne dass sich etwas doppelt. fillerQuiet nimmt nur echte Wortzeiten.
  const words = snapParts(job.parts, job.transcript)
  // Wortgrenzen können eine Kante wieder vor einen Bildwechsel ziehen (Transkript beim Einrasten in prepareClips noch nicht im Cache): erneut einrasten, jetzt mit Wortschutz
  const snapped = job.cuts?.length ? { ...words, parts: snapToScenes(words.parts, job.cuts, job.transcript).parts } : words
  if (snapped.moved) console.info(`[video] ${basename(job.file)}: ${snapped.moved} Schnittkante(n) an die Wortgrenze gelegt`)
  const quiet: Quiet[] = []
  if (job.pauses === 'kurz' && info.audio) for (const p of snapped.parts) {
    quiet.push(...(await silences(job.file, p.start, p.end, MIN_PAUSE)))
    if (job.transcript) quiet.push(...fillerQuiet(job.transcript, p.start, p.end))
  }
  // Übergang nur am ersten Stück eines geteilten parts: an gekürzten Pausen bleibt die übliche Blende. Standbild nur am letzten Stück, auch wenn follow
  // (prepareClips) den part nahtlos an Sprecherwechseln geteilt hat
  const split = snapped.parts.flatMap((p) => tighten([p], quiet).map((q, j, all) => {
    const r = j && q.transition ? { ...q, transition: undefined } : q
    return r.freeze && j < all.length - 1 ? { ...r, freeze: undefined } : r
  }))
  const parts = padParts(split.map((p, i) => (p.freeze && split[i + 1] && Math.abs(split[i + 1].start - p.end) < 1e-3 ? { ...p, freeze: undefined } : p)), info.duration, job.cuts), joined = seamless(parts), total = partsLength(parts), { size } = job
  // gleiches Seitenverhältnis: blur und split = crop; split ohne erkannte Facecam (cam) zeigt das ganze Bild wie blur
  const other = Math.abs(info.w / info.h - size.w / size.h) > 0.01, cam = job.fit === 'split' && other ? job.cam : undefined
  const blur = (job.fit === 'blur' || (job.fit === 'split' && !cam)) && other
  const [bw, bh] = [size.w, size.h].map((v) => Math.max(2, Math.round(v / 24) * 2)) // Grund klein weichzeichnen, dann hochskalieren: billig und weich
  const captions = job.transcript && job.captions !== 'aus' ? job.captions : null
  const live = job.style === 'lebendig', look = await lookFilter(job)
  if (job.hook?.trim() || captions || live || job.overlays?.some((x) => x.text?.trim() || x.items?.length) || job.chat) {
    // Eigener Unterordner: libass lädt alles in fontsdir, auch fertige Szenen. Relativ zu cwd = dir: kein Pfad-Escaping im Filter.
    await mkdir(join(dir, 'fonts'), { recursive: true })
    await Promise.all(job.font.files.map((b, i) => writeFile(join(dir, 'fonts', `font-${i}.ttf`), b)))
  }
  const segs: Seg[] = [], group = groupFor(Math.max(info.w * info.h, size.w * size.h))
  let done = 0
  for (let k0 = 0; k0 < parts.length; k0 += group) {
    const ps = parts.slice(k0, k0 + group), dur = partsLength(ps), first = !k0, last = k0 + group >= parts.length
    const id = `${name}-${n2(segs.length + 1)}`, hook = first ? job.hook?.trim() : undefined
    const words = captions ? clipWords(job.transcript!, ps, quiet) : []
    // Einblendungen je sichtbarem Stück der Quelle über alle parts, auf die Gruppe (ab 0) beschnitten; Blende nur an echten Enden, nicht an Gruppenkanten
    // vt: Sekunde im Einblend-Video am Anfang des Stücks – es läuft über die sichtbaren Stücke weiter, ab from
    const ovs = (job.overlays ?? []).flatMap((x) => clipSpans(parts, x.start, x.end).map(([a, b], k, all) => [a, b, all.slice(0, k).reduce((q, [c, d]) => q + d - c, 0)]).filter(([a, b]) => b > done && a < done + dur)
      .map(([a, b, run]) => ({ ...x, a: Math.max(0, a - done), b: Math.min(dur, b - done), len: clipSpans(parts, x.start, x.end).reduce((q, [c, d]) => q + d - c, 0), vt: (x.from ?? 0) + run + Math.max(0, done - a), fade: [a >= done - 1e-3, b <= done + dur + 1e-3] as [boolean, boolean] })))
    const texts = ovs.filter((x) => x.text?.trim() || x.items?.length || (x.art === 'markierung' && x.box))
      .map((x) => ({ start: x.a, end: x.b, text: x.text, pos: x.pos, art: x.art, sub: x.sub, items: x.items, box: x.box, el: x.vt - (x.from ?? 0), len: x.len, fade: x.fade })), imgs = ovs.filter((x) => x.image || x.video)
    const pix = ovs.filter((x) => x.art === 'verpixeln' && x.box)
    const chat = job.chat && chatAss(job.chat.msgs, parts, { ...job.chat, size, font: job.font.name, win: [done, done + dur] })
    const subs = !!hook || words.length > 0 || live || texts.length > 0 || !!chat?.events.length
    if (subs) await writeFile(join(dir, `${id}.ass`), assSubs({ size, font: job.font.name, bold: job.font.bold, accent: job.accent, hook, hookDur: Math.min(4, dur), cues: captions && words.length ? cues(words, captions) : [], mode: job.captions, style: job.style, bar: { off: done, dur, total }, ...(texts.length ? { overlays: texts } : {}), ...(job.captionPos ? { captionPos: job.captionPos } : {}), ...(chat?.events.length ? { chat } : {}) }))
    // Überblendung je Naht i (zwischen ps[i-1] und ps[i]): halbe Länge in Frames, begrenzt durch Videoanfang/-ende und harte Bildwechsel (cuts)
    const room = (s: number, dir: 1 | -1) => Math.min(dir > 0 ? info.duration - s : s, ...(job.cuts ?? []).map((c) => (c - s) * dir).filter((d) => d > -1e-6))
    // Frames je Ausschnitt aus den aufsummierten Nahtzeiten, nicht je Ausschnitt abgerundet: so laufen Bild, Ton und Untertitel nicht auseinander
    // Zeiten auf der Clip-Achse (Quelllänge durch Tempo); Vorlauf/Nachlauf in der Quelle = Frames/30 · Tempo
    const at = ps.reduce<number[]>((s, p) => [...s, s[s.length - 1] + partLen(p)], [0]), sp = ps.map(speedOf), fr = (t: number) => Math.round(t * 30)
    const own = (i: number) => fr(at[i + 1]) - fr(at[i]) // Frames ohne Überblendung; zwei Blenden eines Ausschnitts dürfen sich nicht überlappen
    // je Naht i: Bild hv Frames je Seite (nach Art des Schnitts, eigener Übergang CUT.momentFrames, none hart), Ton ha ≤ CUT.jumpFrames/2; jede Naht zieht nur ihre eigene Überlappung ab, Bild und Ton bleiben gleich lang
    const blend = (p: Part, gap: number) => (p.transition === 'none' ? 0 : XFADE[p.transition ?? ''] ? CUT.momentFrames : cutFrames(gap))
    const hv = ps.map((p, i) => (i === 0 || joined[k0 + i] ? 0
      : Math.max(0, Math.min(Math.floor(blend(p, p.start - ps[i - 1].end) / 2), Math.floor(own(i - 1) / 2), Math.floor(own(i) / 2), Math.floor((room(ps[i - 1].end, 1) * 30) / sp[i - 1]), Math.floor((room(p.start, -1) * 30) / sp[i])))))
    const ha = hv.map((h) => Math.min(h, CUT.jumpFrames / 2))
    const graph = ps.map((p, i) => {
      const before = (hv[i] ?? 0) / 30, frames = own(i) + (hv[i] ?? 0) + (hv[i + 1] ?? 0), a0 = (ha[i] ?? 0) / 30
      const c = cropRect(info, size, p.focus), len = partLen(p) + a0 + (ha[i + 1] ?? 0) / 30, k = k0 + i // len: Ton (Clip-Zeit)
      // Punch-in von Hand mal Stil-Zoom; ponytail: bei echtem blur ohne Punch-in (gälte nur fürs Vordergrundbild), Upgrade: zoomCrop vor dem scale des Vordergrunds
      const pz = Math.min(ZOOM.max, Math.max(ZOOM.min, p.zoom ?? 1))
      // Standbild: F Frames des letzten bewegten Bilds halten, dazu der Vorlauf der Blende danach (die blendet aus dem Standbild, nicht aus der Quelle nach dem Ende)
      const fz = freezeOf(p), F = Math.round(fz * 30), h1 = hv[i + 1] ?? 0
      const end = F ? `trim=end_frame=${Math.max(1, frames - F - h1)},tpad=stop_mode=clone:stop=${frames - Math.max(1, frames - F - h1)}` : `trim=end_frame=${frames}`
      const fit = cam ? splitFilter(splitRects(info, size, cam, p.focus), size, i) : blur
        ? `split[b${i}][f${i}];[b${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=4,lutyuv=y=val*0.55,scale=${size.w}:${size.h}[g${i}];` +
          `[f${i}]scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease:force_divisible_by=2[h${i}];[g${i}][h${i}]overlay=(W-w)/2:(H-h)/2`
        : cropFilter(c, size, (job.fit === 'blur' || job.fit === 'split' ? 1 : zoomOf(job.style, cutIndex(parts, k))) * pz, p.track ? { src: info, keys: p.track, start: p.start - before * sp[i] } : undefined) // k über alle Gruppen; start = Anfang der Eingabe (mit Vorlauf); Zoom wechselt nur an echten Schnitten, nie bei blur
      // Ton ab p.start − a0: die Eingabe beginnt beim längeren Bild-Vorlauf (before)
      // Tempo nach dem Zuschnitt im Quellbereich, dann Lautstärke des Originaltons
      const vol = p.volume !== undefined && p.volume !== 1 ? `volume=${Math.min(2, Math.max(0, p.volume))},` : ''
      // Standbild: Quellton nur bis zum Ende der Bewegung, kurz ausgeblendet, dann Stille bis len
      const src = fz ? len - fz - (ha[i + 1] ?? 0) / 30 : len, still = fz ? `afade=t=out:st=${sec(Math.max(0, src - AFADE))}:d=${AFADE},apad=whole_dur=${sec(len)},` : ''
      const a = info.audio ? `[${i}:a]atrim=start=${sec((before - a0) * sp[i])}:duration=${sec(src * sp[i])},asetpts=PTS-STARTPTS,${atempo(sp[i]).map((x) => `${x},`).join('')}${vol}${still}` : `anullsrc=r=48000:cl=stereo,atrim=duration=${sec(len)},`
      // Tonblende nur an Kanten ohne Überblendung; nahtlose Kanten bleiben unberührt
      const fade = `${joined[k] || ha[i] ? '' : `,afade=t=in:d=${AFADE}`}${joined[k + 1] || ha[i + 1] ? '' : `,afade=t=out:st=${sec(Math.max(0, len - AFADE))}:d=${AFADE}`}`
      // Tempo: Zuschnitt (Kamerafahrt in Quellzeit) vor dem Umrechnen der Zeitstempel; ohne Tempo die alte Reihenfolge
      // stabil: deshake vor dem Zuschnitt (braucht das ganze Bild); kostet etwa so viel Rechenzeit wie das Encoden selbst
      const ds = job.stabil ? 'deshake,' : ''
      // Standbild: tpad erst hinter dem Zuschnitt, sonst schwenkte eine Kamerafahrt (track, Ausdruck in t) im Standbild weiter
      const v = sp[i] === 1 ? (F ? `[${i}:v]${ds}setpts=PTS-STARTPTS,fps=30,${fit},${end},` : `[${i}:v]${ds}setpts=PTS-STARTPTS,fps=30,${end},${fit},`) : `[${i}:v]${ds}setpts=PTS-STARTPTS,${fit},setpts=PTS/${sp[i]},fps=30,${end},`
      return `${v}setsar=1,format=yuv420p[v${i}];` +
        `${a}aformat=sample_rates=48000:channel_layouts=stereo${fade}[a${i}]`
    })
    // Bild und Ton getrennt verketten: an Nähten mit Überblendung xfade/acrossfade, sonst concat; offset = bisherige Frames minus Blende.
    // concat liefert die Zeitbasis 1/1000000, xfade verlangt bei beiden Eingängen dieselbe: darum settb zurück auf 1/30.
    // offset einen halben Frame vor der ersten Blendfläche: xfade beginnt beim ersten Frame mit pts ≥ offset, sec() rundet auf 1 ms
    let cv = '[v0]', ca = '[a0]', n = own(0) + (hv[1] ?? 0)
    for (let i = 1; i < ps.length; i++) {
      const h = hv[i], g = ha[i], frames = own(i) + h + (hv[i + 1] ?? 0)
      graph.push(h ? `${cv}[v${i}]xfade=transition=${XFADE[ps[i].transition ?? ''] ?? 'fade'}:duration=${sec((2 * h) / 30)}:offset=${sec((n - 2 * h - 0.5) / 30)}[xv${i}]` : `${cv}[v${i}]concat=n=2:v=1:a=0,settb=1/30[xv${i}]`,
        g ? `${ca}[a${i}]acrossfade=d=${sec((2 * g) / 30)}[xa${i}]` : `${ca}[a${i}]concat=n=2:v=0:a=1[xa${i}]`)
      cv = `[xv${i}]`; ca = `[xa${i}]`; n += frames - 2 * h
    }
    // Look aufs Video vor allen Einblendungen
    if (look) { graph.push(`${cv}${look}[lk]`); cv = '[lk]' }
    // Bild-Einblendungen vor den Untertiteln (die liegen oben): je Stück ein Input ab 0, weich per Alpha-Blende, Rand 4 % der Breite
    // video: Input ab vt, Zeitstempel auf a verschoben; voll: füllt das Format, ein Bild (nicht Folie) mit langsamem Zoom aus einem Einzelbild (zoompan d = Frames)
    // auf doppelter Größe, damit die Ganzzahl-Positionen von zoompan nicht ruckeln
    const r4 = Math.round(size.w * 0.04), low = Math.round(capMargin(size) + Math.min(size.w, size.h) * 0.16) // unten: über der Untertitelzeile wie der Text
    const kb = (x: { image?: string; video?: string; slide?: number; pos?: Overlay['pos'] }) => x.pos === 'voll' && !x.video && !x.slide
    imgs.forEach((x, j) => {
      const d = sec(Math.min(0.2, (x.b - x.a) / 2)), pos = x.pos ?? 'unten', voll = pos === 'voll', n = Math.ceil((x.b - x.a) * 30) + 2
      const ox = voll ? 0 : pos.endsWith('links') ? r4 : pos.endsWith('rechts') ? `W-w-${r4}` : '(W-w)/2', oy = voll ? 0 : pos.startsWith('oben') ? r4 : pos === 'mitte' ? '(H-h)/2' : `H-h-${low}`
      const cover = (w: number, h: number) => `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
      const fit = kb(x) ? `${cover(2 * size.w, 2 * size.h)},zoompan=z='1+${Math.min(KEN_BURNS.max, KEN_BURNS.perSec * (x.b - x.a))}*on/${n}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=${n}:s=${size.w}x${size.h}:fps=30,setpts=PTS-STARTPTS+${sec(x.a)}/TB`
        : `${x.video ? `setpts=PTS-STARTPTS+${sec(x.a)}/TB,` : ''}${voll ? cover(size.w, size.h) : `scale=${Math.round(OVERLAY_W[x.size ?? 'mittel'] * size.w)}:-1`}`
      graph.push(`[${ps.length + j}:v]${fit},format=rgba${x.fade[0] ? `,fade=t=in:st=${sec(x.a)}:d=${d}:alpha=1` : ''}${x.fade[1] ? `,fade=t=out:st=${sec(x.b - Number(d))}:d=${d}:alpha=1` : ''}[o${j}]`,
        `${cv}[o${j}]overlay=${ox}:${oy}:enable='between(t,${sec(x.a)},${sec(x.b)})'[ov${j}]`)
      cv = `[ov${j}]`
    })
    // Verpixeln: Bereich (Anteile des fertigen Bildes, gerade px) klein rechnen und blockig zurück, ohne Blende – soll durchgehend unkenntlich sein
    pix.forEach((x, j) => {
      const [bx, by, bw2, bh2] = x.box!, even = (v: number) => Math.max(2, Math.round(v / 2) * 2), blk = Math.max(4, Math.round(Math.min(size.w, size.h) / 36))
      const cw = Math.min(even(bw2 * size.w), size.w), ch = Math.min(even(bh2 * size.h), size.h), cx = Math.min(even(bx * size.w), size.w - cw), cy = Math.min(even(by * size.h), size.h - ch)
      graph.push(`${cv}split[pa${j}][pb${j}]`, `[pb${j}]crop=${cw}:${ch}:${cx}:${cy},scale=${Math.max(1, Math.round(cw / blk))}:${Math.max(1, Math.round(ch / blk))}:flags=area,scale=${cw}:${ch}:flags=neighbor[pc${j}]`,
        `[pa${j}][pc${j}]overlay=${cx}:${cy}:enable='between(t,${sec(x.a)},${sec(x.b)})'[px${j}]`)
      cv = `[px${j}]`
    })
    const vf = [subs && `ass=${id}.ass:fontsdir=fonts`, o.fadeIn && first && `fade=t=in:d=${FADE}`, o.fadeOut && last && `fade=t=out:st=${sec(Math.max(0, dur - FADE))}:d=${FADE}`]
    // Sprachkette nach dem concat: Entrauschen lernt über die ganze Gruppe; vor den Szenen-Blenden, sonst höbe der Kompressor sie an
    const af = [job.ton === 'klar' && info.audio && SPEECH, o.fadeIn && first && `afade=t=in:d=${FADE}`, o.fadeOut && last && `afade=t=out:st=${sec(Math.max(0, dur - FADE))}:d=${FADE}`]
    // Soundeffekte dieser Gruppe (at in Clipzeit ab done) als weitere Eingänge hinter Teilstücken und Einblendungen. ponytail: ein Effekt über das Gruppenende hinaus wird dort abgeschnitten
    const fx = (job.sfx ?? []).filter((f) => f.at >= done && (f.at < done + dur || last))
    graph.push(`${cv}${vf.filter(Boolean).join(',') || 'null'}[v]`, `${ca}${af.filter(Boolean).join(',') || 'anull'}[as]`,
      sfxGraph('as', fx.map((f, j) => ({ input: ps.length + imgs.length + j, at: f.at - done, gain: f.gain })), 'a'))
    // je Ausschnitt mit Vorlauf für die Überblendung; 0,1 s Reserve, damit trim die Frames sicher bekommt (atrim schneidet den Ton genau)
    const inputs = [...ps.flatMap((p, i) => ['-ss', sec(p.start - ((hv[i] ?? 0) / 30) * sp[i]), '-t', sec(p.end - p.start + (((hv[i] ?? 0) + (hv[i + 1] ?? 0)) / 30) * sp[i] + 0.1 * Math.max(1, sp[i])), '-i', job.file]), // Reserve 0,1 s Clip-Zeit auch bei Zeitraffer
      ...imgs.flatMap((x) => (x.video ? ['-ss', sec(x.vt), '-t', sec(x.b - x.a + 0.5), '-i', x.video] : kb(x) ? ['-i', x.image!] : ['-loop', '1', '-framerate', '30', '-t', sec(x.b), '-i', x.image!])),
      ...fx.flatMap((f) => ['-i', f.file])]
    const file = join(dir, `${id}.mkv`)
    const args = [...inputs, '-filter_complex', graph.join(';'), '-map', '[v]', '-map', '[a]', ...video(o.preset, o.hevc), ...PCM, file]
    const ro = { cwd: dir, duration: dur, onProgress: onProgress && ((pct: number) => onProgress(Math.floor(((done + (dur * pct) / 100) / total) * 100))) }
    await ffx(args, ro, o.phone)
    const music = ps.flatMap((p, i): [number, number, number][] => (p.music === undefined ? [] : [[at[i], at[i + 1], p.music]]))
    segs.push({ file, dur, ...(music.length ? { music } : {}), ...(words.length ? { cues: cues(words, 'satz') } : {}), ...(first ? { xml: [{ at: 0, src: job.file, info, parts, marks: clipMarks(job.hook, job.overlays, parts) }] } : {}) }) // SRT (nur mit Untertiteln, captions ≠ aus und Transkript da) immer in Zeilen, auch bei wort
    done += dur
  }
  return segs
}

/** Titelbild (JPEG in Ausgabegröße) bei Quellsekunde t (Standard: Mitte des ersten parts): Zuschnitt wie der Clip, Hook eingebrannt, ohne Einblendung und Balken. */
export async function encodeCover(job: ClipJob, t: number | undefined, out: string, dir: string, phone?: Phone) {
  const info = await probe(job.file), p0 = job.parts[0]
  const at = Math.min(Math.max(0, t ?? (p0.start + p0.end) / 2), Math.max(0, info.duration - 0.1))
  const p = job.parts.find((x) => at >= x.start && at <= x.end) ?? p0
  // Kamerafahrt: focus linear zwischen den Stützpunkten, davor und danach konstant (wie cropFilter)
  const k = p.track?.findIndex(([kt]) => kt > at) ?? -1, tr = p.track
  const focus = !tr?.length ? p.focus : k < 0 ? tr[tr.length - 1][1] : k === 0 ? tr[0][1] : tr[k - 1][1] + ((tr[k][1] - tr[k - 1][1]) * (at - tr[k - 1][0])) / (tr[k][0] - tr[k - 1][0])
  const { size } = job, hook = job.hook?.trim(), name = basename(out).replace(/\.\w+$/, ''), look = await lookFilter(job)
  const [bw, bh] = [size.w, size.h].map((v) => Math.max(2, Math.round(v / 24) * 2))
  const other = Math.abs(info.w / info.h - size.w / size.h) > 0.01, cam = job.fit === 'split' && other ? job.cam : undefined
  const fit = cam ? splitFilter(splitRects(info, size, cam, focus), size) : (job.fit === 'blur' || job.fit === 'split') && other
    ? `split[b][f];[b]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=4,lutyuv=y=val*0.55,scale=${size.w}:${size.h}[g];` +
      `[f]scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease:force_divisible_by=2[h];[g][h]overlay=(W-w)/2:(H-h)/2`
    : cropFilter(cropRect(info, size, focus), size)
  if (hook) {
    await mkdir(join(dir, 'fonts'), { recursive: true })
    await Promise.all(job.font.files.map((b, i) => writeFile(join(dir, 'fonts', `font-${i}.ttf`), b)))
    // Einblendung weg: das Standbild läge sonst im Moment ganz durchsichtig
    await writeFile(join(dir, `${name}.ass`), assSubs({ size, font: job.font.name, bold: job.font.bold, accent: job.accent, hook, hookDur: 1, cues: [], mode: 'aus', style: job.style }).replace(HOOK_FADE, ''))
  }
  await ffx(['-ss', sec(at), '-i', job.file, '-frames:v', '1', '-update', '1', '-vf', `${fit}${look ? `,${look}` : ''},setsar=1${hook ? `,ass=${name}.ass:fontsdir=fonts` : ''}`, '-q:v', '2', out], { cwd: dir }, phone)
}

/** Standbild (PNG in Ausgabegröße) als Zwischenstand von STILL Sekunden mit stillem Ton, gleiche Video-Parameter wie die Clips. */
export async function encodeStill(png: string, out: string, dir: string, o: SegOpts, onProgress?: (pct: number) => void): Promise<Seg> {
  const vf = ['setsar=1', o.fadeIn && `fade=t=in:d=${FADE}`, o.fadeOut && `fade=t=out:st=${STILL - FADE}:d=${FADE}`].filter(Boolean).join(',')
  await ffx(['-loop', '1', '-framerate', '30', '-t', String(STILL), '-i', png, '-f', 'lavfi', '-t', String(STILL), '-i', 'anullsrc=r=48000:cl=stereo', '-vf', vf, ...video(o.preset, o.hevc), ...PCM, out], { cwd: dir, duration: STILL, onProgress }, o.phone)
  return { file: out, dur: STILL }
}

/** Endschritt je Ausgabedatei: Zwischenstände (alle in dir) per concat-Demuxer verbinden, Video kopiert, Ton einmal AAC.
 *  Musik läuft in Schleife über die ganze Länge (1 s Ein-, 2 s Ausblende) und weicht der Sprache (Sidechain-Kompressor), danach loudnorm. */
export async function finish(segs: Seg[], out: string, dir: string, o: { loudnorm?: boolean; music?: Music; onProgress?: (pct: number) => void; phone?: Phone; hevc?: boolean } = {}) {
  const dur = segs.reduce((s, x) => s + x.dur, 0), list = `${basename(out)}.txt`
  await writeFile(join(dir, list), segs.map((s) => `file '${basename(s.file)}'`).join('\n'))
  // Musikpegel je Ausschnitt (Seg.music): Lautstärke als Ausdruck über die Zeit, sonst feste Zahl
  let off = 0
  // gain (Angleich der Datei) wirkt wie bei volume auch auf die Pegel je Ausschnitt, sonst springt der Pegel an deren Grenzen
  const gain = o.music?.gain ?? 1
  const spans = segs.flatMap((x) => { const r = (x.music ?? []).map(([a, b, v]): [number, number, number] => [off + a, off + b, Math.min(1, Math.max(0, v)) * gain]); off += x.dur; return r })
  const vol = Math.min(1, Math.max(0, o.music?.volume ?? DUCK.volume)) * gain
  const graph = (loud: string) => ['-filter_complex', o.music ? `${duckMusic('0:a', '1:a', spans.length ? `${levelExpr(vol, spans)}:eval=frame` : vol, dur, 'mx')};[mx]anull${loud}[a]` : `[0:a]anull${loud}[a]`]
  const music = o.music ? ['-stream_loop', '-1', '-i', resolve(o.music.file)] : []
  const input = ['-f', 'concat', '-safe', '0', '-i', list, ...music]
  // Messlauf nur über den Ton (schnell, auf dem PC)
  const loud = o.loudnorm ? await measuredNorm(-14, input, graph, dir, dur, o.onProgress) : ''
  await ffx([...input, ...graph(loud), '-map', '0:v', '-map', '[a]', '-c:v', 'copy', ...(o.hevc ? ['-tag:v', 'hvc1'] : []), ...AUDIO, ...FAST, out], { cwd: dir, duration: dur, onProgress: o.onProgress && ((p) => o.onProgress!(o.loudnorm ? 50 + Math.floor(p / 2) : p)) }, o.phone)
}

/** Folienübergang im mp4: letzten Zwischenstand der Szene davor und ersten der Szene (beide in dir) per xfade (ffmpeg-Typ) und acrossfade zu einem neuen
 *  verbinden, Blende 0,5 s (höchstens die halbe Länge eines der beiden); Länge = Summe − Blende, Musikpegel des zweiten rücken mit. */
// ponytail: kodiert beide Nahtstücke ganz neu (bis 20 parts), ohne Fortschritt und immer auf dem PC; Upgrade: nur die Blende neu kodieren und den Rest kopieren
export async function joinSegs(a: Seg, b: Seg, transition: string, out: string, dir: string, preset: string, phone?: Phone, hevc?: boolean): Promise<Seg> {
  const fa = Math.round(a.dur * 30), d = Math.max(1, Math.min(15, Math.floor(fa / 2), Math.floor(Math.round(b.dur * 30) / 2))), off = (fa - d) / 30
  // offset einen halben Frame vor der Blende wie in clipSegs
  await ffx(['-i', basename(a.file), '-i', basename(b.file), '-filter_complex', `[0:v][1:v]xfade=transition=${transition}:duration=${sec(d / 30)}:offset=${sec((fa - d - 0.5) / 30)}[v];[0:a][1:a]acrossfade=d=${sec(d / 30)}[a]`,
    '-map', '[v]', '-map', '[a]', ...video(preset, hevc), ...PCM, out], { cwd: dir }, phone)
  const music = [...(a.music ?? []), ...(b.music ?? []).map(([x, y, v]): [number, number, number] => [x + off, y + off, v])]
  const subs = [...(a.cues ?? []), ...(b.cues ?? []).map((c) => ({ ...c, start: c.start + off, end: c.end + off }))]
  const xml = [...(a.xml ?? []), ...(b.xml ?? []).map((s) => ({ ...s, at: s.at + off }))]
  return { file: out, dur: a.dur + b.dur - d / 30, ...(music.length ? { music } : {}), ...(subs.length ? { cues: subs } : {}), ...(xml.length ? { xml } : {}) }
}

/** Eine Clip-Szene fertig als MP4 (Zwischenstände + Endschritt). Gibt die Länge (s) zurück. */
export async function encodeClip(job: ClipJob, out: string, dir: string, onProgress?: (pct: number) => void, music?: Music): Promise<number> {
  const segs = await clipSegs(job, basename(out).replace(/\.\w+$/, ''), dir, { preset: presetFor(partsLength(job.parts ?? [])) }, onProgress && ((p) => onProgress(Math.floor(p * 0.9))))
  await finish(segs, out, dir, { loudnorm: job.loudnorm, music, onProgress: onProgress && ((p) => onProgress(90 + Math.floor(p / 10))) })
  return segs.reduce((s, x) => s + x.dur, 0)
}

// Head-Schrift des Themes als TTF (Premium- oder eigene Schrift), sonst Archivo Bold aus dem App-Paket. Buffer statt Pfad: im asar kann ffmpeg nicht lesen.
export async function subFont(deck: Deck): Promise<SubFont> {
  const head = resolveTheme(deck.theme).head
  const f = (await import('./export-pptx')).fontsOf(deck).find((x) => x.family === head.pptx)
  if (f) return { name: f.family, files: [f.regular, ...(f.bold ? [f.bold] : [])], bold: !!f.bold }
  const { app } = await import('electron')
  return { name: 'Archivo', files: [await readFile(join(app.getAppPath(), 'assets/fonts/Archivo-Bold.ttf'))], bold: true }
}

/** asset://local/<pfad> oder absoluter Pfad → lokale Datei; auf einem anderen Gerät auf den lokalen Deckwerk-Ordner umleiten. what nennt das Feld in Fehlermeldungen. */
export function mediaPath(src: string, what: string) {
  const p = src.startsWith('asset://') ? assetPath(src) : src
  if (!isAbsolute(p)) throw new Error(`${what} muss ein asset://-Pfad oder ein absoluter Dateipfad sein.`)
  if (!MEDIA_EXT.test(p)) throw new Error(`${what} ist keine Mediendatei (${basename(p)}).`)
  return localAsset(p)
}
export const videoPath = (src: string, slide: number, field = 'video') => mediaPath(src, `Folie ${slide}: „${field}“`)
const sfxOf = (clip: ClipContent, slide: number) => (clip.sfx ?? []).map((f) => {
  const file = mediaPath(f.src, `Folie ${slide}: „sfx“`)
  if (!existsSync(file)) throw new Error(`Folie ${slide}: Soundeffekt fehlt (${basename(file)}).`)
  return { ...f, file }
})

const MAX_SECONDS = 6 * 3600 // Material je Export
const STALE = 6 * 3600e3 // Job-Ordner älter als das (ms): Rest nach einem Absturz
let queue: Promise<unknown> = Promise.resolve()

/** Job-Ordner abgestürzter Exporte (prefix, älter als STALE) in parent wegräumen; mtime ändert sich mit jeder neuen Datei darin. Legt parent an. */
export async function sweepStale(parent: string, prefix: string) {
  await mkdir(parent, { recursive: true })
  for (const e of await readdir(parent, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(prefix)) continue
    const p = join(parent, e.name), st = await stat(p).catch(() => null)
    if (st && Date.now() - st.mtimeMs > STALE) await rm(p, { recursive: true, force: true })
  }
}

/** Musik einmal 0,1 s anspielen: fehlende Datei oder Tonspur sonst erst nach dem Encoden („Stream specifier“). */
export const checkMusic = (file: string) => runFfmpeg(['-v', 'error', '-i', resolve(file), '-map', '0:a:0', '-t', '0.1', '-f', 'null', '-']).catch((e: Error) => {
  throw new Error(`Die Musikdatei ${file} ${/No such file/i.test(e.message) ? 'fehlt' : /matches no streams/i.test(e.message) ? 'hat keine Tonspur' : 'ist nicht lesbar'}.`)
})

/** Deck als Video: mp4 = alle Folien hintereinander in `${base}.mp4`, clips = je Clip-Folie `${base}-01.mp4` usw. Fortschritt 0–100 über alle Szenen.
 *  o.music: Hintergrundmusik (Pfad löst der Aufrufer auf), in jeder Ausgabedatei.
 *  Exporte laufen nacheinander: UI und KI-Tool export_deck können gleichzeitig starten, jeder öffnet bis zu 20 Decoder (groupFor). */
export function exportVideo(...a: Parameters<typeof exportOnce>): Promise<string[]> {
  const run = queue.then(() => exportOnce(...a))
  queue = run.catch(() => {})
  return run
}

async function exportOnce(deck: Deck, target: string, format: 'mp4' | 'clips', transcriptOf: (file: string) => Promise<Transcript | null>, onProgress: (pct: number) => void = () => {}, o: { music?: Music; phone?: Phone } = {}): Promise<string[]> {
  const base = resolve(target), parent = dirname(base)
  phoneFault.reason = ''
  await sweepStale(parent, '.video-tmp-')
  // Ausgeblendete Folien nie als Szene: der Aufrufer reicht sie mit, weil Clips sie als Einblendung (overlays.slide, Nummer in deck.slides) zeigen
  const scenes = deck.slides.map((s, i) => ({ i, clip: s.layout === 'clip' ? (s.content as ClipContent) : undefined })).filter((x) => !deck.slides[x.i].hidden && (format === 'mp4' || x.clip))
  if (!scenes.length) throw new Error('Keine Clip-Folie im Deck: Einzelne Clips entstehen nur aus Folien mit dem Layout „clip“.')
  // Vorab prüfen, damit ein Fehler in Folie 5 nicht erst nach vier fertigen Szenen auffällt
  for (const { i, clip } of scenes) {
    if (!clip) continue
    if (!clip.video) throw new Error(`Folie ${i + 1}: Im Clip fehlt das Video. Erst ein Video anhängen und unter „video“ eintragen.`)
    videoPath(clip.video, i + 1)
    sfxOf(clip, i + 1)
    checkParts(clip.parts, `Folie ${i + 1}`)
    for (const x of clip.overlays ?? []) {
      if (x.video) {
        const v = videoPath(x.video, i + 1, 'video')
        if (!VIDEO_FILE.test(v)) throw new Error(`Folie ${i + 1}: Die Einblendung „video“ braucht eine Videodatei, nicht ${basename(v)}.`)
        if (!(await stat(v).catch(() => null))) throw new Error(`Folie ${i + 1}: Das Video der Einblendung fehlt (${basename(v)}).`)
      }
      if (x.slide !== undefined) {
        const s = deck.slides[x.slide - 1]
        if (!s) throw new Error(`Folie ${i + 1}: Die Einblendung zeigt Folie ${x.slide}, das Deck hat nur ${deck.slides.length} Folien.`)
        if (!s.hidden) throw new Error(`Folie ${i + 1}: Folie ${x.slide} ist nicht ausgeblendet. Einblend-Folien brauchen hidden: true, sonst stehen sie zusätzlich als eigene Szene im Video.`)
        if (s.layout === 'clip') throw new Error(`Folie ${i + 1}: Folie ${x.slide} ist ein Clip. Eingeblendet werden nur Folien ohne Video (Diagramm, Zahl, Liste, Zitat).`)
      }
      const img = x.image && videoPath(x.image, i + 1, 'image')
      if (!img) continue
      if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(img)) throw new Error(`Folie ${i + 1}: Die Einblendung braucht ein Rasterbild (PNG, JPEG, WebP, BMP oder GIF), nicht ${basename(img)}.`)
      if (!(await stat(img).catch(() => null))) throw new Error(`Folie ${i + 1}: Das Bild der Einblendung fehlt (${basename(img)}).`)
    }
  }
  if (o.music) o = { ...o, music: await withMusicGain(o.music) }
  // Gewählte Auflösung nie über dem größten Quell-Ausschnitt (videoSize); ohne Wahl kein Proben, alles wie bisher
  const sources = deck.videoRes ? (await Promise.all([...new Set(scenes.flatMap(({ i, clip }) => (clip ? [videoPath(clip.video, i + 1)] : [])))].map((f) => probe(f).catch(() => null)))).filter((x) => x !== null) : []
  const size = videoSize(sizeOf(deck), deck.videoRes, sources), accent = resolveTheme(deck.theme).c.accent, short = Math.min(size.w, size.h)
  if (size.w < outSize(sizeOf(deck), deck.videoRes).w) console.warn(`[video] ${deck.videoRes} gedeckelt auf ${size.w}×${size.h}: die Quelle ist kleiner, hochskaliert wird nicht`)
  const hevc = short >= 2160 && (await hasEncoder('libx265'))
  if (short >= 2160 && !hevc) console.warn('[video] ffmpeg ohne libx265: Export ab 4K mit H.264')
  // Das Handy-ffmpeg hat kein x265, und über 1080p rechnet es zu lange
  if (short > 1080 && o.phone) { console.log(`[video] ${size.w}×${size.h}: über 1080p rechnet der PC allein, nicht das Handy`); o = { ...o, phone: undefined } }
  // Gewichte für den Fortschritt: Länge je Szene, dazu je Ausgabedatei der Endschritt (Video wird nur kopiert)
  const weights = scenes.map(({ clip }) => (clip ? partsLength(clip.parts) : STILL))
  const sum = weights.reduce((a, b) => a + b, 0), total = sum * 1.2, preset = presetFor(sum, short >= 2160)
  if (sum > MAX_SECONDS) throw new Error(`Das Material ist zusammen ${(sum / 3600).toFixed(1)} h lang, ein Video-Export geht bis 6 h. Bitte Ausschnitte kürzen oder das Deck teilen.`)
  // Platz grob vorab (H.264 ~1,5 MB/s bei 1080p, H.265 etwa die Hälfte, PCM 0,19 MB/s, ×1,5 Reserve): sonst bricht ffmpeg erst nach Minuten am vollen Datenträger ab
  const need = sum * (((hevc ? 0.75e6 : 1.5e6) * size.w * size.h) / (1920 * 1080) + 0.19e6) * 1.5, fs = await statfs(parent), free = fs.bavail * fs.bsize
  if (free < need) throw new Error(`Zu wenig freier Speicherplatz für den Video-Export: nötig sind rund ${Math.ceil(need / 1e8) / 10} GB, frei ${Math.floor(free / 1e8) / 10} GB.`)
  let done = 0
  const step = (w: number) => (pct: number) => onProgress(Math.min(100, Math.floor(((done + (w * pct) / 100) / total) * 100)))
  // Übergang mit xfade-Typ (außer color): echte Überblendung, die Nahtstücke beider Szenen werden neu kodiert (joinSegs). Sonst ≠ none (morph = harter Schnitt):
  // Einblende aus Schwarz am Anfang der Folie, Abblende am Ende der Szene davor. Zwischentitel (Folien ohne Video) blenden immer: der harte Sprung auf ein Standbild wirkte abrupt (12.10.)
  const seam = (k: number) => (format === 'mp4' && k > 0 && k < scenes.length ? joinOf(transitionOf(deck, scenes[k].i), !scenes[k].clip || !scenes[k - 1].clip) : undefined)
  const xf = (k: number) => (seam(k) === 'blend' ? XFADE[transitionOf(deck, scenes[k].i)] : undefined)
  const fades = (k: number) => seam(k) === 'schwarz'
  const dir = join(parent, `.video-tmp-${randomBytes(4).toString('hex')}`) // nicht /tmp: tmpfs läuft bei langen Videos voll
  await mkdir(dir, { recursive: true })
  try {
    const font = scenes.some((x) => x.clip) ? await subFont(deck) : { name: 'Archivo', files: [], bold: true }
    const all: Seg[] = [], moves: [string, string][] = [] // erst im Job-Ordner, am Ende per rename: ein Abbruch lässt den letzten guten Export stehen
    // Titelbild (.jpg) und Post-Text (.txt) neben das MP4; ein Fehler beim Bild kostet nur das Bild
    // Folie als PNG in Ausgabegröße (Standbild-Szene oder Einblendung)
    const slidePng = async (idx: number, file: string) => {
      const [{ renderSlide }, { nativeImage }] = await Promise.all([import('./render'), import('electron')])
      const png = join(dir, file)
      await writeFile(png, nativeImage.createFromBuffer((await renderSlide(deck, idx, { png: true })).png!).resize({ width: size.w, height: size.h, quality: 'best' }).toPNG())
      return png
    }
    // Untertitel aller Zwischenstände auf der Achse der Ausgabedatei (Standbilder und Folienblenden stecken in Seg.dur)
    const subsOf = (segs: Seg[]) => { let off = 0; return segs.flatMap((x) => { const r = (x.cues ?? []).map((c) => ({ ...c, start: c.start + off, end: c.end + off })); off += x.dur; return r }) }
    // Schnittliste (.xml für Premiere/Resolve) aus den Clip-Szenen auf derselben Achse; ein Fehler kostet nur die Schnittliste
    const extras = async (name: string, to: string, cover?: { job: ClipJob; t?: number }, post?: string, phone?: Phone, segs: Seg[] = []) => {
      const subs = subsOf(segs)
      if (subs.length) { await writeFile(join(dir, `${name}.srt`), srt(subs), 'utf8'); moves.push([join(dir, `${name}.srt`), `${to}.srt`]) }
      let off = 0
      const scenes = segs.flatMap((x) => { const r = (x.xml ?? []).map((s) => ({ ...s, at: s.at + off })); off += x.dur; return r })
      if (scenes.length && APP.pro) await Promise.resolve().then(() => writeFile(join(dir, `${name}.xml`), xmeml({ name: basename(to), size, duration: off, scenes }), 'utf8')).then(
        () => moves.push([join(dir, `${name}.xml`), `${to}.xml`]), (e: Error) => console.warn(`[video] Schnittliste ${basename(to)}.xml fehlgeschlagen:`, e.message))
      if (cover) await encodeCover(cover.job, cover.t, join(dir, `${name}.jpg`), dir, phone).then(
        () => moves.push([join(dir, `${name}.jpg`), `${to}.jpg`]), (e: Error) => console.warn(`[video] Titelbild ${basename(to)}.jpg fehlgeschlagen:`, e.message))
      if (post?.trim()) { await writeFile(join(dir, `${name}.txt`), post, 'utf8'); moves.push([join(dir, `${name}.txt`), `${to}.txt`]) }
    }
    const first: { cover?: { job: ClipJob; t?: number }; post?: string } = {} // mp4: Titelbild und Text der ersten Clip-Folie, die sie hat
    for (const [k, { i, clip }] of scenes.entries()) {
      const name = `szene-${n2(k + 1)}`, so: SegOpts = { preset, fadeIn: fades(k), fadeOut: fades(k + 1), phone: o.phone, hevc }
      let segs: Seg[], job: ClipJob | undefined
      if (clip) {
        const file = videoPath(clip.video, i + 1), captions = clip.captions ?? 'wort'
        const transcript = captions === 'aus' && clip.pauses !== 'kurz' ? null : await transcriptOf(file) // pauses kurz: Füllwörter aus dem Transkript
        if (!transcript && captions !== 'aus') console.warn(`[video] Kein Transkript für ${file}: Clip ohne Untertitel (erst transcribe_video aufrufen)`)
        const overlays = clip.overlays && await Promise.all(clip.overlays.map(async (x, j) => (x.image ? { ...x, image: videoPath(x.image, i + 1, 'image') }
          : x.video ? { ...x, video: videoPath(x.video, i + 1, 'video') } : x.slide ? { ...x, image: await slidePng(x.slide - 1, `einblendung-${n2(k + 1)}-${n2(j + 1)}.png`) } : x)))
        job = { file, parts: clip.parts, hook: clip.hook, captions, transcript, size, font, accent, pauses: clip.pauses, fit: clip.fit, style: clip.style, cuts: clip.cuts, ton: clip.ton, overlays, look: clip.look, stabil: clip.stabil, captionPos: clip.captionPos, cam: clip.cam, sfx: sfxOf(clip, i + 1) }
        if (clip.chat) {
          const msgs = await chatOf(file)
          if (msgs.length) job.chat = { ...clip.chat, msgs }
          else console.warn(`[video] Kein Chat zu ${basename(file)}: Chat-Einblendung entfällt (nur Importe von YouTube/Twitch bringen ihn mit)`)
        }
        segs = await clipSegs(job, name, dir, so, step(weights[k]))
        if (!first.cover && clip.cover !== undefined) first.cover = { job, t: clip.cover }
        first.post ??= clip.post?.trim() ? clip.post : undefined
      } else {
        const png = await slidePng(i, `folie-${n2(k + 1)}.png`)
        segs = [await encodeStill(png, join(dir, `${name}.mkv`), dir, so, step(weights[k]))]
      }
      done += weights[k]
      const t = xf(k)
      if (t) { // mp4: Nahtstücke zu einem verbinden, die beiden alten sofort weg
        const a = all.pop()!, b = segs[0]
        segs[0] = await joinSegs(a, b, t, join(dir, `${name}-x.mkv`), dir, preset, o.phone, hevc)
        await Promise.all([a, b].map((x) => rm(x.file, { force: true })))
      }
      if (format === 'mp4') { all.push(...segs); continue }
      await finish(segs, join(dir, `${name}.mp4`), dir, { loudnorm: true, music: o.music, phone: o.phone, hevc, onProgress: step(weights[k] * 0.2) })
      await Promise.all(segs.map((x) => rm(x.file, { force: true }))) // Zwischenstände sofort weg: bei langen Exporten sonst viele GB
      done += weights[k] * 0.2
      moves.push([join(dir, `${name}.mp4`), `${base}-${n2(k + 1)}.mp4`])
      await extras(name, `${base}-${n2(k + 1)}`, { job: job!, t: clip!.cover }, clip!.post, o.phone, segs)
    }
    if (format === 'mp4') {
      await finish(all, join(dir, 'gesamt.mp4'), dir, { loudnorm: true, music: o.music, phone: o.phone, hevc, onProgress: step(sum * 0.2) })
      moves.push([join(dir, 'gesamt.mp4'), `${base}.mp4`])
      await extras('gesamt', base, first.cover, first.post, o.phone, all)
    }
    for (const [from, to] of moves) await rename(from, to) // Job-Ordner liegt neben dem Ziel, also im selben Dateisystem
    onProgress(100)
    return moves.map(([, to]) => to).filter((f) => f.endsWith('.mp4')) // Nebendateien liegen daneben mit gleichem Stamm
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
