// electron-builder-Konfiguration der Edition Deckwerk Pro: die von Deckwerk (package.json "build") mit eigener Identität,
// damit beide Apps nebeneinander installiert sein können. Aufruf: npm run dist:linux:pro
const base = require('./package.json').build
module.exports = {
  ...base,
  appId: 'de.deckwerk.pro',
  productName: 'Deckwerk Pro',
  extraMetadata: { name: 'deckwerk-pro', productName: 'Deckwerk Pro' },
  linux: { ...base.linux, executableName: 'deckwerk-pro', desktop: { ...base.linux.desktop, entry: { ...base.linux.desktop.entry, StartupWMClass: 'deckwerk-pro' } } },
  appImage: { ...base.appImage, artifactName: 'DeckwerkPro-${arch}.${ext}' },
}
