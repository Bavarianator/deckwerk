// Erscheint, wenn ein Wunsch ohne KI-Zugang abgeschickt wird: führt zur Einrichtung oder nimmt direkt einen Anthropic-API-Schlüssel
// (wird im Main-Prozess geprüft und verschlüsselt gespeichert).
import { useEffect, useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'

export function KeyDialog({ onSave, onSetup, onClose }: { onSave: (key: string) => Promise<void>; onSetup: () => void; onClose: () => void }) {
  const [key, setKey] = useState('')
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { ref.current?.showModal() }, [])

  const save = async () => {
    setSaving(true)
    try {
      await onSave(key)
      onClose()
    } catch (e) {
      setErr((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose}>
      <form onSubmit={(e) => (e.preventDefault(), save())}>
        <h2><KeyRound size={18} /> Deckwerk braucht noch eine KI</h2>
        <p className="muted">
          Das geht mit deinem Claude- oder ChatGPT-Abo oder mit einem API-Schlüssel von Anthropic. Die Einrichtung führt dich Schritt
          für Schritt hin.
        </p>
        <button type="button" className="btn primary" onClick={onSetup}>Einrichtung öffnen</button>
        <p className="muted">Schlüssel schon zur Hand? Dann hier einfügen. Er wird geprüft und verschlüsselt auf diesem Rechner gespeichert.</p>
        <input type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="API-Schlüssel" />
        {err && <p className="error" role="alert">{err}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Später</button>
          <button type="submit" className="btn" disabled={!key.trim() || saving}>{saving ? 'Prüfe …' : 'Prüfen und speichern'}</button>
        </div>
      </form>
    </dialog>
  )
}
