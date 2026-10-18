// Bildmessung für die Timeline-Vorschau (rein, ohne DOM): Waveform (Luma je Spalte) und Histogramm. data = RGBA wie aus getImageData
const luma = (d: Uint8ClampedArray, i: number) => Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) // Rec.709

/** cols×256 Zähler: out[col*256 + luma] = Anzahl Pixel dieser Bildspalte mit dieser Helligkeit */
export function waveform(data: Uint8ClampedArray, w: number, h: number, cols = 256): Uint16Array {
  const out = new Uint16Array(cols * 256)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = Math.floor((x * cols) / w) * 256 + luma(data, (y * w + x) * 4)
      if (out[k] < 0xffff) out[k]++
    }
  return out
}

export function histogram(data: Uint8ClampedArray): { r: Uint32Array; g: Uint32Array; b: Uint32Array; y: Uint32Array } {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), y = new Uint32Array(256)
  for (let i = 0; i + 3 < data.length; i += 4) { r[data[i]]++; g[data[i + 1]]++; b[data[i + 2]]++; y[luma(data, i)]++ }
  return { r, g, b, y }
}
