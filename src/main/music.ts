// Freie Musik über Openverse (ohne Key): suchen und in den Asset-Ordner laden. Electron-frei.
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AUDIO_EXT } from '../shared/deck'
import { httpFetch } from './download'

export interface Track { id: string; title: string; artist: string; duration: number /* s, 0 = unbekannt */; license: 'cc0' | 'pdm' | 'by'; tags: string[]; url: string /* Openverse-Seite */ }

// Nur Lizenzen, die Musik unter Video erlauben: ND/SA/NC nie (Vertonung ist eine Bearbeitung, SA würde die Lizenz aufs Video übertragen)
const LICENSE = { cc0: 'CC0', pdm: 'Public Domain Mark', by: 'CC BY' } as const
const MIN_SECONDS = 30 // kürzere Treffer sind Jingles
const MAX_MB = 50
const API = 'https://api.openverse.org/v1/audio'
const UA = { 'User-Agent': 'Deckwerk/0.1 (+https://github.com/Bavarianator/deckwerk)' }

export interface Hit {
  id: string; title?: string; creator?: string; url?: string; filetype?: string; duration?: number | null
  license: string; license_version?: string; license_url?: string; foreign_landing_url?: string; tags?: { name: string }[] | null
}

// Openverse nennt Jamendo-MP3s "mp32"; die URLs haben oft keine Endung. Strikte Audio-Liste: die Endung landet im Dateinamen.
export function extOf(h: Pick<Hit, 'url' | 'filetype'>): string | null {
  let e = (h.filetype ?? '').toLowerCase().replace(/^mp3\d$/, 'mp3')
  if (!e) try { e = new URL(h.url ?? '').pathname.match(/\.(\w{2,5})$/)?.[1].toLowerCase() ?? '' } catch { return null }
  return AUDIO_EXT.includes(e) ? e : null
}

// Reine Filterfunktion (auch für fetchMusic mit den Detaildaten)
export function usable(h: Hit): boolean {
  const sec = (h.duration ?? 0) / 1000
  return Object.hasOwn(LICENSE, h.license) && !!h.url?.startsWith('https://') && !!extOf(h) && (sec === 0 || sec >= MIN_SECONDS)
}

const track = (h: Hit): Track => ({
  id: h.id, title: h.title || 'Ohne Titel', artist: h.creator || 'unbekannt', duration: Math.round((h.duration ?? 0) / 1000),
  license: h.license as Track['license'], tags: (h.tags ?? []).map((t) => t.name).slice(0, 8), url: h.foreign_landing_url ?? `https://openverse.org/audio/${h.id}`,
})

async function api<T>(url: string): Promise<T> {
  const res = await httpFetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) })
  if (res.status === 429) throw new Error('Openverse-Limit erreicht (anonym 20 Anfragen pro Minute, 200 pro Tag). Kurz warten und es später erneut versuchen.')
  if (!res.ok) throw new Error(`Openverse antwortet ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as T
}

export async function findMusic(query: string, limit = 8): Promise<Track[]> {
  const { results } = await api<{ results: Hit[] }>(`${API}/?q=${encodeURIComponent(query)}&category=music&license=cc0,pdm,by&page_size=${Math.min(Math.max(limit, 1) * 3, 20)}&mature=false`)
  return results.filter(usable).slice(0, limit).map(track)
}

// Redirects von Hand: jeder Hop muss https und kein lokales Netz sein. Der Body ist auf MAX_MB begrenzt (zählt beim Streamen).
async function get(url: string): Promise<ReadableStream<Uint8Array>> {
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(url)
    if (u.protocol !== 'https:') throw new Error('Nur https-Downloads.')
    if (/^(localhost|127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(u.hostname)) throw new Error('Adressen im eigenen Netz sind gesperrt.')
    const res = await httpFetch(u, { headers: UA, redirect: 'manual', signal: AbortSignal.timeout(120_000) })
    const next = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && next) { url = new URL(next, u).href; continue }
    if (!res.ok || !res.body) throw new Error(`${u.hostname} antwortet ${res.status}.`)
    if (/^text\//.test(res.headers.get('content-type') ?? '')) throw new Error('Unter dem Link liegt keine Audiodatei.')
    if (Number(res.headers.get('content-length')) > MAX_MB * 1e6) throw new Error(`Datei ist größer als ${MAX_MB} MB.`)
    let got = 0
    return res.body.pipeThrough(new TransformStream({ transform(c, ctl) {
      if ((got += c.length) > MAX_MB * 1e6) ctl.error(new Error(`Datei ist größer als ${MAX_MB} MB.`))
      else ctl.enqueue(c)
    } }))
  }
  throw new Error('Zu viele Weiterleitungen.')
}

export async function fetchMusic(id: string, dir: string): Promise<{ file: string; credit: string; track: Track }> {
  if (!/^[\w-]{8,64}$/.test(id)) throw new Error('Ungültige Openverse-ID.')
  const h = await api<Hit>(`${API}/${id}/`) // Details selbst holen, der KI-Eingabe nicht trauen
  if (!usable(h)) throw new Error('Dieser Titel ist nicht frei genug nutzbar (Lizenz, Format oder Länge).')
  const t = track(h)
  const slug = t.title.normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'musik'
  const file = join(dir, `${slug}-${id.replace(/\W/g, '').slice(0, 8)}.${extOf(h)}`)
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true })
    const part = `${file}.part` // erst nach vollständigem Download umbenennen, sonst bliebe eine halbe Datei liegen
    try {
      await pipeline(Readable.fromWeb((await get(h.url!)) as never), createWriteStream(part))
    } catch (e) { await rm(part, { force: true }); throw e }
    await rename(part, file)
  }
  const lic = `${LICENSE[t.license]}${t.license === 'by' && h.license_version ? ` ${h.license_version}` : ''}`
  const credit = `„${t.title}“ von ${t.artist}, ${lic}${h.license_url ? ` (${h.license_url})` : ''}, über Openverse`
  return { file, credit, track: t }
}
