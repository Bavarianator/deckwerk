// Freisteller im Main-Prozess: BiRefNet-lite (MIT) über onnxruntime-node (nativ, mehrere Kerne). Das Modell lädt beim
// ersten Einsatz von Hugging Face nach ~/Deckwerk/models und bleibt dort. Bildverarbeitung mit nativeImage, ohne sharp.
import { nativeImage } from 'electron'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { freemem } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { InferenceSession } from 'onnxruntime-node'

const MODEL_URL = 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx'
const S = 1024 // Eingabegröße des Modells (preprocessor_config.json)
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225]

let session: Promise<InferenceSession> | null = null

async function download(file: string, onProgress: (pct: number) => void) {
  const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(15 * 60_000) })
  if (!res.ok || !res.body) throw new Error(`Modell-Download fehlgeschlagen (${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  let got = 0, last = -1
  const counted = Readable.fromWeb(res.body as never).on('data', (c: Buffer) => {
    got += c.length
    const pct = total ? Math.floor((got / total) * 100) : 0
    if (pct !== last) onProgress((last = pct))
  })
  const part = `${file}.part` // erst nach vollständigem Download umbenennen, sonst bliebe ein kaputtes Modell liegen
  try { await pipeline(counted, createWriteStream(part)) } catch (e) { await rm(part, { force: true }); throw e }
  await rename(part, file)
}

function load(dir: string, onProgress: (pct: number) => void): Promise<InferenceSession> {
  return (session ??= (async () => {
    const file = join(dir, 'birefnet-lite.onnx')
    if (!existsSync(file)) { await mkdir(dir, { recursive: true }); await download(file, onProgress) }
    const ort = await import('onnxruntime-node')
    return ort.InferenceSession.create(file, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' })
  })().catch((e) => { session = null; throw e }))
}

/** Hintergrund entfernen → PNG mit Transparenz in Originalgröße. onProgress: Modell-Download in % (nur beim ersten Mal). */
export async function removeBackground(imagePath: string, modelDir: string, onProgress: (pct: number) => void): Promise<Buffer> {
  // ponytail: grobe Schwelle gegen den OOM-Killer (Modell + Aktivierungen brauchen gut 1,5 GB); genauer messen, falls sie zu streng ist
  if (freemem() < 1.5 * 1024 ** 3 && !session) throw new Error('Zu wenig freier Arbeitsspeicher für den Freisteller (mind. 1,5 GB). Andere Programme schließen und erneut versuchen.')
  const img = nativeImage.createFromPath(imagePath)
  if (img.isEmpty()) throw new Error('Bild lässt sich nicht lesen')
  const { width, height } = img.getSize()
  const s = await load(modelDir, onProgress)
  const ort = await import('onnxruntime-node')

  // Eingabe: 1024×1024, RGB, normiert, NCHW (toBitmap liefert BGRA)
  const px = img.resize({ width: S, height: S, quality: 'best' }).toBitmap()
  const input = new Float32Array(3 * S * S)
  for (let i = 0; i < S * S; i++)
    for (let c = 0; c < 3; c++) input[c * S * S + i] = (px[i * 4 + (2 - c)] / 255 - MEAN[c]) / STD[c]
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) })
  const logits = out[s.outputNames[0]].data as Float32Array

  // Maske (wie transformers.js: Sigmoid nur, wenn die Werte nicht schon in 0..1 liegen) → Graustufenbild → Originalgröße
  const needSigmoid = logits.some((v) => v < -1e-5 || v > 1 + 1e-5)
  const mask = Buffer.alloc(S * S * 4)
  for (let i = 0; i < S * S; i++) {
    const v = Math.round(255 * (needSigmoid ? 1 / (1 + Math.exp(-logits[i])) : logits[i]))
    mask[i * 4] = mask[i * 4 + 1] = mask[i * 4 + 2] = v
    mask[i * 4 + 3] = 255
  }
  const alpha = nativeImage.createFromBitmap(mask, { width: S, height: S }).resize({ width, height, quality: 'best' }).toBitmap()
  const full = Buffer.from(img.toBitmap())
  for (let i = 0; i < width * height; i++) { // Chromium-Bitmaps sind vormultipliert: Farbe × Alpha
    const a = alpha[i * 4]
    full[i * 4] = (full[i * 4] * a) / 255; full[i * 4 + 1] = (full[i * 4 + 1] * a) / 255; full[i * 4 + 2] = (full[i * 4 + 2] * a) / 255
    full[i * 4 + 3] = a
  }
  return nativeImage.createFromBitmap(full, { width, height }).toPNG()
}
