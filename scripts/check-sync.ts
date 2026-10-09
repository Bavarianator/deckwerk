// Cloud-Sync gegen einen Mini-WebDAV-Server im Speicher: npx esbuild scripts/check-sync.ts --bundle --platform=node --format=esm --outfile=out/check-sync.mjs && node out/check-sync.mjs
import { deepStrictEqual as eq, ok } from 'node:assert'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSyncer, davBase, isFolder, localAsset, sync, testSync } from '../src/main/sync'
import { checkSyncFolder, findFolder, folderFetchFor } from '../src/main/sync-folder'

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
put(A, 'fonts/Newsreader/Newsreader-Regular.ttf', 'TTF') // Schrift-Cache lädt jedes Gerät selbst
eq(await sync(A, s), { up: 2, down: 0, deleted: 0, conflicts: 0, changed: [] })
ok(!files.has('/remote.php/dav/files/anna/Deckwerk/pitch/versions/alt.json'))
ok(![...files.keys()].some((f) => f.includes('/fonts/')))
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
const texte: string[] = [] // Fortschritt für die Oberfläche: erst vergleichen, dann übertragen
eq((await sync(C, s, fetch, (t) => texte.push(t))).conflicts, 1)
ok(readdirSync(join(C, 'pitch/versions')).length === 1)
eq(texte, ['Vergleicht 1 von 1 Dateien', 'Überträgt 0 von 2 Dateien', 'Überträgt 1 von 2 Dateien', 'Überträgt 2 von 2 Dateien']) // MB erst ab 1 MB
// mehrere Übertragungen gleichzeitig (bis 4), neue Ordner trotzdem nur einmal angelegt
const D = join(root, 'zweitrechner')
for (let i = 0; i < 6; i++) put(D, `neu/bild${i}.png`, `PNG${i}`)
let laufend = 0, hoechstens = 0, mkcols = 0
const zaehlt: typeof fetch = async (u, i) => {
  if (i?.method === 'MKCOL' && String(u).endsWith('/neu/')) mkcols++
  if (i?.method !== 'PUT') return fetch(u, i)
  hoechstens = Math.max(hoechstens, ++laufend)
  await new Promise((r) => setTimeout(r, 20))
  try { return await fetch(u, i) } finally { laufend-- }
}
eq((await sync(D, s, zaehlt)).up, 6)
ok(hoechstens >= 2 && hoechstens <= 4, `gleichzeitig: ${hoechstens}`)
eq(mkcols, 1)
// Fehler mitten im parallelen Lauf: der erste Fehler kommt an, Fertiges ist gemerkt, der nächste Lauf lädt nur den Rest
for (let i = 0; i < 6; i++) put(D, `zwei/bild${i}.png`, `P${i}`)
const hoch: string[][] = [[], []]
const merkt = (lauf: number, kaputt: boolean): typeof fetch => async (u, i) => {
  if (i?.method !== 'PUT') return fetch(u, i)
  if (kaputt && String(u).endsWith('bild3.png')) return new Response('', { status: 507 })
  const r = await fetch(u, i)
  if (r.ok) hoch[lauf].push(String(u))
  return r
}
await sync(D, s, merkt(0, true)).then(() => ok(false, 'Fehler verschluckt'), (e) => ok(/507/.test(e.message), e.message))
await sync(D, s, merkt(1, false))
ok(!hoch[1].some((u) => hoch[0].includes(u)), 'schon Hochgeladenes noch einmal hochgeladen')
eq(hoch[0].length + hoch[1].length, 6)
// Zwischenstand alle 20 Übertragungen: bricht die App mitten im Lauf ab, ist Erledigtes schon gemerkt
for (let i = 0; i < 25; i++) put(D, `drei/bild${i}.png`, `D${i}`)
let gemerkt = -1, puts = 0
const drei = () => Object.keys(JSON.parse(readFileSync(join(D, '.sync-state.json'), 'utf8')).files).filter((k) => k.startsWith('drei/')).length
const schaut: typeof fetch = async (u, i) => {
  // der Zwischenstand wird nebenher geschrieben (auf langsamer Platte erst nach dem 25. PUT): bis zu 2 s warten; solange
  // dieser letzte Upload aussteht, kann der Lauf nicht enden, gemessen wird also nie der Endstand
  if (i?.method === 'PUT' && ++puts === 25) for (let t = 0; t < 200 && (gemerkt = drei()) < 20; t++) await new Promise((r) => setTimeout(r, 10))
  return fetch(u, i)
}
eq((await sync(D, s, schaut)).up, 25)
ok(gemerkt >= 20, `Zwischenstand: ${gemerkt}`)
ok(!readdirSync(D).includes('.sync-state.json.tmp'))
for (const k of [...files.keys()]) if (/\/Deckwerk\/(neu|zwei|drei)(\/|$)/.test(k)) files.delete(k) // spätere Blöcke (Löschbremse) zählen die Dateien auf dem Server
// hängender Server: verständliche Meldung statt einer englischen DOMException
const hang: typeof fetch = async () => { throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }) }
await sync(A, s, hang).then(() => ok(false, 'Zeitüberschreitung übersehen'), (e) => ok(/antwortet nicht/.test(e.message), e.message))
// … auch wenn der Server erst beim Lesen der Antwort hängt (das Zeitlimit greift dann im Body)
const bodyHang: typeof fetch = async () => ({ ok: true, status: 207, headers: new Headers(), text: async () => { throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' }) } }) as unknown as Response
const st = await createSyncer(A, () => s, () => {}, () => {}, bodyHang).run()
ok(st.error && /antwortet nicht/.test(st.text), st.text)

// 3c) hrefs passen nicht zur Adresse (Proxy, andere Nextcloud-uid) → abbrechen statt „auf dem Server alles weg“
const foreign: typeof fetch = async (u, i) => {
  const r = await fetch(u, i)
  return i?.method === 'PROPFIND' ? new Response((await r.text()).replaceAll('/files/anna/', '/files/uid-7/'), { status: r.status }) : r
}
await sync(A, s, foreign).then(() => ok(false, 'fremde hrefs angenommen'), (e) => ok(/passt nicht/.test(e.message), e.message))
ok(existsSync(join(A, 'pitch/deck.json')))

// 3d) bösartiger Server: `\` im Namen (%5C) wäre unter Windows ein Ordnertrenner → x\..\..\Autostart; nie herunterladen
let untergeschoben = false, geholt = 0
const boese: typeof fetch = async (u, i) => {
  if (i?.method === 'GET' && String(u).includes('%5C')) { geholt++; return new Response('BOOM') }
  const r = await fetch(u, i)
  if (i?.method !== 'PROPFIND' || !String(u).endsWith('/Deckwerk/')) return r
  untergeschoben = true
  const evil = `<d:response><d:href>/remote.php/dav/files/anna/Deckwerk/x%5C..%5C..%5Cevil.cmd</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag><d:getcontentlength>4</d:getcontentlength><d:getlastmodified>${new Date().toUTCString()}</d:getlastmodified><d:resourcetype/></d:prop></d:propstat></d:response>`
  return new Response((await r.text()).replace('</d:multistatus>', `${evil}</d:multistatus>`), { status: r.status })
}
await sync(A, s, boese)
ok(untergeschoben && geholt === 0, `heruntergeladen: ${geholt}`)
ok(!readdirSync(A).some((f) => f.includes('\\')))

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

// 9) Ordner-Ziel (Sync-Ordner von Dropbox & Co.): file:-Adresse, folderFetchFor spielt WebDAV auf der Platte
const box = join(root, 'Dropbox'), P = join(root, 'pc2'), Q = join(root, 'laptop')
mkdirSync(box)
const f = { url: pathToFileURL(box).href, user: '', pass: '' }
const ff = folderFetchFor(P)
ok(isFolder(f.url) && isFolder(f.url.replace('file:', 'FILE:')) && !isFolder('cloud.example.org') && !isFolder('https://x/'))
eq(davBase(f), `${pathToFileURL(box).href}/Deckwerk/`)
eq(davBase({ url: 'file:///C:/Users/a%20b/Dropbox', user: '' }), 'file:///C:/Users/a%20b/Dropbox/Deckwerk/')
await testSync(f, ff)
await testSync({ ...f, url: pathToFileURL(join(root, 'fehlt')).href }, ff).then(() => ok(false, 'fehlender Ordner angenommen'), (e) => ok(/404/.test(e.message), e.message))
put(P, 'pitch/deck.json', '{"v":1}'); put(P, 'assets/f & ü.png', 'PNG'); put(P, 'pitch/versions/alt.json', 'x'); older(P, 'pitch/deck.json')
eq(await sync(P, f, ff), { up: 2, down: 0, deleted: 0, conflicts: 0, changed: [] })
eq(get(box, 'Deckwerk/pitch/deck.json'), '{"v":1}')
ok(!existsSync(join(box, 'Deckwerk/pitch/versions')))
ok(!readdirSync(join(box, 'Deckwerk/pitch')).some((x) => x.endsWith('.part')))
eq(Math.floor(statSync(join(box, 'Deckwerk/pitch/deck.json')).mtimeMs / 1000), Math.floor(statSync(join(P, 'pitch/deck.json')).mtimeMs / 1000)) // X-OC-Mtime
eq(await sync(P, f, ff), { up: 0, down: 0, deleted: 0, conflicts: 0, changed: [] })
eq((await sync(Q, f, folderFetchFor(Q))).down, 2)
eq(get(Q, 'assets/f & ü.png'), 'PNG')
// die Cloud-App bringt eine neuere Fassung in den Ordner → runter
put(box, 'Deckwerk/pitch/deck.json', '{"v":2}')
eq((await sync(P, f, ff)).down, 1)
eq(get(P, 'pitch/deck.json'), '{"v":2}')
// Löschen auf der Ordner-Seite und lokal
rmSync(join(box, 'Deckwerk/assets/f & ü.png'))
eq((await sync(P, f, ff)).deleted, 1)
ok(!existsSync(join(P, 'assets/f & ü.png')))
put(P, 'neu/deck.json', '{}')
eq((await sync(P, f, ff)).up, 1)
rmSync(join(P, 'neu'), { recursive: true })
eq((await sync(P, f, ff)).deleted, 1)
ok(!existsSync(join(box, 'Deckwerk/neu/deck.json')))
// Konflikt: beide ändern, Ordner-Seite ist neuer → lokale Fassung in versions/
put(P, 'pitch/deck.json', '{"v":"pc"}'); older(P, 'pitch/deck.json')
put(box, 'Deckwerk/pitch/deck.json', '{"v":"cloud"}')
eq((await sync(P, f, ff)).conflicts, 1)
eq(get(P, 'pitch/deck.json'), '{"v":"cloud"}')
ok(readdirSync(join(P, 'pitch/versions')).some((x) => x.endsWith('-lokal.json') && get(P, `pitch/versions/${x}`) === '{"v":"pc"}'))
// Systemdateien (desktop.ini, Icon\r) bleiben, wo sie sind; alte .part-Reste im Ordner räumt PROPFIND weg
put(box, 'Deckwerk/desktop.ini', '[x]'); put(box, 'Deckwerk/pitch/Icon\r', ''); put(P, 'Desktop.ini', '[y]')
put(box, 'Deckwerk/pitch/.deck.json.abc.part', 'x'); utimesSync(join(box, 'Deckwerk/pitch/.deck.json.abc.part'), new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000))
eq(await sync(P, f, ff), { up: 0, down: 0, deleted: 0, conflicts: 0, changed: [] })
eq(await sync(P, f, ff), { up: 0, down: 0, deleted: 0, conflicts: 0, changed: [] })
ok(!existsSync(join(P, 'desktop.ini')) && !existsSync(join(P, 'pitch/Icon\r')) && get(P, 'Desktop.ini') === '[y]')
ok(!existsSync(join(box, 'Deckwerk/pitch/.deck.json.abc.part')))
// iCloud hat eine Datei ausgelagert (.name.icloud) → abbrechen statt lokal löschen
put(box, 'Deckwerk/pitch/.deck.json.icloud', ''); rmSync(join(box, 'Deckwerk/pitch/deck.json'))
await sync(P, f, ff).then(() => ok(false, 'ausgelagerte iCloud-Datei übersehen'), (e) => ok(/iCloud/.test(e.message), e.message))
ok(existsSync(join(P, 'pitch/deck.json')))
// Sync-Ordner zeigt nachträglich per Link auf den Deckwerk-Ordner → jede Anfrage verweigert, auch auf noch nicht vorhandene Pfade
const evil = join(root, 'evil'); mkdirSync(evil); symlinkSync(P, join(evil, 'Deckwerk'))
await sync(P, { ...f, url: pathToFileURL(evil).href }, ff).then(() => ok(false, 'Link auf den Deckwerk-Ordner angenommen'), (e) => ok(/selbst/.test(e.message), e.message))
await ff(pathToFileURL(join(evil, 'Deckwerk/neu/x.json')).href, { method: 'PUT', body: 'x' }).then(() => ok(false, 'PUT in den Deckwerk-Ordner angenommen'), (e) => ok(/selbst/.test(e.message), e.message))
ok(existsSync(join(P, 'pitch/deck.json')) && !existsSync(join(P, 'neu/x.json')))

// 10) Ordnerwahl: übliche Sync-Ordner finden; Deckwerk nie in sich selbst spiegeln (auch nicht über Links)
const H = join(root, 'home'), own = join(H, 'Deckwerk')
mkdirSync(join(H, 'OneDrive - Firma'), { recursive: true }); mkdirSync(join(H, 'Insync/a@b.de/Google Drive'), { recursive: true }); mkdirSync(own)
eq(await findFolder('~/OneDrive - *', H), join(H, 'OneDrive - Firma'))
eq(await findFolder('~/Insync/*/Google Drive', H), join(H, 'Insync/a@b.de/Google Drive'))
eq(await findFolder('~/Dropbox', H), null)
eq(await findFolder('G:/Meine Ablage', H), null) // Laufwerke nur unter Windows
await checkSyncFolder(join(H, 'OneDrive - Firma'), own)
symlinkSync(H, join(root, 'home-link'))
mkdirSync(join(root, 'box2')); symlinkSync(own, join(root, 'box2/Deckwerk'))
for (const bad of [H, own, join(root, 'home-link'), join(root, 'box2'), join(root, 'fehlt')])
  await checkSyncFolder(bad, own).then(() => ok(false, `${bad} angenommen`), (e) => ok(/nicht nutzen/.test(e.message), e.message))
mkdirSync(join(own, 'assets'))
await checkSyncFolder(join(own, 'assets'), own).then(() => ok(false, 'Ordner im Deckwerk-Ordner angenommen'), (e) => ok(/selbst/.test(e.message), e.message))
await checkSyncFolder(root, join(root, 'Deckwerk/x/Deckwerk')).then(() => ok(false, 'Ziel über dem Deckwerk-Ordner angenommen'), (e) => ok(/selbst/.test(e.message), e.message))

server.close()
rmSync(root, { recursive: true, force: true })
console.log('check-sync: ok')
