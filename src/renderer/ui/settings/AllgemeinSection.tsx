// Allgemein: Version, Speicherort, Rechtschreibprüfung, Datenschutz, Hinweis auf die Tastenkürzel.
import { useEffect, useState } from 'react'
import type { AppInfo } from '../../../preload'
import { Switch } from '../kit'
import { Logo } from '../Logo'
import { Group, Head, Row, type SectionProps } from './parts'

const OS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' } // app:info liefert „linux x64“

export function AllgemeinSection({ go }: SectionProps) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [spell, setSpell] = useState(true)
  useEffect(() => { void window.api.appInfo().then(setInfo); void window.api.spellcheck().then(setSpell) }, [])
  return (
    <>
      <Head title="Allgemein" />
      <Group label="Über Deckwerk">
        <div className="setup-opt settings-row">
          <Logo size={40} />
          <span className="settings-row-text">
            <b>Deckwerk {info?.version}</b>
            {info && `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node} · ${info.platform.replace(/^\S+/, (p) => OS[p] ?? p)}`}
          </span>
        </div>
      </Group>
      <Group label="Speicherort">
        <Row title={<code>{info?.home ?? '…'}</code>} action={<button type="button" className="pill" onClick={() => void window.api.openHome()}>Ordner öffnen</button>}>
          Decks liegen als Dateien auf diesem Rechner, alte Stände unter versions/.
        </Row>
      </Group>
      <Group label="Editor">
        <div className="setup-opt settings-row">
          {/* macOS prüft mit dem System, sonst lädt Electron Hunspell-Wörterbücher vom Google-CDN */}
          <Switch checked={spell} label={<b>Rechtschreibprüfung</b>} onChange={(on) => { setSpell(on); void window.api.setSpellcheck(on) }}
            hint={info?.platform.startsWith('darwin') ? 'Deutsch und Englisch, mit der Rechtschreibprüfung von macOS.' : 'Deutsch und Englisch. Die Wörterbücher lädt Deckwerk einmalig von einem Google-Server herunter.'} />
        </div>
      </Group>
      <Group label="Datenschutz">
        <Row title="Kein Konto">Deckwerk hat kein Konto bei uns.</Row>
        <Row title="Deine Texte" action={<button type="button" className="plain tint" onClick={() => go('ki')}>KI-Zugang</button>}>
          Sie gehen nur an die KI, die du unter KI-Zugang wählst.
        </Row>
        <Row title="Schlüssel und Passwörter">Liegen verschlüsselt auf diesem Rechner.</Row>
      </Group>
      <Group label="Tastenkürzel">
        <Row title="Übersicht">Im Editor <kbd>?</kbd> drücken.</Row>
      </Group>
    </>
  )
}
