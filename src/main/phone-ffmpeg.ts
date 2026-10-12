// ffmpeg auf einem Android-Handy (wie die Spracherkennung in phone.ts): Deckwerk bringt einen statischen arm64-Build per adb aufs
// Handy, überträgt Quellvideo, Untertitel und Schriften und holt die fertige Datei zurück. Gemessen 12.10.: Galaxy S20+ libx264 1080p
// veryfast 52 fps, AMD A4-9125 ~10 fps. Scheitert das Handy, rechnet der PC (Aufrufer). Ohne Electron, damit der Selbsttest es nutzen kann.
// libass rendert auf Android ohne fontconfig-Konfiguration: es meldet „Cannot load default config file“, nimmt die Schriften aus fontsdir aber trotzdem.
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { download, httpFetch } from './download'
import { run } from './ffmpeg'
import { PHONE_DIR } from './phone'

const exec = promisify(execFile)
const adb = (serial: string, ...args: string[]) => exec('adb', ['-s', serial, ...args], { maxBuffer: 1 << 28, timeout: 30 * 60_000 })

// mwader/static-ffmpeg 9.0.2-1 (linux/arm64, mit libass und libx264) direkt aus Docker Hub, ohne Docker: die eine Schicht per Digest
// (= SHA-256 des gzip-Tars), darin liegt ffmpeg im Wurzelverzeichnis
const REPO = 'mwader/static-ffmpeg'
const LAYER = 'b97d6d5fc8d13dca24a7b71a33f28a32836db81b22673edb4beb6020b10a0272'
const BIN_SHA = 'fd63f670fb1ad8a9ce069bbdf01ffcba5de9b3a33531c220df139b3c1a8f7b0a'
const FF = `${PHONE_DIR}/ffmpeg`
// Quellvideos (Streams bis 2,4 GB) bleiben auf dem Handy für die nächste Szene, aber nur die zuletzt genutzten
const SRC = `${PHONE_DIR}/src`, KEEP = 2

// Einmal nach models/android wie bundle() in phone.ts (nicht /tmp: oft ein kleines RAM-Dateisystem)
async function binary(models: string): Promise<string> {
  const file = join(models, 'android', 'ffmpeg')
  if (existsSync(file)) return file
  await mkdir(join(models, 'android'), { recursive: true })
  const tmp = await mkdtemp(join(models, '.android-'))
  try {
    const res = await httpFetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPO}:pull`, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`ffmpeg fürs Handy: Docker Hub antwortet mit ${res.status}.`)
    const { token } = (await res.json()) as { token: string }
    // Die Registry leitet auf ein CDN um, das den Token nicht stört; redirect: 'manual' scheitert in net.fetch („Redirect was cancelled“)
    await download(`https://registry-1.docker.io/v2/${REPO}/blobs/sha256:${LAYER}`, LAYER, join(tmp, 'layer.tar.gz'), undefined, { Authorization: `Bearer ${token}` })
    await exec('tar', ['-xzf', join(tmp, 'layer.tar.gz'), '-C', tmp, 'ffmpeg'])
    const h = createHash('sha256')
    for await (const c of createReadStream(join(tmp, 'ffmpeg'))) h.update(c)
    if (h.digest('hex') !== BIN_SHA) throw new Error('ffmpeg fürs Handy beschädigt (Prüfsumme stimmt nicht). Bitte noch einmal versuchen.')
    await rename(join(tmp, 'ffmpeg'), file)
    return file
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Ein Argument für die Shell des Handys: in einfache Anführungszeichen, ' als '\'' */
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

const inside = (dir: string, p: string) => { const r = relative(dir, p); return !!r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r) }

/** args fürs Handy: Quellen laut sources (lokal → Cache-Pfad) ersetzt, absolute Pfade unter cwd nach remoteCwd; relative (Filtergraph) bleiben */
export const phoneArgs = (args: string[], cwd: string, remoteCwd: string, sources: Map<string, string>) =>
  args.map((a) => sources.get(a) ?? (isAbsolute(a) && inside(cwd, a) ? `${remoteCwd}/${relative(cwd, a)}` : a))

/** Quellen im Cache, die weg können: alle außer den gebrauchten und den zuletzt genutzten, bis es zusammen keep sind */
export const stale = (cached: { path: string; t: number }[], used: string[], keep = KEEP) =>
  cached.filter((c) => !used.includes(c.path)).sort((a, b) => b.t - a.t).slice(Math.max(0, keep - used.length)).map((c) => c.path)

// Quelle aufs Handy streamen statt adb push: die Bytes zählen wir selbst (Fortschritt beim ersten Export, ein Stream hat 2,4 GB).
// Erst .part, dann umbenennen: ein Abbruch hinterlässt keine falsche Datei gleicher Größe. 120 s ohne Daten (USB hängt) → abbrechen.
async function upload(serial: string, from: string, to: string, onBytes: (n: number) => void): Promise<void> {
  const p = spawn('adb', ['-s', serial, 'exec-in', `cat > ${quote(`${to}.part`)}`], { stdio: ['pipe', 'ignore', 'pipe'] })
  let err = '', n = 0, stall = setTimeout(() => p.kill(), 120_000)
  p.stderr.on('data', (c: Buffer) => { err = (err + c).slice(-2000) })
  const closed = new Promise<number | null>((ok, fail) => { p.on('error', fail); p.on('close', ok) })
  const src = createReadStream(from).on('data', (c) => {
    n += c.length
    onBytes(n)
    clearTimeout(stall)
    stall = setTimeout(() => p.kill(), 120_000)
  })
  try {
    await pipeline(src, p.stdin)
    const code = await closed
    if (code !== 0) throw new Error(`Video aufs Handy übertragen fehlgeschlagen (Code ${code}): ${err.trim()}`)
    await adb(serial, 'shell', `mv ${quote(`${to}.part`)} ${quote(to)}`)
  } catch (e) {
    await adb(serial, 'shell', `rm -f ${quote(`${to}.part`)}`).catch(() => {})
    throw e
  } finally {
    clearTimeout(stall)
  }
}

/** ffmpeg auf dem Handy statt auf dem PC; args wie für runFfmpeg in src/main/ffmpeg.ts (ohne -hide_banner/-nostdin/-y/-nostats, die setzt die Funktion selbst wie ff()). */
export async function phoneFfmpeg(serial: string, args: string[], o: { cwd: string; models: string; duration?: number; onProgress?: (pct: number) => void }): Promise<void> {
  const cwd = resolve(o.cwd), remote = `${PHONE_DIR}/export/${basename(cwd)}`
  const inputs = args.filter((a, i) => args[i - 1] === '-i' && isAbsolute(a))
  const sources = new Map(inputs.filter((a) => !inside(cwd, a)).map((a) => {
    const s = statSync(a)
    return [a, `${SRC}/${createHash('sha1').update(`${a}|${s.size}|${s.mtimeMs}`).digest('hex')}${extname(a)}`]
  }))
  // in den entfernten cwd: Eingänge unter cwd, genannte Untertitel, Schriften (fontsdir=fonts); fertige Szenen (*.mkv) nicht
  const files = [...new Set([...inputs.filter((a) => inside(cwd, a)).map((a) => relative(cwd, a)), ...(args.join(' ').match(/[^\s=:,;'"[\]\\/]+\.ass\b/g) ?? []), 'fonts'])]
    .filter((f) => existsSync(join(cwd, f)))
  const remoteArgs = phoneArgs(args, cwd, remote, sources)

  const bin = await binary(o.models)
  const have = new Map((await adb(serial, 'shell', `stat -c '%Y %s %n' ${FF} ${SRC}/* 2>/dev/null; true`)).stdout.split('\n').flatMap((l) => {
    const m = /^(\d+) (\d+) (.+)$/.exec(l.trim())
    return m ? [[m[3], { t: +m[1], size: +m[2] }] as const] : []
  }))
  if (have.get(FF)?.size !== statSync(bin).size) await adb(serial, 'push', bin, FF)
  const old = stale([...have].filter(([p]) => p.startsWith(`${SRC}/`)).map(([path, { t }]) => ({ path, t })), [...sources.values()])
  // Befehl als Skript: adb shell nimmt höchstens ~64 KB (12.10. gemessen), Filtergraphen mit 20 Ausschnitten und Kamerafahrt können länger werden
  const local = await mkdtemp(join(tmpdir(), 'deckwerk-phone-'))
  try {
    // Reste abgebrochener Exporte (Handy abgesteckt: das Aufräumen unten schlug fehl) nach 12 h weg; ein laufender zweiter Export bleibt
    await adb(serial, 'shell', `find ${PHONE_DIR}/export -mindepth 1 -maxdepth 1 -mmin +720 -exec rm -rf {} + 2>/dev/null; rm -rf ${quote(remote)} && mkdir -p ${quote(remote)} ${SRC} && chmod 755 ${FF}${old.length ? ` && rm -f ${old.map(quote).join(' ')}` : ''}`)
    // Kopieren zählt bis 50 %, das Rechnen den Rest; liegt alles schon auf dem Handy, rechnet es von 0 bis 100 %
    const todo = [...sources].filter(([from, to]) => have.get(to)?.size !== statSync(from).size)
    const bytes = todo.reduce((s, [from]) => s + statSync(from).size, 0), share = bytes && o.duration && o.onProgress ? 50 : 0
    let sent = 0, copied = -1
    for (const [from, to] of todo) {
      const base = sent
      await upload(serial, from, to, (k) => {
        const pct = Math.floor(((base + k) / bytes) * share)
        if (share && pct > copied) o.onProgress!((copied = pct))
      })
      sent += statSync(from).size
    }
    const touch = sources.size ? `touch ${[...sources.values()].map(quote).join(' ')} && ` : '' // zuletzt genutzt (push übernimmt die alte Zeit)
    await writeFile(join(local, 'run.sh'), `${touch}cd ${quote(remote)} && ${FF} -hide_banner -nostdin -y -nostats -progress pipe:1 ${remoteArgs.map(quote).join(' ')}\n`)
    for (const f of files) await adb(serial, 'push', join(cwd, f), `${remote}/${f}`)
    await adb(serial, 'push', join(local, 'run.sh'), `${remote}/run.sh`)
    let last = -1 // nur steigend melden: mit loudnorm (Vorlauf) springt out_time zurück
    // Stillstands-Wache: -progress meldet sich etwa jede Sekunde; 120 s nichts (Handy schläft, USB hängt) → abbrechen, der PC rechnet weiter
    const ac = new AbortController()
    let stall = setTimeout(() => ac.abort(), 120_000)
    const r = await run('adb', ['-s', serial, 'shell', `sh ${quote(`${remote}/run.sh`)}`], { signal: ac.signal, onOut: (s) => {
      clearTimeout(stall)
      stall = setTimeout(() => ac.abort(), 120_000)
      if (!o.duration || !o.onProgress) return
      for (const m of s.matchAll(/out_time_us=(\d+)\n/g)) {
        const pct = share + Math.floor((Math.min(100, Number(m[1]) / 1e4 / o.duration) * (100 - share)) / 100)
        if (pct > last) o.onProgress((last = pct))
      }
    } }).finally(() => clearTimeout(stall))
    if (r.code !== 0) throw new Error(`ffmpeg auf dem Handy fehlgeschlagen (Code ${r.code}):\n${r.err.trim().split('\n').slice(-15).join('\n')}`)
    await adb(serial, 'pull', remoteArgs[remoteArgs.length - 1], args[args.length - 1])
  } finally {
    await rm(local, { recursive: true, force: true })
    await adb(serial, 'shell', `rm -rf ${quote(remote)}`).catch(() => {})
  }
}
