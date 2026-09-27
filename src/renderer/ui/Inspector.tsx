// Anpassen-Panel: gewählte freie Elemente und die Einstellungen der Folie (inkl. Hintergrund).
// Deck-weite Einstellungen (Theme, Übergang, Ablauf, Marke) stehen im Look, die Notizen unter der Folie.
import type { ReactNode } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { BUILDS, DECORS, TONES, type BuildPreset, type DecorId, type Deck, type FrameId, type Item, type Slide, type Tone } from '../../shared/deck'
import { ItemInspector } from './ItemInspector'
import { Select } from './kit'
import { LAYOUTS, nextLook, type LayoutId } from '../../shared/layouts'
import { THEMES, themeFromSpec } from '../../shared/themes'

const FRAME: Record<FrameId, string> = { top: 'Titel oben', split: 'Titel links auf Farbfläche', band: 'Titel im Farbband', center: 'Zentriert' }
const BUILD: Record<BuildPreset, string> ={ none: 'Keine', fade: 'Einblenden', list: 'Liste (Punkt für Punkt)', stagger: 'Nacheinander', wipe: 'Wischen', 'zoom-kpi': 'Zoom' }

interface Props {
  deck: Deck
  index: number
  disabled: boolean
  patchSlide: (i: number, p: Partial<Slide>, tag?: string) => void
  pickImage: () => Promise<string | null>
  picked: string[]
  onItems: (fn: (items: Item[]) => Item[], tag?: string) => void
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="field"><span>{label}</span>{children}</label>
)

export function Inspector({ deck, index, disabled, patchSlide, pickImage, picked, onItems }: Props) {
  const slide = deck.slides[index]
  const def = slide && LAYOUTS[slide.layout as LayoutId]
  const base = deck.theme.custom ? themeFromSpec(deck.theme.custom) : THEMES.find((t) => t.id === deck.theme.id) ?? THEMES[0]

  return (
    <aside className="inspector">
      <fieldset disabled={disabled}>
        {picked.length > 0 && <ItemInspector deck={deck} picked={picked} onItems={onItems} pickImage={pickImage} />}
        {slide && (
          <section className="grow">
            <h3>Folie {index + 1} · {def?.name ?? slide.layout}</h3>
            {(def?.variants || def?.frames) && <button type="button" className="btn wide" title="Nächste Kombination aus Variante, Komposition und Ton" onClick={() => patchSlide(index, nextLook(slide))}>Andere Gestaltung</button>}
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
          </section>
        )}
      </fieldset>
    </aside>
  )
}
