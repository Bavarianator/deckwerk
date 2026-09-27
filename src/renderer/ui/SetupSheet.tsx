// Einrichtung beim ersten Start (und später über das Zahnrad): Willkommen → KI-Zugang → Modell → Agenten (Claude Code, Codex, Vibe) →
// Verbindung testen → Fertig. Jeder Schritt zeigt, was schon erledigt ist; nichts davon ist Pflicht.
import { useContext, useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Check, Copy, KeyRound, LayoutGrid, LoaderCircle, Palette, Sparkles, Terminal, Wand2 } from 'lucide-react'
import { DEFAULT_MODEL, MODELS, routeOf } from '../../shared/models'
import { ChatChoices } from './Chat'
import { Logo } from './Logo'
import type { ChatCli, CliStatus } from '../../preload'

type Status = { key: boolean; clis: CliStatus[] }
const STEPS = ['Willkommen', 'KI-Zugang', 'Modell', 'Agenten', 'Testen', 'Fertig']
const INSTALL: Record<ChatCli, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  vibe: 'uv tool install mistral-vibe',
}
const LOGIN: Record<ChatCli, string> = { claude: 'claude', codex: 'codex login', vibe: 'vibe --setup' }
const PROMPTS = [
  'Erstelle mit Deckwerk einen 10-Folien-Pitch für mein Projekt aus der README.',
  'Mach aus docs/quartal.md mit Deckwerk ein Update für die Geschäftsführung.',
  'Öffne mein letztes Deckwerk-Deck und kürze Folie 4.',
]

interface Props { model: string; onModel: (id: string) => void; onKeySaved: () => void; onClose: () => void }

export function SetupSheet({ model, onModel, onKeySaved, onClose }: Props) {
  const [step, setStep] = useState(0)
  const [s, setS] = useState<Status | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'' | 'key' | 'test' | 'all' | ChatCli>('')
  const [err, setErr] = useState('')
  const [tools, setTools] = useState<number | null>(null)
  const [copied, setCopied] = useState(-1)
  const load = () => window.api.setupStatus().then(setS)
  useEffect(() => { void load() }, [])
  useEffect(() => setErr(''), [step])

  const run = async (what: typeof busy, fn: () => Promise<void>) => {
    setBusy(what)
    setErr('')
    try { await fn() } catch (e) { setErr((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
    setBusy('')
  }
  const saveKey = () => run('key', async () => { await window.api.setApiKey(key); setKey(''); onKeySaved(); await load() })
  const install = (cli: ChatCli) => run(cli, async () => { await window.api.setupMcp(cli); await load() })
  const open = s?.clis.filter((c) => c.found && !c.mcp) ?? [] // gefunden, aber Deckwerk noch nicht eingetragen
  const installAll = () => run('all', async () => { for (const c of open) await window.api.setupMcp(c.id); await load() })
  // Chat-Weg = Gruppe im Modell-Dropdown: Klick auf ein CLI wählt dessen erstes Modell (Claude: das bisherige Claude-Modell)
  const choices = useContext(ChatChoices)
  const kind = routeOf(model)?.cli ?? 'claude'
  const useCli = (cli: ChatCli) => onModel(cli === 'claude' ? (kind === 'claude' ? model : DEFAULT_MODEL) : choices?.[cli][0]?.id ?? `${cli}:`)
  const groups = [
    ...(!choices || choices.claude ? [{ label: 'Claude', items: MODELS.map((m) => ({ id: m.id as string, name: m.name as string, hint: m.hint as string | undefined })) }] : []),
    ...(choices?.vibe.length ? [{ label: 'Vibe (Mistral)', items: choices.vibe }] : []),
    ...(choices?.codex.length ? [{ label: 'Codex (OpenAI)', items: choices.codex }] : []),
  ]
  const test = () => run('test', async () => { setTools(null); setTools(await window.api.setupMcpTest()) })
  const copy = (i: number) => { void navigator.clipboard.writeText(PROMPTS[i]); setCopied(i) }
  const next = () => setStep((x) => Math.min(STEPS.length - 1, x + 1))
  const on = (cli: ChatCli) => kind === cli && !(cli === 'claude' && s?.key) // Claude mit Key läuft über die API
  const mcp = s?.clis.filter((c) => c.mcp).map((c) => c.name).join(', ') // wo Deckwerk eingetragen ist
  const ok = <span className="setup-ok" aria-label="erledigt"><Check size={14} strokeWidth={3} /></span>
  const spin = <LoaderCircle size={14} className="spin" />

  const pages: ReactNode[] = [
    <>
      <Logo size={56} />
      <h1 id="setup-title">Willkommen bei Deckwerk</h1>
      <p className="setup-sub">Ein Satz genügt. Deckwerk schreibt die Storyline, baut die Folien und prüft jede einzelne.</p>
      <ul className="setup-feats">
        <li><Wand2 size={18} /><span><b>Aus einem Satz ein Deck</b>Action Titles, Layouts, Diagramme und Animationen, geprüft als Bild.</span></li>
        <li><LayoutGrid size={18} /><span><b>Frei gestalten wie in Canva</b>Formen, Fotos, Icons und Diagramme direkt auf der Folie.</span></li>
        <li><Palette size={18} /><span><b>Ein Look für alles</b>Themes, eigene Designs von der KI, Formate von Quadrat bis A4.</span></li>
        <li><Terminal size={18} /><span><b>Auch aus Claude Code, Codex und Vibe</b>Decks direkt aus dem Terminal bauen und bearbeiten.</span></li>
      </ul>
    </>,
    <>
      <h1 id="setup-title">KI-Zugang</h1>
      <p className="setup-sub">Deckwerk arbeitet mit dem Login deines Agenten-CLIs oder mit einem Anthropic-API-Key. Ein Zugang reicht.</p>
      <div className="setup-choice" role="radiogroup" aria-label="Chat über">
        {!s ? <p>{spin} Wird geprüft …</p> : s.clis.map((c) => (
          <button key={c.id} role="radio" aria-checked={on(c.id)} disabled={!c.found}
            className={`setup-opt ${on(c.id) ? 'on' : ''}`} onClick={() => useCli(c.id)}>
            {on(c.id) ? ok : <span className="setup-num" />}
            <span><b>{c.name.replace(/ /g, '-')}-Login</b><span>{!c.found ? 'Nicht installiert (siehe Schritt 4).'
              : c.login === false ? <>Gefunden, aber nicht angemeldet. Einmal im Terminal <code>{LOGIN[c.id]}</code> ausführen.</>
              : on(c.id) ? 'Der Chat läuft über dein Abo, kein API-Key nötig.' : 'Gefunden. Anklicken, um den Chat darüber zu führen.'}</span></span>
          </button>
        ))}
        <div className={`setup-opt ${s?.key ? 'on' : ''}`}>
          {s?.key ? ok : <span className="setup-num" />}
          <span>
            <b>Anthropic-API-Key</b>
            {s?.key ? 'Hinterlegt und verschlüsselt auf diesem Rechner gespeichert. Hat Vorrang vor dem Login.' : 'Optional. Wird verschlüsselt gespeichert und verlässt den Rechner nur zur Anthropic-API.'}
            {!s?.key && (
              <form className="setup-key" onSubmit={(e) => { e.preventDefault(); if (key.trim()) saveKey() }}>
                <KeyRound size={15} />
                <input type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="API-Key" />
                <button className="pill tint" disabled={!key.trim() || busy === 'key'}>{busy === 'key' ? spin : 'Speichern'}</button>
              </form>
            )}
          </span>
        </div>
      </div>
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
      <p className="setup-sub">Claude Code, Codex und Vibe bekommen die Werkzeuge von Deckwerk und bauen Decks direkt aus dem Terminal, in jedem Projekt.</p>
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
      <Logo size={56} />
      <h1 id="setup-title">Alles bereit</h1>
      <p className="setup-sub">{mcp ? `Starte in ${mcp} eine neue Sitzung, damit Deckwerk dort geladen wird. Dann zum Beispiel:` : 'Leg auf dem Startbildschirm los. Später in Claude Code, Codex oder Vibe zum Beispiel:'}</p>
      <div className="setup-prompts">
        {PROMPTS.map((p, i) => (
          <button key={p} className="setup-prompt" onClick={() => copy(i)} title="Kopieren">
            <span>„{p}“</span>{copied === i ? <Check size={14} /> : <Copy size={14} />}
          </button>
        ))}
      </div>
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
          {STEPS.map((t, i) => (
            <li key={t}><button className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>{t}</button></li>
          ))}
        </ol>
        <div className="setup-page" key={step}>{pages[step]}</div>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="setup-nav">
          {step > 0 ? <button className="plain" onClick={() => setStep(step - 1)}><ArrowLeft size={15} />Zurück</button> : <button className="plain" onClick={onClose}>Überspringen</button>}
          {step < STEPS.length - 1
            ? <button className="pill tint" onClick={next}>{step === 0 ? 'Einrichten' : 'Weiter'}</button>
            : <button className="pill tint" onClick={onClose}><Sparkles size={15} />Erstes Deck erstellen</button>}
        </div>
      </div>
    </div>
  )
}
