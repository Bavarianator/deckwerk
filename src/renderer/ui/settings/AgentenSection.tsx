// Agenten: Deckwerk als MCP-Server in Claude Code, Codex und Vibe eintragen, die Verbindung testen, Beispiel-Prompts zum Kopieren.
import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { ChatCli, CliStatus } from '../../../preload'
import { Befehl, Group, Head, INSTALL, Row, Spin, TERMINAL, useRun, type SectionProps } from './parts'

const LOGIN: Record<ChatCli, string> = { claude: 'claude', codex: 'codex login', vibe: 'vibe --setup' }
const PROMPTS = [
  'Erstelle mit Deckwerk einen 10-Folien-Pitch für mein Projekt aus der README.',
  'Mach aus docs/quartal.md mit Deckwerk ein Update für die Geschäftsführung.',
  'Öffne mein letztes Deckwerk-Deck und kürze Folie 4.',
]

export function AgentenSection(_: SectionProps) {
  const { busy, err, run } = useRun<'all' | 'test' | ChatCli>()
  const [clis, setClis] = useState<CliStatus[] | null>(null)
  const [tools, setTools] = useState<number | null>(null)
  const [copied, setCopied] = useState(-1)
  const load = () => window.api.setupStatus().then((s) => setClis(s.clis))
  useEffect(() => { void load() }, [])

  const open = clis?.filter((c) => c.found && !c.mcp) ?? [] // gefunden, aber Deckwerk noch nicht eingetragen
  const install = (cli: ChatCli) => run(cli, async () => { await window.api.setupMcp(cli); await load() })
  const installAll = () => run('all', async () => { for (const c of open) await window.api.setupMcp(c.id); await load() })
  const test = () => run('test', async () => { setTools(null); setTools(await window.api.setupMcpTest()) })
  const copy = (i: number) => { void navigator.clipboard.writeText(PROMPTS[i]); setCopied(i) }
  const mcp = clis?.filter((c) => c.mcp).map((c) => c.name).join(', ') // wo Deckwerk eingetragen ist

  return (
    <>
      <Head title="Agenten" sub="Claude Code, Codex und Vibe bekommen die Werkzeuge von Deckwerk und bauen Decks direkt aus dem Terminal, in jedem Projekt. Claude Code und Codex lernen dazu per Skill den Arbeitsablauf." />
      {open.length > 1 && (
        <button type="button" className="pill tint" disabled={!!busy} onClick={() => void installAll()}>
          {busy === 'all' ? <><Spin />Richte ein …</> : `In allen einrichten (${open.map((c) => c.name).join(', ')})`}
        </button>
      )}
      {!clis ? <p><Spin /> Wird geprüft …</p> : (
        <Group label="Agenten auf diesem Rechner">
          {clis.map((c) => !c.found ? (
            <Row key={c.id} ok={false} title={c.name} action={<button type="button" className="plain" disabled={!!busy} onClick={() => void load()}>Erneut prüfen</button>}>
              <span>Nicht installiert. Im Terminal ({TERMINAL}) installieren, dann einmal <code>{LOGIN[c.id]}</code> starten und anmelden:</span>
              <Befehl text={INSTALL[c.id]} />
            </Row>
          ) : c.mcp ? (
            <Row key={c.id} ok title={c.name}>Eingerichtet. Deckwerk steht dort für alle Projekte bereit.</Row>
          ) : (
            <Row key={c.id} ok={false} title={c.name}
              action={<button type="button" className="pill tint" disabled={!!busy} onClick={() => void install(c.id)}>{busy === c.id ? <><Spin />Richte ein …</> : `In ${c.name} einrichten`}</button>}>
              Ein Klick trägt Deckwerk als MCP-Server ein.
            </Row>
          ))}
        </Group>
      )}
      <Group label="Verbindung testen">
        <Row ok={tools ? true : undefined} title={tools ? 'Läuft' : 'Server prüfen'}
          action={<button type="button" className="pill" disabled={busy === 'test'} onClick={() => void test()}>{busy === 'test' ? <><Spin />Teste …</> : tools ? 'Erneut testen' : 'Jetzt testen'}</button>}>
          {tools ? `${tools} Werkzeuge sind bereit, von „Deck anlegen“ bis „Exportieren“.`
            : 'Deckwerk startet den Server so, wie deine Agenten es tun, und fragt die Werkzeuge ab. Dauert etwa zehn Sekunden.'}
        </Row>
      </Group>
      <p className="settings-note">{mcp ? `Starte in ${mcp} eine neue Sitzung, damit Deckwerk dort geladen wird. Dann zum Beispiel:` : 'In Claude Code, Codex oder Vibe zum Beispiel:'}</p>
      <div className="setup-prompts">
        {PROMPTS.map((p, i) => (
          <button key={p} type="button" className="setup-prompt" onClick={() => copy(i)} title="Kopieren">
            <span>„{p}“</span>{copied === i ? <Check size={14} /> : <Copy size={14} />}
          </button>
        ))}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
    </>
  )
}
