// Demo-Layouts für Live-Demos und Erklärvideos (Feature „Animation“), auch in Präsentationen nutzbar: Code (Variante terminal)
// und Bildschirm (Screenshot oder Aufnahme im Rahmen, mit Mauszeiger). Nur Typ-Import aus ./layouts (zyklusfrei wie layouts-extra).
// Komponenten: src/renderer/layouts-demo.tsx (gleiche ids).
import { z } from 'zod'
import type { LayoutDef } from './layouts'
import { ZOOM_SCALE } from './film'
import { photo } from './layouts-extra'

export const CODE_LANGS = ['js', 'ts', 'python', 'bash', 'json', 'html', 'css', 'sql', 'java', 'go', 'rust', 'yaml', 'text'] as const
export type CodeLang = (typeof CODE_LANGS)[number]
// 20 Zeilen: mehr passt in 16:9 mit Titel und Notiz nicht über die Mindestgröße (Lint min-size 13 px); typing = Zeichen, bis zu denen „tippen“ gilt
export const CODE_MAX = { lines: 20, chars: 90, typing: 200 }
export const SCREEN_FRAMES = ['browser', 'fenster', 'handy', 'ohne'] as const

/** Zeilen des Codes, wie das Layout sie zeigt: Tabs als zwei Leerzeichen, ohne Leerzeilen am Anfang und Ende */
export const codeLines = (code: string) => code.replace(/\r/g, '').replace(/\t/g, '  ').replace(/^\s*\n/, '').trimEnd().split('\n')

const rep = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i))
const fill = (s: string, n: number) => s.padEnd(n, ' wert').slice(0, n) // Stresstest: Text genau an der Grenze

const code = z.object({
  title: z.string().min(3).max(50).optional().describe('kurze Überschrift, z. B. „So meldet sich der Client an“; bei terminal steht sie in der Kopfzeile des Fensters'),
  code: z.string().min(1).max(CODE_MAX.lines * (CODE_MAX.chars + 1))
    .refine((s) => s.trim().length > 0, 'code ist leer – Quelltext oder Befehle eintragen')
    .refine((s) => codeLines(s).length <= CODE_MAX.lines, `höchstens ${CODE_MAX.lines} Zeilen – kürzen oder auf zwei Folien teilen`)
    .refine((s) => codeLines(s).every((l) => l.length <= CODE_MAX.chars), `höchstens ${CODE_MAX.chars} Zeichen je Zeile`)
    .describe(`Quelltext mit \\n zwischen den Zeilen, höchstens ${CODE_MAX.lines} Zeilen (besser bis 18) mit je ${CODE_MAX.chars} Zeichen. terminal: Befehle beginnen mit „$ “, die übrigen Zeilen sind Ausgabe`),
  lang: z.enum(CODE_LANGS).optional().describe('Sprache für die Syntaxfarben; text oder weglassen = ohne Farben'),
  focus: z.string().max(40).regex(/^\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*$/, 'Zeilen wie "3-5,8"').optional()
    .describe('Zeilen, um die es geht (ab 1), z. B. "3-5,8": sie behalten ihre Farben, die übrigen werden gedämpft'),
  note: z.string().max(140).optional().describe('ein Satz unter dem Code: was die wichtigen Zeilen tun'),
  reveal: z.enum(['zeilen', 'tippen', 'ganz']).optional()
    .describe(`Aufbau beim Präsentieren und im Film: zeilen = Zeile für Zeile (Standard), tippen = Zeichen für Zeichen (nur bis ${CODE_MAX.typing} Zeichen, sonst zeilen), ganz = alles sofort`),
})

const unit = (what: string) => z.number().min(0).max(1).describe(what)
const cursorMove = z.object({
  x: unit('Zielpunkt waagrecht als Anteil des Bildes, 0 = links'),
  y: unit('Zielpunkt senkrecht als Anteil des Bildes, 0 = oben'),
  step: z.number().int().min(0).max(30).optional().describe('Takt, in dem der Zeiger hinfährt; Standard = Platz in der Liste (1, 2, 3 …), 0 = Startlage ohne Fahrt'),
  click: z.boolean().optional().describe('Klick-Welle am Ziel'),
  zoom: z.number().min(ZOOM_SCALE.min).max(ZOOM_SCALE.max).optional().describe('Kamera vergrößert auf das Ziel, z. B. 2; das nächste Ziel ohne zoom fährt wieder heraus'),
})
const screenZoom = z.object({
  start: z.number().min(0), end: z.number().min(0),
  x: unit('Zielpunkt waagrecht, 0..1'), y: unit('Zielpunkt senkrecht, 0..1'),
  scale: z.number().min(ZOOM_SCALE.min).max(ZOOM_SCALE.max).optional().describe(`Vergrößerung, Standard ${ZOOM_SCALE.def}`),
}).refine((m) => m.end > m.start, 'end muss nach start liegen')

const screen = z.object({
  title: z.string().min(3).max(60).optional().describe('Aussage oder kurze Überschrift, z. B. „Der Export dauert drei Klicks“'),
  image: photo.optional().describe('Screenshot (asset://… aus capture_page oder dem Anhang); genau eins von image oder video'),
  // nur asset:// oder absoluter Pfad (Medien laufen über asset:// und MEDIA_EXT); keine Anführungszeichen, der Pfad landet in url("…")
  video: z.string().regex(/^(asset:\/\/|\/)[^"\\\n]*\.(mp4|webm|mov)$/i, 'Video als asset://… oder absoluter Pfad auf .mp4, .webm oder .mov').optional()
    .describe('Bildschirmaufnahme (asset://… oder absoluter Pfad); genau eins von image oder video'),
  from: z.number().min(0).optional().describe('nur video: Startsekunde (Standard 0); Editor, PDF und PPTX zeigen das Bild bei from'),
  to: z.number().min(0).optional().describe('nur video: Endsekunde; ohne = bis zum Ende'),
  muted: z.boolean().optional().describe('nur video: Ton der Aufnahme stumm'),
  frame: z.enum(SCREEN_FRAMES).optional()
    .describe('Rahmen: browser (Standard, Kopfzeile mit Adressfeld), fenster (Titelzeile), handy (Hochformat, für Handy-Screenshots), ohne (runde Ecken, weicher Schatten)'),
  url: z.string().max(60).optional().describe('Text im Adressfeld (browser) bzw. Fenstertitel (fenster), z. B. "example.com/export"'),
  caption: z.string().max(140).optional().describe('ein Satz neben dem Bild: was man sieht oder worauf es ankommt'),
  cursor: z.array(cursorMove).min(1).max(8).optional()
    .describe('Mauszeiger für Screenshots: steht am ersten Ziel, im Film fährt er Takt für Takt die Ziele an; nicht in der PPTX. Bei video weglassen: Dort ist der echte Zeiger schon im Bild (zooms vergrößert ihn mit)'),
  zooms: z.array(screenZoom).max(12).optional().describe('nur video: Vergrößerung auf Stellen der Aufnahme, Zeiten in Videosekunden (aus screen_zooms); wirkt im Film'),
})
  .refine((c) => !c.image !== !c.video, 'genau eins von image oder video')
  .refine((c) => !!c.video || (c.from === undefined && c.to === undefined && c.muted === undefined && !c.zooms), 'from, to, muted und zooms nur mit video')
  .refine((c) => c.to === undefined || c.to > (c.from ?? 0), 'to muss nach from liegen')

const L = <S extends z.ZodObject>(d: LayoutDef<S>) => d

export const DEMO_LAYOUTS = {
  code: L({
    id: 'code', name: 'Code', variants: ['editor', 'terminal'],
    when: 'Quelltext, Konfiguration oder Befehle zeigen (Live-Demo, Erklärvideo, Entwickler-Vortrag). Bis ~18 Zeilen, lang für Syntaxfarben, focus auf die Zeilen, um die es geht (der Rest wird gedämpft), note erklärt sie in einem Satz. Variante terminal: Befehle mit „$ “ am Zeilenanfang, sonst Ausgabe; der Titel steht in der Kopfzeile. reveal: zeilen (Standard) baut Zeile für Zeile auf, tippen tippt kurzen Code, ganz zeigt alles sofort.',
    schema: code, defaultBuild: 'none', footer: true,
    samples: {
      min: { code: 'print("Hallo, Welt")' },
      typ: {
        title: 'Eine Abfrage liefert den Wochenumsatz', lang: 'ts', focus: '6-7',
        code: "// Bestellungen der letzten sieben Tage laden\nconst seit = new Date(Date.now() - 7 * 864e5)\nconst res = await fetch(`/api/orders?since=${seit.toISOString()}`)\nif (!res.ok) throw new Error(`HTTP ${res.status}`)\n\nconst orders = await res.json()\nconst umsatz = orders.reduce((s, o) => s + o.total, 0)\nconsole.log(`${orders.length} Bestellungen, ${umsatz} €`)",
        note: 'reduce summiert die Beträge aller Bestellungen in einem Durchlauf.',
      },
      max: {
        title: fill('Der Bericht entsteht in einem Durchlauf', 50), lang: 'python', focus: '3-5,8', reveal: 'tippen',
        code: rep(CODE_MAX.lines, (i) => fill(`    summe_${i} = berechne(region="Nord", quartal=${i}, faktor=1.25)  # Prüfwert`, CODE_MAX.chars)).join('\n'),
        note: fill('Jede Zeile berechnet eine Region; die markierten Zeilen fließen in den Bericht ein', 140),
      },
    },
  }),
  screen: L({
    id: 'screen', name: 'Bildschirm',
    when: 'Bildschirm zeigen (Produkt-Demo, Website, App, Bildschirmaufnahme): Screenshot (image) oder Aufnahme (video mit from/to) im Rahmen browser (Standard, url im Adressfeld), fenster, handy (Hochformat) oder ohne. cursor setzt Klickziele als Anteile 0–1 des Bildes, im Film fährt der Zeiger sie Takt für Takt an; zooms vergrößert Stellen der Aufnahme. caption sagt in einem Satz, was man sieht.',
    schema: screen, defaultBuild: 'none', footer: true,
    samples: {
      min: { image: { src: '' }, frame: 'handy' },
      typ: {
        title: 'Der Export dauert drei Klicks', image: { src: '' }, url: 'example.com/export',
        caption: 'Format wählen, prüfen, herunterladen: Die Datei lässt sich sofort in PowerPoint bearbeiten.',
        cursor: [{ x: 0.2, y: 0.3 }, { x: 0.62, y: 0.55, click: true }, { x: 0.84, y: 0.86, click: true, zoom: 2 }],
      },
      max: {
        title: fill('Der Export dauert drei Klicks', 60), image: { src: '' }, frame: 'browser', url: fill('example.com/export', 60),
        caption: fill('Format wählen, prüfen, herunterladen', 140),
        cursor: rep(8, (i) => ({ x: (i + 1) / 9, y: 1 - (i + 1) / 9, step: i, click: true, zoom: ZOOM_SCALE.max })),
      },
    },
  }),
} satisfies Record<string, LayoutDef<any>>
