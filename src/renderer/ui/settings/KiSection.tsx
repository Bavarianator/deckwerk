// KI-Zugang: Konten (Claude-Abo, ChatGPT-Abo, Mistral, API-Schlüssel) mit Anmelden/Abmelden und darunter das Chat-Modell.
// KiZugang ist auch die mittlere Seite des Einrichtungsassistenten.
import { useContext, useEffect, useRef, useState } from 'react'
import { ExternalLink, KeyRound } from 'lucide-react'
import { AUTO, AUTO_CHOICE, MODELS, routeOf } from '../../../shared/models'
import { ChatChoices } from '../Chat'
import { confirmDialog } from '../kit'
import type { ChatCli, CliStatus, LoginCli } from '../../../preload'
import { Befehl, Group, Head, INSTALL, Ok, Row, Spin, TERMINAL, useRun, type SectionProps } from './parts'

type Status = { key: boolean; clis: CliStatus[] }
const TITEL: Record<ChatCli, string> = { claude: 'Claude-Abo (Claude Code)', codex: 'ChatGPT-Abo (Codex)', vibe: 'Mistral (Vibe)' }
const WER: Record<ChatCli, string> = { claude: 'Für Pro und Max, ohne Extrakosten.', codex: 'Für Plus und Pro.', vibe: 'Mit Mistral-Schlüssel oder lokalen Modellen.' }

// Installationsschritte im Terminal, bis das CLI gefunden wird
function Anleitung({ cli }: { cli: ChatCli }) {
  return (
    <ol className="setup-anleitung">
      {cli === 'codex' && <li>Codex braucht Node.js. Falls es fehlt: <button className="plain tint" onClick={() => void window.api.openHilfe('node')}>nodejs.org öffnen <ExternalLink size={13} /></button> und die LTS-Version installieren.</li>}
      <li>Ein Terminal öffnen ({TERMINAL}), diesen Befehl einfügen und mit Enter bestätigen:<Befehl text={INSTALL[cli]} /></li>
      <li>{cli === 'vibe' ? 'Danach hier den Mistral-Schlüssel eintragen.' : 'Danach hier auf „Anmelden“ klicken.'}</li>
      <li className="setup-status"><Spin /> Deckwerk schaut alle paar Sekunden nach und merkt es von selbst.</li>
      {cli === 'claude' && <li className="setup-status"><button className="plain tint" onClick={() => void window.api.openHilfe('claude')}>Ausführliche Anleitung im Browser <ExternalLink size={13} /></button></li>}
    </ol>
  )
}

/** Konten für die KI; auch im Einrichtungsassistenten */
export function KiZugang({ model, onModel, onChanged }: Pick<SectionProps, 'model' | 'onModel' | 'onChanged'>) {
  const [s, setS] = useState<Status | null>(null)
  const [offen, setOffen] = useState<ChatCli | 'key' | null>(null) // aufgeklappte Anleitung bzw. Schlüssel-Formular
  const [key, setKey] = useState('')
  const [keyInfo, setKeyInfo] = useState<'' | 'geprüft' | 'ungeprüft'>('')
  const [vibeKey, setVibeKey] = useState('')
  const [vibeNeu, setVibeNeu] = useState(false) // „Ändern“ beim gefundenen Mistral-Schlüssel
  const [mitCode, setMitCode] = useState(false)
  const [code, setCode] = useState('')
  const abbruch = useRef(false) // Abbrechen ist kein Fehler
  const laeuft = useRef(false) // Anmeldung offen: beim Schließen abbrechen, sonst hält das CLI bis zu 10 min Port und Prozess
  const { busy, err, run } = useRun<'key' | 'vibe' | 'logout' | LoginCli>()
  const zusatz = useRun<'code' | 'open' | 'cancel'>() // Aktionen während der laufenden Anmeldung
  const [ladeFehler, setLadeFehler] = useState('')
  const load = () => window.api.setupStatus().then((x) => { setS(x); setLadeFehler('') }, () => setLadeFehler('Der Stand der Konten ließ sich nicht abfragen. Deckwerk versucht es weiter.'))
  const neu = async () => { await load(); onChanged() }
  useEffect(() => { void load() }, [])
  useEffect(() => window.api.onLogin((e) => setMitCode(e.code)), [])
  useEffect(() => () => { if (laeuft.current) { abbruch.current = true; void window.api.loginCancel().catch(() => {}) } }, []) // nach dem Schließen gibt es keinen Ort für Fehler
  const abbrechen = () => { abbruch.current = true; void zusatz.run('cancel', () => window.api.loginCancel()) }

  // Chat-Weg = Gruppe im Modell-Dropdown: Claude behält das bisherige Claude-Modell, sonst das erste Modell des CLI
  const choices = useContext(ChatChoices)
  const kind = routeOf(model)?.cli ?? 'claude'
  const useCli = (cli: ChatCli) => onModel(cli === 'claude' ? (kind === 'claude' ? model : AUTO) : choices?.[cli][0]?.id ?? `${cli}:`)
  const gefunden = s?.clis.filter((c) => c.found) ?? []
  const aktiv = s?.key ? null : gefunden.find((c) => c.id === kind && c.login !== false) // CLI, über das der Chat läuft
  const bereit = !!s?.key || !!aktiv
  // Noch kein Zugang (oder Anleitung offen): alle paar Sekunden nachsehen, damit ein frisch installiertes CLI von selbst auftaucht …
  useEffect(() => {
    if (bereit && !offen) return
    const t = setInterval(() => void load(), 4000)
    return () => clearInterval(t)
  }, [bereit, offen])
  // … und es dann gleich als Chat-Weg wählen
  useEffect(() => {
    const c = !bereit && gefunden.find((x) => x.login !== false)
    if (c) useCli(c.id)
    if (offen && offen !== 'key' && gefunden.some((x) => x.id === offen)) setOffen(null) // installiert: Anleitung zu
  }, [s])

  const login = (cli: LoginCli) => run(cli, async () => {
    abbruch.current = false
    laeuft.current = true
    setMitCode(false)
    zusatz.setErr('')
    try { await window.api.login(cli); zusatz.setErr('') } catch (e) { if (!abbruch.current) throw e } finally { laeuft.current = false }
    await neu()
  })
  const logout = async (c: CliStatus) => {
    if (await confirmDialog({ title: `Von ${c.name} abmelden?`, text: 'Der Chat läuft dann nicht mehr über dieses Konto. Anmelden geht jederzeit wieder.', ok: 'Abmelden', danger: true }))
      void run('logout', async () => { await window.api.logout(c.id as LoginCli); await neu() })
  }
  const saveKey = () => run('key', async () => { setKeyInfo(await window.api.setApiKey(key)); setKey(''); setOffen(null); await neu() })
  const clearKey = async () => {
    if (await confirmDialog({ title: 'API-Schlüssel entfernen?', text: 'Der Schlüssel wird auf diesem Rechner gelöscht.', ok: 'Entfernen', danger: true }))
      void run('key', async () => { await window.api.clearApiKey(); setKeyInfo(''); await neu() })
  }
  const saveVibe = (k: string | null) => run('vibe', async () => { await window.api.setVibeKey(k); setVibeKey(''); setVibeNeu(false); await neu() })
  const clearVibe = async () => {
    if (await confirmDialog({ title: 'Mistral-Schlüssel entfernen?', text: 'Der Schlüssel wird aus der Vibe-Einstellung gelöscht.', ok: 'Entfernen', danger: true })) void saveVibe(null)
  }
  const anleitung = (cli: ChatCli) => (
    <button className="plain tint" aria-expanded={offen === cli} aria-label={`Anleitung für ${TITEL[cli]}`} onClick={() => setOffen(offen === cli ? null : cli)}>Anleitung</button>
  )

  const konto = (c: CliStatus) => {
    if (!c.found) return <Row key={c.id} ok={false} title={TITEL[c.id]} action={anleitung(c.id)}>{`Noch nicht installiert. ${WER[c.id]}`}{offen === c.id && <Anleitung cli={c.id} />}</Row>
    if (c.id === 'vibe') {
      const form = c.login !== true || vibeNeu
      return (
        <Row key={c.id} ok={c.login === true} title={TITEL.vibe}
          action={c.login === true && <>
            <button className="plain" disabled={!!busy} aria-label="Mistral-Schlüssel ändern" onClick={() => setVibeNeu(!vibeNeu)}>Ändern</button>
            <button className="plain" disabled={!!busy} aria-label="Mistral-Schlüssel entfernen" onClick={() => void clearVibe()}>Entfernen</button>
          </>}>
          {c.login === true ? 'Mistral-Schlüssel gefunden.' : c.login === null ? 'Kein Mistral-Schlüssel gefunden, für lokale Modelle nicht nötig.'
            : 'Lokale Modelle brauchen keinen Schlüssel, für Mistral in der Cloud trag ihn hier ein.'}
          {form && <>
            <form className="setup-key" onSubmit={(e) => { e.preventDefault(); if (vibeKey.trim()) void saveVibe(vibeKey.trim()) }}>
              <KeyRound size={15} />
              <input type="password" placeholder="Mistral-API-Schlüssel" value={vibeKey} onChange={(e) => setVibeKey(e.target.value)} aria-label="Mistral-API-Schlüssel" />
              <button className="pill tint" disabled={!vibeKey.trim() || !!busy}>{busy === 'vibe' ? <Spin /> : 'Speichern'}</button>
            </form>
            <button className="plain tint ki-link" onClick={() => void window.api.openHilfe('mistral')}>Schlüssel bei Mistral holen <ExternalLink size={13} /></button>
          </>}
        </Row>
      )
    }
    const cli = c.id as LoginCli
    if (busy === cli) return (
      <Row key={c.id} ok={false} title={TITEL[cli]}
        action={<>
          <button className="plain" onClick={() => void zusatz.run('open', () => window.api.loginOpen())}>Seite erneut öffnen</button>
          <button className="plain" onClick={abbrechen}>Abbrechen</button>
        </>}>
        <span className="ki-wartet" role="status"><Spin /> Im Browser anmelden …</span>
        {mitCode && (
          <form className="setup-key" onSubmit={(e) => { e.preventDefault(); if (code.trim()) void zusatz.run('code', async () => { await window.api.loginCode(code.trim()); setCode('') }) }}>
            <input type="text" placeholder="Code aus dem Browser" value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code aus dem Browser" />
            <button className="pill" disabled={!code.trim() || zusatz.busy === 'code'}>Senden</button>
          </form>
        )}
      </Row>
    )
    // null = Anmeldung nicht prüfbar: wie die Startklar-Box als nutzbar zählen, Anmelden trotzdem anbieten
    if (c.login !== true) return (
      <Row key={c.id} ok={c.login === null} title={TITEL[cli]}
        action={<button className="pill tint" disabled={!!busy} aria-label={`Bei ${TITEL[cli]} anmelden`} onClick={() => void login(cli)}>Anmelden</button>}>
        {c.login === null ? 'Installiert, Anmeldung nicht prüfbar.' : `Installiert, noch nicht angemeldet. ${WER[cli]}`}
      </Row>
    )
    return (
      <Row key={c.id} ok title={TITEL[cli]} action={<button className="plain" disabled={!!busy} aria-label={`Von ${TITEL[cli]} abmelden`} onClick={() => void logout(c)}>Abmelden</button>}>
        {c.who ? `Angemeldet als ${c.who}` : 'Angemeldet'}
      </Row>
    )
  }

  if (!s) return ladeFehler ? <p className="error" role="alert">{ladeFehler}</p> : <p><Spin /> Wird geprüft …</p>
  return (
    <>
      {bereit && (
        <div className="setup-box done"><Ok /><span><b>Startklar.</b> {s.key ? 'Deckwerk nutzt deinen API-Schlüssel.' : `Deckwerk nutzt dein ${aktiv!.name.replace(/ /g, '-')}-Login.`}</span></div>
      )}
      <Group label="Konten">
        {s.clis.map(konto)}
        <Row ok={s.key} title="Anthropic-API-Schlüssel"
          action={s.key ? <button className="plain" disabled={!!busy} aria-label="API-Schlüssel entfernen" onClick={() => void clearKey()}>Entfernen</button>
            : <button className="plain tint" aria-expanded={offen === 'key'} onClick={() => setOffen(offen === 'key' ? null : 'key')}>Schlüssel eingeben</button>}>
          {s.key ? `Hinterlegt, verschlüsselt auf diesem Rechner. Hat Vorrang vor Claude Code.${keyInfo === 'ungeprüft' ? ' Prüfen ging gerade nicht, weil keine Internetverbindung bestand.' : ''}`
            : 'Ohne Abo: Du zahlst bei Anthropic nur, was die KI tatsächlich arbeitet.'}
          {!s.key && offen === 'key' && (
            <ol className="setup-anleitung">
              <li><button className="pill" onClick={() => void window.api.openHilfe('api-keys')}>Anthropic-Konsole öffnen <ExternalLink size={13} /></button> und dich anmelden oder ein Konto anlegen.</li>
              <li>Unter „Billing“ etwas Guthaben aufladen.</li>
              <li>Unter „API keys“ auf „Create key“ klicken und den Schlüssel kopieren. Er wird nur einmal angezeigt.</li>
              <li>
                Hier einfügen:
                <form className="setup-key" onSubmit={(e) => { e.preventDefault(); if (key.trim()) void saveKey() }}>
                  <KeyRound size={15} />
                  <input type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="API-Schlüssel" />
                  <button className="pill tint" disabled={!key.trim() || !!busy}>{busy === 'key' ? <><Spin />Prüfe …</> : 'Prüfen und speichern'}</button>
                </form>
              </li>
            </ol>
          )}
        </Row>
      </Group>
      {(err || zusatz.err || ladeFehler) && <p className="error" role="alert">{err || zusatz.err || ladeFehler}</p>}
    </>
  )
}

export function KiSection({ model, onModel, onChanged }: SectionProps) {
  const choices = useContext(ChatChoices)
  const groups = [
    ...(!choices || choices.claude ? [{ label: 'Claude', items: [AUTO_CHOICE, ...MODELS].map((m) => ({ id: m.id as string, name: m.name as string, hint: m.hint as string | undefined })) }] : []),
    ...(choices?.vibe.length ? [{ label: 'Vibe (Mistral)', items: choices.vibe }] : []),
    ...(choices?.codex.length ? [{ label: 'Codex (OpenAI)', items: choices.codex }] : []),
  ]
  return (
    <>
      <Head title="KI-Zugang" sub="Deckwerk denkt mit einer KI, die du schon hast oder schnell einrichtest. Ein Zugang reicht." />
      <KiZugang model={model} onModel={onModel} onChanged={onChanged} />
      <h3 className="ki-titel">Modell</h3>
      <p className="ki-hinweis">Das Modell bestimmt auch, ob der Chat über Claude, Vibe oder Codex läuft. Du kannst es an der KI-Leiste jederzeit wechseln.</p>
      {groups.map((g) => (
        <div key={g.label} className="setup-choice" role="radiogroup" aria-label={g.label}>
          <p className="setup-group">{g.label}</p>
          {g.items.map((m) => (
            <button key={m.id} role="radio" aria-checked={model === m.id} className={`setup-opt ${model === m.id ? 'on' : ''}`} onClick={() => onModel(m.id)}>
              {model === m.id ? <Ok /> : <span className="setup-num" />}
              <span><b>{m.name}</b>{m.hint}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  )
}
