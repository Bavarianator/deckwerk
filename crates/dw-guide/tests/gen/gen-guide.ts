// for e in deckwerk pro; do npx esbuild crates/dw-guide/tests/gen/gen-guide.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=target/dw-guide-gen/gen.mjs --log-level=warning && DW_EDITION=$e node target/dw-guide-gen/gen.mjs; done
// Fixture für dw-guide (aus dem Repo-Wurzelverzeichnis ausführen, je Edition einmal): tests/fixtures/guide-<edition>.json mit
// Kernprompt, Video-Kernprompt, Index, Leitfaden, vollem Prompt und Modul-Liste, wie guide-modules.ts sie liefert.
// Datenordner mit Hausstil und einem Deck (zuletzt gebaute Decks), denselben legt tests/guide_diff.rs an.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = process.cwd()
const home = mkdtempSync(join(tmpdir(), 'dw-guide-gen-'))
process.env.DECKWERK_HOME = home
process.env.DECKWERK_OFFLINE = '1'
writeFileSync(join(home, 'hausstil.md'), '- Immer Du statt Sie\n- Kurze Sätze\n')
mkdirSync(join(home, 'Vortrag'))
writeFileSync(join(home, 'Vortrag', 'deck.json'), JSON.stringify({ title: 'Test  Vortrag', theme: { id: 'keynote' }, slides: [] }))

const { APP } = await import('../../../../src/shared/app-id')
const g = await import('../../../../src/main/guide-modules')
const route = { modules: ['stil', 'layout:chart', 'gibt-es-nicht'], source: 'regel' as const }
const out = {
  core: g.corePrompt(),
  video: g.corePrompt(true),
  index: g.guideIndex(),
  leitfaden: g.leitfaden(route),
  full: g.fullPrompt(),
  parts: g.guideParts().length,
  modules: g.guideModules().map((m) => ({ id: m.id, title: m.title, kurz: m.kurz, always: !!m.always })),
}
writeFileSync(join(ROOT, `crates/dw-guide/tests/fixtures/guide-${APP.pro ? 'pro' : 'deckwerk'}.json`), JSON.stringify(out, null, 1) + '\n')
console.log(`${APP.pro ? 'pro' : 'deckwerk'}: Kern ${out.core.length}, Video ${out.video.length}, voll ${out.full.length} Zeichen, ${out.modules.length} Module`)
process.exit(0)
