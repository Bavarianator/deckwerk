// Komponenten zu src/shared/layouts-demo.ts: Code (Variante terminal) und Bildschirm. Verträge mit dem Film (film.ts):
// Code-Zeilen tragen data-anim (+ -start/-delay) und liegen innerhalb des einen nativen Textfelds, damit die PPTX keine
// Animation je Zeile bekommt; der Mauszeiger ist .dw-cursor[data-moves] im Medien-Container (offsetParent), ein Video
// liegt in einem [data-zooms]-Wrapper und trägt data-from/data-to.
import type { CSSProperties, ReactNode } from 'react'
import type { z } from 'zod'
import { converter } from 'culori'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { CODE_MAX, DEMO_LAYOUTS, codeLines, type CodeLang } from '../shared/layouts-demo'
import { ensureContrast } from '../shared/themes'
import { Header } from './layouts'
import { assetOf } from './ui/itemOps'
import { Box, Frame, Img, T, photoOf, useSlide } from './slide'
import './layouts-demo.css'

type Props<K extends keyof typeof DEMO_LAYOUTS> = { c: z.infer<(typeof DEMO_LAYOUTS)[K]['schema']>; v?: string }

const LANGS = { js: javascript, ts: typescript, python, bash, json, html: xml, css, sql, java, go, rust, yaml }
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang)

// Wenige Farben: Schlüsselwörter Akzent, Strings/Zahlen zweite Farbe, Kommentare gedämpft, alles andere Textfarbe
type Kind = 'kw' | 'str' | 'com' | 'txt'
const KIND: Record<string, Kind> = {
  keyword: 'kw', built_in: 'kw', type: 'kw', name: 'kw', 'selector-tag': 'kw', 'selector-class': 'kw', 'selector-id': 'kw',
  string: 'str', number: 'str', regexp: 'str', symbol: 'str', literal: 'str',
  comment: 'com', doctag: 'com', meta: 'com', subst: 'txt', // subst = Code in einem Template-String
}
const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" }
type Tok = { text: string; kind?: Kind }

// highlight.js liefert HTML mit verschachtelten <span class="hljs-…">: innen gewinnt, Unbekanntes erbt von außen. Ergebnis je Zeile.
function highlight(lines: string[], lang?: CodeLang): Tok[][] {
  if (!lang || lang === 'text' || !(lang in LANGS)) return lines.map((text) => [{ text }])
  const html = hljs.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value
  const out: Tok[][] = [[]], stack: (Kind | undefined)[] = []
  for (const part of html.split(/(<span class="[^"]*">|<\/span>)/)) {
    if (part.startsWith('<span ')) stack.push(KIND[/hljs-([\w-]+)/.exec(part)?.[1] ?? ''] ?? stack.at(-1))
    else if (part === '</span>') stack.pop()
    else part.replace(/&(?:amp|lt|gt|quot|#x27);/g, (m) => ENT[m]).split('\n').forEach((text, i) => {
      if (i) out.push([])
      if (text) out.at(-1)!.push({ text, kind: stack.at(-1) })
    })
  }
  return out
}

// "3-5,8" → {3, 4, 5, 8}, geschnitten auf die vorhandenen Zeilen (fremde deck.json kommt ungeprüft an); leer = kein Fokus, sonst wäre alles gedämpft
function focusOf(spec: string | undefined, lines: number): Set<number> | undefined {
  const on = new Set<number>()
  for (const part of spec?.split(',') ?? []) {
    const [a, b = a] = part.split('-').map(Number)
    for (let i = Math.max(a, 1); i <= Math.min(b, lines); i++) on.add(i)
  }
  return on.size ? on : undefined
}

const oklch = converter('oklch')

function CodeBlock({ c, terminal }: { c: Props<'code'>['c']; terminal: boolean }) {
  const { theme: t } = useSlide() // innerhalb von Frame: Farben des Folien-Tons
  const bg = t.c.surface
  // zweite Farbe: accent2, wenn das Theme eine bunte hat (sonst ist sie grau wie die Kommentare), sonst good
  const second = (oklch(t.c.accent2)?.c ?? 0) > 0.05 ? t.c.accent2 : t.c.good
  const color: Record<Kind, string> = { kw: t.c.accent, str: second, com: t.c.muted, txt: t.c.text }
  for (const k of Object.keys(color) as Kind[]) color[k] = ensureContrast(color[k], bg, 4.6) // Lint: Kontrast je Textlauf
  const lines = codeLines(c.code)
  const toks = terminal ? lines.map((l): Tok[] => (l.startsWith('$ ') ? [{ text: '$ ', kind: 'kw' }, { text: l.slice(2) }] : [{ text: l }])) : highlight(lines, c.lang)
  const focus = focusOf(c.focus, lines.length)
  const reveal = c.reveal ?? 'zeilen'
  const typing = reveal === 'tippen' && lines.join('').replace(/\s/g, '').length <= CODE_MAX.typing
  const first = lines.findIndex((l) => l.trim())
  const big = lines.length <= 10 && Math.max(...lines.map((l) => l.length)) <= 60 // kurzer Code in Lesegröße
  return (
    <div className="dwc" data-fit data-slot="code">
      <Box slot="_panel" className="dwc-panel">
        {terminal && <T role="label" slot={c.title ? 'title' : '_bar'} className="dwc-bar" style={{ color: color.com }}>{c.title ?? 'Terminal'}</T>}
        {/* Ein natives Textfeld: Zeilen enden auf \n (runsOf → Umbruch), Leerzeilen tragen ein Leerzeichen, sonst gingen sie in der PPTX verloren.
            PPTX-Schrift: IBM Plex Mono, wenn das Theme sie ohnehin einbettet (Mono-Labels), sonst Courier New (überall vorhanden, gleiche Laufweite 0,6 em) */}
        <div className={`t dwc-text ${big ? 'big' : ''}`} data-pptx="text" data-slot="code" data-role={big ? 'body' : 'small'} data-font="body" data-face={t.mono?.pptx ?? 'Courier New'}>
          {toks.map((line, i) => {
            const on = !focus || focus.has(i + 1)
            const blank = !lines[i].trim()
            const anim = reveal === 'ganz' || blank ? undefined : terminal ? (lines[i].startsWith('$ ') ? 'typewriter' : 'fade') : typing ? 'typewriter' : 'fade'
            return (
              <div key={i} className="dwc-line" style={{ color: on ? color.txt : color.com }}
                data-anim={anim} data-anim-start={anim && (terminal || i !== first ? 'after' : 'with')} data-anim-delay={anim === 'fade' && !terminal ? '0.1' : undefined}>
                {blank ? ' ' : line.map((k, j) => <span key={j} style={on && k.kind && k.kind !== 'txt' ? { color: color[k.kind] } : undefined}>{k.text}</span>)}
                {i < toks.length - 1 && '\n'}
              </div>
            )
          })}
        </div>
      </Box>
      {c.note && <T role="label" slot="note" className="dwc-note muted">{c.note}</T>}
    </div>
  )
}

function Code({ c, v }: Props<'code'>) {
  const terminal = v === 'terminal'
  return (
    <Frame>
      {c.title && !terminal && <Header c={{ title: c.title }} />}
      <CodeBlock c={c} terminal={terminal} />
    </Frame>
  )
}

// Seitenverhältnis des Mediums: Desktop-Screenshot 16:10 (capture_page 1440×900), Aufnahme 16:9, Handy 9:19,5.
// ponytail: festes Verhältnis, Bild per cover oben angelegt; bei abweichendem Bild sitzen cursor-Ziele leicht versetzt. Upgrade: Bildmaße messen.
function Screen({ c }: Props<'screen'>) {
  const frame = c.frame ?? 'browser'
  const img = photoOf(c.image)
  const video = c.video && (c.video.startsWith('/') ? assetOf(c.video) : c.video)
  const from = c.from ?? 0
  const ar = frame === 'handy' ? 9 / 19.5 : video ? 16 / 9 : 16 / 10
  // Video: Standbild und Rahmen liegen im Hintergrundbild der PPTX (?frame= ist keine Bilddatei); native Flächen würden das Standbild verdecken
  const shape = (slot: string, className: string, children?: ReactNode) =>
    video ? <div className={className}>{children}</div> : <Box slot={slot} className={className}>{children}</Box>
  const moves = c.cursor?.map((m, i) => ({ step: m.step ?? i + 1, x: m.x, y: m.y, ...(m.click && { click: true }), ...(m.zoom && { zoom: m.zoom }) }))
  const start = moves?.length ? moves.reduce((a, b) => (b.step < a.step ? b : a)) : undefined // ohne Film steht der Zeiger am ersten Ziel
  return (
    <Frame>
      {c.title && <Header c={{ title: c.title }} />}
      <div className="dws" data-fit data-slot="caption">
        <div className={`dws-stage dws-${frame}`} style={{ '--dws-ar': ar } as CSSProperties}>
          <div className="dws-win">
            {shape('_frame', 'dws-frame')}
            {frame === 'browser' && <div className="dws-bar">{shape('_url', 'dws-url', c.url && <T role="small" slot="url">{c.url}</T>)}</div>}
            {frame === 'fenster' && <div className="dws-bar">{c.url && <T role="small" slot="url" className="dws-title">{c.url}</T>}</div>}
            <div className="dws-media">
              {video ? (
                <div className="dws-zoom" data-zooms={c.zooms?.length ? JSON.stringify(c.zooms) : undefined}>
                  <div className="dws-still" style={{ backgroundImage: `url("${video}?frame=${from}")` }} />
                  {/* Standbild als poster statt Spulen: im Offscreen-Fenster hängt das Spulen (siehe Clip); der Film spult selbst */}
                  <video src={video} poster={`${video}?frame=${from}`} preload="metadata" muted={!!c.muted} playsInline data-from={from} data-to={c.to} />
                </div>
              ) : img?.src ? <Img src={img.src} slot="image" focus={img.focus ?? 'top'} look={img.look ?? 'natural'} /> : <div className="placeholder" />}
              {start && (
                <div className="dw-cursor" data-moves={JSON.stringify(moves)} style={{ left: `${start.x * 100}%`, top: `${start.y * 100}%` }}>
                  <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden><path d="M0 0v19l5.2-4.9 3.4 7.6 3.4-1.5-3.3-7.4h7.1z" fill="#111" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" /></svg>
                </div>
              )}
            </div>
          </div>
        </div>
        {c.caption && <T role="body" slot="caption" className="dws-cap">{c.caption}</T>}
      </div>
    </Frame>
  )
}

export const DEMO_COMPONENTS = { code: Code, screen: Screen }
