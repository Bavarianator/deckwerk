// Dialog zum Eintragen des Anthropic-API-Keys (wird im Main-Prozess verschlüsselt gespeichert).
import { useEffect, useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'

export function KeyDialog({ onSave, onClose }: { onSave: (key: string) => Promise<void>; onClose: () => void }) {
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
        <h2><KeyRound size={18} /> Anthropic-API-Key</h2>
        <p className="muted">
          Deckwerk braucht einen API-Key für die KI. Er wird verschlüsselt auf diesem Rechner gespeichert und verlässt den
          Hauptprozess nicht. Alternativ kannst du die Umgebungsvariable ANTHROPIC_API_KEY setzen.
        </p>
        <input type="password" autoFocus placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} aria-label="API-Key" />
        {err && <p className="error" role="alert">{err}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => ref.current?.close()}>Später</button>
          <button type="submit" className="btn primary" disabled={!key.trim() || saving}>Speichern</button>
        </div>
      </form>
    </dialog>
  )
}
