// Gemeinsam bearbeiten (Canva „Teilen“): der Deck-Ordner in der Nextcloud des Besitzers, per öffentlichem Link geteilt
// (OCS-Share-API). Jede App, die das Deck offen hat, fragt den Ordner alle paar Sekunden ab (createLive). Fremde Stände
// führt der Renderer dreiseitig zusammen (src/shared/merge3.ts), geschrieben wird nur mit If-Match auf den bekannten Stand.
// So gibt es keinen Server, und keine Änderung geht verloren. Der normale Sync lässt geteilte Ordner in Ruhe (SHARED_MARKER).
// Electron-frei wie sync.ts. Selbsttests: scripts/check-merge3.ts (Zusammenführen), scripts/check-sync.ts 3d (Sync lässt geteilte Ordner in Ruhe)
import { APP } from '../shared/app-id'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Deck } from '../shared/deck'
import { canonJson, isAssetRel, portableDeck, portablePath, sanitize } from '../shared/merge3'
import { davBase, etagOf, localAsset, parseMultistatus, SHARED_MARKER, type SyncSettings } from './sync'

export type Rolle = 'edit' | 'view'
/** Inhalt eines Links: Server-Wurzel, Share-Token, Passwort (nur bei Passwortpflicht), Rolle, Titel */
export interface Zugang { s: string; t: string; p?: string; r: Rolle; n: string }
/** WebDAV-Ordner des geteilten Decks (mit Schlussstrich) und die Kopfzeilen für jede Anfrage */
export interface Remote { base: string; headers: Record<string, string> }
export interface Freigabe { id: string; token: string; rolle: Rolle; ablauf: string | null; link: string | null }
export interface Anwesend { id: string; name: string; folie: string | null }
export interface LiveStatus { zustand: 'live' | 'offline' | 'beendet'; rolle: Rolle; text: string }

const SITE = 'https://bavarianator.github.io/deckwerk/teilen/'
export const BASIS = '.mitarbeit-basis.json' // letzter gemeinsamer Stand {etag, text}; Punktdatei, der normale Sync lässt sie aus
const PRESENCE = /^\.anwesend-([\w-]{4,40})\.json$/
const TTL = 150_000 // so lange gilt ein Puls (Puls alle 60 s)

const basic = (user: string, pass: string) => `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${pass}`)))}`
const timeout = (ms: number) => (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(Math.round(ms)) : undefined)
const b64u = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64u = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))

// ---------- Links ----------

/** Link für die Website (website/src/pages/teilen.astro): Zugangsdaten nur im #-Teil, der nie an den Webserver geht */
// a=pro: die Website öffnet den Link per deckwerk-pro:// in Deckwerk Pro statt in Deckwerk
export const linkOf = (z: Zugang) => `${SITE}#d=${b64u(JSON.stringify({ v: 1, ...z }))}${APP.pro ? '&a=pro' : ''}`

/** Website-Link, deckwerk://teilen?d=… oder der rohe Nextcloud-Link …/s/TOKEN (Rolle dann „edit“, ein 403 stuft herunter) */
export function parseLink(text: string): Zugang | null {
  const t = text.trim()
  const d = t.match(/[#?&]d=([A-Za-z0-9_-]+)/)?.[1]
  if (d) {
    try {
      const j = JSON.parse(unb64u(d))
      if (j?.v !== 1 || typeof j.s !== 'string' || !/^https?:\/\/[^/]/.test(j.s) || typeof j.t !== 'string' || !/^[A-Za-z0-9]+$/.test(j.t)) return null
      return { s: j.s.replace(/\/+$/, ''), t: j.t, p: typeof j.p === 'string' && j.p ? j.p : undefined, r: j.r === 'view' ? 'view' : 'edit', n: typeof j.n === 'string' ? j.n.slice(0, 200) : '' }
    } catch { return null }
  }
  const m = t.match(/^(https?:\/\/[^\s#?]+?)\/(?:index\.php\/)?s\/([A-Za-z0-9]+)\/?(?:[?#].*)?$/)
  return m ? { s: m[1], t: m[2], r: 'edit', n: '' } : null
}

// ---------- Nextcloud: Freigaben des Besitzers ----------

/** Server-Wurzel und Nutzerpfad aus dem Sync-Zugang: …/remote.php/webdav/<pfad> oder …/remote.php/dav/files/<nutzer>/<pfad> */
export function serverOf(cfg: SyncSettings): { root: string; path: string } {
  const u = new URL(davBase(cfg))
  const m = u.pathname.match(/^(.*?)\/remote\.php\/(?:webdav|dav\/files\/[^/]+)(\/.*)$/)
  if (!m) throw new Error('Teilen per Link geht nur, wenn der Cloud-Sync mit Nextcloud oder MagentaCLOUD verbunden ist.')
  return { root: u.origin + m[1], path: decodeURIComponent(m[2]) }
}

/** WebDAV-Ordner eines eigenen Decks (Name des Ordners unter ~/Deckwerk) */
export const ownerRemote = (cfg: SyncSettings, dirName: string): Remote =>
  ({ base: `${davBase(cfg)}${encodeURIComponent(dirName)}/`, headers: { Authorization: basic(cfg.user, cfg.pass) } })

async function ocs(cfg: SyncSettings, method: string, rest: string, body: Record<string, string> | null, fetchFn: typeof fetch) {
  const { root } = serverOf(cfg)
  const r = await fetchFn(`${root}/ocs/v2.php/${rest}${rest.includes('?') ? '&' : '?'}format=json`, {
    method,
    headers: { Authorization: basic(cfg.user, cfg.pass), 'OCS-APIRequest': 'true', Accept: 'application/json', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? new URLSearchParams(body).toString() : undefined,
    signal: timeout(30_000),
  }).catch((e) => { throw (e as Error)?.name === 'TimeoutError' ? new Error('Teilen: Die Nextcloud antwortet nicht.') : e })
  const j = await r.json().catch(() => null) as { ocs?: { meta?: { message?: string }; data?: any } } | null
  if (r.status === 401) throw new Error('Teilen: Anmeldung abgelehnt. Cloud in den Einstellungen neu verbinden.')
  if (!r.ok || !j?.ocs) throw new Error(`Teilen: ${j?.ocs?.meta?.message || `Die Nextcloud antwortet mit HTTP ${r.status}.`}`)
  return j.ocs.data
}

export interface Caps { passwort: boolean; tage: number | null; bearbeiten: boolean }
export async function caps(cfg: SyncSettings, fetchFn: typeof fetch = fetch): Promise<Caps> {
  const pub = (await ocs(cfg, 'GET', 'cloud/capabilities', null, fetchFn))?.capabilities?.files_sharing?.public
  if (!pub?.enabled) throw new Error('Öffentliche Links sind auf dieser Nextcloud ausgeschaltet. Das kann nur die Verwaltung der Cloud ändern.')
  const tage = pub.expire_date?.enforced && Number(pub.expire_date.days) > 0 ? Number(pub.expire_date.days) : null
  return { passwort: !!pub.password?.enforced, tage, bearbeiten: pub.upload !== false }
}

const rolleOf = (perm: number): Rolle => (perm & 2 ? 'edit' : 'view')
const PERM: Record<Rolle, string> = { edit: '15', view: '1' } // lesen+ändern+anlegen+löschen bzw. nur lesen
const dateOf = (x: unknown) => (typeof x === 'string' && x ? x.slice(0, 10) : null)
const sharePath = (cfg: SyncSettings, dirName: string) => `${serverOf(cfg).path}${dirName}`

// 24 Zeichen aus allen vier Klassen: Passwort-Richtlinien der Nextcloud verlangen das oft
function passwort(): string {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '-_.!+*']
  const all = sets.join(''), rnd = crypto.getRandomValues(new Uint32Array(24))
  const out = [...rnd].map((n, i) => (i < 4 ? sets[i][n % sets[i].length] : all[n % all.length]))
  for (let i = out.length - 1; i > 0; i--) { const j = rnd[i] % (i + 1); [out[i], out[j]] = [out[j], out[i]] }
  return out.join('')
}

/** Links des Deck-Ordners; link nur, wenn kein Passwort nötig ist oder es in pw(token) bekannt ist */
export async function freigaben(cfg: SyncSettings, dirName: string, titel: string, pw: (token: string) => string | undefined, fetchFn: typeof fetch = fetch): Promise<Freigabe[]> {
  const data = await ocs(cfg, 'GET', `apps/files_sharing/api/v1/shares?path=${encodeURIComponent(sharePath(cfg, dirName))}&reshares=false`, null, fetchFn)
  const { root } = serverOf(cfg)
  return (Array.isArray(data) ? data : []).filter((x) => Number(x.share_type) === 3).map((x) => {
    const rolle = rolleOf(Number(x.permissions)), p = x.password ? pw(String(x.token)) : undefined
    return { id: String(x.id), token: String(x.token), rolle, ablauf: dateOf(x.expiration), link: x.password && !p ? null : linkOf({ s: root, t: String(x.token), p, r: rolle, n: titel }) }
  })
}

/** neuer Link auf den Deck-Ordner. ablauf: JJJJ-MM-TT oder null; bei Pflicht höchstens so viele Tage wie erlaubt */
export async function freigeben(cfg: SyncSettings, dirName: string, titel: string, rolle: Rolle, ablauf: string | null, fetchFn: typeof fetch = fetch): Promise<Freigabe & { passwort?: string }> {
  const c = await caps(cfg, fetchFn)
  if (rolle === 'edit' && !c.bearbeiten) throw new Error('Bearbeiten-Links sind auf dieser Nextcloud ausgeschaltet (öffentliches Hochladen). „Kann ansehen“ geht.')
  const p = c.passwort ? passwort() : undefined
  const max = c.tage ? new Date(Date.now() + c.tage * 86_400_000).toISOString().slice(0, 10) : null
  const bis = max && (!ablauf || ablauf > max) ? max : ablauf
  const body: Record<string, string> = { path: sharePath(cfg, dirName), shareType: '3', permissions: PERM[rolle], publicUpload: String(rolle === 'edit'), label: 'Deckwerk' }
  if (p) body.password = p
  if (bis) body.expireDate = bis
  let x = await ocs(cfg, 'POST', 'apps/files_sharing/api/v1/shares', body, fetchFn)
  // ältere Nextclouds übergehen permissions beim Anlegen: nachziehen und prüfen
  if (String(x.permissions) !== PERM[rolle]) x = await ocs(cfg, 'PUT', `apps/files_sharing/api/v1/shares/${x.id}`, { permissions: PERM[rolle] }, fetchFn)
  if (rolleOf(Number(x.permissions)) !== rolle) throw new Error('Teilen: Die Nextcloud hat die Rechte des Links nicht übernommen.')
  const { root } = serverOf(cfg)
  return { id: String(x.id), token: String(x.token), rolle, ablauf: dateOf(x.expiration), link: linkOf({ s: root, t: String(x.token), p, r: rolle, n: titel }), passwort: p }
}

export async function freigabeAendern(cfg: SyncSettings, id: string, p: { rolle?: Rolle; ablauf?: string | null }, fetchFn: typeof fetch = fetch): Promise<void> {
  if (p.rolle) await ocs(cfg, 'PUT', `apps/files_sharing/api/v1/shares/${encodeURIComponent(id)}`, { permissions: PERM[p.rolle] }, fetchFn)
  if (p.ablauf !== undefined) await ocs(cfg, 'PUT', `apps/files_sharing/api/v1/shares/${encodeURIComponent(id)}`, { expireDate: p.ablauf ?? '' }, fetchFn)
}

export const freigabeBeenden = (cfg: SyncSettings, id: string, fetchFn: typeof fetch = fetch) =>
  ocs(cfg, 'DELETE', `apps/files_sharing/api/v1/shares/${encodeURIComponent(id)}`, null, fetchFn).then(() => {})

// ---------- WebDAV des geteilten Ordners ----------

const PROPS = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>'
const enc = (rel: string) => rel.split('/').map(encodeURIComponent).join('/')

function davOf(remote: Remote, fetchFn: typeof fetch) {
  return async (method: string, rel: string, init: { body?: Uint8Array | string; headers?: Record<string, string> } = {}) =>
    fetchFn(remote.base + enc(rel), { method, body: init.body as BodyInit | undefined, headers: { ...remote.headers, ...init.headers }, signal: timeout(60_000 + (init.body?.length ?? 0) / 50) })
}

/** Inhalt des Ordners (eine Ebene): Dateien mit ETag/Größe/Zeit, dazu die Serverzeit (Anwesenheit ohne Uhrabweichung) */
async function list(remote: Remote, rel: string, fetchFn: typeof fetch) {
  const r = await davOf(remote, fetchFn)('PROPFIND', rel ? `${rel}/` : '', { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROPS })
  if (r.status !== 207) return { status: r.status, files: new Map<string, { etag: string; mtime: number; size: number }>(), now: Date.now() }
  const basePath = decodeURIComponent(new URL(remote.base).pathname) + (rel ? `${rel}/` : '')
  const files = new Map<string, { etag: string; mtime: number; size: number }>()
  for (const e of parseMultistatus(await r.text(), basePath)) if (e.rel && !e.dir) files.set(e.rel, e.remote)
  return { status: 207, files, now: Date.parse(r.headers.get('date') ?? '') || Date.now() }
}

/** Gast: öffentliches WebDAV des Links. Neuer Endpunkt (Nextcloud ≥ 29) zuerst, sonst der alte; Passwort per Basic-Auth */
export async function guestRemote(z: Zugang, fetchFn: typeof fetch = fetch): Promise<Remote> {
  const xr = { 'X-Requested-With': 'XMLHttpRequest' } // sonst leitet Nextcloud passwortgeschützte Links auf die Passwortseite um
  const tries: Remote[] = [
    { base: `${z.s}/public.php/dav/files/${z.t}/`, headers: { ...xr, ...(z.p ? { Authorization: basic('anonymous', z.p) } : {}) } },
    { base: `${z.s}/public.php/dav/files/${z.t}/`, headers: { ...xr, Authorization: basic(z.t, z.p ?? '') } },
    { base: `${z.s}/public.php/webdav/`, headers: { ...xr, Authorization: basic(z.t, z.p ?? '') } },
  ]
  let last = 0
  for (const remote of tries) {
    const r = await fetchFn(remote.base, { method: 'PROPFIND', headers: { ...remote.headers, Depth: '0' }, signal: timeout(30_000) }).catch(() => null)
    if (r?.status === 207) return remote
    last = r?.status ?? 0
  }
  throw new Error(last === 0 ? 'Die Cloud ist nicht erreichbar. Internetverbindung prüfen.'
    : last === 404 || last === 401 || last === 403 ? 'Diese Freigabe gibt es nicht mehr, oder das Passwort stimmt nicht. Bitte um einen neuen Link.'
    : `Die Cloud antwortet mit HTTP ${last}.`)
}

// ---------- Bilder ----------

// alle Dateiverweise eines Decks: asset://-URLs (lokal) bzw. relative assets/<name> (fremd, nach sanitize)
function refs(x: unknown, out = new Set<string>()): Set<string> {
  if (typeof x === 'string') { if (/^asset:\/\/local\//i.test(x) || isAssetRel(x)) out.add(x) }
  else if (x && typeof x === 'object') for (const v of Object.values(x)) refs(v, out)
  return out
}
const fileOf = (url: string) => localAsset(fileURLToPath(`file://${new URL(url).pathname}`))

async function writeAtomic(file: string, data: Uint8Array | string) {
  await mkdir(dirname(file), { recursive: true })
  const part = join(dirname(file), `.${basename(file)}.part`)
  await writeFile(part, data)
  await rename(part, file)
}

/** fehlende Bilder eines fremden Stands holen (Namen sind nach sanitize sicher: assets/<name>) */
async function pullAssets(remote: Remote, dir: string, deck: Deck, fetchFn: typeof fetch) {
  const dav = davOf(remote, fetchFn)
  for (const rel of refs(deck)) {
    if (!rel.startsWith('assets/') || existsSync(join(dir, rel))) continue
    const r = await dav('GET', rel)
    if (r.ok) await writeAtomic(join(dir, rel), new Uint8Array(await r.arrayBuffer())) // fehlt es entfernt noch, kommt es beim nächsten Takt
  }
}

/** eigene Bilder in den Deck-Ordner kopieren (assets/<name> wie portablePath) und hochladen, was dort fehlt */
async function pushAssets(remote: Remote, dir: string, deck: Deck, fetchFn: typeof fetch) {
  const wanted = new Map<string, string>() // rel → Quelle
  for (const url of refs(deck)) if (url.startsWith('asset:')) wanted.set(portablePath(url, dir), fileOf(url))
  if (!wanted.size) return
  const dav = davOf(remote, fetchFn)
  let have = (await list(remote, 'assets', fetchFn))
  if (have.status === 404) { const m = await dav('MKCOL', 'assets/'); if (!m.ok && m.status !== 405) throw new Error(`Bilder-Ordner anlegen fehlgeschlagen (HTTP ${m.status})`); have = { ...have, files: new Map() } }
  for (const [rel, src] of wanted) {
    const local = join(dir, rel)
    if (!existsSync(local)) { if (!existsSync(src)) continue; await mkdir(dirname(local), { recursive: true }); await copyFile(src, local) }
    if (have.files.has(rel.slice('assets/'.length))) continue
    const r = await dav('PUT', rel, { body: new Uint8Array(await readFile(local)) })
    if (!r.ok) throw new Error(`Bild hochladen fehlgeschlagen (HTTP ${r.status})`)
  }
}

// ---------- Basis ----------

export async function readBasis(dir: string): Promise<{ etag: string; text: string } | null> {
  try { const b = JSON.parse(await readFile(join(dir, BASIS), 'utf8')); return typeof b?.text === 'string' ? { etag: String(b.etag ?? ''), text: b.text } : null } catch { return null }
}
export const writeBasis = (dir: string, b: { etag: string; text: string }) => writeAtomic(join(dir, BASIS), JSON.stringify(b))

// ---------- Beitreten (Gast) ----------

/** Link öffnen: Inhalt holen, prüfen, als eigenen Ordner ablegen (dirFor legt ihn an), Basis schreiben. Gibt deck.json zurück */
export async function beitreten(z: Zugang, remote: Remote, dirFor: (titel: string) => string, fetchFn: typeof fetch = fetch): Promise<{ file: string; titel: string }> {
  const dav = davOf(remote, fetchFn)
  const r = await dav('GET', 'deck.json')
  if (r.status === 404) throw new Error('In dieser Freigabe liegt kein Deckwerk-Deck.')
  if (!r.ok) throw new Error(`Das Deck ließ sich nicht laden (HTTP ${r.status}).`)
  const text = await r.text()
  const deck = sanitize(JSON.parse(text))
  const titel = z.n || deck.title || 'Geteiltes Deck'
  const dir = dirFor(titel)
  await pullAssets(remote, dir, deck, fetchFn)
  const m = await dav('GET', SHARED_MARKER)
  await writeAtomic(join(dir, SHARED_MARKER), m.ok ? await m.text() : JSON.stringify({ v: 1, titel }))
  await writeAtomic(join(dir, 'deck.json'), JSON.stringify(deck, null, 2)) // relative Bildpfade, readDeck löst sie auf
  await writeBasis(dir, { etag: etagOf(r.headers.get('etag')), text })
  return { file: join(dir, 'deck.json'), titel }
}

// ---------- Teilen beginnen und beenden (Besitzer) ----------

/** Ordner als geteilt markieren (lokal und in der Cloud) und den aktuellen Stand hochladen; ab jetzt schreibt nur noch Live */
export async function teilenBeginnen(remote: Remote, dir: string, deck: Deck, fetchFn: typeof fetch = fetch): Promise<void> {
  const dav = davOf(remote, fetchFn)
  const marker = JSON.stringify({ v: 1, titel: deck.title })
  await writeAtomic(join(dir, SHARED_MARKER), marker) // zuerst: der normale Sync lädt danach nichts mehr hoch
  // Ordner anlegen, falls der Sync noch nie lief (MKCOL auf Deckwerk/ und den Deck-Ordner; 405 = gibt es schon)
  for (const u of [remote.base.replace(/[^/]+\/$/, ''), remote.base]) {
    const m = await fetchFn(u, { method: 'MKCOL', headers: remote.headers, signal: timeout(30_000) })
    if (!m.ok && m.status !== 405) throw new Error(`Teilen: Ordner in der Cloud anlegen fehlgeschlagen (HTTP ${m.status}).`)
  }
  const put = await dav('PUT', SHARED_MARKER, { body: marker })
  if (!put.ok) throw new Error(`Teilen: Hochladen fehlgeschlagen (HTTP ${put.status}).`)
  await pushAssets(remote, dir, deck, fetchFn)
  const head = (await list(remote, '', fetchFn)).files.get('deck.json')
  const text = JSON.stringify(portableDeck(deck, dir), null, 2)
  const r = await dav('PUT', 'deck.json', { body: text, headers: head ? { 'If-Match': `"${head.etag}"` } : { 'If-None-Match': '*' } })
  if (!r.ok) throw new Error(`Teilen: Hochladen fehlgeschlagen (HTTP ${r.status}). Bitte noch einmal versuchen.`)
  await writeBasis(dir, { etag: etagOf(r.headers.get('etag')), text })
}

/** keine Links mehr: Markierung weg (lokal und in der Cloud), danach gleicht der normale Sync den Ordner wieder ab */
export async function teilenEnden(remote: Remote | null, dir: string, fetchFn: typeof fetch = fetch): Promise<void> {
  if (remote) await davOf(remote, fetchFn)('DELETE', SHARED_MARKER).catch(() => {})
  await rm(join(dir, SHARED_MARKER), { force: true })
  await rm(join(dir, BASIS), { force: true })
}

export const isShared = (dir: string) => existsSync(join(dir, SHARED_MARKER))

// ---------- Live-Abgleich ----------

export interface LiveOpts {
  dir: string
  remote: Remote
  rolle: Rolle
  ich: { id: string; name: string }
  /** aktueller Stand in Main (gleich dem des Renderers, deck:set) */
  getDeck: () => Deck | null
  /** fremder Stand (Bildpfade relativ wie in der Cloud): der Renderer führt zusammen und bestätigt mit ack(etag).
   * ohneBasis: kein gemeinsamer Stand bekannt (weiteres Gerät), base ist dann der eigene Stand und die Cloud gewinnt */
  onRemote: (r: { base: Deck; theirs: Deck; etag: string; ohneBasis: boolean }) => void
  onPresence: (p: Anwesend[]) => void
  onStatus: (s: LiveStatus) => void
  /** Fenster im Vordergrund: dann alle 3 s, sonst alle 15 s */
  fokus?: () => boolean
  fetchFn?: typeof fetch
}

/** Abgleich des offenen geteilten Decks. Ein Takt: Ordner lesen → Fremdes an den Renderer → (nach ack) Eigenes hochladen → Puls.
 * Hochgeladen wird nur, wenn der eigene Stand vom gemeinsamen abweicht und kein fremder Stand auf Bestätigung wartet.
 * ponytail: If-Match ist in Nextcloud kein atomares Vergleichen-und-Schreiben; zwei PUTs im selben Augenblick können
 * einander überschreiben (sehr selten, meist kommt 423). Abhilfe wäre ein Eltern-Hash in der Datei. */
export function createLive(o: LiveOpts) {
  const fetchFn = o.fetchFn ?? fetch
  const dav = davOf(o.remote, fetchFn)
  let rolle = o.rolle, stopped = false, ended = false, busy = false, again = false, fails = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let basis: { etag: string; text: string } | null = null
  let basisDeck: Deck | null = null
  let pending: { etag: string; text: string; theirs: Deck; base: Deck; ohneBasis: boolean } | null = null // wartet auf ack
  let folie: string | null = null, pulsAt = 0, pulsFolie: string | null | undefined
  const seen = new Map<string, { etag: string; a: Anwesend }>()
  const status = (zustand: LiveStatus['zustand'], text: string) => o.onStatus({ zustand, rolle, text })
  const loaded = readBasis(o.dir).then((b) => { basis = b; basisDeck = b ? own(b.text) : null })

  // fremder Stand: geprüft (sanitize). Die Basis dagegen nur als Vergleich und Merge-Basis (merge3 übernimmt nie Werte der Basis),
  // ungeprüft, sonst sähe ein von sanitize geleertes eigenes Feld nach jedem Hochladen wieder geändert aus
  function parse(text: string): Deck | null { try { return sanitize(JSON.parse(text)) } catch { return null } }
  function own(text: string): Deck | null { try { const d = JSON.parse(text); return Array.isArray(d?.slides) ? d : null } catch { return null } }
  function schedule(ms?: number) {
    clearTimeout(timer)
    if (stopped || ended) return
    timer = setTimeout(() => void run(), ms ?? Math.min(30_000, (o.fokus?.() === false ? 15_000 : 3_000) * 2 ** fails))
  }
  async function run() {
    if (busy) { again = true; return }
    busy = true
    try { await loaded; await tick(); fails = 0 }
    catch (e) {
      fails = Math.min(fails + 1, 4)
      status('offline', (e as Error)?.name === 'TimeoutError' || e instanceof TypeError ? 'Offline – deine Änderungen werden nachgereicht' : e instanceof Error ? e.message : String(e))
    }
    busy = false
    if (again) { again = false; return run() }
    schedule()
  }

  async function tick() {
    if (stopped || ended) return
    const l = await list(o.remote, '', fetchFn)
    if (l.status === 401 || l.status === 403 || l.status === 404) { ended = true; status('beendet', 'Die Freigabe wurde beendet. Deine Kopie bleibt erhalten.'); return }
    if (l.status !== 207) throw new Error(`Die Cloud antwortet mit HTTP ${l.status}.`)
    await presence(l.files, l.now)
    const head = l.files.get('deck.json')
    // 1) fremder Stand
    if (head && head.etag !== basis?.etag && head.etag !== pending?.etag) {
      const r = await dav('GET', 'deck.json')
      if (!r.ok) throw new Error(`Das Deck ließ sich nicht laden (HTTP ${r.status}).`)
      const text = await r.text(), theirs = parse(text)
      if (!theirs) throw new Error('Die geteilte deck.json ist beschädigt. Deine Fassung bleibt, bis jemand speichert.')
      const etag = etagOf(r.headers.get('etag')) || head.etag
      if (basis && etag === basis.etag) return status('live', 'Live') // seit dem PROPFIND wieder auf unserem Stand
      await pullAssets(o.remote, o.dir, theirs, fetchFn)
      // ohne Basis (weiteres Gerät, alte Kopie): die eigene Fassung als Basis, damit gewinnt der Stand der Cloud; die eigene sichert gemeinsam.ts
      pending = { etag, text, theirs, base: basisDeck ?? o.getDeck() ?? theirs, ohneBasis: !basisDeck }
    }
    if (pending) { // bis zur Bestätigung bei jedem Takt erneut: der Renderer stellt zurück, solange jemand tippt
      o.onRemote({ base: pending.base, theirs: pending.theirs, etag: pending.etag, ohneBasis: pending.ohneBasis })
      return status('live', 'Neue Änderungen der anderen')
    }
    // 2) eigener Stand
    const deck = o.getDeck()
    if (rolle === 'edit' && deck && basisDeck && canonJson(deck, o.dir) !== canonJson(basisDeck, o.dir)) await push(deck)
    else if (rolle === 'edit' && deck && !head) await push(deck) // Ordner leer (z. B. Datei gelöscht): eigenen Stand wieder hinlegen
    await puls(deck)
    status('live', 'Live')
  }

  async function push(deck: Deck) {
    await pushAssets(o.remote, o.dir, deck, fetchFn)
    const text = JSON.stringify(portableDeck(deck, o.dir), null, 2)
    const r = await dav('PUT', 'deck.json', { body: text, headers: basis?.etag ? { 'If-Match': `"${basis.etag}"` } : { 'If-None-Match': '*' } })
    if (r.status === 412 || r.status === 423) { again = true; return } // jemand war schneller: neu lesen, zusammenführen, dann erneut
    if (r.status === 403 || r.status === 401) { rolle = 'view'; status('live', 'Nur ansehen: Diese Freigabe erlaubt keine Änderungen.'); return }
    if (!r.ok) throw new Error(`Speichern in der Cloud fehlgeschlagen (HTTP ${r.status}).`)
    // ohne ETag in der Antwort bleibt die Basis leer: der nächste Takt holt die eigene Fassung, das Zusammenführen ist dann trivial
    basis = { etag: etagOf(r.headers.get('etag')), text }
    basisDeck = own(text)
    await writeBasis(o.dir, basis)
  }

  // Anwesenheit: eine Punktdatei je Teilnehmer, die die Nextcloud-Oberfläche nicht zeigt. Alter nach Serverzeit
  async function presence(files: Map<string, { etag: string; mtime: number }>, now: number) {
    const out: Anwesend[] = []
    for (const [rel, f] of files) {
      const id = rel.match(PRESENCE)?.[1]
      if (!id || id === o.ich.id || now - f.mtime > TTL) continue
      let s = seen.get(id)
      if (s?.etag !== f.etag) {
        const r = await dav('GET', rel)
        const j = r.ok ? await r.json().catch(() => null) : null
        if (!j) continue
        s = { etag: f.etag, a: { id, name: String(j.name ?? '').slice(0, 60) || 'Jemand', folie: typeof j.folie === 'string' ? j.folie : null } }
        seen.set(id, s)
      }
      out.push(s.a)
    }
    o.onPresence(out)
  }
  async function puls(deck: Deck | null) {
    if (rolle !== 'edit' || !deck) return
    const now = Date.now()
    if (now - pulsAt < 60_000 && (pulsFolie === folie || now - pulsAt < 5_000)) return
    const r = await dav('PUT', `.anwesend-${o.ich.id}.json`, { body: JSON.stringify({ name: o.ich.name, folie }) })
    if (r.ok) { pulsAt = now; pulsFolie = folie }
  }

  schedule(0)
  return {
    /** nach dem Speichern: gleich abgleichen statt erst beim nächsten Takt */
    kick() { if (!busy) schedule(300); else again = true },
    /** der Renderer hat den fremden Stand übernommen (und Main hat deck.json geschrieben): er ist jetzt die Basis */
    async ack(etag: string) {
      if (!pending || pending.etag !== etag) return
      basis = { etag, text: pending.text }
      basisDeck = pending.theirs
      pending = null
      await writeBasis(o.dir, basis)
      schedule(300)
    },
    folie(id: string | null) { if (id !== folie) { folie = id; schedule(300) } },
    rolle: () => rolle,
    async stop() {
      stopped = true
      clearTimeout(timer)
      if (rolle === 'edit' && !ended) await dav('DELETE', `.anwesend-${o.ich.id}.json`).catch(() => {})
    },
  }
}

/** Ordnername eines Decks unter home (geteilt wird immer der ganze Ordner) */
export function deckDirName(file: string, home: string): string | null {
  const dir = dirname(resolve(file))
  return dirname(dir) === resolve(home) && !dir.endsWith(sep) ? basename(dir) : null
}
