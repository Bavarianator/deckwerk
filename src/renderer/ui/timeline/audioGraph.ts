// Web-Audio-Kette je Medienelement für die Timeline-Vorschau: Pegel, EQ und Pegel-Keyframes wie im Export
import { EQ_HZ, TL, tlAt, type TLClip } from '../../../shared/timeline'

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const lin = (db: number) => 10 ** (db / 20)

/** Pegel-Keys des Clips als Rampenpunkte: t relativ zu t0 (Timeline-Zeit), gain linear. Startwert bei t0 interpoliert, danach nur spätere Keys */
export function keysToRamps(clip: TLClip, t0: number): { t: number; gain: number }[] {
  const ks = (clip.keys ?? []).map(([s, db]) => ({ t: tlAt(clip, s), db: clamp(db, TL.db.min, TL.db.max) })).sort((a, b) => a.t - b.t)
  if (!ks.length) return []
  const j = ks.findIndex((k) => k.t > t0)
  let db0: number // zwischen den Keys linear in dB, vor dem ersten bzw. nach dem letzten Key gilt dessen Wert
  if (j < 0) db0 = ks[ks.length - 1].db
  else if (j === 0) db0 = ks[0].db
  else { const a = ks[j - 1], b = ks[j]; db0 = a.db + ((b.db - a.db) * (t0 - a.t)) / (b.t - a.t) }
  return [{ t: 0, gain: lin(db0) }, ...(j < 0 ? [] : ks.slice(j)).map((k) => ({ t: k.t - t0, gain: lin(k.db) }))]
}

/** Pegelfaktor der Rampen zur Zeit t (relativ zu t0): exponentiell zwischen den Punkten = linear in dB wie keyExpr im Export */
export function gainAt(ramps: { t: number; gain: number }[], t: number): number {
  if (!ramps.length) return 1
  const j = ramps.findIndex((r) => r.t > t)
  if (j < 0) return ramps[ramps.length - 1].gain
  if (j === 0) return ramps[0].gain
  const a = ramps[j - 1], b = ramps[j]
  return a.gain * (b.gain / a.gain) ** ((t - a.t) / (b.t - a.t))
}

export interface Chain { apply(clip: TLClip, trackVolume: number, t0: number, now: number): void }
// createMediaElementSource geht je Element nur einmal, deshalb Kette je Element merken
const chains = new WeakMap<HTMLMediaElement, Chain>()

export function chainFor(ctx: AudioContext, el: HTMLMediaElement, master: AudioNode): Chain {
  const hit = chains.get(el)
  if (hit) return hit
  // vol: Lautstärke und Mute (darf 0 sein), keys: Keyframe-Rampen (immer > 0, exponentialRamp verträgt keine 0)
  const vol = ctx.createGain(), keys = ctx.createGain(), low = ctx.createBiquadFilter(), mid = ctx.createBiquadFilter(), high = ctx.createBiquadFilter()
  low.type = 'lowshelf'; low.frequency.value = EQ_HZ.low
  mid.type = 'peaking'; mid.frequency.value = EQ_HZ.mid; mid.Q.value = 1
  high.type = 'highshelf'; high.frequency.value = EQ_HZ.high
  ctx.createMediaElementSource(el).connect(vol).connect(keys).connect(low).connect(mid).connect(high).connect(master)
  const chain: Chain = {
    apply(clip, trackVolume, t0, now) {
      const eq = (v?: number) => clamp(v ?? 0, TL.eq.min, TL.eq.max)
      low.gain.value = eq(clip.eq?.low); mid.gain.value = eq(clip.eq?.mid); high.gain.value = eq(clip.eq?.high)
      const base = clip.mute ? 0 : clamp(clip.volume ?? 1, TL.volume.min, TL.volume.max) * trackVolume
      vol.gain.cancelScheduledValues(now); vol.gain.setValueAtTime(base, now)
      const g = keys.gain, ramps = keysToRamps(clip, t0)
      g.cancelScheduledValues(now)
      if (!ramps.length) { g.setValueAtTime(1, now); return }
      ramps.forEach((r, i) => (i ? g.exponentialRampToValueAtTime(r.gain, now + r.t) : g.setValueAtTime(r.gain, now + r.t)))
    },
  }
  chains.set(el, chain)
  return chain
}

/** Spitzenpegel am Knoten in dBFS (Stille ≈ −100) */
export function meter(ctx: AudioContext, node: AudioNode): () => number {
  const an = ctx.createAnalyser()
  an.fftSize = 2048
  node.connect(an)
  const buf = new Float32Array(an.fftSize)
  return () => {
    an.getFloatTimeDomainData(buf)
    let p = 0
    for (const x of buf) p = Math.max(p, Math.abs(x))
    return 20 * Math.log10(Math.max(p, 1e-5))
  }
}
