// Cloud-Sync gegen einen Mini-WebDAV-Server im Speicher: npx esbuild scripts/check-sync.ts --bundle --platform=node --format=esm --outfile=out/check-sync.mjs && node out/check-sync.mjs
import { deepStrictEqual as eq, ok } from 'node:assert'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { davBase, localAsset, sync, testSync } from '../src/main/sync'

// Server: Dateien unter /remote.php/dav/files/anna/…, ETag = Zähler, kein ETag bei PUT auf *.png (Fallback testen)
const files = new Map<string, { body: Buffer; etag: string; mtime: number }>()
const dirs = new Set<string>(['/remote.php/dav/files/anna'])
let n = 0
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Basic ${Buffer.from('anna:geheim').toString('base64')}`) { res.writeHead(401).end(); return }
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const p = decodeURIComponent(new URL(req.url!, 'http://x').pathname).replace(/\/$/, '')
  if (req.method === 'PROPFIND') {
    if (!dirs.has(p)) { res.writeHead(404).end(); return }
    const kids = req.headers.depth === '0' ? [] : [...dirs].filter((d) => d.startsWith(p + '/') && !d.slice(p.length + 1).includes('/')).map((d) => `<d:response><d:href>${encodeURI(d)}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection xmlns:d="DAV:"/></d:resourcetype></d:prop></d:propstat></d:response>`)
      .concat([...files].filter(([f]) => f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/')).map(([f, v]) => `<d:response><d:href>${encodeURI(f).replace(/%26/g, '&amp;')}</d:href><d:propstat><d:prop><d:getetag>&quot;${v.etag}&quot;</d:getetag><d:getcontentlength>${v.body.length}</d:getcontentlength><d:getlastmodified>${new Date(v.mtime).toUTCString()}</d:getlastmodified><d:resourcetype/></d:prop></d:propstat></d:response>`))
    res.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${encodeURI(p)}/</d:href></d:response>${kids.join('')}</d:multistatus>`)
  } else if (req.method === 'MKCOL') { if (dirs.has(p)) res.writeHead(405).end(); else { dirs.add(p); res.writeHead(201).end() } }
  else if (req.method === 'PUT') {
    const etag = String(++n)
    files.set(p, { body: Buffer.concat(chunks), etag, mtime: Date.now() })
    res.writeHead(201, p.endsWith('.png') ? {} : { ETag: p.endsWith('.json') ? `W/"${etag}"` : `"${etag}"` }).end()
  } else if (req.method === 'GET') { const f = files.get(p); if (f) res.writeHead(200).end(f.body); else res.writeHead(404).end() }
  else if (req.method === 'DELETE') { files.delete(p); res.writeHead(204).end() }
  else res.writeHead(405).end()
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const s = { url, user: 'anna', pass: 'geheim' }

eq(davBase({ url: 'cloud.example.org', user: 'a b' }), 'https://cloud.example.org/remote.php/dav/files/a%20b/Deckwerk/')
eq(davBase({ url: 'https://dav.box.com/dav', user: 'x' }), 'https://dav.box.com/dav/Deckwerk/')
await testSync(s)
await testSync({ ...s, pass: 'falsch' }).then(() => ok(false, 'falsches Passwort angenommen'), (e) => ok(/abgelehnt/.test(e.message)))

const root = mkdtempSync(join(tmpdir(), 'dw-sync-'))
const A = join(root, 'pc'), B = join(root, 'handy')
const put = (home: string, rel: string, text: string) => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), text) }
const get = (home: string, rel: string) => readFileSync(join(home, rel), 'utf8')
const older = (home: string, rel: string) => utimesSync(join(home, rel), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000))

// 1) PC lädt hoch (Versionen bleiben lokal), Handy lädt herunter
put(A, 'pitch/deck.json', '{"v":1}'); put(A, 'pitch/versions/alt.json', 'x'); put(A, 'assets/foto.png', 'PNG'); put(A, '.setup-done', '')
eq(await sync(A, s), { up: 2, down: 0, deleted: 0, conflicts: 0, changed: [] })
ok(!files.has('/remote.php/dav/files/anna/Deckwerk/pitch/versions/alt.json'))
eq((await sync(B, s)).changed.sort(), [join(B, "assets/foto.png"), join(B, "pitch/deck.json")])
eq(get(B, 'pitch/deck.json'), '{"v":1}')
eq(await sync(A, s), { up: 0, down: 0, deleted: 0, conflicts: 0, changed: [] }) // ETag-Fallback für foto.png greift

// 2) Handy ändert, PC holt ab
put(B, 'pitch/deck.json', '{"v":22}')
eq((await sync(B, s)).up, 1)
eq((await sync(A, s)).down, 1)
eq(get(A, 'pitch/deck.json'), '{"v":22}')

// 3) Konflikt: beide ändern, Handy ist neuer → PC bekommt Handy-Fassung, eigene landet in versions/
put(A, 'pitch/deck.json', '{"v":"pc"}'); older(A, 'pitch/deck.json')
put(B, 'pitch/deck.json', '{"v":"handy"}')
await sync(B, s)
eq((await sync(A, s)).conflicts, 1)
eq(get(A, 'pitch/deck.json'), '{"v":"handy"}')
ok(readdirSync(join(A, 'pitch/versions')).some((f) => f.endsWith('-lokal.json') && get(A, `pitch/versions/${f}`) === '{"v":"pc"}'))

// 3b) neues Gerät mit gleich großer, aber anderer deck.json: Inhaltsvergleich → Konflikt, keine Fassung geht verloren
const C = join(root, 'tablet')
put(C, 'pitch/deck.json', '{"v":"hendy"}')
eq((await sync(C, s)).conflicts, 1)
ok(readdirSync(join(C, 'pitch/versions')).length === 1)

// 3c) hrefs passen nicht zur Adresse (Proxy, andere Nextcloud-uid) → abbrechen statt „auf dem Server alles weg“
const foreign: typeof fetch = async (u, i) => {
  const r = await fetch(u, i)
  return i?.method === 'PROPFIND' ? new Response((await r.text()).replaceAll('/files/anna/', '/files/uid-7/'), { status: r.status }) : r
}
await sync(A, s, foreign).then(() => ok(false, 'fremde hrefs angenommen'), (e) => ok(/passt nicht/.test(e.message), e.message))
ok(existsSync(join(A, 'pitch/deck.json')))

// 4) Löschen wandert mit
rmSync(join(B, 'assets/foto.png'))
eq((await sync(B, s)).deleted, 1)
eq((await sync(A, s)).deleted, 1)
ok(!existsSync(join(A, 'assets/foto.png')))

// 5) Sonderzeichen im Namen (Server schreibt &amp; ins href): bleibt eine Datei, kein Dauer-Abgleich
put(A, 'f-&-e/deck.json', '{"fe":1}')
eq((await sync(A, s)).up, 1)
eq(await sync(A, s), { up: 0, down: 0, deleted: 0, conflicts: 0, changed: [] })

// 6) Löschbremse: lokaler Ordner fast leer (Speicher weg, falsches Home) → nichts auf dem Server löschen
for (let i = 0; i < 12; i++) put(A, `deck${i}/deck.json`, `{"i":${i}}`)
await sync(A, s)
const before = files.size
for (let i = 0; i < 12; i++) rmSync(join(A, `deck${i}`), { recursive: true })
await sync(A, s).then(() => ok(false, 'Bremse greift nicht'), (e) => ok(/angehalten/.test(e.message), e.message))
eq(files.size, before)

// 7) Ordner Deckwerk auf dem Server gelöscht (404) bei vorhandenem Stand → lokal nichts löschen, alles neu hochladen
for (const f of [...files.keys()]) if (f.includes('/Deckwerk/')) files.delete(f)
for (const d of [...dirs]) if (d.includes('/Deckwerk')) dirs.delete(d)
const r7 = await sync(B, s)
eq(r7.deleted, 0)
ok(existsSync(join(B, 'pitch/deck.json')))
ok(files.has('/remote.php/dav/files/anna/Deckwerk/pitch/deck.json'))

// 8) Deck-Pfade fremder Geräte auf den lokalen Ordner umleiten
mkdirSync(join(B, 'assets'), { recursive: true })
writeFileSync(join(B, 'assets/foto.png'), 'x')
eq(localAsset('/irgendwo/anders/Deckwerk/assets/foto.png', B), join(B, 'assets/foto.png'))
eq(localAsset(join(B, 'assets/foto.png'), B), join(B, 'assets/foto.png'))
eq(localAsset('/x/Deckwerk/../../etc/passwd', B), '/x/Deckwerk/../../etc/passwd')
eq(localAsset('/x/Deckwerk/assets/fehlt.png', B), '/x/Deckwerk/assets/fehlt.png')

server.close()
rmSync(root, { recursive: true, force: true })
console.log('check-sync: ok')
