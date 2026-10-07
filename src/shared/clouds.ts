// Cloud-Anbieter für den Sync (Einstellungen → Cloud): wie man sich anmeldet und wohin Deckwerk spiegelt.
// nextcloud: Anmeldung im Browser (Login Flow v2). webdav: Adresse steht hier, der Nutzer gibt nur Nutzername und Passwort ein.
// folder: Dienste ohne WebDAV (Dropbox, OneDrive, Google Drive, iCloud) über den Sync-Ordner ihrer Desktop-App.
// Die Hilfe-Links öffnet nur der Main-Prozess (cloud:help), deshalb stehen sie hier und nicht im Renderer.
// Adressen und Hilfeseiten geprüft am 07.10.2026 (WebDAV-Endpunkte antworten anonym mit 401).

export interface CloudPreset {
  id: string
  name: string
  kind: 'nextcloud' | 'webdav' | 'folder'
  /** ein, zwei Sätze unter dem Formular: was man braucht, wo das Passwort herkommt */
  hint: string
  /** nextcloud: feste Server-Adresse (ohne fragt die UI danach). webdav: {server} = Eingabe (ohne Schema → https://),
   * {id} = Eingabe unverändert, {user} = Nutzername, {luser} = Nutzername kleingeschrieben */
  url?: string
  /** Beschriftung des Felds für {server} bzw. {id} */
  ask?: string
  /** Beschriftung des Nutzernamens, Standard „E-Mail-Adresse“ */
  user?: string
  /** Beschriftung des Passworts, Standard „Passwort“ */
  pass?: string
  /** Seite zum Anlegen des App-Passworts bzw. Anleitung */
  help?: string
  /** folder: übliche Sync-Ordner (~ = Home, * = ein beliebiger Namensteil); der erste vorhandene wird vorgeschlagen */
  folders?: string[]
}

export const CLOUDS: CloudPreset[] = [
  // Anmelden im Browser
  { id: 'nextcloud', name: 'Nextcloud', kind: 'nextcloud', ask: 'Adresse deiner Nextcloud',
    hint: 'Eigener Server oder gemietet, z. B. Hetzner Storage Share. Deckwerk bekommt ein eigenes App-Passwort, dein Passwort sieht es nie.' },
  { id: 'magentacloud', name: 'MagentaCLOUD', kind: 'nextcloud', url: 'https://magentacloud.de',
    hint: 'Mit deinem Telekom-Login im Browser. Geht nur mit einer Telekom-Adresse (@t-online.de, @magenta.de).' },
  // Über die App auf diesem Rechner
  { id: 'dropbox', name: 'Dropbox', kind: 'folder', hint: 'Die Dropbox-App muss auf diesem Rechner laufen. Deckwerk legt seinen Ordner in deine Dropbox.',
    folders: ['~/Library/CloudStorage/Dropbox', '~/Dropbox'] },
  { id: 'onedrive', name: 'OneDrive', kind: 'folder', hint: 'Die OneDrive-App muss auf diesem Rechner laufen (unter Linux z. B. der Client „onedrive“).',
    folders: ['~/Library/CloudStorage/OneDrive-Personal', '~/Library/CloudStorage/OneDrive-*', '~/OneDrive', '~/OneDrive - *'] },
  { id: 'gdrive', name: 'Google Drive', kind: 'folder', hint: 'Google Drive für Desktop muss laufen (unter Linux z. B. Insync).',
    folders: ['~/Library/CloudStorage/GoogleDrive-*/Meine Ablage', '~/Library/CloudStorage/GoogleDrive-*/My Drive', 'G:/Meine Ablage', 'G:/My Drive', '~/Insync/*/Google Drive', '~/Insync/*/My Drive', '~/Google Drive'] },
  { id: 'icloud', name: 'iCloud Drive', kind: 'folder', hint: 'Auf dem Mac eingebaut, unter Windows mit der App „iCloud für Windows“.',
    folders: ['~/Library/Mobile Documents/com~apple~CloudDocs', '~/iCloudDrive', '~/iCloud Drive'] },
  // Mit Nutzername und Passwort (WebDAV)
  { id: 'gmx', name: 'GMX Cloud', kind: 'webdav', url: 'https://webdav.mc.gmx.net', user: 'GMX-E-Mail-Adresse', pass: 'App-Passwort',
    hint: 'App-Passwort anlegen: bei GMX auf deine Initialen → Account verwalten → Login & Sicherheit → App-Passwörter.',
    help: 'https://hilfe.gmx.net/sicherheit/2fa/anwendungsspezifisches-passwort.html' },
  { id: 'webde', name: 'WEB.DE Online-Speicher', kind: 'webdav', url: 'https://webdav.smartdrive.web.de', user: 'WEB.DE-E-Mail-Adresse', pass: 'App-Passwort',
    hint: 'App-Passwort anlegen: bei WEB.DE auf deine Initialen → Account verwalten → Login & Sicherheit → App-Passwörter.',
    help: 'https://hilfe.web.de/sicherheit/2fa/anwendungsspezifisches-passwort.html' },
  { id: 'hidrive', name: 'STRATO HiDrive', kind: 'webdav', url: 'https://webdav.hidrive.strato.com/users/{luser}/', user: 'HiDrive-Benutzername (kleingeschrieben)',
    hint: 'Benutzername und Passwort von HiDrive, nicht die E-Mail. WebDAV muss im Paket enthalten sein. Mit Zwei-Faktor-Anmeldung lieber einen eigenen HiDrive-Nutzer ohne 2FA anlegen.',
    help: 'https://www.strato.de/faq/cloud-speicher/ueber-welche-protokolle-kann-ich-mich-mit-hidrive-verbinden/' },
  { id: 'hidrive-ionos', name: 'IONOS HiDrive', kind: 'webdav', url: 'https://webdav.hidrive.ionos.com/users/{luser}/', user: 'HiDrive-Benutzername (kleingeschrieben)',
    hint: 'Vorher in HiDrive unter Einstellungen → Zugriffsrechte und Protokolle WebDAV einschalten.',
    help: 'https://www.ionos.de/hilfe/cloud-speicher/einrichtung-von-hidrive/verbinden-per-webdav-windows-10/11/' },
  { id: 'pcloud', name: 'pCloud (Daten in der EU)', kind: 'webdav', url: 'https://ewebdav.pcloud.com',
    hint: 'E-Mail und pCloud-Passwort. Klappt die Anmeldung nicht, liegt dein Konto vermutlich in den USA.',
    help: 'https://help.pcloud.com/article/connect-to-pcloud-using-webdav-and-rsync' },
  { id: 'pcloud-us', name: 'pCloud (Daten in den USA)', kind: 'webdav', url: 'https://webdav.pcloud.com',
    hint: 'E-Mail und pCloud-Passwort. Klappt die Anmeldung nicht, liegt dein Konto vermutlich in der EU.',
    help: 'https://help.pcloud.com/article/connect-to-pcloud-using-webdav-and-rsync' },
  { id: 'koofr', name: 'Koofr', kind: 'webdav', url: 'https://app.koofr.net/dav/Koofr', pass: 'App-Passwort',
    hint: 'Das normale Passwort geht nicht: bei Koofr unter Preferences → Password → App passwords eins erzeugen.',
    help: 'https://koofr.eu/help/linking-koofr-with-desktops/how-to-generate-an-application-specific-password-in-koofr/' },
  { id: 'kdrive', name: 'Infomaniak kDrive', kind: 'webdav', url: 'https://{id}.connect.kdrive.infomaniak.com', ask: 'kDrive-ID', pass: 'App-Passwort',
    hint: 'Die kDrive-ID ist die Zahl in der Adresse kdrive.infomaniak.com/app/drive/…. Nicht in kSuite Free und Standard.',
    help: 'https://manager.infomaniak.com/v3/ng/profile/user/connection-history/application-password' },
  { id: 'storagebox', name: 'Hetzner Storage Box', kind: 'webdav', url: 'https://{user}.your-storagebox.de', user: 'Box-Nutzer (z. B. u123456)',
    hint: 'In der Hetzner Console WebDAV und „Externe Erreichbarkeit“ einschalten.',
    help: 'https://docs.hetzner.com/de/storage/storage-box/access/access-webdav' },
  { id: 'owncloud', name: 'ownCloud', kind: 'webdav', url: '{server}/remote.php/webdav/', ask: 'Adresse deines ownCloud-Servers', user: 'Nutzername', pass: 'Passwort oder App-Passwort',
    hint: 'Für ownCloud 10. Ein App-Passwort legst du in ownCloud unter Einstellungen → Sicherheit an.' },
  { id: 'synology', name: 'Synology', kind: 'webdav', url: '{server}', ask: 'Adresse mit Port und freigegebenem Ordner, z. B. https://nas.local:5006/home', user: 'DSM-Nutzername',
    hint: 'Auf der NAS das Paket „WebDAV Server“ installieren und HTTPS einschalten.' },
  { id: 'webdav', name: 'Anderer WebDAV-Dienst', kind: 'webdav', url: '{server}', ask: 'WebDAV-Adresse', user: 'Nutzername',
    hint: 'Die WebDAV-Adresse steht in der Hilfe deines Anbieters. Nutze ein App-Passwort, wenn es eins gibt.' },
  { id: 'folder', name: 'Anderer Ordner', kind: 'folder', hint: 'Irgendein Ordner, den ein Cloud-Programm auf diesem Rechner abgleicht.' },
]

/** WebDAV-Adresse eines Anbieters aus Zusatzfeld (server bzw. ID) und Nutzername */
export function cloudUrl(p: CloudPreset, field: string, user: string): string {
  const f = field.trim().replace(/\/+$/, '')
  return (p.url ?? '{server}')
    .replace('{server}', !f || f.includes('://') ? f : `https://${f}`)
    .replace('{id}', encodeURIComponent(f))
    .replace('{user}', encodeURIComponent(user.trim()))
    .replace('{luser}', encodeURIComponent(user.trim().toLowerCase()))
}
