# Deckwerk vs. Canva: Was fehlt und wie wir es bauen

Stand: 27.09.2026. Grundlage: Code in `src/` (Phase 4 umgesetzt, Freiform-Canvas vorhanden), die Renderings unter `exports/` (Ortho-Bot, Q3-Update, Strategie 2027, Café Kollektiv, Freies Design) und eine Recherche zu Canva, Gamma und Beautiful.ai (Quellen am Ende).

> **Kurswechsel (27.09.2026): Zurückhaltung statt Canva-Deko.** Der Nutzer empfand die Decks als „KI-Look“. Die Recherche (Apple-Keynotes, YC/Kevin Hale, McKinsey/BCG, Presentation Zen, Duarte Glance Test, Swiss Style, Storytelling with Data; Kritiken zu „AI slop design“ u. a. [925studios](https://www.925studios.co/blog/ai-slop-design-tells), [Plus AI](https://plusai.com/blog/how-to-make-ai-slides-that-dont-look-like-ai-slop/), [avoid-ai-design](https://github.com/funboy322/avoid-ai-design)) zeigt: Karten im Raster, Icon-Kacheln, Akzentbalken, Versalien-Eyebrows mit Strich, Blobs/Glow, Verläufe, Creme + Terrakotta und Säuregrün sind genau die Muster, an denen man generierte Folien erkennt. Deshalb:
> - Neue Katalog-Themes `beratung` (Default), `keynote`, `schweiz`, `redaktion`, `zen`: flach, `decor: none`, eine Akzentfarbe, IBM Plex / Source Serif 4. Alte Themes laden weiter (`legacy`), werden aber nicht mehr angeboten.
> - Engine: keine Kartenschatten, kein Auto-Kartenraster bei bullets, kpi-grid standardmäßig als Zahlenzeile, Eyebrow ruhig ohne Strich, Icons ohne Kachel, Prozess/Zeitstrahl als offene Spalten, keine Verläufe auf Akzentflächen.
> - Guide §6 neu („Was KI-Folien verrät“), Lint `cards`, `icons`, `breath`, `density` ab 50 Wörtern.
> - Die Canva-Mittel unten (Sticker, Grafiken, Motive, Texteffekte, Shuffle) bleiben, werden aber nur auf ausdrücklichen Wunsch eingesetzt.
> - **Eigene Designs (01.10.2026):** Die KI entwirft wieder pro Deck ein eigenes Theme, jetzt mit Struktur statt nur Farbe: `titleSize` (Plakat-Titel), `titleWeight` (regular/bold), `rule` (Kopflinie oben bzw. Trennlinie unter dem Kopf), `sectionTone` (Kapitel als Fläche, invertiert oder ruhig). Die Katalog-Themes nutzen dieselben Hebel und dienen als Vorbilder (Guide §6). Leitplanken der Engine: Grund wird auf fast Weiß/fast Schwarz gedämpft, Text nie reines Schwarz, Tönungen in oklab gemischt.

---

## 0. Umsetzungsstand (27.09.2026)

| Paket | Stand | Wo |
|---|---|---|
| 1.1 Kompositionen `frame` (top, split, band, center) | fertig, Lint `monotone`, Stresstest über alle erlaubten Frames | `deck.ts` FRAMES, `slide.tsx` Frame, `slide.css` fr-*, `tools.ts` checkFrame |
| 1.2 Layout-Politur | fertig: kpi-grid `focus` + Variante `plain`, Donut schmaler, Galerie-`look`, Prozess/Zeitstrahl größer | `layouts.tsx`, `slide.css` |
| 1.3 Tranche A | fertig: table, big-number, icon-grid, pros-cons, problem-solution, team | `layouts-extra.ts/.tsx/.css` |
| 1.3 Tranche B | fertig: pricing, funnel, market-size, logos; `closing` hat QR statt eigenem contact-Layout; agenda-visual weggelassen | dto. |
| 1.4 Formen und Linien | fertig: 13 neue native Formen, Linien mit Pfeil/Spitze/Punkt, Strichart | `slide.tsx` shapePath, `export-pptx.ts` SHAPE_TYPE/lineOf |
| 1.4 SVG-Grafikbibliothek | fertig: 8 handgezeichnete Grafiken (Kringel, Unterstreichung, Kreis-Markierung, Pfeil, Strahlen, Wellen, Funkeln, Klecks) als Item `graphic`, auch in `decorate_slide`; Illustrationssets weggelassen | `items.ts` GRAPHICS |
| 1.5 Bildrahmen | fertig: circle, arch, hexagon, diamond, octagon, star, heart; nativ als Bildgeometrie | `useMask`, `patch-xml.ts` maskShape |
| 1.5 Zuschneiden, Grids, Freisteller | von deckwerk-f3/89 umgesetzt | – |
| 1.6 Stile mischen | fertig: `theme.shuffle` (6 Farbvarianten), `theme.fonts` (11 Paare), per `update_deck` | `themes.ts` shuffled/FONT_PAIRS |
| 1.6 Drei Vorschläge | von deckwerk-44 umgesetzt (`propose_looks`) | – |
| 1.6 „Andere Gestaltung“ pro Folie | fertig: Knopf im Inspector schaltet Variante × Komposition × Ton durch; „Farben/Schriften mischen“ im Look-Panel | `layouts.ts` nextLook, `LookSheet.tsx` |
| 1.7 Folienhintergrund mit Verlauf | fertig (`bg.gradient`, `bg.angle`) | `slide.tsx` Frame |
| 2.1 Tabellen | fertig als Layout `table` (native Textboxen, keine PowerPoint-Tabelle) | `layouts-extra.tsx` |
| 2.2 Texteffekte | fertig: shadow, lift, hollow, neon für freie Texte | `effectCss`, `patch-xml.ts` textEffect |
| 2.3 Schriften | fertig: +6 OFL-Familien (Playfair Display, Source Sans 3, Plus Jakarta Sans, Lora, Instrument Serif, Archivo); eigene Schrift (TTF) im Look-Panel, eingebettet in die PPTX | `fetch-fonts.ts`, `themes.ts`, `slide.tsx` loadCustomFont, `ipc.ts` font:pick |
| 2.4 Medien | Video/Audio von deckwerk-f3; QR-Code (Item `qr`, `closing.qr`, Dependency `qrcode`); Links per `[Text](url)` als native Hyperlinks | `slide.tsx` QrCode, rich |
| 2.5 Übergänge und Bewegung | fertig: dissolve, wipe, cover, split, circle, zoom; `motion` calm/standard/lively | `animations.ts`, `layouts.ts` buildOf, `PresentScreen.tsx` |
| 2.6 Bildanpassung | fertig: Helligkeit, Kontrast, Sättigung, Weichzeichnen | `adjustCss`, `patch-xml.ts` adjustBlip |
| 2.7 Akzente per KI | fertig: Tool `decorate_slide` (Engine sucht freien Platz), Design-Guide „Canva-Wirkung“ | `tools.ts` |
| 3.1 Editor | Gruppen, Zuschneiden von f3; Autosave von deckwerk-02; offen: Stil übertragen, Pipette, Lineale | – |
| 3.2 Vorlagen-Galerie | Vorzeigedeck `examples/canva-look.json` fertig; Galerie im Startbildschirm offen (UI von deckwerk-02) | – |
| 3.3–3.5 | offen (Übersetzen geht schon per Chat, ohne eigenes Tool) | – |

Nebenbei behoben: PDF-Export hing unter Wayland (Electron jetzt mit `--ozone-platform=x11` in allen Startskripten), Renderer-Fehler kamen als leeres `{}` an, Karten auf Akzent-Folien und gedämpfter Text auf Akzentflächen hatten zu wenig Kontrast, zentriertes Cover mit Foto ohne Overlay.

**PowerPoint-Abnahme:** `npm run render examples/abnahme.json` erzeugt `exports/powerpoint-abnahme.pptx`. Jede Folie enthält die offenen Effekte (Kontur, Schweben, Sättigung, Weichzeichner, Masken, Formen, Pfeile, QR, Link, eingebettete Schriften), die Sprechernotizen sagen, was in PowerPoint zu prüfen ist. LibreOffice zeigt Neon und Masken bereits korrekt, ignoriert aber Kontur, weiche Schatten, Sättigung und Weichzeichner.

---

### Nachtrag 07.10.2026

Abgleich gegen den Code und gegen Canva (Stand Oktober 2026: Canva AI 2.0, Visual Suite 2.0, Magic Studio).

**Seit dem 27.09. dazugekommen:** Stil übertragen, Pipette und Dokumentfarben, Vorlagen-Galerie (5 Decks), Formate von Social bis A4 und Druck-PDF (3.3), Fernbedienung, Laser und Stift (3.4), KI-Bilder (3.5), Word-Export. Am 07.10. außerdem:

| Funktion (Canva-Gegenstück) | Wo |
|---|---|
| Ebenen-Panel (Position → Ebenen): auswählen, Reihenfolge ziehen, sperren, Gruppen bleiben zusammen | `ui/LayersPanel.tsx`, `itemOps.ts` moveNextTo, Test `scripts/check-layers.ts` |
| Suchen & Ersetzen (Strg+F / Strg+H) im ganzen Deck, schema-sicher | `shared/find.ts`, `ui/FindBar.tsx`, Test `scripts/check-find.ts` |
| Rechtschreibprüfung Deutsch/Englisch mit Vorschlägen | `main/spellcheck.ts`, Einstellungen → Allgemein |
| Seite ausblenden: Präsentieren und Export überspringen, PowerPoint `show="0"` | `deck.ts` hidden/showOf, `engine.ts`, Test `scripts/check-hidden.ts` |
| Versionsverlauf mit Vorschau und Wiederherstellen | `ui/VersionsSheet.tsx`, `ipc.ts` versions:* |
| Uploads (Deine Bilder) und Magic Media im Einfügen-Panel | `ui/Elements.tsx`, `tools.ts` makeImage |
| Übersetzen (3.3) als Deck-Auftrag | `ui/AskBar.tsx`, Guide „Aufträge fürs ganze Deck“ |

**Noch offen**, nach Wirkung sortiert:
- Tabelle als freies Element bzw. native PowerPoint-Tabelle mit Zeilen-/Spalten-Editor (2.1).
- Aufzählungen und Links per Knopf in freien Textfeldern (heute nur Layout „bullets“ bzw. `[Text](url)`).
- „Andere Gestaltung“ mit 3–4 Mini-Vorschauen und Layoutwechsel per `convertsTo` (1.6).
- Verlauf-Editor (bis 3 Stopps, Winkel, radial) für Formen und Hintergrund, `bg.pattern` (1.7, 3.1).
- Animationen: Geschwindigkeit des Übergangs, Verzögerung, Dauer, „mit/nach vorherigem“ (2.5).
- Lineale, Raster, gespeicherte Hilfslinien (3.1).
- Bildfilter-Presets und Tönung (2.6); Masken blob/teardrop/rounded, Geräte-Mockups, Foto auf Platzhalter ziehen (1.5).
- Formen wave, cloud, callout, bracket, arc, pie und `custGeom`-Export (1.4); Frame `split-photo`, Donut-Mitte (1.1, 1.2).
- Schriftwahl mit Vorschau, weitere OFL-Familien (2.3); Online-Video in PPTX (2.4).
- Aufzeichnen (Present and record), Live-Umfragen und Quiz.
- PowerPoint-Abnahme in echtem PowerPoint (§8.4).

Weiterhin bewusst draußen (§7): Kommentare, Teilen-Links, Zusammenarbeit, Canva Live, Whiteboard, Stock-Bibliothek, Magic Eraser/Grab/Expand, Bogentext und Deko als Standard.

### Nachtrag 09.10.2026: Drucksachen außer Folien und Flyern

Canva bietet außer Präsentationen und Flyern vor allem Lebenslauf, Bewerbung, Visitenkarte, Urkunde, Einladung, Speisekarte, Brief und Plakat (Maße laut [Canva-Entwicklerreferenz](https://canva.dev/docs/button/reference/design-types)). Neu in Deckwerk, alle mit Startauswahl unter „Format“, Beispiel und Vorlage in der Galerie:

| Canva-Typ | Deckwerk | Format |
|---|---|---|
| Lebenslauf | `cv` (Seitenspalte oder tabellarisch) | A4 |
| Bewerbung | `application-cover` + `letter` + `cv` in einem Deck | A4 |
| Brief/Briefkopf | `letter` nach DIN 5008 (Fensterumschlag, Anlagen) | A4 |
| Urkunde/Zertifikat | `certificate` | A4 quer |
| Einladung, Postkarte | `invitation`, Druck als A5/A6 | A4 |
| Speisekarte | `menu` (eine oder zwei Spalten) | A4 |
| Visitenkarte | `business-card` (Vorder- und Rückseite) | 85 × 55 mm |
| Poster | `flyer`, Druck als A3/A2 | A4 |

Bewusst weggelassen: Infografik (eigenes Langformat), weitere Social-Größen (Pinterest, LinkedIn-Banner; 1:1, 4:5, 9:16 und 1200×630 decken das Meiste ab), Video, Whiteboard, Website. Stresstest 09.10.: 1200/1200 Kombinationen über alle Themes sauber; nur die max-Fälle von Brief und einspaltiger Speisekarte brauchen die kleinste Textstufe.

## 1. Kurzfazit

Deckwerk ist technisch weiter als Canva, sieht aber noch nicht so aus.

**Wo Deckwerk vorn liegt**
- **Die PPTX ist echt.** Canva verliert beim PowerPoint-Export Animationen, ersetzt fremde Schriften, rechnet gekrümmten Text, Verlaufstext und Blend-Modi in Bilder um und verschiebt Elemente. Deckwerk exportiert native Animationen, eingebettete Schriften, native Charts, native Verläufe und Duotone. Diesen Vorsprung dürfen die neuen Funktionen nicht verspielen: **Jede neue Funktion braucht einen nativen PPTX-Weg oder bleibt draußen.**
- **Die KI prüft ihr Ergebnis.** Auto-Fit, Lint, `render_overview` und Action Titles gibt es so bei Canva nicht. Magic Design liefert nur einen ersten Entwurf.
- Presenter-Ansicht mit Notizen und Uhr, Morph (entspricht Canvas „Match & Move“), Undo, Snapping, Ausrichten und Ebenen sind vorhanden.

**Wo Canva vorn liegt (sichtbar in den Renderings)**
1. **Komposition.** Fast jede Inhaltsfolie hat dasselbe Gerüst: Linie oben, Eyebrow, zweizeiliger Titel links, Inhalt darunter, Fußzeile. Canva-Vorlagen wechseln zwischen Split-Screen, randabfallenden Farbblöcken, Text auf Foto, riesigen Zahlen und asymmetrischen Anordnungen. Das ist der größte Unterschied im Look.
2. **Grafische Elemente.** Canva hat Illustrationen, Sticker, handgezeichnete Pfeile, Rahmen (Frames), Raster (Grids) und Mockups. Deckwerk hat 8 Grundformen und Lucide-Linienicons.
3. **Text- und Bildeffekte.** Canva hat Schatten, Lift, Hollow, Neon, Hintergrund, Kurve, Bildfilter, Hintergrundentfernung. Deckwerk hat Fett, Kursiv, Unterstrichen, Versalien, Laufweite, Duotone und Mono.
4. **Bewegung.** Canva hat rund 20 Textanimationen, 8 Seitenübergänge mit Richtung und Tempo und „Magic Animate“. Deckwerk hat 6 Build-Presets, 5 Item-Animationen und 4 Übergänge.
5. **Auswahl statt Einzelergebnis.** Canva zeigt Vorlagen, Stile zum Durchmischen („Shuffle“) und mehrere Designvorschläge. Deckwerk liefert genau ein Ergebnis.
6. **Fehlende Bausteine:** Tabellen, Video, QR-Code, Links, 8 geplante Layouts (Team, Preise, Funnel, Marktgröße, Logos, Pro/Contra, Problem/Lösung, Tabelle).

---

## 2. Ist-Stand im Überblick

| Bereich | Deckwerk heute | Canva | Lücke |
|---|---|---|---|
| Layouts | 18 (12 Kern + photo, gallery, quote + blank, summary, options, matrix), 1–3 Varianten | Tausende Vorlagen, pro Folientyp Dutzende Kompositionen | groß |
| Themes | 11 Katalog + `customTheme` durch die KI, `tone` (normal/accent/invert), 7 Dekor-Motive, Grain | Vorlagen-Familien, Stile, Paletten-Shuffle | mittel |
| Schriften | 3 Office + 6 Premium (Fraunces, Manrope, Space Grotesk, Inter, DM Serif Display, DM Sans), eingebettet | 1000+ Schriften, eigene hochladen | mittel |
| Freie Elemente | Text, 8 Formen, Icon, Bild, Chart; Drehen, Deckkraft, Verlauf mit 2 Farben, Schatten, Sperren | + Linien mit Pfeilspitzen, Konnektoren, Tabellen, Frames, Grids, Sticker, Illustrationen, Video, Audio, QR | groß |
| Texteffekte | B/I/U, Versalien, Laufweite, Zeilenhöhe | Shadow, Lift, Hollow, Splice, Echo, Glitch, Neon, Background, Curve | groß |
| Bildbearbeitung | Zuschnitt per `focus` (nur in Layouts), Kreis, Radius, Duotone, Mono, Spiegeln | Filter, Anpassen, Zuschneiden im Rahmen, Hintergrund entfernen, Magic Eraser/Grab/Expand | groß |
| Animation | Builds: none, fade, list, stagger, wipe, zoom-kpi, pan, pop, words (Wort für Wort), photo (Foto-Zoom); Magic Animate im Look (Keine/Ruhig/Standard/Lebhaft); Items mit Richtung und Tempo wie Canva: Einblenden, Aufsteigen, Schwenken, Treiben, Pop, Zoomen, Purzeln, Stampfen, Grundlinie, Wischen, Schreibmaschine, Wort für Wort, Atmen (Dauerpuls); Übergänge: fade, push, slide, stack, color (Farbwischen), dissolve, wipe, cover, split, circle, zoom, morph (Text und Bild wandern, pro Folie); alles auch in der PPTX, Vorschau beim Wählen | ~20 Textanimationen, Seitenanimationen, Magic Animate, 8 Übergänge mit Richtung/Tempo | mittel |
| Editor | Canvas mit Snapping, Ausrichten, Verteilen, Ebenen, Copy/Paste, Nudge, Zoom, Undo | + Gruppieren, Stil übertragen, Lineale, Zuschneiden per Doppelklick, Autosave | mittel |
| KI | Chat-Agent mit Tools, Element-KI-Leiste, Self-Check | Magic Design (mehrere Vorschläge), Magic Write, Magic Switch (Format/Sprache), Magic Media (Bildgenerierung) | mittel |
| Präsentieren | Vollbild, Presenter-Ansicht mit Notizen und Uhr | + Fernbedienung per QR, Canva Live (Q&A), Aufnahme | klein |
| Export | PPTX nativ (Schriften, Animationen, Charts), PDF, PNG | PPTX mit Verlusten, PDF, MP4, GIF | **Deckwerk vorn** |

---

## 3. Befunde aus den Renderings

Konkrete Schwächen, die ein Betrachter sofort sieht:

| Folie | Befund | Ursache |
|---|---|---|
| `q3-update-vertrieb/03` (KPI) | Karten sind unten zu einem Drittel leer, Inhalt klebt oben. Vier gleich aussehende Karten ohne Hierarchie. | Karten strecken sich auf die volle Höhe, Inhalt oben ausgerichtet. Kein Hervorheben der wichtigsten Zahl. |
| `strategie-2027/05` (Donut) | Viel Leerraum zwischen Donut und Legende, Legende schwebt. Rechte Karte ist gut. | Chart.js-Legende rechts in voller Box-Breite. |
| `ortho-bot-pitch/04` (Statement) | Gut, aber der Glow-Hintergrund ist das einzige Gestaltungsmittel. | Keine grafische Ebene außer Dekor. |
| `caf-kollektiv/01` (Cover mit Foto) | Stark, auf Canva-Niveau. | Phase 4 greift. |
| `caf-kollektiv/05` (Galerie) | Gut, aber gemischte Bildsprache (ein Foto natural, zwei duotone). | `look` pro Bild statt pro Folie. |
| alle Inhaltsfolien | Gleiches Skelett (Linie, Eyebrow, Titel links, Fußzeile) auf jeder Folie. | Layouts teilen einen Kopf. Keine Kompositions-Varianten. |

Daraus folgt die Priorität: **erst Komposition und Grafik, dann Effekte, dann Editor-Komfort.**

---

## 4. Leitplanken für alle Pakete

1. **Nativ oder gar nicht.** Jeder Effekt bekommt eine OOXML-Entsprechung, die in PowerPoint editierbar bleibt. Der Weg ist immer derselbe: PptxGenJS schreibt die Grundform mit `objectName = dw:<slot>`, `src/main/patch-xml.ts` ergänzt das XML (Muster: `gradient`, `roundRect`, `recolor`). Wo es keine Entsprechung gibt, wird der Effekt als Bild gerastert und im Lint als `raster` markiert, oder er entfällt.
2. **Die KI setzt weiter keine Koordinaten in Layouts.** Neue Gestaltung kommt über Varianten, `tone`, `decor` und neue Slots. Freie Items bleiben für `blank` und den Nutzer. Ausnahme: Akzent-Zonen (Paket 3.4), in denen die Engine positioniert.
3. **Jede XML-Vorlage stammt aus einer echten PowerPoint-Referenzdatei**, nicht aus der Spezifikation geraten (wie bei `animations.ts`). Für jedes Paket also zuerst eine Referenz-PPTX in PowerPoint bauen und das XML herauskopieren.
4. **Vorschau = Export.** Jeder neue Effekt hat eine CSS/SVG-Vorschau im Renderer und wird von `npm run verify:pptx` mit LibreOffice verglichen. Die Abnahme macht echtes PowerPoint.
5. Nach jedem Paket: `npm run typecheck && npm run check:layouts && npm run smoke`, Beispiel-Deck rendern, `verify:pptx`.

---

## 5. Pakete, nach Wirkung sortiert

Aufwand: S = bis ½ Tag, M = 1–2 Tage, L = 3–5 Tage.

### P1: Look (größter Hebel)

#### 1.1 Kompositions-Varianten für Inhaltsfolien (L)

**Canva:** Dieselbe Aussage gibt es als Split-Screen, als Farbband, als Text auf Foto, als große Zahl. Das bricht die Monotonie.

**Fehlt:** Alle Inhaltslayouts teilen den Kopf (Eyebrow + Titel oben links). `bullets`, `kpi-grid`, `chart`, `process`, `timeline` haben höchstens zwei Varianten.

**Umsetzung:**
- Neuer gemeinsamer Parameter `frame` pro Folie in `src/shared/deck.ts`, orthogonal zu `variant`:

  | `frame` | Aufbau | passt zu |
  |---|---|---|
  | `top` (heute) | Titel oben, Inhalt darunter | alles |
  | `split` | linke 38 % Akzentfläche (randabfallend) mit Eyebrow + Titel in `onAccent`, rechts der Inhalt | bullets, kpi-grid, process, chart |
  | `split-photo` | linke 40 % randabfallendes Foto, rechts Titel + Inhalt | bullets, quote, summary |
  | `band` | Titel in einem vollbreiten Farbband oben (Höhe nach Titel), Inhalt auf Fläche darunter | kpi-grid, timeline |
  | `center` | Titel zentriert, Inhalt zentriert darunter, kein Eyebrow-Strich | statement-nahe Folien, kurze bullets |

- Umsetzung in `src/renderer/slide.tsx` als Wrapper-Komponente `Frame`, die Kopf und Inhaltsbereich als CSS-Grid aufspannt. Die Layouts rendern ihren Inhalt unverändert in den Inhaltsbereich; dessen Breite ändert sich, Auto-Fit fängt das ab.
- Pro Layout eine Liste `frames: FrameId[]` in `src/shared/layouts.ts`, damit die KI nur passende Kombinationen wählt (zod-Enum pro Layout).
- `split` nutzt `withTone(t, 'accent')` für die linke Fläche, also keine neue Farblogik.
- Export: Die Akzentfläche ist ein nativer `BoxEl`, kein neuer Exportcode.
- Tools (`src/main/tools.ts`): `frame` in `slideInput` und `update_slide`. Inspector: Select neben „Variante“.
- Design-Guide Abschnitt 5 „Rhythmus“: höchstens zwei Folien hintereinander mit gleichem `frame`; pro Deck mindestens zwei verschiedene Frames ab 8 Folien.
- Lint (`src/shared/lint.ts`): Warnung `monotone`, wenn 3 Folien hintereinander dasselbe `frame`, denselben `tone` und kein Bild haben.

**Abnahme:** `check:layouts` iteriert zusätzlich über `frames`. Beispiel-Deck `examples/frames.json`.

#### 1.2 Layout-Politur aus den Befunden (S)

- **KPI-Karten** (`src/renderer/layouts.tsx`, `kpi-grid`): Karten nur so hoch wie der Inhalt, Kartenreihe vertikal im freien Raum zentriert. Neuer optionaler Slot `focus: number` (Index der Hauptzahl): Diese Karte bekommt Akzentfläche, `onAccent`-Text und ist 1,3-mal so breit. Variante `plain` ohne Karten, nur große Zahlen mit Trennlinien (Canva-typisch).
- **Donut** (`chart`): Legende direkt neben dem Ring (Breite = Legendeninhalt) oder als direkte Beschriftung an den Segmenten; Summe oder Highlight-Wert in die Ringmitte. Im Export entspricht das `dataLabel` + `holeSize`; die Mitte als eigene Textbox.
- **Galerie:** `look` optional pro Folie (`content.look`), überschreibt die Bilder, damit die Bildsprache einheitlich bleibt.

#### 1.3 Fehlende Layouts (L, in zwei Tranchen)

Tranche A, häufig gebraucht:

| Layout | Inhalt | Aufbau | Canva-Vorbild |
|---|---|---|---|
| `table` | title, columns (2–5), rows (2–7), highlight? (Zeile/Spalte), note? | native Tabelle (siehe 2.1), Kopfzeile in Akzent, Zebra optional | Tabellen-Element |
| `team` | title, people (2–6: name, role, image?, line?) | runde Porträts oder Frames (siehe 1.5), Name fett, Rolle muted | „Meet the team“ |
| `big-number` | eyebrow?, value (≤ 8 Zeichen), label, context?, image? | Zahl in Display-Größe 180–240 px, Rest klein; optional Foto rechts | Stat-Slides |
| `icon-grid` | title, items (3–6: icon, head, sub?) | 3×2 oder 2×2, Icons in Kreis-Badges (siehe 1.4) | Feature-Übersicht |
| `pros-cons` | title, pros (2–5), cons (2–5), verdict? | zwei Spalten mit Check/X-Badges, Fazitband unten | – |
| `problem-solution` | title, problem, solution, bridge? | zwei Flächen, links `invert`, rechts `accent`, Pfeil dazwischen | Vorher/Nachher |

Tranche B, Pitch und Vertrieb:

| Layout | Inhalt | Aufbau |
|---|---|---|
| `pricing` | title, tiers (2–4: name, price, period?, features 3–6, highlight?) | Karten, die empfohlene Stufe erhöht und in Akzent |
| `funnel` | title, stages (3–5: label, value) | gestapelte Trapeze (native `trapezoid`-Form), Werte rechts |
| `market-size` | title, tam, sam, som (je value + label), source | verschachtelte Kreise (native Ellipsen), Beschriftung rechts |
| `logos` | title, logos (4–12: src, name) | Raster, Logos einheitlich mono oder Theme-Farbe (Duotone) |
| `contact` | title, name, role, mail?, phone?, url?, qr? | Abschluss mit QR-Code (siehe 2.4) und Porträt |
| `agenda-visual` | wie `agenda`, plus image pro Punkt | Bildkarten statt Liste |

Pro Layout: zod-Schema mit `when`-Text in `src/shared/layouts-extra.ts`, Komponente in `src/renderer/layouts-extra.tsx`, CSS in `layouts-extra.css`, Samples (min/normal/max) für `check:layouts`, Eintrag in Design-Guide Abschnitt 4 „Inhalt → Layout“.

#### 1.4 Grafik-Bibliothek: Formen, Badges, Sticker, Illustrationen (L)

**Canva:** Formen, Linien, Sticker, Illustrationen und Rahmen, alles in Markenfarben einfärbbar.

**Umsetzung in drei Stufen:**

1. **Mehr native Formen (S).** PowerPoint kennt über 180 Preset-Geometrien. `SHAPES` in `deck.ts` und `SHAPE_TYPE` in `export-pptx.ts` erweitern um: `roundRect`, `pill` (roundRect 50 %), `chevron`, `pentagon` (Pfeil-Tag), `trapezoid`, `parallelogram`, `donut`, `blockArc`, `pie`, `wave`, `cloud`, `heart`, `moon`, `plus`, `callout` (`wedgeRoundRectCallout`, Sprechblase), `bracket` (`leftBracket`/`rightBracket`), `arc`. Vorschau-Pfade in `SHAPE_PATHS` (`src/renderer/slide.tsx`). Sichtbare Namen im Elemente-Panel.
2. **Linien mit Pfeilspitzen und Strichart (S).** `Item.lineEnd?: 'none'|'arrow'|'dot'`, `lineStart?`, `dash?: 'solid'|'dash'|'dot'`. Export: PptxGenJS kann `line.beginArrowType`, `endArrowType`, `dashType` direkt. Vorschau: SVG `marker` und `stroke-dasharray`.
3. **Dekor-Grafiken als SVG-Bibliothek (M).** Neuer Ordner `assets/graphics/` mit selbst gezeichneten SVGs (keine Lizenzfrage): Kringel, handgezeichnete Pfeile, Unterstreichung, Kreis-Markierung, Sterne/Funken, Blob-Formen, Wellenlinien, Punkteraster, Klammern. Jede Datei nutzt `currentColor` und optional `var(--c2)`, damit sie in Theme-Farben eingefärbt wird.
   - Neuer `Item.kind: 'graphic'` mit `graphic: string` (Dateiname) und `color`, `color2`.
   - Export: Blob- und Linienformen als **`custGeom`** (Pfad aus dem SVG nach DrawingML umgerechnet, native Form, in PowerPoint einfärbbar). Dafür ein kleiner Konverter `svgPathToCustGeom()` in `patch-xml.ts`, der nur `M L C Q Z` versteht (reicht, wenn die SVGs so gezeichnet sind). Komplexe Grafiken als SVG-Bild mit PNG-Fallback wie die Icons heute.
   - Elemente-Panel: Abschnitt „Grafiken“ mit Kategorien.
4. **Illustrationen (M, optional).** Offene Sets mit Recolor-Möglichkeit: Open Peeps und Humaaans (beide CC0), unDraw (eigene Lizenz, erlaubt kommerzielle Nutzung und Umfärben, Lizenz vor Übernahme prüfen). Als SVG unter `assets/illustrations/`, Primärfarbe per Ersetzung auf `accent`. Export als SVG-Bild. KI-Tool `search_graphics(query)` analog zu `search_icons`.
5. **Icon-Badges (S).** Icons heute nur als Linie. Neuer Stil `iconStyle: 'line' | 'badge' | 'solid-badge'` pro Layout-Slot und Item: Icon in einem Kreis oder Quadrat mit `surface`- bzw. `accent`-Fläche. Das Badge ist ein nativer `BoxEl`, das Icon liegt darüber. Default in `bullets`/`icon-grid`: `badge`.

#### 1.5 Bild-Rahmen (Frames) und Raster (Grids) (M)

**Canva:** Frames schneiden ein Foto in eine Form (Kreis, Bogen, Blob, Polaroid, Laptop, Handy). Grids sind Collagen mit einstellbarem Abstand.

**Umsetzung:**
- **Formrahmen fast umsonst:** Ein `<p:pic>` hat in PowerPoint ein eigenes `<a:prstGeom>`. `roundRect` wird heute schon per Patch gesetzt. Allgemein machen: `ImgEl.mask?: 'circle'|'arch'|'hexagon'|'diamond'|'blob'|'teardrop'|'rounded'`, Patch `maskShape(prst)` ersetzt `prst="rect"`. Bogen = `round2SameRect` mit adj 50 %, Blob = `custGeom` aus der Grafik-Bibliothek (1.4). Vorschau per CSS `clip-path` (Kreis, Polygon, `path()`).
  - `Item.mask` für freie Bilder, Inspector: Rahmen-Auswahl als Kachelreihe.
  - Layouts `quote`, `team`, `image-text` bekommen `mask` im Schema; der Default kommt vom Theme (`Theme.imageMask`, z. B. atelier = `arch`, signal = `rounded`).
- **Geräte-Mockups:** PNGs von Laptop und Handy unter `assets/mockups/` mit bekannter Bildschirm-Aussparung (JSON mit Rechteck). Item `kind: 'image', mockup: 'laptop'`: Export = Screenshot als Bild in der Aussparung plus Mockup-PNG darüber (zwei native Bilder). Neues Layout-Slot `product` in `image-text`.
- **Grids als Items:** Toolbar-Aktion „Raster einfügen“ (2, 3, 4, 2×2, 1+2) erzeugt mehrere Bild-Items mit Platzhalter, gleichem Abstand und Theme-Radius. Kein neuer Elementtyp, nur eine Fabrik in `src/shared/items.ts`. Ziehen eines Fotos auf einen Platzhalter ersetzt dessen `src`.
- **Zuschneiden im Rahmen:** Doppelklick auf ein Bild-Item öffnet den Zuschnitt-Modus in `Stage.tsx`: Bild innerhalb der Maske verschieben und zoomen, Ergebnis landet in `Item.focus` und neuem `Item.zoom`. Export über `sizing: { type: 'crop' }` wie bei Layout-Bildern (Code in `export-pptx.ts` existiert).

#### 1.6 Stile mischen und mehrere Designvorschläge (M)

**Canva:** „Styles“ mischen Palette und Schriftpaar über das ganze Deck per Klick; Magic Design zeigt mehrere Entwürfe zur Auswahl.

**Umsetzung:**
- **Paletten-Shuffle** in `src/shared/themes.ts`: `shuffleTheme(t, seed)` rotiert die Rollen `bg`/`surface`/`accent`/`accent2` innerhalb der Theme-Farben und leitet über `resolveTheme` + `ensureContrast` neu ab (inkl. hell/dunkel tauschen). Deterministisch per `seed`, damit Undo und Speichern funktionieren (`deck.theme.shuffle?: number`).
- **Schriftpaar-Tausch** getrennt davon: Liste kuratierter Paare (siehe 2.3) in `themes.ts`, `deck.theme.fontPair?: string`.
- LookSheet (`src/renderer/ui/LookSheet.tsx`): zwei Buttons „Farben mischen“ und „Schriften mischen“ neben dem Theme-Karussell.
- **Drei Vorschläge statt einem:** Tool `propose_looks` in `tools.ts`: Die KI übergibt 3 `customTheme`-Entwürfe, die Engine rendert je eine Musterfolie (`themePreview` existiert) und gibt sie als ein Bild zurück. In der App erscheinen die drei als Karten im Chat (neuer Nachrichtentyp `choice`), Klick übernimmt das Theme. Über Claude Code/MCP kommt dasselbe als Bild plus `ask_user`.
- **Pro Folie „Andere Gestaltung“:** Button in der Element-KI-Leiste bzw. im Inspector: rendert dieselbe Folie mit 3–4 alternativen `layout`/`variant`/`frame`-Kombinationen, deren Schema zum Inhalt passt (Content-Mapping zwischen verwandten Layouts, z. B. bullets ↔ icon-grid ↔ process), als Mini-Vorschauen. Die Kompatibilität steht als `convertsTo` in der Layout-Definition. Das entspricht Beautiful.ais Smart Slides und Canvas Layout-Vorschlägen.

#### 1.7 Folienhintergründe (S)

- `Slide.bg` um `gradient?: { from, to, angle }` und `pattern?: DecorId` erweitern. Export: Verlauf als natives Vollflächen-Rechteck mit `gradFill` (Patch existiert). Bild-Hintergrund mit `look` und `alpha`.
- Inspector: „Hintergrund“ mit Farbe, Verlauf, Bild, Theme-Standard.

---

### P2: Effekte, Bewegung, Bausteine

#### 2.1 Tabellen (M)

**Fehlt komplett**, weder als Layout noch als Item.

- `Item.kind: 'table'` mit `rows: string[][]`, `header?: boolean`, `zebra?: boolean`, `highlight?: { row?: number; col?: number }`, `colW?: number[]`.
- Renderer: HTML-`<table>` mit Theme-Styles. `measure.ts` misst jede Zelle als Box und liefert ein neues `TableEl` (Spaltenbreiten, Zeilenhöhen, Zell-Runs, Füllungen).
- Export: `slide.addTable()` von PptxGenJS mit `colW`, `rowH`, Zellfüllung, Rahmen, Schrift. Native, in PowerPoint editierbar.
- Auto-Fit: gemeinsame Schriftstufe für alle Zellen (Geschwister-Regel wie bei KPI-Labels), Überlauf pro Zelle als Lint-Fehler.
- Editor: Doppelklick auf eine Zelle bearbeitet sie; Inspector mit „Zeile/Spalte hinzufügen/löschen“ und CSV-Einfügen (Funktion `csvToSpec` ist das Vorbild).
- Das Layout `table` (1.3) nutzt dieselbe Komponente.

#### 2.2 Texteffekte (M)

Canva hat neun Effekte. Zuordnung zu nativem PowerPoint:

| Canva | PowerPoint-XML im `<a:rPr>` bzw. `<a:bodyPr>` | Vorschau-CSS | Umsetzen? |
|---|---|---|---|
| Shadow | `<a:effectLst><a:outerShdw blurRad dist dir><a:srgbClr><a:alpha/></a:srgbClr></a:outerShdw>` | `text-shadow` | ja |
| Lift | wie Shadow, weich, ohne Versatz | `text-shadow 0 4px 16px` | ja |
| Hollow | `<a:ln w><a:solidFill/></a:ln><a:noFill/>` | `-webkit-text-stroke`, `color: transparent` | ja |
| Neon | `<a:effectLst><a:glow rad>` | mehrfacher `text-shadow` | ja |
| Background | Textbox mit Füllung und `roundRect`, Innenabstand | `background`, `padding`, `border-radius` | ja |
| Highlight (Marker) | `<a:highlight><a:srgbClr/></a:highlight>` (ab PowerPoint 2019) | `background` am Run | ja, pro Run über `==Text==`-Markup |
| Verlaufstext | `<a:gradFill>` im `rPr` | `background-clip: text` | ja |
| Curve | `<a:bodyPr><a:prstTxWarp prst="textArchUp">` (WordArt) | SVG `<textPath>` | ja, als eigener Item-Typ ohne Auto-Fit |
| Splice, Echo, Glitch | keine direkte Entsprechung | – | nein (bzw. Echo als 3 versetzte Kopien mit Alpha, nur wenn gefragt) |

- Datenmodell: `Item.effect?: { type: 'shadow'|'lift'|'hollow'|'neon'|'background'|'gradient'|'curve'; color?: string; strength?: number }`.
- `TextEl` bekommt `effect`, `measure.ts` reicht es durch, `patch-xml.ts` bekommt `textEffect(el)`, das `<a:rPr>` bzw. `<a:bodyPr>` des Shapes `dw:<slot>` ergänzt.
- Inspector (`ItemInspector.tsx`): Abschnitt „Effekte“ mit Kacheln wie in Canva.
- In Layouts nur `background` und `highlight` (für Kernbegriffe im Titel, heute schon farbig per `**…**`), alle anderen nur für freie Items. Design-Guide: Effekte sparsam, höchstens einer pro Folie.

#### 2.3 Schriften (M)

- `scripts/fetch-fonts.ts` um weitere OFL-Familien erweitern und 10–12 kuratierte Paare definieren. Vorschläge: Playfair Display + Source Sans 3, Syne + Inter, Bricolage Grotesque + Inter, Instrument Serif + Inter, Archivo Black + Archivo, Outfit + Outfit, Plus Jakarta Sans, Lora + Nunito Sans, Bebas Neue + Montserrat (für laute Titel), Caveat (Handschrift-Akzent für Sticker-Texte).
- Nur statische TTF-Instanzen 400/700 (Einschränkung von `embed-fonts.ts`), Familiennamen per `fontFamilyOf()` prüfen.
- **Eigene Schrift hochladen:** im Brand-Kit TTF wählen, nach `~/Deckwerk/<deck>/fonts/` kopieren, `@font-face` zur Laufzeit per `FontFace`-API im Renderer registrieren, beim Export einbetten. Lint-Warnung, wenn `fsType` Einbettung verbietet.
- Font-Picker im Inspector mit Vorschau im jeweiligen Schnitt.
- `fontsLoaded()` in `main.tsx` muss neue Familien abwarten, sonst misst der Offscreen-Host falsch.

#### 2.4 Medien: Video, Audio, GIF, QR, Links (M)

| Baustein | Umsetzung | PPTX |
|---|---|---|
| Video (Datei) | `Item.kind: 'video'`, `src`, `poster` (erstes Frame per `<video>` im Renderer als PNG) | `slide.addMedia({ type: 'video', path, cover })` |
| YouTube | `Item.kind: 'video'`, `url` | `addMedia({ type: 'online', link })` |
| Audio | `Item.kind: 'audio'` mit Icon | `addMedia({ type: 'audio' })` |
| GIF | normales Bild, `.gif` erlauben | `addImage` (PowerPoint spielt GIFs ab) |
| QR-Code | `Item.kind: 'qr'`, `data`; als native Quadrate (ein `rect` pro Modul wäre zu viel, daher als SVG-Bild) | SVG-Bild mit PNG-Fallback |
| Link | `Run.link?: string`, Markup `[Text](url)` | `hyperlink: { url }` in Text-Runs |

QR braucht einen Encoder. Entweder die Dependency `qrcode` (klein, MIT) oder ein eigener Encoder (~300 Zeilen). **Vor dem Hinzufügen fragen** (Projektregel: keine neuen Dependencies ohne Rückfrage).

Präsentationsmodus: Video spielt per Klick bzw. automatisch, analog zu den Build-Steps in `PresentScreen.tsx`.

#### 2.5 Animationen und Übergänge (M)

**Übergänge** (`src/main/animations.ts`, `TRANSITIONS` in `deck.ts`), jeweils mit `dir` und `spd`:

| Canva | PowerPoint | XML |
|---|---|---|
| Dissolve | Auflösen | `<p:dissolve/>` |
| Slide | Schieben / Überdecken | `<p:push dir>`, `<p:cover dir>` |
| Circle wipe | Kreis | `<p:circle/>` |
| Line wipe | Wischen | `<p:wipe dir>` |
| Color wipe | Verblassen über Schwarz bzw. `p14:prism` | `<p:fade thruBlk="1"/>` |
| Stack / Chop | Teilen / Aufdecken | `<p:split>`, `p14:reveal` mit `mc:AlternateContent` |
| Match & Move | Morph | existiert |

`Deck.transition` bleibt deckweit (Geschmacksregel), neu ist `Slide.transition?` als Ausnahme für Kapiteltrenner, plus `transitionSpeed`. Vorschau im Präsentationsmodus per CSS (`clip-path: circle()` für Kreis, `translate` für Schieben).

**Element- und Textanimationen:** `ITEM_ANIMS` und die Build-Presets erweitern. Die Preset-IDs werden aus einer Referenz-PPTX übernommen, nicht geraten.

| Canva | PowerPoint-Effekt | Hinweis |
|---|---|---|
| Rise | Einfliegen von unten, kurz, mit Verzögerung | |
| Pan | Einfliegen von links | |
| Pop | Zoom mit Überschwingen bzw. „Wachsen und Drehen“ | |
| Typewriter | Erscheinen mit `<p:iterate type="lt">` (Buchstabe für Buchstabe) | nur kurze Texte |
| Ascend / Baseline | Einfliegen mit `iterate type="wd"` (wortweise) | für Titel auf Statement-Folien |
| Breathe | Betonung „Pulsieren“ | einmalig, nach dem Eingang |
| Block | Wischen | existiert als `wipe` |
| Drift, Tumble, Neon, Stomp u. a. | – | weglassen, passt nicht zu „Chef-tauglich“ |

- `Item.animDelay?`, `animDur?` und `animTrigger?: 'click'|'with'|'after'` für freie Items (Canva hat Timing pro Element).
- **„Magic Animate“:** `Deck.motion?: 'calm'|'corporate'|'lively'` wählt pro Layout die Build-Presets und Übergänge aus einer Tabelle in `animations.ts`. Die KI setzt `motion` statt jedes Build einzeln; einzelne `build` überschreiben weiter. Tool-Parameter in `create_deck`/`update_deck`.
- Präsentationsmodus: dieselben Effekte per Web Animations API in `PresentScreen.tsx`.
- `scripts/check-animations.ts` um die neuen Effekte erweitern.

#### 2.6 Bildbearbeitung (M)

Native Bildeffekte über `<a:blip>`-Kinder (Patch-Muster `recolor`):

| Canva | `<a:blip>`-Kind | Vorschau-CSS |
|---|---|---|
| Helligkeit / Kontrast | `<a:lum bright contrast/>` | `filter: brightness() contrast()` |
| Sättigung | `<a:hsl sat/>` | `filter: saturate()` |
| Tönung / Farbfilter | `<a:tint>` bzw. Duotone | `mix-blend-mode` |
| Unschärfe | `<a:blur rad/>` bzw. Bildeffekt „Weichzeichnen“ | `filter: blur()` |
| Graustufen / Duotone | existiert | existiert |
| Deckkraft | existiert (`transparency`) | existiert |

- `Item.adjust?: { bright?, contrast?, sat?, blur? }` (−100…100), Schieberegler im Inspector.
- Filter-Presets wie in Canva („Warm“, „Kühl“, „Film“, „S/W kontrastreich“) als benannte Kombinationen in `themes.ts`, damit sie zur Theme-Palette passen.
- **Hintergrund entfernen** (Canva Pro): braucht ein Segmentierungsmodell. Optionen: `@imgly/background-removal-node` (ONNX, lokal; Lizenz vorher prüfen) oder ein externer Dienst. Ergebnis als PNG mit Alpha in den Deck-Ordner, das Original bleibt. **Nur nach Rückfrage**, weil Dependency und Modellgröße (~40–80 MB).
- Magic Eraser, Magic Grab, Magic Expand: weglassen (generative Modelle, nicht lokal machbar).

#### 2.7 Die KI nutzt die neuen Mittel (M)

Canva hat die Mittel, aber der Nutzer muss sie finden. In Deckwerk soll die KI sie gezielt einsetzen, ohne Koordinaten zu raten.

- **Akzent-Zonen:** Nach dem Messen berechnet die Engine freie Rechtecke der Folie (Folie minus Boxen der Slots, minus Rand). Neues Tool `decorate_slide({ slide, accents: [{ graphic|shape|icon, zone: 'top-right'|'bottom-left'|… , size: 's'|'m' }] })`: Die Engine platziert das Element in die passende freie Zone, Lint verhindert Überlappung. So bekommt ein Cover einen Kringel unter dem Schlüsselwort oder eine Statement-Folie einen Stern, ohne dass die KI Koordinaten kennt.
- Tool-Schemas um `frame`, `mask`, `effect`, `motion`, neue Layouts und Grafiken erweitern.
- Design-Guide (`src/main/design-guide.md`) neuer Abschnitt „Canva-Wirkung“: Rhythmus aus Frames und Tones, höchstens ein Akzent-Element pro Folie, Grafiken passend zur Stimmung (handgezeichnet = freundlich, geometrisch = sachlich, keine für Finanz-/Vorstandsdecks), Rahmen-Form aus dem Theme, Effekte nur auf Cover/Statement.
- Art-Director-Check: `render_overview` bekommt einen Hinweistext mit Prüffragen („Gibt es mindestens drei verschiedene Kompositionen? Wirkt eine Folie leer oder überladen?“).

---

### P3: Editor-Komfort und Extras

#### 3.1 Editor (M)

| Funktion | Umsetzung |
|---|---|
| Gruppieren / Gruppierung aufheben (Strg+G) | `Item.group?: string`. Auswahl eines Gruppenmitglieds wählt alle, Doppelklick wählt einzeln. Export als `<p:grpSp>` per Patch (PptxGenJS kann keine Gruppen): Shapes mit gleicher Gruppe nach dem Schreiben in ein `grpSp` mit berechnetem `xfrm` verschieben. |
| Stil übertragen (Pinsel) | Stage-Aktion: Stil-Felder (`font`, `size`, `color`, `fill`, `stroke`, `effect`, `adjust` …) vom Quell-Item auf das nächste angeklickte kopieren. Liste der Stilfelder in `itemOps.ts`. |
| Layout-Folie lösen | Aktion „In freie Elemente umwandeln“: gemessene `El`s der Folie werden zu Items (Text, Box, Bild, Icon, Chart), `layout` wird `blank`. Danach ist alles frei verschiebbar wie in Canva. Einbahnstraße, Undo reicht als Rückweg. |
| Farbwähler | Dokumentfarben (alle im Deck benutzten), Markenfarben, Theme-Farben, Pipette (`EyeDropper`-API in Chromium, nativ). |
| Verlauf mit mehreren Stopps und Winkel | `fill2` → `gradient: Gradient` (Typ existiert in `deck.ts`), Editor mit Winkel und bis zu 3 Stopps. |
| Lineale und eigene Hilfslinien | Leiste an Stage-Rand, Hilfslinien ziehen, Snapping nutzt sie (`snap()` in `Stage.tsx` erweitern). |
| Autosave | Main-Prozess speichert 2 s nach der letzten Änderung, wenn ein Pfad existiert; sonst in `~/Deckwerk/.autosave/`. Wiederherstellen beim Start. |
| Versionen | Beim Speichern eine Kopie nach `<deck>/versions/<zeit>.json`, Liste im Datei-Menü. |
| Seitenraster / Ränder anzeigen | Toggle, zeigt die sicheren Ränder aus dem Theme. |

#### 3.2 Vorlagen-Galerie (S)

Canva startet von Vorlagen, Deckwerk von einem leeren Prompt.

- Ordner `templates/` mit 6–10 kompletten Beispiel-Decks (Pitch, Quartalsbericht, Strategie, Projektstatus, Produktvorstellung, Workshop, Schulung, Event), jedes in einem anderen Theme und mit gemischten Frames.
- `StartScreen.tsx`: Kachelreihe mit Vorschau (PNG beim Build erzeugt über `npm run render`). Klick öffnet eine Kopie; optional mit Prompt „Passe diese Vorlage an: …“, dann übernimmt die KI Storyline und Texte und behält das Design.
- Die KI kann eine Vorlage als Stilreferenz nehmen: Tool `create_deck({ template })` übernimmt Theme, Motion und die Frame-Abfolge.

#### 3.3 Format und Sprache (Magic Switch) (M–L)

- **Übersetzen:** Tool `translate_deck(lang)`: Die KI übersetzt alle Slots und Notizen, Auto-Fit und Lint laufen danach. Kein neuer Engine-Code, nur Tool und Prompt.
- **Andere Formate** (4:3, A4 hoch, 1:1, 9:16): `SLIDE_W`/`SLIDE_H` sind heute Konstanten. Umbau auf `Deck.format` betrifft Renderer, Messung, Export und alle Layouts. Großer Umbau, erst angehen, wenn es wirklich gebraucht wird.
- **Deck → Handout / Zusammenfassung:** Export als Markdown/Word aus Titeln, Inhalten und Notizen. Klein, sinnvoll für Chef-Updates.

#### 3.4 Präsentieren (S–M)

- **Handy als Fernbedienung:** lokaler HTTP-Server (Muster in `claude-agent.ts`) mit Token, QR-Code in der Presenter-Ansicht, Seite mit Weiter/Zurück und Notizen. Nur im LAN.
- **Laserpointer / Zeichnen** im Präsentationsmodus: Overlay-Canvas, nicht im Export.
- Canva Live (Publikums-Q&A), Aufnahme mit Webcam: weglassen, internes Werkzeug.

#### 3.5 KI-Bilder (optional)

Canva hat Bildgenerierung (Magic Media). Für Deckwerk nur als optionaler Anbieter hinter `find_images`, wenn ein API-Key eines Bildmodells hinterlegt ist. Bildnachweis „KI-generiert“ automatisch in die Notizen. Der Plan hat das bisher bewusst weggelassen; nur auf ausdrücklichen Wunsch bauen.

---

## 6. Reihenfolge und Aufwand

| # | Paket | Aufwand | Wirkung auf den Look |
|---|---|---|---|
| 1 | 1.2 Layout-Politur (KPI, Donut, Galerie) | S | hoch, sofort sichtbar |
| 2 | 1.1 Kompositions-Varianten `frame` | L | sehr hoch |
| 3 | 1.4 Stufe 1, 2, 5: Formen, Linien, Icon-Badges | S | mittel |
| 4 | 1.5 Bild-Rahmen, Grids, Zuschneiden | M | hoch |
| 5 | 1.3 Tranche A (table, team, big-number, icon-grid, pros-cons, problem-solution) inkl. 2.1 Tabellen | L | hoch |
| 6 | 1.6 Stile mischen, drei Vorschläge, „Andere Gestaltung“ | M | hoch (Gefühl von Auswahl) |
| 7 | 1.4 Stufe 3 + 2.7 Grafik-Bibliothek und Akzent-Zonen | M | hoch |
| 8 | 2.2 Texteffekte | M | mittel |
| 9 | 2.5 Übergänge, Animationen, Motion-Stile | M | mittel |
| 10 | 2.3 Schriften | M | mittel |
| 11 | 1.7 Hintergründe, 2.6 Bildanpassung | S–M | mittel |
| 12 | 3.2 Vorlagen-Galerie | S | hoch für den Einstieg |
| 13 | 2.4 Medien (Video, QR, Links) | M | Funktion |
| 14 | 1.3 Tranche B | L | mittel |
| 15 | 3.1 Editor-Komfort | M | Bedienung |
| 16 | 3.3, 3.4, 3.5 | M–L | optional |

Pakete 1–7 bringen den Canva-Look. Danach ist Deckwerk im Aussehen auf Augenhöhe und im Export überlegen.

---

## 7. Bewusst weggelassen

- Splice, Echo, Glitch und ähnliche Show-Effekte: kein natives PowerPoint-Gegenstück, passen nicht zu Business-Decks.
- Magic Eraser, Magic Grab, Magic Expand: brauchen generative Bildmodelle.
- Canva Live, Kommentare, Teilen-Links, Zusammenarbeit, Whiteboard: Deckwerk ist ein internes Einzelwerkzeug.
- Riesige Stock-Bibliothek: Unsplash plus eigene Bilder reichen; eigene SVG-Grafiken statt Lizenz-Stock.
- Beliebige Formate (Social Media, Druck): erst bei konkretem Bedarf (3.3).

---

## 8. Offene Entscheidungen für den User

1. **Dependencies:** QR-Encoder (`qrcode`) und Hintergrundentfernung (`@imgly/background-removal-node` o. ä.) nur mit Freigabe.
2. **Illustrationen:** eigene SVGs zeichnen (lizenzfrei, weniger Auswahl) oder offene Sets (Open Peeps, Humaaans, unDraw) übernehmen?
3. **Formate:** Wird außer 16:9 etwas gebraucht? Davon hängt ab, ob 3.3 jemals nötig ist.
4. **PowerPoint-Abnahme:** Texteffekte (Highlight ab PowerPoint 2019), `custGeom`-Masken und neue Übergänge brauchen je eine Prüfung in echtem PowerPoint. Wer macht sie und auf welcher Office-Version?

---

## Quellen

- [Canva Magic Studio (Newsroom)](https://www.canva.com/newsroom/news/magic-studio/)
- [Canva Magic Design für Präsentationen](https://www.canva.com/design-school/resources/how-to-use-magic-design)
- [Canva AI Features Guide 2026](https://perplexityaimagazine.com/ai-tools/canva-ai-features-guide-2026/)
- [Canva Magic Studio 2026](https://www.mindbees.com/blog/canva-magic-studio-2026/)
- [Canva Hilfe: Texteffekte](https://www.canva.com/help/text-effects/) und [Übersicht der Texteffekte](https://www.mindphp.com/en/online-tutorials/292-canva-tutorial-eng/10006-overview-of-text-effects-on-canva-eng.html)
- [Canva: Text-Animationen](https://www.canva.com/features/text-animations/) und [Liste der Animationen](https://bringyourownlaptop.com/blog/how-to-animate-text-in-canva)
- [Canva Hilfe: Seitenübergänge](https://www.canva.com/help/page-transitions/) und [Neue Übergänge und Fernbedienung](https://jakemiller.net/new-transitions-and-remote-control-in-canva-presentations/)
- [Canva Design School: Elemente](https://www.canva.com/design-school/resources/using-and-editing-elements/), [Frames und Grids](https://medium.com/@spideysense693/day-20-mastering-canvas-grid-and-frame-tools-for-stunning-designs-09a0c85e6f51)
- [Canva Brand Kit: Farben anwenden und Shuffle](https://www.canva.com/help/apply-brand-kit-colors/), [Brand-Kit-Leitfaden](https://bringyourownlaptop.com/blog/canva-brand-kits-guide)
- [Canva Hilfe: Präsentieren und Presenter-Ansicht](https://www.canva.com/help/presenting-designs/), [Canva Live](https://www.canva.com/help/canva-live/)
- [Canva Fotoeditor](https://www.canva.com/help/image-editor/), [Magic Eraser](https://www.canva.com/features/magic-eraser/), [Magic Grab](https://www.canva.com/help/using-magic-grab/)
- [Canva → PowerPoint: was beim Export verloren geht](https://www.designexporter.com/blog/canva-to-powerpoint-formatting), [ClassPoint: Canva zu PowerPoint](https://www.classpoint.io/blog/how-to-convert-canva-to-powerpoint)
- [Gamma vs. Canva (SlideSpeak)](https://slidespeak.co/comparison/gamma-vs-canva), [Gamma vs. Beautiful.ai vs. Canva](https://everydayaiblog.com/ai-presentation-maker-gamma-canva-beautiful-ai/)
- [Canva-Präsentationen: Gestaltungstipps](https://www.conveyormg.com/resources/blogs/become-the-michelangelo-of-canva-presentations-with-7-easy-tips)
