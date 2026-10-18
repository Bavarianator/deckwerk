// Allgemein: Version, Speicherort, Rechtschreibprüfung, Datenschutz, Hinweis auf die Tastenkürzel.
import { useEffect, useState } from 'react'
import type { AppInfo, UpdateInfo } from '../../../preload'
import { Switch } from '../kit'
import { Logo } from '../Logo'
import { Befehl, Group, Head, MAC, Ok, Row, Spin, TERMINAL, useRun, type SectionProps } from './parts'

const OS: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' } // app:info liefert „linux x64“
// Spracherkennungs-Modell (sherpa.ts); „Schnell“ gilt nur für Deutsch, andere Sprachen erkennt weiter Parakeet
const ASR_MODELS = [
  { id: 'parakeet', name: 'Spracherkennung: Genau', hint: 'Parakeet Ultra, 25 Sprachen. Standard.' },
  { id: 'de-schnell', name: 'Spracherkennung: Schnell', hint: 'Nur Deutsch, etwa dreimal so schnell, für sehr lange Videos und langsame Rechner. Schreibt Zahlen als Wörter und verhört sich öfter. Lädt einmalig rund 140 MB.' },
] as const
// macOS: kein Versionsvergleich, der Installer holt die DMG des neuesten Releases
const MAC_UPDATE = 'curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/install-mac.sh | sh'

export function AllgemeinSection({ go }: SectionProps) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [spell, setSpell] = useState(true)
  const [phone, setPhone] = useState<{ on: boolean; device: string | null } | null>(null)
  const [asr, setAsr] = useState<'parakeet' | 'de-schnell'>('parakeet')
  const [upd, setUpd] = useState<UpdateInfo | null>(null)
  const { busy, err, run } = useRun<'suche' | 'update'>()
  useEffect(() => { void window.api.appInfo().then(setInfo); void window.api.spellcheck().then(setSpell); void window.api.phoneStatus().then(setPhone); void window.api.asrModel().then(setAsr) }, [])
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
            : info?.platform.startsWith('win32') ? `Version ${upd.latest} ist da. Lade Deckwerk-Setup-x64.exe aus den Releases auf GitHub und installiere darüber, deine Decks bleiben.`
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
      <Group label="Video">
        <div className="setup-opt settings-row">
          <Switch checked={!!phone?.on} label={<b>Android-Handy als Rechenhilfe</b>}
            onChange={(on) => { setPhone((p) => p && { ...p, on }); window.api.setPhone(on).catch(() => setPhone((p) => p && { ...p, on: !on })) }}
            hint={`Ist ein Handy verbunden, laufen Spracherkennung und Video-Export automatisch dort, sonst auf dem PC. Ein aktuelles Handy rechnet etwa fünfmal so schnell wie ein einfacher PC. Handy per USB anschließen und in den Entwickleroptionen USB-Debugging erlauben. Beim ersten Mal überträgt Deckwerk Sprachmodell und ffmpeg (zusammen rund 800 MB), für den Export einmal das Quellvideo (die zwei zuletzt genutzten bleiben auf dem Handy). ${phone?.device ? `Verbunden: ${phone.device}.` : 'Gerade ist kein Handy verbunden, dann rechnet der PC.'}`} />
        </div>
        <div role="radiogroup" aria-label="Spracherkennung" style={{ display: 'flex', flexDirection: 'column' }}>
          {ASR_MODELS.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={asr === m.id} className={`setup-opt ${asr === m.id ? 'on' : ''}`}
              onClick={() => { const was = asr; setAsr(m.id); window.api.setAsrModel(m.id).catch(() => setAsr(was)) }}>
              {asr === m.id ? <Ok /> : <span className="setup-num" />}
              <span><b>{m.name}</b>{m.hint}</span>
            </button>
          ))}
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
        <Row title="Spracherkennung">Parakeet Ultra von moondream auf Basis von Parakeet-TDT-0.6B-v3 sowie stt_de_fastconformer_hybrid_large_pc von NVIDIA (CC BY 4.0), ausgeführt mit sherpa-onnx (Apache-2.0).</Row>
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
