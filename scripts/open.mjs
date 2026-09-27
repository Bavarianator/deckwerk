// Öffnet einen Export in LibreOffice Impress (PPTX) bzw. im Standard-PDF-Betrachter.
// Aufruf: npm run open [-- exports/<datei>.pptx|.pdf]   ohne Argument: neueste exports/*.pptx
import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

let file = process.argv[2]
if (!file) {
  const pptx = readdirSync('exports').filter((f) => f.endsWith('.pptx')).map((f) => join('exports', f))
  file = pptx.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  if (!file) { console.error('Keine PPTX in exports/. Erst `npm run render examples/pitch.json`.'); process.exit(1) }
}
file = resolve(file)
const has = (cmd) => spawnSync('which', [cmd]).status === 0
const [cmd, ...args] = file.endsWith('.pdf') ? ['xdg-open']
  : has('soffice') ? ['soffice', '--impress']
  : ['flatpak', 'run', 'org.libreoffice.LibreOffice', '--impress']
spawn(cmd, [...args, file], { detached: true, stdio: 'ignore' }).unref()
console.log(`Öffne ${file}`)
