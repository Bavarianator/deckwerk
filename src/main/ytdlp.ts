// Import per Link über yt-dlp (Unlicense): Video, Kapitel, YouTube-„Meistgesehen“ und Chat-Replay als Highlight-Signal.
// Ohne Electron, damit Selbsttests es unter Node nutzen können.
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { download } from './download'
import { probe } from './ffmpeg'
import { twitchChat, twitchVodId } from './twitch-chat'

export interface Imported { file: string; title: string; duration: number; chat: string | null; heat: number[] | null; chapters: { start: number; title: string }[] }

const VERSION = '2026.08.19'
const BUILDS: Record<string, { name: string; sha256: string }> = {
  'linux-x64': { name: 'yt-dlp_linux', sha256: '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a' },
  'darwin-arm64': { name: 'yt-dlp_macos', sha256: '0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202' },
}

/** Umgebung für fremde Programme ohne API-Schlüssel: yt-dlp führt YouTubes Player-JS in Node aus. */
export function slimEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|LANG|LC_\w+|XDG_\w+|TMPDIR|https?_proxy|no_proxy)$/i
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.test(k))), ...extra }
}

/** Aufruf ohne Shell; stdout zeilenweise an onLine, vom stderr nur das Ende. Ohne jede Ausgabe für stallMs (Stillstand)
 *  wird die ganze Prozessgruppe beendet (yt-dlp startet ffmpeg) – kein Gesamt-Timeout, lange Streams laden lange. */
export function runTool(bin: string, args: string[], env: NodeJS.ProcessEnv, onLine: (l: string) => void = () => {}, stallMs = 5 * 60_000) {
  return new Promise<{ code: number | null; err: string; stalled: boolean }>((done, fail) => {
    const p = spawn(bin, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = '', rest = '', stalled = false, timer: NodeJS.Timeout | undefined
    const alive = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { stalled = true; try { process.kill(-p.pid!, 'SIGTERM') } catch { p.kill('SIGTERM') } }, stallMs)
    }
    alive()
    p.stdout.on('data', (c: Buffer) => { alive(); const ls = (rest + c).split(/[\r\n]+/); rest = ls.pop()!; ls.forEach(onLine) })
    p.stderr.on('data', (c: Buffer) => { alive(); err = (err + c).slice(-65536) })
    p.on('error', (e) => { clearTimeout(timer); fail(e) })
    p.on('close', (code) => { clearTimeout(timer); if (rest) onLine(rest); done({ code, err, stalled }) })
  })
}

/** Version (YYYY.MM.DD, als Text vergleichbar) oder '' */
const version = async (bin: string) => {
  let v = ''
  try { return (await runTool(bin, ['--version'], slimEnv(), (l) => { v ||= l.trim() })).code === 0 ? v : '' } catch { return '' } // nicht im PATH
}

// Fehlerzeilen von yt-dlp; ohne sie die letzten, sonst verdecken Retry-Warnungen die Ursache
const errorLines = (err: string) => {
  const ls = err.trim().split('\n'), e = ls.filter((l) => l.startsWith('ERROR:'))
  return (e.length ? e : ls).slice(-8).join('\n')
}

async function locate(models: string): Promise<string> {
  // ältere aus dem PATH (Distro-Pakete) kennen --js-runtimes nicht und scheitern oft an YouTube
  if ((await version('yt-dlp')) >= VERSION) return 'yt-dlp'
  const build = BUILDS[`${process.platform}-${process.arch}`]
  if (!build) throw new Error('yt-dlp fehlt. Bitte yt-dlp installieren (z. B. über den Paketmanager) und den Import noch einmal starten.')
  const file = join(models, `yt-dlp-${VERSION}`)
  if (existsSync(file) && (await version(file))) return file
  await rm(file, { force: true })
  await mkdir(models, { recursive: true })
  const tmp = `${file}.${process.pid}` // je Prozess, rename ersetzt atomar (wie ffmpeg.ts)
  try {
    console.log('[yt-dlp] lade', VERSION)
    await download(`https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}/${build.name}`, build.sha256, tmp)
    await chmod(tmp, 0o755)
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
  return file
}

let bin: Promise<string> | undefined
const ytdlpBin = (models: string) => (bin ??= locate(models).catch((e) => { bin = undefined; throw e }))

/** Gewicht einer Chat-Nachricht: 1, Hype/Emotes 2 (ganze Wörter; W/L nur als ganze Nachricht). */
export function chatWeight(text: string): number {
  return /\b(KEKW|LULW?|OMEGALUL|Pog\w*|POGGERS|clip)\b|^[WL]$|\?{3,}/i.test(text.trim()) ? 2 : 1
}

/** YouTube-Chat (<id>.live_chat.json, JSON Lines) → [{ t: Sekunde im Video, w }]; Super Chats 3. Kaputte Zeilen und solche ohne Nachricht fallen weg. */
export function chatTimes(jsonl: string): { t: number; w: number }[] {
  const out: { t: number; w: number }[] = []
  for (const line of jsonl.split('\n')) {
    let j
    try { j = JSON.parse(line) } catch { continue }
    // Replay: Offset in replayChatItemAction; Live-Mitschnitt: auf oberster Ebene
    const t = Number(j?.replayChatItemAction?.videoOffsetTimeMsec ?? j?.videoOffsetTimeMsec) / 1000
    if (!(t >= 0)) continue
    for (const a of j.replayChatItemAction?.actions ?? []) {
      const item = a?.addChatItemAction?.item
      const paid = item?.liveChatPaidMessageRenderer
      const r = paid ?? item?.liveChatTextMessageRenderer
      const text = ((r?.message?.runs ?? []) as { text?: string; emoji?: { shortcuts?: string[] } }[]).map((x) => x.text ?? x.emoji?.shortcuts?.[0] ?? '').join('')
      if (paid) out.push({ t, w: 3 }) // Super Chat zählt auch ohne Text
      else if (text.trim()) out.push({ t, w: chatWeight(text) })
    }
  }
  return out
}

/** YouTube-Heatmap → Wert je Sekunde (Mitte der Sekunde liegt im Abschnitt). */
export function heatPerSecond(heatmap: { start_time: number; end_time: number; value: number }[], duration: number): number[] {
  const out = new Array<number>(Math.ceil(duration)).fill(0)
  for (const h of heatmap) for (let s = Math.max(0, Math.ceil(h.start_time - 0.5)); s < out.length && s + 0.5 < h.end_time; s++) out[s] = h.value
  return out
}

// Vertrauensgrenze: der Link kommt von der KI oder dem Nutzer und landet als Argument bei yt-dlp.
// Lokale Ziele wie music.ts get(): Loopback, private Netze, Link-local, *.local und alle IPv6-Literale (deckt [::1], fc00::/7,
// fe80::/10 und [::ffff:127.0.0.1] ab; Video-Links nennen keine IPv6-Adressen).
// ponytail: prüft nur den Link selbst; ein Name, der aufs eigene Netz auflöst (DNS-Rebinding), oder eine Weiterleitung dorthin
// kommt durch – dafür müsste yt-dlp über einen prüfenden Proxy laufen.
const LOCAL_HOST = /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)|(^|\.)(localhost|local)\.?$/i
export function checkUrl(url: string): URL {
  if (url.length > 2000 || /[\x00-\x1f\x7f]/.test(url)) throw new Error('Ungültiger Link (zu lang oder mit Steuerzeichen).')
  let u: URL
  try { u = new URL(url) } catch { throw new Error(`Kein gültiger Link: ${url.slice(0, 100)}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Nur Links mit http:// oder https:// lassen sich laden.')
  if (LOCAL_HOST.test(u.hostname)) throw new Error('Links auf Adressen im eigenen Netz sind gesperrt.')
  return u
}

/** Zwischenrest des Imports <id>: nur bekannte Muster, damit Dateien anderer ids mit Punkt (clip → clip.v2.mp4) bleiben. */
export const leftover = (id: string, f: string) =>
  f.startsWith(`${id}.`) && /^(info\.json|live_chat\.json|twitch-chat\.json|temp\.\w+|f[\w-]+\.\w+|(f[\w-]+\.|live_chat\.)?\w+\.(part(-Frag\d+)?|ytdl))$/.test(f.slice(id.length + 1))

type ImportOpts = { models: string; ffmpeg: string; onProgress?: (pct: number) => void }
// ponytail: Sperre je Prozess (App und MCP-Server laden je einen); ein zweiter Import wartet, das Tool meldet so lange „läuft noch“
let queue: Promise<unknown> = Promise.resolve()

/** Video per Link nach dir laden (Dateiname <id>.<ext>), dazu Titel, Dauer, Kapitel, Heatmap und Chat (YouTube-Replay oder Twitch-VOD). Nur ein Import gleichzeitig. */
export async function importUrl(url: string, dir: string, o: ImportOpts): Promise<Imported> {
  const u = checkUrl(url)
  const r = queue.then(() => load(u, dir, o))
  queue = r.catch(() => {})
  return r
}

async function load(u: URL, dir: string, o: ImportOpts): Promise<Imported> {
  await mkdir(dir, { recursive: true })
  const fs = await statfs(dir)
  const free = fs.bavail * fs.bsize
  if (free < 3e9) throw new Error(`Zu wenig freier Speicherplatz für den Download: ${Math.floor(free / 1e8) / 10} GB frei, nötig sind mindestens 3 GB.`)
  const yt = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/i.test(u.hostname)
  const bin = await ytdlpBin(o.models)
  const env = slimEnv({ ELECTRON_RUN_AS_NODE: '1' }) // execPath ist in Electron die App; als JS-Runtime für YouTube läuft sie damit als Node
  const common = [
    '--ignore-config', '--no-playlist', '--playlist-items', '1', // reine Playlist-/Kanal-Links: nur das erste Video, nicht alle
    '--js-runtimes', `node:${process.execPath}`, '-P', dir, '-o', '%(id)s.%(ext)s',
  ]
  let id = '', file = '', last = -1
  try {
    const r = await runTool(bin, [
      // Grenzen: höchstens 20 GB und 12 h (unbekannte Dauer geht durch, „<?“)
      ...common, '--match-filters', '!is_live & duration <? 43200', '--max-filesize', '20G', '-S', 'res:1080,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4', '--write-info-json',
      // ein nacktes „ffmpeg“ (aus dem PATH) hielte yt-dlp für einen fehlenden Pfad; ohne Angabe sucht es selbst im PATH
      ...(isAbsolute(o.ffmpeg) ? ['--ffmpeg-location', o.ffmpeg] : []),
      // --print macht yt-dlp still, --progress holt den Fortschritt zurück (auf stdout); DWID kommt vor allen Dateien (fürs Aufräumen)
      '--progress', '--newline', '--progress-template', 'download:DW %(progress._percent_str)s',
      '--print', 'pre_process:DWID %(id)s', '--print', 'after_move:filepath', '--', u.href,
    ], env, (l) => {
      if (l.startsWith('DWID ')) id = l.slice(5).trim()
      else if (l.startsWith('DW ')) {
        const p = Math.floor(parseFloat(l.slice(3)))
        if (p > last) o.onProgress?.((last = p)) // Bild und Ton laden getrennt je 0→100: nur steigend melden
      } else if (l.trim()) file = l.trim()
    })
    if (r.stalled) throw new Error('yt-dlp hängt: seit 5 Minuten kein Fortschritt, Download abgebrochen.')
    if (r.code !== 0) throw new Error(`Download fehlgeschlagen (yt-dlp, Code ${r.code}):\n${errorLines(r.err)}${yt ? '\nYouTube-Fehler kommen oft von einem veralteten yt-dlp: yt-dlp aktualisieren.' : ''}`)
    // Filter und Größengrenze greifen still (Code 0, keine Datei)
    if (!file) throw new Error('Kein Video geladen: Der Live-Stream läuft noch, das Video ist länger als 12 Stunden oder größer als 20 GB, oder unter dem Link liegt kein Video. Streams nach dem Ende als Aufzeichnung laden.')
    file = resolve(file)
    if (!file.startsWith(resolve(dir) + sep) || !existsSync(file)) throw new Error(`yt-dlp meldet eine unerwartete Datei: ${file}`)
    id = basename(file).replace(/\.[^.]+$/, '')

    const info = JSON.parse(await readFile(join(dir, `${id}.info.json`), 'utf8'))
    const duration: number = info.duration ?? (await probe(file)).duration
    const chatFile = join(dir, `${id}.chat.json`)
    let chat: string | null = null
    try { // Chat ist Zugabe: Fehler kosten nur den Chat, nicht das Video
      const vod = twitchVodId(u.href)
      if (yt) {
        // eigener Aufruf, damit ein kaputtes Chat-Fragment nicht den Video-Download kippt
        const c = await runTool(bin, [...common, '--skip-download', '--write-subs', '--sub-langs', 'live_chat', '--newline', '--', u.href], env)
        if (c.stalled || c.code !== 0) throw new Error(c.stalled ? 'yt-dlp hängt beim Chat' : errorLines(c.err))
        const liveChat = join(dir, `${id}.live_chat.json`) // nur bei ehemaligen Livestreams
        if (existsSync(liveChat)) {
          // zeilenweise: der Chat eines 8-h-Streams kann größer sein als ein JS-String
          const times: { t: number; w: number }[] = []
          for await (const l of createInterface({ input: createReadStream(liveChat) })) for (const x of chatTimes(l)) times.push(x)
          await writeFile(chatFile, JSON.stringify(times))
          chat = chatFile
        }
      } else if (vod) {
        await writeFile(chatFile, JSON.stringify(await twitchChat(vod, join(dir, `${id}.twitch-chat.json`), { models: o.models })))
        chat = chatFile
      }
    } catch (e) { console.warn('[import] Chat fehlt:', (e as Error).message) }
    return {
      file, duration, chat,
      title: info.title ?? id,
      heat: info.heatmap?.length ? heatPerSecond(info.heatmap, duration) : null,
      chapters: ((info.chapters ?? []) as { start_time: number; title: string }[]).map((c) => ({ start: c.start_time, title: c.title })),
    }
  } finally { // Fehler beim Aufräumen dürfen den eigentlichen nicht verdecken
    if (id) for (const f of await readdir(dir).catch(() => [] as string[])) if (leftover(id, f)) await rm(join(dir, f), { force: true }).catch(() => {})
  }
}
