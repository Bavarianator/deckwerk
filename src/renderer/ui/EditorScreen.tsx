// Arbeitsansicht: Folienübersicht | Folie mit Notizen und KI-Leiste | Panel „Einfügen“ oder „Anpassen“ (ausblendbar).
import { useCallback, useEffect, useMemo, useState } from 'react'
import { sizeOf, type ChartSpec, type Deck, type Item, type Slide } from '../../shared/deck'
import type { LayoutId } from '../../shared/layouts'
import { resolveTheme } from '../../shared/themes'
import { AskBar, type Target } from './AskBar'
import { ChartEditor } from './ChartEditor'
import type { Msg } from './Chat'
import { Elements } from './Elements'
import { Filmstrip } from './Filmstrip'
import { InsertSearch } from './InsertSearch'
import { Inspector } from './Inspector'
import { ObjectBar } from './ObjectBar'
import { Stage } from './Stage'
import type { Panel } from './TopBar'

interface Props {
  deck: Deck | null
  index: number
  msgs: Msg[]
  busy: boolean
  model: string
  onModel: (id: string) => void
  onSend: (text: string, context?: string) => boolean
  onAbort: () => void
  onSelect: (i: number) => void
  onMove: (from: number, to: number) => void
  onEdit: (slot: string, text: string) => void
  picked: string[]
  onPick: (ids: string[]) => void
  onItems: (fn: (items: Item[]) => Item[], tag?: string) => void
  addSlide: (layout?: LayoutId, at?: number) => void
  dupSlide: (i: number) => void
  delSlide: (i: number) => void
  patchSlide: (i: number, p: Partial<Slide>, tag?: string) => void
  pickImage: () => Promise<string | null>
  nav: boolean
  panel: Panel
  onPanel: (p: Panel) => void
  target: Target | null
  onTarget: (t: Target | null) => void
  canUndoTurn: boolean
  onUndoTurn: () => void
}

export function EditorScreen(p: Props) {
  const { onItems, onPick } = p
  const size = sizeOf(p.deck)
  // neue Elemente mittig auf der Folie (Fabriken rechnen mit 1280×720)
  const add = useCallback((it: Item) => {
    const c = { ...it, x: Math.round((size.w - it.w) / 2), y: Math.round((size.h - it.h) / 2) }
    onItems((l) => [...l, c]); onPick([c.id])
  }, [onItems, onPick, size.w, size.h])
  const slide = p.deck?.slides[p.index]

  // Werkzeuge am Objekt: Diagramm-Daten (Layout- oder freies Diagramm) bzw. Leiste über einem freien Element
  const [closed, setClosed] = useState<string | null>(null) // Diagramm-Popover für diesen Bezug geschlossen
  const [dragging, setDragging] = useState(false) // beim Ziehen ausblenden, die Position wäre veraltet
  const t = p.target
  useEffect(() => setClosed(null), [t?.slot])
  // Einfügen ist ein Popover: Klick daneben schließt es (Ziehen auf die Folie beginnt im Popover und bleibt erlaubt)
  const { panel, onPanel } = p
  useEffect(() => {
    if (panel !== 'insert') return
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.work-panel, .top')) onPanel(null) }
    addEventListener('pointerdown', close)
    return () => removeEventListener('pointerdown', close)
  }, [panel, onPanel])
  useEffect(() => {
    if (!dragging) return
    const up = () => setDragging(false)
    addEventListener('pointerup', up)
    return () => removeEventListener('pointerup', up)
  }, [dragging])
  const item = t?.slot?.startsWith('items.') ? slide?.items?.find((it) => it.id === t.slot!.slice(6)) : undefined
  const spec: ChartSpec | undefined = t?.slot === 'chart' ? slide?.content?.chart : item?.kind === 'chart' ? item.spec : undefined
  const colors = useMemo(() => {
    if (!p.deck) return []
    const c = resolveTheme(p.deck.theme).c
    return [...new Set([c.text, c.accent, c.accent2, c.muted])]
  }, [JSON.stringify(p.deck?.theme)]) // eslint-disable-line react-hooks/exhaustive-deps
  const patchItem = (id: string, q: Partial<Item>, tag?: string) => p.onItems((l) => l.map((it) => (it.id === id ? { ...it, ...q } : it)), tag)
  const setSpec = (s: ChartSpec) => {
    if (!slide) return
    if (item) patchItem(item.id, { spec: s }, `chart-${item.id}`)
    else p.patchSlide(p.index, { content: { ...slide.content, chart: s } }, `chart-${slide.id}`)
  }

  return (
    <div className="work">
      {p.nav && p.deck && (
        <aside className="work-nav" aria-label="Folienübersicht">
          <Filmstrip deck={p.deck} sel={p.index} disabled={p.busy} onSelect={p.onSelect} onMove={p.onMove} onAdd={() => p.addSlide()} onDup={p.dupSlide} onDel={p.delSlide} />
        </aside>
      )}
      <div className="work-center" onPointerDownCapture={(e) => { if ((e.target as HTMLElement).closest('.stage-canvas')) setDragging(true) }}>
        {spec && t?.rect && closed !== t.slot && !dragging && (
          <ChartEditor
            spec={spec} rect={t.rect} busy={p.busy} onChange={setSpec} onClose={() => setClosed(t.slot ?? null)}
            onCheck={() => p.onSend('Ich habe die Daten des Diagramms geändert. Passen Titel und Kernaussage noch dazu? Wenn nicht, passe sie an.', t.context)}
          />
        )}
        {item && item.kind !== 'chart' && t?.rect && !dragging && p.picked.length === 1 && !item.locked && (
          <ObjectBar
            item={item} rect={t.rect} colors={colors} busy={p.busy}
            onPatch={(q, tag) => patchItem(item.id, q, tag)}
            onMore={() => p.onPanel('format')}
            onAsk={() => document.querySelector<HTMLInputElement>('.cap input')?.focus()}
          />
        )}
        <Stage deck={p.deck} index={p.index} busy={p.busy} sel={p.picked} onSel={p.onPick} onItems={p.onItems} onEdit={p.onEdit} onTarget={p.onTarget} />
        {slide && (
          <div className="work-notes">
            <label htmlFor="slide-notes">Notizen</label>
            <textarea
              id="slide-notes"
              rows={2}
              value={slide.notes ?? ''}
              disabled={p.busy}
              placeholder="Was du zu dieser Folie sagst …"
              onChange={(e) => p.patchSlide(p.index, { notes: e.target.value }, `notes-${slide.id}`)}
            />
          </div>
        )}
        <AskBar
          msgs={p.msgs} busy={p.busy} model={p.model} onModel={p.onModel} onSend={p.onSend} onAbort={p.onAbort}
          target={p.target} onTarget={p.onTarget} canUndo={p.canUndoTurn} onUndo={p.onUndoTurn}
        />
      </div>
      {p.panel && p.deck && (
        <aside className={`work-panel ${p.panel}`} aria-label={p.panel === 'insert' ? 'Einfügen' : 'Anpassen'}>
          {p.panel === 'insert'
            ? <InsertSearch deck={p.deck} disabled={p.busy} onAdd={add} onAddSlide={(l) => p.addSlide(l)}>
                <Elements deck={p.deck} disabled={p.busy} onAdd={add} onAddSlide={(l) => p.addSlide(l)} pickImage={p.pickImage} />
              </InsertSearch>
            : <Inspector deck={p.deck} index={p.index} disabled={p.busy} picked={p.picked} onItems={p.onItems} patchSlide={p.patchSlide} pickImage={p.pickImage} />}
        </aside>
      )}
    </div>
  )
}
