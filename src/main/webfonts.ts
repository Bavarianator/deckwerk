// Schriften bei Bedarf: Familien aus dem Katalog (src/shared/font-catalog.ts) von Google Fonts laden, prüfen und unter
// ~/Deckwerk/fonts cachen. withFonts trägt die Dateien als asset://-URLs in ThemeRef.fontFiles ein; Renderer und PPTX-Export
// lesen nur diese Einträge. Fehlt eine Datei (offline, Fehler), bleibt der Eintrag weg und resolveTheme nimmt den Ersatz.
// Ohne Electron-Import, damit Smoke-Tests und Skripte es in Node nutzen können.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FontFiles, ThemeRef } from '../shared/deck'
import { fontInfo, instanceFamily, nearestWeight, WEIGHT_NAMES, type FontInfo } from '../shared/font-catalog'
import { FONTS } from '../shared/themes'
import { inspectTtf } from './embed-fonts'

export const fontDir = () => join(process.env.DECKWERK_HOME ?? join(homedir(), 'Deckwerk'), 'fonts')
const assetUrl = (abs: string) => `asset://local${pathToFileURL(abs).pathname}` // Format wie tools.ts
const MAX = 3_000_000
export const CHARS = 'ÄÖÜäöüß€„“‚‘–—…'

// Google-Fonts-CSS-API: Nicht-Browser-UA bekommt je Schnitt eine statische TTF (Zwischengewichte als eigene Familie)
export const cssUrl = (family: string, spec: string) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${spec}`
export async function faceUrls(family: string, spec: string): Promise<{ style: string; weight: number; url: string }[]> {
  const res = await fetch(cssUrl(family, spec), { headers: { 'User-Agent': 'deckwerk' }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Google Fonts: ${family} ${spec} → ${res.status}`)
  return [...(await res.text()).matchAll(/font-style: (\w+);\s*font-weight: (\d+);[\s\S]*?src: url\((\S+?\.ttf)\)/g)].map(([, style, weight, url]) => ({ style, weight: Number(weight), url }))
}
export async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`Download ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX) throw new Error(`Schrift zu groß (${Math.round(buf.length / 1e6)} MB)`)
  return buf
}

// Ein Schnitt: RIBBI-Schnitte gehören zur Familie, Zwischengewichte sind eigene Familien („Inter SemiBold“, nur regular)
interface Face { family: string; slot: keyof FontFiles; weight: number; italic: boolean }
const stem = (s: string) => s.replace(/\s+/g, '')
const fileOf = (info: FontInfo, f: Face) =>
  join(fontDir(), stem(info.family), `${stem(info.family)}-${f.family === info.family ? ({ regular: 'Regular', bold: 'Bold', italic: 'Italic', boldItalic: 'BoldItalic' } as const)[f.slot] : WEIGHT_NAMES[f.weight]}.ttf`)

const inflight = new Map<string, Promise<string | null>>()
// Datei aus dem Cache oder frisch laden (geprüft, atomar geschrieben); null = nicht verfügbar
function ensureFace(info: FontInfo, f: Face, offline: boolean): Promise<string | null> {
  const file = fileOf(info, f)
  if (existsSync(file)) return Promise.resolve(file)
  if (offline) return Promise.resolve(null)
  let p = inflight.get(file)
  if (!p) {
    p = (async () => {
      const [face] = await faceUrls(info.family, f.italic ? `ital,wght@1,${f.weight}` : `wght@${f.weight}`)
      if (!face) throw new Error(`${info.family} ${f.weight}: keine TTF`)
      const ttf = await download(face.url)
      const got = inspectTtf(ttf)
      if (got.family !== f.family) throw new Error(`${info.family}: Datei heißt „${got.family}“, erwartet „${f.family}“`)
      if (!got.glyf) throw new Error(`${info.family}: keine TrueType-Umrisse`)
      mkdirSync(join(fontDir(), stem(info.family)), { recursive: true })
      writeFileSync(`${file}.part`, ttf)
      renameSync(`${file}.part`, file)
      return file
    })().catch((e) => { console.warn('[fonts]', e instanceof Error ? e.message : e); return null }).finally(() => inflight.delete(file))
    inflight.set(file, p)
  }
  return p
}

// Schnitte, die ein Theme braucht: Text- und Titelfamilie mit RIBBI, dazu die Instanz fürs Titelgewicht
function facesFor(ref: ThemeRef): { info: FontInfo; faces: Face[] }[] {
  const names = new Set([ref.custom?.headFont, ref.custom?.bodyFont, ...(ref.fonts ?? []), ref.brand?.headFont].filter((n): n is string => !!n))
  const out: { info: FontInfo; faces: Face[] }[] = []
  for (const name of names) {
    const info = fontInfo(name)
    if (!info || info.office || name in FONTS) continue // gebündelt oder Office: nichts zu laden
    const has = (w: number) => info.weights.includes(w)
    const base = has(400) ? 400 : info.weights[0]
    const faces: Face[] = [{ family: info.family, slot: 'regular', weight: base, italic: false }]
    if (has(700)) faces.push({ family: info.family, slot: 'bold', weight: 700, italic: false })
    if (info.italic) faces.push({ family: info.family, slot: 'italic', weight: base, italic: true }, ...(has(700) ? [{ family: info.family, slot: 'boldItalic' as const, weight: 700, italic: true }] : []))
    out.push({ info, faces })
  }
  const head = ref.custom?.headWeight && ref.custom.headFont ? fontInfo(ref.custom.headFont) : undefined
  if (head && !head.office) {
    const w = nearestWeight(head, ref.custom!.headWeight!)
    if (w !== 400 && w !== 700) // auch bei gebündelten Familien: Instanzen liegen nicht in assets/fonts
      out.push({ info: head, faces: [{ family: instanceFamily(head.family, w), slot: 'regular', weight: w, italic: false }] })
  }
  return out
}

// fontFiles für dieses Theme neu bestimmen: laden, was fehlt, alte oder verwaiste Einträge verwerfen. notes für den Theme-Bericht.
export async function withFonts(ref: ThemeRef, opts: { offline?: boolean } = {}): Promise<{ ref: ThemeRef; notes: string[] }> {
  const offline = opts.offline ?? !!process.env.DECKWERK_OFFLINE
  const fontFiles: Record<string, FontFiles> = {}, notes: string[] = []
  for (const { info, faces } of facesFor(ref)) {
    const got = await Promise.all(faces.map(async (f) => ({ f, file: await ensureFace(info, f, offline) })))
    for (const { f, file } of got) if (file) (fontFiles[f.family] ??= { regular: '' })[f.slot] = assetUrl(file)
    const missing = got.filter((g) => !g.file).map((g) => g.f.family)
    if (missing.length) notes.push(`${[...new Set(missing)].join(', ')}: nicht verfügbar${offline ? ' (offline)' : ''}, Ersatz ${info.fallback}`)
  }
  for (const [k, v] of Object.entries(fontFiles)) if (!v.regular) delete fontFiles[k] // ohne Regular kein brauchbarer Schnitt
  const next: ThemeRef = { ...ref, fontFiles: Object.keys(fontFiles).length ? fontFiles : undefined }
  if (!next.fontFiles) delete next.fontFiles
  return { ref: next, notes }
}

// Selbsttest ohne Netz: DW_WEBFONTS_SELFTEST=1 node … (Offline-Pfad, Instanzname, Cache-Treffer)
if (typeof process !== 'undefined' && process.env.DW_WEBFONTS_SELFTEST) void (async () => {
  const dir = join(process.env.DECKWERK_HOME!, 'fonts', 'InterTight')
  mkdirSync(dir, { recursive: true })
  const ttf = readFileSync(process.env.DW_WEBFONTS_SELFTEST!) // eine echte Regular-TTF (irgendeine) als Cache-Attrappe
  writeFileSync(join(dir, 'InterTight-Regular.ttf'), ttf)
  const r = await withFonts({ id: 'custom', custom: { name: 't', bg: '#FFFFFF', accent: '#111111', headFont: 'Inter Tight', bodyFont: 'Inter', radius: 2, decor: 'none', headWeight: 600 } }, { offline: true })
  if (!r.ref.fontFiles?.['Inter Tight']?.regular.startsWith('asset://local/')) throw new Error('Cache-Treffer fehlt')
  if (r.ref.fontFiles?.['Inter Tight SemiBold']) throw new Error('offline darf nichts Neues entstehen')
  if (!r.notes.some((n) => n.includes('Inter Tight SemiBold') && n.includes('offline'))) throw new Error('Offline-Hinweis fehlt: ' + r.notes.join(' | '))
  console.log('webfonts ok')
})()
