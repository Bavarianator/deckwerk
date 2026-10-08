// Anpassen-Panel: gewählte freie Elemente und die Einstellungen der Folie (inkl. Hintergrund).
// Deck-weite Einstellungen (Theme, Übergang, Ablauf, Marke) stehen im Look, die Notizen unter der Folie.
import type { ReactNode } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { BUILDS, DECORS, TONES, TRANSITIONS, transitionOf, transitionSpeedOf, type BuildPreset, type Transition, type DecorId, type Deck, type FrameId, type Item, type Slide, type Tone } from '../../shared/deck'
import { ItemInspector } from './ItemInspector'
import { LayersPanel } from './LayersPanel'
import { TRANSITION } from './LookSheet'
import { Select } from './kit'
import { SlideLooks } from './SlideLooks'
import { LAYOUTS, type LayoutId } from '../../shared/layouts'
import { extract, eyebrowRules } from '../measure'
import { FONT_NAMES, THEMES, themeFromSpec } from '../../shared/themes'
import { colorsOf, elsToItems, recolor } from '../../shared/items'

const FRAME: Record<FrameId, string> = { top: 'Titel oben', split: 'Titel links auf Farbfläche', band: 'Titel im Farbband', center: 'Zentriert' }
const BUILD: Record<BuildPreset, string> = {
  none: 'Keine', fade: 'Einblenden', list: 'Liste (Punkt für Punkt)', stagger: 'Aufsteigen (nacheinander)', wipe: 'Wischen', 'zoom-kpi': 'Zoom',
  pan: 'Schwenken (nacheinander)', pop: 'Pop (nacheinander)', words: 'Wort für Wort', photo: 'Foto-Zoom',
}

interface Props {
  deck: Deck
  index: number
  disabled: boolean
  patchSlide: (i: number, p: Partial<Slide>, tag?: string) => void
  pickImage: () => Promise<string | null>
  picked: string[]
  onPick: (ids: string[]) => void
  onItems: (fn: (items: Item[]) => Item[], tag?: string) => void
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="field"><span>{label}</span>{children}</label>
)

export function Inspector({ deck, index, disabled, patchSlide, pickImage, picked, onPick, onItems }: Props) {
  const slide = deck.slides[index]
  const def = slide && LAYOUTS[slide.layout as LayoutId]
  const items = slide?.items ?? []
  const colors = colorsOf(items)
  const texts = items.filter((it) => it.kind === 'text')
  const base = deck.theme.custom ? themeFromSpec(deck.theme.custom) : THEMES.find((t) => t.id === deck.theme.id) ?? THEMES[0]

  return (
    <aside className="inspector">
      <fieldset disabled={disabled}>
        {slide && <LayersPanel deck={deck} index={index} picked={picked} disabled={disabled} onPick={onPick} onItems={onItems} />}
        {picked.length > 0 && <ItemInspector deck={deck} index={index} picked={picked} onItems={onItems} pickImage={pickImage} />}
        {slide && (
          <section className="grow">
            <h3>Folie {index + 1} · {def?.name ?? slide.layout}</h3>
            {(def?.variants || def?.frames) && <SlideLooks deck={deck} index={index} patchSlide={patchSlide} />}
            {slide.layout !== 'blank' && (
              <button type="button" className="btn wide" title="Alle Texte, Formen, Bilder und Icons der Folie werden frei verschiebbar wie in Canva. Rückgängig mit Strg+Z."
                onClick={() => {
                  const root = document.querySelector<HTMLElement>('.stage-canvas .slide')
                  if (root) patchSlide(index, { layout: 'blank', variant: undefined, frame: undefined, content: {}, items: [...elsToItems([...eyebrowRules(root), ...extract(root)]), ...items] })
                }}>In freie Elemente umwandeln</button>
            )}
            {def?.variants && (
              <Field label="Variante">
                <Select value={slide.variant ?? def.variants[0]} onChange={(e) => patchSlide(index, { variant: e.target.value })}>
                  {def.variants.map((v) => <option key={v}>{v}</option>)}
                </Select>
              </Field>
            )}
            {def?.frames && (
              <Field label="Komposition">
                <Select value={slide.frame ?? 'top'} onChange={(e) => patchSlide(index, { frame: e.target.value === 'top' ? undefined : (e.target.value as FrameId) })}>
                  {(['top', ...def.frames] as FrameId[]).map((f) => <option key={f} value={f}>{FRAME[f]}</option>)}
                </Select>
              </Field>
            )}
            {colors.length > 0 && (
              <div className="field">
                <span>Farben dieser Folie</span>
                <div className="swatches">
                  {colors.map((c, i) => <input key={i} type="color" aria-label={`Farbe ${c} überall auf der Folie ersetzen`} title="Überall auf der Folie ersetzen" value={c.toLowerCase()} onChange={(e) => onItems((l) => recolor(l, c, e.target.value.toUpperCase()), `recolor-${slide.id}-${i}`)} />)}
                </div>
              </div>
            )}
            {texts.length > 1 && (
              <Field label="Schrift aller Texte">
                <Select value={texts.every((it) => it.font === texts[0].font) ? texts[0].font ?? 'head' : ''} onChange={(e) => onItems((l) => l.map((it) => (it.kind === 'text' ? { ...it, font: e.target.value } : it)))}>
                  <option value="" disabled>Gemischt</option>
                  <option value="head">Theme: Titel</option>
                  <option value="body">Theme: Text</option>
                  {FONT_NAMES.map((f) => <option key={f} value={f}>{f}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Ton">
              <Select value={slide.tone ?? ''} onChange={(e) => patchSlide(index, { tone: (e.target.value || undefined) as Tone | undefined })}>
                <option value="">Standard ({def?.tone ?? 'normal'})</option>
                {TONES.map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
            <Field label="Dekor">
              <Select value={slide.decor ?? ''} onChange={(e) => patchSlide(index, { decor: (e.target.value || undefined) as DecorId | undefined })}>
                <option value="">Theme-Standard</option>
                {DECORS.map((d) => <option key={d}>{d}</option>)}
              </Select>
            </Field>
            <div className="field">
              <span>Hintergrund {(slide.bg?.color || slide.bg?.image) && <button type="button" className="link" onClick={() => patchSlide(index, { bg: undefined })}>Theme</button>}</span>
              <div className="field-row">
                <input type="color" aria-label="Hintergrundfarbe" value={slide.bg?.color ?? base.c.bg} onChange={(e) => patchSlide(index, { bg: { ...slide.bg, color: e.target.value.toUpperCase() } }, `bg-${slide.id}`)} />
                {slide.bg?.image
                  ? <button type="button" className="btn" onClick={() => patchSlide(index, { bg: { ...slide.bg, image: undefined } })}><X size={14} /> Bild</button>
                  : <button type="button" className="btn" onClick={async () => { const src = await pickImage(); if (src) patchSlide(index, { bg: { ...slide.bg, image: src } }) }}><ImagePlus size={14} /> Bild</button>}
              </div>
            </div>
            <Field label="Animation">
              <Select value={slide.build ?? ''} onChange={(e) => patchSlide(index, { build: (e.target.value || undefined) as BuildPreset | undefined })}>
                <option value="">Standard ({BUILD[def?.defaultBuild ?? 'none']})</option>
                {BUILDS.map((b) => <option key={b} value={b}>{BUILD[b]}</option>)}
              </Select>
            </Field>
            {index > 0 && (
              <Field label="Übergang zu dieser Folie">
                <Select value={slide.transition ?? ''} onChange={(e) => patchSlide(index, { transition: (e.target.value || undefined) as Transition | undefined })}>
                  <option value="">Wie im Deck ({TRANSITION[deck.transition]})</option>
                  {TRANSITIONS.map((x) => <option key={x} value={x}>{TRANSITION[x]}</option>)}
                </Select>
              </Field>
            )}
            {transitionOf(deck, index) !== 'none' && (
              // Normal = Tempo des Decks
              <div className="seg" role="group" aria-label="Tempo des Übergangs">
                {(['slow', undefined, 'fast'] as const).map((sp) => (
                  <button key={sp ?? 'normal'} type="button" aria-pressed={transitionSpeedOf(deck, index) === sp} onClick={() => patchSlide(index, { transitionSpeed: sp })}>{sp === 'slow' ? 'Langsam' : sp === 'fast' ? 'Schnell' : 'Normal'}</button>
                ))}
              </div>
            )}
          </section>
        )}
      </fieldset>
    </aside>
  )
}
