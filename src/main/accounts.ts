// Konten (Einstellungen): Browser-Anmeldung in Claude Code und Codex über deren eigenen Login-Befehl, Mistral-Key für Vibe,
// Nextcloud per Login Flow v2 (App-Passwort ohne Abtippen). Electron-frei, damit scripts/check-accounts.ts es unter Node prüft.
import { execFile, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SyncSettings } from './sync'

export type LoginCli = 'claude' | 'codex'

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

/** Anmeldung über den Login-Befehl des CLI. Es öffnet den Browser selbst; die Adresse geht trotzdem an onUrl, falls nicht.
 * Klappt bei Claude der Rückweg auf localhost nicht, zeigt der Browser einen Code, den code() auf stdin durchreicht. */
export function cliLogin(bin: string, cli: LoginCli, onUrl: (e: { url: string; code: boolean }) => void, signal: AbortSignal): { done: Promise<void>; code(c: string): void } {
  const p = spawn(bin, cli === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'], { stdio: 'pipe' })
  p.stdin.on('error', () => {}) // Code nach dem Ende des Prozesses (EPIPE)
  let url = '', lastErr = ''
  // zeilenweise, weil eine Zeile in mehreren Stücken ankommen kann; Codex schreibt die Adresse auf stderr
  const read = (stream: Readable, err: boolean) => {
    let buf = ''
    const line = (l: string) => {
      l = l.replace(ANSI, '').trim()
      if (err && l) lastErr = l
      const m = !url && !signal.aborted && l.match(/https?:\/\/\S+/)
      if (m) { url = m[0]; onUrl({ url, code: cli === 'claude' }) }
    }
    stream.setEncoding('utf8')
    stream.on('data', (d: string) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) line(buf.slice(0, i)) })
    stream.on('end', () => line(buf))
  }
  read(p.stdout, false)
  read(p.stderr, true)
  const done = new Promise<void>((ok, fail) => {
    const end = (e?: Error) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (e) { p.kill(); fail(e) } else ok()
    }
    const abort = () => end(new Error('Anmeldung abgebrochen.'))
    const timer = setTimeout(() => end(new Error('Die Anmeldung hat länger als 10 Minuten gedauert. Bitte noch einmal starten.')), 10 * 60_000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    p.on('error', (e) => end(new Error(`Die Anmeldung ließ sich nicht starten: ${e.message}`)))
    p.on('close', (code) => end(code === 0 ? undefined : new Error(`Anmeldung fehlgeschlagen${lastErr ? `: ${lastErr}` : ` (Code ${code})`}`)))
  })
  return { done, code: (c) => void p.stdin.write(`${c.trim()}\n`) }
}

/** Angemeldet? null = unbekannt (CLI zu alt, hängt oder startet nicht); who: Konto für die Anzeige */
export function cliStatus(bin: string, cli: LoginCli): Promise<{ login: boolean | null; who?: string }> {
  return new Promise((ok) => execFile(bin, cli === 'claude' ? ['auth', 'status'] : ['login', 'status'], { timeout: 10_000 }, (e, out, err) => {
    if (cli === 'codex') {
      if (e && typeof e.code !== 'number') return ok({ login: null }) // nicht startbar oder Zeitlimit
      const t = `${out}${err}`
      return ok(e ? { login: false } : { login: true, who: /api key/i.test(t) ? 'API-Schlüssel' : /chatgpt/i.test(t) ? 'ChatGPT-Konto' : undefined })
    }
    try {
      const j = JSON.parse(out)
      if (typeof j.loggedIn !== 'boolean') throw new Error()
      const sub = typeof j.subscriptionType === 'string' ? j.subscriptionType.charAt(0).toUpperCase() + j.subscriptionType.slice(1) : ''
      ok(j.loggedIn ? { login: true, who: [j.email, sub].filter(Boolean).join(' · ') || undefined } : { login: false })
    } catch { ok({ login: null }) } // ältere Claude Code ohne `auth`
  }))
}

export const cliLogout = (bin: string, cli: LoginCli) => new Promise<void>((ok, fail) =>
  execFile(bin, cli === 'claude' ? ['auth', 'logout'] : ['logout'], { timeout: 30_000 }, (e, _out, err) => (e ? fail(new Error(`Abmelden fehlgeschlagen: ${err.trim() || e.message}`)) : ok())))

// Vibe liest MISTRAL_API_KEY aus der Umgebung, dem Schlüsselbund oder $VIBE_HOME/.env; prüfen lassen sich nur Umgebung und .env
const vibeEnv = () => join(process.env.VIBE_HOME ?? join(homedir(), '.vibe'), '.env')
const readEnv = () => { try { return readFileSync(vibeEnv(), 'utf8') } catch { return '' } }
const KEY_LINE = /^\s*(export\s+)?MISTRAL_API_KEY\s*=/

export const vibeKey = (): boolean => !!process.env.MISTRAL_API_KEY || /^[ \t]*(export[ \t]+)?MISTRAL_API_KEY[ \t]*=[ \t]*['"]?[^\s'"#]/m.test(readEnv())

/** Key in die .env von Vibe schreiben (null löscht ihn); die übrigen Zeilen bleiben */
export function setVibeKey(key: string | null): void {
  const k = typeof key === 'string' ? key.trim() : key
  if (k !== null && (typeof k !== 'string' || k.length > 200 || !/^\S+$/.test(k))) throw new Error('Der Mistral-Schlüssel ist ungültig: ohne Leerzeichen, höchstens 200 Zeichen.')
  const lines = readEnv().split('\n').filter((l) => !KEY_LINE.test(l))
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  if (k) lines.push(`MISTRAL_API_KEY=${k}`)
  const file = vibeEnv()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 })
  chmodSync(file, 0o600) // mode gilt nur beim Anlegen
}

const webUrl = (s: unknown) => { try { const u = new URL(String(s)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null } catch { return null } }

/** Nextcloud Login Flow v2: Anmeldeseite im Browser öffnen, dann abfragen, bis Nextcloud ein App-Passwort liefert (höchstens 20 min) */
export async function nextcloudLogin(server: string, o: { open(url: string): void; signal: AbortSignal; fetchFn?: typeof fetch; interval?: number }): Promise<SyncSettings> {
  const f = o.fetchFn ?? fetch
  const s = server.trim()
  // Adresse wie aus dem Browser kopiert: ohne Schema, mit /index.php/apps/… oder der WebDAV-Adresse dahinter
  let u: URL
  try { u = new URL(/^[a-z][\w+.-]*:\/\//i.test(s) ? s : `https://${s}`) } catch { throw new Error('Die Nextcloud-Adresse ist ungültig, z. B. cloud.example.de.') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Die Nextcloud-Adresse muss mit https:// beginnen.')
  const base = u.origin + u.pathname.replace(/\/(index|remote)\.php(\/.*)?$/, '').replace(/\/+$/, '')
  const headers = { 'User-Agent': 'Deckwerk' } // zeigt Nextcloud als Gerätename
  const signal = () => AbortSignal.any([o.signal, AbortSignal.timeout(15_000)]) // je Anfrage, damit ein hängender Server nicht blockiert
  try {
    const r = await f(`${base}/index.php/login/v2`, { method: 'POST', headers, signal: signal() }).catch((e: Error) => {
      if (o.signal.aborted) throw e
      throw new Error(`${base} ist nicht erreichbar. Adresse und Internetverbindung prüfen.`)
    })
    const j = r.ok ? await r.json().catch(() => null) : null
    if (!j?.poll?.token || !j.poll.endpoint || !j.login) throw new Error(`Unter ${base} antwortet kein Nextcloud. Adresse prüfen (z. B. cloud.example.de).`)
    // login geht an shell.openExternal: nur Webadressen
    const login = webUrl(j.login), endpoint = webUrl(j.poll.endpoint)
    if (!login || !endpoint) throw new Error('Nextcloud hat eine ungültige Anmeldeadresse geschickt.')
    o.open(login)
    for (const until = Date.now() + 20 * 60_000; Date.now() < until;) {
      await sleep(o.interval ?? 2000, undefined, { signal: o.signal })
      const p = await f(endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(j.poll.token)}`, signal: signal() })
        .catch((e: Error) => { if (o.signal.aborted) throw e; return null }) // Netz kurz weg oder Zeitlimit: weiter abfragen
      if (!p || p.status === 404 || p.status === 429 || p.status >= 500) continue // 404: noch nicht im Browser bestätigt
      if (!p.ok) throw new Error(`Nextcloud antwortet beim Anmelden mit HTTP ${p.status}.`)
      const c = await p.json().catch(() => null)
      if (typeof c?.loginName !== 'string' || !c.loginName || typeof c.appPassword !== 'string' || !c.appPassword) throw new Error('Nextcloud hat keinen Zugang geschickt. Bitte noch einmal anmelden.')
      // Adresse, unter der die Anmeldung eben klappte (auch in Unterordnern). webdav statt dav/files/<loginName>: bei Login per
      // E-Mail oder LDAP ist der Login-Name nicht die Nutzer-ID. davBase hängt Deckwerk/ an
      return { url: `${base}/remote.php/webdav/`, user: c.loginName, pass: c.appPassword }
    }
    throw new Error('Die Anmeldung hat länger als 20 Minuten gedauert. Bitte noch einmal starten.')
  } catch (e) {
    if (o.signal.aborted) throw new Error('Anmeldung abgebrochen.')
    throw e
  }
}
