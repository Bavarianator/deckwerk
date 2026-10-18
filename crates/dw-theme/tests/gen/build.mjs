// Fixtures neu erzeugen (vom Repo-Stamm): node crates/dw-theme/tests/gen/build.mjs
// esbuild-API statt CLI: themeVars ist in slide.tsx nicht exportiert, das Plugin hängt den Export an die echte Datei an.
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const exportThemeVars = {
  name: 'themeVars',
  setup(b) {
    b.onLoad({ filter: /renderer[\\/]slide\.tsx$/ }, async (a) => ({ contents: `${await readFile(a.path, 'utf8')}\nexport { themeVars }\n`, loader: 'tsx' }))
  },
}
// Renderer-Pakete, die für themeVars keine Rolle spielen und im node_modules fehlen können: alles schluckender Stub
const stub = {
  name: 'stub',
  setup(b) {
    b.onResolve({ filter: /^highlight\.js/ }, (a) => ({ path: a.path, namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'const p = new Proxy(function () {}, { get: (_, k) => (k === "__esModule" ? false : p), apply: () => p }); module.exports = p', loader: 'js' }))
  },
}
const outfile = 'target/gen-resolved.cjs'
await build({
  entryPoints: ['crates/dw-theme/tests/gen/resolved.ts'], bundle: true, platform: 'node', outfile, logLevel: 'warning',
  loader: { '.css': 'empty', '.md': 'text', '.png': 'empty', '.svg': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
  plugins: [exportThemeVars, stub],
})
createRequire(import.meta.url)(`${process.cwd()}/${outfile}`)
