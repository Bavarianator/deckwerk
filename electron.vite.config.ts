import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// "use client" in lucide-react ist nur für Server-Components relevant, im Bundle bedeutungslos
const onwarn = (w: { code?: string }, warn: (w: never) => void) => { if (w.code !== 'MODULE_LEVEL_DIRECTIVE') warn(w as never) }

// Tastenkürzel- und Dateimanager-Texte der Oberfläche pro Plattform. Build-Zeit reicht: DMG und Setup werden auf macOS
// bzw. Windows gebaut. DW_PLATFORM nur zum Testen unter Linux. Auf dem Mac ⌘ statt Strg (die Handler prüfen ctrlKey || metaKey).
const platform = process.env.DW_PLATFORM ?? process.platform
const shortcuts: Plugin = {
  name: 'dw-plattform-texte',
  enforce: 'pre',
  transform(s, id) {
    if (!/\/src\/renderer\/.*\.tsx?(\?|$)/.test(id)) return null
    if (platform === 'win32') return s.replaceAll('aus dem Dateimanager', 'aus dem Explorer').replaceAll('im Dateimanager', 'im Explorer')
    if (platform !== 'darwin') return null
    // Strg+Alt+T steht nur im Linux-Zweig (Terminal öffnen) und bleibt; „Strg + −)“ aus den Zoom-Titeln wird „⌘−)“
    return s.replace(/Strg\+(⇧\+|Umschalt\+)/g, '⌘⇧').replace(/Strg\+(?!Alt)(\S)/g, '⌘$1').replace(/Strg \+ (\S\))/g, '⌘$1').replaceAll('<kbd>Entf</kbd>', '<kbd>⌫</kbd>').replaceAll('(Umschalt: ', '(⇧: ').replaceAll('aus dem Dateimanager', 'aus dem Finder').replaceAll('<kbd>Strg</kbd>', '<kbd>⌘</kbd>').replaceAll('(F5)', '(⌥⌘P)').replaceAll('<kbd>F5</kbd>', '<kbd>⌥⌘P</kbd>')
      // Kürzelübersicht (ShortcutSheet), Stil kopieren (Strg+Alt+C/V), Suchleiste (Umschalt+Enter); e.key === 'F5' im Code bleibt
      .replace(/Strg\+Alt\+([CV])\b/g, '⌥⌘$1').replaceAll("['F5',", "['⌥⌘P',").replaceAll("['Umschalt+F5',", "['⌥⇧⌘P',").replaceAll('Umschalt+', '⇧')
      .replaceAll("['Entf',", "['⌫',").replaceAll('(Entf)', '(⌫)').replaceAll('· Entf ', '· ⌫ ').replaceAll('(mit Umschalt ', '(mit ⇧ ').replace(/'(Umschalt|Alt|Strg) (beim|an) /g, (_, k: 'Umschalt' | 'Alt' | 'Strg', w) => `'${{ Umschalt: '⇧', Alt: '⌥', Strg: '⌘' }[k]} ${w} `)
  },
}

// Edition (Deckwerk oder Deckwerk Pro) zur Build-Zeit: DW_EDITION=pro, sonst Deckwerk (src/shared/app-id.ts)
const define = { __DW_EDITION__: JSON.stringify(process.env.DW_EDITION === 'pro' ? 'pro' : 'deckwerk') }

export default defineConfig({
  // onnxruntime-node (Freisteller) und sherpa-onnx-node (Spracherkennung) sind native Module (.node) und müssen zur Laufzeit
  // aus node_modules kommen. sherpa-worker ist ein eigener Einstieg: sherpa.ts startet ihn als Kindprozess (out/main/sherpa-worker.js).
  // Chunks wie ohne input direkt in out/main, sonst stimmen die __dirname-Pfade (../renderer, ../preload) nicht mehr.
  main: { define, build: { externalizeDeps: false, rollupOptions: { input: { index: 'src/main/index.ts', 'sherpa-worker': 'src/main/sherpa-worker.ts' }, external: ['onnxruntime-node', /^sherpa-onnx-node(\/.*)?$/], output: { chunkFileNames: '[name]-[hash].js' }, onwarn } } },
  preload: { define },
  renderer: { define, plugins: [shortcuts, react()], build: { rollupOptions: { onwarn } } },
})
