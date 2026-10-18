// Gemeinsam bearbeiten in der App: verbindet mitarbeit.ts (Links, Freigaben, Live-Abgleich) mit dem offenen Deck aus ipc.ts.
// Gast-Zugänge und Link-Passwörter liegen verschlüsselt in appData/deckwerk/mitarbeit.bin, der Anzeigename in profil.json.
import { app, ipcMain, safeStorage, type BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Deck } from '../shared/deck'
import { newId } from '../shared/items'
import { beitreten, createLive, deckDirName, freigabeAendern, freigabeBeenden, freigaben, freigeben, guestRemote, isShared, ownerRemote, parseLink, serverOf, teilenBeginnen, teilenEnden,
  type Anwesend, type Freigabe, type LiveStatus, type Remote, type Rolle, type Zugang } from './mitarbeit'
import { isFolder, type SyncSettings } from './sync'
import { localizeDeck } from './tools'

interface Store { gaeste: Record<string, { z: Zugang; remote: Remote }>; passwoerter: Record<string, string> }
/** was die Oberfläche über das offene Deck wissen muss; rolle besitzer = eigener Ordner, edit/view = Gast */
export interface TeilenStatus { geteilt: boolean; rolle: 'besitzer' | Rolle | null; server: string | null; freigaben: Freigabe[]; hinweis: string | null }

export interface GemeinsamCtx {
  home: string
  getDeck: () => Deck | null
  getPath: () => string | null
  /** deck.json jetzt schreiben (vor der Basis, siehe mitarbeit.ts) */
  saveNow: () => Promise<void>
  syncCfg: () => SyncSettings | null
  freeDir: (title: string) => string
  /** Deck öffnen wie über „Zuletzt“, liefert den AppState */
  openFile: (file: string) => Promise<unknown>
}

const stamp = () => new Date().toLocaleString('sv').replace(' ', 'T').replace(/:/g, '-')

export function registerGemeinsam(win: BrowserWindow, ctx: GemeinsamCtx) {
  const dir = join(app.getPath('appData'), 'deckwerk')
  const storeFile = join(dir, 'mitarbeit.bin'), profilFile = join(dir, 'profil.json')
  let store: Store = { gaeste: {}, passwoerter: {} }
  try { if (existsSync(storeFile)) store = { ...store, ...JSON.parse(safeStorage.decryptString(readFileSync(storeFile))) } } catch (e) { console.warn('[gemeinsam] Zugänge nicht lesbar:', e) }
  const saveStore = async () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Keine sichere Schlüsselablage verfügbar, der Zugang kann nicht gespeichert werden.')
    await mkdir(dir, { recursive: true })
    await writeFile(storeFile, safeStorage.encryptString(JSON.stringify(store)), { mode: 0o600 })
  }
  // Anzeigename für die anderen und eine feste ID für die Anwesenheitsdatei
  let profil: { id: string; name: string } = { id: newId() + newId(), name: '' }
  try { profil = { ...profil, ...JSON.parse(readFileSync(profilFile, 'utf8')) } } catch { /* erster Start */ }
  if (!existsSync(profilFile)) void mkdir(dir, { recursive: true }).then(() => writeFile(profilFile, JSON.stringify(profil)))
  const name = () => profil.name.trim() || (() => { try { return userInfo().username } catch { return 'Jemand' } })()

  const send = (ch: string, x: unknown) => { if (!win.isDestroyed()) win.webContents.send(ch, x) }
  const nextcloud = () => { const c = ctx.syncCfg(); return c && !isFolder(c.url) ? c : null }
  const gast = (deckDir: string) => store.gaeste[basename(deckDir)]

  let live: ReturnType<typeof createLive> | null = null
  let liveDir: string | null = null
  let last: { etag: string; theirs: Deck } | null = null // für die Sicherung bei Konflikten
  let gesichert = '' // ohne Basis: eigenen Stand je fremdem Stand einmal nach versions/

  /** Live für das offene Deck starten bzw. stoppen (nach jedem Öffnen und nach Teilen/Beenden) */
  async function opened(file: string | null) {
    const d = file ? dirname(file) : null
    if (live && liveDir === d) return
    await live?.stop()
    live = null; liveDir = null; last = null
    send('live:presence', [])
    if (!d || !isShared(d) || !file) { send('live:status', null); return }
    const g = gast(d), cfg = nextcloud(), dirName = deckDirName(file, ctx.home)
    let remote: Remote, rolle: Rolle
    if (g) { remote = g.remote; rolle = g.z.r }
    else if (cfg && dirName) { remote = ownerRemote(cfg, dirName); rolle = 'edit' }
    else { send('live:status', { zustand: 'offline', rolle: 'edit', text: 'Geteiltes Deck: Verbinde in den Einstellungen deine Nextcloud, um mitzuarbeiten.' } satisfies LiveStatus); return }
    liveDir = d
    live = createLive({
      dir: d, remote, rolle, ich: { id: profil.id, name: name() },
      getDeck: ctx.getDeck,
      fokus: () => !win.isDestroyed() && win.isFocused(),
      onStatus: (s) => send('live:status', s),
      onPresence: (p: Anwesend[]) => send('live:presence', p),
      onRemote: ({ base, theirs, etag, ohneBasis }) => {
        last = { etag, theirs }
        if (ohneBasis && gesichert !== etag && ctx.getDeck()) { // weiteres Gerät ohne gemeinsamen Stand: die Cloud gewinnt, das Eigene bleibt in versions/
          gesichert = etag
          void mkdir(join(d, 'versions'), { recursive: true }).then(() => writeFile(join(d, 'versions', `${stamp()}-lokal.json`), JSON.stringify(ctx.getDeck(), null, 2)))
        }
        const loc = (x: Deck) => localizeDeck(structuredClone(x), d) // relative Bildpfade wie beim Öffnen auflösen
        send('live:remote', { path: file, base: loc(base), theirs: loc(theirs), etag })
      },
    })
  }

  /** Renderer hat einen fremden Stand übernommen: erst deck.json, dann die Basis; bei Konflikten den fremden Stand sichern */
  async function ack(a: { etag: string; konflikte: number }) {
    if (!live) return
    await ctx.saveNow()
    if (a.konflikte > 0 && last?.etag === a.etag && liveDir) {
      await mkdir(join(liveDir, 'versions'), { recursive: true })
      await writeFile(join(liveDir, 'versions', `${stamp()}-cloud.json`), JSON.stringify(last.theirs, null, 2))
    }
    await live.ack(a.etag)
  }

  async function status(): Promise<TeilenStatus> {
    const file = ctx.getPath(), deck = ctx.getDeck()
    const leer: TeilenStatus = { geteilt: false, rolle: null, server: null, freigaben: [], hinweis: null }
    if (!file || !deck) return { ...leer, hinweis: 'Speichere das Deck zuerst.' }
    const d = dirname(file), g = gast(d)
    if (g && isShared(d)) return { geteilt: true, rolle: live?.rolle() ?? g.z.r, server: new URL(g.z.s).host, freigaben: [], hinweis: null }
    const cfg = nextcloud(), dirName = deckDirName(file, ctx.home)
    if (!cfg) return { ...leer, hinweis: 'Teilen per Link geht über deine Nextcloud oder MagentaCLOUD. Verbinde sie in den Einstellungen unter Cloud.' }
    if (!dirName) return { ...leer, hinweis: 'Teilen geht nur für Decks im Deckwerk-Ordner.' }
    let server: string
    try { server = new URL(serverOf(cfg).root).host } catch (e) { return { ...leer, hinweis: (e as Error).message } }
    const shared = isShared(d)
    const list = shared ? await freigaben(cfg, dirName, deck.title, (t) => store.passwoerter[t]) : []
    return { geteilt: shared, rolle: 'besitzer', server, freigaben: list, hinweis: null }
  }

  ipcMain.handle('teilen:status', () => status())
  ipcMain.handle('teilen:create', async (_, rolle: unknown, ablauf: unknown) => {
    if (rolle !== 'edit' && rolle !== 'view') throw new Error('Unbekannte Rolle.')
    if (ablauf !== null && (typeof ablauf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ablauf))) throw new Error('Ablaufdatum als JJJJ-MM-TT.')
    const file = ctx.getPath(), deck = ctx.getDeck(), cfg = nextcloud()
    const dirName = file ? deckDirName(file, ctx.home) : null
    if (!file || !deck || !cfg || !dirName) throw new Error((await status()).hinweis ?? 'Dieses Deck lässt sich nicht teilen.')
    await ctx.saveNow()
    const f = await freigeben(cfg, dirName, deck.title, rolle, ablauf as string | null)
    if (f.passwort) { store.passwoerter[f.token] = f.passwort; await saveStore() }
    if (!isShared(dirname(file))) { await teilenBeginnen(ownerRemote(cfg, dirName), dirname(file), deck); await opened(file) }
    return status()
  })
  ipcMain.handle('teilen:update', async (_, id: unknown, p: { rolle?: unknown; ablauf?: unknown }) => {
    const cfg = nextcloud()
    if (!cfg || typeof id !== 'string') throw new Error('Kein Zugang zur Nextcloud.')
    const rolle = p?.rolle === 'edit' || p?.rolle === 'view' ? p.rolle : undefined
    const ablauf = p?.ablauf === null ? null : typeof p?.ablauf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.ablauf) ? p.ablauf : undefined
    await freigabeAendern(cfg, id, { rolle, ablauf })
    return status()
  })
  // Link beenden; ist es der letzte, gilt der Ordner wieder als eigener (normaler Sync)
  ipcMain.handle('teilen:end', async (_, id: unknown) => {
    const cfg = nextcloud(), file = ctx.getPath()
    if (!cfg || !file || typeof id !== 'string') throw new Error('Kein Zugang zur Nextcloud.')
    await freigabeBeenden(cfg, id)
    const rest = await status()
    if (!rest.freigaben.length) {
      const dirName = deckDirName(file, ctx.home)
      await live?.stop(); live = null; liveDir = null
      await teilenEnden(dirName ? ownerRemote(cfg, dirName) : null, dirname(file))
      send('live:status', null)
      return status()
    }
    return rest
  })
  // Gast: nicht mehr mitarbeiten. Die lokale Kopie bleibt als eigenes Deck
  ipcMain.handle('teilen:leave', async () => {
    const file = ctx.getPath()
    if (!file) return
    await live?.stop(); live = null; liveDir = null
    delete store.gaeste[basename(dirname(file))]
    await saveStore()
    await teilenEnden(null, dirname(file))
    send('live:status', null)
  })
  ipcMain.handle('live:folie', (_, id: unknown) => live?.folie(typeof id === 'string' ? id : null))
  ipcMain.handle('profil:get', () => ({ name: profil.name, vorschlag: name() }))
  ipcMain.handle('profil:set', async (_, n: unknown) => {
    if (typeof n !== 'string' || n.length > 60) throw new Error('Der Name darf höchstens 60 Zeichen haben.')
    profil = { ...profil, name: n.trim() }
    await writeFile(profilFile, JSON.stringify(profil))
  })

  /** Link öffnen (Startseite, deckwerk://): schon beigetreten → vorhandene Kopie, sonst herunterladen. Liefert den AppState */
  async function openLink(text: unknown) {
    const z = typeof text === 'string' && text.length < 4000 ? parseLink(text) : null
    if (!z) throw new Error('Das ist kein Deckwerk-Link. Kopiere den ganzen Link, den du bekommen hast.')
    const known = Object.entries(store.gaeste).find(([d, g]) => g.z.s === z.s && g.z.t === z.t && existsSync(join(ctx.home, d, 'deck.json')))
    if (known) {
      if (z.p && known[1].z.p !== z.p) { known[1].z.p = z.p; known[1].remote = await guestRemote(z); await saveStore() } // neues Passwort
      return ctx.openFile(join(ctx.home, known[0], 'deck.json'))
    }
    const remote = await guestRemote(z)
    const { file } = await beitreten(z, remote, ctx.freeDir)
    store.gaeste[basename(dirname(file))] = { z, remote }
    await saveStore()
    return ctx.openFile(file)
  }
  ipcMain.handle('link:open', (_, text: unknown) => openLink(text))

  return {
    opened,
    ack,
    openLink,
    saved: () => live?.kick(),
    stop: () => live?.stop(),
    /** Rolle des offenen Decks (Lesemodus bei view) */
    rolle: () => live?.rolle() ?? null,
  }
}

/** deckwerk://teilen?d=… aus der Kommandozeile (Protokoll-Handler) */
export const linkArg = (argv: string[]) => argv.find((a) => /^deckwerk:\/\//i.test(a)) ?? null
