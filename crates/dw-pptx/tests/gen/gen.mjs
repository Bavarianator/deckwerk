// node crates/dw-pptx/tests/gen/gen.mjs → crates/dw-pptx/tests/fixtures/*.json, *.eot (Differenztests gegen die TS-Quelle)
// Bündelt gen.ts mit esbuild. Nicht exportierte TS-Funktionen (injectSlide, transitionXml, addChart, stepsFor, ITEM_FX)
// macht ein Plugin beim Laden sichtbar; electron wird durch einen leeren Stub ersetzt. Die TS-Quellen bleiben unverändert.
import { build } from 'esbuild'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../../..')
const out = join(root, 'target/dw-pptx-gen/gen.mjs') // nicht /tmp (tmpfs), nicht out/ (electron-vite leert es)
mkdirSync(dirname(out), { recursive: true })
const extra = {
  'src/main/animations.ts': 'export { injectSlide, transitionXml }',
  'src/main/export-pptx.ts': 'export { addChart, stepsFor, ITEM_FX }',
}
await build({
  entryPoints: [join(here, 'gen.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  loader: { '.md': 'text' }, external: ['sharp', 'onnxruntime-node', 'sherpa-onnx-node'],
  plugins: [{
    name: 'dw-gen',
    setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { app: { getAppPath: () => "" }, nativeImage: {}, net: {}, safeStorage: {} }', loader: 'js' }))
      b.onLoad({ filter: /src\/main\/(animations|export-pptx)\.ts$/ }, (a) => {
        const rel = Object.keys(extra).find((k) => a.path.endsWith(k))
        return { contents: readFileSync(a.path, 'utf8') + '\n' + extra[rel] + '\n', loader: 'ts' }
      })
    },
  }],
})
process.env.DW_FIXTURES = join(here, '../fixtures')
process.env.DW_ROOT = root
await import(pathToFileURL(out).href)
