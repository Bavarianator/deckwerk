// Messlauf Router: ohne --live nur der Regel-Router, mit --live zusätzlich Haiku über `claude -p` (Login des Nutzers, je Fall
// ~0,2 Cent und 10–30 s; Zeitlimit wie in der App 30 s, ändern mit --timeout=<s>):
// npx esbuild scripts/router-eval.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=out/router-eval.mjs && node out/router-eval.mjs [--live]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { corePrompt, fullPrompt, modulesText, ruleRoute, type Route, type RouteInput } from '../src/main/guide-modules'
import { routeTask } from '../src/main/router'

process.env.DECKWERK_HOME = mkdtempSync(join(tmpdir(), 'dw-router-eval-')) // ohne Hausstil und Decks des Nutzers: vergleichbar
const live = process.argv.includes('--live')
const timeoutMs = Number(process.argv.find((a) => a.startsWith('--timeout='))?.slice(10)) * 1000 || undefined

const neu = (text: string, profile: RouteInput['profile'] = 'slides'): RouteInput => ({ text, profile, layoutsInDeck: [], hasDeck: false })
const alt = (text: string, layoutsInDeck: string[], profile: RouteInput['profile'] = 'slides'): RouteInput => ({ text, profile, layoutsInDeck, hasDeck: true })
const DECK = ['cover', 'bullets', 'kpi-grid', 'chart', 'statement', 'image-text', 'closing']

// Fall, Eingabe, Pflicht-Module (was die KI für den Auftrag sicher braucht, knapp gehalten)
const FAELLE: [string, RouteInput, string[]][] = [
  ['Pitch', neu('Erstelle einen Pitch für unser Start-up (Bio-Gemüse-Lieferdienst), 10 Folien, für Investoren'), ['geruest-praesentation', 'storyline', 'gestaltung', 'layout:cover', 'layout:statement']],
  ['Quartalsbericht', neu('Quartalsbericht Q3 für die Geschäftsführung mit Diagrammen: Umsatz +12 %, Kosten, Ausblick'), ['geruest-praesentation', 'inhalt-layout', 'layout:chart', 'layout:kpi-grid']],
  ['Instagram-Karussell', neu('Instagram-Karussell mit 6 Slides: 5 Tipps für besseren Schlaf', 'social'), ['geruest-social', 'gestaltung', 'layout:cover']],
  ['Flyer Sommerfest', neu('Flyer für unser Sommerfest im Kindergarten am 12. Juli', 'doc'), ['geruest-a4', 'layout:flyer']],
  ['Bewerbung', neu('Bewerbung als Pflegefachkraft im Klinikum, mit Anschreiben und Lebenslauf', 'doc'), ['geruest-a4', 'layout:letter', 'layout:cv', 'layout:application-cover']],
  ['Lebenslauf', neu('Schreib mir einen Lebenslauf, ich bin Elektroniker mit 8 Jahren Berufserfahrung', 'doc'), ['geruest-a4', 'layout:cv']],
  ['Visitenkarte', neu('Visitenkarte für mein Fotostudio', 'doc'), ['geruest-visitenkarte', 'layout:business-card']],
  ['Urkunde', neu('Urkunde für den Sieger im Vereinsturnier', 'doc'), ['geruest-a4', 'layout:certificate']],
  ['Speisekarte', neu('Speisekarte für unser italienisches Restaurant, Vorspeisen, Pasta, Desserts', 'doc'), ['geruest-a4', 'layout:menu']],
  ['Einladung', neu('Einladung zu 25 Jahren Firmenjubiläum mit Programm und Anmeldung', 'doc'), ['geruest-a4', 'layout:invitation']],
  ['Brief', neu('Brief an unsere Kunden: Preiserhöhung ab Januar freundlich erklären', 'doc'), ['geruest-a4', 'layout:letter']],
  ['Animation ruhiger', alt('Animationen ruhiger machen', ['cover', 'kpi-grid', 'chart', 'closing']), ['animation', 'katalog-animationen', 'layout:kpi-grid', 'layout:chart']],
  ['Zeitstrahl', alt('Folie 3 als Zeitstrahl', DECK), ['layout:timeline']],
  ['Mutiger', alt('Mach es mutiger', DECK), ['stil', 'gestaltung']],
  ['Bilder suchen', alt('Bilder für alle Folien suchen', DECK), ['fotos']],
  ['Übersetzen', alt('übersetze ins Englische', DECK), ['deck-auftraege', 'text']],
  ['Plakat A2', neu('Plakat in A2 für unser Stadtteilkonzert', 'doc'), ['geruest-a4', 'layout:flyer']],
  ['Workshop-Agenda', neu('Präsentation für einen halbtägigen Workshop mit Agenda und Übungen'), ['geruest-praesentation', 'layout:agenda']],
  ['Datenschutz-Schulung', neu('Datenschutz-Schulung für neue Mitarbeitende, ca. 15 Folien'), ['geruest-praesentation', 'storyline', 'layout:bullets']],
  ['Tippfehler', alt('Auf Folie 2 steht „Umstaz“ statt „Umsatz“', DECK), ['text']],
]

const core = corePrompt().length, full = fullPrompt().length
type Mess = { hits: number; must: number; mods: number; chars: number; ms: number; fallback: boolean }
const sum: Record<string, Mess[]> = { Regel: [], Haiku: [] }
const pct = (a: number, b: number) => `${Math.round((100 * a) / b)} %`
const zeile = (name: string, r: Route, must: string[], ms: number) => {
  const m: Mess = { hits: must.filter((id) => r.modules.includes(id)).length, must: must.length, mods: r.modules.length, chars: core + modulesText(r.modules).length, ms, fallback: r.reason?.startsWith('Fallback') ?? false }
  sum[name].push(m)
  const fehlt = must.filter((id) => !r.modules.includes(id))
  return `${name.padEnd(5)} ${m.hits}/${m.must}  ${String(m.mods).padStart(2)} Module  ${String(m.chars).padStart(6)} Z. (${pct(m.chars, full).padStart(5)})  ${(ms / 1000).toFixed(1).padStart(5)} s` +
    `${r.model ? `  ${r.model}/${r.effort ?? '-'}` : ''}${fehlt.length ? `  fehlt: ${fehlt.join(', ')}` : ''}${m.fallback ? `  ${r.reason}` : ''}`
}

console.log(`Kernprompt ${core} Z., voller Prompt ${full} Z.${live ? '' : ' (nur Regeln; Haiku mit --live)'}\n`)
for (const [name, input, must] of FAELLE) {
  console.log(name)
  let t = performance.now()
  console.log(`  ${zeile('Regel', ruleRoute(input), must, performance.now() - t)}`)
  if (!live) continue
  t = performance.now()
  const r = await routeTask(input, { kind: 'claude', bin: 'claude' }, { auto: true, timeoutMs })
  console.log(`  ${zeile('Haiku', r, must, performance.now() - t)}`)
}

console.log('\nSumme')
for (const [name, ms] of Object.entries(sum).filter(([, v]) => v.length)) {
  const total = (k: keyof Mess) => ms.reduce((a, m) => a + Number(m[k]), 0), n = ms.length
  console.log(`  ${name.padEnd(5)} Pflicht-Module ${total('hits')}/${total('must')} (${pct(total('hits'), total('must'))}), Fälle komplett ${ms.filter((m) => m.hits === m.must).length}/${n}, ` +
    `Ø ${(total('mods') / n).toFixed(1)} Module, Ø ${Math.round(total('chars') / n)} Z. (${pct(total('chars') / n, full)} vom vollen Prompt), Ø ${(total('ms') / n / 1000).toFixed(1)} s` +
    `${total('fallback') ? `, ${total('fallback')} Fallbacks` : ''}`)
}
