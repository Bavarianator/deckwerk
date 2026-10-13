// Spracherkennung auf einem Android-Handy (Option in Einstellungen → Allgemein): Deckwerk bringt per adb (USB- oder
// WLAN-Debugging) sherpa-onnx samt Parakeet aufs Handy; die Sprachstücke eines Chunks schneidet Silero-VAD weiter auf dem
// PC (sherpa-worker.ts), erkannt werden sie dort in einem Programmlauf. Gemessen 12.10.: Galaxy S20+ RTF 0,18, AMD A4-9125
// ~0,8. Scheitert das Handy, rechnet der PC (sherpa.ts). Ohne Electron, damit Worker und Selbsttest es nutzen können.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { download, httpFetch } from './download'

const exec = promisify(execFile)
const adb = (serial: string, ...args: string[]) => exec('adb', ['-s', serial, ...args], { maxBuffer: 1 << 28, timeout: 30 * 60_000 })
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
const BUNDLE = ['sherpa-onnx-offline', ...LIBS, 'libc++_shared.so']
const PARAKEET = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']

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
    await exec('tar', ['-xf', join(tmp, 'sherpa.tar.bz2'), '-C', tmp, `${TOP}/bin/sherpa-onnx-offline`, ...LIBS.map((l) => `${TOP}/lib/${l}`)])
    const entry = (await (await httpFetch(`${TERMUX}dists/stable/main/binary-aarch64/Packages`)).text()).split('\n\n').find((e) => /^Package: libc\+\+$/m.test(e))
    const deb = entry && /^Filename: (\S+)$/m.exec(entry)?.[1], sha = entry && /^SHA256: (\w+)$/m.exec(entry)?.[1]
    if (!deb || !sha) throw new Error('libc++ nicht im Termux-Paketindex gefunden')
    await download(TERMUX + deb, sha, join(tmp, 'libcxx.deb'))
    await writeFile(join(tmp, 'data.tar.xz'), arMember(readFileSync(join(tmp, 'libcxx.deb')), 'data.tar'))
    const so = './data/data/com.termux/files/usr/lib/libc++_shared.so'
    await exec('tar', ['-xf', join(tmp, 'data.tar.xz'), '-C', tmp, so])
    for (const [from, to] of [[`${TOP}/bin/sherpa-onnx-offline`, 'sherpa-onnx-offline'], ...LIBS.map((l) => [`${TOP}/lib/${l}`, l]), [so, 'libc++_shared.so']])
      await rename(join(tmp, from), join(dir, to))
    return dir
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Programm, Bibliotheken und Parakeet aufs Handy, was dort fehlt oder eine andere Größe hat (abgebrochene Übertragung).
 *  Beim ersten Mal ~700 MB: per USB etwa 30 s. */
export async function ensurePhone(serial: string, models: string): Promise<void> {
  const dir = await bundle(models)
  const want = [...BUNDLE.map((f) => join(dir, f)), ...PARAKEET.map((f) => join(models, 'parakeet-v3', f))]
  const { stdout } = await adb(serial, 'shell', `mkdir -p ${PHONE_DIR} && cd ${PHONE_DIR} && stat -c '%n %s' * 2>/dev/null; true`)
  const have = new Map(stdout.split('\n').map((l) => l.trim().split(' ') as [string, string]))
  for (const f of want) {
    const name = f.split('/').pop()!
    if (Number(have.get(name)) !== statSync(f).size) await adb(serial, 'push', f, `${PHONE_DIR}/${name}`)
  }
  await adb(serial, 'shell', `chmod 755 ${PHONE_DIR}/sherpa-onnx-offline`)
}

/** 16-bit-WAV, 16 kHz mono (das Programm liest nur WAV) */
export function wav(s: Float32Array): Buffer {
  const d = Buffer.alloc(44 + s.length * 2)
  d.write('RIFF', 0); d.writeUInt32LE(36 + s.length * 2, 4); d.write('WAVEfmt ', 8); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20); d.writeUInt16LE(1, 22)
  d.writeUInt32LE(16000, 24); d.writeUInt32LE(32000, 28); d.writeUInt16LE(2, 32); d.writeUInt16LE(16, 34); d.write('data', 36); d.writeUInt32LE(s.length * 2, 40)
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
export async function phoneDecode(serial: string, parts: Float32Array[], onProgress?: (pct: number) => void): Promise<PhoneResult[]> {
  if (!parts.length) return []
  const local = await mkdtemp(join(tmpdir(), 'deckwerk-phone-')), remote = `${PHONE_DIR}/job-${process.pid}`
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
    const { stdout } = await adb(serial, 'shell', `cd ${PHONE_DIR} && LD_LIBRARY_PATH=. ./sherpa-onnx-offline --tokens=tokens.txt --encoder=encoder.int8.onnx --decoder=decoder.int8.onnx --joiner=joiner.int8.onnx --model-type=nemo_transducer --num-threads=4 ${names.map((n) => `${remote}/${n}`).join(' ')} 2>/dev/null`)
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
