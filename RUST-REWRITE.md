# Deckwerk in Rust: Plan für eine native App (Deckwerk + Deckwerk Pro)

Stand 17.10.2026. Ausgewertet wurden Deckwerk `f2bcddc` (Branch `feat/mensch-statt-ki`, das ist der neueste Stand) und Deckwerk Pro `307a4b5` (`main`). Grundlage sind neun Recherchen zu Main-Prozess, Shared/Renderer, Tests/CI, Pro, Video/Podcast, Plattformen, Export-Vertrag, Oberfläche sowie Pro-Interna/KI. Dazu kommen eigene Prüfungen: `cargo search`/`cargo info` und Quellcode von krilla, parley, vello_cpu, Slint und iced im Cargo-Registry. Alle Zeilenangaben beziehen sich auf diese Stände.

**Umfang:** nur Deckwerk und Deckwerk Pro. Android, iOS, Cloud, die Website (Astro) und das Promo-Video (Remotion) bleiben außen vor. Die Forks `deckwerk-macos` und `deckwerk-windows` fallen weg, weil der neue Code beide Plattformen über `cfg(target_os)` selbst abdeckt.

**Ziel:** eine native Desktop-App in Rust für Linux, macOS und Windows, ohne Electron, ohne Chromium und ohne Webview. Sie soll alles können, was Deckwerk und Pro heute können. Folien, Exporte, KI-Werkzeuge, MCP, Video-Schnitt, Podcast und die Pro-Timeline laufen dann auf einem Kern. Und sie soll messbar besser funktionieren: schneller, sparsamer, pixelgleich zwischen Vorschau und Export, ohne die bekannten Workarounds.

---

## 0. Inhalt

1. Kurzfassung
2. Ausgangslage in Zahlen
3. Zielarchitektur
4. Rendern ohne Browser (das Kernproblem und seine Lösung)
5. Modul-Mapping: jede Datei → Crate, Funktionsabgleich
6. Export-Spezifikation (PPTX, DOCX, PDF, PNG, Druck)
7. Was gefixt werden muss
8. Was besser funktionieren soll
9. Crate-Auswahl mit Versionen
10. Kompatibilität und Verträge
11. Teststrategie
12. Phasenplan
13. Risiken und offene Entscheidungen
14. Anhang: Quellen und Zahlen

---

## 1. Kurzfassung

**Acht Entscheidungen**

| # | Entscheidung | Begründung in einem Satz |
|---|---|---|
| 1 | **Eigene Folien-Engine `dw-scene`** mit taffy (Flex/Grid) + parley (Text) + hypher (Silbentrennung) | Die Folien nutzen nur zahmes CSS (§4.1), und ein eigener Layouter macht Messung, Vorschau, PNG und PDF identisch und schnell. |
| 2 | **Ausgaben aus einer Szene:** vello (Editor, GPU), vello_cpu (PNG), krilla (PDF), eigene OOXML-Generatoren (PPTX/DOCX) | Ein Szenengraph ersetzt DOM, `capturePage`, `printToPDF`, pptxgenjs und alle Regex-Patches. |
| 3 | **PDF/X-4 in CMYK ohne Ghostscript:** krilla (CMYK + ICC + TrimBox/BleedBox im Code belegt) + lcms2 + OutputIntent | Externe gs-Abhängigkeit ≥ 10.05 entfällt, der Farbauftrag wird exakt aus der Szene berechnet. |
| 4 | **Native GUI mit Slint 1.18** (`renderer-vello`, `unstable-wgpu-30`, AccessKit), iced 0.14 als Ausweichweg | Slint teilt sich den Linebender-Stack (vello, fontique) und bringt Barrierefreiheit mit. |
| 5 | **Video/Audio nativ:** gstreamer-rs für Wiedergabe, cpal für Mix/Pegel, ffmpeg-CLI weiter für Export | Bewährter Exportweg bleibt, die Vorschau läuft ohne `<video>`/WebAudio. |
| 6 | **Ein Engine-Daemon `dw-daemon`** für App, MCP und CLI | Behebt doppelte Engines (je 1,3–1,5 GB ASR-Modell), Races und Jobs, die nur im Prozess existieren. |
| 7 | **Editionen statt Fork:** Cargo-Feature `pro` + `Edition` | Pro und Deckwerk driften heute auseinander (54 Pro-Dateien, ~5 500 Zeilen). |
| 8 | **Strangler-Migration:** Kern zuerst per napi-rs in Electron, abgesichert durch Differenztests; Folien-Engine gegen Chromium-Referenzen; Slint-App zuletzt | Jede Phase liefert lauffähige Software, nichts wird blind ersetzt. |

**Bleibt außerhalb von Rust:** ffmpeg und ffprobe, yt-dlp, TwitchDownloaderCLI, die ONNX-Modelle (laufen über Rust-Bindings), die CLIs claude/codex/vibe, `design-guide.md`, die SKILL.md-Dateien und (optional) poppler für PDF-Quellen.

**Phasen:** P0 Spikes → P1 Kern per napi → P2 Folien-Engine → P3 Exporte → P4 Daemon/KI/MCP → P5 Medien/Video/Podcast/Timeline → P6 Slint-App + Editionen → P7 Electron abschalten (§12).

**Top-Risiken:** Rich-Text-Bearbeitung direkt auf dem Canvas, mehr als 41 Layouts originalgetreu nachbauen, Diagramm-Optik ohne chart.js, Feature-Stopp während der Migration (§13).

---

## 2. Ausgangslage in Zahlen

### 2.1 Deckwerk (`f2bcddc`)

| Bereich | Umfang |
|---|---|
| `src/` gesamt | ~25 000 Zeilen TS/TSX/CSS |
| `src/main/` (Electron-Main) | 39 Dateien, ~7 800 Zeilen; größte: `tools.ts` 1 364, `ipc.ts` 782, `engine.ts` 402 |
| `src/shared/` (reine Logik) | 24 Dateien, ~4 430 Zeilen |
| `src/renderer/` (Folien) | `slide.tsx` 745, `layouts.tsx` 484, `layouts-extra.tsx` 878, `measure.ts` 289, `slide.css` 426, `layouts-extra.css` 467 |
| `src/renderer/ui/` (Oberfläche) | 44 TS/TSX-Dateien (davon 8 Einstellungen), ~6 600 Zeilen TSX + ~1 240 Zeilen CSS |
| Layouts | 41 (15 in `layouts.ts`, 26 in `layouts-extra.ts`) |
| Themes | 20 statische (9 Katalog, 11 Legacy) + `custom` + `+brand` |
| IPC | 72 `invoke`-Kanäle, 10 Events Main → Renderer |
| KI-Werkzeuge | 25 (App-Chat), 27 im MCP-Server (23 ohne die App-Chat-Werkzeuge `plan_storyline`/`ask_user`, plus `read_guide`, `get_deck`, `save_deck`, `open_deck`) |
| Skripte/Selbsttests | 48 Dateien in `scripts/` |
| Abhängigkeiten | Electron 44, React 19, zod 4, culori, pptxgenjs 4, jszip, chart.js, lucide-react, qrcode, onnxruntime-node, sherpa-onnx-node, @anthropic-ai/sdk, @modelcontextprotocol/sdk |

### 2.2 Deckwerk Pro (`307a4b5`)

Pro ist eine **Obermenge** von Deckwerk: Jede Basis-Datei existiert auch in Pro. Hinzu kommen 54 eigene Dateien mit ~5 460 Zeilen:

- **Mehrspur-Timeline** („Schnittplatz wie Resolve“): `shared/timeline.ts`, `timeline-edit.ts`, `timeline-from-clips.ts`, `layouts-timeline.ts`, `grade.ts`; `main/timeline-ffmpeg.ts`, `export-timeline.ts`, `timeline-media.ts`, `export-xmeml.ts`, `export-xmeml-tl.ts`; 23 UI-Dateien unter `renderer/ui/timeline/` (Schnitt, Farbe, Ton, Ausgabe, Mixer, Farbräder, Scopes, Medienpool).
- **KI-Routing:** `main/router.ts` (Haiku/Claude/Codex/Vibe), `main/guide-modules.ts` (Guide modular, Kernprompt ~15k statt 75 KB).
- **Office:** `main/potx.ts` (Firmenvorlage), `main/xlsx-link.ts` (Excel-Verknüpfung für Diagramme), `main/print-pdf.ts` (PDF/X-4 CMYK via Ghostscript, Farbauftrag).
- **Arbeitsbereiche:** `main/clients.ts` (Kunden mit eigenem Brand-Kit und Hausstil), Brand-Lock (`shared/deck.ts:42`, `shared/lint.ts:82`).
- **Handy-Offload:** `main/phone.ts`, `main/phone-ffmpeg.ts` (ASR und ffmpeg per adb auf einem Android-Handy).
- **Layouts:** Gantt (`shared/layouts-pro.ts`), Stream-Paket (`stream-screen`, `panel` 320×160), `shared/layout-switch.ts`.
- **UI:** ThemeEditor, VideoTools, ContentForm (Formular aus Zod-Schema), DeckSheet, LintPanel, AccentPicker.
- **Werkzeuge:** 27 im App-Chat, davon nur in Pro `read_guide` (in `tools.ts`) und `edit_timeline`. Im MCP-Server 28 (25 ohne `plan_storyline`/`ask_user`, plus `get_deck`, `save_deck`, `open_deck`).
- **Selbsttests:** 72 Skripte statt 48, u. a. check-timeline-*, check-grade, check-mixer, check-print, check-xlsx, check-xmeml*, check-router, check-guide-modules, check-potx, check-brand-lock, check-tac.
- **Identität:** `shared/app-id.ts` (Name, ID, Datenordner `~/DeckwerkPro`, Repo).

### 2.3 Drift zwischen den Ständen (warum ein Kern nötig ist)

- Stark geänderte gemeinsame Dateien in Pro: `tools.ts` +270/−61, `ipc.ts` +192/−36, `export-video.ts` +243/−57, `Deckvid.tsx` +176/−16, `engine.ts` +97/−25, `video.ts` +91/−13, `agent.ts` +67/−47, `sherpa.ts` +60/−19.
- Der Video-Branch `feat/video-schnitt` ist eine ältere Teilmenge der Basis. Der Podcast-Branch `feat/podcast-aktuell` (17.10.) ist der neueste Stand für Video und Podcast und bringt `router.ts`, `phone*.ts` und `guide-modules.ts` ebenfalls mit. Router und Handy existieren also in drei Kopien.
- `shared/video.ts` liegt in drei Fassungen vor (218 / 283 / Pro), `Deckvid.tsx` ebenfalls (524 / 678 / 688 Zeilen).
- macOS (0.1.3) und Windows (0.1.0, ohne Commit) werden per Textpatch (`macify.mjs`, `winify.mjs`) aus der Linux-Fassung erzeugt. Windows fehlt dabei die gesamte Video- und Sync-Strecke.

**Folge:** Jede Änderung muss heute in bis zu vier Ständen nachgezogen werden. Der Rewrite ist die Gelegenheit, das auf **einen** Kern mit Editionen und Plattform-`cfg` zurückzuführen.

---

## 3. Zielarchitektur

### 3.1 Überblick

```
                         ┌────────────────────────────────────────────────┐
                         │                 dw-app (Slint)                 │
                         │ Start · Editor/Stage · Inspector · Präsentation│
                         │ Deckvid · Clip-Cutter · Podcast · Timeline(Pro)│
                         │ Einstellungen · Referentenansicht · Fernbed.   │
                         └───────────────┬────────────────────────────────┘
                                         │ typisierte Commands + Events (lokal: In-Process;
                                         │ optional Unix-Socket/Named Pipe zum Daemon)
┌──────────────┐   stdio/HTTP   ┌────────▼────────────────────────────────────────────┐
│ Claude Code, │◄──────────────►│                    dw-daemon                         │
│ Codex, Vibe  │      MCP       │ Deck-Zustand · Job-Queue (persistent, abbrechbar) ·  │
│ (extern)     │                │ Sperren · Fortschritt · ein ASR-Worker · ein Export  │
└──────────────┘                └───┬───────────┬───────────┬───────────┬──────────────┘
                                    │           │           │           │
       ┌────────────────────────────▼──┐  ┌─────▼─────┐ ┌───▼──────┐ ┌──▼─────────────┐
       │ KI: dw-tools · dw-agent ·     │  │ dw-scene  │ │ Export   │ │ Medien          │
       │ dw-cli-agent · dw-router ·    │  │ Layout +  │ │ dw-pptx  │ │ dw-media(ffmpeg)│
       │ dw-guide · dw-mcp (rmcp)      │  │ Autofit + │ │ dw-docx  │ │ dw-video        │
       └───────────────┬───────────────┘  │ Szene     │ │ dw-pdf   │ │ dw-podcast      │
                       │                  └─────┬─────┘ │ dw-raster│ │ dw-timeline(Pro)│
                       │                        │       │ dw-md    │ │ dw-asr · vision │
                       │                        │       └───┬──────┘ │ dw-phone (Pro)  │
                       │                        │           │        └──┬──────────────┘
       ┌───────────────▼────────────────────────▼───────────▼───────────▼──────────────┐
       │ Kern: dw-model (Deck, Items, Layout-Schemas) · dw-theme · dw-color · dw-lint ·│
       │ dw-typo · dw-merge · dw-fonts                                                  │
       ├───────────────────────────────────────────────────────────────────────────────┤
       │ Infrastruktur: dw-store (Ablage, Versionen, Einstellungen, keyring, Edition) · │
       │ dw-net (ein HTTP-Client, eine SSRF-Prüfung) · dw-sync · dw-remote · dw-update  │
       │ dw-office-in (potx, xlsx, Quellmaterial)                                       │
       └───────────────────────────────────────────────────────────────────────────────┘
                     dw-cli: render · check · mcp · verify · export  (ersetzt `electron . --render/--check/--mcp`)
```

### 3.2 Cargo-Workspace

```
deckwerk/
  Cargo.toml                 # [workspace], gemeinsame Versionen, Profile
  crates/
    dw-model/  dw-theme/  dw-color/  dw-lint/  dw-typo/  dw-merge/  dw-fonts/
    dw-scene/  dw-raster/  dw-pdf/  dw-pptx/  dw-docx/  dw-md/  dw-office-in/
    dw-media/  dw-video/  dw-podcast/  dw-timeline/  dw-asr/  dw-vision/  dw-phone/
    dw-tools/  dw-agent/  dw-cli-agent/  dw-router/  dw-guide/  dw-mcp/
    dw-store/  dw-net/  dw-sync/  dw-remote/  dw-update/
    dw-daemon/  dw-app/  dw-cli/
    dw-napi/                 # nur Migration: bindet Kern-Crates in die alte Electron-App
  assets/  examples/  skills/  fonts/  icc/
  tests/                     # Referenzen (Chromium-Messungen), Golden Files
  xtask/                     # Build, Bundles, Referenz-Erzeugung, Release
```

**Features:** `pro` (Timeline, Router, Guide-Module, Kunden, potx, xlsx, Druck-CMYK, Handy, Gantt/Stream-Layouts, `edit_timeline`, `read_guide`), `video`, `asr`, `gpu` (vello statt nur vello_cpu). Plattformen laufen über `cfg(target_os = "linux" | "macos" | "windows")` in einem Modul `dw-store::platform` (Pfade, CLI-Suche, Shell-Aufrufe, Hardware-Encoder, Spracherkennung-Threads).

### 3.3 Crates im Einzelnen

| Crate | Zweck | Quelle heute | Öffentliche API (Skizze) |
|---|---|---|---|
| **dw-model** | Datenmodell Deck/Slide/Item/El/Measured, Formate, Layout-Schemas und Samples, Validierung, JSON-Schema für Tools | `shared/deck.ts`, `items.ts`, `layouts.ts`, `layouts-extra.ts`, Pro `layouts-pro.ts`, `layouts-timeline.ts`, `video.ts` (Typen), Pro `timeline.ts` (Typen), `podcast` (Typen) | `Deck`, `Slide`, `Item`, `El`, `Measured`, `Format`, `LayoutId`, `LayoutDef { schema, when, variants, samples }`, `fn validate(&Deck) -> Result<(), Vec<Issue>>`, `fn tool_schema::<T>() -> serde_json::Value` (schemars) |
| **dw-theme** | Themes, `resolveTheme` mit Leitplanken, Tokens (`tune`), Brand-Kit, Schriftkatalog | `shared/themes.ts`, `themes-extra.ts`, `theme-refs.ts`, `font-catalog.ts`, `font-win.ts` | `fn resolve(&ThemeRef, Option<&BrandKit>) -> Theme`, `Theme { colors, fonts, scale, struktur }` |
| **dw-color** | OKLab, Mix, Chroma-Clamp, WCAG-Kontrast, CIEDE2000, `ensureContrast` | culori-Stellen in `themes.ts`, `lint.ts`, `theme-lint.ts` (heute 3× verteilt) | `Oklab`, `fn contrast(a,b)`, `fn ensure_contrast(fg,bg,min)`, `fn delta_e2000(a,b)` |
| **dw-lint** | Folien-, Deck-, Motion-, Theme-, Clip-, Klartext-, Brand-Lock-Lint; Suchen/Ersetzen; Serienbrief-CSV; Handout | `shared/lint.ts`, `theme-lint.ts`, `clip-lint.ts`, `klartext.ts`, `find.ts`, `merge.ts`, `handout.ts` | `fn lint_slide(&Slide, &Measured, &Profile) -> Vec<Finding>`, `fn lint_deck`, `fn lint_motion`, `fn lint_clip` |
| **dw-typo** | Feinsatz: Anführungszeichen, `pretty`, Tracking, hängende Interpunktion | `shared/typo.ts` | `fn typeset(&str) -> String`, `fn pretty_breaks(&Layout)` |
| **dw-merge** | Drei-Wege-Merge für gemeinsames Bearbeiten und Sync-Konflikte | **nur auf Branch `feat/gemeinsam-bearbeiten`** (`shared/merge.ts`, 142 Zeilen; nicht Teil der Referenzstände, vor P1 prüfen). Im Referenzstand ist `shared/merge.ts` (73) der Serienbrief → dw-lint | `fn merge3(base, mine, theirs) -> Merged` |
| **dw-fonts** | Schriften laden, Katalog, Webfonts-Cache, TTF-Parser, EOT (PPTX), odttf (DOCX), Namen reparieren | `main/embed-fonts.ts`, `main/webfonts.ts`, `scripts/repair-font-names.ts`, `scripts/curate-fonts.ts` | `FontDb` (fontique), `fn ttf_to_eot`, `fn obfuscate_odttf` |
| **dw-scene** | **Folien-Engine:** Layouts als Rust-Bäume, taffy-Layout, parley-Text, Autofit, Bild-Fit, Masken, Icons, QR, Diagramme, Frame/Deko, Formate; Ausgabe `Scene` + `Measured` | `renderer/slide.tsx`, `layouts.tsx`, `layouts-extra.tsx`, Pro `layouts-pro.tsx`, `measure.ts`, `slide.css`, `layouts-extra.css`, `shared/charts.ts`, `renderer/main.tsx` (window.dw) | `fn render(&Deck, idx, &RenderOpts) -> (Scene, Measured)`, `fn autofit(...)`, `Scene { nodes: Vec<Node> }` |
| **dw-raster** | Szene → Pixel (vello_cpu), Thumbnails, Kontaktbogen | `render.ts` (capturePage), `engine.ts:232-246` (nativeImage) | `fn png(&Scene, scale) -> Vec<u8>`, `fn overview(&[Scene])` |
| **dw-pdf** | Szene → PDF (krilla), Beschnitt/Trim/Bleed, Druck, PDF/X-4 CMYK, Farbauftrag, PDF/UA | `render.ts:117-148`, `pdf-boxes.ts`, Pro `print-pdf.ts` | `fn pdf(&[Scene], &PdfOpts)`, `fn print_pdf(..., PrintOptions { bleed, cmyk })` |
| **dw-pptx** | Eigener OOXML-Generator (quick-xml + zip) inkl. Animationen, Übergänge, Morph, Sektionen, Agenda-Links, native Diagramme, Tabellen, Masken, Verläufe, Effekte, Fonts | `export-pptx.ts`, `pptx-post.ts`, `animations.ts`, `patch-xml.ts`, `embed-fonts.ts` | `fn pptx(&Deck, &[Measured], &[BgPng]) -> Vec<u8>` |
| **dw-docx** | WordprocessingML mit Textfeldern über Hintergrundbild, Font-Obfuskation | `export-docx.ts` | `fn docx(...)` |
| **dw-md** | Markdown- und Handout-Export | `engine.ts:55-57`, `shared/handout.ts` | `fn markdown(&Deck)` |
| **dw-office-in** | Quellmaterial lesen (PDF, DOCX, PPTX, TXT, Bilder), Firmenvorlage .potx/.pptx/.thmx, Excel-Verknüpfung | `source-text.ts`, Pro `potx.ts`, Pro `xlsx-link.ts` | `fn read_source(path) -> Source`, `fn potx_theme`, `fn xlsx_range` (calamine) |
| **dw-media** | ffmpeg/ffprobe finden oder laden (SHA-256), Probe, Frames, PCM, Szenen, Stille, Peaks, Proxy, R128; yt-dlp; Twitch-Chat; Downloads; Dateisperren | `ffmpeg.ts`, `ytdlp.ts`, `twitch-chat.ts`, `download.ts`, `video-cache.ts`, Pro `timeline-media.ts` | `Ffmpeg::run(args, Cancel, Progress)`, `fn probe(path) -> Probe` (ffprobe JSON) |
| **dw-video** | Clip-Modell, Schnittlogik, ASS-Untertitel, Filtergraph, Effekte, Lautheit, Highlights, Retakes, Transkript-Suche | `shared/video.ts`, `highlights.ts`, `retakes.ts`, `transcript-search.ts`, `main/export-video.ts`, `video-fx.ts`, `music.ts`, `faces.ts` (Zuschnitt) | `fn clip_graph(&ClipContent, &Probe) -> FfGraph`, `fn highlights(&Signals)` |
| **dw-podcast** | Episode, Mehrspur, `autoCuts` (Binärsuche statt O(n²)), Kapitel, Export | `shared/podcast.ts`, `main/podcast.ts` (Podcast-Branch) | `fn auto_cuts(&Episode, &Transcript) -> Vec<Cut>`, `fn episode_graph` |
| **dw-timeline** (Pro) | Timeline-Modell, Edit-Ops, Lint, Grade/LUT, Abschnitte, Filtergraph, Export, xmeml/FCPXML | Pro `shared/timeline*.ts`, `grade.ts`, `main/timeline-ffmpeg.ts`, `export-timeline.ts`, `export-xmeml*.ts` | `fn apply_ops(&mut Timeline, &[TlOp])`, `fn sections`, `fn export(&Timeline, &Deliver, Cancel, Progress)` |
| **dw-asr** | Parakeet/Whisper/fc-de über sherpa-onnx, VAD, CED, Diarisierung, Mel per rustfft, Streaming | `sherpa.ts`, `sherpa-worker.ts`, `transcribe.ts` | `trait Recognizer`, `fn transcribe_stream(pcm_iter) -> impl Stream<Segment>` |
| **dw-vision** | YuNet-Gesichter, BiRefNet-Freisteller (ort), Bildskalierung/-dekodierung statt nativeImage | `faces.ts`, `bg-remove.ts` | `fn faces(&Frame)`, `fn remove_bg(&Image) -> Image` |
| **dw-phone** (Pro) | adb: Gerät, Push mit Stillstandswache, ASR und ffmpeg auf dem Handy | Pro `phone.ts`, `phone-ffmpeg.ts` | `Phone::detect()`, `fn run_remote_ffmpeg` |
| **dw-tools** | **Eine** Definition aller KI-Werkzeuge (Schema, Beschreibung, run), Bericht „Autofit + Lint je Folie“, Jobs | `tools.ts` (1 364 / Pro ~1 570 Zeilen) | `fn tools(&Ctx, Edition) -> Vec<Tool>`, `Tool { name, description, schema, run }` |
| **dw-agent** | Anthropic-/OpenAI-API (reqwest + SSE), Tool-Runner, Streaming, Web-Tools, Abbruch | `agent.ts` | `Agent::turn(msg, Cancel) -> impl Stream<AgentEvent>` |
| **dw-cli-agent** | Chat über `claude -p`, `codex exec`, `vibe -p` mit lokalem MCP-HTTP | `claude-agent.ts`, `accounts.ts` | `CliAgent::turn(...)` |
| **dw-router** (Pro, später alle) | Auftrag → Module, Modell, Effort; Regel-Router als Fallback | Pro `router.ts`, `shared/models.ts` | `fn route(&Task) -> Route` |
| **dw-guide** | Guide-Module, Kernprompt, Katalog, Hausstil | Pro `guide-modules.ts`, `design-guide.md`, `buildCatalog()` | `fn core_prompt(&Route) -> String`, `fn module(id)` |
| **dw-mcp** | MCP-Server stdio + Streamable HTTP (Bearer, zeitkonstant), Tools + `get/save/open_deck` | `mcp.ts`, HTTP-Teil von `claude-agent.ts` | `serve_stdio(Daemon)`, `serve_http(Daemon, Token)` |
| **dw-store** | Datenordner, Decks, Versionen, Assets, brand.json, hausstil.md, Kunden, Einstellungen, Secrets (keyring), Edition, Plattform, **ein** Slug, **eine** Pfadbasis | Teile von `ipc.ts`, `mcp.ts:157`, `engine.ts:31`, `image-settings.ts`, `accounts.ts`, Pro `clients.ts`, `shared/app-id.ts` | `Store::open(Edition)`, `fn save_deck(atomic, version)`, `Secrets::get/set` |
| **dw-net** | Ein HTTP-Client, **eine** SSRF-Prüfung (inkl. IPv6, 100.64/10, `.local`, Redirects manuell), Größen- und Zeitlimits, Unsplash/Openverse/Bild-KI | `download.ts`, `music.ts`, `tools.ts:1059-1306`, `webfonts.ts`, `update.ts` | `Net::get(url, Limits)`, `fn check_public(url)` |
| **dw-sync** | WebDAV-Spiegel, Ordner-Sync (Dropbox & Co.), Nextcloud-Login, Teilen/Live, Konflikte | `sync.ts`, `sync-folder.ts`, `shared/clouds.ts`, Teilen/Live aus Branch `feat/gemeinsam-bearbeiten` (`mitarbeit.ts`/`gemeinsam.ts`, ungeprüft) | `Sync::run(Cancel, Progress)` |
| **dw-remote** | Handy-Fernbedienung mit Pairing, TLS (rcgen) oder signiertem Token | `remote.ts` | `Remote::start() -> PairingQr` |
| **dw-update** | Update-Check und Installation mit Signaturprüfung | `update.ts`, `scripts/install.sh` | `fn check()`, `fn install(verified)` |
| **dw-daemon** | Engine-Prozess für App, MCP und CLI: Deck-Zustand, Job-Queue, Sperren, Fortschritt | `engine.ts`, Teile von `ipc.ts`, `mcp.ts`, `render.ts` (Queue) | `Daemon::command(Cmd) -> Reply`, `Daemon::events()` |
| **dw-app** | Slint-Oberfläche | `renderer/App.tsx`, `renderer/ui/**`, Pro `ui/timeline/**` | – |
| **dw-cli** | `deckwerk render\|check\|mcp\|verify\|export`, `--edition pro` | `index.ts` (CLI-Modi), `check.ts`, `scripts/verify-pptx.ts` | – |
| **dw-napi** | nur Migration: Kern-Crates als Node-Addon | – | `lintSlide`, `resolveTheme`, … |

### 3.4 Prozessmodell

- **Standard:** Die App bindet den Daemon **in-process** ein, ein Prozess für alles. Startet ein externer Agent `deckwerk mcp`, prüft der MCP-Prozess zuerst, ob schon ein Daemon läuft (Lockfile + Unix-Socket bzw. Named Pipe in `appData/deckwerk[-pro]/daemon.sock`). Läuft einer, wird er zum dünnen Proxy. Läuft keiner, startet er den Daemon headless.
- **Ergebnis:** Es gibt nie zwei Engines auf demselben Datenordner. Damit sind folgende Probleme erledigt: doppelte ASR-Worker (`sherpa.ts:110-112`, je 1,3–1,5 GB), parallele Exporte ohne Sperre (Pro `ipc.ts:240`, nur in der App), das Import-Race (`ytdlp.ts:133-140`), `save_deck` ohne Atomarität und ohne Version (Pro `mcp.ts:75`) und Jobs, die nach 600 s vergessen werden (Pro `tools.ts:460`).
- **Schwere Arbeit** (ASR, Freisteller, Export) läuft in Worker-Threads mit Speicherbudget (§8.3). Kindprozesse gibt es nur noch für externe Binaries (ffmpeg, yt-dlp, adb, CLIs), alle mit Timeout, Abbruch und Prozessgruppe (`cfg(unix)` setsid, `cfg(windows)` Job-Objekt).

---

## 4. Rendern ohne Browser

### 4.1 Das Problem heute

Heute baut Chromium jede Folie. `src/main/render.ts` hält versteckte Offscreen-Fenster (`#render`, `#print`, `#overview`). Diese führen den React-Folien-Code aus und werden per `executeJavaScript` mit eingebettetem `JSON.stringify(deck)` gesteuert (`render.ts:53,105,122,144`). Die eigentliche Arbeit in diesen Fenstern:

1. **Autofit** (`renderer/measure.ts:47-58`): 16 Kombinationen aus Titel- und Text-Stufe (`COMBOS`, `:7`), billigste zuerst. Jede Stufe setzt CSS-Variablen `--fs-<role>` aus `SCALE` (`shared/themes.ts:70`, z. B. `body: [24, 22, 20, 19]`) und den Formfaktor (`prof-social` = Breite/750, `prof-doc` = min(0,65, Breite/1221), nie unter 12 px; `measure.ts:12-15`). Danach prüft `findOverflow` (`:32-45`) drei Dinge: `scrollHeight > clientHeight` an `[data-fit]`, `scrollWidth > clientWidth` an Text und die Zeilenzahl gegen `data-maxlines`. Gezählt wird über `Range.getClientRects()` mit 3 px Toleranz (`:18-27`). Bis zu 16 vollständige DOM-Layouts pro Folie.
2. **Extraktion** (`measure.ts:156-280`): `getBoundingClientRect`, `getComputedStyle`, TreeWalker + Range für Zeilenumbrüche und Runs. Das Ergebnis ist `Measured { fit, els: El[] }` (`shared/deck.ts:321-393`).
3. **Bilder:** `capturePage` mit 1-px-Sequenzmarker, weil Chromium sonst alte Frames liefert. Bis zu 150 Versuche à 20 ms (`render.ts:59-91`). Das Fenster ist 721 bzw. 1442 px hoch, damit der Marker nicht im Bild liegt (`render.ts:17,104,121,143,156`).
4. **PDF:** `printToPDF` mit `preferCSSPageSize`. Die Papiergröße muss in ganzen pt angegeben werden, sonst skaliert Chromium den Inhalt auf bis zu 2/3 (`render.ts:127-139`). Trim- und Bleed-Box werden danach per Regex in die xref geflickt (`pdf-boxes.ts`).

**Folgen:** Rendern ist langsam (bis zu 16 DOM-Layouts, eine serielle Queue `render.ts:36-42`) und speicherhungrig (Chromium-Prozesse, OOM-Neustart `render.ts:23-28`). Es ist plattformabhängig (Wayland-Druck hängt, deshalb startet die App über XWayland neu: `index.ts:25-33`, `--ozone-platform=x11` in jedem Skript). Und es ist nicht von einem Webview zu trennen: Tauri/wry kennen weder `capturePage` noch `printToPDF`.

### 4.2 Die Lösung: `dw-scene`, eine eigene Folien-Engine

**Idee:** Die Layouts werden nicht mehr als HTML/CSS beschrieben, sondern als Rust-Bäume aus Boxen und Textblöcken. taffy berechnet Flex, Grid und Block. parley setzt den Text. Das Ergebnis ist **direkt** das, was heute erst mühsam aus dem DOM extrahiert wird: eine `Scene` (zum Malen) und `Measured { fit, els }` (für Lint, PPTX, DOCX). Messen und Malen sind dieselbe Datenstruktur, eine Extraktion entfällt.

```
Deck + Slide + Theme + Format
        │
        ▼
  Layout-Funktion (je Layout, Rust)  ──►  Node-Baum (Box/Text/Img/Icon/Chart/Table/Media/Line)
        │                                      │ Styles: taffy::Style + TextStyle (Rolle, Slot, Build, Fit)
        ▼                                      ▼
  Autofit-Schleife (16 COMBOS)  ──►  taffy::compute_layout + parley::Layout je Textknoten
        │                              (Overflow: Höhe an Fit-Knoten, Breite, Zeilen > maxlines)
        ▼
  Scene { nodes in Folienpixeln }  ──►  Measured { fit, els }  (identisch zum heutigen JSON)
        │
        ├──► vello (Editor, GPU)        ├──► vello_cpu (PNG, Thumbnails, Lint-Bilder)
        ├──► krilla (PDF, Druck, PDF/X) ├──► dw-pptx / dw-docx (nativ aus els, Hintergrund aus Szene ohne exportierbare Knoten)
```

#### 4.2.1 Was die Folien an CSS wirklich brauchen

Inventur über `slide.css` und `layouts-extra.css` (893 Zeilen; Pro `layouts-pro.css` 21 Zeilen):

| CSS-Merkmal | Häufigkeit | Rust-Abbildung |
|---|---|---|
| `display: flex`, `flex-direction`, `align-items`, `justify-content`, `flex-wrap` | 117× flex, 82× direction | taffy Flexbox |
| `display: grid`, `grid-template-columns` (u. a. `minmax(0,1fr)`, `max-content`, `%`, `px`, `repeat`) | 36× grid, 37 Templates | taffy Grid (fr, minmax, repeat, auto-flow, auto-rows) |
| `gap`, `column-gap`, `row-gap` | 143 / 11 / 3 | taffy `gap` |
| `position: absolute`, `inset`, `top/left/right/bottom` | 59× absolute (97× position) / 18 / ~180 | taffy `Position::Absolute` |
| `width/height/min/max-*`, `aspect-ratio` | ~260 / 3 | taffy `size`, `min_size`, `max_size`, `aspect_ratio` |
| `padding`, `margin` | ~120 | taffy |
| `overflow: hidden` (45×), `[data-fit]` | 45 | eigene Prüfung: Inhaltshöhe > Box |
| `::before`/`::after` (Linien, Eyebrow-Striche, Zähler) | 41 / 7 | **explizite Knoten** `Line`/`Rule` in der Layout-Funktion (kein Pseudo-Element nötig) |
| `border-*`, `border-radius`, `box-shadow` | ~30 / 47 / 5 | Szene: Rahmen, `RoundedRect`, Schatten (vello `BlurredRoundedRect`) |
| `background`, `background-image` (Verlauf), `background-position/size/repeat` | 94 / 3 / 26 | Füllung, `Gradient` (linear/radial), Bild-Fit |
| `opacity`, `visibility` | 9 / 4 | Alpha-Layer |
| `font-size` (über `--fs-*`), `line-height`, `letter-spacing`, `font-weight`, `text-align`, `text-transform` | 68 / 47 / 18 / 31 / 13 / 2 | parley `StyleProperty` (FontSize, LineHeight, LetterSpacing, FontWeight), `Alignment` (Start/Center/End/Justify), Großschreibung vorab |
| `font-variant-numeric: tabular-nums` | 9 | parley `FontFeature("tnum")` |
| `text-wrap: pretty` | 11 | eigener Feinsatz in `dw-typo` (letzte Zeile nicht einwortig, Abwägen über parley-Zeilenbrüche) |
| `white-space`, `overflow-wrap`, `word-break`, `hyphens: manual` | 12 / 2 / 1 / 1 | parley `TextWrapMode`, `OverflowWrap`, `WordBreak`; Silbentrennung über `hypher` (`de.bin`) als weiche Trennstellen |
| `mix-blend-mode` (screen, multiply) | 2 | vello `Mix::Screen/Multiply` (Duotone) |
| `filter: blur(90px)` | 1 | vello_cpu Filter-Layer (Hintergrund-Motiv) |
| `mask-image: radial-gradient(...)` | 1 | Masken-Layer mit radialem Verlauf |
| `transform: translate…`, `translate`, `scale` | 5 | Affine Transformation am Knoten |
| `counter-*`, `column-count`, `break-*` | 3 / 1 / 3 | Nummern in der Layout-Funktion; Spalten/Umbruch nur in `doc-text`/`offer` (A4), dort eigener Fließtext-Umbruch |
| `:has()` | 6 | wird zu Bedingungen in der Layout-Funktion (z. B. „Spalte hat Bild“) |
| Container-Queries, `vw`, `clamp()` | 0 | – |
| `calc(...)`, `var(--…)` | 99 / >400 | **Theme-Tokens** als Rust-Werte (`Theme.fs(role)`, `Theme.accent`, Abstände `--m-l` usw.); `calc` wird zu Rechnung |

**Fazit:** Es gibt kein CSS-Merkmal, das ohne Browser unlösbar wäre. Der Aufwand liegt in der **Fleißarbeit**, 41 + 4 Pro-Layouts mit Varianten, Frames und Formaten nachzubauen. Gegen diese Arbeit sichern die Referenztests (§4.6) ab.

#### 4.2.2 Layouts als Rust-Funktionen

Heute (`renderer/layouts.tsx:212`, `two-column`):

```tsx
<Frame><Header c={c} />
  <div className={`cols ${few ? 'few' : ''}`}>
    {['left','right'].map((k,i) => <Box slot={`_card.${k}`} className={...} build={i} fit>
      <T role="h2" slot={`${k}.heading`} build={i}>…</T> …
```

Künftig (Skizze, `dw-scene/src/layouts/two_column.rs`):

```rust
pub fn two_column(c: &TwoColumn, v: Variant, cx: &mut Cx) -> Node {
    // wenig Inhalt je Spalte: größer und luftiger (heute layouts.tsx:214-216)
    let few = cx.wide() && longest_word(&[&c.left.heading, &c.right.heading]) <= 20
        && [&c.left, &c.right].iter().all(|col| col.points.len() <= 3 && col.chars() <= 160);
    frame(cx, [
        header(c, cx),
        grid(cx.tokens.cols(few))                       // statt .cols / .cols.few in slide.css
            .gap(cx.tokens.gap_l)
            .children([("left", &c.left, 0), ("right", &c.right, 1)].map(|(k, col, i)| {
                card(cx, v, k == "right" && v == Variant::HighlightRight)
                    .slot(format!("_card.{k}")).build(i).fit()     // [data-fit]
                    .children([
                        text(Role::H2, &col.heading).slot(format!("{k}.heading")).build(i),
                        opt(col.text.as_ref(), |t| text(Role::Body, t).slot(format!("{k}.text")).build(i)),
                        points(&col.points, format!("{k}.points"), i),
                    ])
            })),
    ])
}
```

- **Gleiche Begriffe wie heute:** `role`, `slot`, `build`, `fit`, `maxlines`, `variants`, `frames`, `footer`. Damit bleiben die PPTX-Objektnamen `dw:<slot>` (§6.4), Lint und Morph unverändert.
- **Schema und Komponente liegen zusammen** in einem `LayoutDef`. Heute hängen sie nur über gleiche IDs zusammen (`shared/layouts.ts:7` ↔ `renderer/layouts.tsx:467`, `layouts-extra.tsx:873`), künftig prüft der Compiler das.
- **Formate:** `Cx` trägt `profile` (`slides`/`social`/`doc`), `tall`, `narrow`. Was heute der Block „Formate“ am Ende von `slide.css` macht (Spalten stapeln, Bilder nach oben), wird zur Verzweigung in `grid()`/`row()`-Helfern. Layouts mit `sizes` (Fließtext, Angebot) gelten weiter nur in diesen Formaten.
- **Tokens statt CSS-Variablen:** `Theme` liefert `fs(role, step, profile)`, Farben, Abstände (`m_l`, `m_r`, `m_t`, `measure`, `radius`) und Struktur-Hebel (Theme-Enums aus `themeFromSpec`). Das ersetzt `--fs-*`, `--accent`, `--m-l` usw.

#### 4.2.3 Text

- **Shaping und Umbruch:** parley 0.12 (HarfRust-Shaping, ICU4X-Segmentierung, BiDi) mit fontique für Schriftsuche und Fallback. Im Quellcode von parley 0.12 belegt sind `LetterSpacing`, `WordSpacing`, `LineHeight`, `Alignment` inkl. Blocksatz, `OverflowWrap`, `WordBreak`, `TextWrapMode`, `FontFeature`, `InlineBox` und `PlainEditor`.
- **Runs:** `rich()` (`slide.tsx:38-43`, Markdown-Auszug: fett, kursiv, Links) wird zu parley-Style-Spannen. Daraus entstehen dieselben `Run { text, bold, italic, underline, color, breakAfter, link, sizePx, trackingPx }` wie heute (`deck.ts:321`).
- **Zeilenzahl** direkt aus `Layout::lines()`. Die Toleranz-Heuristik (`measure.ts:18-27`, „höchste Kästen zuerst“) entfällt, weil parley echte Zeilen liefert.
- **Silbentrennung:** hypher 0.1.8 mit `de.bin`. Trennstellen werden als weiche Trennungen (U+00AD) vor dem Shaping eingefügt, nur bei `hyphens`-Rollen (heute `hyphens: manual`, also nur explizite). Standard bleibt **keine** automatische Trennung, wie heute.
- **Feinsatz** (`shared/typo.ts`, Commit 8bf276a): hängende „, `pretty`, Tracking. `pretty` wird ein eigener Schritt: parley-Umbruch → letzte Zeile prüfen → bei Bedarf Breite um 1–3 % verringern und neu brechen (die Chromium-Logik ist ebenso heuristisch).
- **Metrik-Zwillinge bleiben:** Arimo ↔ Arial, Carlito ↔ Calibri (`themes.ts:41`). Nur so brechen PPTX in PowerPoint und unsere Vorschau gleich um. `WRAP_SLACK = 0.015` (`export-pptx.ts:22-25`) bleibt als Kalibrierung für PowerPoint.
- **Win-Zeilenhöhe** (`shared/font-win.ts`, hhea vs. OS/2-Win) wird aus der Schrift gelesen (skrifa/ttf-parser), nicht mehr fest hinterlegt.

#### 4.2.4 Autofit (gleiche Logik, ohne DOM)

```rust
const COMBOS: [(u8, u8); 16] = /* (head, body), billigste zuerst, bei Gleichstand erst body kleiner (measure.ts:7) */;

pub fn autofit(slide: &Slide, cx: &mut Cx) -> (Scene, Fit) {
    for (head, body) in COMBOS {
        cx.set_steps(head, body);                     // ersetzt applySteps (measure.ts:9-16), inkl. Profil-Faktor und 12-px-Untergrenze
        let tree = build_layout(slide, cx);           // Layout-Funktion
        let laid = cx.layout(&tree);                  // taffy + parley
        if laid.overflow().is_empty() { return (laid.scene(), Fit::ok(head, body)) }
    }
    let laid = cx.layout(&build_layout(slide, cx.with_steps(3, 3)));
    (laid.scene(), Fit::failed(laid.overflow()))      // Overflow { slot, overPx, kind: height|width|lines }
}
```

- **Optimierung:** Textblöcke werden je `(Text, Style, Breite)` gecacht. Zwischen zwei Stufen ändert sich nur die Schriftgröße, also ist der zweite Durchlauf billig. Erwartet werden 1–5 ms pro Folie statt einiger hundert ms mit DOM und Chromium (Messung im P0-Spike).
- **Live im Editor:** Autofit läuft bei jeder Änderung für **die geänderte Folie** im Hintergrund-Thread und blockiert die UI nicht. Heute misst jede Deck-Änderung neu im UI-Thread (`slide.tsx:713-723`, useLayoutEffect ohne Deps, Befund §7.5).

#### 4.2.5 Bilder, Masken, Effekte

| Heute | Künftig |
|---|---|
| Fotos als CSS-Hintergrund, `imagesLoaded` wartet (`slide.tsx:560,722`) | Dekodierung vorab (image 0.25, zune-jpeg, image-webp, png), Cache nach Pfad + mtime; Fit `cover`/`contain` + `focus` exakt wie `containRect` (`export-pptx.ts:41-48`) |
| Maske als `clipPath: path()` mit ResizeObserver (`slide.tsx:103-116`) | Clip-Layer mit kurbo-Pfad aus `shapePath` (`slide.tsx:457-498` → `dw-scene::shapes`) |
| Duotone über zwei Blend-Divs (`slide.tsx:149-151`) | vello `Mix::Multiply` + `Mix::Screen` bzw. Farbmatrix im Bild-Shader |
| Filter (`adjustCss`, `slide.tsx:99-101`: Helligkeit, Kontrast, Sättigung, Blur) | vello_cpu Filter-Layer bzw. Vorberechnung am Bild (fast_image_resize + eigene Matrix) |
| Texteffekte shadow/lift/neon/hollow (`slide.tsx:521-529`) | Schatten-/Glow-Layer (Blur), Kontur über Glyphen-Outline (skrifa) |
| Verläufe (`Gradient { angle, stops }`, `deck.ts:351`) | peniko `Gradient::Linear/Radial` |
| Hintergrund-Motive (CSS-Blobs, `slide.tsx:290-300`) | Pfade + Blur-Layer, nur auf Wunsch (Design-Kurs) |

#### 4.2.6 Icons, QR, Diagramme, Tabellen, Linien

- **Icons:** lucide als statische SVGs (Crate `lucide-svg` oder eigener Build-Schritt aus lucide-static) → usvg 0.48 → Pfade in der Szene. Für PPTX gehen sie heute nur als 4×-PNG raus (`export-pptx.ts:215-217`). Künftig wird **zusätzlich** ein SVG mit PNG-Fallback geschrieben (`asvg:svgBlip`), wie es PowerPoint seit 2016 kann. Die Suche `search_icons` braucht den lucide-Katalog (Namen, Tags) als Daten, nicht `lucide-react` im Main-Prozess (`tools.ts:12,238-240`).
- **QR:** qrcode 0.14 liefert die Modulmatrix, heute `QRCode.create` (`slide.tsx:532-549`). Ruhezone 4 Module bleibt (Flyer-Regel).
- **Diagramme:** Heute rendert chart.js auf Canvas (`slide.tsx:174-280`, eigene Plugins `:202-263`), exportiert wird nativ als PPTX-Diagramm. Künftig zeichnet **`dw-scene::chart`** die sechs Typen `bar|hbar|stacked|waterfall|line|donut` mit `highlight` und `annotate` (`cagr|delta`) selbst als Pfade und Text. Daten und Farben kommen aus `shared/charts.ts` (`chartColors`). Vorteil: gleiche Schrift und gleicher Umbruch wie die Folie, keine Canvas-Unschärfe. Die Optik orientiert sich an der heutigen chart.js-Konfiguration (Balkenabstand 40 %, Linie 2,25 pt, Donut-Loch 62 %, Legende rechts, wie in `export-pptx.ts:52-89`).
- **Tabellen:** Spaltenbreiten `colW` und Zeilenhöhen `rowH` werden mit parley gemessen (heute `innerText` + DOM, `measure.ts:254-272`). `TABLE_PAD = 8 px` (`export-pptx.ts:93`) und Kopflinie 2 px / Körper 1 px bleiben.
- **Linien und Konnektoren** (`LineSvg`, `slide.tsx:503-518`): Pfade mit Pfeil, Spitze und Punkt, in PPTX wie heute `ShapeType.line` mit `ARROW`/`DASH`.

#### 4.2.7 Video und Audio auf der Folie

`MediaEl` (`deck.ts:370`) zeigt im Editor ein Poster (erstes Bild per ffmpeg, Cache). In der Präsentation spielt `dw-app` das Video über gstreamer in einer wgpu-Textur an der Box-Position ab. Das Layout `clip` bleibt ein Standbild (`?frame=`, `layouts-extra.tsx:588-610`).

### 4.3 Ausgabe-Backends aus derselben Szene

| Ziel | Crate | Was es kann (geprüft) | Ersetzt |
|---|---|---|---|
| Editor-Canvas | **vello 0.11** (GPU, wgpu 30) bzw. Slint `renderer-vello` | Pfade, Verläufe, Bilder, Glyphen, Clip/Blend-Layer | DOM + Chromium-Compositing |
| PNG, Thumbnails, Lint-Bilder, Kontaktbogen, Video-Standbilder | **vello_cpu 0.3** (Features `png`, `text`, `multithreading`) | `fill_path`, `stroke_path`, `glyph_run`, `push_clip_layer`, `push_blend_layer`, `push_mask_layer`, `push_filter_layer`, `BlurredRoundedRect` (alles im Quellcode belegt) | `capturePage` + Sequenzmarker + `nativeImage` |
| PDF (Bildschirm) | **krilla 0.8.2** | Font-Subsetting, echte kopierbare Texte (Glyphen kommen von parley; krillas eigenes Shaping über rustybuzz ist nur Feature `simple-text`), Bilder (png/jpeg/gif/webp), Verläufe, Transparenz, Masken, PDF/A-1…4, PDF/UA-1, `PageSettings::with_trim_box/with_bleed_box` | `printToPDF` + `pdf-boxes.ts` |
| Druck-PDF, PDF/X-4 CMYK (Pro) | krilla (CMYK-Farben `cmyk::Color`, `ICCProfile`) + **lcms2 6.2** + lopdf 0.45 | siehe §4.4 | Ghostscript ≥ 10.05 (`print-pdf.ts:12-19,62-77`) |
| PPTX | **dw-pptx** (quick-xml 0.42 + zip 9) | §6 | pptxgenjs + 4 Regex-Patch-Durchläufe |
| DOCX | **dw-docx** | §6.5 | handgeschriebenes WordprocessingML (bleibt in der Art, wird typisiert) |
| Hintergrundbild für PPTX/DOCX | vello_cpu, Szene **ohne** exportierbare Knoten | ersetzt `hideExportables` (`main.tsx:102-106`, `slide.css:14-17`) | – |

**Vorteil:** Vorschau, PNG und PDF teilen Layout, Glyphen und Umbrüche. Ein Unterschied zwischen „im Editor sieht es gut aus“ und „im PDF bricht es anders um“ ist ausgeschlossen. PPTX und DOCX bleiben die einzigen Ziele mit fremdem Umbruch (PowerPoint, Word), dort greifen weiter die Metrik-Zwillinge und `WRAP_SLACK`.

### 4.4 PDF/X-4 in CMYK ohne Ghostscript

Heute (Pro `print-pdf.ts`): Chromium erzeugt ein RGB-PDF. Dann wandelt Ghostscript ≥ 10.05 per `-sDEVICE=pdfwrite -dPDFX=4 -sColorConversionStrategy=CMYK` mit FOGRA39 um (`:62-77`), mit 10 Minuten Timeout. Der Farbauftrag (TAC) wird aus einem 50-dpi-PAM-Raster gemessen (`:28-45`), Fehler werden nur geloggt (`:80`). In der CI läuft gs < 10.05 (`ci.yml:23`), der Pfad wird dort also nur im Fehlerfall getestet.

Künftig:
1. **Farben** der Szene (RGB, sRGB) werden mit lcms2 über FOGRA39 (`assets/icc/`) nach CMYK umgerechnet, Rendering-Intent relativ farbmetrisch mit Tiefenkompensierung. Ergebnis sind krilla `cmyk::Color`.
2. **Bilder** werden per lcms2 zeilenweise nach CMYK gewandelt und als CMYK-JPEG/Flate eingebettet. Graustufen-Duotone bleibt als Separation/DeviceN, wenn sinnvoll.
3. **Text und Vektoren** bleiben Vektoren. Schwarzer Text wird auf reines K (0/0/0/100) gesetzt statt Vierfarbschwarz, das ist ein Druckerei-Standard und heute nicht steuerbar.
4. **OutputIntent:** krilla schreibt OutputIntents bisher nur für PDF/A (`configure/validate.rs:285`). Für PDF/X-4 wird nachträglich per lopdf ein `OutputIntent` mit `S /GTS_PDFX`, eingebettetem FOGRA39-Profil, `OutputConditionIdentifier` und `/GTS_PDFXVersion (PDF/X-4)` im Info-Dictionary ergänzt. Eine Alternative ist ein kleiner Upstream-Patch an krilla (Validator `PdfX4`).
5. **TrimBox/BleedBox** direkt über `PageSettings` (krilla `page.rs:120,136`), der Regex-Patch entfällt.
6. **Farbauftrag** wird exakt je Fläche aus den CMYK-Werten der Szene berechnet, ohne Raster. Bei Bildern dient das Maximum der Pixel-Summen. Warnung über 300 % wie heute (`tacWarning`), aber als Lint-Befund mit Slot statt Konsolenausgabe.
7. **Prüfung:** veraPDF prüft nur PDF/A und PDF/UA, **nicht PDF/X**. Für PDF/X-4 gibt es keinen freien Validator: In der CI prüfen gs (rendert in CMYK, `-sDEVICE=inkcov`), qpdf `--check` und ein Strukturtest (OutputIntent GTS_PDFX, GTS_PDFXVersion, kein DeviceRGB). Die Normprüfung macht ein kommerzielles Werkzeug (z. B. callas pdfToolbox) oder die Druckerei. Weitere Profile (PSO Coated v3/FOGRA51, in PRO.md gewünscht) kommen per ICC-Datei hinzu.

**Ergebnis:** Kein externes Binary, kein 10-Minuten-Timeout, keine stille Warnungslücke, gleiche Glyphen wie im Bildschirm-PDF. Auch PDF/X-1a (Roadmap PRO.md:82) ist so machbar (keine Transparenz → Flattening nötig, späterer Schritt).

### 4.5 Präsentation, Animationen, Morph

- Heute: Web Animations API (Presets `PresentScreen.tsx:18-28`, `ITEM_MOTION :43-58`), Übergänge per DOM (`:82-108`), Morph per `document.startViewTransition` (`:127-157, 251-264`).
- Künftig: Präsentation als **Szenen-Interpolation** in `dw-app`.
  - Builds und Item-Animationen werden als Parameter je Knoten berechnet (Alpha, Versatz, Skalierung, Wipe als Clip-Rechteck) und mit 60/120 Hz gemalt.
  - Übergänge (`slide|stack|color|push|dissolve|wipe|cover|split|circle|zoom`, `animations.ts:35-51`) laufen als zwei Szenen mit Blend/Clip.
  - **Morph:** `morphNames` (`deck.ts:299-315`) ordnet Knoten über Text, Bildquelle oder Slot zu. Zwischen den zugeordneten Knoten wird Box, Farbe, Schriftgröße und Radius interpoliert, Text überblendet. Das ist näher an PowerPoints Morph als View Transitions und unabhängig von der Plattform.
- Referentenansicht, Publikumsfenster (zweites Slint-Fenster statt `BrowserWindow #audience`, `ipc.ts:552-575`), Laser, Stift, Pause (B), Zahl + Enter bleiben funktionsgleich.

### 4.6 Referenztests: Chromium als Lehrer

Damit der Nachbau nicht nach Augenmaß passiert:

1. **Referenzen erzeugen (einmalig, mit der alten App):** Ein Skript `xtask refs` startet die heutige Electron-Engine und rendert jede Kombination aus `samples` (min/typ/max) × Varianten × Frames × Formate (16:9, 4:5, 9:16, 1:1, A4 hoch/quer, og, Visitenkarte, panel) × Themes. Gespeichert werden je Kombination `Measured`-JSON + PNG unter `tests/refs/<layout>/<variant>/<format>/<theme>/<sample>.{json,png}`. Die Infrastruktur von `check:layouts` (`src/main/check.ts`) liefert das fast schon.
2. **Vergleich in `cargo test`:**
   - Autofit-Stufe `(head, body)` gleich.
   - Je `El`: gleicher `kind`, gleicher `slot`, Box-Abweichung ≤ 2 px (Folienpixel).
   - Je Text: gleiche Zeilenzahl, gleiche Umbruchstellen (Toleranz: 1 abweichende Stelle bei `pretty`).
   - Pixel-Diff (z. B. mit dssim oder einer eigenen Metrik) unter einer Schwelle, mit Ausgabe einer Diff-PNG bei Fehlschlag.
3. **Fortschritt messbar:** Ein Bericht „x von y Kombinationen gleich“ je Layout. Ein Layout gilt als portiert, wenn alle Kombinationen grün sind.
4. **Danach** sind die Rust-Ausgaben die neue Wahrheit (insta-Snapshots), und die Referenzen können eingefroren werden.

### 4.7 Editor-Canvas (Stage) nativ

- Die Stage zeigt die vello-Szene der aktuellen Folie als wgpu-Textur in Slint, mit Zoom, Pan, Raster und Hilfslinien.
- **Treffer- und Auswahllogik** arbeitet auf `Measured.els` plus Item-Boxen: Hit-Test über Box, Rotation und Pfad, Mehrfachauswahl per Rahmen, Einrasten an Kanten und Mitten (heute `Stage.tsx:202-266`).
- **Griffe** für Größe, Drehung und Zuschnitt werden als Overlay-Szene gezeichnet. Neu: Größe ändern und Drehen auch per Tastatur (heute nur Maus, `Stage.tsx:622-643`).
- **Textbearbeitung:** Heute `contentEditable` am Folien-DOM (`slide.tsx:77`). Künftig ein Inline-Editor über dem Textknoten auf Basis von parley `PlainEditor`, erweitert um Spannen für fett, kursiv, Link und Farbe (Rich-Text). IME per winit/Slint-Text-Input. **Das ist das größte UI-Risiko** (§13) und deshalb Teil des P0-Spikes.
- **Drag and Drop** von Dateien und Elementen (heute MIME `application/x-deckwerk-item`, `Elements.tsx:45`) über Slint-/winit-DnD und `rfd` für Dateidialoge. Die Zwischenablage läuft über arboard.

---

## 5. Modul-Mapping: jede Datei → Crate, Funktionsabgleich

Aufwand: **S** < 1 Tag, **M** 1–3 Tage, **L** > 3 Tage (eine erfahrene Person, mit Tests). „P“ = nur in Deckwerk Pro.

### 5.1 `src/main/` (Electron-Main)

| Datei (Zeilen) | Ziel | Heute abhängig von | Rust-Ersatz | Aufwand | Besonderheit |
|---|---|---|---|---|---|
| `index.ts` (175) | dw-app (Start), dw-cli (Modi), dw-store::platform | Electron app/BrowserWindow/protocol, net.fetch | Slint-Start, clap-CLI, eigenes Asset-Laden | M | Wayland-Neustart (`:25-33`), IPv4-first (`:20`) und Range-Workaround (`:116-117`) entfallen |
| `ipc.ts` (782) | dw-daemon (Commands), dw-store, dw-sync, dw-cli-agent (Setup) | 72 ipcMain-Handler, dialog, safeStorage, clipboard, shell | typisierte `Cmd`-Enum + Slint-Callbacks, rfd, keyring, arboard, `open` | L | Validierung an jeder Grenze (§7.1), TOML per `toml_edit` statt von Hand (`:685-696,735`) |
| `engine.ts` (402) | dw-daemon (Export-Dispatch, Caches), dw-video | render.ts, nativeImage | dw-scene/raster/pdf/pptx, LRU-Cache | M | Measure-Cache begrenzen (`:34`), Slug vereinheitlichen (`:31`) |
| `render.ts` (170) | **entfällt** → dw-scene, dw-raster, dw-pdf | Offscreen-BrowserWindow, capturePage, printToPDF | §4 | L | Sequenzmarker, 721-px-Hack, Papierrundung entfallen |
| `pdf-boxes.ts` (29) | entfällt → krilla `PageSettings` | Regex auf PDF-Bytes | krilla | S | – |
| `export-pptx.ts` (359) | dw-pptx | pptxgenjs, nativeImage | eigener OOXML-Generator | L | §6 |
| `pptx-post.ts` (102) | dw-pptx (Diagramme, Sektionen, Agenda-Links) | jszip, Regex | Generator schreibt direkt | M | Regex mit ungeprüfter ID (`:27`) entfällt |
| `animations.ts` (202) | dw-pptx::timing | Regex, Preset-IDs | Generator + Preset-Tabelle | M | Tabellen-ID-Hack (`:80-83`) entfällt durch eigene ID-Vergabe |
| `patch-xml.ts` (84) | dw-pptx (Verlauf, Maske, Effekt, Blip) | Regex | Generator | M | XML-Injection (`:28,57,65`) entfällt durch Escaping/Typen |
| `embed-fonts.ts` (136) | dw-fonts + dw-pptx | eigener TTF-Parser | ttf-parser/skrifa + eigener EOT-Writer | M | fsType-Frage klären (`:84`) |
| `export-docx.ts` (123) | dw-docx | handgeschriebenes XML | quick-xml + zip | M | – |
| `export-video.ts` (370; P: +243) | dw-video::export | ffmpeg, renderSlide, nativeImage | dw-media + dw-raster | L | Loudnorm per JSON-Ausgabe statt Regex (`:240-244`), Speicherbudget statt `GROUP=20` (`:22`) |
| `video-fx.ts` (57) | dw-video::fx | – | rein | S | – |
| `video-cache.ts` (91) | dw-media::cache | – | rein | S | – |
| `ffmpeg.ts` (239) | dw-media::ffmpeg | spawn, ffmpeg-static | `std::process` + ffprobe | M | Probe per ffprobe-JSON statt stderr (`:101-103`), Abbruch + Timeout |
| `transcribe.ts` (251) | dw-asr::whisper | onnxruntime-node | sherpa-onnx (Whisper) oder ort + rustfft | M | O(N²)-DFT (`:62-66`) → FFT, kein UI-Freeze |
| `sherpa.ts` (185; P: +60) + `sherpa-worker.ts` (203) | dw-asr | sherpa-onnx-node, fork | sherpa-onnx 1.13.8 (Rust), Worker-Thread | M | `vad.front(false)`-Umgehung und stdout-Umleitung entfallen |
| `faces.ts` (214) | dw-vision::faces | onnxruntime-node | ort 2.0-rc.14 | M | `speakerFaces` holt Frames einmal (`:185`) |
| `bg-remove.ts` (66) | dw-vision::bg | onnxruntime-node, nativeImage | ort + image + fast_image_resize | S | RAM-Wache bleibt (`:35`) |
| `ytdlp.ts` (213) | dw-media::ytdlp | yt-dlp, `ELECTRON_RUN_AS_NODE` als JS-Runtime | yt-dlp + Deno/`--js-runtimes`, Dateisperre | M | `process.execPath` als Node (`:151-154`) braucht Ersatz |
| `twitch-chat.ts` (62) | dw-media::twitch | TwitchDownloaderCLI | gleich (Binary) oder Twitch-GQL direkt | S | JSON gestreamt statt ganz im RAM (`:58-59`) |
| `download.ts` (45) | dw-net::download | net.fetch (SIGTRAP-Umgehung) | reqwest mit SHA-256 und Stillstandswache | S | Umgehung entfällt |
| `music.ts` (93) | dw-net + dw-video::music | fetch, eigene SSRF-Prüfung | dw-net | S | dritte SSRF-Variante (`:59`) entfällt |
| `source-text.ts` (173) | dw-office-in::source | poppler (pdftotext/pdfimages) | poppler weiter oder pdf-extract/hayro; docx/pptx per quick-xml | M | Größenlimits (`:151,172`) |
| `webfonts.ts` (141) | dw-fonts::web | fetch, CSS-Regex | dw-net + Google-Fonts-API (JSON) | S | – |
| `image-settings.ts` (43) | dw-store::secrets | safeStorage | keyring | S | – |
| `accounts.ts` (133) | dw-cli-agent::accounts | Kindprozesse, Nextcloud Login Flow v2 | gleich | M | – |
| `claude-agent.ts` (229; P: +) | dw-cli-agent + dw-mcp::http | spawn, http | tokio::process, axum | M | Bearer zeitkonstant (`:43`), Prompt per Datei statt Argument |
| `agent.ts` (235; P: +67/−47) | dw-agent | @anthropic-ai/sdk | reqwest + SSE, eigener Tool-Runner | M | Retry ohne doppelte Tool-Ausführung (§7.2) |
| `tools.ts` (1 364; P: ~1 570) | dw-tools | zod, culori, lucide-react | schemars, dw-color, Icon-Katalog | L | eine Definition für alle Wege |
| `mcp.ts` (173) | dw-mcp | @modelcontextprotocol/sdk | rmcp 3.5 | M | `save_deck` atomar + Version, `open_deck` mit Prüfung |
| `design-guide.md` (494 Zeilen, 75 KB) | dw-guide (eingebettet per `include_str!`) | Vite `?raw` | – | S | bleibt Markdown |
| `sync.ts` (350) | dw-sync::webdav | fetch, btoa/unescape | reqwest (+ reqwest_dav oder eigene PROPFIND) | M | Pfadprüfung in `down()` (`:179-192`) |
| `sync-folder.ts` (109) | dw-sync::folder | fs | std::fs + notify | S | Seiteneffekt im PROPFIND (`:46`) trennen |
| `remote.ts` (52) | dw-remote | http auf 0.0.0.0 | axum + Pairing + TLS | M | §7.1 |
| `update.ts` (38) | dw-update | `curl … \| sh` | signierte Artefakte (minisign/ed25519) | M | §7.1 |
| `spellcheck.ts` (40) | dw-app::spell | Electron-Spellchecker | spellbook 0.4 (Hunspell-Wörterbücher, `de_DE`) | M | Wörterbuch mitliefern |
| `check.ts` (89) | dw-cli check | app.getAppPath | – | S | – |
| P `router.ts` (205) | dw-router | spawn claude/codex/vibe, API | dw-agent + dw-cli-agent | M | Zeitlimits bleiben |
| P `guide-modules.ts` (215) | dw-guide | – | rein | S | Fehler bei fehlender Überschrift → Build-Test |
| P `clients.ts` (72) | dw-store::clients | fs | rein | S | – |
| P `potx.ts` (54) | dw-office-in::potx | JSZip, Regex | zip + quick-xml | S | – |
| P `xlsx-link.ts` (140) | dw-office-in::xlsx | eigener Scanner | calamine 0.36 | S | Limits bleiben (50 MB, 30×30) |
| P `print-pdf.ts` (90) | dw-pdf::print | Ghostscript | §4.4 | M | – |
| P `phone.ts` (136) + `phone-ffmpeg.ts` (167) | dw-phone | adb | adb-Prozess (oder adb_client-Crate) | M | 64-KB-Grenze von `adb shell` bleibt (Skript-Datei) |
| P `timeline-ffmpeg.ts` (173) | dw-timeline::graph | – | rein | M | Bugs §7.2 |
| P `export-timeline.ts` (185) | dw-timeline::export | ffmpeg | dw-media | M | Abbruch, Timeout |
| P `timeline-media.ts` (73) | dw-media (peaks, proxy, r128) | ffmpeg | – | S | – |
| P `export-xmeml.ts` (116) + `export-xmeml-tl.ts` (121) | dw-timeline::xmeml (+ FCPXML neu) | String-XML | quick-xml | M | Mix/Farbe ergänzen (§8) |

### 5.2 `src/preload/`

| Datei | Ziel | Bemerkung |
|---|---|---|
| `preload/index.ts` (230, ~80 Methoden, 72 invoke, 10 Events) | **entfällt** | Ersetzt durch die `Cmd`/`Event`-Typen von dw-daemon. Retry-Schleife (`:34-37`) und zehn gleiche Listener-Blöcke (`:65-219`) entfallen. |

### 5.3 `src/shared/` (reine Logik)

| Datei (Zeilen) | Ziel | Aufwand | Besonderheit |
|---|---|---|---|
| `deck.ts` (403) | dw-model | M | erstmals ein Deck-Schema beim Laden (heute nur Typ) |
| `items.ts` (246) | dw-model::items | M | `newId` per uuid statt `Math.random` (`:75`) |
| `layouts.ts` (424) + `layouts-extra.ts` (829) | dw-model::layouts (Schemas, Samples) + dw-scene::layouts (Bau) | L | `.describe()`-Texte als Doc-Kommentare (schemars) |
| `themes.ts` (413), `themes-extra.ts` (90), `theme-refs.ts` (50) | dw-theme | M | – |
| `font-catalog.ts` (173), `font-win.ts` (43) | dw-theme::fonts / dw-fonts | S | Win-Metrik aus der Schrift lesen |
| `lint.ts` (274), `theme-lint.ts` (117) | dw-lint | M | Kontrast aus dw-color |
| `clip-lint.ts` (297) | dw-lint::clip | M | `inWord` per Binärsuche (`:23`) |
| `video.ts` (218; Podcast-Branch 283; P +91) | dw-model::video + dw-video | M | Referenz = Podcast-Branch-Stand |
| `highlights.ts` (122), `retakes.ts` (89), `transcript-search.ts` (174) | dw-video | M | `retakes` O(n·Fenster) (`:43`) bewusst prüfen |
| `find.ts` (99), `merge.ts` (73), `handout.ts` (33), `klartext.ts` (16), `typo.ts` (42) | dw-lint / dw-typo / dw-md | S | – |
| `charts.ts` (74) | dw-scene::chart + dw-pptx::chart | S | – |
| `models.ts` (41) | dw-router::models | S | Wahl-IDs nie durch `modelOf()` (Regel aus CLAUDE.md) |
| `clouds.ts` (88) | dw-sync::providers | S | – |
| P `app-id.ts` (3) | dw-store::Edition | S | – |
| P `timeline.ts` (119), `timeline-edit.ts` (220), `timeline-from-clips.ts` (66), `layouts-timeline.ts` (84), `grade.ts` (77) | dw-timeline | M | – |
| P `layouts-pro.ts` (69), `layout-switch.ts` (106) | dw-model::layouts (Feature `pro`) | S | – |
| Podcast-Branch `podcast.ts` (298) | dw-podcast | M | O(n²) → sortiert + Binärsuche |

### 5.4 `src/renderer/` (Folien)

| Datei (Zeilen) | Ziel | Aufwand | Besonderheit |
|---|---|---|---|
| `slide.tsx` (745) | dw-scene (Primitive `T`, `Box`, `Img`, `Icon`, `ChartBox`, `QrCode`, `LineSvg`, `FreeItem`, `Frame`, Deko) | L | Chart.js-Ersatz, Masken, Effekte |
| `layouts.tsx` (484) | dw-scene::layouts (15 Layouts) | L | – |
| `layouts-extra.tsx` (878) | dw-scene::layouts (26 Layouts) | L | – |
| P `layouts-pro.tsx` (50) + `layouts-pro.css` (21) | dw-scene::layouts (Gantt, Stream) | M | – |
| `slide.css` (426), `layouts-extra.css` (467) | **entfällt**, aufgeteilt in Layout-Funktionen + Theme-Tokens | (in den Layouts enthalten) | Inventur §4.2.1 |
| `measure.ts` (289) | dw-scene::autofit + direkte El-Erzeugung | M | keine Extraktion mehr nötig |
| `main.tsx` (171) | entfällt (`window.dw`-Brücke: `mark`, `render`, `hideExportables`, `renderAll`) | – | `mirrorBleed` (`:57-69`) wird zu dw-pdf::bleed |
| `boot.ts` (4), `index.html` (39), `fonts.css` (58) | entfällt | S | Schriften über fontique |
| `App.tsx` (478) | dw-app::shell (Screens, Undo, Autosave) | L | Undo als Patch-Historie (§8) |

### 5.5 `src/renderer/ui/` (Oberfläche) → `dw-app` (Slint)

| Komponente (Zeilen) | Slint-Modul | Aufwand | Hinweis |
|---|---|---|---|
| `Stage.tsx` (725) | `stage` (Canvas, Interaktion, Kontextmenü getrennt) | L | §4.7 |
| `EditorScreen.tsx` (153), `TopBar.tsx` (119), `Filmstrip.tsx` (109), `Overview.tsx` (116), `LayersPanel.tsx` (125), `ObjectBar.tsx` (130) | `editor/*` | M je | Overview: Pfeilnavigation ergänzen (`Overview.tsx:47`) |
| `Inspector.tsx` (161), `ItemInspector.tsx` (509), `ChartEditor.tsx` (97), `FontPicker.tsx` (41) | `inspector/*` | M–L | Animations-Vorschau über Szenen-Interpolation statt Web Animations (`ItemInspector.tsx:219`) |
| `Elements.tsx` (227), `InsertSearch.tsx` (137), `FindBar.tsx` (96) | `insert/*`, `find` | M | – |
| `LookSheet.tsx` (334), `SlideLooks.tsx` (56), `FormatSheet.tsx` (87), `PrintSheet.tsx` (77), `VersionsSheet.tsx` (96), `ShortcutSheet.tsx` (67) | `sheets/*` | M | Mini-Vorschauen per vello_cpu-Thumbnails |
| `Start.tsx` (238; P 327), `AskBar.tsx` (196), `Chat.tsx` (112), `BuildView.tsx` (67) | `start`, `chat` | M | Start lädt Decks nicht bei jedem Fokus neu (`Start.tsx:132`) |
| `Deckvid.tsx` (524; P 688), `DeckvidWork.tsx` (46), `ClipCutter.tsx` (188), `clipPlayer.tsx` (195), `media.ts` (25) | `video/*` | L | Wiedergabe über gstreamer, Ducking über cpal-Mixer (`Deckvid.tsx:446-472`) |
| Podcast-Branch `PodcastStage.tsx` (333), `Waveform.tsx` (90), `deckvid-parts.tsx` (41) | `podcast/*` | M | Waveform selbst aus Peaks zeichnen (statt WaveSurfer) |
| `PresentScreen.tsx` (463) | `present` (Engine + Ansicht getrennt) | L | §4.5 |
| `SetupSheet.tsx` (73), `KeyDialog.tsx` (43), `kit.tsx` (178), `Logo.tsx` (4) | `kit/*` | S–M | – |
| `settings/Settings.tsx` (57), `parts.tsx` (70), `KiSection.tsx` (209), `CloudSection.tsx` (180), `MarkeSection.tsx` (99), `BilderSection.tsx` (86), `AgentenSection.tsx` (72), `AllgemeinSection.tsx` (77), `settings.css` (73) | `settings/*` | M | Vollbild-Einstellungen wie heute; Poll in KiSection (4 s) durch Events ersetzen |
| `itemOps.ts` (138), `story.ts` (13) | dw-model::ops (rein) | S | gehört in den Kern, nicht in die UI |
| CSS (`app.css` 331, `shell.css` 501, `kit.css` 104, `deckvid.css` 134, `cutter.css` 39, `deckvid-work.css` 18, `layers.css` 17, `versions.css` 21; P `content-form.css`, `videotools.css`, `timeline/timeline.css`, `timeline-panels.css`, `color.css`, `mediapool.css`, `mixer.css`, `viewer.css`) | Slint-Styles (`theme.slint` + je Modul) | M | Gestaltung = heutige App (shell.css als Vorlage) |
| P `timeline/TimelineEditor.tsx` (303), `Tracks.tsx` (212), `Viewer.tsx` (143), `Inspector.tsx` (181), `useTimelinePlayer.ts` (247) | `timeline/*` | L | Spielkopf per Timer-Property statt setState je Frame (§7.5) |
| P `timeline/Mixer.tsx` (95), `audioGraph.ts` (75), `Scopes.tsx` (57), `scope-math.ts` (19) | `timeline/mixer`, Audio über cpal, Scopes über eigene Analyse | M | rAF-Dauerschleifen entfallen |
| P `timeline/ColorPage.tsx` (71), `ColorWheel.tsx` (73), `wheel-math.ts` (23) | `timeline/color` | M | Vorschau mit derselben LUT wie der Export (§8) |
| P `timeline/MediaPool.tsx` (62), `Deliver.tsx` (93), `Ruler.tsx` (53), `drag.ts` (111), `media.ts` (38) | `timeline/*` | M | – |
| P `ThemeEditor.tsx` (177), `VideoTools.tsx` (184), `ContentForm.tsx` (196), `DeckSheet.tsx` (144), `LintPanel.tsx` (59), `AccentPicker.tsx` (59) | `pro/*` | M | ContentForm baut aus dem schemars-Schema (statt `z.toJSONSchema`) |

### 5.6 `scripts/` → Tests und Werkzeuge

| Skript | Ziel |
|---|---|
| `agent-smoke.ts`, `mcp-smoke.ts`, `mcp-e2e.ts`, `claude-smoke.ts` | `crates/dw-tools/tests/smoke.rs`, `dw-mcp/tests/e2e.rs` (gegen echten Daemon, headless ohne Bildschirm – kein Xvfb mehr nötig), `claude-smoke` bleibt manuell |
| `validate-examples.ts` | `dw-model/tests/examples.rs` |
| `verify-pptx.ts` | `dw-cli verify` (LibreOffice-Rendering ↔ dw-raster) |
| `check-*.ts` (Basis 34, Pro 64) | je ein `#[test]`-Modul im Ziel-Crate (Tabelle §11.2) |
| `story-check.ts` | `dw-model/tests/story.rs` |
| `install.sh`, `uninstall.sh`, `deckwerk.sh`, `open.mjs` | `xtask` + Paketierung (§12 P7); `deckwerk.sh` entfällt (kein Neubauen beim Start) |
| `fetch-fonts.ts`, `curate-fonts.ts`, `repair-font-names.ts`, `spike-embed-fonts.ts` | `xtask fonts …` |
| P `router-eval.ts` | `dw-router/examples/eval.rs` |
| P `convert-parakeet-ultra.py` | bleibt Python (Modellumwandlung, einmalig) |

### 5.7 Funktionsabgleich: nichts geht verloren

**KI-Werkzeuge** (alle wandern nach `dw-tools`; Ausführung im jeweiligen Fach-Crate):

| Werkzeug | Fach-Crate | | Werkzeug | Fach-Crate |
|---|---|---|---|---|
| `create_deck`, `update_deck` | dw-model, dw-theme, dw-store | | `find_images` (Assets, Unsplash mit Bildnachweis in den Notizen, Openverse, URL) | dw-net, dw-store |
| `add_slides`, `update_slide`, `reorder_slides`, `delete_slides` | dw-model + dw-scene (Autofit/Lint-Bericht) | | `generate_image` (gpt-image-2 über Mammouth, OpenAI oder Codex-Login) | dw-net, dw-cli-agent |
| `decorate_slide` (nur auf Wunsch) | dw-scene | | `export_deck` (pptx, docx, pdf, png, zip, md, print, clips, mp4; P: Stapel-Export `formats`) | dw-pptx/docx/pdf/raster/md, dw-video |
| `render_slides`, `render_overview` | dw-raster | | `import_video`, `video_highlights`, `transcribe_video`, `search_transcript`, `video_frames`, `check_clip` | dw-media, dw-asr, dw-video, dw-lint |
| `propose_looks` | dw-theme + dw-raster | | `find_music` (Openverse, CC) | dw-net, dw-video |
| `lint_deck` | dw-lint | | `remember` (Hausstil, §7.1 S10) | dw-store |
| `search_icons` | dw-scene::icons (Katalog) | | `plan_storyline`, `ask_user` (nur App-Chat) | dw-app-Events |
| P `read_guide` | dw-guide | | P `edit_timeline` | dw-timeline |
| MCP: `get_deck`, `save_deck`, `open_deck`, `read_guide` | dw-mcp + dw-store | | Podcast: `create_episode`, `edit_episode` | dw-podcast |

**Funktionen ohne eigenes Werkzeug:**

| Funktion | Heute | Ziel |
|---|---|---|
| ✦-Aufträge in der KI-Leiste: übersetzen (9 Sprachen), Sprechernotizen für alle Folien, auf 5–15 Folien kürzen, als E-Mail/Newsletter/Blog zusammenfassen, Rechtschreibung prüfen (README:82) | vorbereitete Prompts im App-Chat | `dw-app::ask` + `dw-guide`-Vorlagen, unverändert über den Agenten |
| Notizen „Schreiben lassen“/„Überarbeiten“, geschätzte Sprechzeit | UI + Agent | dw-app + dw-agent, Sprechzeit in dw-lint |
| **Serienbrief:** `{{Spalte}}` in Texten, Kopfleiste „Serienbrief (CSV) …“, je CSV-Zeile ein PDF (`TopBar.tsx:37,106`, `shared/merge.ts`) | Renderer + Export | dw-lint::series (Ersetzung) + dw-pdf (Stapel), Menüpunkt in dw-app |
| Video-Profi: Bauchbinde, Bild-in-Bild, Folie im Video, Verpixeln, Look, Standbild, SRT, Einblendungen `liste`/`zitat`/`markierung`/`abspann`, Tempo, Lautstärke, Musikpegel/Ducking, Übergänge (xfade), Zoom an Momentwechseln, Pausen kürzen, Zusammenschnitt, Chat-Import (YouTube/Twitch) | `shared/video.ts`, `export-video.ts`, `video-fx.ts`, Deckvid | dw-video (Graph + ASS), dw-media, Vorschau in dw-app (gstreamer + Overlay-Szene) |
| Brand-Kit (Farben, Schriften, Logo hell/dunkel; Logo nur Titel/Schluss), P Brand-Lock, P Firmenvorlage | `brand.json`, Look-Dialog | dw-theme + dw-store, dw-office-in::potx |
| Hausstil `hausstil.md`, P Kunden-Arbeitsbereiche | Datei, `clients.ts` | dw-store |
| Quellmaterial (PDF/Word/PPTX/Text/Bilder, Abbildungen aus PDF/Word) | `source-text.ts` | dw-office-in |
| Freisteller (BiRefNet) | `bg-remove.ts` | dw-vision |
| Webfonts (Google-Fonts-Katalog), eigene Schriften | `webfonts.ts`, `font:pick` | dw-fonts |
| Versionen (10 min, 100 je Deck), Vorlagen, zuletzt geöffnet | `ipc.ts` | dw-store |
| Präsentieren: Referentenansicht, Publikumsfenster, Handy-Fernbedienung, Laser, Stift, Pause | `PresentScreen.tsx`, `remote.ts` | dw-app::present, dw-remote |
| Rechtschreibung | Electron-Spellchecker | spellbook (de_DE) |
| Cloud-Sync (WebDAV, Nextcloud, Ordner-Sync Dropbox & Co.) | `sync*.ts` | dw-sync |
| Konten (Claude-/Codex-Login, Vibe-Key, Nextcloud Login Flow), Einrichtung MCP + Skill | `accounts.ts`, `ipc.ts` | dw-cli-agent, dw-store |
| P Excel-Verknüpfung für Diagramme | `xlsx-link.ts` | dw-office-in::xlsx (calamine) |
| P Handy-Offload (ASR + ffmpeg per adb) | `phone*.ts` | dw-phone |
| P Druck-PDF CMYK + Farbauftrag | `print-pdf.ts` | dw-pdf::print (§4.4) |
| P Gantt, Stream-Paket (`stream-screen`, `panel`), Layoutwechsel | `layouts-pro.ts`, `layout-switch.ts` | dw-model + dw-scene (Feature `pro`) |
| P Schnittplatz (Schnitt, Farbe, Ton, Ausgabe), Medienpool, Mixer, Scopes, xmeml | `ui/timeline/**`, `timeline*.ts` | dw-timeline + dw-app::timeline |
| Podcast (Mehrspur, Schnitte pause/füll/versprecher/hand, Kapitel, Intro/Outro, SFX) | Podcast-Branch | dw-podcast + dw-app::podcast |
| Selbst-Update | `update.ts` | dw-update (signiert) |

---

## 6. Export-Spezifikation (Vertrag für dw-pptx, dw-docx, dw-pdf, dw-raster)

Dieses Kapitel hält fest, was die heutigen Exporte **tatsächlich** erzeugen. Der Rust-Generator muss das mindestens erreichen. Die PPTX ist laut Roadmap „der Vorsprung vor Canva“.

### 6.1 El-Typen (Eingang aller Exporte, `shared/deck.ts`)

| Typ | Felder |
|---|---|
| `Run` (`:321`) | `text, bold, italic, underline?, color, breakAfter?, link?, sizePx?, trackingPx?` |
| `Base` (`:323`) | `slot, box{x,y,w,h}, build?, rot?, anim?, animDir?, animSpeed?, link?` |
| `TextEl` (`:324-339`) | `font 'head'\|'body', role, sizePx, effect?{type,color}, fontFace?, lineHeightPx, trackingPx, align, upper, runs, list?{type,indentPx}, lines, bg` |
| `BoxEl` (`:340-350`) | `fill?{color,alpha}, border?{color,width}, radius, shadow?{color,alpha,blur,offsetY}, ellipse, gradient?, shape?, lineStart?, lineEnd?, dash?` |
| `Gradient` (`:351`) | `angle, stops[{color,alpha,pos}]` |
| `ImgEl` (`:352-365`) | `src, radius, fit 'cover'\|'contain', focus{x,y}, under?, nat?{w,h}, look?, alt?, mask?, adjust?, alpha?, round?, flip?, crop?` |
| `IconEl` (`:367`) | `svg, png? (4×), name?, qr?, color?` |
| `ChartEl`/`ChartSpec` (`:368,379-386`) | `type bar\|hbar\|stacked\|waterfall\|line\|donut, categories, series[{name,values}], unit?, highlight?, annotate? cagr\|delta`; Pro: `link?: { file, sheet?, range }` (`:389-393`) |
| `MediaEl` (`:370`) | `media video\|audio, src, poster?` |
| `TableEl` (`:372-376`) | `cells, colW[], rowH[], sizePx, font, fontFace?, color, line, align[]` |
| `Measured` (`:390-393`) | `fit { ok, head, body, overflow: Overflow[] }, els: El[]` |

In Rust wird daraus `enum El { Text(TextEl), Box(BoxEl), Img(ImgEl), Icon(IconEl), Chart(ChartEl), Media(MediaEl), Table(TableEl) }` mit `#[serde(tag = "kind")]`. Dieselbe JSON-Form bleibt erhalten, damit die Differenztests (§11) Byte für Byte vergleichen können.

### 6.2 Umrechnungen und Konstanten

| Größe | Formel | Quelle |
|---|---|---|
| Zoll | px / 96 | `export-pptx.ts:19` |
| Punkt | px · 0,75 | `:20` |
| EMU | px · 9 525 | `patch-xml.ts:56` |
| Twips (DOCX) | px · 15 | `export-docx.ts:12` |
| Halbe Punkte (DOCX `sz`) | px · 1,5 | `export-docx.ts:56-63` |
| `WRAP_SLACK` | 0,015 (Box ±1,5 % breiter, bei center/right verschoben) | `export-pptx.ts:22-25,155-156` |
| `TABLE_PAD` | 8 px | `export-pptx.ts:93` |
| Druck-pt | 1 pt = 4/3 CSS-px; Beschnitt 0–5 mm · 2,835 pt | `render.ts:137-139` |

### 6.3 PPTX je El-Typ

- **Text:** `p:sp` mit `txBody`, ein `a:r` je Run (b, i, u=sng, `solidFill`, `hlinkClick`), `a:br` bei `breakAfter`. Die Box wird um WRAP_SLACK verbreitert. `lnSpc` aus `lineHeightPx`, `spc` aus `trackingPx` (Tausendstel-Punkt). `bodyPr` mit `wrap="square" lIns=tIns=rIns=bIns=0 anchor="t"` und ohne Autofit, `lang="de-DE"`. `upper` wird in den Text übernommen (heute `:159`). **Listen:** `buChar`/`buAutoNum` mit Einzug `marL`/`indent` aus `indentPx`; `startAt` **nur am ersten Absatz**, weil LibreOffice bei jedem startAt neu zählt (`:135-145`). **Links:** Run-Link als externe URL. `#N` ist nur als Folienlink gültig und nur, wenn N existiert (`linkOf`, `:120-124`). Heute wird ein Run-Link `#N` ungeprüft als URL geschrieben (`:159`), siehe §7.2.
- **Box:** `prstGeom` `rect|roundRect|ellipse|line` oder freie Form über `SHAPE_TYPE` (`star→star5`, `arrow→rightArrow`, `pentagon→homePlate`, `:106-110`). `roundRect`-adj = radius/min(w,h)·100 000 (max 50 000). Füllung `solidFill` + `alpha` = (1−alpha)·100 %. Umriss `ln` mit `prstDash` (`:112`), `headEnd`/`tailEnd` (`:111`). Schatten `outerShdw` (blur/dist in EMU, dir 90°). Verlauf `gradFill` mit `lin ang = (CSS-Winkel − 90°)·60 000`. **Genau eine Füllung je Form**, sonst repariert PowerPoint die Datei (`patch-xml.ts:34`). Linie: `ShapeType.line`, Höhe 0, auf halber Höhe (`:173`).
- **Bild:** `p:pic` mit `blipFill`. `cover` als `srcRect`-Zuschnitt nach `focus`, `contain` über `containRect` (`:41-48`), freier `crop` als `srcRect` (`:197-199`). Rundung über `roundRect`, Masken über `prstGeom` aus `MASK_GEOM` (ellipse, round2SameRect, hexagon, diamond, octagon, star5, heart, `patch-xml.ts:43-52`). `alphaModFix` für Deckkraft, `flipH`. **Bildanpassung** als `a:blip`-Kinder `blur`, `hsl`, `lum` (in 1/1000 %, `patch-xml.ts:72-79`). Duotone/Graustufen als `a:duotone` bzw. `a:grayscl` (`:82-85`). **Alt-Text** = `alt` oder ein Leerzeichen, **nie der Dateipfad** (`:187,190,196`, Vuln 3).
- **Icon:** heute nur PNG (4×). Neu: `asvg:svgBlip` + PNG-Fallback.
- **Medien:** `p:pic` mit `videoFile`/`audioFile` + `p14:media`, Poster als Bild. Fehlt die Datei, warnt der Export statt still eine leere Box zu setzen.
- **Diagramm:** echtes `c:chartSpace` in `ppt/charts/chartN.xml` + eingebettete `xlsx` (für „Daten bearbeiten“ in PowerPoint; heute übernimmt das pptxgenjs).
  - Donut: `doughnutChart`, `holeSize 62`, Legende rechts.
  - hbar: `barDir bar` + `orientation maxMin`.
  - stacked/waterfall: `grouping stacked`, Labels `ctr`, sonst `outEnd`, `gapWidth 40`.
  - Linie: 2,25 pt, Marker circle 6.
  - Schrift 14 pt. Bei negativen Werten `tickLblPos low`. Zahlenformat `#,##0.0`, wenn Dezimalwerte vorkommen.
  - Waterfall mit Serien Basis/Anstieg/Rückgang/Summe, wobei die Basis unsichtbar bleibt (`noFill`, Labels `delete`; heute `pptx-post.ts:75-102`). Linienende mit Serienname, Legende nur bei Bedarf. Farben aus `chartColors`.
- **Tabelle:** `a:tbl` mit `gridCol` (colW) und `tr h` (rowH). Zeile 0 fett, nur untere Rahmenlinien: Kopf 1,5 pt, Körper 0,75 pt. Zellränder aus TABLE_PAD. **Eigene, eindeutige `cNvPr id`**: Heute kollidieren Tabellen- und Shape-IDs (`animations.ts:80-83`).
- **Notizen:** `notesSlide`. **Ausgeblendet:** `show="0"`. **Titel/Autor:** `docProps/core.xml`, Autor = `Edition::name()`.

### 6.4 Namen, Sektionen, Links, Animationen, Fonts

- **Objektnamen** (`export-pptx.ts:298-303`): `dw:<slot>`, Präfix `!!dw:` wenn diese oder die folgende Folie Morph nutzt (`:294`). Bei Doppelungen folgen `#2`, `#3`. Die Zeichen `&<>"'` werden entfernt. Die Slots sind `data-slot` bzw. `items.<id>` für freie Elemente.
- **Sektionen:** `p14:sectionLst` in `p:extLst` der `presentation.xml`, Name aus Kapitelnummer und Titel, sonst „Einstieg“. Heute nur, wenn noch kein `p:extLst` existiert (`pptx-post.ts:56`). Der Generator fügt sie immer korrekt ein.
- **Agenda-Links:** `ppaction://hlinksldjump` + Rel `slideN.xml` am Shape `dw:items.<id>.title` (Wort ≥ 4 Buchstaben, `pptx-post.ts:35-49`).
- **Übergänge** (`animations.ts:35-66`): `p:transition` mit `spd` (fast/med/slow) und `p14:dur` in `mc:AlternateContent`. Morph als `p159:morph option="byObject"` mit Fallback fade. Abbildung `slide→push l`, `stack→cover l`, `color→wipe r`, `push u`, `dissolve`, `wipe`, `cover`, `split`, `circle`, `zoom`.
- **Animationen** (`animations.ts:68-202`): `p:timing` mit mainSeq → Klickgruppe (`delay="indefinite"`) → after-Kette → Effekte. `bldLst` mit `bldP build="p"` bei Absatz-Builds, `animBg`, `bldGraphic` für Diagramme.
  - Presets: fade 10/0, float 42, pan/drift 2/8, pop/zoom/stomp 53/16, baseline 22/4, wipe 22/8, appear 1/0, pulse 26 (emph), grow 6 (emph).
  - Effekt-XML: `p:set` + `p:animEffect filter="fade|wipe(…)"`, `p:anim` auf `ppt_x/ppt_y/ppt_w/ppt_h`, `p:iterate` mit `tmAbs` (120/45 ms).
  - „Purzeln“ wird zu Zoom, weil relative Drehung in PowerPoint unzuverlässig ist (`export-pptx.ts:260`). Herübergewanderte Morph-Elemente werden nicht noch einmal animiert (`:311`).
- **Eingebettete Schriften** (`embed-fonts.ts:100-136`): TTF → EOT v2.0 unkomprimiert als `ppt/fonts/fontN.fntdata`, Rel-Typ `…/relationships/font`, Content-Type `application/x-fontdata`. Dazu `p:embeddedFontLst` nach `p:notesSz` (regular/bold/italic/boldItalic, `pitchFamily` 34 bzw. 18) und `embedTrueTypeFonts="1"`. Der Familienname muss exakt zum `typeface` passen. Eingebettet werden nur Katalog- und Premium-Schriften, Office-Schriften nicht.
- **Hintergrund:** ein PNG in 2× Auflösung mit allem außer den nativen Elementen (Linien aus `::before`, Deko, Fotos unter Scrim). In Rust ist das die Szene ohne exportierbare Knoten.
- **Ein Durchgang:** Heute wird das ZIP fünfmal neu gepackt (pptxgenjs, `patchShapes`, `injectAnimations`, `postProcess`, `embedFonts`). dw-pptx schreibt jedes Teil genau einmal, `[Content_Types].xml` und alle Rels aus einem Register.

### 6.5 DOCX (`export-docx.ts`)

- Ein Absatz je Folie, ab Folie 2 `pageBreakBefore`, Zeilenhöhe 1 pt exact (`:90`).
- Hintergrund als `wp:anchor behindDoc="1"` an Seite 0/0 in Foliengröße (`word/media/bgN.png`, `:81-87`).
- Je Textelement ein `wps:wsp`-Textfeld an Seitenposition. Einzeilig mit `wrap="none"` + `noAutofit` (Word misst anders, `:16,76`), mehrzeilig mit `square` + `spAutoFit`.
- Runs mit `rFonts`, b/i, caps, outline (hollow), color, spacing (Twips), `sz`, Unterstreichung, Hyperlink (`TargetMode=External`).
- Seite: `pgSz` in Twips, Querformat bei W > H, Ränder 0. A4 = 11 910 × 16 845.
- Schriften: `word/fonts/fontN.odttf`, obfuskiert mit GUID-Schlüssel (Bytes umgekehrt, XOR der ersten 32 Bytes), `w:embedTrueTypeFonts` in `settings.xml`.
- **Neu:** Alt-Text für Bilder (heute fehlt er in Word).

### 6.6 PDF, PNG, Druck

| Ziel | Heute | Künftig |
|---|---|---|
| PDF | `printToPDF`, Seite = w/96 × h/96 Zoll, Ränder 0 (`render.ts:117-125`) | krilla, eine Seite je Folie in pt = px · 0,75, echte Schriften, Links als Annotationen, Gliederung (Outline) aus Kapiteln, optional PDF/UA (Tags aus Rollen: Titel = H1 …) |
| Druck-PDF | Endformat a2–a6 in mm, Beschnitt 0–5 mm (Standard 3), Seite in ganzen pt, `mirrorBleed` spiegelt Ränder, Trim/Bleed per Regex (`render.ts:131-148`, `pdf-boxes.ts`) | krilla mit `with_trim_box/with_bleed_box`. Beschnitt: Hintergrund und randabfallende Bilder werden **echt erweitert** statt gespiegelt (Spiegeln nur als Fallback). Pro: CMYK/PDF/X-4 (§4.4) |
| PNG | 2× Foliengröße, Ordner `NN.png` (`engine.ts:297-301`) | vello_cpu, gleiche Größe; zusätzlich 1×/3× wählbar |
| Thumbnails/Lint-PNG | 1024 px Breite, Übersicht 1600 px (`engine.ts:232-243`) | vello_cpu direkt in Zielgröße, kein Herunterskalieren |
| ZIP | PNG + PDF, STORE (`engine.ts:289-291`) | gleich, Name aus `base` (heute nicht, `:290`) |
| Markdown/Handout | `engine.ts:55-57` | dw-md |

Formate (`deck.ts:204-215`): 16:9 1280×720, 4:3 960×720, 1:1 1080×1080, 4:5 1080×1350, 9:16 720×1280, A4 hoch/quer 794×1123/1123×794, og 1200×630, Visitenkarte 321×208 (= 85×55 mm), Pro `panel` 320×160. Druckformate (`deck.ts:230`): a2 420×594, a3 297×420, a4 210×297, a5 148×210, a6 105×148 mm. Dateisuffix über `formatSuffix` (`deck.ts:218-223`), nur mit endlichen Zahlen (Vuln-1-Fix).

### 6.7 Treue-Kalibrierungen, die erhalten bleiben müssen

1. `WRAP_SLACK` 0,015 und Metrik-Zwillinge Arimo/Carlito (`export-pptx.ts:22-25`, `themes.ts:41`).
2. Listen-Nummerierung: `startAt` nur am ersten Absatz (`export-pptx.ts:135-136`).
3. Diagramm-Achsen: Beschriftung unten bei negativen Werten (`:80`), hbar mit umgekehrter Kategorienreihenfolge (`:75`).
4. Purzeln → Zoom (`:260`), Morph-Elemente nicht doppelt animieren (`:311`).
5. Eine Füllung je Form (`patch-xml.ts:34`).
6. Exakter Familienname bei eingebetteten Schriften (`embed-fonts.ts:2`), fsType (`:84`, siehe §7.1).
7. Word: einzeilige Felder nie umbrechen (`export-docx.ts:16,76`).
8. Druckereien: Beschnitt Flyeralarm 1 mm, Saxoprint/Onlineprinters 2 mm, WIRmachenDRUCK 3 mm (`deck.ts:227-228`).

**Wegfallen** dürfen nur die pptxgenjs-Umgehungen: charSpacing 0,001 (`export-pptx.ts:160-161`), Tabellenmargin in Zoll (`:102`), `catAxisOrientation`-Typtrick (`:75`), XML-Escaping-Umgehung (`:151-152`).

---

## 7. Was gefixt werden muss

Priorisiert nach Schwere. Jeder Befund nennt Ort, Problem und Lösung im Rust-Design. **B** = Deckwerk `f2bcddc`, **P** = Deckwerk Pro `307a4b5`. Die mit ✔ markierten Stellen sind für dieses Dokument im Code nachgelesen.

### 7.1 Sicherheit

| # | Ort | Problem | Lösung im Rust-Design |
|---|---|---|---|
| S1 | B `ipc.ts:760-764` (`readDeck`), B `mcp.ts:117-119` / P `mcp.ts:83-85` ✔ (`open_deck`) | Ein Deck wird ohne Schema geladen. `open_deck` liest jeden Pfad (`resolve(home, i.path)`). `size` und andere Felder werden nicht geprüft (Vuln 1 nur in `formatSuffix` behoben). | `dw-model::Deck` mit serde + garde, **jede** Ladestelle geht durch `Deck::load(path) -> Result<Deck>` mit Größenlimit (z. B. 20 MB), Feldgrenzen und Pfadprüfung (nur unter Datenordner oder per Dialog gewählt). |
| S2 | B `sync.ts:179-192` ✔ (`down()`) | Der Pfad aus der Remote-Liste wird ohne `..`/absolut-Prüfung mit `join(home, rel)` verbunden (der Vuln-2-Fix sitzt nur in `skip`). | `dw-sync`: `RelPath` als eigener Typ, der beim Parsen `..`, absolute Pfade, `\` und Laufwerksbuchstaben ablehnt. Schreiben nur über `Store::resolve(RelPath)`. |
| S3 | B `patch-xml.ts:28,57,65` ✔ | `hex()` entfernt nur `#` und übernimmt den Rest ungeprüft in XML-Attribute (`effectColor` → `<a:srgbClr val="…">`), das erlaubt XML-Injection in die PPTX. | Farben sind `Rgb([u8;3])`, die Serialisierung kann nur 6 Hex-Ziffern schreiben. Alles XML läuft über quick-xml mit Escaping. |
| S4 | B `pptx-post.ts:27` | `RegExp` aus ungeprüfter Item-ID. | entfällt (kein Regex auf XML). |
| S5 | B `ipc.ts:395-400` ✔ (`source:read`) | Übergibt der Renderer Pfade, liest Main sie **ohne Dialog**. Bei einem kompromittierten Renderer lassen sich so beliebige Dateien lesen (bis zur Größe ohne Limit, `source-text.ts:151,172`). | In der nativen App gibt es keine Renderer-Grenze mehr. Trotzdem: Quellen nur per Dialog, Drag and Drop oder aus dem Datenordner, mit Größenlimit je Typ. |
| S6 | B `update.ts:32` ✔ | Das Update läuft per `curl …/master/scripts/install.sh \| sh`: ohne Hash, vom Branch statt vom Release, Ausführung als Shell. | `dw-update`: Release-Manifest (Version, SHA-256, ed25519-Signatur mit eingebautem öffentlichem Schlüssel), Download des Artefakts, Prüfung, atomarer Austausch. Keine Shell. |
| S7 | B `remote.ts:38` ✔ | Die Fernbedienung lauscht per HTTP auf `0.0.0.0` mit 16-Byte-Token, die Notizen gehen im Klartext durchs WLAN (`:35`). Das ist bekannt und im Review „akzeptiert“. | `dw-remote`: Pairing per QR (Token + Fingerprint eines selbst erzeugten Zertifikats, rcgen), HTTPS mit Zertifikats-Pinning im Handy-Browser nicht möglich → daher **Ende-zu-Ende-Verschlüsselung der Nachrichten** (Schlüssel im QR, XChaCha20-Poly1305) über WebSocket; standardmäßig nur auf der LAN-Schnittstelle binden, Zeitlimit. |
| S8 | B `claude-agent.ts:43` ✔ | Der Bearer-Vergleich ist nicht zeitkonstant (`!==`). | `subtle::ConstantTimeEq`. Server nur auf 127.0.0.1 (bleibt), Token 32 Byte, Datei 0600 (bleibt) **und** beim Start alte Token-Ordner aufräumen (heute nur bei sauberem Ende, `:58-59`). |
| S9 | B `tools.ts:1087` ✔, `ytdlp.ts:118` ✔, `music.ts:59` ✔ | Es gibt drei SSRF-Prüfungen mit abweichenden Regexen. `tools.ts`/`music.ts` kennen kein `.local`, alle drei kennen kein IPv6 außer per `[`-Präfix, kein 100.64/10, kein `::ffff:`, keine DNS-Auflösung. `find_images` folgt Weiterleitungen automatisch (`:1088`). | `dw-net::check_public(url)`: URL parsen, Host **auflösen**, jede IP gegen private/Loopback/Link-local/CGNAT/ULA/v4-mapped prüfen, Weiterleitungen manuell mit erneuter Prüfung, Zeit- und Größenlimit. Eine Funktion für alle Aufrufer. |
| S10 | B `tools.ts:1022-1030` ✔ (`remember`) | Die KI schreibt bis zu 200 Zeichen dauerhaft in `hausstil.md`, das in jeden künftigen Systemprompt eingeht (`agent.ts:70`). Das ist ein persistenter Prompt-Injection-Pfad (z. B. aus einer präparierten Quelle). | `remember` schreibt in einen **Vorschlagsbereich**, den der Nutzer in den Einstellungen bestätigt. Alternativ markiert der Prompt Einträge als Nutzerdaten. Inhalt filtern (keine Anweisungen an Werkzeuge, keine URLs). |
| S11 | B `ipc.ts:417` (`brand:set`), `tools.ts:51` | Das Brand-Kit wird ohne Validierung gespeichert. | `BrandKit` mit garde (Farben, bekannte Schriften, Logo nur `MEDIA_EXT` aus `assets/`). |
| S12 | B `ipc.ts:462` (`asset:save`), `source-text.ts:151,172` | Größen sind nicht begrenzt. | Limits je Typ in `dw-store` (Bild 50 MB, Quelle 100 MB, Video unbegrenzt, aber Stream statt RAM). |
| S13 | B `export-pptx.ts:159` | Run-Links `#N` gehen ungeprüft als URL in die PPTX, ebenso beliebige Schemata. | `Link` als Enum `Slide(n)` oder `Url(Url)` mit Allowlist `http`, `https`, `mailto`. |
| S14 | B `embed-fonts.ts:84` | Das fsType-Bit „restricted“ wird gelöscht, damit PowerPoint die Schrift zeigt. Lizenzrechtlich heikel. | Nur Schriften aus dem Katalog mit bekannter Lizenz (OFL/Apache) einbetten. Für sie ist das Bit ohnehin 0 bzw. das Einbetten erlaubt. Bei fremden Schriften mit „restricted“ **nicht** einbetten und einen Lint-Hinweis zeigen. |
| S15 | B `accounts.ts:88-89` ✔ | Der Vibe-Key liegt im Klartext in `~/.vibe/.env` (immerhin 0600). Vibe verlangt das so. | Bleibt nötig, solange Vibe es so liest. Hinweis in den Einstellungen; der eigene Speicher nutzt keyring. |
| S16 | P `ipc.ts:740,878-882` | Beim Einrichten von Pro werden der MCP-Eintrag `deckwerk` und der Skill aus fremden Configs entfernt. | Bei zwei Editionen beide Einträge zulassen (unterschiedliche Namen), nie fremde Einträge löschen. |
| S17 | B `ipc.ts:361-365` (`image:pick`) | Es wird nur der Originalpfad gespeichert. Ein geteiltes Deck kann so lokale Dateien beim Export einbetten (unter Schwelle im Review). | Bilder beim Einfügen immer nach `assets/` kopieren (Hash-Name). Beim Export nur `assets/` und `MEDIA_EXT`. |
| S18 | `scripts/deckwerk.sh:15-17` | Lock- und Log-Dateien liegen in `/tmp` (nicht geprüft). | entfällt (kein Startskript mehr), Logs nach `appData/…/logs/` mit Rotation. |

**Status SECURITY-REVIEW.md** (Stand 07.10.): Vuln 1 teilweise behoben (S1 offen), Vuln 2 teilweise behoben (S2 offen), Vuln 3 behoben (alte Exporte in `exports/` und `website/public/beispiele/deckwerk.pptx` enthalten noch Pfade, einmalig neu erzeugen). Härtungen S3, S7, S9 und S17 sind offen.

### 7.2 Korrektheit

| # | Ort | Problem | Lösung |
|---|---|---|---|
| K1 | B `engine.ts:34` ✔ | Der Measure-Cache ist unbegrenzt („ponytail“). Lange Sitzungen und der MCP-Dauerbetrieb wachsen ohne Ende. | LRU nach Bytes (z. B. 256 MB), Schlüssel = Hash aus Folie + Theme + Format + Schriftstand. |
| K2 | B `engine.ts:121-122` | Sprecher-IDs gelten nur je 30-min-Stück, über Stücke hinweg wechselt die Zuordnung. | Diarisierung mit globalem Embedding-Abgleich (CAM++-Vektoren über alle Stücke clustern). |
| K3 | B `engine.ts:290` | Der ZIP-Name wird nicht aus `base` gebildet (andere Benennung als die übrigen Exporte). | Ein `ExportName` für alle Formate. |
| K4 | B `tools.ts:1306` | `codexImage` nimmt das neueste Bild im Ordner. Laufen zwei Aufträge, gibt es ein Race. | Auftrags-ID als Dateiname oder eigener Arbeitsordner je Aufruf. |
| K5 | B `tools.ts:398,409`, P `tools.ts:450-478` | Jobs liegen nur in einer Map im Speicher, ohne Persistenz. Nach 600 s sind sie vergessen. | Job-Tabelle im Daemon (redb oder SQLite), Status überlebt Neustarts, abholbar per ID. |
| K6 | B `App.tsx:244-248,304` | Nach `deck:synced` wird der Undo-Stapel geleert, `turnStart` aber nicht. „KI-Runde rückgängig“ kann den Stand vor dem Sync zurückholen und die Synchronisation überschreiben. | Undo als Patch-Historie mit Basisversion. Ein Sync setzt eine neue Basis, ältere Patches werden rebased oder verworfen. |
| K7 | B `ipc.ts:91-93` | Lokale ungespeicherte Änderungen gewinnen beim nächsten Speichern **still** gegen die Cloud-Fassung. | Drei-Wege-Merge (dw-merge) gegen die zuletzt synchronisierte Basis; bei echten Konflikten Hinweis und Version sichern. |
| K8 | B `pptx-post.ts:56` | Sektionen werden nur eingefügt, wenn noch kein `p:extLst` existiert. | Der Generator schreibt `extLst` selbst. |
| K9 | B `export-pptx.ts:215-217` | Icons ohne PNG fallen **still** weg. | SVG + PNG-Fallback aus der Szene, Warnung bei Fehlern. |
| K10 | B `preload` ↔ `ipc.ts:572` | `present:cmd` ist gleichzeitig Invoke-Kanal und Event (Namenskollision). | getrennte `Cmd::Present` und `Event::Present`. |
| K11 | B `ytdlp.ts:133-140` | Die Import-Sperre gilt je Prozess. App und MCP schreiben parallel nach `assets/.video/import`. | Daemon (§3.4) + Dateisperre (`fs4`/`fd-lock`). |
| K12 | B `source-text.ts:163` | Bei Videos gibt es ein 15-s-Race als Quellmaterial. | Probe mit Abbruch-Token statt Race. |
| K13 | P `tools.ts:578` ✔, `:612` ✔, `lint.ts:82` | `create_deck` (`:578`) prüft den Arbeitsbereich (`defaultBrand()?.lock`), `update_deck` (`:612`) und der Lint dagegen nur die Deck-Kopie `deck.theme.brand?.lock`. **Bei alten Decks** (vor dem Einschalten angelegt) **greift der Lock beim Ändern nicht.** | Lock ist eine Eigenschaft des Arbeitsbereichs (`Store::brand().lock`), nicht des Decks. Jede Prüfung fragt den Store. |
| K14 | P `timeline-ffmpeg.ts:38` ✔ | Bei xfade beginnt das Ziel im Bild zu früh, weil die Quelle auf ≥ 0 geklemmt wird, während der Ton per `adelay` wartet („ponytail“). | `tpad=start_duration` vorn bzw. Versatz im `setpts`. Test: Bild- und Ton-Onset gleich (±1 Frame). |
| K15 | P `timeline-ffmpeg.ts:171` ✔ | `estimate()` ruft `sections(tl)` ohne Deliver auf und rechnet deshalb mit 30 fps statt mit der gewählten Bildrate. | `sections(tl, deliver)`. |
| K16 | P `timeline-edit.ts:121-132` | `setClip` prüft `out > in` nicht selbst (erst das Schema). | Invariante im Typ (`ClipRange::new` prüft). |
| K17 | P `timeline-ffmpeg.ts:44` | Der Ton einer ausgeblendeten Videospur (`hide`) bleibt hörbar. | Bewusst entscheiden und dokumentieren: `hide` = nur Bild, `mute` = nur Ton. Im Inspector getrennt anzeigen. |
| K18 | P `export-xmeml-tl.ts:5` | Die Mehrspur-XML verwirft Lautstärke, Keys, EQ, Grade, Zuschnitt, Bild-in-Bild, Einblendungen und Untertitel. | Lautstärke/Keys als `filter`/`effect` (Audio Levels), Zuschnitt/PiP als Basic Motion, Untertitel als SRT daneben (gibt es). Zusätzlich FCPXML 1.11 (Roadmap). |
| K19 | P `mcp.ts:73-76` ✔ | `save_deck` schreibt nicht atomar und legt keine Version an (die App macht beides, `ipc.ts:224-236`). | Ein `Store::save_deck` für alle Wege: `.part` + `rename` + Version. |
| K20 | P `agent.ts:243` ✔ | Bei Nicht-API-Fehlern wird der ganze Zug einmal wiederholt. Laut Kommentar ist die History unverändert. **Zu prüfen:** ob dabei bereits ausgeführte Tools (Export, Schreiben) erneut laufen. | Wiederholung nur für die Modellanfrage, Tool-Ergebnisse werden je `tool_use_id` gecacht und nicht erneut ausgeführt. |
| K21 | P `ffmpeg.ts`, `ipc.ts:241-262`, `engine.ts:280` | Der Export ist **nicht abbrechbar**, und ffmpeg läuft ohne Timeout. | `Cancel`-Token durch alle Exporte, ffmpeg in eigener Prozessgruppe, Abbruch → SIGTERM → SIGKILL, Fortschritt per `-progress pipe:1` (gibt es). |
| K22 | Podcast-Branch `tools.ts:1117` vs. `:1145` | `create_episode` nutzt nur Spur 1, `edit_episode` alle Spuren. Der Lint meldet dann fälschlich „ohne Transkript“. | eine Funktion `episode_transcript(&Episode)` mit `mergeTracks`. |
| K23 | Podcast-Branch `podcast.ts:85-92` | `scriptFlag`/`hasLame` cachen auch die **fehlgeschlagene** Promise dauerhaft. | `OnceCell` nur bei Erfolg setzen (wie `ffmpeg.ts:78`). |
| K24 | Podcast-Branch `tools.ts:1186-1192` | `ep` wird vor `safeParse` an Ort und Stelle verändert. | Ops auf einer Kopie, Übernahme nur bei gültigem Ergebnis (wie `edit_timeline`). |
| K25 | B `tools.ts:1` | Der Kopfkommentar sagt „Die 12 KI-Tools“, es sind 25 bzw. 27. | Tool-Liste ist Code, die Zahl kommt aus `tools().len()`, Smoke-Tests prüfen die Zahl automatisch. |

### 7.3 Doppelte Logik

| Was | Wo heute | Künftig |
|---|---|---|
| Slug (4 Varianten, ASCII vs. Unicode) | B `engine.ts:31`, `ipc.ts:768`, `mcp.ts:158`, `tools.ts:1114` | `dw-store::slug` |
| SSRF-Prüfung (3, abweichend) | B `tools.ts:1087`, `ytdlp.ts:118`, `music.ts:59` | `dw-net::check_public` |
| WCAG-Kontrast (3) + `ensureContrast` | B `lint.ts:1`, `theme-lint.ts:4`, `themes.ts:1,171` | `dw-color` |
| Tool-Wiring (3) | B `agent.ts:145`, `claude-agent.ts:128-138`, `mcp.ts:67` | `dw-tools` + Adapter |
| `freeDir` (2) | B `ipc.ts:767`, `mcp.ts:157` | `dw-store` |
| `assetUrl` (2) | B `tools.ts:55`, `webfonts.ts:16` | `dw-store::asset_url` |
| `toHex`/`hexOf` | B `lint.ts:44`, `ItemInspector.tsx:91` | `dw-color::Rgb::to_hex` |
| `mmss` | B `video.ts:203`, `PresentScreen.tsx:219` | `dw-model::time` |
| Layout-Registrierung (Schema ↔ Komponente nur über ID) | B `layouts.ts:173` ↔ `layouts.tsx:467`; `layouts-extra.ts:361` ↔ `layouts-extra.tsx:873` | ein `LayoutDef` mit Schema und Bau-Funktion |
| `shapePath` (Geometrie im Renderer) | B `slide.tsx:457-498` | `dw-scene::shapes` (auch für PPTX-`custGeom`) |
| Farbe Vorschau ≠ Export (Pro) | P `Viewer.tsx:117-131` (SVG `feComponentTransfer`) vs. `timeline-ffmpeg.ts:101` (`lut1d`) | eine LUT, die Vorschau wendet sie per wgpu-Shader auf die Videotextur an |
| `video.ts`, `sherpa.ts`, `Deckvid.tsx` in mehreren Ständen | Basis, Podcast-Branch, Pro | ein Stand im Monorepo |
| `pathOf`, `isFileUrl`, Pfadtrennung nur an `/` | B `ipc.ts:404`, Windows-Patch `winify.mjs:46-51` | `std::path` + `dw-store::platform` |

### 7.4 Workarounds, die wegfallen

| Workaround | Ort | Warum er wegfällt |
|---|---|---|
| Sequenznummer-Marker gegen alte Frames, 150 × 20 ms | `render.ts:59-91` | kein `capturePage` |
| 721-/1442-px-Fenster | `render.ts:17,104,121,143,156` | keine Fenster |
| Papiergröße in ganzen pt, Skalierungsfalle | `render.ts:127-139` | krilla setzt die Seitengröße exakt |
| Wayland → XWayland-Neustart, `--ozone-platform=x11` überall | `index.ts:25-33`, alle Skripte | kein Chromium-Druck |
| Renderer-Neustart bei OOM | `render.ts:23-28` | kein Renderer-Prozess |
| `net.fetch` gegen SIGTRAP (nur bei Download/Musik) | `download.ts:9-12` | reqwest überall |
| E2BIG / 128-KiB-Argumentgrenze | `claude-agent.ts:79,88` | Systemprompt per Datei (`--system-prompt-file`, falls vorhanden) oder stdin; Windows-Grenze 32 767 ebenso (`winify.mjs:69-74`) |
| `ELECTRON_RUN_AS_NODE` + `process.execPath` als JS-Runtime für yt-dlp | `ytdlp.ts:151-154` | yt-dlp mit Deno (gebündelt, SHA-gepinnt) oder ohne JS-Runtime |
| Preload-Retry beim Startrennen | `preload/index.ts:34-37` | kein IPC-Rennen |
| `guideParts`, `videoGuide` per String-Index | `mcp.ts:22-30,40` | `dw-guide` mit typisierten Modulen |
| `vad.front(false)` (Electron-Umgehung), stdout auf stderr | `sherpa-worker.ts:110`, `sherpa.ts:117` | kein Electron |
| pptxgenjs-Umgehungen (charSpacing 0,001, Tabellenmargin in Zoll, catAxisOrientation, XML-Escaping, Tabellen-ID-Kollision) | `export-pptx.ts:75,102,151-152,160-161`, `animations.ts:80-83` | eigener Generator |
| Regex statt XML-Parser | `animations.ts:86`, `patch-xml.ts`, `pptx-post.ts`, `pdf-boxes.ts`, `potx.ts`, `webfonts.ts:25` | Generator bzw. quick-xml/serde |
| ZIP fünfmal neu packen | §6.4 | ein Durchgang |
| `macify.mjs` (Ankertexte, Version, Signatur, Tastentexte), `winify.mjs` (Pfade, `.exe`-Suche, `windowsHide`) | Forks | `cfg(target_os)`; Tastenbeschriftung über eine Tabelle `Shortcut::label()` je Plattform (⌘/Strg, ⌫/Entf) |
| `deckwerk.sh` (baut bei Bedarf neu, Lock/Log in `/tmp`) | `scripts/deckwerk.sh` | fertiges Binary |

### 7.5 Performance und Speicher (Zielrechner: 7 GB RAM)

| # | Ort | Problem | Lösung |
|---|---|---|---|
| L1 | B `App.tsx:140-142,172-179`, `slide.tsx:713-723`, `Stage.tsx:583-586` | Jede Deck-Änderung schickt das **volle Deck** an Main und führt Autofit (bis 16 Layouts) für die Folie im UI-Thread neu aus. `onEdit` bricht die Memoisierung. | Änderungen als Patches an den Daemon, Autofit nur für betroffene Folien im Hintergrund-Thread, Ergebnis per Event. |
| L2 | B `transcribe.ts:62-66` ✔ | Naive DFT, ca. 2,4·10⁸ Schleifendurchläufe (4,8·10⁸ Multiplikationen) je 30-s-Fenster, synchron im Hauptprozess. | rustfft (Realteil-FFT 400 Punkte), Worker-Thread. Erwartet: Faktor > 100. |
| L3 | B `ffmpeg.ts:153-165` | `pcm16k` legt bei 8 h 1,8 GB Float32 an. | PCM gestreamt in 30-s-Blöcken (sherpa-Streaming bzw. VAD-Segmente), Spitzenbedarf < 50 MB. |
| L4 | B `transcribe.ts:161-165`, `sherpa.ts:75` | RAM-Wache nur über `freemem()`, ohne Spitzenbedarf. Zwei Modelle parallel (App + MCP). | Speicherbudget im Daemon: ein ASR-Modell gleichzeitig, Reservierung vor dem Laden. |
| L5 | B `export-video.ts:22`, Podcast-Stand/P `shared/video.ts:30` (`MAX_MEDIA`) | Bis zu 20 gleichzeitige Decoder, jede Medien-Einblendung ein Decoder. Bei 4K reicht der RAM nicht. | Decoder-Budget je Auflösung (1080p: 20, 4K: 6, 8K: 2), Teilstücke seriell bei Knappheit. |
| L6 | B `ffmpeg.ts:118-126` | Ein ffmpeg-Prozess je Frame, sequenziell (12 Prozesse für 12 Frames). | ein ffmpeg mit `select`-Filter für alle Zeitpunkte, oder gstreamer-Seek in einer Pipeline. |
| L7 | B `faces.ts:185` | `speakerFaces` ruft `rawFrames` je Turn mehrfach auf. | Frames einmal je Zeitpunkt holen und teilen. |
| L8 | B `twitch-chat.ts:58-59` | Das ganze Chat-JSON liegt im RAM. | serde-Streaming (`StreamDeserializer`). |
| L9 | Podcast-Branch `podcast.ts:117-162`, B `clip-lint.ts:23`, `retakes.ts:43` | O(n²)-Schleifen. `Math.max(...ws.filter())` sprengt bei 8 h die Argumentgrenze (Spread über Zehntausende). | Wörter sortiert, Binärsuche (`partition_point`), kein Spread. |
| L10 | P `useTimelinePlayer.ts:174,213`, `TimelineEditor.tsx:296-298` | `setState` je Frame führt zu 60 Re-Renders/s der ganzen Timeline, `Tracks` ist nicht memoisiert. | Spielkopf als Slint-Property, nur der Kopf und der Viewer zeichnen neu. |
| L11 | P `Scopes.tsx:21`, `Mixer.tsx:58` | rAF-Dauerschleifen auch ohne Sichtbarkeit. | nur zeichnen, wenn sichtbar und Wiedergabe läuft. |
| L12 | B `Start.tsx:132` | Bei jedem Fensterfokus wird `recent(Infinity)` geladen. | Dateisystem-Beobachter (notify) + Index. |
| L13 | B `slide.tsx:271-274`, `slide.tsx:709`, `EditorScreen.tsx:86` | Das Diagramm wird bei jedem Stilwechsel neu gebaut, der Theme-Schlüssel entsteht per `JSON.stringify` je Render. | Hash-Schlüssel, Szenen-Cache je Knoten. |
| L14 | B `render.ts:36-42` | **Eine** serielle Render-Queue für alles (Vorschau, Export, Lint). | Folien parallel rendern (rayon), Exporte mit Prioritäten. |
| L15 | B/P Start | Electron-Start über 10 s auf dem Zielrechner (P `ipc.ts:886`), plus Chromium-Fenster für jede Messung. | Native App: Start < 1 s bis zum Startbildschirm (Ziel), Schriften lazy. |

### 7.6 Hygiene

- **Veraltete Doku:** PRO.md:31-33 (Video „nur MP4/SRT, fest −14 LUFS, 1080p 30 fps“ stimmt nicht mehr), ROADMAP.md:14 (Version 0.1.6, `package.json` steht auf 0.1.10). Der Stapel-Export ist umgesetzt (P `tools.ts:947`), steht aber in der Roadmap als offen.
- **Tests außerhalb der CI:** P check-brand-lock, check-potx, check-tac, check-batch, check-phone-export, check-faces, check-sherpa, check-transcribe, check-engine-video, check-source, check-import, check-motion, check-music, check-ki-look, check-klartext, check-merge, check-connect, router-eval. B: Konnektor, Serienbrief, Link, Alt-Text (ROADMAP „Qualität“). Im Rewrite laufen alle Tests ohne Netz und Modelle in der CI, die mit Netz/Modell als `#[ignore]` + nächtlicher Job.
- **CI-Ghostscript zu alt** (P `ci.yml:23`), der PDF/X-Pfad wird nur im Fehlerfall getestet. Entfällt mit §4.4.
- **Toter Code:** Stub in `renderer/main.tsx:20-22`, veralteter Kommentar „Peaks kommen später“ (P `TimelineEditor.tsx:149`).
- **9 (B) + 3 (P) `eslint-disable exhaustive-deps`** (`InsertSearch.tsx:42,58`, `FindBar.tsx:38,43`, `ItemInspector.tsx:142`, `EditorScreen.tsx:86`, `Stage.tsx:528,581`, `LookSheet.tsx:66`; P `Deckvid.tsx:123`, `timeline/MediaPool.tsx:25`) und Effekte ohne Deps, die bei jedem Render neu abonnieren (`Stage.tsx:435-439`, `PresentScreen.tsx:334-357`). Sie entfallen mit Slints Properties und Bindings.
- **Listener-Lücke** P `Tracks.tsx:86-88`: Fenster-Listener werden nur bei `pointerup` entfernt, ein Unmount mitten im Ziehen lässt sie stehen.
- **Chat-Poll ohne Guard:** `Chat.tsx:75-80`.
- **Unbegrenzte Arbeitsordner:** `.video-tmp-*` neben dem Ziel, ältere Jobs nach 6 h gelöscht (P `export-video.ts:421,436-441`). Künftig ein Arbeitsordner je Job im Cache, aufgeräumt beim Start.
- **Logs:** Es gibt keine Logdatei, nur `console.*`. Künftig tracing + Dateilog mit Rotation, Diagnose-Export in den Einstellungen.

---

## 8. Was besser funktionieren soll (über 1:1 hinaus)

### 8.1 Folien und Exporte

| Verbesserung | Heute | Künftig | Messbar an |
|---|---|---|---|
| Vorschau = PNG = PDF | Chromium-Layout, Druck-Skalierung, Spiegel-Beschnitt | eine Szene für alle Ausgaben | Pixel-Diff Editor-Snapshot ↔ PNG ↔ PDF-Raster = 0 |
| Autofit-Tempo | bis 16 DOM-Layouts, serielle Queue | parley-Messung mit Cache, parallel je Folie | ms je Folie (Ziel < 5 ms typisch), Deck mit 30 Folien < 0,5 s |
| Echte Texte im PDF | Chromium-PDF (Text vorhanden, aber Druckskalierung) | krilla mit Subsetting, Links, Outline aus Kapiteln, optional PDF/UA | veraPDF PDF/UA-1 |
| Druck-PDF | RGB oder gs-CMYK (extern, ≥ 10.05) | PDF/X-4 nativ, reines K für schwarzen Text, exakter Farbauftrag, echte Beschnitterweiterung | gs/qpdf/Strukturtest für PDF/X-4 (veraPDF kann kein PDF/X), TAC-Test |
| PPTX-Treue | 5 ZIP-Durchläufe, Regex-Patches, Icons als PNG | ein Generator, SVG-Icons, eindeutige IDs, Sektionen immer | `verify:pptx` (LibreOffice), Abnahmefolie in echtem PowerPoint |
| Diagramme | chart.js in der Vorschau, nativ in PPTX, Optik weicht ab (README Pro: „sehen leicht anders aus“) | eigene Diagramm-Szene mit derselben Parametrisierung wie das PPTX-Diagramm | Nebeneinander-Vergleich je Typ |
| Morph in der Präsentation | View Transitions (nur Chromium) | Szenen-Interpolation wie PowerPoint (byObject) | gleiche Zuordnung `morphNames` in App und PPTX |

### 8.2 Ein Daemon statt drei Engines

- App, MCP (stdio) und App-Chat (MCP-HTTP) teilen **einen** Deck-Zustand, **einen** ASR-Worker und **eine** Export-Queue (§3.4).
- **Jobs** werden persistent: Export, Transkript, Highlights, Import und Timeline-Export bekommen IDs, Fortschritt, Abbruch und Fortsetzen nach Neustart. Ein Teilstück-Export setzt beim letzten fertigen Stück wieder an (ROADMAP Video 4: „Export abbrechen und fortsetzen“).
- **Sperren** über Prozesse hinweg per Lockfile: Import, Modell-Download, Deck-Speichern.

### 8.3 Speicherbudget und Medien

- **Budget-Verwalter im Daemon:** Er kennt den freien RAM (sysinfo) und reserviert vor schwerer Arbeit (ASR-Modell 1,3–1,5 GB, Freisteller ca. 2 GB, Decoder je Auflösung). Reicht der Platz nicht, wartet der Job oder lehnt mit klarer Meldung ab, statt im OOM zu sterben.
- **Grundlage für 4K/8K** (ROADMAP Video 3): Ausgabegröße wählbar, Quelle nie hochskaliert, HEVC ab 4K mit Fallback, Decoder-Grenze je Auflösung, Zeit- und Platzschätzung nach Pixelzahl, Hardware-Encoder (VAAPI/NVENC, auf macOS VideoToolbox) über `cfg` mit Software-Fallback.
- **Streaming-ASR** (L3): kein vollständiges PCM im Speicher, Ergebnisse erscheinen während der Erkennung.
- **ffprobe** statt stderr-Parsing (`ffmpeg.ts:101-103`), echte Bildrate der Quelle (24/25/30/50/60) statt fest 30.
- **Proxy überall:** Vorschau, Frames, Szenen und Gesichter auf 320–540 px (gibt es teils), Export in voller Größe.
- **Ein ffmpeg-Lauf für mehrere Frames** (L6), Frame-Cache wie heute (`assets/.video/<sha1>-<t>.jpg`).

### 8.4 Pro-Timeline

- **60 fps ohne Re-Render** (L10): Wiedergabe über gstreamer mit eigener Uhr, die Oberfläche bindet nur den Spielkopf.
- **Farbe identisch** in Vorschau und Export: eine 1D-LUT (`grade.ts:14-26`) als wgpu-Shader auf der Videotextur. Später 3D-LUT (`.cube` 33³) für Looks.
- **Audio-Mix nativ** (cpal): Pegel, EQ, Keys und Master-Analyser im selben DSP wie der Export (Biquads 100 Hz / 1 kHz / 8 kHz wie `timeline-ffmpeg.ts:127-152`), damit die Vorschau so klingt wie der Export.
- **Austausch:** xmeml mit Pegel/Zuschnitt/PiP (K18) und neu FCPXML 1.11 für Final Cut (PRO.md Roadmap 5). Audio-Überblendung als echtes `acrossfade` statt Gain-Rampe.
- **xfade-Versatz behoben** (K14), `estimate` mit Deliver-fps (K15).

### 8.5 Editor und Bedienung

- **Undo als Patch-Historie** (statt 100 kompletter Deck-Snapshots, `App.tsx:36,151-164`), mit Zusammenfassen gleicher Aktionen (`tag`), KI-Runde als ein Schritt, sync-fest (K6).
- **Autosave** ohne Datenverlust: Patch-Log (Write-Ahead) im Deck-Ordner, `deck.json` alle 1,5 s atomar (wie heute), Wiederherstellung nach Absturz.
- **Barrierefreiheit:** Slint-Accessibility für alle Bedienelemente. Auf dem Canvas bekommt jedes Element einen AccessKit-Knoten (Rolle, Name aus Slot oder Text). Größe ändern, Drehen und Zuschneiden gehen per Tastatur, Overview mit Pfeilnavigation.
- **i18n-Struktur:** UI-Texte über fluent (`.ftl`, Deutsch als einzige Sprache zum Start). Damit fällt auch die Tastentext-Ersetzung aus `macify.mjs` weg.
- **Rechtschreibung** nativ (spellbook mit Hunspell-de_DE) für Folientexte und Notizen.
- **Kein Neuladen der Decks bei jedem Fokus** (L12), Startseite mit Index und Vorschaubildern aus dem Cache.

### 8.6 Betrieb und Plattformen

- **Linux, macOS und Windows nativ aus einem Code.** Windows läuft heute laut Pro-README nur über WSL, die Fassung `deckwerk-windows` hat 0.1.0 und keine Video-Funktion.
- **Pakete:** Linux AppImage + .deb/.rpm (cargo-packager 0.11), macOS signiertes und notarisiertes .dmg (Developer-ID statt Ad-hoc `identity: '-'`, kein `xattr`-Umweg), Windows MSI/NSIS ohne Admin.
- **Größe:** Ohne Chromium und Electron fallen ca. 150–200 MB weg. Ziel: Basis-Paket < 60 MB. ffmpeg und Modelle werden wie heute bei Bedarf geladen (SHA-256-gepinnt).
- **Signierte Updates** (S6), Release-Kanal stabil/beta.
- **Logs und Diagnose:** tracing mit Dateirotation, Diagnosepaket ohne Secrets für Fehlerberichte.
- **MCP ohne Bildschirm:** `deckwerk mcp` braucht kein Xvfb mehr, weil kein Chromium läuft (heute `E2E_HEADLESS=1` und xvfb in der CI).

---

## 9. Crate-Auswahl (Stand 17.10.2026, `cargo search`/`cargo info`)

| Bereich | Crate | Version | Lizenz | Reife | Lücke / Fallback |
|---|---|---|---|---|---|
| GUI | **slint** | 1.18.1 | GPL-3.0 / Royalty-free / kommerziell | stabil (1.x), Features `renderer-vello`, `unstable-wgpu-30`, `accessibility`, `unstable-fontique-011` | Fallback **iced** 0.14.0 (MIT, wgpu/tiny-skia, canvas). gpui 0.2.2 nicht (keine Barrierefreiheit, API instabil) |
| Fenster/Plattform | winit (über Slint), rfd 0.17.2 (Dialoge), muda 0.21.2 (Menüs), arboard 3.7.0 (Zwischenablage), notify-rust 4.18.2 | – | MIT/Apache | stabil | – |
| GPU | wgpu | 30.0.1 | MIT/Apache | stabil | – |
| 2D-Rendering GPU | vello | 0.11.0 | MIT/Apache | in Entwicklung (Compute-GPU nötig) | Fallback vello_cpu → Textur |
| 2D-Rendering CPU | **vello_cpu** | 0.3.0 | MIT/Apache | reifster vello-Zweig, Filter/Blend/Clip/Mask belegt | tiny-skia 0.12.0 |
| Layout | **taffy** | 0.15.0 | MIT | stabil (Flex/Grid/Block) | – |
| Text | **parley** | 0.12.0 | MIT/Apache | aktiv, Rich-Text-Editor nur Plain | eigener Rich-Text-Editor auf parley |
| Schriften | fontique 0.12.0, skrifa 0.48.0, ttf-parser 0.25.1, harfrust 0.14.0, allsorts 0.17.0 (Subsetting) | – | MIT/Apache | stabil | EOT-Writer selbst (wie heute) |
| Silbentrennung | hypher | 0.1.8 | MIT/Apache | stabil, `de.bin` enthalten | – |
| SVG | usvg / resvg | 0.48.1 | MIT/Apache | stabil | – |
| Geometrie | kurbo 0.13.1, lyon 1.0.19 | – | MIT/Apache | stabil | – |
| PDF schreiben | **krilla** | 0.8.2 | MIT/Apache | stabil (Typst-Export), CMYK + ICC + Trim/Bleed + PDF/A + PDF/UA | PDF/X-OutputIntent per lopdf 0.45.0 oder Patch |
| PDF lesen/rastern | lopdf 0.45.0, hayro 0.8.0, pdf-extract 0.12.1 (Quelltext), pdfium-render 0.9.4 (optional) | – | – | – | poppler bleibt als Option |
| Farbmanagement | **lcms2** | 6.2.0 | MIT | stabil (Little CMS) | qcms 0.3.0 |
| Farben | palette | 0.7.7 | MIT/Apache | stabil | eigene OKLab/CIEDE2000 (klein) |
| Bilder | image 0.25.10, zune-jpeg 0.5.16-rc2, image-webp 0.2.4, png 0.18.1, fast_image_resize 6.1.0, oxipng 10.2.1, kamadak-exif 0.6.1 | – | MIT/Apache | stabil | – |
| QR | qrcode | 0.14.1 | MIT/Apache | stabil | – |
| Icons | lucide-svg 0.1.1 / lucide-icons 1.58.0 | – | ISC | – | eigener Build aus lucide-static |
| XML/ZIP | quick-xml 0.42.0, zip 9.0.5 | – | MIT | stabil | – |
| DOCX | eigener Generator (quick-xml); docx-rs 0.4.22 als Option | – | MIT | – | – |
| Excel lesen | calamine | 0.36.1 | MIT | stabil | – |
| Serialisierung/Schema | serde, serde_json 1.0.154, schemars 1.2.3, garde 0.23.0, jsonschema 0.59.0 (Tests) | – | MIT/Apache | stabil | zod-`.describe()` → `///`-Doc-Kommentare |
| Async/HTTP | tokio 1.53.3, reqwest 0.13.5, axum 0.8.9, hyper 1.12.0, rustls (stabile 0.23.x; 0.24 ist dev) | – | MIT/Apache | stabil | – |
| MCP | **rmcp** | 3.5.1 | MIT | offizielles SDK | – |
| Anthropic/OpenAI | eigener Client (reqwest + SSE) | – | – | – | kein offizielles Rust-SDK |
| Secrets | keyring | 4.2.0 | MIT/Apache | API-Umbau in 4.x | Linux ohne Secret Service: verschlüsselte Datei (age) |
| Speicher | redb 4.4.0 oder rusqlite 0.40.2 | – | – | stabil | Jobs, Indizes |
| ONNX | ort | 2.0.0-rc.14 (ONNX Runtime 1.31) | MIT/Apache | RC, verbreitet | – |
| ASR | sherpa-onnx | 1.13.8 | Apache | Rust-Wrapper (heute auch Node 1.13.8) | – |
| FFT | rustfft | 6.4.1 | MIT/Apache | stabil | – |
| Video-Wiedergabe | gstreamer / gstreamer-play | 0.25.4 / 0.25.0 | MIT/Apache (GStreamer LGPL) | stabil | ffmpeg-next 9.0.0 für Dekodierung |
| Audio | cpal 0.18.2, rodio 0.23.0, symphonia 0.6.1 | – | – | stabil | – |
| ffmpeg | CLI über `std::process` (wie heute), ffmpeg-sidecar 2.6.0 optional | – | – | – | – |
| Rechtschreibung | spellbook | 0.4.2 | MPL-2.0 | jung | zspell 0.5.5 |
| i18n | fluent-bundle | 0.16.0 | MIT/Apache | stabil | – |
| Dateien beobachten | notify | 9.0.0-rc.5 (bzw. 8.x stabil) | – | – | – |
| Hash/IDs | sha2 0.11.1, uuid 1.28.0 | – | – | stabil | – |
| TLS-Zertifikate (Fernbedienung) | rcgen | 0.14.10 | MIT/Apache | stabil | – |
| Migration | napi | 3.14.2 | MIT | stabil | – |
| Paketierung | cargo-packager 0.11.8, cargo-dist 0.32.0 | – | – | – | – |
| Tests | insta | 1.49.0 | Apache | stabil | – |
| Logs | tracing | 0.1.44 | MIT | stabil | – |

**Rust-Toolchain:** stabil ≥ 1.92 (MSRV von krilla und Slint). Lokal ist 1.96.0 installiert.

**Lizenzlage:** Deckwerk ist AGPL-3.0-only. Slint (GPL-3.0) ist mit AGPL-3.0 kombinierbar (GPLv3 §13). Für eine spätere kommerzielle Pro-Lizenz gibt es Slints Royalty-free- bzw. kommerzielle Lizenz. GStreamer-Plugins (LGPL, teils GPL/patentbelastet bei Codecs) müssen je Plattform geprüft werden. ffmpeg-static mit libx264 ist GPL, das ist heute schon so.

---

## 10. Kompatibilität und Verträge

1. **`deck.json` bleibt formatgleich.** serde mit `#[serde(default)]` und unbekannten Feldern als `extra: Map` (Durchreichen statt Verwerfen), damit Pro-Felder (`chart.link`, `brand.lock`, Timeline, Podcast) in jeder Edition erhalten bleiben (README Pro „Verträglichkeit“). Neu ist eine Prüfung beim Laden (S1). Versionsfeld `v` für spätere Migrationen.
2. **`Measured`/`El` JSON-gleich** (§6.1). Es dient als Schnittstelle der Differenztests.
3. **PPTX-Objektnamen** `dw:<slot>` und `!!dw:` (Morph) bleiben. Externe Werkzeuge und Morph hängen daran.
4. **KI-Werkzeuge:**
   - Namen, Parameter und Beschreibungen bleiben (25 B / 27 P).
   - Schemas entstehen per schemars aus denselben Rust-Typen, die auch validieren. Damit gibt es **ein** Schema für App-Chat, MCP und UI-Formulare (Pro `ContentForm.tsx:69` baut heute per `z.toJSONSchema`).
   - Rückgabetexte bleiben gleich, z. B. „Folie n (id, layout): OK|k FEHLER · Autofit head/body · Überlauf…“ (P `tools.ts:382-404`), ebenso Bilder als Zusatzblöcke und Jobs mit „läuft noch (x %)“ nach 240 s.
   - Tool-Zahlen prüfen die Smoke-Tests automatisch (heute muss man sie in drei Dateien von Hand anpassen).
5. **MCP:** stdio-Server `deckwerk mcp` (statt `electron . --mcp`), Intro < 2 KB (Claude Code kürzt danach), wichtige Regeln auch in Tool-Beschreibungen und Ergebnissen. Die Einrichtung (`setup:mcp`) trägt den neuen Befehl in `~/.claude.json`, `~/.codex/config.toml` und `~/.vibe/config.toml` ein (per toml_edit/serde_json, nicht von Hand).
6. **Skills** `skills/deckwerk/SKILL.md` und `skills/deckwerk-pro/SKILL.md` bleiben. „Eingerichtet“ gilt weiter nur bei Inhaltsgleichheit.
7. **Datenordner:** `~/Deckwerk` bzw. `~/DeckwerkPro`, `<titel>/deck.json`, `versions/` (10 min, max. 100), `assets/`, `assets/.video/<sha1>…`, `brand.json`, `hausstil.md`, `kunden/<name>/` (P), `.sync-state.json`. Geteilt sind `~/Deckwerk/models/` und `fonts/`. `DECKWERK_HOME` gilt weiter für Tests.
8. **appData:** `appData/deckwerk[-pro]/` mit `setup-done`, `asr-model`, `spellcheck-off`, `phone-off`. Die verschlüsselten `.bin`-Dateien (safeStorage) werden **einmalig migriert**: Die alte App exportiert sie per napi-Hilfsbefehl oder die neue App fragt die Schlüssel neu ab. Danach liegen sie im keyring.
9. **Modellwahl** (`shared/models.ts`): gespeicherte IDs `claude-*`, `vibe:<alias>`, `codex:<slug>`, `routeOf` bestimmt den Weg. Diese IDs nie durch `modelOf()` schicken (Regel aus CLAUDE.md).
10. **Website:** `website/scripts/folien.mjs` rendert Beispiele mit Deckwerk. Künftig ruft es `deckwerk render examples/*.json --png` auf (kein Electron nötig).

---

## 11. Teststrategie

### 11.1 Ebenen

1. **Einheitentests** je Crate (`cargo test`), ohne Netz und ohne Modelle.
2. **Snapshot-Tests** mit insta für PPTX-XML-Teile (normalisiert), DOCX, PDF-Struktur, ffmpeg-Filtergraphen, Tool-Schemas und Tool-Berichte.
3. **Differenztests TS ↔ Rust** (nur während der Migration): Die alte App (Node) und dw-napi bekommen dieselben Eingaben (`examples/*.json`, Samples, Fixtures) und müssen gleiche Ausgaben liefern: Lint-Befunde, `resolveTheme`, `morphNames`, `autoCuts`, `clipSegs`, Graphen.
4. **Layout-Referenzen aus Chromium** (§4.6).
5. **Treue-Tests:** `deckwerk verify` rendert die PPTX mit LibreOffice (Flatpak, Gelasio-Alias wie heute) und vergleicht mit dw-raster. PDF wird mit hayro bzw. pdftoppm gerastert und gegen die PNG verglichen. veraPDF prüft PDF/A und PDF/UA; PDF/X-4 per gs/qpdf und Strukturtest (siehe §4.4).
6. **E2E:** `dw-mcp` gegen einen echten Daemon (headless), App-Smoke per Slint-Testing-Backend (`i-slint-backend-testing`), Klickpfade Start → Deck → Export.
7. **Opt-in** (`#[ignore]`, nächtlich): Netz (yt-dlp, Openverse, Unsplash), Modelle (sherpa, Whisper, YuNet, BiRefNet), `claude -p`.
8. **Stresstest** `deckwerk check` (Layout × Variante × Beispiel × Theme × Format) ersetzt `npm run check:layouts`. Parallel, weil kein Chromium: Ziel < 5 min statt ~1 h.

### 11.2 Skript → Test

| Heute | Künftig |
|---|---|
| `agent-smoke`, `mcp-smoke` | `dw-tools/tests/smoke.rs`, `dw-mcp/tests/smoke.rs` (Mock-Engine) |
| `mcp-e2e` | `dw-mcp/tests/e2e.rs` (echter Daemon, headless) |
| `validate-examples`, `story-check` | `dw-model/tests/{examples,story}.rs` |
| `check-lint-profile`, `check-ki-look`, `check-klartext`, `check-theme-lint`, `check-theme-tokens`, `check-hidden`, `check-find`, `check-merge`, `check-handout`, `check-motion`, P `check-brand-lock`, `check-lint-panel` | `dw-lint/tests/*` |
| `check-brand`, `check-looks`, `check-recolor`, `check-gradient`, `check-webfonts`, P `check-theme-editor` | `dw-theme/tests/*` |
| `check-layers`, `check-free-text`, `check-table`, P `check-layout-switch` | `dw-scene/tests/*` |
| `check-animations`, `check-docx`, `check-pdf-boxes`, `verify-pptx`, P `check-print`, `check-tac`, `check-potx`, `check-xlsx` | `dw-pptx`, `dw-docx`, `dw-pdf`, `dw-office-in` Tests |
| `check-video`, `check-engine-video`, `check-import`, `check-music`, `check-faces`, `check-sherpa`, `check-transcribe` | `dw-media`, `dw-video`, `dw-asr`, `dw-vision` Tests (teils `#[ignore]`) |
| P `check-timeline*` (8), `check-grade`, `check-color-wheel`, `check-mixer`, `check-scopes`, `check-media`, `check-xmeml*`, `check-video-tools`, `check-batch` | `dw-timeline/tests/*`, UI-Logik in `dw-app/tests` |
| P `check-router`, `check-guide-modules`, `check-cli-prompt`, `router-eval` | `dw-router`, `dw-guide`, `dw-cli-agent` Tests |
| `check-sync`, `check-accounts`, `check-update`, `check-connect`, `check-source` | `dw-sync`, `dw-cli-agent`, `dw-update`, `dw-office-in` Tests |
| P `check-clients`, `check-phone`, `check-phone-export` | `dw-store`, `dw-phone` Tests |

### 11.3 CI

- Matrix Linux (ubuntu-24.04), macOS (arm64) und Windows (x64): `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace`, beide Editionen (`--features pro`).
- Render-Job: `deckwerk render examples/pitch.json` → PPTX/PDF/PNG + Lint, Artefakte hochladen.
- Treue-Job (Linux): LibreOffice + veraPDF (PDF/A, PDF/UA) + gs/qpdf (PDF/X-4).
- Größenbudget je Paket, Installer-Test (installieren → `deckwerk mcp` → deinstallieren), wie heute.
- Während der Migration läuft die alte CI (`npm run …`) parallel weiter, bis P7.

---

## 12. Phasenplan (Strangler)

Grober Aufwand für eine Person in Vollzeit mit KI-Unterstützung. Die Zahlen sind Schätzungen, keine Zusagen. Jede Phase endet mit lauffähiger Software.

| Phase | Umfang | Ergebnis | Abnahme | Aufwand |
|---|---|---|---|---|
| **P0 Spikes** | (a) `dw-scene` für `cover`, `bullets`, `two-column` in 16:9 und A4; (b) Slint-Fenster mit vello-Canvas, Zoom, Auswahl, Inline-Texteditor mit IME (Wayland, X11, macOS, Windows); (c) krilla-PDF/X-4 mit lcms2; (d) gstreamer-Video in Slint-Textur; (e) dw-pptx für die drei Layouts | Entscheidungsvorlage Slint ↔ iced, Machbarkeit Rendern ohne Browser | (a) Referenzvergleich §4.6 grün für 3 Layouts × min/typ/max; (b) Tippen mit Umlauten und IME ohne Verzögerung, 60 fps bei Zoom; (c) PDF/X-4-Strukturtest + gs-CMYK-Rendering bestanden; (d) 1080p30 flüssig; (e) LibreOffice-Vergleich wie heute. **Abbruchkriterium:** Scheitert (a) oder (b) grundsätzlich, wird Plan B geprüft (§13) | 3–4 Wochen |
| **P1 Kern per napi** | dw-model, dw-color, dw-theme, dw-lint, dw-typo, dw-merge; dw-napi bindet sie in Electron ein und ersetzt die TS-Fassungen schrittweise | Electron-App läuft mit Rust-Kern | Differenztests grün, `npm run smoke`, Selbsttests grün | 3–4 Wochen |
| **P2 Folien-Engine** | alle 41 + Pro-Layouts, Varianten, Frames, Formate, freie Elemente, Icons, QR, Diagramme, Tabellen, Masken, Effekte; Referenzen erzeugen | `deckwerk render` erzeugt PNG ohne Chromium | §4.6: alle Kombinationen grün, Stresstest grün | 8–12 Wochen |
| **P3 Exporte** | dw-pptx, dw-docx, dw-pdf (inkl. Druck, Beschnitt, PDF/X-4), dw-raster, dw-md, Schriften/EOT | alle Exporte aus Rust; Electron nutzt sie per napi | verify:pptx, check-docx, PDF/X-4, Abnahmefolie in PowerPoint | 5–7 Wochen |
| **P4 Daemon, KI, MCP** | dw-store, dw-net, dw-daemon, dw-tools (alle 27), dw-agent, dw-cli-agent, dw-router, dw-guide, dw-mcp, dw-sync, dw-update | `deckwerk mcp` ersetzt `electron . --mcp`, Electron-App spricht mit dem Daemon | mcp-e2e headless, agent-smoke, claude-smoke (manuell), sync- und update-Tests | 5–7 Wochen |
| **P5 Medien** | dw-media, dw-asr, dw-vision, dw-video, dw-podcast, dw-timeline, dw-phone | alle Video-, Podcast- und Timeline-Exporte aus Rust | check-video, check-engine-video, check-timeline*, Podcast-Fixtures, A/V-Sync-Test (K14) | 6–8 Wochen |
| **P6 Slint-App** | Start, Editor (Stage, Inspector, Ebenen, Filmstreifen, Übersicht), Sheets, Chat, Präsentation (Referentenansicht, Publikum, Fernbedienung, Morph), Deckvid, Clip-Cutter, Podcast, Pro-Timeline (Schnitt, Farbe, Ton, Ausgabe), Einstellungen, Editionen | native App mit Funktionsgleichheit | Klickpfade aller Screens, Barrierefreiheits-Check (Screenreader), Nutzertest | 12–16 Wochen |
| **P7 Umstellung** | Electron, React und Node-Abhängigkeiten entfernen, Paketierung für drei Plattformen, Migration von Einstellungen und Schlüsseln, Forks `deckwerk-macos`/`-windows` einstellen, Doku (README, CLAUDE.md, Skill) | Release 1.0 nativ | Installer-Tests auf drei Plattformen, Datenmigration getestet, alte Decks öffnen | 2–3 Wochen |

**Summe grob:** 44–61 Wochen. Parallelisierbar sind vor allem P3/P4/P5 (unabhängige Crates) und Teile von P6, sobald P2 steht.

**Feature-Politik während der Migration:** Neue Funktionen kommen nur noch, wenn sie im Rust-Kern landen (ab P1 für Logik, ab P2 für Layouts). Für Fixes in der alten App gilt die Regel: erst prüfen, ob die Stelle schon portiert ist.

---

### 12.1 Stand P0 (18.10.2026, Branch `feat/rust`)

| Spike | Ergebnis |
|---|---|
| (a) Folien-Engine ohne Browser | **bestanden.** `dw-scene` trifft Chromium bei 27/27 Folien (cover, bullets, two-column × alle Varianten × min/typ/max): gleiche Autofit-Stufe, Zeilenzahl, Schriftgröße, Zeilenhöhe, Boxen ≤ 1 px. `text-wrap: pretty/balance` als Nachbildung von Blinks ScoreLineBreaker. Danach auf alle 20 Themes, alle Frames und Formate erweitert; 446 Chromium-Referenzen für 43 Layouts liegen in `tests/refs/`. |
| (b) Slint-Editor | **teilweise.** Slint-Fenster mit echten Folien, Auswahl per Hit-Test, Textbearbeitung über ein Slint-Overlay, Live-Neusatz und atomares Speichern laufen (`crates/dw-app-spike`). Zwei Befunde: (1) Rastern über vello_cpu → Bild kostet im Release geschätzt 150–250 ms je Folie (1×), zu langsam für flüssiges Tippen – der Editor braucht `renderer-vello`/wgpu oder Teil-Neurastern. (2) Das Overlay nutzt Slint-Text statt parley und bricht anders um; die Lösung ist ein parley-Editor auf dem Canvas mit eigenem Caret und IME-Preedit (größtes UI-Risiko, §13). Echte IME-Komposition unter Wayland ist noch per Hand zu prüfen. |
| (c) PDF/X-4 ohne Ghostscript | **bestanden** (Strukturtest, gs-CMYK-Rendering, qpdf): FOGRA39-OutputIntent, schwarzer Text als reines K, Trim/Bleed nativ; PDF ↔ PNG mittlere Abweichung 0,44/255. |
| (d) gstreamer-Video in Slint | offen. |
| (e) Eigener PPTX-Generator | **bestanden** und vollständig: Text, Formen, Bilder, Tabellen, Übergänge inkl. Morph, Animationen, Sektionen, Agenda-Links, native Diagramme mit xlsx, Masken, Effekte, Medien, EOT-Schriften; Differenztests gleich TS. |

Zusätzlich fertig: `dw-model`, `dw-color`, `dw-theme` (129/129 Themes, 467/467 Token-Sätze gleich TS), `dw-lint` (alle Prüfregeln, > 4 400 Fälle gleich TS), `dw-raster`, `dw-pdf`, `dw-cli` (`deckwerk render`: PNG, PDF, PPTX für ein Deck in 0,6 s ohne Electron). Deckwerk und Deckwerk Pro sind auf `feat/rust` in einem Code vereint (Pro als Edition `DW_EDITION=pro`), alle Feature-Branches und liegengebliebene Arbeit sind integriert.

## 13. Risiken und offene Entscheidungen

| Risiko | Wahrscheinlichkeit / Wirkung | Gegenmaßnahme |
|---|---|---|
| **Rich-Text-Bearbeitung auf dem Canvas** (Cursor, Auswahl, IME, fett/kursiv/Link, Rechtschreibung) | hoch / hoch | P0-Spike (b). parley `PlainEditor` als Basis plus eigene Spannen. Ausweichweg: Bearbeitung in einem Slint-`TextEdit`-Overlay mit eigenem Rich-Text-Modell, Ergebnis wird sofort neu gesetzt. |
| **41+ Layouts originalgetreu** | mittel / hoch | Referenztests (§4.6), Layout für Layout, Fortschrittsbericht. Layout-Helfer (`header`, `cols`, `points`, `frame`) zuerst. |
| **Slint-Canvas-Einbindung / vello-GPU-Reife** | mittel / mittel | `unstable-wgpu-30` und `renderer-vello` sind als „unstable“ markiert. Ausweichweg: vello_cpu rendert in einen Pixelpuffer (`SharedPixelBuffer`), bei 1280×720 × 2 schnell genug für den Editor. Alternative: iced. |
| **Diagramm-Optik ohne chart.js** | mittel / mittel | Diagramm-Szene parametrisch wie PPTX; Vergleichsbilder je Typ. |
| **Textumbruch weicht von Chromium ab** (pretty, Kerning, Silben) | mittel / mittel | Referenztests mit Toleranz. Wichtiger als Chromium-Gleichheit ist PowerPoint-Gleichheit, die über Metrik-Zwillinge und `WRAP_SLACK` gesichert ist. |
| **Video-Wiedergabe gstreamer auf drei Plattformen** (Plugins, Codecs, Bündelung) | mittel / mittel | P0-Spike (d). Ausweichweg: ffmpeg-next-Dekodierung in Textur + cpal. |
| **Morph ohne View Transitions** | niedrig / niedrig | Szenen-Interpolation ist einfacher als View Transitions und passt besser zu PowerPoint. |
| **Feature-Stopp** (mehr als ein Jahr Parallelbetrieb) | hoch / mittel | Strangler: Electron-App bleibt nutzbar und bekommt Rust-Teile früh (P1, P3, P4). Neue Funktionen nur im Kern. |
| **Lizenzen** (Slint GPL, GStreamer-Plugins, fsType) | niedrig / mittel | Slint-GPL ist mit AGPL kompatibel. Für Pro-Kommerz die Slint-Lizenz prüfen. fsType §7.1 S14. |
| **Migration der verschlüsselten Einstellungen** (safeStorage → keyring) | niedrig / niedrig | Exporthilfe in der letzten Electron-Version oder Neueingabe. |
| **ONNX-Runtime-Bündelung** (ort lädt ONNX Runtime, Prebuilds brauchen x86-64-v3) | mittel / mittel | dynamisches Laden der mitgelieferten `libonnxruntime`, wie heute bei sherpa. Fallback ohne AVX2 prüfen. |

**Offene Entscheidungen:**

1. **Slint oder iced** nach P0 (Empfehlung: Slint, wegen Barrierefreiheit und vello/fontique-Nähe).
2. **Ab wann gilt Feature-Stopp** in der Electron-App (Empfehlung: ab Ende P1 für Logik, ab Ende P2 für Layouts)?
3. **Android/iOS später** über dieselben Crates (uniffi), oder bleiben sie eigene Projekte? (Dieser Plan hält die Crates dafür frei: kein Desktop-Code im Kern.)
4. **Cloud** (`deckwerk-cloud`) später mit dw-model/dw-lint als WASM oder axum-Server, auch das gehört nicht zu diesem Plan.
5. **Name des Monorepos:** `deckwerk` mit neuer Struktur auf `master` (Empfehlung), Electron-Stand als Tag `electron-final` sichern.

---

## 14. Anhang

### 14.1 Geprüfte Stände

- Deckwerk `f2bcddc` (`feat/mensch-statt-ki`, 95 Commits vor `master` `852aa91`).
- Deckwerk Pro `307a4b5` (`main`).
- Podcast-Branch `feat/podcast-aktuell` `28a8738` (für Video/Podcast-Logik).
- Andere Sessions waren beim Schreiben fertig, ihre Arbeit ist in diesen Ständen enthalten.

### 14.2 Wichtige Konstanten zum Mitnehmen

| Konstante | Wert | Ort |
|---|---|---|
| `SCALE` | hero 200/170/144/120, display 76/66/58/50, statement 50/44/38/33, h1 42/38/34/30, kpi 72/62/54/46, h2 26/24/22/20, h3 22/20/18/17, body 24/22/20/19, label 19/18/17/16, small 17/16/15/14, eyebrow 14/14/13/13, footer 13 | `shared/themes.ts:70-82` |
| `COMBOS` | 16 Paare (head 0–3 × body 0–3), sortiert nach Summe, bei Gleichstand head zuerst klein | `renderer/measure.ts:7` |
| Profilfaktor | social = Breite/750; doc = min(0,65, Breite/1221); Untergrenze 12 px bei k < 1 | `measure.ts:12-15` |
| Zeilentoleranz | 3 Layout-px | `measure.ts:21` |
| Render-Zoom | 2 (PNG = 2× Foliengröße) | `render.ts:8` |
| Versionen | alle 10 min, max. 100 je Deck | `ipc.ts:27-36` (P `:38-47`) |
| Autosave | 1,5 s Debounce, atomar `.part` + `rename` | `App.tsx:124-130`, `ipc.ts:210-219` |
| Undo | 100 Stände, gleiche `tag` zusammengefasst | `App.tsx:151-164` |
| Jobs | 240 s warten, dann „läuft noch“, nach 600 s vergessen | P `tools.ts:448-478` |
| ASR | Chunk 300 s, Diarisierung je 30 min, Worker-Leerlauf 60 s, 1,5 GB Mindest-RAM | `video-cache.ts:6`, `engine.ts:121`, `sherpa.ts:70,75` |
| Video | PAD 0,15 s, MAX_PARTS 100, LONG_VIDEO 600 s, Decoder-Gruppe 20, MAX_MEDIA 8, Lautheit −14 LUFS (Podcast −16) | B `shared/video.ts:35-39`, `export-video.ts:22`; `MAX_MEDIA` Podcast-Stand/P `video.ts:30` |
| Timeline (P) | 12 Spuren, 400 Clips, Speed 0,25–4, Fade ≤ 10 s, Xfade ≤ 5 s, fps 10–120, LUFS −30…−9, Overlays 60, Subs 2 000, Marker 200 | P `timeline.ts:30-47`, `layouts-timeline.ts` |
| Limits Eingaben | Musik 50 MB, Bilder 15 MB, yt-dlp ≥ 3 GB frei / ≤ 20 GB / ≤ 12 h, Video ≤ 48 h, xlsx 50 MB / 30×30 | P `music.ts:15`, `tools.ts:1294`, `ytdlp.ts:148,159`, `xlsx-link.ts:7-9` |

### 14.3 Was dieses Dokument bewusst nicht entscheidet

- Neue Funktionen aus ROADMAP.md (Verlauf-Editor, Lineale, Quiz, Live-Chat-Overlay, Streamer-Paket …). Sie kommen nach P2 bzw. P5 direkt im Rust-Kern.
- Gestaltung: Der Gestaltungskurs (flach, linksbündig, eine Akzentfarbe, keine Deko als Standard) gilt unverändert. Die Slint-Oberfläche übernimmt die heutige Gestaltung (`shell.css`) und erfindet keinen neuen Stil.
