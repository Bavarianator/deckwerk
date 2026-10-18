// npx esbuild crates/dw-docx/tests/gen/gen-docx.ts --bundle --platform=node --format=esm --outfile=target/dw-docx-gen/gen.mjs --log-level=warning && node target/dw-docx-gen/gen.mjs
// Fixture für dw-docx (aus dem Repo-Wurzelverzeichnis): Eingabe (Deck-Kopf, gemessene Seiten, Theme-Schriften) und die
// XML-Teile, die buildDocx daraus baut. Ohne eingebettete Schriften (randomUUID), die prüft ein Rust-Test für sich.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { buildDocx } from '../../../../src/main/export-docx'
import { resolveTheme } from '../../../../src/shared/themes'

const base = { build: undefined }
const run = (text: string, o = {}) => ({ text, bold: false, italic: false, color: '#1a2b3c', ...o })
const text = (slot: string, box: object, o: object) => ({
  kind: 'text', slot, box, font: 'body', role: 'body', sizePx: 24, lineHeightPx: 31.2, trackingPx: 0, align: 'left', upper: false, lines: 2, bg: '#ffffff', ...base, ...o,
})
const pages = [
  [
    text('title', { x: 80, y: 60, w: 900, h: 120 }, { font: 'head', role: 'title', sizePx: 52.5, lineHeightPx: 57.75, trackingPx: -0.5, runs: [run('Umsatz <wächst> & "mehr"\u0007', { bold: true }), run('Zeile 2', { italic: true, breakAfter: true })] }),
    { kind: 'box', slot: 'deko', box: { x: 0, y: 0, w: 10, h: 10 }, radius: 0, ellipse: false },
    text('foot', { x: 80, y: 680, w: 400, h: 20 }, { align: 'right', lines: 1, upper: true, runs: [run('Quelle', { link: 'https://example.org/?a=1&b=2', underline: true, sizePx: 12.3, trackingPx: 1.2 })] }),
    text('leer', { x: 1, y: 1, w: 1, h: 1 }, { runs: [run('')] }),
  ],
  [
    text('free', { x: 300.4, y: 200.6, w: 500.5, h: 80 }, { align: 'center', rot: -30.5, fontFace: 'DM Serif Display', effect: { type: 'hollow', color: '#ff0000' }, runs: [run('Kontur')] }),
  ],
]
const deck = { title: 'Diff & <Test>', theme: { id: 'beratung' }, size: { w: 1280, h: 720 }, slides: [] }
const t = resolveTheme(deck.theme as never)
const png = Buffer.from('89504e470d0a1a0a', 'hex')
const buf = await buildDocx(deck as never, pages.map((els) => ({ measured: { els, fit: { ok: true, head: 0, body: 0, overflow: [] } } as never, background: png })))
const zip = await JSZip.loadAsync(buf)
const parts: Record<string, string> = {}
for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.xml') || n.endsWith('.rels'))) parts[name] = await zip.file(name)!.async('string')
const out = { title: deck.title, size: deck.size, head: t.head.pptx, body: t.body.pptx, pages, files: Object.keys(zip.files).filter((n) => !zip.files[n].dir), parts }
writeFileSync(join(process.cwd(), 'crates/dw-docx/tests/fixtures/docx.json'), JSON.stringify(out, null, 1) + '\n')
console.log(`docx: ${Object.keys(parts).length} Teile`)
