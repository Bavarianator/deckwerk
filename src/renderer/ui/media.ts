// Medien-Helfer der Canvas: Vorschaubild aus einem Video und Freisteller (Hintergrund entfernen).

// Erstes sinnvolles Einzelbild (0,5 s) als PNG unter ~/Deckwerk/assets; ratio = Seitenverhältnis des Videos
export function videoPoster(src: string): Promise<{ src: string; ratio: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.preload = 'auto'
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2) }
    v.onseeked = async () => {
      const c = Object.assign(document.createElement('canvas'), { width: v.videoWidth, height: v.videoHeight })
      c.getContext('2d')!.drawImage(v, 0, 0)
      try { resolve({ src: await window.api.saveAsset(c.toDataURL('image/jpeg', 0.85), 'poster'), ratio: v.videoWidth / v.videoHeight || 16 / 9 }) } catch (e) { reject(e) }
    }
    v.onerror = () => reject(new Error('Video lässt sich nicht lesen (Format?)'))
    v.src = src
  })
}

/** Hintergrund entfernen → asset://-URL eines PNG mit Transparenz. onProgress: Modell-Download in % (nur beim ersten Mal) */
export async function removeBackground(src: string, onProgress?: (pct: number) => void): Promise<string> {
  const off = onProgress && window.api.onBgProgress(onProgress)
  try { return await window.api.removeBg(src) } finally { off?.() }
}
