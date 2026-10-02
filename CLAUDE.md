# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Deckwerk ist eine Electron-App (React-Oberfläche), in der eine KI Präsentationen aus einem festen Layout-Katalog baut. Die Engine misst jede Folie, passt Schriftgrößen an, prüft per Lint und exportiert PPTX, PDF, PNG und Markdown. Code, Kommentare, Doku und UI-Texte sind deutsch; neue Texte ebenso.

## Befehle

```sh
npm ci
npm run dev                 # App mit Hot Reload
npm run typecheck           # tsc über das ganze Projekt
npm run smoke               # KI-Tools + MCP-Server gegen Mock-Engine (ohne Electron, ohne API-Key)
npm run render examples/pitch.json   # → exports/<slug>.pptx/.pdf/<slug>/NN.png + Lint-Report
npm run mcp:e2e             # MCP-Server gegen die echte Engine (E2E_HEADLESS=1: ohne Bildschirm)
npm run check:layouts       # Stresstest Layout × Variante × Beispiel × Theme, ~1 h; eingrenzen mit DW_THEMES=beratung,keynote
npm run smoke:claude        # App-Chat über echtes `claude -p` (kostet Anfragen); DECKWERK_CLI=codex|vibe
npm run verify:pptx -- exports/<slug>.pptx   # PPTX gegen LibreOffice-Rendering (README „PPTX-Treue-Check“)
npm run dist:linux          # AppImage
```

- Einzelne Selbsttests (`scripts/check-*.ts`, `story-check.ts`, `validate-examples.ts`, `agent-smoke.ts`) tragen ihren Aufruf als Kommentar in der ersten Zeile: mit esbuild bündeln, dann mit node ausführen. Wird `design-guide.md` mitgebündelt, braucht esbuild `--loader:.md=text`.
- Alle Skripte starten Electron mit `--ozone-platform=x11`, weil Chromiums PDF-Druck unter Wayland hängt.
- `electron-vite build` leert `out/`. Dort keine Logs oder Testbündel ablegen. Arbeiten andere Sessions parallel, baue und teste in einer Kopie im Scratchpad (`src/`, `examples/` kopieren, `node_modules` verlinken).
- CI (`.github/workflows/ci.yml`): typecheck, smoke, Selbsttests, render, mcp:e2e mit und ohne Bildschirm, AppImage-Größe, Installer.

## Architektur

**Datenmodell** (`src/shared/deck.ts`): Ein Deck ist `deck.json` mit Folien aus `layout` + `content`. `content` wird gegen das zod-Schema des Layouts geprüft (`src/shared/layouts.ts`, `layouts-extra.ts`). Dazu kommen optionale freie Elemente `items` (px auf 1280×720, `src/shared/items.ts`), Ton, Frame und Animation. Das Theme ist eine Katalog-ID oder ein eigenes `ThemeSpec`, das `resolveTheme` in `src/shared/themes.ts` mit Leitplanken (Kontrast, gedämpfter Grund) auflöst.

**Engine**: Den Vertrag `Engine` definiert `src/main/agent.ts`, implementiert ist er in `src/main/engine.ts`. `src/main/render.ts` hält versteckte Offscreen-Fenster (`index.html#render`, `#print`, `#overview`), die denselben React-Folien-Code wie die App ausführen. Gesteuert werden sie über `window.dw` aus `src/renderer/main.tsx`. Ein Render-Durchgang:
1. Autofit (`src/renderer/measure.ts`) geht die Typo-Skala `SCALE` stufenweise nach unten, bis kein `[data-fit]`-Container überläuft.
2. `extract()` liefert gemessene Elemente (`Measured.els`).
3. Darauf bauen Lint (`src/shared/lint.ts`) und der PPTX-Export (`src/main/export-pptx.ts`) auf. Text, Formen, Bilder und Diagramme werden nativ an die gemessenen Positionen gesetzt, der Rest kommt als Hintergrund-PNG (`dw.hideExportables`). `pptx-post.ts` patcht das XML für Animationen und Morph, `embed-fonts.ts` bettet TTF als EOT ein.

Snapshots tragen eine Markierungszeile mit Sequenznummer, weil `capturePage` sonst alte Frames liefert. Fotos sind CSS-Hintergründe; der Host wartet auf sie (`imagesLoaded`).

**Layouts**: Ein Layout besteht aus Schema + `when` + Varianten/Frames + `samples` (min/typ/max) in `src/shared/layouts*.ts` sowie aus der Komponente und dem CSS in `src/renderer/layouts*.tsx` und `slide.css`/`layouts-extra.css`.
- Text immer über `<T role=… slot=…>`, damit Autofit, Lint, Morph und die PPTX-Objektnamen (`dw:<slot>`) greifen.
- Die `samples` speisen den Stresstest und die Katalog-Vorschaubilder für die KI.
- Linien auf `data-pptx`-Boxen als `::before`: `border-top` wird in der PPTX zum Rahmen ringsum.
- Keine generischen Klassennamen in `slide.css`, sonst leaken UI-Klassen wie `.plain` in die Folien.

**KI-Werkzeuge** (`src/main/tools.ts`): `buildTools(ctx)` ist die einzige Definition. Sie ist SDK- und Electron-frei, damit die Smoke-Tests sie unter Node laufen lassen können. Drei Wege nutzen sie:
- `DeckAgent` (`src/main/agent.ts`): Anthropic-API, Tool-Runner, Systemprompt = `src/main/design-guide.md` (per `?raw`) + `buildCatalog()` + Hausstil `~/Deckwerk/hausstil.md`.
- `CliAgent` (`src/main/claude-agent.ts`): Chat über `claude -p`, `codex exec` oder `vibe -p` mit dem Login des Nutzers. Ein lokaler HTTP-MCP-Server mit Bearer-Token stellt die Tools bereit; Shell und Dateiwerkzeuge der CLIs sind gesperrt.
- `src/main/mcp.ts`: stdio-MCP-Server für externe Agenten (`electron . --mcp`), zusätzlich `get_deck`/`save_deck`/`open_deck`/`read_guide`. Claude Code kürzt MCP-Anweisungen nach rund 2 KB. Wichtige Regeln gehören deshalb auch in Tool-Beschreibungen und Tool-Ergebnisse.

**Skill** (`skills/deckwerk/SKILL.md`): Arbeitsablauf für Claude Code und Codex. Die Einrichtung (`setup:mcp` in `ipc.ts`) und `scripts/install.sh` legen ihn unter `~/.claude/skills/` bzw. `~/.codex/skills/` ab; „eingerichtet“ gilt nur, wenn er inhaltsgleich ist. Er ist per `asarUnpack` lesbar für den Installer. Ändert sich der Ablauf (Tools, Guide), den Skill mitpflegen.

Jedes ändernde Tool antwortet mit Autofit und Lint pro Folie; daran korrigiert sich die KI selbst. **Neues Tool → Anzahl in `scripts/agent-smoke.ts`, `mcp-smoke.ts` und `mcp-e2e.ts` anpassen.**

**Modellwahl** (`src/shared/models.ts`): Die gespeicherte Wahl ist eine Claude-ID oder `vibe:<alias>`/`codex:<slug>`; `routeOf` bestimmt daraus den Chat-Weg. Diese IDs nie durch `modelOf()` schicken, das macht daraus Opus.

**Main/Preload/Renderer**:
- `src/main/index.ts` lädt Engine und `ipc.ts` erst nach dem ersten Fenster (schneller Start).
- Neue IPC-Kanäle: Handler in `src/main/ipc.ts`, Aufruf über den `invoke()`-Wrapper in `src/preload/index.ts`. Das Preload läuft in der Sandbox und darf nur `electron` importieren.
- Alle Fenster sind sandboxed, Navigation ist gesperrt.
- `asset://` und der PPTX-Export laden nur Dateien, deren Endung auf `MEDIA_EXT` (`src/shared/deck.ts`) passt. Neue Medientypen dort ergänzen.

**Ablage und Einstellungen**:
- Decks liegen unter `~/Deckwerk/<titel>/deck.json`, alte Stände in `versions/`. Bilder liegen in `~/Deckwerk/assets/`.
- In Tests setzt `DECKWERK_HOME` das Deck-Verzeichnis um.
- Der Anthropic-Key liegt mit `safeStorage` verschlüsselt im userData.
- Gemeinsame Einstellungen für App, Entwicklung und MCP-Prozess liegen unter `appData/deckwerk/`, weil sich das userData zwischen diesen Wegen unterscheidet. Dazu gehören `setup-done` und `image-settings.bin` (Bild-KI: Mammouth/OpenAI-Key, Anbieter, Modell).
- Weitere Schlüssel kommen aus der Umgebung: `UNSPLASH_ACCESS_KEY`, `MAMMOUTH_API_KEY`, `OPENAI_API_KEY`, `IMAGE_MODEL`.

## Gestaltungskurs

Der Nutzer lehnt den „KI-Look“ ab. Gestaltet wird zurückhaltend: flach, linksbündig, eine Akzentfarbe, keine Kästen, Blobs, Verläufe oder Icon-Kacheln als Standard. Canva-Deko (Sticker, Masken, Motive, Texteffekte) gibt es nur auf ausdrücklichen Wunsch. Leitlinien für die KI stehen in `src/main/design-guide.md` §6, Hintergrund in `CANVA-VERGLEICH.md`. Neue Stil-Hebel für Themes sind kleine Enums mit nur guten Optionen. Sie müssen in `themeFromSpec`, im `themeSpec` in `tools.ts` und im Guide auftauchen.

## Zusammenarbeit im Repo

- Oft arbeiten mehrere Claude-Sessions gleichzeitig und uncommittet in diesem Checkout.
- Vor Änderungen an fremden Baustellen `git status` und `git diff` ansehen und gezielt editieren statt Dateien neu zu schreiben.
- Commits nur auf Wunsch und mit expliziter Dateiliste.
- macOS lebt im Fork `deckwerk-macos`, der per `macify.mjs` an Ankertexten patcht (z. B. `findCli`). Plattformabhängige Stellen nur mit Rücksicht darauf ändern.
- Laufende Test-Instanzen über ihren `--remote-debugging-port` beenden, nicht per `pkill -f`.
- AppImages nie nach `/tmp` entpacken: Läuft das tmpfs voll, entstehen still 0-Byte-Dateien.
