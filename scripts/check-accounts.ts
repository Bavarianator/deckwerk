// Konten ohne echte Dienste (Fake-CLI, Mini-Nextcloud): npx esbuild scripts/check-accounts.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-accounts.mjs && node ${TMPDIR:-/tmp}/check-accounts.mjs
import { deepStrictEqual as eq, ok, rejects } from 'node:assert'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliLogin, cliStatus, nextcloudLogin, setVibeKey, vibeKey } from '../src/main/accounts'
import { davBase } from '../src/main/sync'

const root = mkdtempSync(join(tmpdir(), 'dw-accounts-'))

// 1) Fake-CLI: Claude gibt die Adresse in zwei Stücken aus und wartet auf den Code, Codex schreibt auf stderr und hängt
const bin = join(root, 'fake')
writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "auth login") echo "Opening browser to sign in…"; printf "If the browser didn't open, visit: \\033[1mhttps://claude.ai/oau"; sleep 0.2; printf "th?code=true&x=1\\033[0m\\n"
    printf "Paste code here if prompted > "; read c; [ "$c" = "abc#def" ] && { echo "Login successful."; exit 0; }; echo "Ungültiger Code" >&2; exit 1;;
  "auth status") [ "$FAKE" = alt ] && { echo "error: unknown command 'auth'" >&2; exit 1; }
    echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.de", "subscriptionType": "max"}';;
  "login status") [ "$FAKE" = aus ] && { echo "Not logged in" >&2; exit 1; }; echo "Logged in using ChatGPT" >&2;;
  "login ") echo "If your browser did not open, navigate to this URL to authenticate:" >&2; echo "https://auth.openai.com/oauth/authorize?x=1" >&2; sleep 30;;
esac
`)
chmodSync(bin, 0o755)

const urls: { url: string; code: boolean }[] = []
let l = cliLogin(bin, 'claude', (e) => urls.push(e), new AbortController().signal)
while (!urls.length) await new Promise((r) => setTimeout(r, 20))
eq(urls, [{ url: 'https://claude.ai/oauth?code=true&x=1', code: true }])
l.code('  abc#def ')
await l.done

l = cliLogin(bin, 'claude', () => l.code('falsch'), new AbortController().signal)
await rejects(l.done, /Anmeldung fehlgeschlagen: Ungültiger Code/)

const ctrl = new AbortController()
urls.length = 0
l = cliLogin(bin, 'codex', (e) => { urls.push(e); ctrl.abort() }, ctrl.signal)
await rejects(l.done, /^Error: Anmeldung abgebrochen\.$/)
eq(urls, [{ url: 'https://auth.openai.com/oauth/authorize?x=1', code: false }])

eq(await cliStatus(bin, 'claude'), { login: true, who: 'a@b.de · Max' })
eq(await cliStatus(bin, 'codex'), { login: true, who: 'ChatGPT-Konto' })
process.env.FAKE = 'aus'
eq(await cliStatus(bin, 'codex'), { login: false })
process.env.FAKE = 'alt'
eq(await cliStatus(bin, 'claude'), { login: null })
eq(await cliStatus(join(root, 'fehlt'), 'codex'), { login: null })

// 2) Vibe: nur die Key-Zeile der .env ändert sich
process.env.VIBE_HOME = join(root, 'vibe')
delete process.env.MISTRAL_API_KEY
eq(vibeKey(), false)
setVibeKey(' neu1 ') // legt Ordner und Datei an
eq(readFileSync(join(root, 'vibe/.env'), 'utf8'), 'MISTRAL_API_KEY=neu1\n')
writeFileSync(join(root, 'vibe/.env'), 'FOO=1\nexport MISTRAL_API_KEY=alt\n# Kommentar\n\n', { mode: 0o644 })
setVibeKey('neu2')
eq(readFileSync(join(root, 'vibe/.env'), 'utf8'), 'FOO=1\n# Kommentar\nMISTRAL_API_KEY=neu2\n')
eq(statSync(join(root, 'vibe/.env')).mode & 0o777, 0o600)
eq(vibeKey(), true)
setVibeKey(null)
eq(readFileSync(join(root, 'vibe/.env'), 'utf8'), 'FOO=1\n# Kommentar\n')
eq(vibeKey(), false)
writeFileSync(join(root, 'vibe/.env'), 'MISTRAL_API_KEY=\nFOO=1\n')
eq(vibeKey(), false)
for (const bad of ['', '  ', 'a\nb', 'a b', 'x'.repeat(201), 42 as unknown as string]) await rejects(async () => setVibeKey(bad), /ungültig/)

// 3) Nextcloud Login Flow v2 gegen einen Mini-Server unter /nc (Unterordner)
let polls = 0, mode: 'ok' | 'offen' | 'js' | 'verboten' = 'ok'
const server = createServer(async (req, res) => {
  let body = ''
  for await (const c of req) body += c
  const p = new URL(req.url!, 'http://x').pathname
  if (req.method !== 'POST' || req.headers['user-agent'] !== 'Deckwerk') return void res.writeHead(400).end()
  if (p === '/nc/index.php/login/v2')
    return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ poll: { token: 't 1', endpoint: `${url}/nc/login/v2/poll` }, login: mode === 'js' ? 'javascript:alert(1)' : `${url}/nc/login/v2/flow/abc` }))
  if (p === '/nc/login/v2/poll' && body === 'token=t%201') {
    if (mode === 'verboten') return void res.writeHead(403).end()
    if (mode === 'offen' || ++polls < 3) return void res.writeHead(polls === 1 ? 503 : 404).end() // 503: Wartung, weiter abfragen
    return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ server: 'http://intern', loginName: 'anna@b.de', appPassword: 'app-pw' }))
  }
  res.writeHead(404).end()
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const opened: string[] = []
const s = await nextcloudLogin(` ${url}/nc/index.php/apps/files/?dir=/ `, { open: (u) => opened.push(u), signal: new AbortController().signal, interval: 10 })
eq(opened, [`${url}/nc/login/v2/flow/abc`])
eq(s, { url: `${url}/nc/remote.php/webdav/`, user: 'anna@b.de', pass: 'app-pw' })
eq(davBase(s), `${url}/nc/remote.php/webdav/Deckwerk/`)
eq(polls, 3)

mode = 'offen'
const c2 = new AbortController()
await rejects(nextcloudLogin(`${url}/nc/`, { open: () => setTimeout(() => c2.abort(), 50), signal: c2.signal, interval: 10 }), /^Error: Anmeldung abgebrochen\.$/)

mode = 'verboten'
await rejects(nextcloudLogin(`${url}/nc`, { open: () => {}, signal: new AbortController().signal, interval: 10 }), /HTTP 403/)

mode = 'js'
opened.length = 0
await rejects(nextcloudLogin(`${url}/nc`, { open: (u) => opened.push(u), signal: new AbortController().signal, interval: 10 }), /ungültige Anmeldeadresse/)
eq(opened, [])

await rejects(nextcloudLogin(url, { open: () => {}, signal: new AbortController().signal }), /antwortet kein Nextcloud/)
await rejects(nextcloudLogin('javascript:alert(1)', { open: () => {}, signal: new AbortController().signal }), /Nextcloud-Adresse/)

server.close()
rmSync(root, { recursive: true, force: true })
console.log('check-accounts: ok')
