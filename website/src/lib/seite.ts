// Daten und Helfer für alle Abschnitte der Startseite
import type { ImageMetadata } from 'astro'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import data from '../assets/folien/folien.json'

// Echte Renderings aus scripts/folien.mjs; Titel, Notizen und Briefing stehen in folien.json
export type Folie = { title: string; layout: string; theme: string; notes: string }
export type Deck = { title: string; brief: { audience?: string; goal?: string; tone?: string }; theme: string; slides: string[]; dl: string[] }
const bilder = import.meta.glob<{ default: ImageMetadata }>('../assets/folien/*.webp', { eager: true })
export const folien = data.folien as Record<string, Folie>
export const decks = data.decks as Record<string, Deck>
export const lint = data.lint as string[]
// Stile in „Stil wechseln“ und im Briefing der Demo; scripts/folien.mjs rendert dieselbe Liste
export const THEMES: Record<string, string> = { beratung: 'Beratung', keynote: 'Keynote', schweiz: 'Schweiz', redaktion: 'Redaktion', zen: 'Zen' }

export const bild = (id: string, sizes: string, widths = [480, 960, 1600]) => ({
  src: bilder[`../assets/folien/${id}.webp`].default,
  alt: folien[id].title ? `Folie „${folien[id].title}“` : `Folie im Layout ${folien[id].layout}`,
  sizes,
  widths,
  format: 'webp' as const,
})

// GitHub-Daten beim Build (Pages-Workflow baut täglich neu); ohne Netz bleiben die Stellen weg
const gh = async (path: string) => {
  try {
    const token = process.env.GITHUB_TOKEN
    const r = await fetch(`https://api.github.com/repos/Bavarianator/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}
const [info, releases] = await Promise.all([gh('deckwerk'), gh('deckwerk/releases?per_page=3')])
const datum = (iso: string) => new Date(iso).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' })
const absatz = (md = '') => (md.split(/\n\s*\n/).find((p) => p.trim() && !/^\s*(#|```|-)/.test(p)) ?? '').replace(/\*\*|`/g, '').trim()
export const neu = ((releases ?? []) as any[]).map((r) => ({ name: r.name || r.tag_name, url: r.html_url, datum: datum(r.published_at), text: absatz(r.body) }))
export const mb = (bytes: number) => `${(bytes / 1e6).toLocaleString('de-DE', { maximumFractionDigits: bytes < 1e7 ? 1 : 0 })} MB`
export const appimage = releases?.[0]?.assets?.find((a: any) => a.name === 'Deckwerk-x86_64.AppImage')
export const version = releases?.[0] ? `${releases[0].tag_name.replace(/^v/, '')} vom ${datum(releases[0].published_at)}` : ''
export const sterne: number = info?.stargazers_count ?? 0
export const groesse = (f: string) => { try { return mb(statSync(join(process.cwd(), 'public', f)).size) } catch { return '' } }

export const REPO = 'https://github.com/Bavarianator/deckwerk'
export const MAC_REPO = 'https://github.com/Bavarianator/deckwerk-macos'
export const APPIMAGE = `${REPO}/releases/latest/download/Deckwerk-x86_64.AppImage`
export const DMG = `${MAC_REPO}/releases/download/latest/Deckwerk-arm64.dmg` // laufender Mac-Build, wie install.sh ohne Version
export const INSTALL = 'curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/install.sh | sh'
export const INSTALL_MAC = 'curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk-macos/main/install.sh | sh'
export const UNINSTALL = 'curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/uninstall.sh | sh'
export const MCP = 'claude mcp add -s user deckwerk -- ~/deckwerk/scripts/deckwerk.sh --mcp'

export const base = import.meta.env.BASE_URL.replace(/\/?$/, '/')
export const beispiel = decks.strategie.dl.find((f) => f.endsWith('.pptx'))

// Kopf: wenige direkte Ziele; die vollständige Liste steht im Fuß
export const KOPF: [href: string, label: string][] = [
  ['#demo', 'Beispiele'],
  ['#looks', 'Stile'],
  ['#faq', 'Fragen'],
  [REPO, 'GitHub'],
]

export const FUSS: { name: string; links: [href: string, label: string][] }[] = [
  {
    name: 'Entdecken',
    links: [
      ['#so-gehts', 'So geht’s'],
      ['#demo', 'Beispiele'],
      ['#looks', 'Stile'],
      ['#formate', 'Formate'],
      ['#kosten', 'Kosten und Daten'],
      ['#faq', 'Fragen'],
      ['#laden', 'Kostenlos laden'],
    ],
  },
  {
    name: 'GitHub',
    links: [
      [REPO, sterne ? `Quellcode · ★ ${sterne}` : 'Quellcode'],
      [`${REPO}/releases`, version ? `Version ${version.split(' ')[0]}` : 'Versionen'],
      [`${REPO}/issues/new`, 'Fehler melden'],
      [`${REPO}#entwicklung`, 'Mitentwickeln'],
      [MAC_REPO, 'macOS-Fassung'],
    ],
  },
  {
    name: 'Mehr',
    links: [
      ['#technik', 'Unter der Haube'],
      ...(beispiel ? [[`${base}${beispiel}`, 'Beispiel als PowerPoint'] as [string, string]] : []),
      [`${REPO}/blob/master/LICENSE`, 'Lizenz (AGPL-3.0)'],
    ],
  },
]
