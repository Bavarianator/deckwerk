// node crates/dw-video/tests/gen/gen.mjs   (aus dem Repo-Wurzelverzeichnis; braucht node_modules mit esbuild)
// Bündelt gen-video.ts mit Attrappen für ffmpeg, Handy und Render-Fenster (die Exporte laufen ohne Prozesse, die Attrappe
// zeichnet die ffmpeg-Argumente auf) und führt es aus. Ergebnis: crates/dw-video/tests/fixtures/video.json
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const tmp = resolve(process.env.DW_GEN_TMP ?? 'target/tmp/dw-video-gen') // nicht /tmp (kleines tmpfs)
mkdirSync(tmp, { recursive: true })
const stubs = {
  ffmpeg: `const S = () => globalThis.__dw
export const ffmpegBin = async () => 'ffmpeg'
export const hasEncoder = async () => false
export const probe = async () => S().probe
export const run = async (_bin, args, o = {}) => S().run(args, o)
export const runFfmpeg = async (args, o = {}) => { S().calls.push({ args, cwd: o.cwd, duration: o.duration }) }
export const silences = async (_file, from, to, min) => S().silences(from, to, min)
export const frameVf = () => ''`,
  'phone-ffmpeg': `export const phoneFfmpeg = async () => { throw new Error('kein Handy im Test') }`,
  'export-pptx': `export const fontsOf = () => []`,
  render: `export const renderFilm = async () => { throw new Error('kein Render im Test') }; export const renderSlide = renderFilm`,
}
const stub = {
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: /^\.\/(ffmpeg|phone-ffmpeg|render|export-pptx)$/ }, (a) => (a.importer.includes('/src/main/') ? { path: a.path.slice(2), namespace: 'stub' } : undefined))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ contents: stubs[a.path], loader: 'js' }))
  },
}
const outfile = resolve(tmp, 'gen-video.mjs')
await build({ entryPoints: ['crates/dw-video/tests/gen/gen-video.ts'], bundle: true, platform: 'node', format: 'esm', outfile, plugins: [stub], external: ['electron'], logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } })
process.env.DW_GEN_TMP = tmp
await import(pathToFileURL(outfile).href)
