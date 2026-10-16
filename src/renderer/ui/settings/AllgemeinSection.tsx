// Allgemein: Version, Speicherort, Rechtschreibprüfung, Datenschutz, Hinweis auf die Tastenkürzel.
import { useEffect, useState } from 'react'
import type { AppInfo, UpdateInfo } from '../../../preload'
import { Switch } from '../kit'
import { Logo } from '../Logo'
import { Befehl, Group, Head, MAC, Row, Spin, TERMINAL, useRun, type SectionProps } from './parts'

const OS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' } // app:info liefert „linux x64“
// macOS-Ausgabe (eigenes Repo, nur der laufende Stand „latest“ ohne Versionsnummer): kein Versionsvergleich, ihr Installer aktualisiert
const MAC_UPDATE = 'curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk-macos/main/install.sh | sh'

export function AllgemeinSection({ go }: SectionProps) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [spell, setSpell] = useState(true)
  const [upd, setUpd] = useState<UpdateInfo | null>(null)
  const { busy, err, run } = useRun<'suche' | 'update'>()
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
        {MAC ? (
          <Row title="Updates">
            <span>Die neueste Version installierst du im Terminal ({TERMINAL}). Deckwerk startet dabei neu, deine Decks bleiben:</span>
            <Befehl text={MAC_UPDATE} />
          </Row>
        ) : <Row
          title="Updates"
          action={upd?.newer && upd.canInstall
            ? <button type="button" className="pill tint" disabled={!!busy} onClick={() => void run('update', () => window.api.installUpdate())}>{busy === 'update' ? <><Spin />Aktualisiere …</> : `Auf ${upd.latest} aktualisieren`}</button>
            : <button type="button" className="pill" disabled={!!busy} onClick={() => void run('suche', async () => setUpd(await window.api.checkUpdate()))}>{busy === 'suche' ? <><Spin />Suche …</> : 'Nach Updates suchen'}</button>}
        >
          {!upd ? 'Deckwerk fragt nur auf Knopfdruck bei GitHub nach, nie von selbst.'
            : !upd.newer ? `Du hast die neueste Version (${upd.current}).`
            : upd.canInstall ? `Version ${upd.latest} ist da. Deckwerk ersetzt sich selbst und startet neu, deine Decks bleiben.`
            : <>Version {upd.latest} ist da. Im Terminal aktualisierst du mit <code>deckwerk update</code>.</>}
        </Row>}
        {err && <p className="error" role="alert">{err}</p>}
      </Group>
      <Group label="Speicherort">
        <Row title={<code>{info?.home ?? '…'}</code>} action={<button type="button" className="pill" onClick={() => void window.api.openHome()}>Ordner öffnen</button>}>
          Decks liegen als Dateien auf diesem Rechner, alte Stände unter versions/.
        </Row>
      </Group>
      <Group label="Editor">
        <div className="setup-opt settings-row">
          {/* macOS prüft mit dem System, sonst lädt Electron Hunspell-Wörterbücher vom Google-CDN */}
          <Switch checked={spell} label={<b>Rechtschreibprüfung</b>} onChange={(on) => { setSpell(on); window.api.setSpellcheck(on).catch(() => setSpell(!on)) }}
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
      <Group label="Modelle und Lizenzen">
        <Row title="Spracherkennung">Parakeet-TDT-0.6B-v3 von NVIDIA (CC BY 4.0), ausgeführt mit sherpa-onnx (Apache-2.0).</Row>
        <Row title="Videoanalyse">Silero VAD (MIT), CED (Apache-2.0), YuNet (MIT).</Row>
        <Row title="Video laden">yt-dlp (Unlicense), TwitchDownloader (MIT).</Row>
        <Row title="Musik">Von Openverse; der Nachweis steht im Deck.</Row>
      </Group>
      <Group label="Tastenkürzel">
        <Row title="Übersicht">Im Editor <kbd>?</kbd> drücken.</Row>
      </Group>
    </>
  )
}
