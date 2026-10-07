// Cloud: den Ordner „Deckwerk“ per WebDAV spiegeln. Nextcloud über die Anmeldung im Browser (eigenes App-Passwort),
// andere Anbieter mit Adresse, Nutzername und App-Passwort. Dazu die Wolke in der Kopfleiste (Start und Editor).
import { useContext, useEffect, useRef, useState } from 'react'
import { Cloud, CloudAlert, CloudCheck, CloudSync, KeyRound } from 'lucide-react'
import type { SyncStatus } from '../../../preload'
import { confirmDialog } from '../kit'
import { Group, Head, OpenSettings, Row, Spin, useRun, type SectionProps } from './parts'

const zeit = (at: number) => new Date(at).toLocaleTimeString('de')

// Sync-Zustand, bleibt über onSync aktuell
function useSync() {
  const [s, setS] = useState<SyncStatus | null>(null)
  useEffect(() => { void window.api.syncStatus().then(setS); return window.api.onSync(setS) }, [])
  return [s, setS] as const
}

export function CloudSection(_: SectionProps) {
  const [s, setS] = useSync()
  const { busy, err, run } = useRun<'sync' | 'aus' | 'login' | 'dav'>()
  const [server, setServer] = useState('')
  const [dav, setDav] = useState({ url: '', user: '', pass: '' })
  const abmelden = async () => {
    if (!(await confirmDialog({ title: 'Von der Cloud abmelden?', text: 'Der Ordner in der Cloud und deine Dateien hier bleiben erhalten.', ok: 'Abmelden' }))) return
    await run('aus', async () => setS(await window.api.setSync(null)))
  }
  // Nur den eigenen Nextcloud-Login abbrechen (nicht eine Claude-/Codex-Anmeldung); Abbruch durch den Nutzer ist kein Fehler
  const laeuft = useRef(false), abgebrochen = useRef(false)
  useEffect(() => () => { if (laeuft.current) void window.api.loginCancel() }, [])
  const login = () => run('login', async () => {
    laeuft.current = true
    abgebrochen.current = false
    try { setS(await window.api.nextcloudLogin(server.trim())) } catch (e) { if (!abgebrochen.current) throw e } finally { laeuft.current = false }
  })
  const abbrechen = () => { abgebrochen.current = true; void window.api.loginCancel() }
  const verbinden = () => run('dav', async () => { setS(await window.api.setSync(dav)); setDav((d) => ({ ...d, pass: '' })) })

  return (
    <>
      <Head title="Cloud" sub="Deine Decks und Bilder landen im Ordner „Deckwerk“ deiner Cloud und kommen so auf andere Rechner und aufs Handy." />
      {s?.hasPass ? (
        <Group>
          <Row ok title={`Verbunden als ${s.user}`} action={<>
            <button type="button" className="pill" disabled={!!busy || s.busy} onClick={() => void run('sync', async () => setS(await window.api.syncRun()))}>Jetzt abgleichen</button>
            <button type="button" className="plain" disabled={!!busy} onClick={() => void abmelden()}>Abmelden</button>
          </>}>
            {s.busy ? <span><Spin /> Gleicht gerade ab …</span>
              : <span className={s.error ? 'error' : undefined}>{s.at ? `${zeit(s.at)}: ${s.text}` : 'Noch kein Abgleich.'}</span>}
          </Row>
        </Group>
      ) : (
        <>
          <Group>
            <Row title="Mit Nextcloud anmelden">
              Adresse deiner Nextcloud eingeben, dann im Browser anmelden. Deckwerk bekommt ein eigenes App-Passwort, dein Passwort sieht es nie.
              {busy === 'login' ? (
                <span className="cloud-login">
                  <Spin /> Im Browser anmelden und Zugriff erlauben …
                  <button type="button" className="plain tint" onClick={() => void window.api.loginOpen()}>Seite erneut öffnen</button>
                  <button type="button" className="plain" onClick={abbrechen}>Abbrechen</button>
                </span>
              ) : (
                <form className="setup-key" onSubmit={(e) => { e.preventDefault(); void login() }}>
                  <Cloud size={15} />
                  <input type="text" placeholder="cloud.example.de" value={server} onChange={(e) => setServer(e.target.value)} aria-label="Adresse deiner Nextcloud" />
                  <button className="pill tint" disabled={!server.trim() || !!busy}>Anmelden</button>
                </form>
              )}
            </Row>
          </Group>
          <details className="cloud-dav">
            <summary>Anderer Anbieter (WebDAV)</summary>
            <p>Geht mit jedem WebDAV-Anbieter: ownCloud, pCloud, Koofr, Box, Synology, MagentaCLOUD … Lege dort ein <b>App-Passwort</b> an, statt dein Login-Passwort zu verwenden.</p>
            <form onSubmit={(e) => { e.preventDefault(); void verbinden() }}>
              <Group>
                <Row title="Adresse">
                  <span className="setup-key"><Cloud size={15} /><input type="text" placeholder="https://…/webdav" value={dav.url} onChange={(e) => setDav({ ...dav, url: e.target.value })} aria-label="WebDAV-Adresse" /></span>
                </Row>
                <Row title="Nutzername">
                  <span className="setup-key"><input type="text" value={dav.user} autoComplete="username" onChange={(e) => setDav({ ...dav, user: e.target.value })} aria-label="Nutzername" /></span>
                </Row>
                <Row title="App-Passwort">
                  <span className="setup-key"><KeyRound size={15} /><input type="password" autoComplete="current-password" value={dav.pass} onChange={(e) => setDav({ ...dav, pass: e.target.value })} aria-label="App-Passwort" /></span>
                </Row>
              </Group>
              <div className="cloud-go">
                <button className="pill tint" disabled={!!busy || !dav.url.trim() || !dav.user.trim() || !dav.pass}>{busy === 'dav' ? <><Spin />Verbinde …</> : 'Verbinden und abgleichen'}</button>
              </div>
            </form>
          </details>
        </>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </>
  )
}

// Wolke in der Kopfleiste (Start und Editor): zeigt den Sync-Zustand, Klick öffnet den Abschnitt „Cloud“
export function CloudButton() {
  const [s] = useSync()
  const open = useContext(OpenSettings)
  const Icon = !s?.hasPass ? Cloud : s.busy ? CloudSync : s.error ? CloudAlert : CloudCheck
  const label = !s ? 'Cloud-Sync' : !s.hasPass ? 'Cloud-Sync einrichten'
    : s.busy ? 'Cloud-Sync läuft …'
    : `Cloud-Sync: ${s.text || 'noch kein Abgleich'}${s.at ? ` (${zeit(s.at)})` : ''}`
  return (
    <button className={`plain cloud-btn ${!s?.hasPass ? 'off' : s.error ? 'error' : ''}`} title={label} aria-label={label} onClick={() => open('cloud')}>
      <Icon size={17} className={Icon === CloudSync ? 'spin' : undefined} />
    </button>
  )
}
