// Download großer Dateien (Modelle, ffmpeg) mit Prüfsumme: erst nach vollständigem, geprüftem Download unter dem Zielnamen.
// Ohne Electron, damit Selbsttests es unter Node nutzen können.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// Im Electron-Hauptprozess über Chromiums Netz (net.fetch): Nodes fetch stürzte dort bei Downloads sporadisch mit SIGTRAP ab
// (Electron 44, etwa jeder sechste 6-MB-Download). Unter Node (Selbsttests, Worker) bleibt es beim globalen fetch.
export const httpFetch = async (url: string | URL, init?: RequestInit): Promise<Response> =>
  process.type === 'browser' ? (await import('electron')).net.fetch(String(url), init as never) : fetch(url, init)

export async function download(url: string, sha256: string, file: string, onProgress: (pct: number) => void = () => {}) {
  // Abbruch erst, wenn 60 s keine Daten kommen: ein fester Gesamt-Timeout brach große Modelle (650 MB) bei langsamer Leitung ab
  const ac = new AbortController()
  let stall: ReturnType<typeof setTimeout> | undefined
  const arm = () => { clearTimeout(stall); stall = setTimeout(() => ac.abort(new Error('Download hängt (60 s ohne Daten). Bitte noch einmal versuchen.')), 60_000) }
  arm()
  try {
    await save(await httpFetch(url, { signal: ac.signal }), sha256, file, onProgress, arm)
  } finally {
    clearTimeout(stall)
  }
}

async function save(res: Response, sha256: string, file: string, onProgress: (pct: number) => void, arm: () => void) {
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0, last = -1
  const hash = createHash('sha256')
  const counted = Readable.fromWeb(res.body as never).on('data', (c: Buffer) => {
    arm()
    hash.update(c)
    got += c.length
    const pct = total ? Math.min(100, Math.floor((got / total) * 100)) : 0 // content-length zählt gzip-Bytes, fetch liefert entpackt
    if (pct !== last) onProgress((last = pct))
  })
  const part = `${file}.${process.pid}.part` // erst nach vollständigem Download umbenennen, sonst bliebe ein kaputtes Modell liegen; je Prozess, weil App und MCP-Server gleichzeitig laden können
  try {
    await pipeline(counted, createWriteStream(part))
    if (hash.digest('hex') !== sha256) throw new Error('Download beschädigt (Prüfsumme stimmt nicht). Bitte noch einmal versuchen.')
  } catch (e) { await rm(part, { force: true }); throw e }
  await rename(part, file)
}
