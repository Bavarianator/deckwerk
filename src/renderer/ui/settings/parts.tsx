// Gemeinsame Bausteine der Einstellungen und der Einrichtung: Abschnitte, Öffner, Befehl zum Kopieren, Statuszeichen, Fehlerbehandlung.
import { createContext, useState, type ReactNode } from 'react'
import { Check, Copy, LoaderCircle } from 'lucide-react'
import type { ChatCli } from '../../../preload'

export type SectionId = 'ki' | 'cloud' | 'bilder' | 'marke' | 'agenten' | 'allgemein'
/** model/onModel: Chat-Modell der App; onChanged: KI-Zugang geändert (App lädt hasKey und Modell-Liste neu); go: anderen Abschnitt zeigen */
export interface SectionProps { model: string; onModel: (id: string) => void; onChanged: () => void; go: (s: SectionId) => void }

/** Öffnet die Einstellungen (optional bei einem Abschnitt); App stellt die Funktion bereit */
export const OpenSettings = createContext<(s?: SectionId) => void>(() => {})

export const TERMINAL = navigator.userAgent.includes('Mac') ? 'Programme → Dienstprogramme → Terminal' : 'meist mit Strg+Alt+T'
export const CLAUDE_NATIV = 'curl -fsSL https://claude.ai/install.sh | bash' // nativer Installer von Anthropic, braucht kein Node.js
export const INSTALL: Record<ChatCli, string> = {
  claude: CLAUDE_NATIV,
  codex: 'npm install -g @openai/codex',
  vibe: 'uv tool install mistral-vibe',
}

export const Ok = () => <span className="setup-ok" aria-label="erledigt"><Check size={14} strokeWidth={3} /></span>
export const Spin = () => <LoaderCircle size={14} className="spin" />

// Befehl zum Abtippen sparen: Code plus Kopieren-Knopf
export function Befehl({ text }: { text: string }) {
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

// Kopf eines Abschnitts: Titel und ein Satz, worum es geht
export function Head({ title, sub }: { title: string; sub?: ReactNode }) {
  return <header className="settings-head"><h2 id="settings-title">{title}</h2>{sub && <p>{sub}</p>}</header>
}

// Weiße Liste mit Überschrift (wie in der Einrichtung)
export function Group({ label, children }: { label?: string; children: ReactNode }) {
  return <div className="setup-choice">{label && <p className="setup-group">{label}</p>}{children}</div>
}

// Zeile einer Liste: Haken (ok) oder leerer Kreis (false) bzw. nichts (undefined), Titel, Text darunter, Knöpfe rechts
export function Row({ ok, title, children, action }: { ok?: boolean; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="setup-opt settings-row">
      {ok ? <Ok /> : ok === false ? <span className="setup-num" /> : null}
      <span className="settings-row-text"><b>{title}</b>{children}</span>
      {action && <span className="settings-act">{action}</span>}
    </div>
  )
}

// Eine Aktion zur Zeit: busy nennt sie, err die Meldung ohne Electron-Präfix
export function useRun<T extends string>() {
  const [busy, setBusy] = useState<T | ''>('')
  const [err, setErr] = useState('')
  const run = async (what: T, fn: () => Promise<void>) => {
    setBusy(what)
    setErr('')
    try { await fn() } catch (e) { setErr((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
    setBusy('')
  }
  return { busy, err, setErr, run }
}
