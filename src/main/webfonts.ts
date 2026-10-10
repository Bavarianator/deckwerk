// Schriften bei Bedarf: Familien aus dem Katalog (src/shared/font-catalog.ts) von Google Fonts laden, prüfen und unter
// ~/Deckwerk/fonts cachen. withFonts trägt die Dateien als asset://-URLs in ThemeRef.fontFiles ein; Renderer und PPTX-Export
// lesen nur diese Einträge. Fehlt eine Datei (offline, Fehler), bleibt der Eintrag weg und resolveTheme nimmt den Ersatz.
// Ohne Electron-Import, damit Smoke-Tests und Skripte es in Node nutzen können.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Deck, FontFiles, ThemeRef } from '../shared/deck'
import { fontInfo, instanceFamily, nearestWeight, WEIGHT_NAMES, type FontInfo } from '../shared/font-catalog'
import { FONTS, THEMES } from '../shared/themes'
import { inspectTtf } from './embed-fonts'

export const fontDir = () => join(process.env.DECKWERK_HOME ?? join(homedir(), 'Deckwerk'), 'fonts')
const assetUrl = (abs: string) => `asset://local${pathToFileURL(abs).pathname}` // Format wie tools.ts
const MAX = 3_000_000
export const CHARS = 'ÄÖÜäöüß€„“‚‘–—…'

// Google-Fonts-CSS-API: Nicht-Browser-UA bekommt je Schnitt eine statische TTF (Zwischengewichte als eigene Familie)
export const cssUrl = (family: string, spec: string) => `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${spec}`
export async function faceUrls(family: string, spec: string): Promise<{ style: string; weight: number; url: string }[]> {
  const res = await fetch(cssUrl(family, spec), { headers: { 'User-Agent': 'deckwerk' }, redirect: 'error', signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`Google Fonts: ${family} ${spec} → ${res.status}`)
  return [...(await res.text()).matchAll(/font-style: (\w+);\s*font-weight: (\d+);[\s\S]*?src: url\((\S+?\.ttf)\)/g)].map(([, style, weight, url]) => ({ style, weight: Number(weight), url }))
}
export async function download(url: string): Promise<Buffer> {
  if (!url.startsWith('https://fonts.gstatic.com/')) throw new Error(`Schriften nur von fonts.gstatic.com, nicht ${url.slice(0, 80)}`)
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) }) // keine Weiterleitung weg von fonts.gstatic.com
  if (!res.ok) throw new Error(`Download ${res.status}`)
  if (Number(res.headers.get('content-length')) > MAX) throw new Error('Schrift zu groß')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX) throw new Error(`Schrift zu groß (${Math.round(buf.length / 1e6)} MB)`)
  return buf
}

// Ein Schnitt: RIBBI-Schnitte gehören zur Familie, Zwischengewichte sind eigene Familien („Inter SemiBold“, nur regular)
interface Face { family: string; slot: keyof FontFiles; weight: number; italic: boolean }
const stem = (s: string) => s.replace(/\s+/g, '')
const fileOf = (info: FontInfo, f: Face) =>
  join(fontDir(), stem(info.family), `${stem(info.family)}-${f.family === info.family ? ({ regular: 'Regular', bold: 'Bold', italic: 'Italic', boldItalic: 'BoldItalic' } as const)[f.slot] : WEIGHT_NAMES[f.weight]}.ttf`)

// vollständige TTF der erwarteten Familie mit Umrissen? (inspectTtf wirft auch bei abgeschnittenen Tabellen)
const valid = (ttf: Buffer | string, family: string) => { try { const i = inspectTtf(typeof ttf === 'string' ? readFileSync(ttf) : ttf); return i.family === family && i.glyf } catch { return false } }
const checked = new Set<string>() // Cache-Dateien, die dieser Prozess schon geprüft hat
// Nach einem Netzfehler einige Minuten nicht mehr versuchen: sonst kostet jede weitere Familie den vollen Timeout (MCP-Aufrufe)
let netDownUntil = 0
const netDown = () => Date.now() < netDownUntil

const inflight = new Map<string, Promise<string | null>>()
// Datei aus dem Cache oder frisch laden (geprüft, atomar geschrieben); null = nicht verfügbar
function ensureFace(info: FontInfo, f: Face, offline: boolean): Promise<string | null> {
  const file = fileOf(info, f)
  if (existsSync(file)) {
    if (checked.has(file) || valid(file, f.family)) { checked.add(file); return Promise.resolve(file) }
    rmSync(file, { force: true }) // halb geschrieben, von Hand kopiert o. Ä.: neu laden
  }
  if (offline) return Promise.resolve(null)
  let p = inflight.get(file)
  if (!p) {
    p = (async () => {
      const [face] = await faceUrls(info.family, f.italic ? `ital,wght@1,${f.weight}` : `wght@${f.weight}`)
      if (!face) throw new Error(`${info.family} ${f.weight}: keine TTF`)
      const ttf = await download(face.url)
      if (!valid(ttf, f.family)) throw new Error(`${info.family}: keine brauchbare TTF für „${f.family}“`)
      mkdirSync(join(fontDir(), stem(info.family)), { recursive: true })
      const part = `${file}.${process.pid}-${randomBytes(3).toString('hex')}.part` // eindeutig: App und MCP-Prozess laden womöglich gleichzeitig
      try { writeFileSync(part, ttf); renameSync(part, file) } finally { rmSync(part, { force: true }) }
      return file
    })().catch((e) => {
      if (e instanceof TypeError || ['TimeoutError', 'AbortError'].includes((e as Error)?.name)) netDownUntil = Date.now() + 5 * 60_000 // fetch: kein Netz bzw. Zeitüberschreitung
      console.warn('[fonts]', e instanceof Error ? e.message : e)
      return null
    }).finally(() => inflight.delete(file))
    inflight.set(file, p)
  }
  return p
}

// Schnitte, die ein Theme braucht: alle genannten Familien (Design, Schriftpaar, Marke, freie Texte) mit RIBBI, dazu die Instanz fürs Titelgewicht
// Werte kommen auch aus fremden deck.json-Dateien: alles, was kein String ist, zählt nicht
function facesFor(ref: ThemeRef, extra: string[] = []): { info: FontInfo; faces: Face[] }[] {
  const fonts: unknown[] = Array.isArray(ref.fonts) ? ref.fonts : []
  const names = new Set([ref.custom?.headFont, ref.custom?.bodyFont, ...fonts, ref.brand?.headFont, ref.brand?.bodyFont, ...extra].filter((n): n is string => typeof n === 'string' && !!n))
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
  // tune schlägt custom; Titelschrift wie in resolveTheme: Schriftpaar > Marke > eigenes Design > Katalog-Theme
  const weight = ref.tune?.headWeight ?? ref.custom?.headWeight
  const headName = fonts[0] ?? ref.brand?.headFont ?? ref.custom?.headFont ?? THEMES.find((t) => t.id === ref.id)?.head.pptx
  const head = typeof weight === 'number' && typeof headName === 'string' ? fontInfo(headName) : undefined
  if (head && !head.office) {
    const w = nearestWeight(head, weight!)
    if (w !== 400 && w !== 700) // auch bei gebündelten Familien: Instanzen liegen nicht in assets/fonts
      out.push({ info: head, faces: [{ family: instanceFamily(head.family, w), slot: 'regular', weight: w, italic: false }] })
  }
  return out
}

const itemFonts = (deck: Deck) => deck.slides.flatMap((s) => (Array.isArray(s?.items) ? s.items : [])).flatMap((it) => (typeof it?.font === 'string' && it.font !== 'head' && it.font !== 'body' ? [it.font] : []))
const isOffline = () => !!process.env.DECKWERK_OFFLINE && process.env.DECKWERK_OFFLINE !== '0'

// fontFiles für dieses Theme neu bestimmen: laden, was fehlt, alte oder verwaiste Einträge verwerfen. notes für den Theme-Bericht.
export async function withFonts(ref: ThemeRef, opts: { offline?: boolean; extra?: string[] } = {}): Promise<{ ref: ThemeRef; notes: string[] }> {
  const offline = opts.offline ?? isOffline()
  const fontFiles: Record<string, FontFiles> = {}, notes: string[] = []
  for (const { info, faces } of facesFor(ref, opts.extra)) {
    const off = offline || netDown()
    const got = await Promise.all(faces.map(async (f) => ({ f, had: existsSync(fileOf(info, f)), file: await ensureFace(info, f, off) })))
    for (const { f, file } of got) if (file) (fontFiles[f.family] ??= { regular: '' })[f.slot] = assetUrl(file)
    const loaded = got.filter((g) => g.file && !g.had).map((g) => g.f.family)
    if (loaded.length) notes.push(`${[...new Set(loaded)].join(', ')} geladen`)
    const missing = got.filter((g) => !g.file).map((g) => g.f.family)
    if (missing.length) notes.push(`${[...new Set(missing)].join(', ')}: nicht verfügbar${off ? ' (offline)' : ''}, Ersatz ${info.fallback}`)
  }
  for (const [k, v] of Object.entries(fontFiles)) if (!v.regular) delete fontFiles[k] // ohne Regular kein brauchbarer Schnitt
  const next: ThemeRef = { ...ref, fontFiles: Object.keys(fontFiles).length ? fontFiles : undefined }
  if (!next.fontFiles) delete next.fontFiles
  return { ref: next, notes }
}

// Wie withFonts, mit den Schriften freier Texte aller Folien
export async function withDeckFonts(deck: Deck, opts: { offline?: boolean } = {}): Promise<{ theme: ThemeRef; notes: string[] }> {
  const { ref, notes } = await withFonts(deck.theme, { ...opts, extra: itemFonts(deck) })
  return { theme: ref, notes }
}

// deck.json ohne fontFiles: das sind Pfade dieses Rechners (mit Login-Namen), sie gehören weder in geteilte Dateien noch an die KI;
// beim Öffnen bestimmt withDeckFonts sie neu
export const deckJson = (deck: unknown, space = 2) => JSON.stringify(deck, (k, v) => (k === 'fontFiles' ? undefined : v), space)

// Welche Schnitte ein Deck braucht, ohne Dateizugriff: ändert sich der Wert, muss withDeckFonts neu laufen
export const fontNeeds = (deck: Deck) => JSON.stringify(facesFor(deck.theme, itemFonts(deck)).map(({ faces }) => faces.map((f) => `${f.family}/${f.slot}`)))
