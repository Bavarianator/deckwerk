// Twitch-Chat eines VODs über TwitchDownloaderCLI (MIT): Binary einmalig von GitHub laden (Prüfsumme), Chat als JSON holen.
// Ohne Electron, damit Selbsttests es unter Node nutzen können.
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import JSZip from 'jszip'
import { download } from './download'
import { chatWeight, runTool, slimEnv } from './ytdlp'

const VERSION = '1.56.5'
const BUILDS: Record<string, { name: string; sha256: string }> = {
  'linux-x64': { name: 'Linux-x64', sha256: 'f2bcee00d0e6da759d97c23767345634cb9cdb10cdff96cfa96f97983d51bf55' },
  'darwin-arm64': { name: 'MacOSArm64', sha256: '17a0182f83689a0ae429f48cf03c26f1701eed7edcd787fa3d261898a6023d76' },
}
/** VOD-ID aus einem Link twitch.tv/videos/<id>, sonst null. */
export const twitchVodId = (url: string): string | null => /^(?:https?:\/\/)?(?:[\w-]+\.)?twitch\.tv\/videos\/(\d+)(?:[/?#]|$)/i.exec(url)?.[1] ?? null

async function locate(models: string): Promise<string> {
  const build = BUILDS[`${process.platform}-${process.arch}`]
  if (!build) throw new Error(`Twitch-Chat: TwitchDownloaderCLI gibt es nicht für ${process.platform}-${process.arch}.`)
  const dir = join(models, `twitch-downloader-${VERSION}`), file = join(dir, 'TwitchDownloaderCLI')
  if (existsSync(file)) return file // erscheint nur per rename, also vollständig
  await mkdir(dir, { recursive: true })
  const tmp = `${file}.${process.pid}` // je Prozess, rename ersetzt atomar (wie ffmpeg.ts)
  try {
    console.log('[twitch] lade TwitchDownloaderCLI', VERSION)
    await download(`https://github.com/lay295/TwitchDownloader/releases/download/${VERSION}/TwitchDownloaderCLI-${VERSION}-${build.name}.zip`, build.sha256, `${tmp}.zip`)
    const entry = (await JSZip.loadAsync(await readFile(`${tmp}.zip`))).file('TwitchDownloaderCLI')
    if (!entry) throw new Error('TwitchDownloaderCLI fehlt im geladenen Archiv.')
    await pipeline(entry.nodeStream(), createWriteStream(tmp))
    await chmod(tmp, 0o755)
    await rename(tmp, file)
  } finally {
    await Promise.all([rm(`${tmp}.zip`, { force: true }), rm(tmp, { force: true })])
  }
  return file
}

let bin: Promise<string> | undefined
/** Pfad zu TwitchDownloaderCLI, beim ersten Mal von GitHub geladen. Ergebnis gemerkt, Fehler nicht. */
export const twitchBin = (models: string) => (bin ??= locate(models).catch((e) => { bin = undefined; throw e }))

/** Chat eines VODs → [{ t: Sekunde im Video, w: Gewicht }]; out = Pfad der Roh-JSON von TwitchDownloaderCLI. Bits → 3. */
export async function twitchChat(vodId: string, out: string, o: { models: string; onProgress?: (pct: number) => void }): Promise<{ t: number; w: number }[]> {
  if (!/^\d+$/.test(vodId)) throw new Error(`Ungültige Twitch-VOD-ID: ${vodId}`)
  let last = -1
  // ohne libicu startet .NET sonst evtl. gar nicht
  const r = await runTool(await twitchBin(o.models), ['chatdownload', '-u', vodId, '-o', out, '--collision', 'Overwrite', '-t', '2'], slimEnv({ DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' }), (l) => {
    const p = Number(/(\d+)%/.exec(l)?.[1])
    if (p > last) o.onProgress?.((last = p))
  })
  if (r.stalled) throw new Error('TwitchDownloader hängt: seit 5 Minuten keine Ausgabe, abgebrochen.')
  if (r.code !== 0) {
    const why = r.err.split('\n').find((l) => /Exception:/.test(l)) ?? r.err.trim().split('\n').slice(-5).join('\n')
    throw new Error(`Twitch-Chat ließ sich nicht laden: ${why.trim()}`)
  }
  // ponytail: ganze Datei in den Speicher; bei sehr großen Chats (> ~500 MB JSON) zu groß, dann zeilenweise/streamend parsen
  const { comments = [] } = JSON.parse(await readFile(out, 'utf8')) as { comments?: { content_offset_seconds: number; message?: { body?: string; bits_spent?: number } }[] }
  return comments.filter((c) => Number.isFinite(c.content_offset_seconds) && c.content_offset_seconds >= 0)
    .map((c) => ({ t: c.content_offset_seconds, w: (c.message?.bits_spent ?? 0) > 0 ? 3 : chatWeight(c.message?.body ?? '') }))
}
