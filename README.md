# Deckwerk

KI-Präsentationsstudio für den Desktop. Ein Satz genügt: Deckwerk schreibt die Storyline, baut die Folien, prüft jede einzelne als Bild und exportiert nach PowerPoint (editierbar), PDF und PNG. Danach gestaltest du frei weiter wie in Canva, per Chat oder direkt auf der Folie.

Den KI-Zugang liefert der Login deines Agenten-CLIs (Claude Code, Codex oder Mistral Vibe) oder ein Anthropic-API-Key.

Website: [bavarianator.github.io/deckwerk](https://bavarianator.github.io/deckwerk/) (Quelle in `website/`, Folienbilder neu erzeugen mit `npm run folien` dort)

## Was Deckwerk kann

- **Aus einem Satz ein Deck.** Storyline nach dem Pyramidenprinzip, Action Titles, 29 Layouts, Diagramme und Animationen. Jede Folie wird gerendert und geprüft: Überlauf, Kontrast, Struktur, Eintönigkeit.
- **Quellmaterial nutzen.** PDF, Word, PowerPoint, Text, Markdown, CSV oder JSON anhängen, und die KI baut das Deck daraus. Auf Wunsch recherchiert sie im Web.
- **Eigene Bilder und Logos.** Fotos, Screenshots und Logos (PNG, JPG, WebP, GIF, SVG) einfach mit anhängen, auch mehrere Dateien auf einmal. Abbildungen aus PDF, Word und PowerPoint kommen mit. Die KI sieht sich jedes Bild an, setzt Fotos auf die passende Folie und ein Logo auf Titel- und Schlussfolie.
- **Video-Schnitt.** Die KI macht aus langen Videos Shorts mit Hook und Untertiteln, kürzt ganze Videos, findet die Höhepunkte stundenlanger Streams und baut Zusammenschnitte mit Zwischentiteln und Musik. Videos kommen als Anhang oder per Link (YouTube, Twitch, Kick).
- **Frei gestalten.** Texte, Formen, Fotos, Icons, Diagramme, QR-Codes, Video und Audio. Dazu Gruppen, Zuschnitt, Freisteller, Ausrichten, Hilfslinien und das Umwandeln von Layout-Folien in freie Elemente.
- **Ein Look für alles.** 11 Themes, eigene Designs von der KI, eigene Schriften, 8 Formate von 16:9 über Instagram bis A4 (Layouts, Schriftgrößen und Lint passen sich an), ein Brand-Kit für jedes neue Deck und ein Hausstil, den sich die KI dauerhaft merkt.
- **Präsentieren.** Referentenansicht mit Notizen, Uhr und Sprechzeit, Laserpointer und Stift, Handy als Fernbedienung.
- **Export.** PowerPoint mit editierbaren Objekten, Animationen und eingebetteten Schriften, Word mit bearbeitbarem Text, dazu PDF, PNG, ein ZIP mit allen Bildern plus PDF (Karussell) und ein Handout als Markdown.
- **Auch aus Claude Code.** Deckwerk ist ein MCP-Server: Decks lassen sich direkt aus dem Terminal bauen und bearbeiten.

## Installation

Deckwerk läuft unter Linux (x86_64) und unter Windows in WSL. Für macOS gibt es eine eigene Fassung: [deckwerk-macos](https://github.com/Bavarianator/deckwerk-macos). Auf dem Mac leitet der Befehl unten automatisch dorthin weiter.

```sh
curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/install.sh | sh
```

Der Installer lädt die fertige App aus dem neuesten Release nach `~/.local/share/deckwerk`. Git und Node.js brauchst du dafür nicht. Er legt einen Startmenü-Eintrag an und öffnet `deck.json`-Dateien per Doppelklick mit Deckwerk. Sind Claude Code, Codex oder Vibe installiert, trägt er Deckwerk dort als MCP-Server ein.

**Aktualisieren:** `deckwerk update` im Terminal (der Installer legt den Befehl `deckwerk` nach `~/.local/bin`) oder in Deckwerk unter Einstellungen → Allgemein → „Nach Updates suchen“. Beides führt den Installationsbefehl erneut aus: holt den neuesten Release und ersetzt die App; deine Decks und Einstellungen bleiben. Deckwerk fragt nie von selbst nach Updates.

**Entfernen:**

```sh
curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/uninstall.sh | sh
```

Das Skript entfernt die App, den Startmenü-Eintrag, die Dateizuordnung und die Einträge in Claude Code, Vibe und Codex. Deine Decks unter `~/Deckwerk` bleiben erhalten.

<details>
<summary>Andere Wege: AppImage, aus dem Quellcode, wget</summary>

**AppImage:** `Deckwerk-x86_64.AppImage` aus den [Releases](https://github.com/Bavarianator/deckwerk/releases/latest) laden, ausführbar machen und starten. Das braucht FUSE 2 (`libfuse2`). Der Installer oben braucht es nicht, weil er das AppImage entpackt.

**Aus dem Quellcode** (Git und Node.js 22 oder neuer):

```sh
curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/install.sh | DECKWERK_SOURCE=1 sh
```

Das klont den neuesten Release-Tag nach `~/deckwerk` (anderer Ordner: `DECKWERK_DIR`, anderer Stand: `DECKWERK_REF=master`), installiert die Abhängigkeiten und baut. Ein erneuter Aufruf aktualisiert auf den neuesten Release. Ein Checkout auf einem Zweig wird dabei nur vorgespult, nie umgestellt. Aus einem eigenen Checkout: `./scripts/install.sh`; entfernen mit `~/deckwerk/scripts/uninstall.sh`. Startest du eine Quellcode-Installation über das Startmenü, baut sie nach einem Update selbst neu (etwa eine Minute).

**Mit wget:** `wget -qO- https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/install.sh | sh`

**Sandbox:** Erlaubt das System keine User-Namespaces (etwa Ubuntu 24.04 mit AppArmor-Sperre), startet Deckwerk ohne Chromium-Sandbox, statt gar nicht. Wer das nicht möchte, gibt die Namespaces frei (`sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`) oder richtet ein AppArmor-Profil ein.

</details>

## Erste Schritte

1. Starte Deckwerk über das Startmenü.
2. Beim ersten Start führt dich die Einrichtung durch den KI-Zugang. Sie findet Claude Code, Codex und Vibe von selbst. Ist eines davon installiert und angemeldet, brauchst du nichts einzutragen: Der Chat nutzt dessen Login, bei mehreren wählst du per Klick. Ohne Zugang zeigt sie die Wege Schritt für Schritt: Claude-Abo (Claude Code per nativem Installer), ChatGPT-Abo (Codex), Mistral-Schlüssel (Vibe) oder Anthropic-API-Key. Ein frisch installiertes CLI erkennt sie von selbst, „Anmelden“ öffnet den Login von Claude Code bzw. Codex im Browser, ohne Terminal. Einen Key prüft Deckwerk vor dem Speichern bei Anthropic, alternativ geht `ANTHROPIC_API_KEY`. Ein eingetragener Key hat Vorrang.

   Alles Weitere steht in den **Einstellungen** (Zahnrad oben rechts, auf dem Startbildschirm und im Editor): KI-Zugang (An- und Abmelden je Konto, Schlüssel, Modell), Cloud, Bilder (KI-Bilder und Unsplash-Fotosuche), Marke (Standard-Brand-Kit und Hausstil), Agenten (Deckwerk mit einem Klick in alle gefundenen CLIs eintragen, Verbindung testen) und Allgemein (Version, Speicherort, Datenschutz).
3. Beschreibe auf dem Startbildschirm in einem Satz, was du zeigen willst, zum Beispiel „Quartalsbericht für die Geschäftsführung, 8 Folien, Fokus auf Wachstum“. Über „Datei“ (oder per Ziehen ins Feld) hängst du Quellmaterial und eigene Bilder an, auch mehrere Dateien. Die Bilder landen in `~/Deckwerk/assets/`, Abbildungen aus Dokumenten unter `assets/import-<name>/`. Für Abbildungen aus PDFs braucht Deckwerk `pdfimages` aus demselben Poppler-Paket wie `pdftotext`.
4. Oder beginne mit einer Vorlage (du bearbeitest eine Kopie) oder mit „Leer beginnen und frei gestalten“.

## Bedienung

### Mit der KI arbeiten

- Der Chat unten im Editor nimmt Wünsche fürs ganze Deck entgegen. Er weiß immer, welche Folie du gerade ansiehst.
- Ein Klick auf ein Element der Folie zeigt eine KI-Leiste. Dein Wunsch geht dann mit Folie, Element und Text an die KI.
- Das Modell wählst du im Dropdown neben dem Eingabefeld. Es bestimmt auch, worüber der Chat läuft:
  - **Claude:** Opus 5.5 (Standard), Fable 5.1, Sonnet 5 oder Haiku 4.5, über den API-Key oder Claude Code.
  - **Vibe:** die Modelle aus deiner Vibe-Einstellung.
  - **Codex:** die Modelle aus dessen Katalog.

  Angeboten wird nur, was installiert ist. Steht das gespeicherte Modell nicht mehr zur Verfügung, nimmt Deckwerk das erste verfügbare. Die Wahl gilt ab der nächsten Nachricht und bleibt gespeichert. Wechselst du den Anbieter, beginnt ein neues Gespräch; das Deck bleibt. Vibe und Codex antworten spürbar langsamer als Claude.
- Unter den Notizen schreibt „Schreiben lassen“ die Sprechernotizen, „Überarbeiten“ verbessert vorhandene. Daneben steht die geschätzte Sprechzeit.
- **✦ in der KI-Leiste:** Aufträge fürs ganze Deck mit einem Klick: übersetzen (9 Sprachen), Sprechernotizen für alle Folien, auf 5–15 Folien kürzen, als E-Mail, Newsletter oder Blogartikel zusammenfassen (Antwort im Chat, das Deck bleibt) und Rechtschreibung prüfen. Ist ein Element gewählt, auch ein Textfeld des Layouts, stehen oben dessen Text-Aktionen: kürzer, ausführlicher, einfacher, förmlicher, lockerer, korrigieren, übersetzen. Bei freien Textelementen gibt es dieselben Aktionen in der Objektleiste unter „Umschreiben“. „Rückgängig“ in der Blase nimmt die ganze KI-Runde zurück.
- **Brand-Kit:** Im Look-Dialog „Als Standard speichern“ legt Farben, Schriften und Logo (auch eines für dunklen Grund) in `~/Deckwerk/brand.json` ab. Jedes Deck, das die KI neu anlegt, bekommt die Marke automatisch, das Logo steht auf Titel- und Schlussfolie, bei A4 auf Seite 1 (kein Wasserzeichen auf jeder Folie); „Standard übernehmen“ wendet sie auf ein bestehendes Deck an.
- **Hausstil:** Sag „merk dir …“, und die KI trägt die Vorliebe in `~/Deckwerk/hausstil.md` ein. Die Datei gilt für jedes künftige Deck und lässt sich von Hand bearbeiten.
- **Fotos:** Die KI nutzt zuerst deine Bilder aus `~/Deckwerk/assets`. Findet sie dort nichts Passendes und ist ein Unsplash-Key eingerichtet (Einstellungen → Bilder → Fotosuche oder `UNSPLASH_ACCESS_KEY`), sucht sie auf Unsplash und übernimmt den Bildnachweis in die Notizen.
- **KI-Bilder:** Die KI kann Bilder auch selbst erzeugen, mit `gpt-image-2` über [Mammouth](https://mammouth.ai) oder OpenAI, ohne Key auch über Codex mit deinem ChatGPT-Login (einmal `codex login`). Eingerichtet wird das unter Einstellungen → **Bilder**: Keys (verschlüsselt gespeichert), bevorzugter Anbieter und Modell, z. B. `gemini-3-pro-image-preview` bei Mammouth. Ohne Vorgabe nimmt die KI den ersten eingerichteten Anbieter in der Reihenfolge Mammouth, OpenAI, Codex; „mach das Bild mit Codex“ wählt gezielt. Alternativ gelten `MAMMOUTH_API_KEY`, `OPENAI_API_KEY` und `IMAGE_MODEL` aus der Umgebung. Die Bilder landen in `~/Deckwerk/assets`.

### Video-Schnitt

Häng ein Video an (MP4, MOV, M4V, WebM, MKV, OGV oder FLV) oder nenn einen Link, und schreib, was du brauchst. Den Schnitt bedient nur die KI, im Chat der App und über MCP in Claude Code, Codex und Vibe. Eine Folie im Layout „Videoclip“ ist ein Video aus Ausschnitten einer Quelle. Vier Abläufe:

- **Shorts und Reels (9:16)**, etwa „Mach drei Shorts daraus“: Die KI transkribiert das Video und wählt die 3–5 stärksten Momente (packender Einstieg, ohne Vorwissen verständlich, ein Bogen bis zur Pointe, ein abgeschlossener Gedanke am Ende). Sie sieht sich Standbilder an und baut je Short eine Folie mit Hook und Untertiteln. Der Zuschnitt sucht das Gesicht, bei mehreren Personen folgt er dem, der spricht; Folien und Gesten am Rand zeigt sie ganz auf unscharfem Grund. Füllsätze schneidet sie heraus (Jump Cuts). Export: je Short eine MP4.
- **Ganzes Video kürzen (16:9)**, etwa „Kürz den Vortrag auf das Wesentliche“: eine Folie mit allen behaltenen Ausschnitten in Reihenfolge (bis 100), Versprecher und Abschweifungen fallen weg, Sprechpausen werden kürzer. Export als eine MP4.
- **Highlights aus Streams (2–8 h)**: Die KI sucht zuerst die stärksten Momente aus Lautheit, Lachen und Jubel, Chat-Ausbrüchen und der „Meistgesehen“-Kurve von YouTube und transkribiert dann nur diese Fenster. Daraus werden Shorts, auf Wunsch zusätzlich ein Zusammenschnitt in 16:9.
- **Zusammenschnitt aus mehreren Quellen (16:9)**: je Quelle eine Clip-Folie, dazwischen ruhige Zwischentitel mit Abblende, auf Wunsch leise Hintergrundmusik. Export als eine MP4.

**Links:** Deckwerk lädt Videos über [yt-dlp](https://github.com/yt-dlp/yt-dlp) (YouTube, Twitch, Kick und viele andere Seiten) in bis zu 1080p, dazu Kapitel und bei Aufzeichnungen von Livestreams den Chat (Twitch über [TwitchDownloader](https://github.com/lay295/TwitchDownloader)). Laufende Livestreams gehen erst nach dem Ende. Lade nur Material, an dem du die Rechte hast oder das frei lizenziert ist.

**Musik:** Die KI sucht freie Musik auf [Openverse](https://openverse.org), nur CC0, Public Domain und CC BY. Die Musik läuft leise unter dem ganzen Video und wird unter Sprache automatisch leiser. Den Nachweis schreibt die KI in die Notizen der letzten Folie; bei CC BY gehört er auch in die Beschreibung des fertigen Videos.

**Lokal:** Das Video wird nicht kopiert, Deckwerk verweist nur auf die Datei (Downloads per Link landen in `~/Deckwerk/assets`). Die Spracherkennung läuft lokal: Parakeet-TDT-0.6B-v3 über sherpa-onnx für 25 europäische Sprachen, für andere Sprachen Whisper (die KI gibt dafür die Sprache an, etwa bei Japanisch, Türkisch oder Arabisch). Beim ersten Mal lädt Deckwerk das Modell (rund 670 MB) nach `~/Deckwerk/models`. Die Erkennung dauert auf schnellen Rechnern etwa die halbe Videolänge, auf langsamen auch länger als das Video; bei langen Videos transkribiert die KI deshalb nur die Stellen, die sie braucht. Der Export in 1080p läuft auf langsamen Rechnern mit rund 10 Bildern pro Sekunde, ein einstündiges Video braucht dort 2–3 Stunden. ffmpeg nimmt Deckwerk aus dem System, sonst lädt es ein statisches ffmpeg bei Bedarf nach.

Die Kriterien für gute Momente und die Idee dahinter stammen von [BridgeClip](https://github.com/bridge-mind/bridgeclip) (MIT, © 2026 BridgeMind).

### Folien frei gestalten

Oben rechts öffnen **Einfügen** (Elemente), **Anpassen** (Folie oder ausgewähltes Element) und **Look** (Theme und Schriften) die Seitenleiste.

- **Auswählen und bewegen:** Ein Klick wählt ein Element aus. Umschalt-Klick oder ein aufgezogener Rahmen wählt mehrere. Beim Ziehen rasten Elemente an Folienrand, Mitte, anderen Elementen und eigenen Hilfslinien ein (Alt: frei, Umschalt: nur waagrecht oder senkrecht).
- **Skalieren und drehen:** 8 Griffe skalieren, der runde Griff dreht (Umschalt: in 15°-Schritten). Doppelklick oder Enter bearbeitet Text.
- **Elemente:**
  - Text-Presets, 8 Formen, Icon-Suche, Fotos (Upload, Suche, Zwischenablage, Drag & Drop), Diagramme mit Datentabelle, QR-Codes, Video und Audio.
  - „Bild erzeugen“: Beschreibung eingeben, Quer, Hoch oder Quadrat wählen, die KI-Bild-Funktion aus Einstellungen → Bilder erzeugt es. „Deine Bilder“ zeigt die neuesten Bilder aus `~/Deckwerk/assets` zum Wiederverwenden.
  - Aus dem Layout-Katalog lassen sich fertige Folien einfügen.
- **Bilder:**
  - Doppelklick schneidet zu.
  - „Hintergrund entfernen“ stellt frei. Das läuft lokal; beim ersten Mal wird ein Modell (224 MB) geladen, und die Berechnung braucht rund 2 GB freien Arbeitsspeicher.
  - Duotone, Schwarzweiß, Kreis-Maske und Spiegeln.
- **Layout-Folien:**
  - „Andere Gestaltung“ wechselt Variante, Komposition und Ton.
  - „In freie Elemente umwandeln“ macht jeden Text, jede Form und jedes Bild der Folie frei verschiebbar.
  - „Farben dieser Folie“ ersetzt eine Farbe überall auf der Folie.
- **Kontextmenü (Rechtsklick):** Ebenen, Gruppen, Sperren, sichere Ränder einblenden und eigene Hilfslinien setzen.
- **Ebenen:** Unter „Anpassen“ listet „Ebenen“ alle freien Elemente der Folie, oberstes zuerst. Klick wählt, Ziehen ändert die Reihenfolge (Gruppen bleiben zusammen), das Schloss sperrt.
- **Suchen & Ersetzen:** Strg+F sucht im ganzen Deck (Folientexte, freie Texte, Notizen, Titel), Strg+H ersetzt. Bild- und Linkadressen bleiben unberührt; Stellen, die danach zu lang oder leer für ihr Feld wären, überspringt Deckwerk.
- **Rechtschreibprüfung:** Deutsch und Englisch, Vorschläge per Rechtsklick. Abschalten unter Einstellungen → Allgemein. Unter Linux und Windows lädt Deckwerk die Wörterbücher einmalig von einem Google-Server.
- **Folien ausblenden:** Rechtsklick im Filmstreifen oder „Ausblenden“ in der Übersicht. Ausgeblendete Folien überspringt Deckwerk beim Präsentieren und im PDF-, Bild-, Word- und Handout-Export; in der PowerPoint-Datei sind sie enthalten, aber ausgeblendet.
- **Formate:** „Exportieren“ → „Anderes Format …“ rechnet das Deck auf ein anderes Format um oder legt Kopien in weiteren Formaten an: 16:9, 4:3, Quadrat, 4:5, Story 9:16, A4 hoch oder quer, Link-Vorschau. Freie Elemente wandern mit, Layouts ordnen sich neu an: Hoch- und Quadratformate stapeln Bild und Text, Social-Formate setzen größere Schrift, A4 kleinere. Der Lint rechnet je Format mit eigenen Grenzen (Social bis 30, A4 bis 350 Wörter je Seite). Für A4 gibt es die Layouts „Fließtext“, „Angebot“, „Flyer“ (Foto oben, Vollbild oder typografisch, mit Handlungsaufforderung und QR-Code) und „Flyer-Rückseite“ (Programm, Eckdaten, eine Handlung mit QR-Code, Impressum). Der QR-Code braucht eine vollständige URL (`https://`, `mailto:`, `tel:`). Layouts mit festem Format erscheinen in den Folienvorlagen nur im passenden Format; auf dem Startbildschirm gibt es den Beispiel-Chip „Flyer für ein Sommerfest“, und die Vorlagen-Galerie enthält den Flyer. Der Lint warnt bei Fotos, die für den Druck zu klein sind (unter 250 ppi).

### Speichern und Versionen

Deckwerk speichert automatisch. Jede Änderung, ob von dir oder von der KI, landet nach 1,5 Sekunden in `~/Deckwerk/<titel>/deck.json`. Schließt du das Fenster oder öffnest ein anderes Deck, sichert Deckwerk offene Änderungen vorher, auch einen Text, den du gerade tippst.

Höchstens alle 10 Minuten legt Deckwerk den vorigen Stand unter `<deck>/versions/` ab, pro Deck bis zu 100 Versionen. „Exportieren“ → „Versionsverlauf …“ zeigt sie nach Tagen sortiert mit Vorschau der Folien; „Diese Version wiederherstellen“ macht sie wieder zum Deck, und der bisherige Stand wandert selbst in die Versionen.

Ein Doppelklick auf eine `deck.json` im Dateimanager öffnet sie in Deckwerk, auch wenn die App schon läuft. Ein Deck-Ordner lässt sich weitergeben: Bildpfade relativ zur deck.json (`assets/foto.jpg`) löst Deckwerk beim Öffnen auf.

### Cloud-Sync

Unter Einstellungen → Cloud (oder per Klick auf die Wolke in der Kopfleiste) wählst du deinen Dienst aus einer Liste:

- **Im Browser anmelden:** Nextcloud (nur die Adresse) und MagentaCLOUD. Deckwerk bekommt dabei ein eigenes App-Passwort und sieht dein Passwort nie.
- **Über die App auf diesem Rechner:** Dropbox, OneDrive, Google Drive und iCloud Drive haben kein WebDAV. Deckwerk legt dann den Ordner `Deckwerk` in deren Sync-Ordner (wird meist von selbst gefunden), die App des Dienstes lädt ihn hoch.
- **Mit Nutzername und Passwort:** GMX, WEB.DE, STRATO und IONOS HiDrive, pCloud, Koofr, Infomaniak kDrive, Hetzner Storage Box, ownCloud und Synology. Die Adresse ist hinterlegt, ein Link führt zur Anleitung für das App-Passwort. Jeder andere WebDAV-Dienst geht mit eigener Adresse. Deckwerk spiegelt dann `~/Deckwerk` in den Ordner `Deckwerk/` deiner Cloud: beim Start, 5 Sekunden nach jedem Speichern, beim Zurückkehren ins Fenster und über „Jetzt abgleichen“. Die Wolke zeigt den Zustand: abgeglichen, läuft gerade, Fehler oder noch nicht eingerichtet. Die Android-App gleicht mit demselben Ordner ab.

Versionen, Exporte und das Freisteller-Modell bleiben lokal. Hast du dasselbe Deck auf zwei Geräten geändert, gewinnt die neuere Fassung. Die ältere landet in `versions/` und lässt sich von dort wiederherstellen. Gelöschte Dateien werden auch auf den anderen Geräten gelöscht.

### Präsentieren

**Präsentieren** (oder F5) startet mit der ersten Folie, Umschalt+F5 mit der aktuellen. Mit zweitem Bildschirm erscheint das Publikumsfenster dort, und du siehst die Referentenansicht mit Notizen, Uhr, Sprechzeit und der nächsten Folie.

- L schaltet den Laserpointer, D den Stift, E löscht die Striche. Beides sieht auch das Publikum.
- **Morph** setzt du pro Folie unter Anpassen → „Übergang zu dieser Folie“. Gleicher Text, dasselbe Foto oder derselbe Platz im Layout wandern dann von der vorigen Folie herüber, etwa ein Agenda-Punkt in den Kapiteltitel. Das läuft beim Präsentieren und in PowerPoint.
- **Animationen wie in Canva:** Freie Elemente können einblenden, aufsteigen, schwenken, treiben, ploppen, purzeln, stampfen, von der Grundlinie aufsteigen oder wischen. Text kann wie mit der Schreibmaschine oder Wort für Wort erscheinen, und „Atmen“ lässt einen Knopf dauerhaft pulsieren. Für Schwenken, Treiben, Wischen und Aufsteigen wählst du die Richtung per Pfeil, für alle das Tempo. Für ganze Folien gibt es dazu Schwenken, Pop, Wort für Wort und den Foto-Zoom (das Foto zoomt langsam heran), als Übergänge Slide, Stapel und Farbwischen. Unter Look → Animation setzt du wie bei Canvas Magic Animate einen Stil für alle Folien: Keine, Ruhig, Standard oder Lebhaft. Beim Wählen spielt die Animation einmal zur Vorschau; in PowerPoint laufen alle mit (Purzeln als Zoom, Farbwischen als Wischen).
- **Handy als Fernbedienung** (in der Referentenansicht) zeigt einen QR-Code. Das Handy blättert dann und zeigt die Notizen. Handy und Rechner müssen im selben WLAN sein.

### Exportieren

**Exportieren** erzeugt PowerPoint, Word (eine Seite pro Folie: Text in bearbeitbaren Textfeldern mit eingebetteten Schriften, Fotos, Flächen und Diagramme als Hintergrundbild), PDF, PNG (eine Datei pro Folie), ein ZIP (alle Bilder plus PDF) oder ein Handout (Markdown mit Notizen). Bei Nicht-16:9 steht das Format im Dateinamen (`-4x5`, `-a4`). Die Dateien landen im Ordner des Decks.

Bei A4-Decks gibt es zusätzlich „PDF für die Druckerei …“. Die Datei (`…-druck.pdf`) hat Endformat plus Beschnitt (Standard 3 mm, wählbar je Druckerei: Flyeralarm 1 mm, Saxoprint/Onlineprinters 2 mm, WIRmachenDRUCK 3 mm), keine Schnittmarken; randabfallende Fotos laufen gespiegelt in den Beschnitt. Das Endformat A3, A4 oder A5 ist wählbar; A4-Seiten werden verlustfrei skaliert. Die Farben bleiben RGB: Die genannten Druckereien wandeln selbst nach CMYK, leuchtende Akzente werden dabei etwas matter (print24 verlangt CMYK). Bei großer Auflage lohnt ein Probedruck. Die Seitenzahl muss zur Bestellung passen (1 oder 2), lösche nicht gewählte Entwürfe vorher.

In der PowerPoint-Datei sind Texte, Formen, Bilder, Diagramme, Video und Audio native, editierbare Objekte. Animationen und Folienübergänge kommen mit, die Schriften der Premium-Themes sind eingebettet. PDF und PNG entsprechen der Vorschau pixelgenau.

### Tastenkürzel

| Wo | Taste | Wirkung |
|---|---|---|
| Editor | Strg+Z / Strg+Y | Rückgängig / Wiederholen |
| | Strg+S | Sofort speichern |
| | / | Wunsch an die KI eingeben |
| | ← / → | Vorige / nächste Folie |
| | F5, Umschalt+F5 | Präsentieren ab Folie 1 / ab der aktuellen Folie |
| Folie | Pfeile (Umschalt: 10 px) | Auswahl verschieben |
| | Entf | Löschen |
| | Strg+C / X / V / D | Kopieren, Ausschneiden, Einfügen, Duplizieren |
| | Strg+A, Strg+L | Alles auswählen, Sperren |
| | Strg+] / Strg+[ (mit Umschalt: ganz) | Nach vorne / nach hinten |
| | Strg+G, Strg+Umschalt+G | Gruppieren, Gruppe lösen |
| | Esc | Auswahl aufheben |
| Präsentation | Leertaste, →, Bild ↓ | Weiter |
| | ←, Bild ↑ | Zurück |
| | L / D / E | Laser / Stift / Striche löschen |
| | P | Referentenansicht umschalten |
| | Esc | Beenden |

## Deckwerk in Claude Code, Vibe und Codex

Der Installer trägt Deckwerk als MCP-Server in Claude Code ein, für alle Projekte. Die Einrichtung in der App kann das ebenfalls, für jedes gefundene CLI mit einem Klick. Von Hand geht das so:

```sh
claude mcp add -s user deckwerk -- ~/deckwerk/scripts/deckwerk.sh --mcp
```

Sind Vibe oder Codex installiert, trägt der Installer Deckwerk dort ebenfalls ein. Von Hand:

```sh
vibe mcp add --transport stdio --command ~/deckwerk/scripts/deckwerk.sh --arg=--mcp --startup-timeout-sec 90 --tool-timeout-sec 300 deckwerk
codex mcp add deckwerk -- ~/deckwerk/scripts/deckwerk.sh --mcp   # danach in ~/.codex/config.toml unter [mcp_servers.deckwerk]: startup_timeout_sec = 90
```

Vibe und Codex starten den Server ohne Bildschirm. Deckwerk rendert dann headless, deshalb dauert der erste Aufruf etwas länger.

Claude Code und Codex bekommen dazu den Skill `deckwerk` (`skills/deckwerk/SKILL.md`, abgelegt unter `~/.claude/skills/` bzw. `~/.codex/skills/`). Er bringt dem Agenten den Arbeitsablauf bei: Guide lesen, Briefing und Quellmaterial, Storyline, Look, Bildplan, Folien in Etappen mit Korrekturen nach dem Lint, Prüfrunden, Speichern und Export. Der Agent lädt ihn von selbst, sobald du eine Präsentation willst. Nach einem Update zeigt die Einrichtung den Schritt wieder als offen; ein Klick erneuert den Skill.

Claude Code bekommt dieselben Werkzeuge wie der Chat in der App: Deck anlegen, Folien bauen und prüfen, Looks vorschlagen, Fotos und Icons suchen, rendern und exportieren. Dazu kommen `get_deck`, `save_deck` und `open_deck`. Layout-Katalog und Design-Guide stehen in den Server-Anweisungen. Decks landen unter `~/Deckwerk/<titel>/deck.json`; die Umgebungsvariable `DECKWERK_HOME` wählt einen anderen Ordner.

Bei einer Quellcode-Installation nutzt der Server den vorhandenen Build und baut nicht neu, weil Claude Code nur 30 Sekunden auf ihn wartet. Nach einem Update dort deshalb einmal die App starten oder `npm run build` ausführen. Die fertige App braucht das nicht.

## Wo liegt was

| Pfad | Inhalt |
|---|---|
| `~/Deckwerk/<titel>/deck.json` | Deine Decks; Exporte landen daneben |
| `~/Deckwerk/<titel>/versions/` | Frühere Stände eines Decks |
| `~/Deckwerk/assets/` | Eigene, eingefügte und freigestellte Bilder, geladene Fotos |
| `~/Deckwerk/hausstil.md` | Hausstil für alle Decks |
| `~/Deckwerk/brand.json` | Brand-Kit (Farben, Schriften, Logo) für neue Decks |
| `~/Deckwerk/models/` | Modelle für Freisteller und Spracherkennung, bei Bedarf ffmpeg |
| `~/Deckwerk/.sync-state.json` | Stand des letzten Cloud-Abgleichs |
| `~/.config/deckwerk/` | Einstellungen und API-Key, verschlüsselt über den System-Schlüsselbund |

## Datenschutz und Sicherheit

- **Was an die KI geht:** Deine Wünsche, der Inhalt des Decks, angehängtes Quellmaterial (auch Vorschauen deiner Bilder) und gerenderte Folienbilder gehen an den Anbieter deines KI-Zugangs: Anthropic (API oder Claude Code), OpenAI (Codex) oder Mistral (Vibe). Bei einer Web-Recherche ruft die KI Webseiten ab.
- **Chat über Claude Code, Codex oder Vibe:** Das CLI bekommt nur die Deckwerk-Werkzeuge (dazu Web-Recherche), keine Shell und keine Dateiwerkzeuge. Ein präpariertes Quelldokument kann so keine Befehle auf deinem Rechner ausführen.
- **Cloud-Sync:** Nur wenn du ihn einrichtest. Decks und Bilder gehen dann an deinen WebDAV-Server. Das App-Passwort liegt verschlüsselt über den System-Schlüsselbund. Nutze eine `https://`-Adresse.
- **Was lokal bleibt:** Freisteller, Rendering und Export laufen auf deinem Rechner.
- **Fremde Decks:** Decks binden nur Bilder (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP), Video, Audio und Schriften ein. Andere Dateien verweigert Deckwerk. So kann ein fremdes Deck keine privaten Dateien in einen Export ziehen.
- **App-Fenster:** Alle Fenster laufen in der Chromium-Sandbox und können nicht auf fremde Seiten wechseln.
- **Handy-Fernbedienung:** Sie läuft nur, solange du sie in der Referentenansicht geöffnet hast. Die Verbindung geht über HTTP mit einem zufälligen Token und ist unverschlüsselt, in fremden WLANs also mitlesbar.

## Grenzen

- Die PowerPoint-Dateien sind gegen LibreOffice geprüft. Die Abnahme in echtem PowerPoint (Umbrüche, Animationen, eingebettete Schriften) steht noch aus.
- Diagramme sind in PowerPoint nativ und sehen deshalb leicht anders aus als in der Vorschau.
- Text-Deckkraft kommt nicht in PowerPoint an, und Gruppen landen dort als Einzelobjekte.
- Gedrehte Bilder lassen sich erst nach Drehung auf 0° zuschneiden.
- Es gibt keine Echtzeit-Zusammenarbeit.
- Windows läuft nur über WSL.
- Codex ist mit einem angemeldeten Konto noch nicht getestet, weder als Chat noch als MCP-Client. Getestet sind Einrichtung und Modellliste.

## Entwicklung

```sh
npm ci
npm run dev            # App mit Hot Reload
npm run typecheck
npm run build
```

Unter Wayland hängt Chromiums PDF-Druck, deshalb starten alle Skripte Electron mit `--ozone-platform=x11`.

| Befehl | Zweck |
|---|---|
| `npm run render examples/pitch.json` | Deck rendern → `exports/<slug>.pptx`, `.docx`, `.pdf`, `.zip`, `<slug>/NN.png` und Lint-Report |
| `npm run check:layouts` | Stresstest: jedes Layout × Variante × Beispiel × Theme (dauert rund eine Stunde) |
| `npm run dist:linux` | AppImage bauen → `dist/Deckwerk-x86_64.AppImage` |
| `npm run smoke` | KI-Werkzeuge und MCP-Server gegen eine Mock-Engine (ohne Electron, ohne API-Key) |
| `npm run mcp:e2e` | MCP-Server Ende-zu-Ende gegen die echte Engine; `E2E_HEADLESS=1` ohne Bildschirm wie Vibe und Codex, `E2E_APP=<AppRun>` gegen das Paket |
| `npm run smoke:claude` | App-Chat über Claude Code gegen eine Mock-Engine, samt Sperre für Shell und Dateien (braucht den Login, vier kleine Anfragen). `DECKWERK_CLI=vibe` oder `codex` testet die anderen CLIs |
| `npm run verify:pptx -- exports/<slug>.pptx` | PPTX-Treue-Check gegen LibreOffice (siehe unten) |
| `npm run open [-- exports/<datei>]` | Export in LibreOffice Impress öffnen (ohne Argument: neueste PPTX) |

Kleinere Selbsttests stehen als Kommentar im Kopf der jeweiligen Datei unter `scripts/check-*.ts`, `scripts/story-check.ts` und `scripts/validate-examples.ts`.

GitHub Actions prüft jeden Push (`.github/workflows/ci.yml`): Typecheck, Smoke-Tests, Selbsttests, Rendern und Export, den MCP-Server mit und ohne Bildschirm, das AppImage und den Installer mit dieser App. Ein Tag `v*` baut das AppImage und hängt es an den Release (`release.yml`). Der Installer holt immer den neuesten Release.

### Aufbau

- `src/main/`: Electron-Main.
  - `engine.ts`, `render.ts`: Rendern in einem Offscreen-Chromium.
  - `export-pptx.ts`: PowerPoint-Export.
  - `export-docx.ts`: Word-Export.
  - `agent.ts`: Chat über die API.
  - `claude-agent.ts`: Chat über Claude Code.
  - `tools.ts`: KI-Werkzeuge.
  - `mcp.ts`: MCP-Server.
  - `ipc.ts`: Brücke zur Oberfläche.
- `src/renderer/`: Oberfläche (React). `slide.tsx` rendert Folien, `ui/Stage.tsx` ist die Canvas, `ui/kit.tsx` enthält die UI-Bausteine.
- `src/shared/`: Datenmodell (`deck.ts`), Layouts und ihre Schemas, Themes, freie Elemente (`items.ts`), Design-Guide für die KI.
- `examples/`: Beispieldecks, zugleich die Vorlagen auf dem Startbildschirm.

Der Main-Prozess lädt Engine und IPC erst nach dem ersten Fenster, damit der Start schnell bleibt. Neue IPC-Kanäle laufen deshalb über den `invoke()`-Wrapper in `src/preload/index.ts`. Das Preload läuft in der Sandbox und darf nur `electron` importieren.

### Chat über Claude Code, Codex und Vibe

Der Chat läuft über die API oder über ein Agenten-CLI mit dessen Login: `claude -p`, `codex exec` oder `vibe -p`. Den Weg bestimmt das Modell-Dropdown: Claude-Modelle gehen über den API-Key (hat Vorrang) oder Claude Code, `vibe:<modell>` und `codex:<modell>` über das jeweilige CLI (`routeOf` in `src/shared/models.ts`, Liste über den IPC-Kanal `chat:models`). `src/main/claude-agent.ts` öffnet dafür einen MCP-Server auf `127.0.0.1`: zufälliger Port, Bearer-Token nie auf der Kommandozeile (für Claude Code in einer 0600-Datei, die beim Beenden gelöscht wird, für Codex und Vibe in einer Umgebungsvariable des Kindprozesses). So sieht die Live-Vorschau jede Änderung sofort. Der Prompt geht über stdin.

Jedes CLI bekommt nur die Deckwerk-Werkzeuge und die Web-Recherche:

- **Claude Code:** `--tools WebSearch,WebFetch`, `--strict-mcp-config`, ohne Hooks, Plugins und Skills aus deinen Einstellungen (`--setting-sources ""`). Folgenachrichten per `--resume`, Modell per `--model`.
- **Codex:** `--ignore-user-config` (weder deine MCP-Server noch Profile, der Login bleibt), `shell_tool`, `unified_exec` und `hooks` aus, `sandbox_mode="read-only"`, `approval_policy="never"`, Systemprompt als `developer_instructions`. Folgenachrichten per `exec resume`, Modell per `-c model=…` (Liste aus `codex debug models`). Nicht mit angemeldetem Codex getestet.
- **Vibe:** `VIBE_MCP_SERVERS` ersetzt deine MCP-Server, `--enabled-tools deckwerk_*` (plus `web_search`, `web_fetch`) sperrt alle anderen Werkzeuge, auch Shell und Dateien, `--auto-approve` gilt nur für die freigegebenen. Der Systemprompt steht vor der ersten Nachricht, weil Vibe eigene Prompts nur aus `VIBE_HOME` liest. Folgenachrichten per `--resume`; die dabei erneut ausgespielten Antworten filtert Deckwerk über ihre ID. Modell per `VIBE_ACTIVE_MODEL` (Liste aus Vibes `config.toml`), `--legacy-harness`, wenn die Vibe-Version es kennt: Sie bietet die Werkzeuge direkt an statt über eine Werkzeugsuche.

### PPTX-Treue-Check

PowerPoint bricht Text nur dann wie Chromium um, wenn Schriftmetriken und Boxbreiten passen. `scripts/verify-pptx.ts` prüft das ohne PowerPoint:

1. LibreOffice rendert die PPTX headless nach PDF, `pdftoppm` macht daraus PNGs (2560×1440, wie der eigene PNG-Export).
2. Pro Folie wird das LibreOffice-Bild mit dem Chromium-PNG verglichen: mittlerer Grauwert-Unterschied und Anteil deutlich veränderter Fläche. Beide Bilder werden dafür auf ein Viertel verkleinert, damit Antialiasing nicht zählt.
3. Für jede Textbox (`dw:<slot>`) werden in beiden Bildern die Texthöhe und der vertikale Versatz der ersten Zeile gemessen.
   - Weicht die Texthöhe um mehr als 0,6 × Schriftgröße ab, ist der Umbruch anders.
   - Tinte unter der Box, die nur LibreOffice hat, gilt als Überlauf.
   - Der Median des Versatzes je Schriftgröße kalibriert den Zeilenabstand im Export.
4. Das Ergebnis steht auf der Konsole und in `exports/verify/<slug>/report.json`, daneben die LibreOffice-Bilder (`lo-NN.png`).

Voraussetzungen sind `pdftoppm` (poppler) und LibreOffice, als `soffice` im PATH oder als User-Flatpak. Das Flatpak sieht `/tmp` nicht, deshalb nur Dateien unter `exports/` prüfen.

```sh
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.libreoffice.LibreOffice
```

Arial und Calibri ersetzt LibreOffice selbst durch die metrischen Zwillinge Liberation Sans und Carlito. Georgia fehlt; dafür Gelasio (metrisch kompatibel) als User-Font mit fontconfig-Alias einrichten:

```sh
mkdir -p ~/.local/share/fonts/gelasio ~/.config/fontconfig
curl -sSfL -o ~/.local/share/fonts/gelasio/Gelasio.ttf "https://github.com/google/fonts/raw/main/ofl/gelasio/Gelasio%5Bwght%5D.ttf"
curl -sSfL -o ~/.local/share/fonts/gelasio/Gelasio-Italic.ttf "https://github.com/google/fonts/raw/main/ofl/gelasio/Gelasio-Italic%5Bwght%5D.ttf"
cat > ~/.config/fontconfig/fonts.conf <<'XML'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <alias binding="same"><family>Georgia</family><prefer><family>Gelasio</family></prefer></alias>
</fontconfig>
XML
fc-cache -f ~/.local/share/fonts
flatpak run --command=fc-match org.libreoffice.LibreOffice Georgia   # → Gelasio
```

Ablauf:

```sh
npm run render examples/quartal.json
npm run verify:pptx -- exports/q3-update-vertrieb.pptx
```

Kalibriert werden damit `WRAP_SLACK` (Breitenreserve der Textboxen) und die Zeilenabstände in `src/main/export-pptx.ts`. Folien mit `!` sind meist Diagramm-Folien. LibreOffice ist nicht PowerPoint: Die endgültige Abnahme von Umbruch, Animationen und Morph bleibt echtes PowerPoint.

### Schriften in der PPTX

`src/main/embed-fonts.ts` wandelt TTF in unkomprimiertes EOT (`.fntdata`) um. Die Schrift trägt es in `ppt/presentation.xml` (`embeddedFontLst`, `embedTrueTypeFonts="1"`), in die Relationships und in die Content-Types ein. Die Premium-Themes betten so ihre TTFs aus `assets/fonts/` ein (geladen mit `npm run fonts:fetch`), eigene Schriften ebenso.

Randbedingungen:
- Nur statische TTF, keine variablen Fonts.
- Der Schriftname im Text muss exakt dem Familiennamen der Schrift entsprechen.
- `fsType` „restricted“ wird beim Einbetten ausmaskiert, deshalb muss die Lizenz der Schrift das Einbetten erlauben.

`npm run spike:fonts -- Regular.ttf [Bold.ttf]` baut eine Test-PPTX und prüft mit LibreOffice und `pdffonts`, ob die eingebettete Schrift benutzt wird. LibreOffice tut das. Die Abnahme in PowerPoint (Datei → Informationen → eingebettete Schriften, Anzeige ohne Reparatur) steht noch aus.

## Lizenz

Deckwerk steht unter der GNU Affero General Public License v3.0 (siehe `LICENSE`). Wer Deckwerk verändert weitergibt oder als Dienst im Netz betreibt, muss den Quellcode der veränderten Fassung offenlegen.

Mitgelieferte Schriften unter `assets/fonts/`: SIL Open Font License 1.1 (`OFL-*.txt`). Beispielfotos: Unsplash-Lizenz, Nachweise in `examples/assets/CREDITS.md` und `assets/samples/CREDITS.md`.

Bei Bedarf nachgeladen (Video-Schnitt): Spracherkennung Parakeet-TDT-0.6B-v3 von NVIDIA (CC-BY-4.0) über sherpa-onnx (Apache-2.0), Gesichtserkennung YuNet (MIT), Download per Link über yt-dlp (Unlicense) und TwitchDownloader (MIT).
