// Pro-Folientypen für Beratungen (Projektplan als Gantt). Nur Typ-Import aus ./layouts, damit layouts.ts diese Datei zyklusfrei einbinden kann (PRO_LAYOUTS).
// Komponenten: src/renderer/layouts-pro.tsx (gleiche ids).
import { z } from 'zod'
import type { LayoutDef } from './layouts'

const WORDS = 'Bestandsaufnahme Konzeption Pilotierung Rollout Schulung Abnahme Datenmigration Prozessanalyse Ausschreibung Umsetzung Wirkungsmessung'.split(' ')
const words = (max: number, offset = 0) => {
  let s = ''
  for (let i = offset; ; i++) {
    const next = s ? `${s} ${WORDS[i % WORDS.length]}` : WORDS[i % WORDS.length]
    if (next.length > max) return s || next.slice(0, max)
    s = next
  }
}
const rep = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i))

const title = (max = 90) => z.string().min(3).max(max).describe('Action Title: die Kernaussage der Folie als ganzer Satz')
const eyebrow = z.string().max(28).optional().describe('Kleine Überzeile, z. B. Kapitelname')
const source = z.string().max(90).optional().describe('Quellenangabe / Fußnote')

const gantt = z.object({
  eyebrow,
  title: title(),
  periods: z.array(z.string().max(10)).min(3).max(12).describe('Spaltenköpfe der Zeitachse, gleich lange Zeiträume, z. B. „Jan“…„Jun“, „Q1“…„Q4“ oder „KW 1“…„KW 8“'),
  rows: z.array(z.object({
    label: z.string().max(30).describe('Phase oder Arbeitspaket'),
    start: z.number().int().min(0).describe('Index der ersten Periode in periods (0-basiert)'),
    end: z.number().int().min(0).describe('Index der letzten Periode (inklusiv, ≥ start)'),
    milestone: z.boolean().optional().describe('Meilenstein: Raute statt Balken, start = end'),
    highlight: z.boolean().optional().describe('in Akzentfarbe (kritischer Pfad, laufende Phase); sonst gedämpft. Sparsam: 1–2 Zeilen'),
  })).min(2).max(8),
  today: z.number().int().min(0).optional().describe('Index der aktuellen Periode: dünne Heute-Linie'),
  source,
}).refine((c) => c.rows.every((r) => r.end >= r.start), 'end muss ≥ start sein')
  .refine((c) => c.rows.every((r) => r.end < c.periods.length) && (c.today === undefined || c.today < c.periods.length), 'start, end und today müssen Indizes in periods sein (< periods.length)')
  .refine((c) => c.rows.every((r) => !r.milestone || r.start === r.end), 'Meilensteine brauchen start = end')

const L = <S extends z.ZodObject>(d: LayoutDef<S>) => d

export const PRO_LAYOUTS = {
  gantt: L({
    id: 'gantt', name: 'Projektplan',
    when: 'Projektplan, Phasen, Roadmap mit Zeiträumen: Arbeitspakete als Balken über einer Zeitachse (Monate, Quartale, Kalenderwochen), Meilensteine als Raute, optional Heute-Linie. Nur 1–2 Zeilen highlight (kritischer Pfad). Für wenige Meilensteine ohne Dauer stattdessen `timeline`.',
    schema: gantt, defaultBuild: 'stagger', footer: true,
    samples: {
      min: { title: 'Zwei Phasen bis zum Start', periods: ['Jan', 'Feb', 'Mär'], rows: [{ label: 'Konzept', start: 0, end: 1 }, { label: 'Umsetzung', start: 1, end: 2, highlight: true }] },
      typ: {
        eyebrow: 'Vorgehen', title: 'In sechs Monaten vom Konzept zum Rollout in allen Standorten',
        periods: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun'],
        rows: [
          { label: 'Bestandsaufnahme', start: 0, end: 0 },
          { label: 'Zielbild und Konzept', start: 0, end: 1 },
          { label: 'Pilot an zwei Standorten', start: 2, end: 3, highlight: true },
          { label: 'Entscheidung Rollout', start: 3, end: 3, milestone: true, highlight: true },
          { label: 'Rollout und Schulung', start: 4, end: 5 },
        ],
        today: 2,
        source: 'Stand: März, Lenkungskreis',
      },
      max: {
        eyebrow: words(28), title: words(90),
        periods: rep(12, (i) => `KW ${i + 10}`),
        rows: rep(8, (i) => i === 5 ? { label: words(30, i), start: 7, end: 7, milestone: true } : { label: words(30, i), start: i, end: Math.min(11, i + 4), highlight: i === 2 }),
        today: 6,
        source: words(90),
      },
    },
  }),
} satisfies Record<string, LayoutDef<any>>
