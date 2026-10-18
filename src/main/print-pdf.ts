// Druck-PDF als PDF/X-4 in CMYK mit Output-Intent FOGRA39, gewandelt vom installierten Ghostscript (AGPL wie Deckwerk Pro).
// Erst ab 10.05 schreibt pdfwrite PDF/X-4 mit Transparenz (Chromium-PDFs haben Alpha); PDF/X-3 würde rastern.
// TrimBox/BleedBox aus setPrintBoxes übernimmt gs unverändert. Electron-frei, Selbsttest scripts/check-print.ts.
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/** Meldung, wenn Ghostscript fehlt (version undefined) oder älter als 10.05 ist; sonst undefined. */
export function gsVersionError(version: string | undefined): string | undefined {
  const v = version?.trim()
  const m = /^(\d+)\.(\d+)/.exec(v ?? '')
  if (m && (+m[1] > 10 || (+m[1] === 10 && +m[2] >= 5))) return undefined
  return `Für den CMYK-Druck braucht Deckwerk Pro Ghostscript ab 10.05 (${v ? `gefunden: ${v}` : 'nicht gefunden'}). Installieren oder aktualisieren: sudo apt install ghostscript, sudo dnf install ghostscript, sudo pacman -S ghostscript oder brew install ghostscript; bringt die Distribution nur eine ältere Version mit, die aktuelle von ghostscript.com nehmen.`
}

// Kurzfassung von Ghostscripts lib/PDFX_def.ps, nur der X-4-Zweig. Den Titel aus dem Info des Eingabe-PDFs (Chromium) behält gs; dieser greift nur ohne.
const pdfxDef = (icc: string) => `%!
[ /GTS_PDFXVersion (PDF/X-4) /Title (Deckwerk Pro) /Trapped /False /DOCINFO pdfmark
[/_objdef {icc_PDFX} /type /stream /OBJ pdfmark
[{icc_PDFX} << /N 4 >> /PUT pdfmark
[{icc_PDFX} (${icc.replace(/[\\()]/g, '\\$&')}) (r) file /PUT pdfmark
[/_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark
[{OutputIntent_PDFX} <<
  /Type /OutputIntent /S /GTS_PDFX
  /OutputCondition (Offset, gestrichenes Papier, ISO 12647-2:2004)
  /Info (FOGRA39L Coated)
  /OutputConditionIdentifier (FOGRA39)
  /RegistryName (http://www.color.org)
  /DestOutputProfile {icc_PDFX}
>> /PUT pdfmark
[{Catalog} <</OutputIntents [ {OutputIntent_PDFX} ]>> /PUT pdfmark
`

/** Gesamtfarbauftrag (C+M+Y+K in %) einer PAM-Seite aus gs -sDEVICE=pamcmyk32: 99,9-%-Perzentil, damit einzelne Kantenpixel nicht zählen. */
export function tacOfPam(pam: Buffer): number {
  const end = pam.indexOf('ENDHDR\n')
  if (end < 0) throw new Error('PAM ohne ENDHDR')
  const head = pam.subarray(0, end).toString('latin1'), num = (k: string) => Number(new RegExp(`${k} (\\d+)`).exec(head)?.[1])
  const n = num('WIDTH') * num('HEIGHT')
  if (num('DEPTH') !== 4 || !n) throw new Error('PAM ist kein CMYK')
  const px = pam.subarray(end + 7), hist = new Uint32Array(4 * 255 + 1)
  if (px.length < n * 4) throw new Error('PAM abgeschnitten')
  for (let i = 0; i < n * 4; i += 4) hist[px[i] + px[i + 1] + px[i + 2] + px[i + 3]]++
  let s = 0
  for (let acc = 0; s < hist.length - 1 && (acc += hist[s]) < n * 0.999; s++);
  return Math.round((s / 255) * 100)
}

/** Warnung für Seiten über 300 % Gesamtfarbauftrag (übliche Grenze der Druckereien); tac[i] = Seite i+1. */
export function tacWarning(tac: number[]): string | undefined {
  const over = tac.map((t, i) => [i + 1, t]).filter(([, t]) => t > 300)
  if (!over.length) return undefined
  return `Gesamtfarbauftrag über 300 %: ${over.map(([p, t]) => `Seite ${p} (${t} %)`).join(', ')}. Tiefes Schwarz aus Fotos oder Farbflächen dunkler Themes; Druckerei fragen oder hellere Flächen.`
}

/** RGB-Druck-PDF → PDF/X-4 in CMYK. icc = Pfad zu FOGRA39L_coated.icc; er darf im asar liegen, gs liest nur die Kopie im Job-Ordner.
 *  warning = Seiten mit zu hohem Gesamtfarbauftrag (tacWarning). */
export async function toPdfX4(pdf: Buffer, icc: string): Promise<{ pdf: Buffer; warning?: string }> {
  const version = await exec('gs', ['--version'], { timeout: 10_000 }).then((r) => r.stdout, () => undefined)
  const bad = gsVersionError(version)
  if (bad) throw new Error(bad)
  const job = await mkdtemp(join(tmpdir(), 'deckwerk-druck-'))
  const at = (f: string) => join(job, f)
  try {
    await writeFile(at('FOGRA39L_coated.icc'), await readFile(icc))
    await writeFile(at('pdfx.ps'), pdfxDef(at('FOGRA39L_coated.icc')))
    await writeFile(at('in.pdf'), pdf)
    await exec('gs', ['-dBATCH', '-dNOPAUSE', '-dSAFER', `--permit-file-read=${job}/`, '-sDEVICE=pdfwrite', '-dPDFX=4', '-sColorConversionStrategy=CMYK',
      `-sOutputICCProfile=${at('FOGRA39L_coated.icc')}`, `-sOutputFile=${at('out.pdf')}`, at('pdfx.ps'), at('in.pdf')], { timeout: 600_000, maxBuffer: 16 << 20 })
      .catch((e: { killed?: boolean; stdout?: string; stderr?: string; message: string }) => {
        const why = e.killed ? 'nach 10 Minuten abgebrochen' : `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim().slice(-1500) || e.message
        throw new Error(`Ghostscript konnte das Druck-PDF nicht nach CMYK wandeln: ${why}`)
      })
    // Messung bei 50 dpi reicht für Flächen; scheitert sie, bleibt das PDF gültig, nur ohne Warnung
    const warning = await exec('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', `--permit-file-read=${job}/`, '-sDEVICE=pamcmyk32', '-r50', `-o${at('page-%03d.pam')}`, at('out.pdf')], { timeout: 300_000 })
      .then(async () => {
        const tac: number[] = []
        for (const f of (await readdir(job)).filter((f) => f.endsWith('.pam')).sort()) tac.push(tacOfPam(await readFile(at(f)))) // nacheinander: Plakate sind groß
        return tacWarning(tac)
      })
      .catch((e) => { console.warn('Gesamtfarbauftrag nicht gemessen:', e); return undefined })
    return { pdf: await readFile(at('out.pdf')), warning }
  } finally {
    await rm(job, { recursive: true, force: true })
  }
}
