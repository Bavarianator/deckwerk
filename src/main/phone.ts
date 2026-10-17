// Spracherkennung auf einem Android-Handy (Option in Einstellungen → Allgemein): Deckwerk bringt per adb (USB- oder
// WLAN-Debugging) sherpa-onnx samt Parakeet aufs Handy; die Sprachstücke eines Chunks schneidet Silero-VAD weiter auf dem
// PC (sherpa-worker.ts), erkannt werden sie dort in einem Programmlauf. Gemessen 12.10.: Galaxy S20+ RTF 0,18, AMD A4-9125
// ~0,8. Scheitert das Handy, rechnet der PC (sherpa.ts). Ohne Electron, damit Worker und Selbsttest es nutzen können.
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { VoiceId } from '../shared/deck'
import { download, httpFetch } from './download'

const exec = promisify(execFile)
const adbIn = (ms: number, serial: string, ...args: string[]) => exec('adb', ['-s', serial, ...args], { maxBuffer: 1 << 28, timeout: ms })
const adb = (serial: string, ...args: string[]) => adbIn(30 * 60_000, serial, ...args)
export const PHONE_DIR = '/data/local/tmp/deckwerk'
/** Marker unter appData/deckwerk (gemeinsam für App, Entwicklung und MCP-Server wie spellcheck-off): vorhanden = aus. Ohne Marker rechnet ein verbundenes Handy, der PC ist der Rückfall */
export const phoneMarker = (appData: string) => join(appData, 'deckwerk', 'phone-off')

// sherpa-onnx für Termux (läuft auch per adb shell), fester Release + Prüfsumme. Es braucht libc++_shared.so, die weder dieses
// noch das App-Paket von sherpa mitbringt: die kommt aus Termux (Pfad und Prüfsumme aus dessen Paketindex, der Pfad wechselt
// mit jeder Version).
// GPU/NPU: Der Termux-Build ist für API 24 übersetzt, NNAPI schaltet sherpa erst ab API 27 ein (12.10. gemessen: --provider=nnapi
// → „Fallback to cpu“, gleiche RTF). Dafür bräuchte es einen eigenen Android-Build mit API ≥ 27.
const TOP = 'sherpa-onnx-v1.13.8-android-aarch64-termux-shared'
const SHERPA = [`https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/${TOP}.tar.bz2`, 'ad7bac42adc6295293fe6d36475936afb227cdc757cf293c02a706f6aca4e0a2']
const LIBS = ['libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so', 'libonnxruntime.so']
const TERMUX = 'https://packages.termux.dev/apt/termux-main/'
const BINS = ['sherpa-onnx-offline', 'sherpa-onnx-offline-tts'] // Erkennung, Sprecherstimme (phoneTts)
const BUNDLE = [...BINS, ...LIBS, 'libc++_shared.so']
const ASR = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']
// Modellordner auf dem Handy, relativ zu PHONE_DIR (bis v0.2.4 lag Parakeet v3 direkt darin, ensurePhone räumt es weg)
const sub = (dir: string) => `${dir}/`

/** Verbundene Geräte aus `adb devices -l` (nur freigegebene, nicht „unauthorized“) */
export function parseDevices(out: string): { serial: string; model: string }[] {
  return out.split('\n').flatMap((l) => {
    const m = /^(\S+)\s+device\b(.*)$/.exec(l.trim())
    return m ? [{ serial: m[1], model: (/model:(\S+)/.exec(m[2])?.[1] ?? m[1]).replace(/_/g, ' ') }] : []
  })
}

/** Erstes freigegebenes Handy oder null (auch ohne adb) */
export async function phoneDevice(): Promise<{ serial: string; model: string } | null> {
  try { return parseDevices((await exec('adb', ['devices', '-l'], { timeout: 10_000 })).stdout)[0] ?? null } catch { return null }
}

/** Ein Eintrag (Namensanfang) aus einem ar-Archiv, z. B. data.tar.xz aus einer .deb */
export function arMember(buf: Buffer, prefix: string): Buffer {
  for (let o = 8; o + 60 <= buf.length;) {
    const name = buf.toString('latin1', o, o + 16).trim(), size = Number(buf.toString('latin1', o + 48, o + 58).trim())
    if (name.startsWith(prefix)) return buf.subarray(o + 60, o + 60 + size)
    o += 60 + size + (size % 2)
  }
  throw new Error(`${prefix} fehlt im Archiv`)
}

// Programm und Bibliotheken für das Handy einmal nach models/android (nicht /tmp: oft ein kleines RAM-Dateisystem)
async function bundle(models: string): Promise<string> {
  const dir = join(models, 'android')
  if (BUNDLE.every((f) => existsSync(join(dir, f)))) return dir
  await mkdir(dir, { recursive: true })
  const tmp = await mkdtemp(join(models, '.android-'))
  try {
    await download(SHERPA[0], SHERPA[1], join(tmp, 'sherpa.tar.bz2'))
    const from = [...BINS.map((b) => `${TOP}/bin/${b}`), ...LIBS.map((l) => `${TOP}/lib/${l}`)]
    await exec('tar', ['-xf', join(tmp, 'sherpa.tar.bz2'), '-C', tmp, ...from])
    // libc++ nur, wenn sie fehlt: Ein Bundle von vor sherpa-onnx-offline-tts behält seine (der Termux-Index hat inzwischen evtl. eine neuere)
    if (!existsSync(join(dir, 'libc++_shared.so'))) {
      const entry = (await (await httpFetch(`${TERMUX}dists/stable/main/binary-aarch64/Packages`)).text()).split('\n\n').find((e) => /^Package: libc\+\+$/m.test(e))
      const deb = entry && /^Filename: (\S+)$/m.exec(entry)?.[1], sha = entry && /^SHA256: (\w+)$/m.exec(entry)?.[1]
      if (!deb || !sha) throw new Error('libc++ nicht im Termux-Paketindex gefunden')
      await download(TERMUX + deb, sha, join(tmp, 'libcxx.deb'))
      await writeFile(join(tmp, 'data.tar.xz'), arMember(readFileSync(join(tmp, 'libcxx.deb')), 'data.tar'))
      const so = './data/data/com.termux/files/usr/lib/libc++_shared.so'
      await exec('tar', ['-xf', join(tmp, 'data.tar.xz'), '-C', tmp, so])
      from.push(so)
    }
    for (const f of from) await rename(join(tmp, f), join(dir, basename(f))) // ersetzt Vorhandenes durch Gleiches (fester Release)
    return dir
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Programm, Bibliotheken und das Erkennungsmodell (Ordner model unter models) aufs Handy, was dort fehlt oder eine andere
 *  Größe hat (abgebrochene Übertragung). Beim ersten Mal ~700 MB (Parakeet Ultra): per USB etwa 30 s. */
export async function ensurePhone(serial: string, models: string, model: string): Promise<void> {
  const dir = await bundle(models), p = sub(model)
  const want = [...BUNDLE.map((f) => [join(dir, f), f]), ...ASR.map((f) => [join(models, model, f), p + f])]
  const { stdout } = await adb(serial, 'shell', `mkdir -p ${PHONE_DIR}/${p} && cd ${PHONE_DIR} && rm -f ${ASR.join(' ')} && stat -c '%n %s' * ${p}* 2>/dev/null; true`) // rm: altes Parakeet v3
  const have = new Map(stdout.split('\n').map((l) => l.trim().split(' ') as [string, string]))
  for (const [f, name] of want) if (Number(have.get(name)) !== statSync(f).size) await adb(serial, 'push', f, `${PHONE_DIR}/${name}`)
  await adb(serial, 'shell', `chmod 755 ${PHONE_DIR}/sherpa-onnx-offline`)
}

/** 16-bit-WAV, 16 kHz mono (das Programm liest nur WAV) */
export function wav(s: Float32Array, sr = 16000): Buffer {
  const d = Buffer.alloc(44 + s.length * 2)
  d.write('RIFF', 0); d.writeUInt32LE(36 + s.length * 2, 4); d.write('WAVEfmt ', 8); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20); d.writeUInt16LE(1, 22)
  d.writeUInt32LE(sr, 24); d.writeUInt32LE(sr * 2, 28); d.writeUInt16LE(2, 32); d.writeUInt16LE(16, 34); d.write('data', 36); d.writeUInt32LE(s.length * 2, 40)
  for (let i = 0; i < s.length; i++) d.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s[i] * 32767))), 44 + i * 2)
  return d
}

export type PhoneResult = { text: string; tokens: string[]; timestamps: number[]; durations?: number[] }
/** Ergebnisse aus der Standardausgabe: eine JSON-Zeile je Datei in Aufrufreihenfolge; nan/inf in den Zahlenlisten → null */
export const parseResults = (stdout: string): PhoneResult[] =>
  stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l.replace(/(?<=[[,]\s*)-?(?:nan|inf)(?=\s*[,\]])/gi, 'null')))

// Sekunden Laufzeit (Übertragen, Laden, Erkennen) je Sekunde Audio, nach jedem Lauf gemessen; Start: S20+ ~0,1–0,2
let phoneRtf = 0.2
/** Sprachstücke (16 kHz mono f32) auf dem Handy erkennen, ein Programmlauf (Modell einmal laden) für alle */
export async function phoneDecode(serial: string, model: string, parts: Float32Array[], onProgress?: (pct: number) => void): Promise<PhoneResult[]> {
  if (!parts.length) return []
  const local = await mkdtemp(join(tmpdir(), 'deckwerk-phone-')), remote = `${PHONE_DIR}/job-${process.pid}`, p = sub(model)
  // ponytail: Fortschritt geschätzt (Laufzeit / erwartete Dauer, höchstens 95 %), weil sherpa alle Ergebnisse erst am Ende ausgibt;
  // echte Schritte gingen nur mit mehreren Läufen, die jedes Mal das Modell neu laden
  const secs = parts.reduce((s, p) => s + p.length, 0) / 16000, t0 = Date.now()
  // bei 95 % still: dann greift die Stillstands-Wache in sherpa.ts wieder, falls adb hängt
  const tick = onProgress && setInterval(() => {
    const pct = Math.min(95, Math.floor(((Date.now() - t0) / 1000 / (secs * phoneRtf)) * 100))
    onProgress(pct)
    if (pct >= 95) clearInterval(tick)
  }, 1000)
  try {
    await Promise.all(parts.map((p, i) => writeFile(join(local, `${String(i).padStart(4, '0')}.wav`), wav(p))))
    const names = (await readdir(local)).sort()
    await adb(serial, 'shell', `rm -rf ${remote} && mkdir -p ${remote}`)
    await adb(serial, 'push', ...names.map((n) => join(local, n)), remote)
    const { stdout } = await adb(serial, 'shell', `cd ${PHONE_DIR} && LD_LIBRARY_PATH=. ./sherpa-onnx-offline --tokens=${p}tokens.txt --encoder=${p}encoder.int8.onnx --decoder=${p}decoder.int8.onnx --joiner=${p}joiner.int8.onnx --model-type=nemo_transducer --num-threads=4 ${names.map((n) => `${remote}/${n}`).join(' ')} 2>/dev/null`)
    const out = parseResults(stdout)
    if (out.length !== parts.length) throw new Error(`Handy lieferte ${out.length} von ${parts.length} Ergebnissen`)
    if (secs >= 30) phoneRtf = Math.min(1, (Date.now() - t0) / 1000 / secs) // kurze Läufe: Fixkosten (Laden) verzerren
    return out
  } finally {
    clearInterval(tick)
    await rm(local, { recursive: true, force: true })
    await adb(serial, 'shell', `rm -rf ${remote}`).catch(() => {})
  }
}

// Ein Argument für die Shell des Handys (auch phone-ffmpeg.ts)
export const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
// Gemessen 17.10. auf dem S20+: jeder Lauf lädt die Stimme neu (~1,2 s), daher 4 Läufe zugleich mit je 2 Threads (8 Sätze: 5 s statt 11 s nacheinander)
const TTS_JOBS = 4
const QUICK = 30_000 // Frist für kleine adb-Schritte: schläft das Handy oder hängt USB, rechnet bald der PC

let speaking: Promise<unknown> = Promise.resolve()
/** Sprecherstimme auf dem Handy statt im sherpa-Worker: je Satz mono f32 wie tts() in sherpa.ts, ein Programmlauf je Satz.
 *  Die Stimme muss unter <models>/tts-<voice> liegen (ensureVoice); sie kommt beim ersten Mal nach PHONE_DIR/tts-<voice> (~80 MB).
 *  Ein Aufruf zur Zeit je Prozess (Player-Vorschau und Export): parallel teilten sie sich nur die Kerne des Handys. */
export function phoneTts(serial: string, models: string, voice: VoiceId, sentences: string[], speed: number): Promise<{ samples: Float32Array[]; sampleRate: number }> {
  const run = speaking.then(() => speak(serial, models, voice, sentences, speed))
  speaking = run.catch(() => {})
  return run
}

async function speak(serial: string, models: string, voice: VoiceId, sentences: string[], speed: number): Promise<{ samples: Float32Array[]; sampleRate: number }> {
  const v = `tts-${voice}`, onnx = readdirSync(join(models, v)).find((f) => f.endsWith('.onnx'))
  if (!onnx) throw new Error(`Stimme ${voice} fehlt unter ${models}`)
  const local = await mkdtemp(join(tmpdir(), 'deckwerk-tts-')), id = `tts-job-${basename(local).slice(-6)}`, job = `${PHONE_DIR}/${id}` // eigener Ordner je Aufruf: App und MCP-Server können gleichzeitig sprechen
  try {
    // zuerst: ohne Handy scheitert es hier, bevor das Bundle geladen wird. Reste abgebrochener Läufe (Handy abgesteckt) nach 12 h weg wie in phone-ffmpeg.ts
    await adbIn(QUICK, serial, 'shell', `find ${PHONE_DIR} -mindepth 1 -maxdepth 1 -name 'tts-job-*' -mmin +720 -exec rm -rf {} + 2>/dev/null; mkdir -p ${job}`)
    const dir = await bundle(models), up = [...BUNDLE.map((f) => join(dir, f)), join(models, v)]
    const bytes = [...up, ...readdirSync(join(models, v), { recursive: true }).map((f) => join(models, v, String(f)))].reduce((n, f) => n + statSync(f).size, 0)
    // --sync überträgt nur, was auf dem Handy fehlt oder abweicht (Größe, Zeitstempel): eine abgebrochene Übertragung wird wiederholt. Frist: mindestens 1 MB/s (WLAN-Debugging)
    await adbIn(QUICK + Math.round(bytes / 1000), serial, 'push', '--sync', ...up, PHONE_DIR)
    // -- vor dem Text: sonst hielte das Programm einen Satz wie „--x“ für eine Option (17.10. geprüft, „-“ allein ginge auch ohne)
    const run = (s: string, k: number) => `LD_LIBRARY_PATH=. ./sherpa-onnx-offline-tts --vits-model=${v}/${onnx} --vits-tokens=${v}/tokens.txt --vits-data-dir=${v}/espeak-ng-data --num-threads=2 --speed=${speed} --output-filename=${job}/${k}.wav -- ${quote(s)} >/dev/null 2>&1 &${(k + 1) % TTS_JOBS ? '' : '\nwait'}`
    await writeFile(join(local, 'tts.sh'), `cd ${PHONE_DIR} && chmod 755 sherpa-onnx-offline-tts || exit 1\n${sentences.map(run).join('\n')}\nwait\n`)
    await adbIn(QUICK, serial, 'push', join(local, 'tts.sh'), `${job}/tts.sh`)
    // Zeitgrenze statt Stillstands-Wache: die Läufe melden nichts; ein Satz braucht auf dem S20+ ~1,5 s
    await adbIn(60_000 + sentences.length * 10_000, serial, 'shell', `sh ${job}/tts.sh`).catch((e) => {
      throw new Error(e.killed ? 'Stimme auf dem Handy: keine Antwort in der Zeitgrenze' : `Stimme auf dem Handy fehlgeschlagen: ${e.message}`)
    })
    const done = (await adbIn(QUICK, serial, 'shell', `ls ${job}`)).stdout.split(/\s+/).filter((f) => f.endsWith('.wav')).length
    if (done !== sentences.length) throw new Error(`Handy lieferte ${done} von ${sentences.length} Sätzen`)
    await adbIn(QUICK, serial, 'pull', ...sentences.map((_, k) => `${job}/${k}.wav`), local)
    const wavs = await Promise.all(sentences.map((_, k) => readFile(join(local, `${k}.wav`))))
    // sherpa schreibt 16 bit mono mit festem 44-Byte-Kopf
    if (wavs.some((b) => b.toString('latin1', 0, 4) !== 'RIFF' || b.readUInt16LE(34) !== 16 || b.toString('latin1', 36, 40) !== 'data')) throw new Error('Stimme vom Handy: unerwartetes WAV')
    return { samples: wavs.map((b) => Float32Array.from({ length: (b.length - 44) / 2 }, (_, i) => b.readInt16LE(44 + i * 2) / 32768)), sampleRate: wavs[0].readUInt32LE(24) }
  } finally {
    await rm(local, { recursive: true, force: true })
    // nach Frist oder Abbruch laufen Skript und sherpa weiter: alles mit dem Job-Ordner im Aufruf beenden ([/]: passt nicht auf diese Shell selbst)
    await adbIn(QUICK, serial, 'shell', `pkill -f '${id}[/]'; rm -rf ${job}`).catch(() => {})
  }
}
