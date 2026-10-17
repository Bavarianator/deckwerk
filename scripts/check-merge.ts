// Serienbrief: npx esbuild scripts/check-merge.ts --bundle --platform=node --format=esm --loader:.md=text --outfile=${TMPDIR:-/tmp}/check-merge.mjs && node ${TMPDIR:-/tmp}/check-merge.mjs
import { deepStrictEqual as eq, rejects } from 'node:assert'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Deck } from '../src/shared/deck'
import { fillDeck, parseCsv, placeholders } from '../src/shared/merge'
import { exportSeries } from '../src/main/tools'

// CSV: BOM, ; als Trenner, "" im Feld, Zeilenumbruch in Anführungszeichen, CRLF, leere Zeilen
const rows = parseCsv('﻿Name;Kurs\r\n"Müller; Anna";"Erste ""Hilfe"""\r\n\r\nBen;"Zeile1\nZeile2"\n;\n')
eq(rows, [{ Name: 'Müller; Anna', Kurs: 'Erste "Hilfe"' }, { Name: 'Ben', Kurs: 'Zeile1\nZeile2' }])
eq(parseCsv('a,b\n1,"x,y"'), [{ a: '1', b: 'x,y' }])
eq(parseCsv('"Nachname, Vorname";Kurs\n"Muster, Max";A'), [{ 'Nachname, Vorname': 'Muster, Max', Kurs: 'A' }]) // Komma in Quotes zählt nicht
eq(parseCsv('a,b\nA,5" Zoll\nB,x'), [{ a: 'A', b: '5" Zoll' }, { a: 'B', b: 'x' }]) // " mitten in der Zelle öffnet nichts
eq(parseCsv('a;b\r1;2\r3;4'), [{ a: '1', b: '2' }, { a: '3', b: '4' }]) // nur \r als Zeilenende

const deck: Deck = {
  title: 'Urkunde {{Name}}', theme: { id: 'beratung' }, transition: 'fade', mode: 'click',
  slides: [{
    id: 's1', layout: 'statement', content: { title: 'Für {{ Name }}', items: [{ text: 'Kurs: {{Kurs}}' }], n: 3 },
    notes: 'an {{Name}}, {{Datum}}', items: [{ id: 'i', kind: 'text', x: 0, y: 0, w: 10, h: 10, text: '{{Kurs}}!' } as never],
  }],
}
eq(placeholders(deck).sort(), ['Datum', 'Kurs', 'Name'])
const d = fillDeck(deck, rows[0])
eq(d.title, 'Urkunde Müller; Anna')
eq(d.slides[0].content, { title: 'Für Müller; Anna', items: [{ text: 'Kurs: Erste "Hilfe"' }], n: 3 })
eq(d.slides[0].notes, 'an Müller; Anna, {{Datum}}') // unbekannter Platzhalter bleibt
eq(d.slides[0].items![0].text, 'Erste "Hilfe"!')
eq(deck.slides[0].content.title, 'Für {{ Name }}') // Original unverändert

// Serienexport: fehlende Spalte → Fehler; sonst je Zeile eine Datei NNN-<erster Wert>
const out = mkdtempSync(join(tmpdir(), 'dw-merge-'))
const engine = { exportDeck: async (dk: Deck, f: string, dir: string) => { const p = join(dir, `x.${f}`); writeFileSync(p, dk.title); return [p] } } as never
await rejects(exportSeries(engine, deck, rows, 'pdf', out), /\{\{Datum\}\}/)
mkdirSync(join(out, 'serie-pdf'), { recursive: true })
for (const f of ['001-alt.pdf', '.tmp-7', 'eigene.txt']) writeFileSync(join(out, 'serie-pdf', f), '') // Altlasten und fremde Datei
const full = rows.map((r) => ({ ...r, Datum: '1.1.' }))
eq((await exportSeries(engine, deck, full, 'pdf', out)).map((p) => p.slice(out.length + 1)), ['serie-pdf/001-müller-anna.pdf', 'serie-pdf/002-ben.pdf'])
eq(readdirSync(join(out, 'serie-pdf')).sort(), ['001-müller-anna.pdf', '002-ben.pdf', 'eigene.txt'])
rmSync(out, { recursive: true })
console.log('check-merge: ok')
