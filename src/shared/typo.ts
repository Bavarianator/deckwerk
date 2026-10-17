// Feinsatz für Folientexte (deutsch): „…“, ’ und – statt Tastatur-Zeichen (Minus bleibt ASCII, die Parser lesen nur das), geschützte Leerzeichen vor Einheiten.
// Idempotent und ohne Abhängigkeiten, damit Tools, Vorschau und Exporte dieselbe Funktion nutzen können.
const NB = '\u00a0' // U+00A0, nicht U+202F: das fehlt in manchen eingebetteten Schriften
const UNITS = 'Mio\\.?|Mrd\\.?|Tsd\\.?|T€|km²|km|m²|m³|kg|h|Min\\.|Std\\.'
// URLs, Pfade und Adressen werden vor dem Satz durch Platzhalter (Private-Use, ohne Ziffern) ersetzt
const PROTECT = /(?:https?:\/\/|www\.|asset:|data:|file:)\S*|(?<=^|\s)\/\S+|[^\s"„“”]+@[^\s"„“”]+\.[^\s"„“”]+/g
// Bereichsstrich nur bei Jahren und kurzen Zahlen vor Einheit; Kennungen (SKU 12-345, ISO 9001-2015) bleiben
const COUNT = '%|€|°C|(?:Uhr|Mal|Jahre|Jahren|Monate|Monaten|Wochen|Tage|Tagen|Stunden|Minuten|Prozent|Mio\\.|Mrd\\.|Seiten|Personen|Teilnehmer|Kinder|Schüler)(?![\\p{L}])'
const ID_BEFORE = /(?:\d[ \u00a0]|\b(?:Tel|Fax|Nr|SKU|ISO|IBAN|Art)\.?[ \u00a0]?)$/
const range = (re: RegExp, t: string) => t.replace(re, (m, a: string, b: string, i: number) => (ID_BEFORE.test(t.slice(0, i)) ? m : `${a}–${b}`))

// Gerade Anführungszeichen paarweise; Zollzeichen (Ziffer davor, außerhalb eines Paars) und unpaarige Strings bleiben
function quotes(t: string): string {
  let open = false
  const out = [...t]
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '"') continue
    if (open) { out[i] = '“'; open = false }
    else if (i > 0 && /\d/.test(t[i - 1])) continue
    else if ((i === 0 || /[\s(\[/:;!?–—]/.test(t[i - 1])) && /[\p{L}\d]/u.test(t[i + 1] ?? '')) { out[i] = '„'; open = true }
    else return t
  }
  return open ? t : out.join('')
}

export function typeset(s: string): string {
  if (s.startsWith('/')) return s // Dateipfad
  const kept: string[] = []
  let t = s.replace(PROTECT, (m) => String.fromCharCode(0xe100 + kept.push(m) - 1))
  t = quotes(t)
    .replace(/(?<=\p{L})'(?=\p{L})/gu, '’')
    .replace(/(?<=\p{L}{2}|[)”“]) - (?=\p{L})/gu, ' – ') // nicht in Formeln („x - 3“)
    .replace(/(?<=\S) – /g, `${NB}– `) // Gedankenstrich bleibt am Zeilenende, beginnt keine Zeile
    .replace(new RegExp(`(\\d)[ ${NB}]?(%|‰|€)`, 'g'), `$1${NB}$2`)
    .replace(new RegExp(`(\\d)[ ${NB}](${UNITS})(?![\\p{L}\\d])`, 'gu'), `$1${NB}$2`)
    .replace(new RegExp(`(Mio\\.?|Mrd\\.?|Tsd\\.?)[ ${NB}](€|\\$|£|Euro)`, 'g'), `$1${NB}$2`)
    .replace(new RegExp(`(?<![\\p{L}])(?:[zZ]\\.[ ${NB}]?B|d\\.[ ${NB}]?h|u\\.[ ${NB}]?a)\\.`, 'gu'), (m) => m.replace(/\.[ \u00a0]?/, `.${NB}`))
    .replace(new RegExp(`(?<![\\p{L}])(Nr|S)\\.[ ${NB}]?(?=\\d)`, 'gu'), `$1.${NB}`)
  t = range(/(?<![\d\p{L},.-])((?:19|20)\d\d)-((?:19|20)\d\d)(?![\d-])/gu, t)
  t = range(new RegExp(`(?<![\\d\\p{L},.-])(\\d{1,3}(?:,\\d+)?)-(\\d{1,3}(?:,\\d+)?)(?=[ ${NB}]?(?:${COUNT}))`, 'gu'), t)
  return t.replace(/[\ue100-\ue1ff]/g, (c) => kept[c.charCodeAt(0) - 0xe100])
}
