// Layout einer Folie wechseln: gleichnamige, im Ziel gültige Felder übernehmen, Listen aufeinander abbilden,
// fehlende Pflichtfelder aus samples.typ des Ziels füllen. `lost` nennt verlorene Felder deutsch für den Hinweis in der UI.
import type { z } from 'zod'
import type { Slide } from './deck'
import { LAYOUTS, type LayoutId } from './layouts'

export const FIELD_NAMES: Record<string, string> = {
  title: 'Titel', eyebrow: 'Überzeile', subtitle: 'Untertitel', meta: 'Zusatzzeile', text: 'Text', source: 'Quelle',
  items: 'Liste', bullets: 'Liste', points: 'Punkte', kpis: 'Kennzahlen', cards: 'Karten', steps: 'Schritte', options: 'Optionen',
  image: 'Bild', images: 'Bilder', chart: 'Diagramm', quote: 'Zitat', author: 'Autor', value: 'Wert', label: 'Beschriftung',
  number: 'Nummer', left: 'Linke Spalte', right: 'Rechte Spalte', focus: 'Fokus', active: 'Hervorhebung', takeaway: 'Fazit',
}
const nameOf = (k: string) => FIELD_NAMES[k] ?? k

type Obj = Record<string, unknown>
const str = (x: unknown): string | undefined => {
  if (typeof x === 'string') return x
  if (x && typeof x === 'object') { const o = x as Obj; for (const k of ['text', 'title', 'label', 'value', 'name']) if (typeof o[k] === 'string') return o[k] as string }
}
const sub = (x: unknown): string | undefined => {
  if (!x || typeof x !== 'object') return
  const o = x as Obj, head = str(x)
  for (const k of ['sub', 'desc', 'text', 'body']) if (typeof o[k] === 'string' && o[k] !== head) return o[k] as string
}
type Arr = { def: { type: string; innerType?: z.ZodType; element: z.ZodType; checks?: { _zod: { def: { check: string; maximum?: number } } }[] } }
const arrayOf = (s: z.ZodType): Arr | undefined => {
  const a = s as unknown as Arr
  return a.def.type === 'array' ? a : a.def.innerType && arrayOf(a.def.innerType) // optional/default auspacken
}
const isArray = (s: z.ZodType) => !!arrayOf(s)
const clean = (o: Obj) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

// Element-Formen, in die sich ein Listeneintrag umdeuten lässt; die erste, die das Zielschema annimmt, gewinnt
const shapes = (x: unknown): unknown[] => {
  const s = str(x), d = sub(x)
  return [x, s, clean({ text: s, sub: d }), clean({ title: s, desc: d }), clean({ title: s, text: d }), clean({ label: s }), clean({ text: s }), clean({ title: s })]
}

// Je Form nur die Einträge einzeln prüfen und den gültigen Anfang bis maxItems nehmen: ein Parse pro Eintrag statt Längen durchprobieren
function mapList(target: z.ZodType, list: unknown[]): { value: unknown; cut: boolean } | undefined {
  const arr = arrayOf(target)
  if (!arr) return
  const el = arr.def.element
  // aus .max(); toJSONSchema wäre hier zu langsam
  const max = arr.def.checks?.map((c) => c._zod.def).find((d) => d.check === 'max_length')?.maximum ?? Infinity
  const want = Math.min(list.length, max)
  for (let k = 0; k < shapes(undefined).length; k++) {
    const out: unknown[] = []
    for (const x of list.slice(0, want)) { const r = el.safeParse(shapes(x)[k]); if (!r.success) break; out.push(r.data) }
    if (!out.length) continue
    const r = target.safeParse(out)
    if (r.success) return { value: r.data, cut: out.length < list.length }
  }
}

export function switchLayout(slide: Slide, to: string): { content: unknown; lost: string[] } {
  const def = LAYOUTS[to as LayoutId]
  if (!def) throw new Error(`Unbekanntes Layout "${to}"`)
  const shape = def.schema.shape as Record<string, z.ZodType>
  const sample = def.samples.typ as Obj
  const from = (slide.content ?? {}) as Obj
  const out: Obj = {}
  const used = new Set<string>()
  const srcOf: Record<string, string> = {} // Zielfeld → Quellfeld
  const cut: string[] = []

  for (const [k, s] of Object.entries(shape)) {
    if (!(k in from)) continue
    // Listen über mapList: kürzt auf maxItems, statt hunderte Einträge mit Fehlern durchzuparsen
    const v = from[k]
    const m = Array.isArray(v) && isArray(s) ? mapList(s, v) : undefined
    const r = m ? { success: true, data: m.value } : Array.isArray(v) && isArray(s) ? { success: false } : s.safeParse(v)
    if (r.success) { out[k] = r.data; used.add(k); srcOf[k] = k; if (m?.cut) cut.push(`${nameOf(k)} (gekürzt)`) }
  }
  // Listen ohne gleichnamiges Gegenstück: erste noch freie Quell-Liste auf die erste freie Ziel-Liste abbilden
  for (const [k, s] of Object.entries(shape)) {
    if (k in out || !isArray(s)) continue
    for (const [fk, fv] of Object.entries(from)) {
      if (used.has(fk) || !Array.isArray(fv) || !fv.length) continue
      const m = mapList(s, fv)
      if (!m) continue
      out[k] = m.value
      used.add(fk)
      srcOf[k] = fk
      if (m.cut) cut.push(`${nameOf(fk)} (gekürzt)`)
      break
    }
  }
  // Pflichtfelder aus dem Muster; was dann noch scheitert (Abhängigkeiten zwischen Feldern), ebenfalls aus dem Muster
  for (const k of Object.keys(shape)) if (!(k in out) && !shape[k].safeParse(undefined).success) out[k] = structuredClone(sample[k])
  for (let i = 0; i < 3; i++) {
    const r = def.schema.safeParse(out)
    if (r.success) break
    for (const iss of r.error.issues) {
      const k = String(iss.path[0] ?? '')
      if (!k) continue
      if (k in sample) out[k] = structuredClone(sample[k])
      else delete out[k]
      if (srcOf[k]) used.delete(srcOf[k])
    }
  }
  const final = def.schema.safeParse(out)
  const content = final.success ? final.data : structuredClone(sample)
  const lost = [...new Set([...Object.keys(from).filter((k) => !used.has(k) || !final.success).map(nameOf), ...cut])]
  return { content, lost }
}
