// Freisteller im Main-Prozess: BiRefNet-lite (MIT) über onnxruntime-node (nativ, mehrere Kerne). Das Modell lädt beim
// ersten Einsatz von Hugging Face nach ~/Deckwerk/models und bleibt dort. Bildverarbeitung mit nativeImage, ohne sharp.
import { nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { freemem } from 'node:os'
import { join } from 'node:path'
import type { InferenceSession } from 'onnxruntime-node'
import { download } from './download'

// fester Commit + Prüfsumme: ein nachträglich verändertes Modell landet nie im nativen ONNX-Parser
const MODEL_URL = 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model.onnx'
const MODEL_SHA256 = '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333'
const S = 1024 // Eingabegröße des Modells (preprocessor_config.json)
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225]

let session: Promise<InferenceSession> | null = null

function load(dir: string, onProgress: (pct: number) => void): Promise<InferenceSession> {
  return (session ??= (async () => {
    const file = join(dir, 'birefnet-lite.onnx')
    if (!existsSync(file)) { await mkdir(dir, { recursive: true }); await download(MODEL_URL, MODEL_SHA256, file, onProgress) }
    const ort = await import('onnxruntime-node')
    // Speicher sparen statt Tempo: ohne Arena/Memory-Pattern werden Zwischenpuffer sofort freigegeben (Spitze deutlich kleiner)
    const create = (executionProviders: string[]) => ort.InferenceSession.create(file, { executionProviders, graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false, executionMode: 'sequential' })
    return process.platform === 'darwin' ? create(['coreml', 'cpu']).catch(() => create(['cpu'])) : create(['cpu'])
  })().catch((e) => { session = null; throw e }))
}

/** Hintergrund entfernen → PNG mit Transparenz in Originalgröße. onProgress: Modell-Download in % (nur beim ersten Mal). */
export async function removeBackground(imagePath: string, modelDir: string, onProgress: (pct: number) => void): Promise<Buffer> {
  // Schutz vor dem OOM-Killer: gemessene Spitze ~2 GB (Eingabe fest 1024×1024, auch mit sparsamen Session-Optionen).
  // Unter Linux beendet der Kernel sonst womöglich die ganze Terminal-/App-Gruppe. macOS zählt den Datei-Cache als belegt
  // (freemem fast immer < 1 GB) und lagert aus, statt Prozesse zu beenden; dort also nicht sperren.
  if (process.platform === 'linux' && freemem() < 2.5 * 1024 ** 3) throw new Error(`Zu wenig freier Arbeitsspeicher für den Freisteller (${(freemem() / 1024 ** 3).toFixed(1)} GB frei, nötig ca. 2,5 GB). Andere Programme schließen und erneut versuchen.`)
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
