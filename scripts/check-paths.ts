// asset://-Pfade (Windows-Laufwerke, Linux-Pfade aus der Cloud-Sync): npx esbuild --bundle --platform=node --log-level=warning scripts/check-paths.ts --format=cjs --external:electron --loader:.md=text --loader:.css=empty --outfile=${TMPDIR:-/tmp}/check-paths.cjs && node ${TMPDIR:-/tmp}/check-paths.cjs
import { strictEqual as eq } from 'node:assert'
import { assetPath } from '../src/main/sync'
import { assetUrl } from '../src/main/tools'
import { assetOf } from '../src/renderer/ui/itemOps'

// Explorer-Pfad (Renderer) → asset:// → Main: Laufwerk ohne führenden Schrägstrich, Trenner als '/'
for (const p of ['C:\\Users\\Anna Müller\\Bilder\\foto #1.png', 'D:\\Präsentationen\\100% sicher\\logo.svg']) eq(assetPath(assetOf(p)), p.replace(/\\/g, '/'))
// Posix-Rundweg über pathToFileURL im Main-Prozess
const posix = '/home/a b/Deckwerk/assets/ä #1%.png'
eq(assetPath(assetUrl(posix)), posix)
eq(assetPath(assetOf(posix)), posix)
// Deck von einem Linux-Gerät (Cloud-Sync): bleibt Linux-Pfad, localAsset biegt ihn um
eq(assetPath('asset://local/home/x/Deckwerk/assets/foto%20a.png'), '/home/x/Deckwerk/assets/foto a.png')

console.log('check-paths: OK')
