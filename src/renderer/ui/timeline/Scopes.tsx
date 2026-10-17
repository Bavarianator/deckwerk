// Waveform/Histogramm des aktuellen Vorschaubilds. Canvas sieht den SVG-Filter der Vorschau nicht, darum Grading hier nachrechnen
import { useEffect, useRef } from 'react'
import type { Grade } from '../../../shared/timeline'
import { applyTables, gradeTables } from '../../../shared/grade'
import { histogram, waveform } from './scope-math'

const W = 256, H = 128, SW = 256, SH = 144 // Anzeige, Abtastbild
const FPS = 8

export function Scopes({ video, grade, sat, mode }: { video: HTMLVideoElement | null; grade?: Grade; sat?: number; mode: 'waveform' | 'histogram' }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current, g = cv?.getContext('2d')
    if (!cv || !g || !video) return
    const src = document.createElement('canvas')
    src.width = SW; src.height = SH
    const sg = src.getContext('2d', { willReadFrequently: true })!
    const tables = gradeTables(grade)
    let raf = 0, last = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (now - last < 1000 / FPS || video.readyState < 2) return
      last = now
      let px: Uint8ClampedArray
      try { sg.drawImage(video, 0, 0, SW, SH); px = sg.getImageData(0, 0, SW, SH).data } catch { return } // fremde Quelle (tainted) o. Ä.
      applyTables(px, tables, sat)
      g.clearRect(0, 0, W, H)
      const accent = getComputedStyle(cv).getPropertyValue('--accent').trim() || '#888'
      if (mode === 'waveform') {
        const wf = waveform(px, SW, SH, W), img = g.createImageData(W, H), norm = Math.log1p(SH / 4)
        for (let x = 0; x < W; x++)
          for (let v = 0; v < 256; v++) {
            const n = wf[x * 256 + v]
            if (!n) continue
            const i = ((H - 1 - ((v * (H - 1)) / 255) | 0) * W + x) * 4
            img.data[i] = img.data[i + 1] = img.data[i + 2] = 170
            img.data[i + 3] = Math.min(255, img.data[i + 3] + (255 * Math.log1p(n)) / norm)
          }
        g.putImageData(img, 0, 0)
      } else {
        const hs = histogram(px)
        const max = Math.max(1, ...hs.y, ...hs.r, ...hs.g, ...hs.b)
        const line = (a: Uint32Array, color: string) => {
          g.strokeStyle = color
          g.beginPath()
          for (let v = 0; v < 256; v++) g.lineTo((v * W) / 256, H - (a[v] / max) * H)
          g.stroke()
        }
        g.lineWidth = 1
        line(hs.r, 'rgba(220,80,80,.6)'); line(hs.g, 'rgba(80,180,100,.6)'); line(hs.b, 'rgba(80,120,220,.6)'); line(hs.y, accent)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [video, grade, sat, mode])
  return <canvas ref={ref} width={W} height={H} aria-label={mode === 'waveform' ? 'Waveform' : 'Histogramm'} style={{ width: W, height: H, display: 'block' }} />
}
