// Marke: Standard-Brand-Kit (~/Deckwerk/brand.json), das jedes neue Deck der KI bekommt, und der Hausstil (~/Deckwerk/hausstil.md).
import { useEffect, useRef, useState } from 'react'
import type { BrandKit } from '../../../shared/deck'
import { confirmDialog } from '../kit'
import { Group, Head, Row, Spin, useRun, type SectionProps } from './parts'

const fileName = (src: string) => decodeURIComponent(src).split('/').pop()

export function MarkeSection(_: SectionProps) {
  const { busy, err, run } = useRun<'brand' | 'style'>()
  const [kit, setKit] = useState<BrandKit | null>() // undefined = lädt noch
  useEffect(() => { void window.api.getBrand().then(setKit) }, [])
  // Farbwähler feuern beim Ziehen laufend: erst nach Ruhe speichern, beim Schließen sofort
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pending = useRef<BrandKit | null>(null)
  const flush = () => { clearTimeout(timer.current); const b = pending.current; pending.current = null; if (b) void run('brand', () => window.api.setBrand(b)) }
  useEffect(() => flush, [])
  const save = (b: BrandKit, wait = 0) => { setKit(b); pending.current = b; clearTimeout(timer.current); timer.current = setTimeout(flush, wait) }
  const addLogo = async (k: 'logo' | 'logoDark') => { const src = await window.api.pickImage(); if (src && kit) save({ ...kit, [k]: src }) }
  const clear = async () => {
    if (!(await confirmDialog({ title: 'Standard-Marke löschen?', text: 'Neue Decks bekommen dann wieder Farben und Schriften aus dem Theme. Bestehende Decks behalten ihre Marke.', ok: 'Löschen', danger: true }))) return
    clearTimeout(timer.current)
    pending.current = null
    await run('brand', async () => { await window.api.clearBrand(); setKit(null) })
  }

  const [haus, setHaus] = useState({ text: '', saved: '' })
  // Änderungen aus dem externen Editor übernehmen, solange hier nichts Ungespeichertes steht
  useEffect(() => {
    const load = () => void window.api.getStyle().then((t) => setHaus((h) => (h.text === h.saved ? { text: t, saved: t } : h)))
    load()
    addEventListener('focus', load)
    return () => removeEventListener('focus', load)
  }, [])
  // Esc oder „Fertig“ mit ungespeichertem Text: nicht verwerfen, aber nichts überschreiben, was inzwischen im Editor geändert wurde
  const hausNow = useRef(haus)
  hausNow.current = haus
  useEffect(() => () => {
    const h = hausNow.current
    if (h.text !== h.saved) window.api.getStyle().then((t) => t === h.saved ? window.api.setStyle(h.text) : undefined).catch((e) => console.error('Hausstil nicht gespeichert', e))
  }, [])
  const writeStyle = async (t: string) => { await window.api.setStyle(t); setHaus((h) => ({ ...h, saved: t })) }
  const saveStyle = () => run('style', () => writeStyle(haus.text))
  // erst speichern, sonst sähe der Editor den alten Stand und der Fokus-Reload griffe nicht
  const openEditor = () => run('style', async () => { if (haus.text !== haus.saved) await writeStyle(haus.text); await window.api.openStyle() })

  return (
    <>
      <Head title="Marke" sub="Farben und Logo, die die KI jedem neuen Deck mitgibt, und dein Hausstil. Bestehende Decks bleiben, wie sie sind." />
      {kit === undefined ? <p><Spin /> Wird geladen …</p> : kit === null ? (
        <Group label="Brand-Kit">
          <Row ok={false} title="Noch kein Standard" action={<button className="pill tint" disabled={!!busy} onClick={() => save({ primary: '#4F52D9' })}>Mit Akzentfarbe anlegen</button>}>
            Im Look eines Decks legt „Als Standard speichern“ eins an. Oder fang hier mit einer Farbe an.
          </Row>
        </Group>
      ) : (
        <>
          <Group label="Brand-Kit">
            <Row title="Farben" action={<>
              <label className="swatch" style={{ background: kit.primary }} title="Primärfarbe">
                <input type="color" aria-label="Primärfarbe" value={kit.primary} onChange={(e) => save({ ...kit, primary: e.target.value.toUpperCase() }, 400)} />
              </label>
              <label className="swatch" style={{ background: kit.secondary ?? kit.primary }} title="Sekundärfarbe">
                <input type="color" aria-label="Sekundärfarbe" value={kit.secondary ?? kit.primary} onChange={(e) => save({ ...kit, secondary: e.target.value.toUpperCase() }, 400)} />
              </label>
            </>}>{kit.secondary ? 'Primär- und Sekundärfarbe.' : 'Primärfarbe. Die Sekundärfarbe kommt aus dem Theme, bis du eine wählst.'}</Row>
            {(['logo', 'logoDark'] as const).map((k) => {
              const src = kit[k]
              return (
                <Row key={k} title={k === 'logo' ? 'Logo' : 'Logo für dunklen Grund'}
                  action={src ? <button className="plain" disabled={!!busy} onClick={() => save({ ...kit, [k]: undefined })}>Entfernen</button>
                    : <button className="pill" disabled={!!busy} onClick={() => void addLogo(k)}>Hinzufügen</button>}>
                  {src ? <img className={`settings-logo ${k === 'logoDark' ? 'dark' : ''}`} src={src} alt={fileName(src)} title={fileName(src)} />
                    : k === 'logo' ? 'Noch keins.' : 'Für dunkle Folien. Fehlt es, nimmt Deckwerk das normale Logo.'}
                </Row>
              )
            })}
            <Row title="Schriften">
              {`Überschriften: ${kit.headFont ?? 'wie im Theme'}. Text: ${kit.bodyFont ?? 'wie im Theme'}. Schriften wählst du im Look eines Decks.`}
            </Row>
          </Group>
          <button type="button" className="plain" disabled={!!busy} onClick={() => void clear()}>Standard löschen</button>
        </>
      )}
      <Group label="Hausstil">
        <div className="settings-haus">
          <p className="settings-note">Die KI liest das vor jedem Deck. Sag im Chat „merk dir …“, dann ergänzt sie es selbst.</p>
          <textarea className="settings-style" aria-label="Hausstil" maxLength={20000} placeholder="Zum Beispiel: Wir duzen. Zahlen immer mit Quelle. Keine Anglizismen."
            value={haus.text} onChange={(e) => setHaus({ ...haus, text: e.target.value })} />
          <span className="settings-act">
            <button type="button" className="pill tint" disabled={haus.text === haus.saved || !!busy} onClick={() => void saveStyle()}>{busy === 'style' ? <><Spin />Speichere …</> : 'Speichern'}</button>
            <button type="button" className="plain tint" disabled={!!busy} onClick={() => void openEditor()}>In einem Editor öffnen</button>
          </span>
        </div>
      </Group>
      {err && <p className="error" role="alert">{err}</p>}
    </>
  )
}
