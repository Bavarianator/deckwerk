// Einrichtung beim ersten Start (und später über das Zahnrad). Kurz für alle: Willkommen → KI-Zugang (geführt: Claude-Abo, ChatGPT-Abo
// oder API-Schlüssel) → Fertig. „Mehr Einstellungen“ ergänzt Modell → Agenten (Claude Code, Codex, Vibe) → Verbindung testen →
// Bilder (KI-Bilder über Mammouth, OpenAI oder Codex) → Cloud (WebDAV-Sync). Jeder Schritt zeigt, was schon erledigt ist; nichts davon ist Pflicht.
import { useContext, useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Cloud, Copy, ExternalLink, FileDown, HardDrive, KeyRound, LoaderCircle, MousePointerClick, Sparkles, Wand2 } from 'lucide-react'
import { AUTO, AUTO_CHOICE, MODELS, routeOf } from '../../shared/models'
import { ChatChoices } from './Chat'
import { Select } from './kit'
import { Logo } from './Logo'
import type { ChatCli, CliStatus, ImageProvider, ImageStatus, SyncStatus } from '../../preload'

type Status = { key: boolean; clis: CliStatus[] }
const ALLE = ['Willkommen', 'KI-Zugang', 'Modell', 'Agenten', 'Testen', 'Bilder', 'Cloud', 'Fertig']
const KURZ = ['Willkommen', 'KI-Zugang', 'Fertig'] // der Rest steckt unter „Mehr Einstellungen“ (gemerkt pro Rechner)
const TERMINAL = navigator.userAgent.includes('Mac') ? 'Programme → Dienstprogramme → Terminal' : 'meist mit Strg+Alt+T'
const CLAUDE_NATIV = 'curl -fsSL https://claude.ai/install.sh | bash' // nativer Installer von Anthropic, braucht kein Node.js
type Weg = 'claude' | 'codex' | 'key'
const WEGE: { id: Weg; titel: string; text: string }[] = [
  { id: 'claude', titel: 'Ich habe ein Claude-Abo', text: 'Pro oder Max: Deckwerk nutzt dein Abo über Claude Code, ohne Extrakosten.' },
  { id: 'codex', titel: 'Ich habe ein ChatGPT-Abo', text: 'Plus oder Pro: Deckwerk nutzt dein Abo über Codex.' },
  { id: 'key', titel: 'Ich nehme einen API-Schlüssel', text: 'Ohne Abo: Du zahlst bei Anthropic nur, was die KI tatsächlich arbeitet.' },
]
const merken = (an?: boolean) => { try { if (an !== undefined) localStorage.setItem('setup-mehr', an ? '1' : '0'); return localStorage.getItem('setup-mehr') === '1' } catch { return !!an } }

// Befehl zum Abtippen sparen: Code plus Kopieren-Knopf
function Befehl({ text }: { text: string }) {
  const [kopiert, setKopiert] = useState(false)
  return (
    <span className="setup-befehl">
      <code>{text}</code>
      <button type="button" className="pill" onClick={() => { void navigator.clipboard.writeText(text); setKopiert(true) }}>
        {kopiert ? <Check size={13} /> : <Copy size={13} />}{kopiert ? 'Kopiert' : 'Kopieren'}
      </button>
    </span>
  )
}
const IMG_APIS = [
  { id: 'mammouth', name: 'Mammouth', env: 'MAMMOUTH_API_KEY', placeholder: 'sk-…', hint: 'API-Key aus deinem Mammouth-Konto: ein Abo, viele Bildmodelle.' },
  { id: 'openai', name: 'OpenAI', env: 'OPENAI_API_KEY', placeholder: 'sk-…', hint: 'API-Key von platform.openai.com, abgerechnet pro Bild.' },
] as const
const IMAGE_MODELS = ['gpt-image-2', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview']
const INSTALL: Record<ChatCli, string> = {
  claude: CLAUDE_NATIV,
  codex: 'npm install -g @openai/codex',
  vibe: 'uv tool install mistral-vibe',
}
const LOGIN: Record<ChatCli, string> = { claude: 'claude', codex: 'codex login', vibe: 'vibe --setup' }
const PROMPTS = [
  'Erstelle mit Deckwerk einen 10-Folien-Pitch für mein Projekt aus der README.',
  'Mach aus docs/quartal.md mit Deckwerk ein Update für die Geschäftsführung.',
  'Öffne mein letztes Deckwerk-Deck und kürze Folie 4.',
]

/** start: Schritt, mit dem die Einrichtung aufgeht (z. B. „KI-Zugang“ aus dem Key-Dialog) */
interface Props { model: string; onModel: (id: string) => void; onKeySaved: () => void; onClose: () => void; start?: string }

export function SetupSheet({ model, onModel, onKeySaved, onClose, start }: Props) {
  const [mehr, setMehr] = useState(() => merken())
  const steps = mehr ? ALLE : KURZ
  const [step, setStep] = useState(() => Math.max(0, steps.indexOf(start ?? '')))
  const toggleMehr = () => { const neu = !mehr; merken(neu); setMehr(neu); setStep(Math.max(0, (neu ? ALLE : KURZ).indexOf(steps[step]))) }
  const [s, setS] = useState<Status | null>(null)
  const [weg, setWeg] = useState<Weg | null>(null)
  const [andere, setAndere] = useState(false) // schon startklar: weitere Wege erst auf Klick zeigen
  const [keyInfo, setKeyInfo] = useState<'' | 'geprüft' | 'ungeprüft'>('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'' | 'key' | 'test' | 'all' | 'img' | 'sync' | ChatCli>('')
  const [err, setErr] = useState('')
  const [tools, setTools] = useState<number | null>(null)
  const [copied, setCopied] = useState(-1)
  const [img, setImg] = useState<ImageStatus | null>(null)
  const [imgKeys, setImgKeys] = useState({ mammouth: '', openai: '' })
  const [imgModel, setImgModel] = useState('')
  const showImg = (x: ImageStatus) => { setImg(x); setImgModel(x.model) }
  const load = () => window.api.setupStatus().then(setS)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [dav, setDav] = useState({ url: '', user: '', pass: '' })
  useEffect(() => { void load(); void window.api.imageSettings().then(showImg); void window.api.syncStatus().then((x) => { setSync(x); setDav({ url: x.url, user: x.user, pass: '' }) }) }, [])
  useEffect(() => window.api.onSync(setSync), [])
  useEffect(() => setErr(''), [step])

  const run = async (what: typeof busy, fn: () => Promise<void>) => {
    setBusy(what)
    setErr('')
    try { await fn() } catch (e) { setErr((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
    setBusy('')
  }
  const saveKey = () => run('key', async () => { setKeyInfo(await window.api.setApiKey(key)); setKey(''); onKeySaved(); await load() })
  const saveSync = (off = false) => run('sync', async () => { setSync(await window.api.setSync(off ? null : dav)); setDav((d) => (off ? { url: '', user: '', pass: '' } : { ...d, pass: '' })) })
  const saveImg = (patch: Parameters<typeof window.api.setImageSettings>[0]) => run('img', async () => showImg(await window.api.setImageSettings(patch)))
  const install = (cli: ChatCli) => run(cli, async () => { await window.api.setupMcp(cli); await load() })
  const open = s?.clis.filter((c) => c.found && !c.mcp) ?? [] // gefunden, aber Deckwerk noch nicht eingetragen
  const installAll = () => run('all', async () => { for (const c of open) await window.api.setupMcp(c.id); await load() })
  // Chat-Weg = Gruppe im Modell-Dropdown: Klick auf ein CLI wählt dessen erstes Modell (Claude: das bisherige Claude-Modell)
  const choices = useContext(ChatChoices)
  const kind = routeOf(model)?.cli ?? 'claude'
  const useCli = (cli: ChatCli) => onModel(cli === 'claude' ? (kind === 'claude' ? model : AUTO) : choices?.[cli][0]?.id ?? `${cli}:`)
  const groups = [
    ...(!choices || choices.claude ? [{ label: 'Claude', items: [AUTO_CHOICE, ...MODELS].map((m) => ({ id: m.id as string, name: m.name as string, hint: m.hint as string | undefined })) }] : []),
    ...(choices?.vibe.length ? [{ label: 'Vibe (Mistral)', items: choices.vibe }] : []),
    ...(choices?.codex.length ? [{ label: 'Codex (OpenAI)', items: choices.codex }] : []),
  ]
  const test = () => run('test', async () => { setTools(null); setTools(await window.api.setupMcpTest()) })
  const copy = (i: number) => { void navigator.clipboard.writeText(PROMPTS[i]); setCopied(i) }
  const next = () => setStep((x) => Math.min(steps.length - 1, x + 1))
  const on = (cli: ChatCli) => kind === cli && !(cli === 'claude' && s?.key) // Claude mit Key läuft über die API
  const gefunden = s?.clis.filter((c) => c.found) ?? []
  const aktiv = s?.key ? null : gefunden.find((c) => c.id === kind && c.login !== false) // CLI, über das der Chat läuft
  const bereit = !!s?.key || !!aktiv
  // Noch kein Zugang: alle paar Sekunden nachsehen, damit ein frisch installiertes CLI von selbst auftaucht …
  const zugang = steps[step] === 'KI-Zugang'
  useEffect(() => {
    if (!zugang || bereit) return
    const t = setInterval(() => void load(), 4000)
    return () => clearInterval(t)
  }, [zugang, bereit])
  // … und es dann gleich als Chat-Weg wählen
  useEffect(() => {
    const c = !bereit && gefunden.find((x) => x.login !== false)
    if (c) useCli(c.id)
  }, [s])
  const mcp = s?.clis.filter((c) => c.mcp).map((c) => c.name).join(', ') // wo Deckwerk eingetragen ist
  const codex = s?.clis.find((c) => c.id === 'codex'), codexReady = !!codex?.found && codex.login !== false
  const ok = <span className="setup-ok" aria-label="erledigt"><Check size={14} strokeWidth={3} /></span>
  const spin = <LoaderCircle size={14} className="spin" />

  const pages: ReactNode[] = [
    <>
      <Logo size={56} />
      <h1 id="setup-title">Willkommen bei Deckwerk</h1>
      <p className="setup-sub">Sag in einem Satz, was du zeigen willst. Deckwerk baut daraus eine fertige Präsentation.</p>
      <ul className="setup-feats">
        <li><Wand2 size={18} /><span><b>Aus einem Satz eine Präsentation</b>Deckwerk denkt sich die Geschichte aus, gestaltet die Folien und prüft jede einzelne.</span></li>
        <li><MousePointerClick size={18} /><span><b>Alles bleibt änderbar</b>Klick auf eine Folie und ändere Text, Bilder und Farben, oder sag einfach, was anders sein soll.</span></li>
        <li><FileDown size={18} /><span><b>Als PowerPoint oder PDF</b>Weitergeben, weiterbearbeiten oder direkt aus Deckwerk vortragen.</span></li>
        <li><HardDrive size={18} /><span><b>Deine Dateien bleiben bei dir</b>Präsentationen liegen als Datei auf deinem Rechner. Ein Konto bei uns gibt es nicht.</span></li>
      </ul>
    </>,
    <>
      <h1 id="setup-title">Woher kommt die KI?</h1>
      <p className="setup-sub">Deckwerk denkt mit einer KI, die du schon hast oder schnell einrichtest. Ein Weg reicht, ändern kannst du ihn jederzeit.</p>
      {!s ? <p>{spin} Wird geprüft …</p> : bereit && (
        <div className="setup-box done">{ok}<span><b>Startklar.</b> {s.key ? 'Deckwerk nutzt deinen API-Schlüssel.' : `Deckwerk nutzt dein ${aktiv!.name.replace(/ /g, '-')}-Login.`}
          {aktiv?.id === 'claude' && <> Falls Claude Code noch nach der Anmeldung fragt: einmal <code>claude</code> im Terminal starten.</>}</span></div>
      )}
      {gefunden.length > 0 && (
        <div className="setup-choice" role="radiogroup" aria-label="Chat über">
          <p className="setup-group">Auf diesem Rechner gefunden</p>
          {gefunden.map((c) => (
            <button key={c.id} role="radio" aria-checked={on(c.id)} className={`setup-opt ${on(c.id) ? 'on' : ''}`} onClick={() => useCli(c.id)}>
              {on(c.id) ? ok : <span className="setup-num" />}
              <span><b>{c.name}</b><span>{c.login === false ? <>Noch nicht angemeldet. Einmal im Terminal <code>{LOGIN[c.id]}</code> eingeben.</>
                : s?.key && c.id === 'claude' ? 'Der API-Schlüssel hat Vorrang.' : on(c.id) ? 'Der Chat läuft über dein Abo.' : 'Anklicken, um den Chat darüber zu führen.'}</span></span>
            </button>
          ))}
        </div>
      )}
      {bereit && !andere ? <button className="plain tint" onClick={() => setAndere(true)}>Einen anderen Zugang einrichten</button> : (
        <div className="setup-choice" role="radiogroup" aria-label="Weg zur KI">
          <p className="setup-group">{bereit ? 'Einen anderen Zugang einrichten' : 'Noch kein Zugang? Wähle, was auf dich zutrifft'}</p>
          {WEGE.map((w) => {
            const fertig = w.id === 'key' ? s?.key : gefunden.some((c) => c.id === w.id && c.login !== false)
            return (
              <button key={w.id} role="radio" aria-checked={weg === w.id} className={`setup-opt ${weg === w.id ? 'on' : ''}`} onClick={() => { setErr(''); setWeg(weg === w.id ? null : w.id) }}>
                {fertig ? ok : <span className="setup-num" />}
                <span><b>{w.titel}</b>{w.text}</span>
              </button>
            )
          })}
        </div>
      )}
      {weg === 'claude' && (
        <ol className="setup-anleitung">
          <li>Ein Terminal öffnen: {TERMINAL}.</li>
          <li>Diesen Befehl einfügen und mit Enter bestätigen:<Befehl text={CLAUDE_NATIV} /></li>
          <li>Danach <code>claude</code> eingeben, Enter drücken und im Browser mit deinem Claude-Konto anmelden.</li>
          <li className="setup-status">{gefunden.some((c) => c.id === 'claude') ? <>{ok} Claude Code ist da. Deckwerk nutzt es, sobald du angemeldet bist.</> : <>{spin} Deckwerk schaut alle paar Sekunden nach und merkt es von selbst.</>}</li>
          <li className="setup-status"><button className="plain tint" onClick={() => void window.api.openHilfe('claude')}>Ausführliche Anleitung im Browser <ExternalLink size={13} /></button></li>
        </ol>
      )}
      {weg === 'codex' && (
        <ol className="setup-anleitung">
          <li>Codex braucht Node.js. Falls es fehlt: <button className="plain tint" onClick={() => void window.api.openHilfe('node')}>nodejs.org öffnen <ExternalLink size={13} /></button> und die LTS-Version installieren.</li>
          <li>Ein Terminal öffnen ({TERMINAL}), diesen Befehl einfügen und mit Enter bestätigen:<Befehl text={INSTALL.codex} /></li>
          <li>Danach <code>codex login</code> eingeben und im Browser mit deinem ChatGPT-Konto anmelden.</li>
          <li className="setup-status">{codexReady ? <>{ok} Codex ist bereit.</> : <>{spin} Deckwerk schaut alle paar Sekunden nach und merkt es von selbst.</>}</li>
        </ol>
      )}
      {weg === 'key' && (
        <ol className="setup-anleitung">
          <li><button className="pill" onClick={() => void window.api.openHilfe('api-keys')}>Anthropic-Konsole öffnen <ExternalLink size={13} /></button> und dich anmelden oder ein Konto anlegen.</li>
          <li>Unter „Billing“ etwas Guthaben aufladen.</li>
          <li>Unter „API keys“ auf „Create key“ klicken und den Schlüssel kopieren. Er wird nur einmal angezeigt.</li>
          <li>
            Hier einfügen:
            <form className="setup-key" onSubmit={(e) => { e.preventDefault(); if (key.trim()) saveKey() }}>
              <KeyRound size={15} />
              <input type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="API-Schlüssel" />
              <button className="pill tint" disabled={!key.trim() || busy === 'key'}>{busy === 'key' ? <>{spin}Prüfe …</> : 'Prüfen und speichern'}</button>
            </form>
            {s?.key && <p>{ok} {keyInfo === 'ungeprüft' ? 'Gespeichert. Prüfen ging gerade nicht, weil keine Internetverbindung bestand.' : 'Der Schlüssel ist verschlüsselt auf diesem Rechner gespeichert.'}</p>}
          </li>
        </ol>
      )}
    </>,
    <>
      <h1 id="setup-title">Welches Modell?</h1>
      <p className="setup-sub">Das Modell bestimmt auch, ob der Chat über Claude, Vibe oder Codex läuft. Du kannst es an der KI-Leiste jederzeit wechseln.</p>
      {groups.map((g) => (
        <div key={g.label} className="setup-choice" role="radiogroup" aria-label={g.label}>
          <p className="setup-group">{g.label}</p>
          {g.items.map((m) => (
            <button key={m.id} role="radio" aria-checked={model === m.id} className={`setup-opt ${model === m.id ? 'on' : ''}`} onClick={() => onModel(m.id)}>
              {model === m.id ? ok : <span className="setup-num" />}
              <span><b>{m.name}</b>{m.hint}</span>
            </button>
          ))}
        </div>
      ))}
    </>,
    <>
      <h1 id="setup-title">Deckwerk in deinen Agenten</h1>
      <p className="setup-sub">Claude Code, Codex und Vibe bekommen die Werkzeuge von Deckwerk und bauen Decks direkt aus dem Terminal, in jedem Projekt. Claude Code und Codex lernen dazu per Skill den Arbeitsablauf.</p>
      {open.length > 1 && <button className="pill tint" disabled={!!busy} onClick={installAll}>{busy === 'all' ? <>{spin}Richte ein …</> : `In allen einrichten (${open.map((c) => c.name).join(', ')})`}</button>}
      {!s ? <p>{spin} Wird geprüft …</p> : s.clis.map((c) => !c.found ? (
        <div key={c.id} className="setup-box">
          <b>{c.name} ist nicht installiert.</b>
          <p>Im Terminal installieren, dann einmal <code>{LOGIN[c.id]}</code> starten und anmelden:</p>
          <code className="setup-cmd">{INSTALL[c.id]}</code>
          <button className="pill" onClick={() => void load()}>Erneut prüfen</button>
        </div>
      ) : c.mcp ? (
        <div key={c.id} className="setup-box done">{ok}<span><b>{c.name}: eingerichtet.</b> Deckwerk steht dort für alle Projekte bereit.</span></div>
      ) : (
        <div key={c.id} className="setup-box">
          <p><b>{c.name}</b>: Ein Klick trägt Deckwerk als MCP-Server ein.</p>
          <button className="pill tint" disabled={!!busy} onClick={() => install(c.id)}>{busy === c.id ? <>{spin}Richte ein …</> : `In ${c.name} einrichten`}</button>
        </div>
      ))}
    </>,
    <>
      <h1 id="setup-title">Verbindung testen</h1>
      <p className="setup-sub">Deckwerk startet den Server so, wie deine Agenten es tun, und fragt die Werkzeuge ab.</p>
      <div className={`setup-box ${tools ? 'done' : ''}`}>
        {tools ? <>{ok}<span><b>Läuft.</b> {tools} Werkzeuge sind bereit, von „Deck anlegen“ bis „Exportieren“.</span></>
          : <>
            <p>{mcp ? 'Dauert etwa zehn Sekunden.' : 'Tipp: Richte Deckwerk zuerst in Schritt 4 ein. Der Test funktioniert aber auch ohne.'}</p>
            <button className="pill tint" disabled={busy === 'test'} onClick={test}>{busy === 'test' ? <>{spin}Teste …</> : 'Jetzt testen'}</button>
          </>}
      </div>
    </>,
    <>
      <h1 id="setup-title">Bilder per KI</h1>
      <p className="setup-sub">Die KI kann Fotos und Illustrationen für deine Folien erzeugen. Ein Zugang reicht. Keys werden verschlüsselt auf diesem Rechner gespeichert.</p>
      <div className="setup-choice">
        {IMG_APIS.map((a) => (
          <div key={a.id} className={`setup-opt ${img?.[a.id] ? 'on' : ''}`}>
            {img?.[a.id] ? ok : <span className="setup-num" />}
            <span>
              <b>{a.name}</b>
              {img?.[a.id] === 'app' ? <span>Hinterlegt. <button className="plain" disabled={!!busy} onClick={() => saveImg({ [a.id]: null })}>Entfernen</button></span>
                : img?.[a.id] === 'env' ? <span>Aus der Umgebungsvariable <code>{a.env}</code>. Ein Key hier hat Vorrang.</span> : a.hint}
              {img?.[a.id] !== 'app' && (
                <form className="setup-key" onSubmit={(e) => { e.preventDefault(); if (imgKeys[a.id].trim()) { saveImg({ [a.id]: imgKeys[a.id] }); setImgKeys((k) => ({ ...k, [a.id]: '' })) } }}>
                  <KeyRound size={15} />
                  <input type="password" placeholder={a.placeholder} value={imgKeys[a.id]} onChange={(e) => setImgKeys((k) => ({ ...k, [a.id]: e.target.value }))} aria-label={`${a.name}-API-Key`} />
                  <button className="pill tint" disabled={!imgKeys[a.id].trim() || !!busy}>{busy === 'img' ? spin : 'Speichern'}</button>
                </form>
              )}
            </span>
          </div>
        ))}
        <div className={`setup-opt ${codexReady ? 'on' : ''}`}>
          {codexReady ? ok : <span className="setup-num" />}
          <span><b>Codex</b>{!codex?.found ? 'Nicht installiert (siehe Schritt 4). Braucht keinen Key, läuft über dein ChatGPT-Abo.'
            : codex.login === false ? <span>Gefunden, aber nicht angemeldet. Einmal im Terminal <code>codex login</code> ausführen.</span>
            : 'Bereit. Braucht keinen Key, läuft über dein ChatGPT-Abo.'}</span>
        </div>
      </div>
      <div className="setup-choice">
        <div className="setup-opt">
          <span>
            <b>Bevorzugter Anbieter</b>
            <Select value={img?.provider ?? ''} disabled={!!busy} onChange={(e) => saveImg({ provider: (e.target.value || null) as ImageProvider | null })} aria-label="Bevorzugter Anbieter">
              <option value="">Automatisch: der erste eingerichtete (Mammouth, OpenAI, Codex)</option>
              <option value="mammouth">Mammouth</option>
              <option value="openai">OpenAI</option>
              <option value="codex">Codex</option>
            </Select>
          </span>
        </div>
        <div className="setup-opt">
          <span>
            <b>Modell</b>Gilt für Mammouth und OpenAI (Gemini-Modelle nur über Mammouth). Leer = gpt-image-2.
            <form className="setup-key" onSubmit={(e) => { e.preventDefault(); saveImg({ model: imgModel || null }) }}>
              <input list="image-models" placeholder="gpt-image-2" value={imgModel} onChange={(e) => setImgModel(e.target.value)} aria-label="Bildmodell" />
              <datalist id="image-models">{IMAGE_MODELS.map((m) => <option key={m} value={m} />)}</datalist>
              <button className="pill" disabled={!!busy || imgModel === (img?.model ?? '')}>Übernehmen</button>
            </form>
          </span>
        </div>
      </div>
    </>,
    <>
      <h1 id="setup-title">Cloud-Sync</h1>
      <p className="setup-sub">Deine Decks und Bilder landen im Ordner „Deckwerk“ deiner Cloud und kommen so auf andere Rechner und aufs Handy. Geht mit jedem WebDAV-Anbieter: Nextcloud, ownCloud, pCloud, Koofr, Box, Synology, MagentaCLOUD …</p>
      <div className={`setup-box ${sync?.hasPass ? 'done' : ''}`}>
        {sync?.hasPass ? <>{ok}<span><b>Verbunden mit {sync.user}.</b> {sync.busy ? 'Synchronisiert gerade …' : sync.at ? `${new Date(sync.at).toLocaleTimeString('de')}: ${sync.text}` : 'Noch kein Abgleich.'}</span></>
          : <p>Bei Nextcloud reicht die Adresse des Servers. Lege dort unter Einstellungen → Sicherheit ein <b>App-Passwort</b> an, statt dein Login-Passwort zu verwenden.</p>}
      </div>
      <form className="setup-choice" onSubmit={(e) => { e.preventDefault(); saveSync() }}>
        <div className="setup-opt"><span><b>Adresse</b>
          <span className="setup-key"><Cloud size={15} /><input placeholder="cloud.example.de oder https://…/webdav" value={dav.url} onChange={(e) => setDav({ ...dav, url: e.target.value })} aria-label="WebDAV-Adresse" /></span></span></div>
        <div className="setup-opt"><span><b>Nutzername</b>
          <span className="setup-key"><input value={dav.user} autoComplete="username" onChange={(e) => setDav({ ...dav, user: e.target.value })} aria-label="Nutzername" /></span></span></div>
        <div className="setup-opt"><span><b>App-Passwort</b>
          <span className="setup-key"><KeyRound size={15} /><input type="password" autoComplete="current-password" placeholder={sync?.hasPass ? 'gespeichert, leer lassen' : ''} value={dav.pass} onChange={(e) => setDav({ ...dav, pass: e.target.value })} aria-label="App-Passwort" /></span></span></div>
        <div className="setup-nav">
          {sync?.hasPass ? <button type="button" className="plain" disabled={!!busy} onClick={() => saveSync(true)}>Sync ausschalten</button> : <span />}
          <span>
            {sync?.hasPass && <button type="button" className="pill" disabled={!!busy || sync.busy} onClick={() => run('sync', async () => setSync(await window.api.syncRun()))}>Jetzt abgleichen</button>}{' '}
            <button className="pill tint" disabled={!!busy || !dav.url.trim() || !dav.user.trim() || (!dav.pass && !sync?.hasPass)}>{busy === 'sync' ? <>{spin}Verbinde …</> : 'Verbinden und abgleichen'}</button>
          </span>
        </div>
      </form>
    </>,
    <>
      <Logo size={56} />
      <h1 id="setup-title">{bereit ? 'Alles bereit' : 'Schau dich ruhig erst um'}</h1>
      <p className="setup-sub">{bereit
        ? 'Schreib auf dem Startbildschirm in einem Satz, was du zeigen willst, zum Beispiel „Quartalsbericht für die Geschäftsführung, 8 Folien“. Den Rest macht Deckwerk.'
        : 'Ohne KI-Zugang kannst du Vorlagen öffnen, bearbeiten, präsentieren und exportieren. Den Zugang richtest du später über das Zahnrad oben rechts ein.'}</p>
      {(mehr || mcp) && <>
        <p className="setup-sub">{mcp ? `Starte in ${mcp} eine neue Sitzung, damit Deckwerk dort geladen wird. Dann zum Beispiel:` : 'Später in Claude Code, Codex oder Vibe zum Beispiel:'}</p>
        <div className="setup-prompts">
          {PROMPTS.map((p, i) => (
            <button key={p} className="setup-prompt" onClick={() => copy(i)} title="Kopieren">
              <span>„{p}“</span>{copied === i ? <Check size={14} /> : <Copy size={14} />}
            </button>
          ))}
        </div>
      </>}
      <div className="setup-keys">
        <span><kbd>/</kbd> Wunsch an die KI</span><span><kbd>F5</kbd> Präsentieren</span><span><kbd>P</kbd> Referentenansicht</span><span><kbd>Strg</kbd>+<kbd>Z</kbd> Rückgängig</span>
      </div>
    </>,
  ]

  return (
    <div className="setup" role="dialog" aria-modal="true" aria-labelledby="setup-title"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); e.stopPropagation() }}>
      <div className="setup-card material">
        <ol className="setup-steps" aria-label="Schritte">
          {steps.map((t, i) => (
            <li key={t}><button className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>{t}</button></li>
          ))}
          <li><button className="setup-mehr" aria-pressed={mehr} title="Modell, Agenten, Bilder und Cloud" onClick={toggleMehr}>{mehr ? 'Weniger' : 'Mehr Einstellungen'}</button></li>
        </ol>
        <div className="setup-page" key={steps[step]}>{pages[ALLE.indexOf(steps[step])]}</div>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="setup-nav">
          {step > 0 ? <button className="plain" onClick={() => setStep(step - 1)}><ArrowLeft size={15} />Zurück</button> : <button className="plain" onClick={onClose}>Überspringen</button>}
          {step < steps.length - 1
            ? <button className="pill tint" onClick={next}>{step === 0 ? 'Einrichten' : 'Weiter'}</button>
            : <button className="pill tint" onClick={onClose}><Sparkles size={15} />{bereit ? 'Erstes Deck erstellen' : 'Vorlagen ansehen'}</button>}
        </div>
      </div>
    </div>
  )
}
