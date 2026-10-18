// Kunden (aktiver Kunde, Pfade für brand.json/hausstil.md): npx esbuild scripts/check-clients.ts --bundle --platform=node --format=esm --outfile=${TMPDIR:-/tmp}/check-clients.mjs && node ${TMPDIR:-/tmp}/check-clients.mjs
import { deepStrictEqual as eq, ok, throws } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeClient, brandFile, clientName, listClients, setClient, styleFile } from '../src/main/clients'

const home = mkdtempSync(join(tmpdir(), 'check-clients-'))
process.env.DECKWERK_HOME = home
const marker = join(home, '.kunde') // Punktdatei: Cloud-Sync lässt sie aus
const kunden = join(home, 'kunden')

// Ohne Kunde: eigene Marke im Datenordner
eq(activeClient(), null)
eq(listClients(), [])
eq(brandFile(), join(home, 'brand.json'))
eq(styleFile(), join(home, 'hausstil.md'))

setClient('Müller')
ok(brandFile().endsWith(join('kunden', 'Müller', 'brand.json')), brandFile())
ok(styleFile().endsWith(join('kunden', 'Müller', 'hausstil.md')), styleFile())
eq(readFileSync(marker, 'utf8').trim(), 'Müller')
eq(activeClient(), 'Müller')
ok(listClients().includes('Müller'))
eq(readdirSync(home).filter((f) => f.endsWith('.tmp')), []) // atomar geschrieben, keine Temp-Datei übrig

// Groß/klein und zerlegte Umlaute treffen den vorhandenen Kunden, kein Doppel
setClient('müller')
eq(activeClient(), 'Müller')
eq(clientName('  MÜLLER '), 'Müller')
eq(listClients(), ['Müller'])

// Sortierung deutsch, erlaubte Zeichen
setClient('Zeta'); setClient('Äpfel'); setClient('Café-Nord_2 & Co.KG')
eq(listClients(), ['Äpfel', 'Café-Nord_2 & Co.KG', 'Müller', 'Zeta'])
eq(clientName('x'.repeat(40)), 'x'.repeat(40))

for (const bad of ['../x', 'a/b', 'a\\b', '.x', 'x.', 'a..b', 'CON', 'nul', 'Com1', 'COM¹', 'lpt²', 'lpt9.txt', '', '   ', 'a\nb', 'a\u0000b', 'x'.repeat(41)])
  throws(() => setClient(bad), /Kundenname|reserviert/, JSON.stringify(bad))
eq(activeClient(), 'Café-Nord_2 & Co.KG') // Fehler ändern den aktiven Kunden nicht

// Symlinks und von Hand angelegte Ordner mit ungültigem Namen sind keine Kunden
symlinkSync(join(kunden, 'Zeta'), join(kunden, 'Link'))
mkdirSync(join(kunden, 'CON')); mkdirSync(join(kunden, '.versteckt'))
eq(listClients(), ['Äpfel', 'Café-Nord_2 & Co.KG', 'Müller', 'Zeta'])
writeFileSync(marker, 'Link\n')
eq(activeClient(), null)
throws(() => brandFile(), /Kunde „Link“ nicht gefunden/)

// null = eigene Marke, Marker weg
setClient(null)
ok(!existsSync(marker))
eq(activeClient(), null)
eq(brandFile(), join(home, 'brand.json'))
eq(styleFile(), join(home, 'hausstil.md'))
setClient(null) // ohne Marker kein Fehler

// Kundenordner gelöscht → kein Rückfall auf die Agenturmarke, sondern Fehler; setClient repariert
setClient('Weg')
rmSync(join(kunden, 'Weg'), { recursive: true })
eq(activeClient(), null)
throws(() => brandFile(), /Kunde „Weg“ nicht gefunden – in den Einstellungen/)
throws(() => styleFile(), /Kunde „Weg“ nicht gefunden/)
setClient('Zeta')
ok(brandFile().endsWith(join('kunden', 'Zeta', 'brand.json')))

// Kaputter Marker (leer, Pfad) → activeClient null, Pfade werfen
for (const m of ['', '\n', '../kunden/Müller', '..']) {
  writeFileSync(marker, m)
  eq(activeClient(), null, JSON.stringify(m))
  throws(() => brandFile(), /ungültig/, JSON.stringify(m))
  throws(() => styleFile(), /ungültig/, JSON.stringify(m))
}
setClient(null)
eq(brandFile(), join(home, 'brand.json'))

// Ordner zerlegt (NFD, wie von macOS): setClient('Müller') findet ihn und nutzt den echten Ordnernamen
rmSync(join(kunden, 'Müller'), { recursive: true })
mkdirSync(join(kunden, 'Müller'))
setClient('Müller')
eq(activeClient(), 'Müller')
eq(listClients().filter((c) => c.normalize('NFC') === 'Müller').length, 1)
ok(brandFile().endsWith(join('kunden', 'Müller', 'brand.json')))

rmSync(home, { recursive: true })
console.log('check-clients: alle Prüfungen bestanden')
