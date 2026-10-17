// Medien der Pro-Timeline: Ziehen aus Pool und Dateimanager, Art und Länge einer Quelle
import { AUDIO_FILE, VIDEO_FILE } from '../../../shared/deck'
import { clipUrl } from '../clipPlayer'
import { assetOf } from '../itemOps'

/** dataTransfer-Typ für Pool-Einträge; Inhalt = src (mehrere zeilenweise) */
export const MEDIA_MIME = 'application/x-dw-media'
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i
const IMAGE_LEN = 5 // Standbilder ohne eigene Länge, wie VideoTools

export const isAudioSrc = (src: string) => AUDIO_FILE.test(src)
export const isImageSrc = (src: string) => IMAGE_FILE.test(src)
const usable = (src: string) => VIDEO_FILE.test(src) || isAudioSrc(src) || isImageSrc(src)

/** Quellen aus einem Drop: Pool-Einträge und Dateien vom Betriebssystem (als asset://-URL wie pickMedia), nur Video, Ton und Bild */
export function srcFromDrop(dt: DataTransfer): string[] {
  const pool = (dt.getData(MEDIA_MIME) || '').split('\n').map((s) => s.trim()).filter(Boolean)
  const files = Array.from(dt.files ?? []).map((f) => window.api.pathOf(f)).filter(Boolean).map(assetOf)
  return [...new Set([...pool, ...files])].filter(usable)
}

/** Länge in s und ob ein Bild dabei ist; Bilder gelten als 5 s Video */
export function probeMedia(src: string): Promise<{ duration: number; video: boolean }> {
  if (isImageSrc(src)) return Promise.resolve({ duration: IMAGE_LEN, video: true })
  return new Promise((ok, fail) => {
    const audio = isAudioSrc(src), m = document.createElement(audio ? 'audio' : 'video')
    const done = () => { clearTimeout(timer); m.removeAttribute('src'); m.load() }
    const timer = setTimeout(() => { done(); fail(new Error('Datei antwortet nicht (Zeitüberschreitung)')) }, 15_000)
    m.preload = 'metadata'
    m.onloadedmetadata = () => {
      const d = m.duration, video = !audio && (m as HTMLVideoElement).videoWidth > 0
      done()
      Number.isFinite(d) && d > 0 ? ok({ duration: d, video }) : fail(new Error('Länge der Datei unbekannt'))
    }
    m.onerror = () => { done(); fail(new Error('Datei lässt sich nicht lesen')) }
    m.src = clipUrl(src)
  })
}
