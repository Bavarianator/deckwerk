import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// "use client" in lucide-react ist nur für Server-Components relevant, im Bundle bedeutungslos
const onwarn = (w: { code?: string }, warn: (w: never) => void) => { if (w.code !== 'MODULE_LEVEL_DIRECTIVE') warn(w as never) }

export default defineConfig({
  // onnxruntime-node (Freisteller) ist ein natives Modul (.node) und muss zur Laufzeit aus node_modules kommen
  main: { build: { externalizeDeps: false, rollupOptions: { external: ['onnxruntime-node'], onwarn } } },
  preload: {},
  renderer: { plugins: [react()], build: { rollupOptions: { onwarn } } },
})
