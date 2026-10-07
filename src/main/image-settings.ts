// Einstellungen für Bilder (Einstellungen → Bilder): Keys für Mammouth, OpenAI und die Unsplash-Fotosuche, bevorzugter Anbieter, Modell.
// Verschlüsselt mit safeStorage wie der Anthropic-Key, aber unter appData/deckwerk, damit App und MCP-Server dieselbe Datei
// lesen (userData wechselt zwischen Entwicklung, installierter App und MCP, siehe setupFile in ipc.ts).
import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { IMAGE_PROVIDERS, imageSettings } from './tools'

const file = () => join(app.getPath('appData'), 'deckwerk', 'image-settings.bin')
const key = z.string().max(400).nullable().optional()
const patchSchema = z.object({ mammouth: key, openai: key, unsplash: key, provider: z.enum(IMAGE_PROVIDERS).nullable().optional(), model: z.string().max(80).nullable().optional() }).strict()

export function loadImageSettings(): void {
  try {
    if (existsSync(file())) Object.assign(imageSettings, JSON.parse(safeStorage.decryptString(readFileSync(file()))))
  } catch (e) {
    console.warn('[image-settings] nicht lesbar:', (e as Error).message)
  }
}

// Die UI sieht nur, woher ein Key kommt, nie den Key selbst
export const imageStatus = () => ({
  mammouth: imageSettings.mammouth ? 'app' : process.env.MAMMOUTH_API_KEY ? 'env' : null,
  openai: imageSettings.openai ? 'app' : process.env.OPENAI_API_KEY ? 'env' : null,
  unsplash: imageSettings.unsplash ? 'app' : process.env.UNSPLASH_ACCESS_KEY ? 'env' : null,
  provider: imageSettings.provider ?? null,
  model: imageSettings.model ?? '',
}) as const

// Felder setzen; null oder leer löscht
export function saveImageSettings(patch: unknown): ReturnType<typeof imageStatus> {
  const p = patchSchema.parse(patch)
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Keine sichere Schlüsselablage verfügbar. Setze stattdessen MAMMOUTH_API_KEY, OPENAI_API_KEY bzw. UNSPLASH_ACCESS_KEY in der Umgebung.')
  for (const [k, v] of Object.entries(p) as [keyof typeof imageSettings, string | null | undefined][]) {
    if (v === undefined) continue
    if (v?.trim()) (imageSettings as Record<string, string>)[k] = v.trim()
    else delete imageSettings[k]
  }
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), safeStorage.encryptString(JSON.stringify(imageSettings)), { mode: 0o600 })
  return imageStatus()
}
