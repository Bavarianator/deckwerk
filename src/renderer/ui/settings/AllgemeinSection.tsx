// Allgemein: Version, Speicherort, Datenschutz, Hinweis auf die Tastenkürzel.
import { useEffect, useState } from 'react'
import type { AppInfo } from '../../../preload'
import { Logo } from '../Logo'
import { Group, Head, Row, type SectionProps } from './parts'

const OS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' } // app:info liefert „linux x64“

export function AllgemeinSection({ go }: SectionProps) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => { void window.api.appInfo().then(setInfo) }, [])
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
