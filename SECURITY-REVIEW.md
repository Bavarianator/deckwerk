# Security-Review Deckwerk

Stand 07.10.2026, Branch `feat/mensch-statt-ki` @ `fa25e3c`.

**Umfang:** die ganze Codebasis, also Main, Preload, Renderer, Shared, Skripte, CI-Workflows und Website. Dazu kommt der Branch-Diff mit den Cloud-Sync-Änderungen: Fortschritt, Zeitlimit, 4 parallele Übertragungen, Zwischenstand.

**Vorgehen:**
- Vier Prüfungen nach Bereich: Electron/IPC/Netz, KI-Tools/MCP/CLI, Cloud-Sync/Dateien, Export/Renderer/Skripte.
- Jeder Befund wurde danach einzeln auf Fehlalarm gegengeprüft.
- Gemeldet sind nur Befunde mit einer Konfidenz von mindestens 8 von 10.

**Branch-Diff:** Er bringt keine neue Angriffsfläche.
- Die Fortschrittstexte enthalten nur Zahlen, die Zeitlimit-Meldungen nur den relativen Pfad.
- Der Zwischenstand wird nacheinander und atomar über `.tmp` + `rename` geschrieben.
- Zugangsdaten tauchen weder im Status noch in Fehlermeldungen auf.

---

# Vuln 1: Path Traversal über `deck.size` beim Export: `src/shared/deck.ts:160`

* **Status:** **behoben** (07.10.2026, uncommittet). `formatSuffix` lässt nur endliche Zahlen in den Namen, Selbsttest in `scripts/check-lint-profile.ts`.
* **Severity:** Medium
* **Kategorie:** `path_traversal` (beliebiges Schreiben von Dateien, die Endung ist vorgegeben)
* **Konfidenz:** 8/10. Die Rechnung mit `path.join` ist nachgeprüft.
* **Beschreibung:**
  - `formatSuffix` setzt bei einer unbekannten Größe `-${size.w}x${size.h}` ungeprüft in den Dateinamen ein. `src/main/engine.ts:54` baut daraus `base = join(outDir, slug(title) + formatSuffix(deck.size))`.
  - Nur der Titel läuft durch `slug()`, `size` nicht. Ein Schema für `Deck` gibt es nicht.
  - `readDeck` (`src/main/ipc.ts:639`) und MCP `open_deck` (`src/main/mcp.ts:97-108`) prüfen nur `slides` und `theme`.
  - Der Markdown-/Handout-Export (`engine.ts:55-57`) rendert nichts und schreibt direkt. Er stolpert deshalb auch nicht über eine ungültige Größe.
  - Es gibt keinen Speichern-Dialog und keine Prüfung des Pfads nach dem Zusammensetzen.
  - Betroffen sind auch `.pdf`, `.pptx`, `.docx` und `.zip` (`engine.ts:60, 73, 86, 89`) sowie PNG-Ordner (`engine.ts:80`, mit rekursivem `mkdir`).
* **Exploit-Szenario:**
  - Eine präparierte `deck.json` enthält `"size": {"w": "/../../../.claude/", "h": "/../CLAUDE"}` und einen Titel mit Zeilenumbrüchen und eigenem Markdown.
  - Die Datei kommt über die Dateizuordnung, über „Öffnen“, über einen geteilten WebDAV-, Dropbox- oder Nextcloud-Ordner (Sync lädt das Deck neu, `ipc.ts:72`) oder über `open_deck`.
  - Exportiert der Nutzer das Handout, oder ruft die KI `export_deck {format: "md"}` auf, wird geschrieben nach `join("~/Deckwerk/<titel>", "<slug>-/../../../.claude/x/../CLAUDE") + ".md"`, also nach `~/.claude/CLAUDE.md`.
  - Damit sind die eigenen Anweisungen des Nutzers überschrieben. Jede folgende Claude-Code-Sitzung bekommt die Anweisungen des Angreifers, im Auto-Modus bis hin zur Befehlsausführung.
  - Genauso lassen sich vorhandene `.md`-, `.pdf`-, `.pptx`-, `.docx`- und `.zip`-Dateien an bekannten Pfaden überschreiben. Zusätzliche `..` bleiben an `/` hängen, das Ziel ist also frei wählbar.
  - Voraussetzung: Der Nutzer öffnet das Deck und exportiert es, und der Zielordner existiert schon (außer bei PNG).
* **Empfehlung:** Den Fix an der gemeinsamen Stelle in `formatSuffix` setzen, dann sind App, MCP und alle Formate abgedeckt. Nur endliche Zahlen zulassen:
  ```ts
  if (!Number.isFinite(size.w) || !Number.isFinite(size.h)) return ''
  ```
  Zusätzlich sollten `readDeck` und `open_deck` `size` ablehnen, wenn die Werte keine positiven endlichen Zahlen sind. Das verhindert auch das NaN-Rendering.

---

# Vuln 2: Path Traversal im Cloud-Sync über `%5C` (Windows): `src/main/sync.ts:113`

* **Status:** **Behoben** am 07.10.2026, noch nicht committet. `skip()` übergeht jetzt jeden Namen mit `\`, und zwar auf beiden Seiten. Lokal heißt das: nichts wird gelöscht, eine solche Datei fällt nur aus dem gespeicherten Sync-Stand. Selbsttest ist Block 3d in `scripts/check-sync.ts`. Der Fork muss den Stand noch übernehmen.
* **Severity:** Medium, solange kein Windows-Build Cloud-Sync ausliefert. **High**, sobald der Windows-Fork `deckwerk-windows` `sync.ts` übernimmt; das passiert mit dem nächsten `npm run sync:linux`, weil `winify.mjs` die Datei nicht patcht.
* **Kategorie:** `path_traversal` (Schreiben außerhalb von `~/Deckwerk`, führt zu Codeausführung beim Login)
* **Konfidenz:** 8/10. Mit `node -e` und `path.win32` nachgerechnet.
* **Beschreibung:**
  - `parseMultistatus` (`sync.ts:60`) dekodiert den `href` des Servers mit `decodeURIComponent`. Der WHATWG-URL-Parser löst `%2e%2e` und `/../` auf, `%5C` aber nicht. Daraus wird ein `\`.
  - Der Filter in `listRemote` (`sync.ts:113`) trennt nur an `/` (`e.rel.split('/').some(skip)`). Ein Segment wie `x\..\..\AppData\…` beginnt nicht mit `.` und kommt deshalb durch.
  - `down()` (`sync.ts:178ff.`) schreibt nach `join(home, rel)`. Unter Windows behandelt `path.join` `\` als Trenner und löst die `..` auf.
  - Eine Prüfung wie in `localAsset` (`resolve` + `startsWith(home + sep)`) fehlt.
  - Linux, macOS und Android sind nicht betroffen, weil `\` dort ein normales Zeichen im Dateinamen ist.
* **Exploit-Szenario:**
  - Ein bösartiger oder kompromittierter WebDAV-Server antwortet auf das PROPFIND von `Deckwerk/` mit `<d:href>/remote.php/dav/files/u/Deckwerk/x%5C..%5C..%5CAppData%5CRoaming%5CMicrosoft%5CWindows%5CStart%20Menu%5CPrograms%5CStartup/evil.cmd</d:href>`. Dasselbe gelingt einem MITM bei einer `http://`-Adresse oder einem Mitnutzer eines geteilten Ordners auf einem Server, der `\` in Namen erlaubt (generisches WebDAV, rclone).
  - Daraus wird `rel = x\..\..\AppData\…\Startup/evil.cmd`, `skip` greift nicht.
  - Der Download landet in `C:\Users\<login>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\evil.cmd`, die `.part`-Datei im selben Ordner, und `rename` gelingt.
  - Die Batch-Datei läuft beim nächsten Login, ohne dass der Nutzer etwas tut.
  - Grenze: `touched()` überspringt vorhandene Dateien. Der Angreifer kann also nur neue Dateien anlegen. Für den Autostart-Ordner reicht das.
* **Empfehlung:** Einen Guard an der Stelle einbauen, durch die alle Pfade vom Server laufen (`sync.ts:113`):
  ```ts
  if (e.rel === rel || e.rel.split(/[\\/]/).some(skip)) continue
  ```
  Zur Absicherung in `down()` zusätzlich prüfen, dass `resolve(home, rel)` mit `resolve(home) + sep` beginnt, nach dem Muster von `localAsset`. Den Fix bitte vor dem nächsten Abgleich des Windows-Forks einbauen.

---

# Vuln 3: Absoluter lokaler Pfad als Alternativtext in jeder PPTX: `src/main/export-pptx.ts:140`

* **Status:** **Behoben** am 07.10.2026, noch nicht committet. `altText: ' '` steht jetzt in beiden Bildzweigen. Geprüft ist das mit einem echten Export von `examples/foto.json`: 9 × `descr=" "`, kein Pfad mehr. Alte Dateien unter `exports/` und `website/public/beispiele/deckwerk.pptx` enthalten die Pfade weiterhin, bis sie neu exportiert werden.
* **Severity:** Low (Datenschutz, kein Angreifer nötig)
* **Kategorie:** `data_exposure` / PII (CWE-200)
* **Konfidenz:** 8/10. An echten Exporten belegt.
* **Beschreibung:**
  - Keiner der `addImage`-Aufrufe setzt `altText`: weder `export-pptx.ts:140` noch das gemeinsame `extra` in `:146`, das die Aufrufe in `:149`, `:152` und `:153` verwenden.
  - PptxGenJS schreibt dann `descr="${altText || image}"` (`node_modules/pptxgenjs/dist/pptxgen.cjs.js:5531`). `image` ist der volle Pfad aus `assetPath()`.
  - Auch `altText: ''` fällt auf den Pfad zurück.
  - Der Code will solche Metadaten erkennbar vermeiden: `pptx.author = 'Deckwerk'` in `export-pptx.ts:222`.
* **Exploit-Szenario:**
  - Ein Nutzer exportiert ein Deck mit einem eigenen Foto. `image:pick` (`ipc.ts:307`) kopiert die Datei nicht, sondern merkt sich den Originalpfad.
  - Oder das Deck enthält Abbildungen aus importierten PDF- oder Word-Dateien.
  - Der Nutzer schickt die PPTX weiter. Der Empfänger sieht unter „Alternativtext“ den Login-Namen (oft der Klarname), die Ordnerstruktur und die Dateinamen. Ein Screenreader liest den Pfad vor. Ein Beispiel: `/home/<login>/Bilder/<Privatordner>/<Name>.jpg` oder `…/assets/import-<Name des Quelldokuments>/image1.png`.
  - Belegt ist das in den lokalen Exporten unter `exports/*.pptx` und in `website/public/beispiele/deckwerk.pptx`. Dort steht nur ein `/tmp`-Pfad, ohne personenbezogene Daten.
* **Empfehlung:**
  - In `export-pptx.ts:140` und im `extra` in `:146` einen nicht leeren `altText` setzen, z. B. `' '` oder einen echten Bildtext aus dem Inhalt.
  - Alternativ in `pptx-post.ts` jedes `descr` aus `<p:cNvPr>` entfernen.
  - Danach die Beispiel-PPTX der Website neu bauen und mit `unzip -p … 'ppt/slides/*.xml' | grep -o 'descr="[^"]*"'` nachprüfen.

---

## Unter der Meldeschwelle (Konfidenz < 8, ausgefiltert)

| Befund | Stelle | Konfidenz | Warum ausgefiltert | Mögliche Härtung |
|---|---|---|---|---|
| SSRF ins LAN über `find_images {url}`: fetch folgt Weiterleitungen, DNS-Namen wie `fritz.box` oder `*.local` und 100.64/10 sind nicht gesperrt | `src/main/tools.ts:703-704` | 5/10 | Setzt eine Prompt-Injection voraus. Laden aus dem öffentlichen Netz ist gewollt (WebFetch ist im CLI-Weg ohnehin erlaubt). Zurück kommen nur Status und Content-Type, Inhalte nur bei `image/*`. Die Lücke ist im `ponytail:`-Kommentar benannt. | `redirect: 'manual'` setzen, jedes Ziel erneut prüfen, außerdem `dns.lookup` mit `net.BlockList` (Loopback, RFC1918, 100.64/10, Link-Local, ULA). |
| Präparierte deck.json aus der Cloud bettet beliebige lokale Mediendateien in die PPTX ein (unsichtbares Item mit `opacity: 0` bei x=-1280). Der Export liegt im Deck-Ordner und wird mit hochgeladen. | `src/main/sync.ts:41`, `export-pptx.ts:28-31`, `ipc.ts:113` | 4/10 | Braucht eine bösartige Sync-Gegenstelle, exakte Dateinamen und einen PPTX-Export durch den Nutzer. Ein falscher Pfad lässt den Export laut scheitern. Abfließen können nur Medien (Bild, Video, Audio, Schrift), keine Schlüssel. | Exporte nach `<deck>/exports/` legen, das steht schon in `SKIP`. Besser: `assetPath` auf `~/Deckwerk` begrenzen und bei `image:pick`/`media:pick` die Datei nach `assets/` kopieren. Das behebt auch Vuln 3 für eigene Fotos. |
| Handy-Fernbedienung: Token und Speaker Notes laufen per Klartext-HTTP durchs LAN | `src/main/remote.ts:38, 46` | 2/10 | Bewusste, in `README.md:207` dokumentierte Entscheidung. Betroffen sind nur die Notizen der laufenden Folie sowie Weiter/Zurück. Das Token stammt aus `randomBytes(16)` und wird mit `timingSafeEqual` geprüft. | Beim Schließen des QR-Dialogs auch `remoteStop()` aufrufen (`PresentScreen.tsx:389`) und nur an die ermittelte IP binden. |
| XML-Injection über `items[].effectColor`/`items[].font` in die PPTX | `src/main/patch-xml.ts:57, 65` | – | Keine konkrete Auswirkung: keine externen Rels, Links nur https/mailto. Wer das ausnutzen will, könnte gleich eine präparierte PPTX schicken. | `hex()` auf `/^[0-9A-F]{6}$/` prüfen. |
| Lock- und Log-Datei in `/tmp`, wenn `XDG_RUNTIME_DIR` fehlt | `scripts/deckwerk.sh:15-17` | – | Ausnutzbar nur über Symlinks eines anderen lokalen Nutzers, und `fs.protected_symlinks` verhindert das standardmäßig. | – |

## Geprüft und unauffällig

- **Electron-Härtung:** Hauptfenster und Publikumsfenster laufen mit `sandbox: true` und `contextIsolation`, ohne `nodeIntegration`.
  - `will-navigate` ist gesperrt, `setWindowOpenHandler` lehnt ab. Es gibt kein `webview` und keine iframes.
  - Die CSP (`script-src 'self'`, kein https in img/media/font/connect) verhindert Skripte und Datenabfluss aus dem Renderer.
  - Deck-Daten erreichen `executeJavaScript` nur über `JSON.stringify`.
- **XSS-Senken:** Es gibt weder `dangerouslySetInnerHTML` noch `innerHTML` oder `eval`.
  - Links sind `<span data-href>`, nur https/mailto sind erlaubt.
  - SVG wird nur als `data:`-Bild eingebunden.
  - Auf der Website gibt es `set:html` nur mit statischen Strings.
- **IPC und Prozesse:**
  - `shell.openExternal` öffnet nur feste Listen oder http(s).
  - Alle `execFile`/`spawn`-Aufrufe arbeiten ohne Shell und mit festen Argumenten. `cliArg` prüft gegen eine Allowlist.
  - Nutzertext geht an die CLIs nur über stdin. In den CLIs sind Shell- und Datei-Tools gesperrt.
- **Lokaler MCP-HTTP-Server** (`claude-agent.ts`):
  - Er lauscht nur auf 127.0.0.1. Das Bearer-Token kommt aus `randomBytes(24)`.
  - Weil es keine CORS-Antwort gibt, helfen weder CSRF noch DNS-Rebinding.
  - Das Token steht nie in `ps`: Es liegt in einer 0600-Datei in einem mkdtemp-Ordner oder in der Umgebung des Kindprozesses.
- **Secrets:**
  - Der Renderer bekommt nur `hasPass` bzw. die Quelle eines Schlüssels, nie den Schlüssel selbst.
  - Das Sync-Passwort wird nur für dieselbe URL und denselben Nutzer wiederverwendet.
  - undici entfernt `Authorization`, wenn eine Weiterleitung auf einen anderen Ursprung führt.
- **Cloud-Sync (Linux/macOS/Android):**
  - `%2e%2e` und `..%2f` kommen nicht durch, Punktsegmente fallen in `skip`.
  - Das XML wird per Regex gelesen, also ohne XXE.
  - `rmLocal` wirkt nur auf lokal aufgezählte Pfade.
  - Konfliktdateien bekommen Namen mit Zeitstempel, nicht aus Serverdaten.
- **Dateien und Pfade:**
  - `asset://` und der Export prüfen `MEDIA_EXT`. `~/.ssh/id_rsa` oder `sync.bin` lassen sich deshalb nicht einbetten.
  - `fromAsset` prüft `resolve` + `startsWith`.
  - Titel laufen durch `slug()` und taugen nicht für Traversal.
  - Beim Import von Quellmaterial gibt es kein Zip-Slip (`basename`, `clean()`, Schreiben mit `wx`) und kein XXE.
  - `bg-remove` lädt das Modell mit SHA-256-Prüfung.
- **CI/Installer:**
  - Die Workflows nutzen nur `pull_request`, kein `pull_request_target`, und kein `${{ github.event.* }}` in `run:`.
  - `install.sh` lädt per HTTPS von GitHub nach `mktemp -d`.
