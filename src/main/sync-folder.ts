// Cloud-Sync über den Sync-Ordner einer Desktop-App (Dropbox, OneDrive, Google Drive, iCloud): file:-Adressen sprechen
// hier dieselbe WebDAV-Teilmenge, die sync.ts nutzt, direkt auf der Platte. So bleibt es bei einer einzigen Abgleich-Logik;
// das Hochladen in die Cloud übernimmt die App des Anbieters. Nur node:*, Selbsttest: scripts/check-sync.ts
import type { Stats } from 'node:fs'
import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFolder } from './sync'

const etag = (st: Stats) => `"${st.mtimeMs}-${st.size}"`
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const prop = (href: string, st: Stats) => `<d:response><d:href>${xml(href)}</d:href><d:propstat><d:prop>${st.isDirectory()
  ? '<d:resourcetype><d:collection/></d:resourcetype>'
  : `<d:resourcetype/><d:getetag>${etag(st)}</d:getetag><d:getcontentlength>${st.size}</d:getcontentlength>`
}<d:getlastmodified>${st.mtime.toUTCString()}</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`

// a ist b oder liegt darin; macOS und Windows unterscheiden Groß- und Kleinschreibung meist nicht
const norm = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase()).replace(/[\\/]+$/, '') + sep
const inside = (a: string, b: string) => norm(a).startsWith(norm(b))
// realpath des Pfads oder, wenn es ihn noch nicht gibt, des nächsten vorhandenen Elternordners
const real = async (p: string): Promise<string> => realpath(p).catch(() => (dirname(p) === p ? p : real(dirname(p))))

/** fetch für file:-URLs: PROPFIND (Depth 0/1), GET, PUT (atomar, X-OC-Mtime), DELETE, MKCOL mit den Statuscodes eines Servers.
 * home = Deckwerk-Ordner: jede Anfrage dorthin wird verweigert, auch wenn der Sync-Ordner erst später per Link darauf zeigt. */
export const folderFetchFor = (home: string): typeof fetch => async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  const file = fileURLToPath(url)
  if (inside(await real(file), await realpath(home).catch(() => home)))
    throw new Error('Cloud-Sync: Der Sync-Ordner führt in den Deckwerk-Ordner selbst. In den Einstellungen einen anderen Ordner wählen.')
  const method = (init?.method ?? 'GET').toUpperCase()
  const headers = new Headers(init?.headers)
  const status = (n: number, h?: Record<string, string>) => new Response(null, { status: n, headers: h })
  try {
    if (method === 'PROPFIND') {
      const st = await stat(file)
      const self = st.isDirectory() && !url.pathname.endsWith('/') ? `${url.pathname}/` : url.pathname
      const names = st.isDirectory() && headers.get('depth') !== '0' ? (await readdir(file)).sort() : []
      // iCloud lagert Dateien als .name.icloud aus; sync.ts sähe sie als entfernt gelöscht und löschte sie lokal
      if (names.some((n) => /^\..+\.icloud$/.test(n)))
        throw new Error('Cloud-Sync: iCloud hat Dateien im Ordner Deckwerk ausgelagert. Im Finder „Immer auf diesem Mac behalten“ einschalten.')
      // hrefs aus der angefragten URL bauen: dann passen sie zur Basis, die sync.ts daraus ableitet
      const kids = await Promise.all(names.map(async (n) => {
        const s = await stat(join(file, n)).catch(() => null) // kaputter Link, gerade gelöscht
        if (s?.isFile() && /^\..+\.[a-z0-9]+\.part$/.test(n) && Date.now() - s.mtimeMs > 3_600_000) { await rm(join(file, n), { force: true }); return '' } // Rest eines abgebrochenen PUT
        return s ? prop(`${self}${encodeURIComponent(n)}${s.isDirectory() ? '/' : ''}`, s) : ''
      }))
      return new Response(`<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${prop(self, st)}${kids.join('')}</d:multistatus>`,
        { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
    }
    if (method === 'GET') {
      const st = await stat(file)
      return st.isDirectory() ? status(405) : new Response(new Uint8Array(await readFile(file)), { status: 200, headers: { ETag: etag(st) } })
    }
    if (method === 'PUT') {
      const old = await stat(file).catch(() => null)
      if (old?.isDirectory()) return status(405)
      // atomar: die Cloud-App lädt nie eine halbe Datei hoch (Punktdateien überspringt sync.ts)
      const part = join(dirname(file), `.${basename(file)}.${Math.random().toString(36).slice(2)}.part`)
      const mtime = Number(headers.get('x-oc-mtime')) // wie Nextcloud: Bearbeitungszeit behalten, sonst gewinnt im Konflikt der letzte Upload
      try {
        await writeFile(part, new Uint8Array(await new Response(init?.body ?? null).arrayBuffer()))
        if (mtime > 0) await utimes(part, mtime, mtime)
        await rename(part, file)
      } catch (e) { await rm(part, { force: true }); throw e }
      return status(old ? 204 : 201, { ETag: etag(await stat(file)) })
    }
    if (method === 'DELETE') { await stat(file); await rm(file, { recursive: true }); return status(204) }
    if (method === 'MKCOL') { await mkdir(file); return status(201) }
    return status(405)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'EEXIST') return status(405) // MKCOL: gibt es schon
    if (code === 'ENOENT' || code === 'ENOTDIR') return status(method === 'PUT' || method === 'MKCOL' ? 409 : 404) // 409: Elternordner fehlt
    throw e
  }
}

/** file:-Adressen auf die Platte (nie in home), alles andere übers Netz */
export const syncFetchFor = (home: string): typeof fetch => {
  const folder = folderFetchFor(home)
  return (input, init) => isFolder(String(input instanceof Request ? input.url : input)) ? folder(input, init) : fetch(input, init)
}

/** Sync-Ordner prüfen: <dir>/Deckwerk darf weder der Deckwerk-Ordner (home) sein noch darin liegen noch ihn enthalten,
 * sonst spiegelt Deckwerk sich in sich selbst und löscht womöglich Dateien. Links per realpath aufgelöst. */
export async function checkSyncFolder(dir: string, home: string): Promise<void> {
  const bad = (why: string) => new Error(`Diesen Ordner kann Deckwerk nicht nutzen: ${why}`)
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw bad('Es gibt ihn nicht.')
  try { await access(dir, constants.W_OK) } catch { throw bad('Deckwerk darf dort nicht schreiben.') }
  const target = await realpath(join(dir, 'Deckwerk')).catch(async () => join(await realpath(dir), 'Deckwerk'))
  const own = await realpath(home).catch(() => home)
  if (inside(target, own) || inside(own, target)) throw bad('Darin läge der Deckwerk-Ordner selbst. Bitte den Ordner der Cloud-App wählen.')
}

/** Ersten vorhandenen Ordner zu einem Muster aus CLOUDS.folders: ~ = home, * = ein beliebiger Teil eines Namens; G:/… nur unter Windows */
export async function findFolder(pattern: string, home = homedir()): Promise<string | null> {
  if (/^[a-z]:\//i.test(pattern) && process.platform !== 'win32') return null
  const [head, ...parts] = pattern.split('/')
  let paths = [head === '~' ? home : `${head}/`]
  for (const part of parts) {
    if (!part.includes('*')) { paths = paths.map((p) => join(p, part)); continue }
    const re = new RegExp(`^${part.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
    paths = (await Promise.all(paths.map(async (p) => (await readdir(p).catch(() => [] as string[])).filter((n) => re.test(n)).sort().map((n) => join(p, n))))).flat()
  }
  for (const p of paths) if ((await stat(p).catch(() => null))?.isDirectory()) return p
  return null
}
