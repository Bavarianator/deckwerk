// Cloud-Sync per WebDAV (Nextcloud, ownCloud, pCloud, Koofr, Box, Synology …): spiegelt ~/Deckwerk in den Ordner
// Deckwerk/ auf dem Server. Electron-frei, damit dieselbe Datei in der Android-Engine läuft (dort mit nativeFetch).
// Abgleich gegen .sync-state.json (je Datei mtime/size lokal und etag entfernt vom letzten Lauf):
// nur eine Seite geändert → übernehmen, beide → neuere gewinnt (bei deck.json landet die ältere in versions/).
// Selbsttest: scripts/check-sync.ts
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

export interface SyncSettings { url: string; user: string; pass: string }
export interface SyncResult { up: number; down: number; deleted: number; conflicts: number; changed: string[] } // changed: lokal überschriebene oder gelöschte Dateien (absolut)
interface Entry { mtime: number; size: number }
interface Remote extends Entry { etag: string }
interface State { [path: string]: { mtime: number; size: number; etag: string } }

const STATE = '.sync-state.json'
// nicht gespiegelt: Versionen, Exporte, Modelle, Importe, Punktdateien (auch .sync-state.json, .setup-done)
const SKIP = new Set(['versions', 'out', 'models', '.import', 'exports'])
const skip = (name: string) => name.startsWith('.') || SKIP.has(name)

/** WebDAV-Basis inkl. Deckwerk/. Nur ein Host (ohne Pfad) → Nextcloud/ownCloud-Pfad /remote.php/dav/files/<nutzer>/ */
export function davBase(s: Pick<SyncSettings, 'url' | 'user'>): string {
  let u: URL
  try { u = new URL(s.url.trim().includes('://') ? s.url.trim() : `https://${s.url.trim()}`) } catch { throw new Error('Cloud-Sync: Die WebDAV-Adresse ist ungültig.') }
  if (u.pathname === '/' || u.pathname === '') u.pathname = `/remote.php/dav/files/${encodeURIComponent(s.user)}/`
  if (!u.pathname.endsWith('/')) u.pathname += '/'
  return `${u.origin}${u.pathname}Deckwerk/`
}

// Deck-Pfade sind absolut; auf einem anderen Gerät liegt der Deckwerk-Ordner woanders → beim Lesen auf den lokalen umleiten
export function localAsset(file: string, home = process.env.DECKWERK_HOME ?? join(homedir(), 'Deckwerk')): string {
  if (existsSync(file)) return file
  const i = file.lastIndexOf('/Deckwerk/')
  if (i < 0) return file
  const alt = resolve(home, file.slice(i + '/Deckwerk/'.length))
  return alt.startsWith(resolve(home) + sep) && existsSync(alt) ? alt : file
}

const enc = (rel: string) => rel.split('/').map(encodeURIComponent).join('/')

// ETags kommen je Server mit oder ohne Anführungszeichen bzw. W/-Präfix (PUT-Header und PROPFIND unterscheiden sich)
const etagOf = (e: string | null | undefined) => (e ?? '').replace(/&quot;/g, '"').replace(/^W\//, '').replace(/"/g, '').trim()
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')

// PROPFIND-Antwort ohne XML-Bibliothek: Namensraum-Präfixe sind je Server verschieden (d:, D:, keins)
function parseMultistatus(xml: string, basePath: string) {
  const tag = (s: string, name: string) => s.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`))?.[1]?.trim() ?? ''
  const out: { rel: string; dir: boolean; remote: Remote }[] = []
  for (const part of xml.split(/<(?:\w+:)?response[\s>]/).slice(1)) {
    // Schlussstrich ergänzen: manche Server nennen Ordner ohne, sonst fiele der Ordner selbst (/…/Deckwerk) durch
    const href = decodeURIComponent(new URL(unxml(tag(part, 'href')), 'http://x').pathname).replace(/\/?$/, '/')
    if (!href.startsWith(basePath)) continue
    const rel = href.slice(basePath.length).replace(/\/$/, '')
    out.push({
      rel,
      dir: /<(?:\w+:)?collection[\s/>]/.test(part),
      remote: { etag: etagOf(tag(part, 'getetag')), size: Number(tag(part, 'getcontentlength')) || 0, mtime: Date.parse(tag(part, 'getlastmodified')) || 0 },
    })
  }
  return out
}

export async function sync(home: string, s: SyncSettings, fetchFn: typeof fetch = fetch): Promise<SyncResult> {
  const base = davBase(s)
  const basePath = decodeURIComponent(new URL(base).pathname)
  const auth = `Basic ${btoa(unescape(encodeURIComponent(`${s.user}:${s.pass}`)))}`
  const dav = async (method: string, rel: string, init: { body?: Uint8Array | string; headers?: Record<string, string> } = {}) => {
    const r = await fetchFn(base + enc(rel), { method, body: init.body as BodyInit | undefined, headers: { Authorization: auth, ...init.headers } })
    if (r.status === 401) throw new Error('Cloud-Sync: Anmeldung abgelehnt. Nutzername und App-Passwort prüfen.')
    return r
  }
  const must = async (r: Response, what: string) => {
    if (!r.ok && r.status !== 207) throw new Error(`Cloud-Sync: ${what} fehlgeschlagen (HTTP ${r.status})`)
    return r
  }

  // entfernt: Depth 1 rekursiv, weil Nextcloud Depth infinity sperrt. fresh = Ordner Deckwerk fehlte und ist neu angelegt
  const remote = new Map<string, Remote>()
  const madeDirs = new Set<string>([''])
  let fresh = false
  async function listRemote(rel: string): Promise<void> {
    const r = await dav('PROPFIND', rel ? `${rel}/` : '', { headers: { Depth: '1', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>' })
    if (r.status === 404 && !rel) {
      const m = await dav('MKCOL', '')
      if (m.status === 409) throw new Error('Cloud-Sync: Die WebDAV-Adresse gibt es auf dem Server nicht. Adresse prüfen.')
      await must(m, 'Ordner Deckwerk anlegen')
      fresh = true
      return
    }
    await must(r, 'Ordner lesen')
    const entries = parseMultistatus(await r.text(), basePath)
    // Depth 1 nennt immer den Ordner selbst. Fehlt er, passen die hrefs nicht zur Adresse (Proxy, andere Nextcloud-uid):
    // eine leer gelesene Liste sähe sonst aus, als wäre auf dem Server alles gelöscht
    if (!entries.some((e) => e.rel === rel)) throw new Error('Cloud-Sync: Die Antwort des Servers passt nicht zur Adresse. WebDAV-Adresse prüfen.')
    for (const e of entries) {
      if (e.rel === rel || e.rel.split('/').some(skip)) continue
      if (e.dir) { madeDirs.add(e.rel); await listRemote(e.rel) } else remote.set(e.rel, e.remote)
    }
  }
  await listRemote('')

  // lokal. Nur ein fehlender Ordner zählt als leer; jeder andere Lesefehler bricht ab (sonst sähe alles „lokal gelöscht“ aus)
  const local = new Map<string, Entry>()
  async function listLocal(rel: string): Promise<void> {
    const items = await readdir(join(home, rel), { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      if (e?.code === 'ENOENT') return []
      throw new Error(`Cloud-Sync: Ordner ${join(home, rel)} nicht lesbar (${e?.message ?? e})`)
    })
    for (const d of items) {
      if (skip(d.name)) continue
      const r = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) await listLocal(r)
      else { const st = await stat(join(home, r)); local.set(r, { mtime: Math.round(st.mtimeMs), size: st.size }) }
    }
  }
  await listLocal('')

  // Stand des letzten Laufs. Gilt nur für dieselbe Adresse und einen vorhandenen Server-Ordner: anderes Konto, andere URL oder
  // ein gelöschter bzw. umbenannter Ordner Deckwerk heißen „neu anfangen“ (alles abgleichen, nichts löschen)
  const statePath = join(home, STATE)
  const saved: { base?: string; files?: State } = await readFile(statePath, 'utf8').then(JSON.parse).catch(() => ({}))
  const old: State = !fresh && saved.base === `${s.user}@${base}` ? saved.files ?? {} : {}
  const next: State = {}
  const gone = new Set<string>()
  const res: SyncResult = { up: 0, down: 0, deleted: 0, conflicts: 0, changed: [] }
  const uploaded: string[] = []

  const mkcols = async (rel: string) => {
    const parts = rel.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      if (madeDirs.has(d)) continue
      const r = await dav('MKCOL', `${d}/`)
      if (!r.ok && r.status !== 405) await must(r, `Ordner ${d} anlegen`) // 405 = gibt es schon
      madeDirs.add(d)
    }
  }
  const up = async (rel: string) => {
    await mkcols(rel)
    const l = local.get(rel)!
    // X-OC-Mtime: Nextcloud/ownCloud übernehmen die Bearbeitungszeit, sonst wäre getlastmodified die Upload-Zeit (Konflikt-Gewinner)
    const r = await must(await dav('PUT', rel, { body: await readFile(join(home, rel)), headers: { 'X-OC-Mtime': String(Math.floor(l.mtime / 1000)) } }), `Hochladen ${rel}`)
    next[rel] = { ...l, etag: etagOf(r.headers.get('etag')) }
    uploaded.push(rel)
    res.up++
  }
  // Hat sich die Datei seit dem Auflisten lokal geändert (Auto-Speichern), nicht anfassen: der nächste Lauf sieht einen Konflikt
  const touched = async (rel: string) => {
    const st = await stat(join(home, rel)).catch(() => null), l = local.get(rel)
    return l ? !st || Math.round(st.mtimeMs) !== l.mtime || st.size !== l.size : !!st
  }
  const down = async (rel: string, force = false) => {
    if (!force && await touched(rel)) return
    const r = await must(await dav('GET', rel), `Herunterladen ${rel}`)
    const file = join(home, rel)
    await mkdir(dirname(file), { recursive: true })
    // atomar über eine Punktdatei (vom Sync ausgenommen): ein Abbruch hinterlässt keine halbe Datei
    const part = join(dirname(file), `.${rel.split('/').pop()}.part`)
    await writeFile(part, new Uint8Array(await r.arrayBuffer()))
    await rename(part, file)
    const st = await stat(file)
    next[rel] = { mtime: Math.round(st.mtimeMs), size: st.size, etag: remote.get(rel)!.etag }
    res.down++
    res.changed.push(file)
  }
  // Konflikt: die ältere Fassung einer deck.json bleibt in versions/ erhalten, dann gewinnt die neuere
  const stamp = () => new Date().toLocaleString('sv').replace(' ', 'T').replace(/:/g, '-')
  const conflict = async (rel: string) => {
    res.conflicts++
    const deck = rel.endsWith('/deck.json')
    const vdir = join(home, dirname(rel), 'versions')
    if (local.get(rel)!.mtime >= remote.get(rel)!.mtime) {
      if (deck) {
        const r = await must(await dav('GET', rel), `Herunterladen ${rel}`)
        await mkdir(vdir, { recursive: true })
        await writeFile(join(vdir, `${stamp()}-cloud.json`), new Uint8Array(await r.arrayBuffer()))
      }
      await up(rel)
    } else {
      if (deck) { await mkdir(vdir, { recursive: true }); await writeFile(join(vdir, `${stamp()}-lokal.json`), await readFile(join(home, rel))) }
      await down(rel, true)
    }
  }

  // erst planen, dann ausführen: so greift die Löschbremse, bevor etwas weg ist
  type Op = 'keep' | 'same' | 'conflict' | 'up' | 'down' | 'rmLocal' | 'rmRemote' | 'forget'
  const plan: [string, Op][] = []
  for (const rel of new Set([...local.keys(), ...remote.keys(), ...Object.keys(old)])) {
    const l = local.get(rel), r = remote.get(rel), o = old[rel]
    // zwei neue Dateien gleicher Größe (erster Abgleich, Neubeginn): Inhalt vergleichen, sonst ginge eine Fassung unbemerkt verloren
    if (l && r && !o && l.size === r.size) {
      const [x, y] = [new Uint8Array(await (await must(await dav('GET', rel), `Herunterladen ${rel}`)).arrayBuffer()), new Uint8Array(await readFile(join(home, rel)))]
      const same = x.length === y.length && x.every((v, i) => v === y[i]) // ohne Buffer: läuft auch in der Android-Engine
      plan.push([rel, same ? 'same' : 'conflict'])
      continue
    }
    const lChanged = !!l && (!o || l.mtime !== o.mtime || l.size !== o.size)
    // ohne gemerkten ETag (Server lieferte keinen) entscheidet die Größe
    const rChanged = !!r && (!o || (o.etag ? r.etag !== o.etag : r.size !== o.size))
    plan.push([rel, l && r
      ? lChanged && rChanged ? 'conflict' : lChanged ? 'up' : rChanged ? 'down' : 'keep'
      : l ? (o && !lChanged ? 'rmLocal' : 'up')
      : r ? (o && !rChanged ? 'rmRemote' : 'down')
      : 'forget'])
  }
  const deletions = plan.filter(([, op]) => op === 'rmLocal' || op === 'rmRemote').length
  const known = Object.keys(old).length
  if (known >= 10 && deletions > known / 2)
    throw new Error(`Cloud-Sync angehalten: ${deletions} von ${known} Dateien würden gelöscht. Ist der Ordner auf dem Server oder auf dem Gerät noch vollständig? Zum Neubeginn Sync aus- und wieder einschalten.`)

  try {
    for (const [rel, op] of plan) {
      const l = local.get(rel), r = remote.get(rel)
      if (op === 'same') next[rel] = { ...l!, etag: r!.etag }
      else if (op === 'keep') next[rel] = old[rel]
      else if (op === 'conflict') await conflict(rel)
      else if (op === 'up') await up(rel)
      else if (op === 'down') await down(rel)
      else if (op === 'rmLocal') { if (await touched(rel)) continue; await rm(join(home, rel), { force: true }); gone.add(rel); res.deleted++; res.changed.push(join(home, rel)) } // entfernt gelöscht
      else if (op === 'rmRemote') { await must(await dav('DELETE', rel), `Löschen ${rel}`); gone.add(rel); res.deleted++ } // lokal gelöscht
      else gone.add(rel)
    }
    // ETags der hochgeladenen Dateien aus einer frischen Liste: manche Server liefern beim PUT keinen, andere ändern ihn
    // danach noch (X-OC-Mtime setzt die Zeit, rclone leitet den ETag daraus ab)
    if (uploaded.length) {
      remote.clear()
      madeDirs.clear()
      await listRemote('')
      for (const rel of uploaded) next[rel].etag = remote.get(rel)?.etag ?? next[rel].etag
    }
  } finally {
    // auch nach einem Abbruch (Netz weg): Erledigtes merken, Unerledigtes behält seinen alten Stand
    const files: State = { ...old, ...next }
    for (const rel of gone) delete files[rel]
    await writeFile(statePath, JSON.stringify({ base: `${s.user}@${base}`, files }))
  }
  return res
}

/** Verbindung prüfen, ohne etwas zu übertragen (Einstellungen → „Verbindung testen“) */
export async function testSync(s: SyncSettings, fetchFn: typeof fetch = fetch): Promise<void> {
  const base = davBase(s)
  const r = await fetchFn(base.replace(/Deckwerk\/$/, ''), { method: 'PROPFIND', headers: { Depth: '0', Authorization: `Basic ${btoa(unescape(encodeURIComponent(`${s.user}:${s.pass}`)))}` } })
  if (r.status === 401) throw new Error('Anmeldung abgelehnt. Nutzername und App-Passwort prüfen.')
  if (r.status !== 207 && !r.ok) throw new Error(`Server antwortet mit HTTP ${r.status}. Ist die WebDAV-Adresse richtig?`)
}

/** Kurzer Text für die Oberfläche */
export const syncSummary = (r: SyncResult) =>
  r.up + r.down + r.deleted === 0 ? 'Alles aktuell' : [r.up && `${r.up} hoch`, r.down && `${r.down} runter`, r.deleted && `${r.deleted} gelöscht`, r.conflicts && `${r.conflicts} Konflikt(e), ältere Fassung in versions/`].filter(Boolean).join(' · ')

export interface SyncStatus { url: string; user: string; hasPass: boolean; busy: boolean; at: number | null; text: string; error: boolean }

/** Läufe für eine App: nie zwei gleichzeitig (ein Wunsch während eines Laufs startet danach einen zweiten), later() entprellt */
export function createSyncer(home: string, settings: () => SyncSettings | null, onStatus: (s: SyncStatus) => void, onChanged: (files: string[]) => void, fetchFn: typeof fetch = fetch) {
  let busy = false, again = false, at: number | null = null, text = '', error = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const status = (): SyncStatus => {
    const s = settings()
    return { url: s?.url ?? '', user: s?.user ?? '', hasPass: !!s?.pass, busy, at, text, error }
  }
  async function run(): Promise<SyncStatus> {
    const s = settings()
    if (!s) return status()
    if (busy) { again = true; return status() }
    busy = true
    try {
      onStatus(status()) // im try: wirft er (Fenster zu), bliebe busy sonst für immer gesetzt
      const r = await sync(home, s, fetchFn)
      text = syncSummary(r)
      if (r.changed.length) onChanged(r.changed)
      error = false
    } catch (e) {
      text = e instanceof Error ? e.message.replace(/^Cloud-Sync: /, '') : String(e)
      error = true
    }
    at = Date.now()
    busy = false
    onStatus(status())
    if (again) { again = false; return run() }
    return status()
  }
  return {
    status,
    run,
    later(ms = 5000) { clearTimeout(timer); if (settings()) timer = setTimeout(() => void run(), ms) },
  }
}
