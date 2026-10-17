// Prüfliste im Editor (lint_deck-Antwort parsen): npx esbuild scripts/check-lint-panel.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-lint-panel.mjs && node ${TMPDIR:-/tmp}/check-lint-panel.mjs
import assert from 'node:assert/strict'
import { parseLint } from '../src/renderer/ui/LintPanel'

// Format wie lint_deck in src/main/tools.ts
const text = `1 Fehler, 1 Warnungen, 1 Hinweise:
  - Folie 2 (ab12cd) [error] overflow @title: Text passt nicht
  - Folie 2 (ab12cd) [warn] titel-formel: Alle Titel gleich lang: a: b
  - Folie 5 (x9) (ausgeblendet) [hinweis] clip-kurz @items.v1: Clip unter 2 s`
const r = parseLint(text)
assert.equal(r.length, 3)
assert.deepEqual(r[0], { slide: 1, slideId: 'ab12cd', level: 'error', rule: 'overflow', slot: 'title', message: 'Text passt nicht' })
assert.equal(r[1].slot, undefined)
assert.equal(r[1].message, 'Alle Titel gleich lang: a: b')
assert.deepEqual([r[2].slide, r[2].level, r[2].slot], [4, 'hinweis', 'items.v1'])
assert.deepEqual(parseLint('Keine Probleme. Das Deck ist sauber.'), [])
console.log('check-lint-panel: ok')
