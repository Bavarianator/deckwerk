// Aufruf: npx esbuild scripts/check-webfonts.ts --bundle --platform=node --format=esm --outfile=out/check-webfonts.mjs && node out/check-webfonts.mjs
// Katalogschriften ohne Netz: Sammlung (Design, Marke, freie Texte), Titelgewicht als Instanz (tune schlägt custom), Cache-Treffer,
// Offline-Hinweise, verwaiste Einträge fallen weg; kaputte Cache-Dateien und fremde Werte, Netz-Härtung mit gemocktem fetch.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Deck } from '../src/shared/deck'
import { deckJson, fontDir, fontNeeds, withDeckFonts } from '../src/main/webfonts'

process.env.DECKWERK_HOME = mkdtempSync(join(tmpdir(), 'dw-fonts-')) // nie der echte ~/Deckwerk-Cache
// kleinste TTF, die inspectTtf annimmt: Tabellen cmap, glyf und name (Familie, Windows-Unicode)
const ttf = (family: string) => {
  const s = Buffer.from(family, 'utf16le').swap16(), name = Buffer.alloc(18 + s.length)
  ;[0, 1, 18, 3, 1, 0x409, 1, s.length, 0].forEach((v, i) => name.writeUInt16BE(v, i * 2)); s.copy(name, 18)
  const tabs: [string, Buffer][] = [['cmap', Buffer.alloc(4)], ['glyf', Buffer.alloc(4)], ['name', name]]
  const head = Buffer.alloc(12 + 16 * tabs.length)
  head.writeUInt32BE(0x00010000, 0); head.writeUInt16BE(tabs.length, 4)
  let at = head.length
  tabs.forEach(([tag, b], i) => { head.write(tag, 12 + i * 16, 'latin1'); head.writeUInt32BE(at, 20 + i * 16); head.writeUInt32BE(b.length, 24 + i * 16); at += b.length })
  return Buffer.concat([head, ...tabs.map(([, b]) => b)])
}
const cache = (dir: string, file: string, data: Buffer | string) => { mkdirSync(join(fontDir(), dir), { recursive: true }); writeFileSync(join(fontDir(), dir, file), data) }
cache('InterTight', 'InterTight-Regular.ttf', ttf('Inter Tight')); cache('InterTight', 'InterTight-SemiBold.ttf', ttf('Inter Tight SemiBold'))
cache('Newsreader', 'Newsreader-Regular.ttf', ttf('Newsreader')); cache('Newsreader', 'Newsreader-Bold.ttf', ttf('Newsreader'))
cache('Newsreader', 'Newsreader-Italic.ttf', ttf('Newsreader').subarray(0, 60)) // abgeschnitten (paralleler Download, Sync)

const deck = (theme: Deck['theme'], fonts: string[] = []): Deck => ({ title: 't', theme, transition: 'fade', mode: 'click',
  slides: [{ id: 's1', layout: 'blank', content: {}, items: fonts.map((font, i) => ({ id: `t${i}`, kind: 'text', text: 'x', font, x: 0, y: 0, w: 100, h: 40 })) }] })
const custom = { name: 't', bg: '#FFFFFF', accent: '#111111', headFont: 'Inter Tight', bodyFont: 'Inter', radius: 2, decor: 'none' as const, headWeight: 500 as const }
const d = deck({ id: 'custom', custom, tune: { headWeight: 600 }, brand: { primary: '#111111', bodyFont: 'Newsreader' }, fontFiles: { Alt: { regular: 'asset://local/alt.ttf' } } }, ['Literata', 'head', 'Inter'])

const { theme, notes } = await withDeckFonts(d, { offline: true })
const ff = theme.fontFiles ?? {}
assert.deepEqual(Object.keys(ff).sort(), ['Inter Tight', 'Inter Tight SemiBold', 'Newsreader'], 'Alt verwaist, Inter gebündelt, Literata fehlt im Cache')
assert.match(ff['Inter Tight'].regular, /^asset:\/\/local\/.*\/fonts\/InterTight\/InterTight-Regular\.ttf$/)
assert.equal(ff['Inter Tight'].bold, undefined)
assert.ok(ff['Inter Tight SemiBold'].regular.endsWith('InterTight-SemiBold.ttf'), 'tune.headWeight 600 schlägt custom 500')
assert.ok(ff.Newsreader.bold?.endsWith('Newsreader-Bold.ttf'), 'brand.bodyFont mit Bold')
assert.ok(notes.some((n) => n.startsWith('Literata: nicht verfügbar (offline), Ersatz Georgia')), notes.join(' | '))
assert.ok(notes.some((n) => n.startsWith('Inter Tight: nicht verfügbar (offline)')), 'fehlende Schnitte (Bold, Kursive) werden gemeldet')
assert.ok(!notes.some((n) => n.includes('geladen')), 'offline wird nichts geladen')
assert.equal(d.theme.fontFiles?.Alt?.regular, 'asset://local/alt.ttf', 'Eingabe bleibt unverändert')
assert.equal(ff.Newsreader.italic, undefined); assert.ok(!existsSync(join(fontDir(), 'Newsreader', 'Newsreader-Italic.ttf')), 'kaputte Cache-Datei gelöscht')
// deck.json und get_deck ohne rechnerabhängige Pfade
assert.ok(!deckJson({ ...d, theme }).includes('fontFiles') && deckJson({ ...d, theme }).includes('Inter Tight'))
// fremde/kaputte deck.json: falsche Typen werfen nicht
const junk = { ...deck({ id: 'custom', custom: { ...custom, headFont: 5 }, fonts: 5, brand: { primary: '#111111', headFont: 5 }, tune: { headWeight: 'fett' } } as never), slides: [{ id: 'x', items: [{ font: 7 }, null] }, { id: 'y', items: 3 }] } as never
assert.deepEqual((await withDeckFonts(junk, { offline: true })).notes, [])

// ohne tune gilt custom.headWeight (500 → Instanz Medium, nicht im Cache)
assert.ok((await withDeckFonts(deck({ id: 'custom', custom }), { offline: true })).notes.some((n) => n.startsWith('Inter Tight Medium: nicht verfügbar')))
// Katalog-Theme mit tune: Instanz der Theme-Titelschrift (beratung = IBM Plex Sans)
assert.ok((await withDeckFonts(deck({ id: 'beratung', tune: { headWeight: 600 } }), { offline: true })).notes.some((n) => n.startsWith('IBM Plex Sans SemiBold: nicht verfügbar')))
// nur gebündelte Schriften: nichts zu laden, kein fontFiles
const plain = await withDeckFonts(deck({ id: 'beratung', fontFiles: { Alt: { regular: 'x' } } }, ['Inter']), { offline: true })
assert.deepEqual(plain, { theme: { id: 'beratung' }, notes: [] })
// fontNeeds: ändert sich mit neuen Schriften, nicht mit fontFiles
assert.equal(fontNeeds(d), fontNeeds({ ...d, theme: theme }))
assert.notEqual(fontNeeds(d), fontNeeds(deck(d.theme, ['Literata', 'Spectral'])))
// Netz (gemockt): TTF nur von fonts.gstatic.com; nach einem Netzfehler bleibt der Prozess einige Minuten offline
const calls: string[] = []
const css = 'font-style: normal;\n  font-weight: 400;\n  src: url(https://evil.example/x.ttf) format(\'truetype\');'
globalThis.fetch = (async (url: string) => { calls.push(String(url)); return new Response(css) }) as typeof fetch
assert.match((await withDeckFonts(deck({ id: 'beratung' }, ['Spectral']), { offline: false })).notes.join(), /Spectral: nicht verfügbar, Ersatz Georgia/)
assert.ok(calls.length && !calls.some((u) => u.includes('evil')), 'fremde Adresse nicht geladen')
globalThis.fetch = (async (url: string) => { calls.push(String(url)); throw new TypeError('fetch failed') }) as typeof fetch
await withDeckFonts(deck({ id: 'beratung' }, ['Petrona']), { offline: false })
const n = calls.length
assert.match((await withDeckFonts(deck({ id: 'beratung' }, ['Vollkorn']), { offline: false })).notes.join(), /Vollkorn: nicht verfügbar \(offline\)/)
assert.equal(calls.length, n, 'nach dem Netzfehler kein weiterer Versuch')
console.log('webfonts ok')
