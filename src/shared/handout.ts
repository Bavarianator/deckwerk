import type { Deck } from './deck'

// Handout (Canva „Deck → Doc“): Titel als Überschrift, übrige Texte als Liste, Notizen als Zitat
const SKIP = /^(image|src|icon|logo|url|href|qr|photo|focus|look|color)$/i
export function handout(deck: Deck): string {
  const texts = (v: unknown, k = ''): string[] =>
    typeof v === 'string' ? (SKIP.test(k) || /^(asset|https?):/.test(v) || !v.trim() ? [] : [v.trim()])
    : typeof v === 'number' ? [] : Array.isArray(v) ? v.flatMap((x) => texts(x, k))
    : v && typeof v === 'object' ? Object.entries(v).flatMap(([kk, x]) => texts(x, kk)) : []
  const out = [`# ${deck.title}`, '']
  deck.slides.forEach((s, i) => {
    const c = { ...s.content }
    const key = ['title', 'text', 'quote'].find((k) => typeof c[k] === 'string' && c[k].trim()) // statement/quote haben keinen Titel
    const title = key ? c[key].trim() : 'Folie'
    if (key) delete c[key]
    const body = [...texts(c), ...(s.items ?? []).flatMap((it) => (it.kind === 'text' ? texts(it.text) : []))]
    out.push(`## ${i + 1}. ${title.replace(/\n+/g, ' ')}`, '')
    out.push(...body.map((t) => `- ${t.replace(/\n+/g, ' ')}`))
    if (s.notes?.trim()) out.push('', ...s.notes.trim().split('\n').map((l) => `> ${l}`))
    out.push('')
  })
  return out.join('\n')
}

// Sprechzeit der Notizen in Sekunden (~130 Wörter pro Minute, freier Vortrag)
export const speakSec = (notes?: string) => Math.round(((notes ?? '').match(/\S+/g)?.length ?? 0) / 130 * 60)
export const fmtSec = (s: number) => (s < 60 ? `${s} s` : `${Math.round(s / 60)} min`)
