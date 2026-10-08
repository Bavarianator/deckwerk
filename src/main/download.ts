// Download großer Dateien (Modelle, ffmpeg) mit Prüfsumme: erst nach vollständigem, geprüftem Download unter dem Zielnamen.
// Ohne Electron, damit Selbsttests es unter Node nutzen können.
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export async function download(url: string, sha256: string, file: string, onProgress: (pct: number) => void = () => {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0, last = -1
  const hash = createHash('sha256')
  const counted = Readable.fromWeb(res.body as never).on('data', (c: Buffer) => {
    hash.update(c)
    got += c.length
    const pct = total ? Math.floor((got / total) * 100) : 0
    if (pct !== last) onProgress((last = pct))
  })
  const part = `${file}.part` // erst nach vollständigem Download umbenennen, sonst bliebe ein kaputtes Modell liegen
  try {
    await pipeline(counted, createWriteStream(part))
    if (hash.digest('hex') !== sha256) throw new Error('Download beschädigt (Prüfsumme stimmt nicht). Bitte noch einmal versuchen.')
  } catch (e) { await rm(part, { force: true }); throw e }
  await rename(part, file)
}
