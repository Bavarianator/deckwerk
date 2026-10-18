// Kunden (Agenturen): je Kunde eigenes Brand-Kit und eigener Hausstil unter <Datenordner>/kunden/<Name>/.
// Der aktive Kunde steht in <Datenordner>/.kunde und gilt für neue Decks und die KI. Ohne Electron; die Umgebung
// wird bei jedem Aufruf gelesen, weil Tests DECKWERK_HOME setzen und der MCP-Prozess lange läuft.
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { APP } from '../shared/app-id'

export const dataDir = () => process.env.DECKWERK_HOME ?? join(homedir(), APP.home)
// Punktdatei: Cloud-Sync lässt sie aus (skip in sync.ts), der aktive Kunde gilt also je Gerät
const marker = () => join(dataDir(), '.kunde')
const clientDir = (name: string) => join(dataDir(), 'kunden', name)

// Name prüfen, bevor er Ordnername wird: kein Pfad, nichts, was Windows (Sync auf andere Geräte) ablehnt oder umbenennt
function checked(raw: string): string {
  const name = raw.normalize('NFC').trim() // NFC: macOS liefert Umlaute zerlegt, sonst gäbe es „Müller“ doppelt
  if (!/^[\p{L}\p{N} ._&-]{1,40}$/u.test(name)) throw new Error('Der Kundenname braucht 1 bis 40 Zeichen: Buchstaben, Ziffern, Leerzeichen und - _ . &')
  if (name.includes('..') || name.startsWith('.') || name.endsWith('.')) throw new Error('Der Kundenname darf nicht mit einem Punkt beginnen oder enden und kein „..“ enthalten.')
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i.test(name)) throw new Error(`„${name}“ ist unter Windows als Name reserviert.`)
  return name
}
const valid = (dir: string) => { try { return checked(dir) === dir.normalize('NFC') } catch { return false } }

// Nur echte Ordner mit gültigem Namen (kein Symlink, nichts von Hand Angelegtes wie „CON“)
export function listClients(): string[] {
  try {
    return readdirSync(join(dataDir(), 'kunden'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && valid(d.name))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'de'))
  } catch { return [] }
}

export function clientName(raw: string): string {
  const name = checked(raw)
  // Groß/klein zählt nicht: „müller“ trifft den vorhandenen Kunden „Müller“ (Windows und macOS unterscheiden es ohnehin nicht);
  // zurück kommt der echte Ordnername, auch wenn er zerlegt (NFD) auf der Platte liegt
  const low = name.toLocaleLowerCase('de')
  return listClients().find((c) => c.normalize('NFC').toLocaleLowerCase('de') === low) ?? name
}

// null = kein Marker = eigene Marke. Marker kaputt oder Kundenordner weg → Fehler statt still der Agenturmarke
function current(): string | null {
  if (!APP.pro) return null // Kunden-Arbeitsbereiche gibt es nur in Deckwerk Pro
  let raw: string
  try { raw = readFileSync(marker(), 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  const hint = '– in den Einstellungen einen Kunden wählen'
  let name: string
  try { name = clientName(raw) } catch { throw new Error(`Kunde „${raw.trim().slice(0, 40)}“ ungültig ${hint}`) }
  if (!lstatSync(clientDir(name), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Kunde „${name}“ nicht gefunden ${hint}`)
  return name
}

// Wirft nicht: die Kundenliste bleibt bedienbar, setClient repariert den Zustand
export function activeClient(): string | null {
  try { return current() } catch { return null }
}

export function setClient(name: string | null): void {
  if (name === null) return rmSync(marker(), { force: true })
  const n = clientName(name)
  mkdirSync(clientDir(n), { recursive: true })
  // Atomar ersetzen: der MCP-Prozess darf nie einen halb geschriebenen (leeren) Marker lesen
  const tmp = `${marker()}.${process.pid}.tmp`
  writeFileSync(tmp, `${n}\n`)
  renameSync(tmp, marker())
}

// Bewusst kein Rückfall auf die eigene Marke, wenn der Kunde noch keine brand.json/hausstil.md hat:
// Sonst bekäme der Kunde Farben, Logo und Vorlieben der Agentur. Wirft bei kaputtem Marker (siehe current).
const fileOf = (file: string) => { const c = current(); return join(c ? clientDir(c) : dataDir(), file) }
export const brandFile = () => fileOf('brand.json')
export const styleFile = () => fileOf('hausstil.md')
