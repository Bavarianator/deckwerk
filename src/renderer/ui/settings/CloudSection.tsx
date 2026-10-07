// Cloud: den Ordner „Deckwerk“ spiegeln. Anbieter aus einer Liste wählen (src/shared/clouds.ts), dann nur das Nötigste eingeben:
// Nextcloud im Browser, WebDAV-Dienste mit Nutzername und Passwort, Dropbox & Co. über den Sync-Ordner ihrer App.
// Dazu die Wolke in der Kopfleiste (Start und Editor).
import { useContext, useEffect, useRef, useState } from 'react'
import { ChevronDown, Cloud, CloudAlert, CloudCheck, CloudSync, ExternalLink } from 'lucide-react'
import type { SyncStatus } from '../../../preload'
import { CLOUDS, cloudUrl, type CloudPreset } from '../../../shared/clouds'
import { confirmDialog } from '../kit'
import { Group, Head, OpenSettings, Row, Spin, useRun, type SectionProps } from './parts'

const zeit = (at: number) => new Date(at).toLocaleTimeString('de')
const kurz = (pfad: string) => pfad.replace(/^(\/home\/|\/Users\/|[A-Za-z]:[\\/]Users[\\/])[^/\\]+/, '~') // Home als ~
const GRUPPEN: [CloudPreset['kind'], string][] = [['nextcloud', 'Anmelden im Browser'], ['folder', 'Über die App auf diesem Rechner'], ['webdav', 'Mit Nutzername und Passwort']]

// Womit verbunden: Ordner, Anbieter aus CLOUDS (gleicher Host, {user}/{id} als Platzhalter) oder Host der Adresse
function ziel(s: SyncStatus): string {
  if (s.url.startsWith('file:')) return `Ordner ${kurz(decodeURIComponent(new URL(s.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'))}/Deckwerk`
  let host = s.url
  try { host = new URL(s.url).host } catch { /* Adresse so zeigen */ }
  const p = CLOUDS.find((c) => {
    const h = /^https:\/\/([^/]+)/.exec(c.url ?? '')?.[1]
    return h && new RegExp(`^${h.replace(/\./g, '\\.').replace(/\{\w+\}/g, '[^.]+')}$`).test(host)
  })
  // interne Kennungen (z. B. Nextcloud mit Single Sign-on: 64 Hex-Zeichen) sagen niemandem etwas
  const user = /^[0-9a-f]{24,}$/i.test(s.user) ? '' : s.user
  return `${p?.name ?? host}${user ? ` als ${user}` : ''}`
}

// Sync-Zustand, bleibt über onSync aktuell
function useSync() {
  const [s, setS] = useState<SyncStatus | null>(null)
  useEffect(() => { void window.api.syncStatus().then(setS); return window.api.onSync(setS) }, [])
  return [s, setS] as const
}

export function CloudSection(_: SectionProps) {
  const [s, setS] = useSync()
  const { busy, err, setErr, run } = useRun<'sync' | 'aus' | 'login' | 'dav' | 'ordner' | 'hilfe'>()
  const [offen, setOffen] = useState<string | null>(null) // aufgeklappter Anbieter
  const [feld, setFeld] = useState('') // Server-Adresse bzw. ID
  const [nutzer, setNutzer] = useState('')
  const [pass, setPass] = useState('')
  const [ordner, setOrdner] = useState<{ id: string; path: string }[]>([])
  useEffect(() => { window.api.cloudFolders().then(setOrdner, () => {}) }, []) // ohne Fund bleibt nur „Ordner wählen …“
  const ordnerVon = (id: string) => ordner.find((o) => o.id === id)?.path
  const umschalten = (id: string) => { setOffen(offen === id ? null : id); setFeld(''); setNutzer(''); setPass(''); setErr('') }
  const istOrdner = !!s?.url.toLowerCase().startsWith('file:')
  const abmelden = async () => {
    const text = istOrdner ? 'Der Ordner und deine Dateien hier bleiben erhalten.' : 'Der Ordner in der Cloud und deine Dateien hier bleiben erhalten.'
    if (!(await confirmDialog({ title: 'Von der Cloud abmelden?', text, ok: 'Abmelden' }))) return
    await run('aus', async () => setS(await window.api.setSync(null)))
  }
  // Nur den eigenen Nextcloud-Login abbrechen (nicht eine Claude-/Codex-Anmeldung); Abbruch durch den Nutzer ist kein Fehler
  const laeuft = useRef(false), abgebrochen = useRef(false)
  useEffect(() => () => { if (laeuft.current) void window.api.loginCancel() }, [])
  const login = (server: string) => run('login', async () => {
    laeuft.current = true
    abgebrochen.current = false
    try { setS(await window.api.nextcloudLogin(server)) } catch (e) { if (!abgebrochen.current) throw e } finally { laeuft.current = false }
  })
  const abbrechen = () => { abgebrochen.current = true; void window.api.loginCancel() }
  const verbinden = (p: CloudPreset) => run('dav', async () => {
    setS(await window.api.setSync({ url: cloudUrl(p, feld, nutzer), user: nutzer.trim(), pass }))
    setPass('')
  })
  const nimmOrdner = (pfad: string) => run('ordner', async () => setS(await window.api.setSyncFolder(pfad)))
  const waehleOrdner = (start?: string) => run('ordner', async () => {
    const d = await window.api.pickCloudFolder(start)
    if (d) setS(await window.api.setSyncFolder(d))
  })

  // Aufgeklappte Zeile: nur, was der Anbieter braucht
  const formular = (p: CloudPreset) => {
    const mitFeld = p.kind === 'nextcloud' ? !p.url : /\{(server|id)\}/.test(p.url ?? '{server}')
    const adresse = mitFeld && (
      <label className="cloud-field"><span>{p.ask ?? 'Adresse'}</span>
        <input type="text" value={feld} onChange={(e) => setFeld(e.target.value)} placeholder={p.kind === 'nextcloud' ? 'cloud.example.de' : undefined} />
      </label>
    )
    const gefunden = ordnerVon(p.id)
    return (
      <div className="cloud-form" id={`cloud-${p.id}`}>
        <p className="cloud-hint">{p.hint}</p>
        {p.help && <button type="button" className="plain tint cloud-link" onClick={() => void run('hilfe', () => window.api.cloudHelp(p.id))}>Anleitung öffnen <ExternalLink size={13} /></button>}
        {p.kind === 'nextcloud' && (busy === 'login' ? (
          <span className="cloud-login" role="status">
            <Spin /> Im Browser anmelden und Zugriff erlauben …
            <button type="button" className="plain tint" onClick={() => void window.api.loginOpen()}>Seite erneut öffnen</button>
            <button type="button" className="plain" onClick={abbrechen}>Abbrechen</button>
          </span>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); void login(p.url ?? feld.trim()) }}>
            {adresse}
            <div className="cloud-go"><button className="pill tint" disabled={!!busy || (mitFeld && !feld.trim())}>Im Browser anmelden</button></div>
          </form>
        ))}
        {p.kind === 'webdav' && (
          <form onSubmit={(e) => { e.preventDefault(); void verbinden(p) }}>
            {adresse}
            <label className="cloud-field"><span>{p.user ?? 'E-Mail-Adresse'}</span>
              <input type="text" autoComplete="username" value={nutzer} onChange={(e) => setNutzer(e.target.value)} />
            </label>
            <label className="cloud-field"><span>{p.pass ?? 'Passwort'}</span>
              <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
            </label>
            <div className="cloud-go">
              <button className="pill tint" disabled={!!busy || (mitFeld && !feld.trim()) || !nutzer.trim() || !pass}>{busy === 'dav' ? <><Spin />Verbinde …</> : 'Verbinden'}</button>
            </div>
          </form>
        )}
        {p.kind === 'folder' && <>
          <p className="cloud-hint">Deckwerk legt darin den Ordner „Deckwerk“ an, die App lädt ihn hoch.</p>
          <div className="cloud-go">
            {gefunden ? <>
              <button type="button" className="pill tint" disabled={!!busy} onClick={() => void nimmOrdner(gefunden)}>{kurz(gefunden)} verwenden</button>
              <button type="button" className="plain" disabled={!!busy} onClick={() => void waehleOrdner(gefunden)}>Anderen Ordner wählen …</button>
            </> : <button type="button" className="pill tint" disabled={!!busy} onClick={() => void waehleOrdner()}>Ordner wählen …</button>}
            {busy === 'ordner' && <Spin />}
          </div>
        </>}
        {err && <p className="error" role="alert">{err}</p>}
      </div>
    )
  }

  return (
    <>
      <Head title="Cloud" sub="Deine Decks und Bilder landen im Ordner „Deckwerk“ deiner Cloud und kommen so auf andere Rechner und aufs Handy." />
      {!s ? null : s.hasPass ? ( /* bis der Zustand da ist nichts zeigen, sonst blitzt bei Verbundenen die Anbieterliste auf */
        <>
          <Group>
            <Row ok title={`Verbunden mit ${ziel(s)}`} action={<>
              <button type="button" className="pill" disabled={!!busy || s.busy} onClick={() => void run('sync', async () => setS(await window.api.syncRun()))}>Jetzt abgleichen</button>
              <button type="button" className="plain" disabled={!!busy} onClick={() => void abmelden()}>Abmelden</button>
            </>}>
              {s.busy ? <span role="status"><Spin /> {s.text || 'Gleicht gerade ab …'}</span>
                : <span className={s.error ? 'error' : undefined}>{s.at ? `${zeit(s.at)}: ${s.text}` : 'Noch kein Abgleich.'}</span>}
            </Row>
          </Group>
          {err && <p className="error" role="alert">{err}</p>}
        </>
      ) : (
        <>
          <p className="settings-note">Wähle deinen Cloud-Dienst.</p>
          {GRUPPEN.map(([kind, label]) => (
            <Group key={kind} label={label}>
              {CLOUDS.filter((p) => p.kind === kind).map((p) => {
                const gefunden = ordnerVon(p.id)
                return (
                  <div key={p.id} className="cloud-item">
                    <button type="button" className="setup-opt" aria-expanded={offen === p.id} aria-controls={`cloud-${p.id}`} disabled={!!busy} onClick={() => umschalten(p.id)}>
                      <span><b>{p.name}</b>{gefunden && `Ordner gefunden: ${kurz(gefunden)}`}</span>
                      <ChevronDown size={16} />
                    </button>
                    {offen === p.id && formular(p)}
                  </div>
                )
              })}
            </Group>
          ))}
        </>
      )}
    </>
  )
}

// Wolke in der Kopfleiste (Start und Editor): zeigt den Sync-Zustand, Klick öffnet den Abschnitt „Cloud“
export function CloudButton() {
  const [s] = useSync()
  const open = useContext(OpenSettings)
  const Icon = !s?.hasPass ? Cloud : s.busy ? CloudSync : s.error ? CloudAlert : CloudCheck
  const label = !s ? 'Cloud-Sync' : !s.hasPass ? 'Cloud-Sync einrichten'
    : s.busy ? `Cloud-Sync läuft${s.text ? `: ${s.text}` : ' …'}`
    : `Cloud-Sync: ${s.text || 'noch kein Abgleich'}${s.at ? ` (${zeit(s.at)})` : ''}`
  return (
    <button className={`plain cloud-btn ${!s?.hasPass ? 'off' : s.error ? 'error' : ''}`} title={label} aria-label={label} onClick={() => open('cloud')}>
      <Icon size={17} className={Icon === CloudSync ? 'spin' : undefined} />
    </button>
  )
}
