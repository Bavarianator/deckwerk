// Bilder: KI-Bilder (Mammouth, OpenAI, Codex), bevorzugter Anbieter und Modell, Fotosuche (Unsplash, ohne Key Openverse).
import { useEffect, useState } from 'react'
import { ExternalLink, KeyRound } from 'lucide-react'
import type { CliStatus, ImageProvider, ImageStatus } from '../../../preload'
import { Select } from '../kit'
import { Group, Head, Row, Spin, useRun, type SectionProps } from './parts'

type KeyId = 'mammouth' | 'openai' | 'unsplash'
const KEYS: Record<KeyId, { name: string; env: string; placeholder: string; hint: string; hilfe?: 'openai' | 'unsplash' }> = {
  mammouth: { name: 'Mammouth', env: 'MAMMOUTH_API_KEY', placeholder: 'sk-…', hint: 'API-Key aus deinem Mammouth-Konto: ein Abo, viele Bildmodelle.' },
  openai: { name: 'OpenAI', env: 'OPENAI_API_KEY', placeholder: 'sk-…', hint: 'API-Key von platform.openai.com, abgerechnet pro Bild.', hilfe: 'openai' },
  unsplash: { name: 'Unsplash', env: 'UNSPLASH_ACCESS_KEY', placeholder: 'Access Key', hint: 'Ohne Key sucht Deckwerk frei lizenzierte Fotos bei Openverse. Mit einem Unsplash-Key findet es mehr und bessere.', hilfe: 'unsplash' },
}
const IMAGE_MODELS = ['gpt-image-2', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview']

export function BilderSection({ go }: SectionProps) {
  const [img, setImg] = useState<ImageStatus | null>(null)
  const [keys, setKeys] = useState<Record<KeyId, string>>({ mammouth: '', openai: '', unsplash: '' })
  const [model, setModel] = useState('')
  const [codex, setCodex] = useState<CliStatus>()
  const { busy, err, run } = useRun<KeyId | 'img'>()
  const show = (x: ImageStatus) => { setImg(x); setModel(x.model) } // Modellfeld nur beim Laden und Übernehmen setzen, sonst ginge eine Eingabe verloren
  useEffect(() => {
    void window.api.imageSettings().then(show)
    void window.api.setupStatus().then((s) => setCodex(s.clis.find((c) => c.id === 'codex')))
  }, [])
  const save = (patch: Parameters<typeof window.api.setImageSettings>[0]) => run('img', async () => setImg(await window.api.setImageSettings(patch)))
  const saveModel = () => run('img', async () => show(await window.api.setImageSettings({ model: model || null })))
  const saveKey = (id: KeyId) => run(id, async () => { setImg(await window.api.setImageSettings({ [id]: keys[id].trim() })); setKeys((k) => ({ ...k, [id]: '' })) })
  const codexReady = !!codex?.found && codex.login !== false

  const keyRow = (id: KeyId) => {
    const k = KEYS[id], von = img?.[id]
    return (
      <Row key={id} ok={!!von} title={k.name} action={von === 'app'
        ? <button type="button" className="plain" disabled={!!busy} onClick={() => void save({ [id]: null })}>Entfernen</button>
        : k.hilfe && <button type="button" className="plain tint" onClick={() => void window.api.openHilfe(k.hilfe!)}><ExternalLink size={13} />Key holen</button>}>
        {von === 'app' ? 'Hinterlegt.' : von === 'env' ? <span>Aus der Umgebungsvariable <code>{k.env}</code>. Ein Key hier hat Vorrang.</span> : k.hint}
        {von !== 'app' && (
          <form className="setup-key" onSubmit={(e) => { e.preventDefault(); if (keys[id].trim()) void saveKey(id) }}>
            <KeyRound size={15} />
            <input type="password" placeholder={k.placeholder} value={keys[id]} onChange={(e) => setKeys((x) => ({ ...x, [id]: e.target.value }))} aria-label={`${k.name}-Key`} />
            <button className="pill tint" disabled={!keys[id].trim() || !!busy}>{busy === id ? <Spin /> : 'Speichern'}</button>
          </form>
        )}
      </Row>
    )
  }

  return (
    <>
      <Head title="Bilder" sub="Die KI kann Fotos und Illustrationen für deine Folien erzeugen und passende Fotos suchen. Keys werden verschlüsselt auf diesem Rechner gespeichert." />
      <Group label="KI-Bilder (ein Zugang reicht)">
        {keyRow('mammouth')}
        {keyRow('openai')}
        <Row ok={codexReady} title="Codex" action={!codexReady && <button type="button" className="plain tint" onClick={() => go('ki')}>{codex?.found ? 'Anmelden' : 'Einrichten'}</button>}>
          {!codex?.found ? 'Nicht eingerichtet. Braucht keinen Key, läuft über dein ChatGPT-Abo.'
            : codex.login === false ? 'Gefunden, aber nicht angemeldet.'
            : 'Bereit. Braucht keinen Key, läuft über dein ChatGPT-Abo.'}
        </Row>
      </Group>
      <Group label="Anbieter und Modell">
        <Row title="Bevorzugter Anbieter">
          <Select value={img?.provider ?? ''} disabled={!!busy} onChange={(e) => void save({ provider: (e.target.value || null) as ImageProvider | null })} aria-label="Bevorzugter Anbieter">
            <option value="">Automatisch: der erste eingerichtete (Mammouth, OpenAI, Codex)</option>
            <option value="mammouth">Mammouth</option>
            <option value="openai">OpenAI</option>
            <option value="codex">Codex</option>
          </Select>
        </Row>
        <Row title="Modell">
          Gilt für Mammouth und OpenAI (Gemini-Modelle nur über Mammouth). Leer = gpt-image-2.
          <form className="setup-key" onSubmit={(e) => { e.preventDefault(); void saveModel() }}>
            <input type="text" list="image-models" placeholder="gpt-image-2" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Bildmodell" />
            <datalist id="image-models">{IMAGE_MODELS.map((m) => <option key={m} value={m} />)}</datalist>
            <button className="pill" disabled={!!busy || model === (img?.model ?? '')}>Übernehmen</button>
          </form>
        </Row>
      </Group>
      <Group label="Fotosuche">
        {keyRow('unsplash')}
      </Group>
      {err && <p className="error" role="alert">{err}</p>}
    </>
  )
}
