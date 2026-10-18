// Marke: Standard-Brand-Kit (~/Deckwerk/brand.json), das jedes neue Deck der KI bekommt, und der Hausstil (~/Deckwerk/hausstil.md).
import { APP } from '../../../shared/app-id'
import { useEffect, useRef, useState } from 'react'
import type { BrandKit } from '../../../shared/deck'
import { Select, confirmDialog } from '../kit'
import { Group, Head, Row, Spin, useRun, type SectionProps } from './parts'

const fileName = (src: string) => decodeURIComponent(src).split('/').pop()
const NEU = '\u0000neu' // Auswahl „Neuer Kunde …“, kann kein Kundenname sein

export function MarkeSection(_: SectionProps) {
  const { busy, err, run } = useRun<'brand' | 'style' | 'kunde'>()
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

  const [skipped, setSkipped] = useState<string[]>([])
  const fromPotx = () => run('brand', async () => {
    const r = await window.api.brandFromPotx()
    if (!r) return
    // Logo, dunkles Logo und Lock bleiben; Schriften, die die Vorlage nicht setzt, ebenso
    const base: BrandKit = kit ?? { primary: r.kit.primary }
    const next: BrandKit = { ...base, ...r.kit }
    setSkipped(r.skipped)
    clearTimeout(timer.current)
    pending.current = null
    setKit(next)
    await window.api.setBrand(next)
  })

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

  // Deckwerk Pro: Kunden. getBrand/getStyle und ihre Gegenstücke arbeiten auf dem aktiven Kunden; vor dem Wechsel Offenes in den bisherigen schreiben
  const [kunden, setKunden] = useState<{ list: string[]; active: string | null }>()
  const [neu, setNeu] = useState<string | null>(null) // Namensfeld für „Neuer Kunde …“
  useEffect(() => { if (APP.pro) void window.api.clients().then(setKunden) }, []) // Kunden, Firmenvorlage, Brand-Lock: nur Pro
  // Anzeige immer vom aktiven Kunden; was nicht lädt, wird nicht gezeigt, damit nichts Altes in den neuen Kunden gespeichert wird
  const reload = async () => {
    const [k, brand, style] = await Promise.allSettled([window.api.clients(), window.api.getBrand(), window.api.getStyle()])
    setKunden(k.status === 'fulfilled' ? k.value : undefined)
    setKit(brand.status === 'fulfilled' ? brand.value : undefined)
    setHaus(style.status === 'fulfilled' ? { text: style.value, saved: style.value } : { text: '', saved: '' })
    return [k, brand, style].find((r) => r.status === 'rejected')?.reason as unknown
  }
  const wechsel = (name: string | null) => run('kunde', async () => {
    clearTimeout(timer.current)
    const b = pending.current
    if (b) { await window.api.setBrand(b); if (pending.current === b) pending.current = null } // wirft setBrand, bleibt die Änderung offen
    const h = hausNow.current
    if (h.text !== h.saved) await writeStyle(h.text)
    let fail: unknown
    try { await window.api.setClient(name); setNeu(null) } catch (e) { fail = e }
    const bad = await reload() // auch nach einem Fehler: die Anzeige muss zum Stand auf der Platte passen
    if (fail ?? bad) throw fail ?? bad
  })
  const fehlt = kunden?.active && !kunden.list.includes(kunden.active) ? kunden.active : null // Marker zeigt auf einen Kunden ohne Ordner

  return (
    <>
      <Head title="Marke" sub="Farben und Logo, die die KI jedem neuen Deck mitgibt, und dein Hausstil. Bestehende Decks bleiben, wie sie sind." />
      {kunden && (
        <Group label="Kunde">
          <Row title="Aktiver Kunde" action={
            <Select value={neu === null ? kunden.active ?? '' : NEU} disabled={!!busy} aria-label="Kunde"
              onChange={(e) => (e.target.value === NEU ? setNeu('') : void wechsel(e.target.value || null))}>
              <option value="">Keiner (eigene Marke)</option>
              {kunden.list.map((k) => <option key={k} value={k}>{k}</option>)}
              <option value={NEU}>Neuer Kunde …</option>
            </Select>
          }>{fehlt ? <span className="error">Der aktive Kunde „{fehlt}“ fehlt im Kundenordner. Wähle einen Kunden oder „Keiner“.</span>
            : 'Neue Decks und die KI nutzen Marke und Hausstil des aktiven Kunden.'}</Row>
          {neu !== null && (
            <Row title="Neuer Kunde" action={<>
              <button type="button" className="pill tint" disabled={!neu.trim() || !!busy} onClick={() => void wechsel(neu.trim())}>{busy === 'kunde' ? <><Spin />Lege an …</> : 'Anlegen'}</button>
              <button type="button" className="plain" disabled={!!busy} onClick={() => setNeu(null)}>Abbrechen</button>
            </>}>
              <input type="text" className="settings-kunde" aria-label="Name des Kunden" placeholder="Zum Beispiel: Müller GmbH" maxLength={60} autoFocus value={neu}
                onChange={(e) => setNeu(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && neu.trim()) void wechsel(neu.trim()) }} />
            </Row>
          )}
        </Group>
      )}
      {kit === undefined ? <p><Spin /> Wird geladen …</p> : kit === null ? (
        <Group label="Brand-Kit">
          {APP.pro && (
          <Row title="Firmenvorlage" action={<button type="button" className="pill" disabled={!!busy} onClick={() => void fromPotx()}>{busy === 'brand' ? <><Spin />Lese …</> : 'Aus PowerPoint-Vorlage …'}</button>}>
  {skipped.length ? <span className="error">Übersprungene Schriften (nicht im Katalog): {skipped.join(', ')}.</span> : 'Übernimmt Akzentfarben und Schriften aus einer .potx, .pptx oder .thmx. Das Logo bleibt.'}
</Row>
          )}
          <Row ok={false} title="Noch kein Standard" action={<button className="pill tint" disabled={!!busy} onClick={() => save({ primary: '#4F52D9' })}>Mit Akzentfarbe anlegen</button>}>
            Im Look eines Decks legt „Als Standard speichern“ eins an. Oder fang hier mit einer Farbe an.
          </Row>
        </Group>
      ) : (
        <>
          <Group label="Brand-Kit">
            {APP.pro && (
            <Row title="Firmenvorlage" action={<button type="button" className="pill" disabled={!!busy} onClick={() => void fromPotx()}>{busy === 'brand' ? <><Spin />Lese …</> : 'Aus PowerPoint-Vorlage …'}</button>}>
  {skipped.length ? <span className="error">Übersprungene Schriften (nicht im Katalog): {skipped.join(', ')}.</span> : 'Übernimmt Akzentfarben und Schriften aus einer .potx, .pptx oder .thmx. Das Logo bleibt.'}
</Row>
            )}
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
            {APP.pro && (
            <Row title="Marke sperren (Brand-Lock)" action={
              <input type="checkbox" aria-label="Marke sperren (Brand-Lock)" checked={!!kit.lock} disabled={!!busy} onChange={(e) => save({ ...kit, lock: e.target.checked || undefined })} />
            }>Die KI darf Farben, Schriften und Logo nicht ändern; Abweichungen zeigt die Prüfung als Fehler.</Row>
            )}
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
