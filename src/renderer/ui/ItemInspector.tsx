// Eigenschaften der gewählten freien Elemente: Position, Drehung, Deckkraft, Ebenen, Ausrichten, Animation und je Art
// Schrift/Farbe, Füllung/Verlauf/Rahmen, Bildlook/Maske/Spiegeln, Icon, Diagrammdaten.
import { useEffect, useState, type ReactNode } from 'react'
import {
  AlignCenter, AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignLeft, AlignRight,
  AlignStartHorizontal, AlignStartVertical, ArrowDown, ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUp, ArrowUpToLine, Bold, ChevronDown, ChevronUp, Copy, FlipHorizontal,
  ClipboardPaste, Crop, Eraser, Group, Italic, LoaderCircle, Lock, LockOpen, Paintbrush, Pipette, Trash2, Underline, Ungroup, type LucideIcon,
} from 'lucide-react'
import { ANIM_DIRS, DASHES, ITEM_ANIMS, type AnimDir, type AnimSpeed, LINE_ENDS, MASKS, sizeOf, type Dash, type Deck, type Item, type ItemAnim, type LineEnd, type MaskId, TEXT_EFFECTS, type TextEffect } from '../../shared/deck'
import { GRAPHICS, csvToSpec, itemSchema, specToCsv } from '../../shared/items'
import { FONT_NAMES, resolveTheme } from '../../shared/themes'
import { align, clip, cloneItems, copyStyle, distribute, groupItems, isGroup, pasteStyle, removeItems, reorder, ungroupItems, type Align, type Order } from './itemOps'
import { Select } from './kit'
import { animateItem } from './PresentScreen'
import { removeBackground } from './media'

interface Props { deck: Deck; index: number; picked: string[]; onItems: (fn: (items: Item[]) => Item[], tag?: string) => void; pickImage: () => Promise<string | null> }

const KIND: Record<Item['kind'], string> = { text: 'Text', shape: 'Form', image: 'Bild', icon: 'Icon', chart: 'Diagramm', video: 'Video', audio: 'Audio', qr: 'QR-Code', graphic: 'Grafik' }
const MASK_NAME: Record<MaskId, string> = { circle: 'Kreis', arch: 'Bogen', hexagon: 'Sechseck', diamond: 'Raute', octagon: 'Achteck', star: 'Stern', heart: 'Herz' }
const EFFECT_NAME: Record<TextEffect, string> = { none: 'Ohne', shadow: 'Schatten', lift: 'Schweben', hollow: 'Kontur', neon: 'Neon' }
const ADJUST_NAME = { bright: 'Helligkeit', contrast: 'Kontrast', sat: 'Sättigung', blur: 'Weichzeichnen' }
const DASH_NAME: Record<Dash, string> = { solid: 'Durchgehend', dash: 'Gestrichelt', dot: 'Gepunktet' }
const END_NAME: Record<LineEnd, string> = { none: 'Ohne', arrow: 'Pfeil', triangle: 'Spitze', dot: 'Punkt' }
// Namen wie in Canva; Schreibmaschine und Wort für Wort nur für Text, Atmen pulsiert ohne Klick
const DIRECTED: ItemAnim[] = ['float', 'pan', 'drift', 'wipe'] // Animationen mit Richtung (Canva-Pfeile)
const DIR_ICON: Record<AnimDir, LucideIcon> = { right: ArrowRight, left: ArrowLeft, up: ArrowUp, down: ArrowDown }
const DIR_NAME: Record<AnimDir, string> = { right: 'Nach rechts', left: 'Nach links', up: 'Nach oben', down: 'Nach unten' }
const ANIM: Record<ItemAnim, string> = {
  none: 'Keine', fade: 'Einblenden', float: 'Aufsteigen', pan: 'Schwenken', drift: 'Treiben', pop: 'Pop', zoom: 'Zoomen', tumble: 'Purzeln',
  stomp: 'Stampfen', baseline: 'Grundlinie', wipe: 'Wischen', typewriter: 'Schreibmaschine', ascend: 'Wort für Wort', breathe: 'Atmen (pulsiert ohne Klick)',
}
const ALIGNS: [Align, LucideIcon, string][] = [
  ['left', AlignStartVertical, 'Links'], ['hcenter', AlignCenterVertical, 'Mittig'], ['right', AlignEndVertical, 'Rechts'],
  ['top', AlignStartHorizontal, 'Oben'], ['vcenter', AlignCenterHorizontal, 'Mitte'], ['bottom', AlignEndHorizontal, 'Unten'],
]
const ORDERS: [Order, LucideIcon, string][] = [['front', ArrowUpToLine, 'Ganz nach vorne'], ['forward', ChevronUp, 'Nach vorne'], ['backward', ChevronDown, 'Nach hinten'], ['back', ArrowDownToLine, 'Ganz nach hinten']]

const Field = ({ label, children }: { label: string; children: ReactNode }) => <label className="field"><span>{label}</span>{children}</label>
const Btn = ({ icon: I, label, on, ...rest }: { icon: LucideIcon; label: string; on?: boolean; onClick: () => void; disabled?: boolean }) => (
  <button type="button" className={`icon-btn ${on ? 'on' : ''}`} title={label} aria-label={label} aria-pressed={on} {...rest}><I size={15} /></button>
)
// Halbfertige Eingaben (z. B. „http“) bleiben lokal und rot markiert; gespeichert wird nur, was das Item-Schema annimmt
function LinkField({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  const [v, setV] = useState(value ?? '')
  const ok = (s: string) => !s || itemSchema.shape.link.safeParse(s).success
  return (
    <Field label="Link">
      <input type="text" value={v} placeholder="https://… oder #3 für Folie 3" aria-invalid={!ok(v.trim())}
        onChange={(e) => { setV(e.target.value); const s = e.target.value.trim(); if (ok(s)) onChange(s || undefined) }} />
    </Field>
  )
}
function Num({ value, onChange, min, max, step = 1, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <span className="num">
      <input type="number" value={Math.round(value * 100) / 100} min={min} max={max} step={step} onChange={(e) => e.target.value !== '' && onChange(Number(e.target.value))} />
      {suffix && <em>{suffix}</em>}
    </span>
  )
}

// „#abc“, „A1B2C3“ … → „#AABBCC“; ungültig → null
const hexOf = (s: string) => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim())
  return m && `#${(m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1]).toUpperCase()}`
}

// Farbwahl mit Theme-Farben als Schnellwahl
function Color({ value, onChange, swatches, tag, allowNone }: { value?: string; onChange: (v: string | undefined, tag?: string) => void; swatches: string[]; tag: string; allowNone?: boolean }) {
  return (
    <div className="color">
      <input type="color" value={value ?? '#000000'} onChange={(e) => onChange(e.target.value.toUpperCase(), tag)} />
      {/* Hex-Eingabe: übernimmt bei Enter/Verlassen, Ungültiges springt zurück; key setzt das Feld bei neuer Farbe neu auf */}
      <input type="text" key={value} defaultValue={value ?? ''} spellCheck={false} aria-label="Farbe als Hex-Wert" placeholder="#RRGGBB"
        style={{ flex: 'none', width: 82, height: 30, fontSize: 12 }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        onBlur={(e) => {
          const v = hexOf(e.target.value)
          e.target.value = v ?? value ?? ''
          if (v && v !== value?.toUpperCase()) onChange(v)
        }} />
      {'EyeDropper' in window && (
        <button type="button" className="icon-btn" title="Farbe vom Bildschirm aufnehmen" aria-label="Pipette"
          onClick={() => new (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper().open().then((r) => onChange(r.sRGBHex.toUpperCase(), tag), () => {})}>
          <Pipette size={14} />
        </button>
      )}
      <div className="swatches">
        {allowNone && <button type="button" className={`swatch none ${!value ? 'on' : ''}`} title="Keine" onClick={() => onChange(undefined)} />}
        {swatches.map((c) => <button type="button" key={c} className={`swatch ${value?.toUpperCase() === c.toUpperCase() ? 'on' : ''}`} style={{ background: c }} title={c} onClick={() => onChange(c.toUpperCase())} />)}
      </div>
    </div>
  )
}

function ChartData({ it, set }: { it: Item; set: (p: Partial<Item>, tag?: string) => void }) {
  const [csv, setCsv] = useState(() => specToCsv(it.spec!))
  useEffect(() => setCsv(specToCsv(it.spec!)), [it.id])
  return (
    <Field label="Daten (erste Zeile: Reihen, erste Spalte: Kategorien)">
      <textarea rows={6} value={csv} spellCheck={false} className="mono" onChange={(e) => {
        setCsv(e.target.value)
        const spec = csvToSpec(e.target.value, it.spec!)
        if (spec) set({ spec }, `chart-${it.id}`)
      }} />
    </Field>
  )
}

// Freisteller: KI entfernt den Hintergrund (lokal, Modell lädt beim ersten Mal ~115 MB)
function BgRemove({ it, set }: { it: Item; set: (p: Partial<Item>) => void }) {
  const [state, setState] = useState<{ busy: boolean; pct?: number; error?: string }>({ busy: false })
  useEffect(() => setState({ busy: false }), [it.id])
  const run = async () => {
    setState({ busy: true })
    try {
      const src = await removeBackground(it.src!, (pct) => setState({ busy: true, pct }))
      set({ src, look: undefined })
      setState({ busy: false })
    } catch (e) { setState({ busy: false, error: e instanceof Error ? e.message : String(e) }) }
  }
  return (
    <div className="field">
      <button type="button" className="btn wide" disabled={state.busy || !it.src} onClick={run}>
        {state.busy ? <><LoaderCircle size={13} className="spin" /> {state.pct !== undefined && state.pct < 100 ? `Modell wird geladen … ${state.pct} %` : 'Hintergrund wird entfernt …'}</> : <><Eraser size={13} /> Hintergrund entfernen</>}
      </button>
      {state.error && <span className="error small">{state.error}</span>}
    </div>
  )
}

export function ItemInspector({ deck, index, picked, onItems, pickImage }: Props) {
  const slide = deck.slides[index] // IDs sind nur je Folie eindeutig (duplizierte Folien behalten sie für Morph)
  const items = slide?.items ?? []
  const chosen = items.filter((it) => picked.includes(it.id))
  const [, bump] = useState(0) // neu zeichnen, sobald ein Stil kopiert ist
  if (!chosen.length) return null
  const t = resolveTheme(deck.theme)
  // Theme- und Markenfarben, dann die im Deck am häufigsten benutzten Farben (Canva „Dokumentfarben“)
  const used = deck.slides.flatMap((s) => s.items ?? []).flatMap((x) => [x.fill, x.fill2, x.stroke, x.color]).filter((c): c is string => !!c).map((c) => c.toUpperCase())
  const docColors = [...new Set(used)].sort((a, b) => used.filter((c) => c === b).length - used.filter((c) => c === a).length).slice(0, 6)
  const swatches = [...new Set([t.c.text, t.c.accent, t.c.accent2, t.c.bg, t.c.surface, t.c.muted, '#FFFFFF', '#000000', deck.theme.brand?.primary, deck.theme.brand?.secondary, ...docColors].filter((c): c is string => !!c).map((c) => c.toUpperCase()))]
  const it = chosen.length === 1 ? chosen[0] : undefined
  const set = (p: Partial<Item>, tag?: string) => onItems((l) => l.map((x) => (picked.includes(x.id) ? { ...x, ...p } : x)), tag)
  // Vorschau wie in Canva: einmal auf der Folie abspielen (Atmen nur kurz)
  const preview = (anim: ItemAnim, dir?: AnimDir, speed?: AnimSpeed) => {
    for (const c of chosen) {
      const el = document.querySelector<HTMLElement>(`.stage-slide [data-item="${CSS.escape(c.id)}"]`)
      const as = el ? animateItem(el, anim, 0, dir, speed) : []
      if (anim === 'breathe') as.forEach((a) => setTimeout(() => a.cancel(), 2400))
    }
  }
  const all = (f: (x: Item) => boolean) => chosen.every(f)
  const locked = all((x) => !!x.locked)

  return (
    <section className="item-insp">
      <h3>
        {it ? KIND[it.kind] : isGroup(items, picked) ? 'Gruppe' : `${chosen.length} Elemente`}
        <span className="h3-acts">
          {chosen.length > 1 && !isGroup(items, picked) && <Btn icon={Group} label="Gruppieren (Strg+G)" onClick={() => onItems((l) => groupItems(l, picked))} />}
          {chosen.some((x) => x.group) && <Btn icon={Ungroup} label="Gruppierung aufheben (Strg+Umschalt+G)" onClick={() => onItems((l) => ungroupItems(l, picked))} />}
          <Btn icon={locked ? Lock : LockOpen} label={locked ? 'Entsperren' : 'Sperren'} on={locked} onClick={() => set({ locked: !locked || undefined })} />
          <Btn icon={Copy} label="Duplizieren" onClick={() => onItems((l) => [...l, ...cloneItems(chosen)])} />
          <Btn icon={Trash2} label="Löschen" onClick={() => onItems((l) => removeItems(l, picked))} />
        </span>
      </h3>
      <fieldset disabled={locked} className="plain">
        <div className="btn-row" role="group" aria-label="Stil übertragen">
          <Btn icon={Paintbrush} label="Stil kopieren (Strg+Alt+C)" disabled={!it} onClick={() => { copyStyle(it!); bump((n) => n + 1) }} />
          <Btn icon={ClipboardPaste} label="Stil einfügen (Strg+Alt+V)" disabled={!clip.style} onClick={() => onItems((l) => pasteStyle(l, picked))} />
        </div>
        <div className="btn-row" role="group" aria-label={chosen.length > 1 ? 'Aneinander ausrichten' : 'An der Folie ausrichten'}>
          {ALIGNS.map(([a, I, label]) => <Btn key={a} icon={I} label={`${label} ausrichten`} onClick={() => onItems((l) => align(l, picked, a, sizeOf(deck)))} />)}
        </div>
        {chosen.length > 2 && (
          <div className="btn-row">
            <button type="button" className="btn small" onClick={() => onItems((l) => distribute(l, picked, 'x'))}>Waagrecht verteilen</button>
            <button type="button" className="btn small" onClick={() => onItems((l) => distribute(l, picked, 'y'))}>Senkrecht verteilen</button>
          </div>
        )}
        <div className="btn-row" role="group" aria-label="Ebene">
          {ORDERS.map(([o, I, label]) => <Btn key={o} icon={I} label={label} onClick={() => onItems((l) => reorder(l, picked, o))} />)}
        </div>

        {it && (
          <div className="grid4">
            <Field label="X"><Num value={it.x} onChange={(x) => set({ x }, `x-${it.id}`)} /></Field>
            <Field label="Y"><Num value={it.y} onChange={(y) => set({ y }, `y-${it.id}`)} /></Field>
            <Field label="Breite"><Num value={it.w} min={1} onChange={(w) => set({ w }, `w-${it.id}`)} /></Field>
            {it.kind !== 'text' && <Field label="Höhe"><Num value={it.h} min={1} onChange={(h) => set({ h }, `h-${it.id}`)} /></Field>}
          </div>
        )}
        <div className="field-row">
          {it && it.kind !== 'chart' && <Field label="Drehung"><Num value={it.rot ?? 0} min={-180} max={180} suffix="°" onChange={(rot) => set({ rot: rot || undefined }, `rot-${it.id}`)} /></Field>}
          <Field label={`Deckkraft ${Math.round((chosen[0].opacity ?? 1) * 100)} %`}>
            <input type="range" min={5} max={100} value={Math.round((chosen[0].opacity ?? 1) * 100)} onChange={(e) => set({ opacity: +e.target.value >= 100 ? undefined : +e.target.value / 100 }, 'opacity')} />
          </Field>
        </div>
        <Field label="Animation beim Präsentieren">
          <Select value={chosen[0].anim ?? 'none'} onChange={(e) => {
            const anim = e.target.value as ItemAnim
            set({ anim: anim === 'none' ? undefined : anim })
            preview(anim, chosen[0].animDir, chosen[0].animSpeed)
          }}>
            {ITEM_ANIMS.filter((a) => chosen.every((c) => c.kind === 'text') || (a !== 'typewriter' && a !== 'ascend')).map((a) => <option key={a} value={a}>{ANIM[a]}</option>)}
          </Select>
        </Field>
        {chosen[0].anim && (
          <div className="anim-opts">
            {DIRECTED.includes(chosen[0].anim) && (
              <div className="seg icons" role="group" aria-label="Richtung">
                {ANIM_DIRS.map((d) => {
                  const Arrow = DIR_ICON[d]
                  const on = (chosen[0].animDir ?? (chosen[0].anim === 'float' ? 'up' : 'right')) === d
                  return <button key={d} type="button" title={DIR_NAME[d]} aria-label={DIR_NAME[d]} aria-pressed={on} onClick={() => { set({ animDir: d }); preview(chosen[0].anim!, d, chosen[0].animSpeed) }}><Arrow size={14} /></button>
                })}
              </div>
            )}
            <div className="seg" role="group" aria-label="Tempo">
              {(['slow', undefined, 'fast'] as const).map((sp) => (
                <button key={sp ?? 'normal'} type="button" aria-pressed={chosen[0].animSpeed === sp} onClick={() => { set({ animSpeed: sp }); preview(chosen[0].anim!, chosen[0].animDir, sp) }}>{sp === 'slow' ? 'Langsam' : sp === 'fast' ? 'Schnell' : 'Normal'}</button>
              ))}
            </div>
          </div>
        )}
        {it && <LinkField key={it.id} value={it.link} onChange={(link) => set({ link }, `link-${it.id}`)} />}

        {it?.kind === 'text' && (
          <>
            <Field label="Schrift">
              <Select value={it.font ?? 'head'} onChange={(e) => set({ font: e.target.value })}>
                <option value="head">Theme: Titel ({t.head.pptx})</option>
                <option value="body">Theme: Text ({t.body.pptx})</option>
                {FONT_NAMES.map((f) => <option key={f} value={f}>{f}</option>)}
              </Select>
            </Field>
            <div className="field-row">
              <Field label="Größe"><Num value={it.size ?? 32} min={6} max={400} suffix="px" onChange={(size) => set({ size }, `size-${it.id}`)} /></Field>
              <Field label="Zeilenabstand"><Num value={it.lineHeight ?? 1.2} min={0.7} max={3} step={0.05} onChange={(lineHeight) => set({ lineHeight }, `lh-${it.id}`)} /></Field>
            </div>
            <div className="btn-row">
              <Btn icon={Bold} label="Fett" on={it.bold} onClick={() => set({ bold: !it.bold || undefined })} />
              <Btn icon={Italic} label="Kursiv" on={it.italic} onClick={() => set({ italic: !it.italic || undefined })} />
              <Btn icon={Underline} label="Unterstrichen" on={it.underline} onClick={() => set({ underline: !it.underline || undefined })} />
              <button type="button" className={`icon-btn ${it.upper ? 'on' : ''}`} title="Großbuchstaben" aria-pressed={!!it.upper} onClick={() => set({ upper: !it.upper || undefined })}>AA</button>
              <span className="stage-sep" />
              <Btn icon={AlignLeft} label="Linksbündig" on={(it.align ?? 'left') === 'left'} onClick={() => set({ align: 'left' })} />
              <Btn icon={AlignCenter} label="Zentriert" on={it.align === 'center'} onClick={() => set({ align: 'center' })} />
              <Btn icon={AlignRight} label="Rechtsbündig" on={it.align === 'right'} onClick={() => set({ align: 'right' })} />
            </div>
            <Field label="Laufweite"><input type="range" min={-5} max={40} value={Math.round((it.spacing ?? 0) * 100)} onChange={(e) => set({ spacing: +e.target.value / 100 || undefined }, `sp-${it.id}`)} /></Field>
            <Field label="Farbe"><Color value={it.color ?? t.c.text} onChange={(color, tag) => set({ color }, tag)} swatches={swatches} tag={`color-${it.id}`} /></Field>
            <Field label="Effekt">
              <Select value={it.effect ?? 'none'} onChange={(e) => set({ effect: e.target.value === 'none' ? undefined : (e.target.value as TextEffect) })}>
                {TEXT_EFFECTS.map((x) => <option key={x} value={x}>{EFFECT_NAME[x]}</option>)}
              </Select>
            </Field>
            {(it.effect === 'neon' || it.effect === 'hollow') && (
              <Field label={it.effect === 'neon' ? 'Leuchtfarbe' : 'Konturfarbe'}><Color value={it.effectColor ?? it.color ?? t.c.text} onChange={(effectColor, tag) => set({ effectColor }, tag)} swatches={swatches} tag={`fx-${it.id}`} /></Field>
            )}
            <Field label="Text"><textarea rows={3} value={it.text ?? ''} onChange={(e) => set({ text: e.target.value }, `text-${it.id}`)} /></Field>
          </>
        )}

        {it?.kind === 'shape' && (
          <>
            {it.shape !== 'line' && <Field label="Füllung"><Color value={it.fill} allowNone onChange={(fill, tag) => set({ fill }, tag)} swatches={swatches} tag={`fill-${it.id}`} /></Field>}
            {(it.shape === 'rect' || it.shape === 'ellipse') && it.fill && (
              <Field label="Verlauf zu">
                <Color value={it.fill2} allowNone onChange={(fill2, tag) => set({ fill2 }, tag)} swatches={swatches} tag={`fill2-${it.id}`} />
              </Field>
            )}
            <Field label={it.shape === 'line' ? 'Linienfarbe' : 'Rahmen'}><Color value={it.stroke} allowNone={it.shape !== 'line'} onChange={(stroke, tag) => set({ stroke, strokeW: stroke ? it.strokeW || 3 : undefined }, tag)} swatches={swatches} tag={`stroke-${it.id}`} /></Field>
            <div className="field-row">
              {(it.stroke || it.shape === 'line') && <Field label="Strichstärke"><Num value={it.strokeW ?? 0} min={0} max={40} suffix="px" onChange={(strokeW) => set({ strokeW }, `sw-${it.id}`)} /></Field>}
              {it.shape === 'rect' && <Field label="Eckenradius"><Num value={it.radius ?? 0} min={0} max={400} suffix="px" onChange={(radius) => set({ radius: radius || undefined }, `r-${it.id}`)} /></Field>}
            </div>
            {(it.stroke || it.shape === 'line') && (
              <div className="field-row">
                <Field label="Strichart">
                  <Select value={it.dash ?? 'solid'} onChange={(e) => set({ dash: e.target.value === 'solid' ? undefined : (e.target.value as Item['dash']) })}>
                    {DASHES.map((d) => <option key={d} value={d}>{DASH_NAME[d]}</option>)}
                  </Select>
                </Field>
                {it.shape === 'line' && (['lineStart', 'lineEnd'] as const).map((k) => (
                  <Field key={k} label={k === 'lineStart' ? 'Anfang' : 'Ende'}>
                    <Select value={it[k] ?? 'none'} onChange={(e) => set({ [k]: e.target.value === 'none' ? undefined : (e.target.value as LineEnd) })}>
                      {LINE_ENDS.map((l) => <option key={l} value={l}>{END_NAME[l]}</option>)}
                    </Select>
                  </Field>
                ))}
              </div>
            )}
            {(it.shape === 'rect' || it.shape === 'ellipse') && (
              <label className="check"><input type="checkbox" checked={!!it.shadow} onChange={(e) => set({ shadow: e.target.checked || undefined })} /> Schatten</label>
            )}
          </>
        )}

        {it?.kind === 'image' && (
          <>
            <Field label="Look">
              <Select value={it.look ?? 'natural'} onChange={(e) => set({ look: e.target.value === 'natural' ? undefined : (e.target.value as Item['look']) })}>
                <option value="natural">Original</option><option value="duotone">Duotone (Theme-Farben)</option><option value="mono">Schwarzweiß</option>
              </Select>
            </Field>
            <div className="btn-row">
              <Btn icon={FlipHorizontal} label="Spiegeln" on={it.flipX} onClick={() => set({ flipX: !it.flipX || undefined })} />
            </div>
            <Field label="Rahmen">
              <Select value={it.round ? 'circle' : (it.mask ?? 'none')} onChange={(e) => set({ round: undefined, mask: e.target.value === 'none' ? undefined : (e.target.value as MaskId) })}>
                <option value="none">Ohne</option>
                {MASKS.map((m) => <option key={m} value={m}>{MASK_NAME[m]}</option>)}
              </Select>
            </Field>
            {(['bright', 'contrast', 'sat', 'blur'] as const).map((k) => (
              <Field key={k} label={`${ADJUST_NAME[k]} ${it.adjust?.[k] ?? 0}`}>
                <input type="range" min={k === 'blur' ? 0 : -100} max={100} value={it.adjust?.[k] ?? 0}
                  onChange={(e) => set({ adjust: { ...it.adjust, [k]: +e.target.value || undefined } }, `adj-${k}-${it.id}`)} />
              </Field>
            ))}
            {!it.round && !it.mask && <Field label="Eckenradius"><Num value={it.radius ?? 0} min={0} max={400} suffix="px" onChange={(radius) => set({ radius: radius || undefined }, `r-${it.id}`)} /></Field>}
            <div className="btn-row">
              <button type="button" className="btn small" disabled={!!it.rot} title={it.rot ? 'Zum Zuschneiden erst die Drehung auf 0° setzen' : 'Ausschnitt wählen (auch per Doppelklick)'}
                onClick={() => dispatchEvent(new CustomEvent('dw:crop', { detail: it.id }))}><Crop size={13} /> Zuschneiden</button>
              {it.crop && <button type="button" className="btn small" onClick={() => set({ crop: undefined })}>Ausschnitt zurücksetzen</button>}
            </div>
            <BgRemove it={it} set={set} />
            <button type="button" className="btn wide" onClick={async () => { const src = await pickImage(); if (src) set({ src, crop: undefined }) }}>Bild ersetzen …</button>
            <Field label="Alternativtext"><textarea rows={2} maxLength={250} value={it.alt ?? ''} placeholder="Was zeigt das Bild?" onChange={(e) => set({ alt: e.target.value || undefined }, `alt-${it.id}`)} /></Field>
          </>
        )}

        {(it?.kind === 'video' || it?.kind === 'audio') && (
          <>
            <label className="check"><input type="checkbox" checked={!!it.autoplay} onChange={(e) => set({ autoplay: e.target.checked || undefined })} /> Beim Präsentieren automatisch abspielen</label>
            <label className="check"><input type="checkbox" checked={!!it.loop} onChange={(e) => set({ loop: e.target.checked || undefined })} /> Endlos wiederholen</label>
            {it.kind === 'video' && <label className="check"><input type="checkbox" checked={!!it.muted} onChange={(e) => set({ muted: e.target.checked || undefined })} /> Ton aus</label>}
            {it.kind === 'audio' && <Field label="Farbe"><Color value={it.color ?? t.c.accent} onChange={(color, tag) => set({ color }, tag)} swatches={swatches} tag={`color-${it.id}`} /></Field>}
            {it.kind === 'video' && <Field label="Eckenradius"><Num value={it.radius ?? 0} min={0} max={400} suffix="px" onChange={(radius) => set({ radius: radius || undefined }, `r-${it.id}`)} /></Field>}
            <p className="muted small">In der PPTX wird die Datei eingebettet und startet per Klick; im PDF erscheint das Vorschaubild.</p>
          </>
        )}

        {it?.kind === 'qr' && (
          <>
            <Field label="Inhalt (Link oder Text)"><textarea rows={2} value={it.text ?? ''} onChange={(e) => set({ text: e.target.value }, `qr-${it.id}`)} /></Field>
            <p className="muted small">Schwarz auf Weiß lässt sich am sichersten scannen.</p>
            <Field label="Farbe"><Color value={it.color ?? '#000000'} onChange={(color, tag) => set({ color }, tag)} swatches={swatches} tag={`color-${it.id}`} /></Field>
            <Field label="Hintergrund"><Color value={it.fill ?? '#FFFFFF'} onChange={(fill, tag) => set({ fill }, tag)} swatches={swatches} tag={`fill-${it.id}`} /></Field>
          </>
        )}

        {it?.kind === 'graphic' && (
          <>
            <Field label="Grafik">
              <Select value={it.graphic ?? 'squiggle'} onChange={(e) => set({ graphic: e.target.value })}>
                {Object.entries(GRAPHICS).map(([id, g]) => <option key={id} value={id}>{g.name}</option>)}
              </Select>
            </Field>
            <Field label="Farbe"><Color value={it.color ?? t.c.accent} onChange={(color, tag) => set({ color }, tag)} swatches={swatches} tag={`color-${it.id}`} /></Field>
            {!GRAPHICS[it.graphic ?? '']?.fill && <Field label="Strichstärke"><Num value={it.strokeW ?? 6} min={1} max={24} suffix="px" onChange={(strokeW) => set({ strokeW }, `sw-${it.id}`)} /></Field>}
          </>
        )}

        {it?.kind === 'icon' && (
          <>
            <Field label="Farbe"><Color value={it.color ?? t.c.accent} onChange={(color, tag) => set({ color }, tag)} swatches={swatches} tag={`color-${it.id}`} /></Field>
            <Field label="Strichstärke"><Num value={it.strokeW ?? 1.75} min={0.5} max={4} step={0.25} onChange={(strokeW) => set({ strokeW }, `sw-${it.id}`)} /></Field>
          </>
        )}

        {it?.kind === 'chart' && it.spec && (
          <>
            <div className="field-row">
              <Field label="Typ">
                <Select value={it.spec.type} onChange={(e) => set({ spec: { ...it.spec!, type: e.target.value as NonNullable<Item['spec']>['type'] } })}>
                  <option value="bar">Säulen</option><option value="hbar">Balken</option><option value="stacked">Gestapelt</option>
                  <option value="waterfall">Wasserfall</option><option value="line">Linie</option><option value="donut">Ring</option>
                </Select>
              </Field>
              <Field label="Einheit"><input type="text" value={it.spec.unit ?? ''} placeholder="z. B. Mio. €" onChange={(e) => set({ spec: { ...it.spec!, unit: e.target.value || undefined } }, `unit-${it.id}`)} /></Field>
            </div>
            <ChartData it={it} set={set} />
          </>
        )}
      </fieldset>
    </section>
  )
}
