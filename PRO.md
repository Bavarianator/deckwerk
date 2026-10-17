# Deckwerk Pro

Deckwerk Pro ist die Ausgabe von Deckwerk für Profis: Beratungen und Konzerne, Agenturen, Video-Profis sowie Druck und Design. Das Repo ist ein Git-Fork von Deckwerk (Remote `upstream`) und steht wie Deckwerk unter AGPL-3.0-only. Pro läuft neben Deckwerk, mit eigenem Datenordner `~/DeckwerkPro`, eigenem MCP-Namen und Skill `deckwerk-pro`.

Stand der Recherche: 17.10.2026. Die Belege stammen meist aus Anbieterseiten und Review-Portalen; Preise sind Größenordnungen.

## Was Profis brauchen

### Beratungen und Konzerne
| Bedarf | Beleg | Deckwerk heute |
|---|---|---|
| Diagramme mit Excel-Verknüpfung und Aktualisieren | think-cell, UpSlide, Macabacus (Excel-Link ab Professional) | Diagramme nativ, Daten nur per Hand oder CSV |
| Wasserfall, Mekko, Gantt | think-cell; Office Timeline für Gantt | Wasserfall ja; Mekko, Gantt fehlen |
| Fußnoten, Quellen, Deck-Prüfung | Macabacus Deck Check | Feld `source` an Datenlayouts, keine nummerierten Fußnoten |
| Agenda und Tracker | Beratungsstandard | Agenda mit aktivem Kapitel, kein Tracker auf jeder Folie |
| Eigene .potx-Vorlage | Microsoft; Gamma kann Master nicht erzwingen | fehlt (Export ohne SlideMaster) |
| Datenschutz: lokal, kein Training mit Kundendaten, SSO | Gamma Business, UpSlide SOC 2 | lokal und offline; SSO entfällt |

### Agenturen
| Bedarf | Beleg | Deckwerk heute |
|---|---|---|
| Brand-Kit je Kunde | Beautiful.ai Team, Canva Teams | ein globales `brand.json` und `hausstil.md` |
| Erzwungene Markenregeln (Locked Themes) | Beautiful.ai, Canva Brand Controls | Theme-Lint, keine Sperre |
| Folienbibliothek | UpSlide Content Library | fehlt |
| Freigabe mit Kommentaren, Rollen, Versionen | Frame.io, Beautiful.ai | Versionen ja; Kommentare bewusst draußen |
| Stapel-Export für viele Plattformen | Opus Clip Business | Serienbrief, Clips einzeln |

### Video-Profis
| Bedarf | Beleg | Deckwerk heute |
|---|---|---|
| KI-Schnitt als bearbeitbare Timeline nach Premiere/Resolve | Descript, Opus Clip Pro (XML-Export) | nur MP4 und SRT |
| Lautheit nach Norm (EBU R128 −23 LUFS, Plattformen −14/−16) | EBU R128 | fest −14 LUFS |
| 4K/60, 10 bit, ProRes/DNxHR | DaVinci Resolve Studio | H.264 1080p, 30 fps fest |
| Team-Review mit Kommentaren am Bild | Frame.io Pro/Team | fehlt |
| Mandantentrennung je Kunde | Opus Clip Business (Vorlagen) | fehlt |

Premiere liest kein FCPXML, nur das ältere Final-Cut-7-XML (xmeml). Das liest auch Resolve. Für OpenTimelineIO gibt es keine JS-Umsetzung.

### Druck und Design
| Bedarf | Typischer Wert | Deckwerk heute |
|---|---|---|
| PDF/X-4 (oder X-1a) mit Output-Intent | druck.at, reha-marketing | normales PDF |
| CMYK, Profil ISO Coated v2 (FOGRA39) oder PSO Coated v3 (FOGRA51) | Druckerei-Datenblätter | RGB |
| Beschnitt 2–3 mm, Sicherheitsabstand 3 mm | WIRmachenDRUCK, druck.at | Beschnitt, TrimBox/BleedBox vorhanden |
| 300 dpi | druck.at | Lint `print-res` |
| Gesamtfarbauftrag ≤ 300 % | schur.com | nicht geprüft |

Ghostscript (AGPL) wandelt nach CMYK und schreibt PDF/X-4; die Lizenz passt zu Pro. Fertige Linux-Binaries zum Nachladen gibt es nicht, Pro nutzt deshalb das installierte `gs` (ab 10.05, wegen PDF/X-4 mit Transparenz).

## Erste Version (0.1)
1. **Excel-Link:** Diagramm mit einem Bereich einer .xlsx verknüpfen, „Aktualisieren“ liest die Werte neu.
2. **Kunden:** Brand-Kit und Hausstil je Kunde; der aktive Kunde gilt für neue Decks und für die KI.
3. **Premiere/Resolve-XML:** Neben jedem Clip-MP4 liegt eine `.xml` (xmeml v5) mit den Schnitten, Tempo und Standbildern.
4. **Druck in CMYK:** Druck-PDF wahlweise als PDF/X-4 in CMYK mit FOGRA39.

## Roadmap
1. Gantt und Mekko als native Diagramme.
2. Brand-Lock: Kundenmarke sperren, Abweichungen als Lint-Fehler.
3. Folienbibliothek je Kunde, Folien per Klick übernehmen.
4. Import eigener .potx-Vorlagen (Farben, Schriften, Raster).
5. Fußnoten mit Nummern und Quellenverzeichnis, Tracker auf jeder Folie.
6. Video: Lautheits-Vorgaben, Export 4K/10 bit/ProRes, FCPXML für Final Cut.
7. Druck: Gesamtfarbauftrag prüfen, Schnittmarken, PDF/X-1a.
8. Freigabe-Workflow mit Kommentaren (baut auf `feat/gemeinsam-bearbeiten` in Deckwerk auf).

## Fork pflegen
- Deckwerk-Stände kommen per `git fetch upstream --tags && git merge vX.Y.Z` (Release-Tags) oder einen Branch von `upstream`.
- Identität (Name, Datenordner, MCP, Skill, Update-Repo) steht gebündelt in `src/shared/app-id.ts`. Die übrigen UI-Texte mit „Deckwerk“ bleiben, damit Merges konfliktarm bleiben.
- Pro-Decks in Deckwerk öffnen: Pro-Felder wie `link` sind dort unbekannt, KI-Änderungen an solchen Folien scheitern.

## Quellen
- think-cell: https://www.g2.com/products/think-cell-suite/reviews · https://deckary.com/blog/think-cell-pricing
- UpSlide: https://upslide.net/enterprise-solution
- Beautiful.ai: https://beautiful.ai/brand-controls-themes · https://beautiful.ai/enterprise
- Pitch: https://help.pitch.com/en/articles/9364636-pitch-s-paid-plans
- Gamma: https://fast.io/resources/gamma-ai-review-2026/
- Macabacus: https://www.capterra.com/p/10011368/Macabacus/pricing/
- Office Timeline: https://www.getapp.com/all-software/a/office-timeline
- Descript: https://www.descript.com/pricing · https://help.descript.com/hc/en-us/articles/10255813481613
- Opus Clip: https://www.opus.pro/pricing · https://help.opus.pro/docs/article/import-to-davinci-resolve
- DaVinci Resolve: https://www.blackmagicdesign.com/products/davinciresolve
- Frame.io: https://frame.io/pricing
- OpenTimelineIO: https://github.com/AcademySoftwareFoundation/OpenTimelineIO
- Premiere und OTIO: https://community.adobe.com/t5/premiere-pro-beta-discussions/new-in-beta-otio-import-and-export/td-p/14937493
- EBU R128: https://en.wikipedia.org/wiki/EBU_R_128
- Druckdaten: https://de.druck.at/downloads/info-druckdatenerstellung-de.pdf · https://www.schur.com/media/wk3llmmk/reprorichtlinien-de.pdf
- Ghostscript: https://ghostscript.readthedocs.io/en/latest/VectorDevices.html · https://artifex.com/licensing
