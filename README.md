# Deckwerk

KI-Präsentationsstudio als Desktop-App (Electron): Ein Satz genügt, Deckwerk schreibt die Storyline, baut die Folien, prüft jede einzelne als Bild und exportiert nach PowerPoint (editierbar), PDF und PNG. Den KI-Zugang liefert entweder dein Claude-Code-Login oder ein Anthropic-API-Key.

## Installation

Voraussetzungen: Git und Node.js 22 oder neuer. Läuft unter Linux und macOS, unter Windows in WSL.

**Per curl (ein Befehl):**

```sh
curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/install.sh | sh
```

Der Installer lädt Deckwerk nach `~/deckwerk`, installiert die Abhängigkeiten, baut die App, legt unter Linux einen Startmenü-Eintrag an und trägt Deckwerk als MCP-Server in Claude Code ein (falls `claude` installiert ist). Anderer Zielordner: `curl … | DECKWERK_DIR=~/apps/deckwerk sh`.

**Mit wget:** `wget -qO- https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/install.sh | sh`

**Aus einem Git-Checkout** (auch für private Repos, denn `raw.githubusercontent.com` liefert nur öffentliche):

```sh
git clone https://github.com/Bavarianator/deckwerk.git   # oder: gh repo clone Bavarianator/deckwerk
cd deckwerk && ./scripts/install.sh
```

**Von Hand:**

```sh
npm ci
npm run build          # danach starten mit ./scripts/deckwerk.sh
npm run dev            # oder: Entwicklungsmodus mit Hot Reload
```

**Aktualisieren:** den Installer erneut ausführen (holt den neuen Stand per `git pull` und baut neu).

**Entfernen:**

```sh
rm -rf ~/deckwerk ~/.local/share/applications/deckwerk.desktop
claude mcp remove -s user deckwerk
```

Deine Decks unter `~/Deckwerk` bleiben dabei erhalten.

## Skripte

| Befehl | Zweck |
|---|---|
| `npm run dev` | App im Entwicklungsmodus |
| `npm run render examples/pitch.json` | Deck rendern → `exports/<slug>.pptx`, `.pdf`, `<slug>/NN.png` + Lint-Report |
| `npm run check:layouts` | Stresstest: jedes Layout × Variante × Sample × Theme |
| `npm run smoke` | Agent-Tools und MCP-Server gegen eine Mock-Engine (ohne Electron, ohne API-Key) |
| `npm run mcp:e2e` | MCP-Server end-to-end gegen die echte Engine (startet `electron . --mcp`) |
| `npm run smoke:claude` | App-Chat über Claude Code gegen eine Mock-Engine (braucht Claude-Code-Login, drei kleine Anfragen) |
| `npm run verify:pptx -- exports/<slug>.pptx` | PPTX-Treue-Check gegen LibreOffice (siehe unten) |
| `npm run open [-- exports/<datei>]` | Export in LibreOffice Impress öffnen (ohne Argument: neueste PPTX) |

## MCP-Server für Claude Code

Claude Code bekommt dieselben Tools wie der Chat-Agent (`create_deck`, `add_slides`, `render_slides`, `export_deck` …) plus `get_deck`, `save_deck`, `open_deck`. Der Layout-Katalog und der Design-Guide liegen in den Server-Instructions. Decks landen unter `~/Deckwerk/<titel>/deck.json` (Umgebungsvariable `DECKWERK_HOME` überschreibt den Ordner). Registriert für alle Projekte:

```sh
claude mcp add -s user deckwerk -- ~/deckwerk/scripts/deckwerk.sh --mcp
```

`deckwerk.sh --mcp` startet `electron . --mcp` mit dem vorhandenen Build und baut nicht neu, weil Claude Code nur 30 s auf den Server wartet. Nach Code-Änderungen also einmal `npm run build` oder die App starten. Der Server beendet sich, wenn Claude Code stdin schließt.

## Chat ohne API-Key (über Claude Code)

Ohne gespeicherten Key und ohne `ANTHROPIC_API_KEY` läuft der Chat in der App über `claude -p` mit deinem Claude-Code-Login, und es erscheint kein Key-Dialog. Ein eingetragener Key hat Vorrang. `src/main/claude-agent.ts` öffnet dafür einen MCP-Server auf `127.0.0.1` (zufälliger Port, Bearer-Token in einer 0600-Datei unter `/tmp`), der die Tools des aktuellen App-Decks bereitstellt. So zeigt die Live-Vorschau jede Änderung sofort. Claude Code läuft dabei ohne eingebaute Tools, ohne Hooks, Plugins und Skills aus deinen Settings (`--setting-sources ""`) und mit dem Deckwerk-Systemprompt. Folgenachrichten setzen die Sitzung per `--resume` fort. Die Sitzungen erscheinen in Claude Code unter `~/Deckwerk`.

## Modellauswahl und Canvas

Im Chat (und auf dem Startbildschirm) wählt ein Dropdown das Modell: Opus 5.5 (Standard), Fable 5.1, Sonnet 5, Haiku 4.5. Die Liste steht in `src/shared/models.ts`. Die Wahl gilt ab der nächsten Nachricht, auch mitten im Gespräch, und bleibt gespeichert. Auf dem API-Weg bekommen Opus 5.5 und Fable 5.1 Effort `high`, Refusal-Fallback und `display: "updates"`, damit die Notizen zwischen Tool-Aufrufen im Chat erscheinen. Haiku 4.5 läuft mit `budget_tokens`. Über Claude Code geht das Modell per `--model` raus.

Die Canvas im Editor (`src/renderer/ui/Stage.tsx`): Ein Klick auf ein Element der Folie zeigt Rahmen, Namen und eine schwebende KI-Leiste. Der Wunsch geht mit Folie, Element und aktuellem Text an den Chat. Text bleibt direkt bearbeitbar. Überlaufende Elemente sind rot umrandet. Unten sitzt eine Leiste mit ‹ Folie › und Zoom (auch Strg + Mausrad, Klick auf die Prozentzahl wechselt zwischen 100 % und Einpassen). ←/→ blättern, Esc hebt die Auswahl auf. Jede Chat-Nachricht nennt der KI die gerade angezeigte Folie.

## Speichern, Vorlagen, Präsentieren

- Auto-Speichern: Jede Änderung, ob von dir oder von der KI, landet nach 1,5 s in `~/Deckwerk/<titel>/deck.json`. Offene Änderungen werden auch dann gesichert, wenn du das Fenster schließt oder ein anderes Deck öffnest, samt gerade bearbeitetem Folientext. Höchstens alle 10 Minuten legt Deckwerk den vorigen Stand unter `<deck>/versions/` ab; zurück geht es über „Deck öffnen“.
- Vorlagen: Der Startbildschirm zeigt kuratierte Decks aus `examples/`. Ein Klick öffnet eine Kopie, die Vorlage bleibt unverändert. Relative Bildpfade (`assets/foto.jpg`) löst Deckwerk beim Öffnen gegen den Ordner der deck.json auf, so lässt sich ein Deck-Ordner samt Bildern weitergeben.
- Präsentieren: Die Referentenansicht zeigt Notizen, Uhr und die nächste Folie. L schaltet den Laserpointer, D den Stift und E löscht die Striche; beides erscheint auch im Publikumsfenster. „Handy als Fernbedienung“ zeigt einen QR-Code: Das Handy blättert und zeigt die Notizen. Handy und Rechner müssen im selben WLAN sein. Die Verbindung läuft über HTTP mit Zufallstoken und ist unverschlüsselt, in fremden WLANs also mitlesbar.

## Frei gestalten wie in Canva

Neben den Layouts trägt jede Folie freie Elemente (`slide.items`: Text, Form, Bild, Icon, Diagramm mit x/y/w/h in px auf 1280×720, Drehung, Deckkraft, Auftritt) und optional einen eigenen Hintergrund (`slide.bg`: Farbe oder Bild). Das Layout `blank` ist eine leere Folie; „Leer beginnen“ auf dem Startbildschirm legt ein Deck damit an. Schema und Fabriken: `src/shared/items.ts`.

- Canvas (`ui/Stage.tsx`): Klick wählt aus, Umschalt-Klick oder Rahmen aufziehen wählt mehrere. Ziehen verschiebt und rastet an Folienrand, Mitte und anderen Elementen ein (Alt: ohne Einrasten, Umschalt: nur waagrecht/senkrecht). 8 Griffe skalieren (Ecken bei Bild/Icon/Text proportional, Text-Ecken skalieren die Schrift), der runde Griff dreht (Umschalt: 15°). Doppelklick oder Enter bearbeitet Text. Tastatur: Pfeile (Umschalt: 10 px), Entf, Strg+C/X/V/D/A/L, Strg+]/[ (mit Umschalt: ganz nach vorne/hinten). Strg+V ohne kopierte Elemente fügt ein Bild aus der System-Zwischenablage ein. Bilddateien lassen sich auf die Folie ziehen. Rechtsklick öffnet das Kontextmenü.
- Elemente-Panel (`ui/Elements.tsx`): Text-Presets, 8 Formen, Icon-Suche (lucide), Foto-Upload und Fotosuche (eigene Bilder in `~/Deckwerk/assets`, sonst Unsplash mit `UNSPLASH_ACCESS_KEY`), Diagramme, Folienvorlagen aus dem Layout-Katalog. Klicken fügt mittig ein, Ziehen legt an der Mausposition ab.
- Element-Inspector (`ui/ItemInspector.tsx`): Sperren, Duplizieren, Löschen, Ausrichten (einzeln an der Folie, mehrere aneinander), Verteilen, Ebenen, Position/Größe/Drehung/Deckkraft, Auftritt beim Präsentieren. Dazu je nach Art Schrift, Größe, Stil und Farbe, Füllung mit Verlauf, Rahmen, Radius und Schatten, Bildlook (Duotone/Schwarzweiß), Kreis-Maske und Spiegeln sowie Diagrammtyp und Daten als Tabelle.
- Export: Freie Elemente nutzen dieselben `data-pptx`-Primitive wie die Layouts und landen als native, editierbare PowerPoint-Objekte in der PPTX (Formen als Preset-Shapes, Drehung, Spiegeln, Verlauf per XML-Patch, Auftritte als Animationen). PDF und PNG sind pixelgenau. Die KI kann `items`/`bg` über `add_slides`/`update_slide` setzen.
- Test: `npm run render examples/canva.json` (alle Elementarten).
- Layout-Folien lösen: „In freie Elemente umwandeln“ im Inspector macht alle Texte, Formen, Bilder und Icons einer Layout-Folie frei verschiebbar (Strg+Z macht es rückgängig). „Farben dieser Folie“ ersetzt eine Farbe überall auf der Folie, „Schrift aller Texte“ setzt eine Schrift für alle Texte. Über das Kontextmenü der Canvas lassen sich die sicheren Ränder einblenden und eigene Hilfslinien setzen, an denen Elemente einrasten.

- Formate (Magic Resize): `deck.size` (Standard 1280×720), Liste in `FORMATS` (src/shared/deck.ts), Umrechnung mit `resizeDeck()` (src/shared/items.ts). Freie Elemente wandern mit, Layouts ordnen sich neu an. PDF, PNG, PPTX und Canvas richten sich nach der Größe.
- Video und Audio: Elemente `video`/`audio` (Knöpfe im Elemente-Panel oder Datei auf die Folie ziehen). Beim Präsentieren spielen sie ab (automatisch, endlos, stumm wählbar). In der PPTX sind sie eingebettet, im PDF erscheint das Vorschaubild.
- Gruppen: Strg+G / Strg+Umschalt+G oder Kontextmenü. Ein Klick wählt die ganze Gruppe, ein Doppelklick ein Mitglied. Gruppen und Mehrfachauswahl skalieren gemeinsam über einen Rahmen.
- Zuschneiden: Doppelklick auf ein Bild (oder „Zuschneiden“ im Inspector). Griffe ändern den Ausschnitt, Ziehen verschiebt das Bild, Enter übernimmt, Esc verwirft. Als `item.crop` gespeichert und in der PPTX nativ zugeschnitten.
- Freisteller: „Hintergrund entfernen“ rechnet BiRefNet-lite (MIT) mit onnxruntime-node im Main-Prozess (`src/main/bg-remove.ts`). Das Modell (224 MB) lädt beim ersten Mal nach `~/Deckwerk/models`. Die Berechnung braucht ca. 2 GB Arbeitsspeicher; ist weniger als 2,5 GB frei, bricht sie mit einer Meldung ab (Schutz vor dem OOM-Killer).
- UI-Bausteine (`src/renderer/ui/kit.tsx`, `kit.css`, Design: Canvas „Deckwerk – UI-Bausteine“): `Select` als Drop-in für `<select>` (optional `data-swatch`, `data-hint`, `style` je Option; `className="ghost"` kompakt), `Switch`, `confirmDialog()` statt `window.confirm()`. `kit.css` stylt Häkchen, Optionsfelder, Regler, Zahlenfelder, Fokus und `data-tip`-Tooltips in der ganzen App.

Decks binden nur Bilder (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP), Video, Audio und Schriften ein. Andere Dateien verweigert Deckwerk, damit ein fremdes Deck keine privaten Dateien in einen Export zieht.

Grenzen: Text-Deckkraft wird nicht nach PowerPoint übertragen, Gruppen landen in der PPTX als Einzelobjekte, gedrehte Bilder lassen sich erst nach Drehung 0° zuschneiden, keine Echtzeit-Zusammenarbeit.

## PPTX-Treue-Check

PowerPoint bricht Text nur dann wie Chromium um, wenn Schriftmetriken und Boxbreiten passen. `scripts/verify-pptx.ts` prüft das ohne PowerPoint:

1. LibreOffice rendert unsere PPTX headless nach PDF, `pdftoppm` macht daraus PNGs (2560×1440, wie der eigene PNG-Export).
2. Pro Folie wird das LibreOffice-Bild mit unserem Chromium-PNG verglichen: mittlerer Grauwert-Unterschied und Anteil deutlich veränderter Fläche (auf 1/4 verkleinert, damit Antialiasing nicht zählt).
3. Aus der PPTX werden alle Textboxen (`dw:<slot>`) samt Schriftgröße gelesen. Für jede Box wird in beiden Bildern die Texthöhe (erste bis letzte Tinte-Zeile) und der vertikale Versatz der ersten Tinte-Zeile gemessen; Tinte im Streifen unter der Box, die nur LibreOffice hat, gilt als Überlauf. Abweichende Texthöhe (> 0,6 × Schriftgröße) = anderer Umbruch. Am Ende steht der Median des Versatzes je Schriftgröße, die Kalibrierzahl für den Zeilenabstand im Export.
4. Ergebnis auf der Konsole und als `exports/verify/<slug>/report.json`; die LibreOffice-Bilder liegen daneben (`lo-NN.png`).

Voraussetzungen: `pdftoppm` (poppler) und LibreOffice, entweder `soffice` im PATH oder als User-Flatpak:

```sh
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.libreoffice.LibreOffice
```

Schriften: Arial und Calibri ersetzt LibreOffice selbst durch die metrischen Zwillinge Liberation Sans und Carlito (im Flatpak enthalten). Georgia fehlt, deshalb Gelasio (metrisch kompatibel) als User-Font plus fontconfig-Alias einrichten. Das Flatpak sieht `~/.local/share/fonts` und `~/.config/fontconfig` automatisch:

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

Kalibriert werden damit `WRAP_SLACK` (Breitenreserve der Textboxen) und die Zeilenabstände in `src/main/export-pptx.ts`. Grenzen: Charts sind in der PPTX nativ und weichen vom Chart.js-Bild immer ab (Folien mit `!` sind meist Chart-Folien). LibreOffice ist nicht PowerPoint; die endgültige Abnahme von Umbruch, Animationen und Morph bleibt echtes PowerPoint.

## Spike: Schriften in die PPTX einbetten

`src/main/embed-fonts.ts` wandelt TTF in unkomprimiertes EOT (`.fntdata`) um und trägt die Schrift in `ppt/presentation.xml` (`embeddedFontLst`, `embedTrueTypeFonts="1"`), die Relationships und die Content-Types ein. `npm run spike:fonts -- Regular.ttf [Bold.ttf]` baut `out/spike-fonts.pptx` und prüft mit LibreOffice und `pdffonts`, ob die eingebettete Schrift wirklich benutzt wird.

Ergebnis (26.09.2026): LibreOffice rendert eine eingebettete Familie, die auf dem System nicht existiert, in Regular und Bold aus der PPTX. Die Abnahme in PowerPoint (Datei → Informationen → eingebettete Schriften, Anzeige ohne Reparatur) steht noch aus.

Randbedingungen: nur statische TTF (keine variablen Fonts), der `fontFace` im Text muss exakt dem Familiennamen der Schrift entsprechen, `fsType` „restricted“ wird beim Einbetten ausmaskiert, die Lizenz muss Einbettung erlauben. Für Premium-Themes liegen die TTFs dann unter `assets/fonts/` und werden nach `injectAnimations` per `embedFonts(buf, [{ family, regular, bold, serif }])` eingebettet.

## Lizenz

Deckwerk steht unter der GNU Affero General Public License v3.0 (siehe `LICENSE`). Wer Deckwerk verändert weitergibt oder als Dienst im Netz betreibt, muss den Quellcode der veränderten Fassung offenlegen.

Mitgelieferte Schriften unter `assets/fonts/`: SIL Open Font License 1.1 (`OFL-*.txt`). Beispielfotos: Unsplash-Lizenz, Nachweise in `examples/assets/CREDITS.md` und `assets/samples/CREDITS.md`.
