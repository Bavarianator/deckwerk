// Stapel-Export (export_deck formats): npx esbuild scripts/check-batch.ts --bundle --platform=node --format=esm --loader:.md=text --external:./render --external:./export-pptx --external:electron --outfile=${TMPDIR:-/tmp}/check-batch.mjs && node ${TMPDIR:-/tmp}/check-batch.mjs
// Engine-Attrappe kodiert wie engine.ts (Name slug+formatSuffix, Größe outSize(sizeOf(deck))) per ffmpeg; geprüft werden Dateien und Maße per probe.
import { deepStrictEqual as eq, ok, rejects } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { formatSuffix, sizeOf, type Deck } from '../src/shared/deck'
import { outSize, type ClipContent } from '../src/shared/video'
import { buildTools, JOB_WAIT } from '../src/main/tools'
import { encodeClip } from '../src/main/export-video'
import { probe, runFfmpeg } from '../src/main/ffmpeg'

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'check-batch-'))
try {
  const src = join(dir, 'quelle.mp4')
  await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-shortest', src])
  const deck = { title: 'Stapel', theme: { id: 'beratung' }, transition: 'none', mode: 'click', size: { w: 720, h: 1280 },
    slides: [{ id: 'a', layout: 'clip', content: { video: src, parts: [{ start: 0.5, end: 1.5 }], captions: 'aus' } }] } as unknown as Deck
  const seen: Deck[] = []
  const engine = {
    measure: async () => [], renderPng: async () => [], renderOverview: async () => Buffer.alloc(0), lint: async () => [],
    exportDeck: async (d: Deck, _f: string, out: string, _p: unknown, onProgress?: (p: number) => void) => {
      seen.push(d)
      const file = join(out, `stapel${formatSuffix(d.size)}.mp4`), c = d.slides[0].content as ClipContent
      await encodeClip({ file: src, parts: c.parts, captions: 'aus', transcript: null, size: outSize(sizeOf(d)), font: { name: 'Archivo', files: [readFileSync(resolve('assets/fonts/Archivo-Bold.ttf'))], bold: true }, accent: '#FF8800' } as never, file, dir)
      onProgress?.(100)
      return [file]
    },
  }
  let cur: Deck | null = structuredClone(deck)
  const tools = buildTools({ engine: engine as never, getDeck: () => cur, setDeck: (d) => { cur = d }, assetDir: dir, outDir: dir })
  const t = tools.find((x) => x.name === 'export_deck')!
  JOB_WAIT.ms = 2000
  const run = async (input: unknown) => { // wie die KI: bei „läuft noch“ erneut aufrufen
    for (;;) { const r = await t.run(t.inputSchema.parse(input)); if (!r.text.includes('läuft noch')) return r }
  }

  // eigenes Format (9:16) nicht doppelt, Duplikate einmal
  const r = await run({ format: 'clips', formats: ['9:16', '1:1', '16:9', '1:1'] })
  ok(r.text.startsWith('Exportiert (clips):'), r.text)
  const files = r.text.split('\n').filter((l) => l.endsWith('.mp4'))
  eq(files.map((f) => basename(f)), ['stapel-9x16.mp4', 'stapel-1x1.mp4', 'stapel.mp4'])
  eq(await Promise.all(files.map(async (f) => { const p = await probe(f); return [p.w, p.h] })), [[1080, 1920], [1620, 1620], [1920, 1080]])
  eq(cur, deck) // Deck bleibt unverändert
  eq(seen.map((d) => d.size), [{ w: 720, h: 1280 }, { w: 1080, h: 1080 }, { w: 1280, h: 720 }])

  // mp4: eigenes Format zuerst, dann die weiteren
  const e2 = { ...engine, exportDeck: async (d: Deck, f: string, o: string) => [`${o}/x${formatSuffix(d.size)}.${f}`] }
  const t2 = buildTools({ engine: e2 as never, getDeck: () => cur, setDeck: () => {}, assetDir: dir, outDir: join(dir, 'b') }).find((x) => x.name === 'export_deck')!
  eq((await t2.run(t2.inputSchema.parse({ format: 'mp4', formats: ['4:5'] }))).text.split('\n').slice(1, 3), [`${dir}/b/x-9x16.mp4`, `${dir}/b/x-4x5.mp4`])

  // nur clips und mp4; Einblendung einer Folie → Hinweis
  await rejects(run({ format: 'pdf', formats: ['1:1'] }), /nur für clips und mp4/)
  cur = { ...structuredClone(deck), slides: [{ ...deck.slides[0], content: { ...(deck.slides[0].content as object), overlays: [{ start: 0.5, end: 1, slide: 1 }] } }] } as Deck
  ok((await t2.run(t2.inputSchema.parse({ format: 'clips', formats: ['1:1'] }))).text.includes('gestreckt'))
  console.log('check-batch: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
