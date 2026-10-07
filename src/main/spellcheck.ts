import { app, ipcMain, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Rechtschreibprüfung nur im Hauptfenster; die Render-Fenster schalten sie ab, sonst landen Wellenlinien in Exporten.
// Aus = Marker unter appData/deckwerk (gemeinsam für App und Entwicklung wie setup-done), Standard an.
export function setupSpellcheck(win: BrowserWindow) {
  const wc = win.webContents, ses = wc.session
  const off = join(app.getPath('appData'), 'deckwerk', 'spellcheck-off')
  // macOS nutzt die Systemprüfung und erkennt die Sprache selbst; sonst Hunspell-Wörterbücher (einmaliger Download).
  // Sprachen nur bei eingeschalteter Prüfung setzen: sie stoßen den Download an, und wer sie ausschaltet, soll keinen haben.
  const enable = (on: boolean) => {
    if (on && process.platform !== 'darwin') ses.setSpellCheckerLanguages(['de-DE', 'en-US'])
    ses.setSpellCheckerEnabled(on)
  }
  enable(!existsSync(off))
  ipcMain.handle('spellcheck:get', () => ses.isSpellCheckerEnabled())
  ipcMain.handle('spellcheck:set', async (_, on: unknown) => {
    on = on === true
    enable(on as boolean)
    if (on) await rm(off, { force: true })
    else await mkdir(dirname(off), { recursive: true }).then(() => writeFile(off, ''))
  })
  // Kommt nur, wenn der Renderer kein eigenes Menü zeigt (preventDefault auf contextmenu)
  wc.on('context-menu', (_, p) => {
    if (!p.isEditable) return
    const fix: MenuItemConstructorOptions[] = p.dictionarySuggestions.slice(0, 5).map((w) => ({ label: w, click: () => wc.replaceMisspelling(w) }))
    if (p.misspelledWord) fix.push({ label: 'Zum Wörterbuch hinzufügen', click: () => ses.addWordToSpellCheckerDictionary(p.misspelledWord) })
    if (fix.length) fix.push({ type: 'separator' })
    // eigene Beschriftungen: Electron beschriftet Rollen nur englisch
    Menu.buildFromTemplate([
      ...fix,
      { role: 'cut', label: 'Ausschneiden' },
      { role: 'copy', label: 'Kopieren' },
      { role: 'paste', label: 'Einfügen' },
      { role: 'selectAll', label: 'Alles auswählen' },
    ]).popup({ window: win })
  })
}
