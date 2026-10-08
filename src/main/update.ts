// Aktualisieren aus der App: Version gegen den neuesten GitHub-Release prüfen (nur auf Knopfdruck, kein Hintergrundabruf)
// und die Linux-Installation durch install.sh ersetzen, dasselbe wie `deckwerk update` im Terminal.
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const REPO = 'Bavarianator/deckwerk'
/** Wohin install.sh die fertige App legt (DECKWERK_APP wie dort) */
export const APP_DIR = process.env.DECKWERK_APP ?? join(homedir(), '.local/share/deckwerk')
export interface UpdateInfo { current: string; latest: string; newer: boolean; canInstall: boolean }

/** Ist b neuer als a? Vergleicht die Zahlen von „0.1.6“ bzw. „v0.1.7“ */
export function isNewer(a: string, b: string): boolean {
  const n = (v: string) => v.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0)
  const [x, y] = [n(a), n(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] ?? 0) !== (x[i] ?? 0)) return (y[i] ?? 0) > (x[i] ?? 0)
  return false
}

export async function checkUpdate(current: string, execPath = process.execPath): Promise<UpdateInfo> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`GitHub antwortet mit ${res.status}.`)
  const latest = String(((await res.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '')
  if (!latest) throw new Error('Keine Version im neuesten Release gefunden.')
  // ersetzen kann sich nur die fertige App unter APP_DIR; Entwicklung und Quellcode-Installation nutzen `deckwerk update` bzw. git
  return { current, latest, newer: isNewer(current, latest), canInstall: process.platform === 'linux' && execPath.startsWith(APP_DIR + '/') }
}

/** install.sh aus master ausführen; bei Fehler die letzten Zeilen der Ausgabe als Meldung */
export function installUpdate(): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn('sh', ['-c', `curl -fsSL https://raw.githubusercontent.com/${REPO}/master/scripts/install.sh | sh`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    for (const s of [p.stdout, p.stderr]) s.on('data', (d: Buffer) => { log = (log + d).slice(-2000) })
    p.on('error', fail)
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`Aktualisieren fehlgeschlagen:\n${log.trim().split('\n').slice(-4).join('\n')}`))))
  })
}
