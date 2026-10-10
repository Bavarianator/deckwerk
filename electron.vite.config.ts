import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// "use client" in lucide-react ist nur für Server-Components relevant, im Bundle bedeutungslos
const onwarn = (w: { code?: string }, warn: (w: never) => void) => { if (w.code !== 'MODULE_LEVEL_DIRECTIVE') warn(w as never) }

export default defineConfig({
  // onnxruntime-node (Freisteller) und sherpa-onnx-node (Spracherkennung) sind native Module (.node) und müssen zur Laufzeit
  // aus node_modules kommen. sherpa-worker ist ein eigener Einstieg: sherpa.ts startet ihn als Kindprozess (out/main/sherpa-worker.js).
  // Chunks wie ohne input direkt in out/main, sonst stimmen die __dirname-Pfade (../renderer, ../preload) nicht mehr.
  main: { build: { externalizeDeps: false, rollupOptions: { input: { index: 'src/main/index.ts', 'sherpa-worker': 'src/main/sherpa-worker.ts' }, external: ['onnxruntime-node', /^sherpa-onnx-node(\/.*)?$/], output: { chunkFileNames: '[name]-[hash].js' }, onwarn } } },
  preload: {},
  renderer: { plugins: [react()], build: { rollupOptions: { onwarn } } },
})
