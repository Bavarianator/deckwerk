// Gemeinsam bearbeiten: dreiseitiges Zusammenführen von Decks (Basis = letzter gemeinsamer Stand, mine, theirs).
// Läuft im Renderer und im Main, deshalb ohne node:-Importe. Bildpfade sind lokal absolut (asset://local/…), im
// geteilten Ordner relativ (assets/<name>); verglichen wird immer in der portablen Form.
import { MEDIA_EXT, type Deck } from './deck'

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x)

// FNV-1a über die UTF-8-Bytes: kurz, ohne Krypto-API, auf jedem Gerät gleich
const utf8 = new TextEncoder()
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (const b of utf8.encode(s)) h = Math.imul(h ^ b, 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Bildpfad portabel machen: asset://-URL einer Datei in <dir>/assets/<name> → "assets/<name>"; jede andere asset://-Datei → "assets/<fnv1a-hex(absoluter Pfad)>-<basename>"; alles andere unverändert. dir = absoluter lokaler Deck-Ordner ohne Schlussstrich */
export function portablePath(v: string, dir: string): string {
  if (!v.startsWith('asset://local/')) return v
  let abs = v.slice('asset://local'.length)
  try { abs = decodeURIComponent(abs) } catch { /* kaputte Kodierung: roh weiter */ }
  const d = dir.replace(/\\/g, '/').replace(/^(?!\/)/, '/') // Windows: C:\x → /C:/x wie in pathToFileURL
  const name = abs.slice(abs.lastIndexOf('/') + 1)
  return abs === `${d}/assets/${name}` ? `assets/${name}` : `assets/${fnv1a(abs)}-${name}`
}

// Kopie mit f auf jedem String (key = Feldname); __proto__ fällt weg, sonst setzte eine Zuweisung den Prototyp
const mapStrings = (x: unknown, f: (s: string, key: string) => string, key = ''): unknown =>
  typeof x === 'string' ? f(x, key)
    : Array.isArray(x) ? x.map((v) => mapStrings(v, f, key))
      : isObj(x) ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== '__proto__').map(([k, v]) => [k, mapStrings(v, f, k)]))
        : x

/** Deck-Kopie mit portablen Bildpfaden (für den Upload) */
export const portableDeck = (deck: Deck, dir: string): Deck => mapStrings(deck, (s) => portablePath(s, dir)) as Deck

// je dir ein Cache: Decks sind unveränderlich (React-State), Undo-Snapshots teilen Folien per Referenz
const caches = new Map<string, WeakMap<object, string>>()
/** kanonisches JSON (Schlüssel sortiert, Strings über portablePath) – für „hat sich etwas geändert?“; Cache je Objekt per WeakMap */
export function canonJson(x: unknown, dir: string): string {
  if (typeof x === 'string') return JSON.stringify(portablePath(x, dir))
  if (!x || typeof x !== 'object') return JSON.stringify(x) ?? '' // undefined → '' (Schlüssel fällt wie in JSON weg)
  let cache = caches.get(dir)
  if (!cache) caches.set(dir, (cache = new WeakMap()))
  let s = cache.get(x)
  if (s === undefined) {
    const o = x as Obj
    s = Array.isArray(x) ? `[${x.map((v) => canonJson(v, dir) || 'null').join(',')}]`
      : `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonJson(o[k], dir)}`).join(',')}}`
    cache.set(x, s)
  }
  return s
}

// id → Eintrag, wenn alle Einträge Objekte mit eindeutiger String-id sind; 'dup' = IDs vorhanden, aber nicht so; null = keine IDs
function byId(a: unknown[]): Map<string, unknown> | 'dup' | null {
  const m = new Map<string, unknown>()
  for (const x of a) {
    const id = isObj(x) ? x.id : undefined
    if (typeof id !== 'string' || m.has(id)) return a.some((y) => isObj(y) && typeof y.id === 'string') ? 'dup' : null
    m.set(id, x)
  }
  return m
}
// gemeinsame Einträge in derselben relativen Reihenfolge wie in der Basis?
const sameOrder = (base: string[], x: string[]) => {
  const inX = new Set(x), inB = new Set(base)
  const a = base.filter((id) => inX.has(id)), b = x.filter((id) => inB.has(id))
  return a.every((id, i) => id === b[i])
}

/** generischer 3-Wege-Merge; eq vergleicht (Standard: kanonische Gleichheit); onConflict je Stelle, an der beide Seiten verschieden geändert haben */
export function merge3(b: unknown, l: unknown, t: unknown, opts: { eq?: (a: unknown, b: unknown) => boolean; onConflict?: (path: string) => void } = {}): unknown {
  const eq = opts.eq ?? ((x, y) => x === y || canonJson(x, '') === canonJson(y, ''))
  const go = (b: unknown, l: unknown, t: unknown, path: string): unknown => {
    // l zuerst: sind alle gleich, bleibt die eigene Referenz (lokale Bildpfade, kein unnötiges Neuzeichnen)
    if (eq(l, t) || eq(t, b)) return l
    if (eq(l, b)) return t
    if (isObj(b) && isObj(l) && isObj(t)) {
      const out: Obj = {}
      for (const k of new Set([...Object.keys(l), ...Object.keys(t)])) {
        const v = go(b[k], l[k], t[k], `${path}/${k}`)
        if (v !== undefined) out[k] = v
      }
      return out
    }
    if (Array.isArray(b) && Array.isArray(l) && Array.isArray(t)) {
      const mb = byId(b), ml = byId(l), mt = byId(t)
      if (mb instanceof Map && ml instanceof Map && mt instanceof Map) {
        const keep = new Map<string, unknown>()
        for (const id of new Set([...ml.keys(), ...mt.keys()])) {
          // fehlt eine Seite, entscheidet go: unverändert gegenüber gelöscht → gelöscht, geändert gegenüber gelöscht → Konflikt, l gewinnt
          const v = (ml.has(id) && mt.has(id)) || mb.has(id) ? go(mb.get(id), ml.get(id), mt.get(id), `${path}/${id}`) : ml.get(id) ?? mt.get(id)
          if (v !== undefined) keep.set(id, v)
        }
        const [li, ti, bi] = [[...ml.keys()], [...mt.keys()], [...mb.keys()]]
        const [first, other] = sameOrder(bi, li) && !sameOrder(bi, ti) ? [ti, li] : [li, ti] // nur theirs umsortiert → deren Reihenfolge
        const ids = first.filter((id) => keep.has(id))
        // Neues der anderen Seite hinter seinen dortigen Vorgänger, ohne Vorgänger an den Anfang
        let prev: string | undefined
        for (const id of other) {
          if (!keep.has(id)) continue
          if (!ids.includes(id)) ids.splice(prev === undefined ? 0 : ids.indexOf(prev) + 1, 0, id)
          prev = id
        }
        return ids.map((id) => keep.get(id))
      }
      if (mb === null && ml === null && mt === null && b.length === l.length && l.length === t.length) return l.map((_, i) => go(b[i], l[i], t[i], `${path}/${i}`))
    }
    opts.onConflict?.(path)
    return l
  }
  return go(b, l, t, '')
}

export function mergeDeck(base: Deck, mine: Deck, theirs: Deck, dir: string): { deck: Deck; konflikte: number } {
  let konflikte = 0
  const deck = merge3(base, mine, theirs, { eq: (a, b) => a === b || canonJson(a, dir) === canonJson(b, dir), onConflict: () => konflikte++ }) as Deck
  return { deck, konflikte }
}

/** Undo/Redo-Snapshots auf einen fremden Stand umsetzen: jeder Snapshot s → mergeDeck(base, s, theirs, dir).deck */
export const rebase = (stack: Deck[], base: Deck, theirs: Deck, dir: string): Deck[] => stack.map((s) => mergeDeck(base, s, theirs, dir).deck)

// Felder mit Dateipfaden: Folien (src, image, poster), Videos (clip.video, Einblendung video), Brand-Kit (logo, logoDark), eigene Schrift
// (regular, bold), Excel-Link (file; nie ein Asset, fällt also immer weg: der Link gilt nur auf dem eigenen Rechner)
const FILE_KEYS = new Set(['src', 'image', 'poster', 'video', 'logo', 'logoDark', 'regular', 'bold', 'file'])
/** relativer Asset-Name aus einem fremden Stand: genau assets/<name>, ohne / \\ und .., Endung aus MEDIA_EXT (sonst schriebe join() unter Windows mit assets/..\\..\\x außerhalb des Deck-Ordners) */
export const isAssetRel = (s: string) => /^assets\/[^/\\]+$/.test(s) && !s.includes('..') && MEDIA_EXT.test(s)
// so, wie ein URL-Parser den Anfang liest: Tab/Zeilenumbruch fallen überall weg, Steuerzeichen und Leerzeichen vorn
const urlStart = (s: string) => s.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, '')

/** fremde deck.json (geparstes JSON, Pfade RELATIV wie im Upload) prüfen: Form wie readDeck (slides Array, theme vorhanden), Folien-IDs Strings; JEDER String irgendwo im Deck, der mit asset: oder file: beginnt (Groß/klein egal), wird entfernt (leerer String); relative Werte in Bildfeldern nur als "assets/<name>" ohne / \ und .., Endung aus MEDIA_EXT, sonst entfernt; data:-URLs in Bildfeldern erlaubt. Ungültige Form → Error mit deutscher Meldung. Gibt das bereinigte Deck zurück. */
export function sanitize(raw: unknown): Deck {
  // theme: Katalog-ID oder eigenes ThemeSpec (themes.ts)
  if (!isObj(raw) || !Array.isArray(raw.slides) || !(isObj(raw.theme) || (typeof raw.theme === 'string' && raw.theme))) throw new Error('Das ist keine gültige deck.json.')
  if (!raw.slides.every((s) => isObj(s) && typeof s.id === 'string')) throw new Error('Eine Folie in der deck.json hat keine gültige ID.')
  return mapStrings(raw, (s, key) => {
    const u = urlStart(s)
    // fremde lokale Dateien (Zugangsdaten, private Fotos) nie anfassen; „File: Bericht“ als Text bleibt
    if (/^(asset|file):\S/i.test(u)) return ''
    if (!FILE_KEYS.has(key) || !u || /^data:/i.test(u)) return s
    return isAssetRel(s) ? s : ''
  }) as Deck
}
