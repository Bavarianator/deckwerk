// Prüft den Schriftkatalog (src/shared/font-catalog.ts) gegen Google Fonts: verfügbare statische Gewichte, Kursive,
// Familienname der Regular- und einer Instanz-TTF, deutsche Sonderzeichen, Dateigröße, Lizenz (OFL/Apache).
// Ändert nichts, meldet Abweichungen; Exit 1, wenn etwas nicht stimmt. Netz nötig.
// Aufruf: npm run fonts:curate [-- "Familie" …]
import { FONT_CATALOG, instanceFamily, type FontInfo } from '../src/shared/font-catalog'
import { inspectTtf } from '../src/main/embed-fonts'
import { CHARS, download, faceUrls } from '../src/main/webfonts'

const ALL = [100, 200, 300, 400, 500, 600, 700, 800, 900]
const only = process.argv.slice(2)
const list = FONT_CATALOG.filter((i) => !i.office && (!only.length || only.includes(i.family)))

async function check(info: FontInfo): Promise<string[]> {
  const issues: string[] = []
  const avail = (await Promise.all(ALL.map(async (w) => ((await faceUrls(info.family, `wght@${w}`).catch(() => [])).length ? w : 0)))).filter(Boolean)
  if (!avail.length) return ['bei Google Fonts nicht gefunden']
  const gone = info.weights.filter((w) => !avail.includes(w)) // Katalog darf Gewichte bewusst auslassen, aber keine erfinden
  if (gone.length) issues.push(`weights: ${gone} nicht verfügbar (verfügbar: ${avail})`)
  const base = avail.includes(400) ? 400 : avail[0]
  const italic = (await faceUrls(info.family, `ital,wght@1,${base}`).catch(() => [])).length > 0
  if (italic !== info.italic) issues.push(`italic: Katalog ${info.italic} ↔ verfügbar ${italic}`)
  const reg = await download((await faceUrls(info.family, `wght@${base}`))[0].url)
  const r = inspectTtf(reg, CHARS)
  if (r.family !== instanceFamily(info.family, base)) issues.push(`Regular heißt „${r.family}“`)
  if (!r.glyf) issues.push('keine TrueType-Umrisse (CFF)')
  if (r.missing.length) issues.push(`fehlende Zeichen: ${r.missing.join('')}`)
  if (r.fsType & 2) issues.push('fsType: Einbettung eingeschränkt')
  if (reg.length > 1_500_000) issues.push(`Regular ${Math.round(reg.length / 1024)} kB`)
  const inst = info.weights.find((w) => w !== 400 && w !== 700)
  if (inst) {
    const name = inspectTtf(await download((await faceUrls(info.family, `wght@${inst}`))[0].url)).family
    if (name !== instanceFamily(info.family, inst)) issues.push(`Instanz ${inst} heißt „${name}“, erwartet „${instanceFamily(info.family, inst)}“`)
  }
  const slug = info.family.toLowerCase().replace(/[^a-z0-9]/g, '')
  const lic = (await fetch(`https://raw.githubusercontent.com/google/fonts/main/${info.license === 'OFL' ? 'ofl' : 'apache'}/${slug}/${info.license === 'OFL' ? 'OFL.txt' : 'LICENSE.txt'}`, { method: 'HEAD' })).ok
  if (!lic) issues.push(`Lizenz ${info.license} unter google/fonts/${slug} nicht gefunden`)
  return issues
}

let bad = 0, next = 0
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < list.length) {
    const info = list[next++]
    const issues = await check(info).catch((e) => [`Fehler: ${e instanceof Error ? e.message : e}`])
    if (issues.length) bad++
    console.log(`${issues.length ? '✗' : '✓'} ${info.family}${issues.length ? '\n    ' + issues.join('\n    ') : ''}`)
  }
}))
console.log(`\n${list.length - bad} von ${list.length} in Ordnung`)
process.exit(bad ? 1 : 0)
