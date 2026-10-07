---
name: deckwerk
description: Präsentationen mit Deckwerk bauen oder überarbeiten – Folien, Decks, Vorträge, Pitches, Chef-Updates, Schulungen, Handouts, Instagram-Karussells, A4-Dokumente, Angebote und Flyer – und als PowerPoint (PPTX), PDF oder PNG exportieren. Nutzen, sobald jemand eine Präsentation, Folien, ein Deck, slides, a presentation oder eine pptx erstellen, aus einem Dokument oder Repo machen, verbessern, kürzen oder exportieren will oder eine deck.json öffnet. Arbeitet mit den MCP-Werkzeugen des Servers deckwerk (create_deck, add_slides, …).
---

# Deckwerk: Präsentationen, die man dem Chef zeigen kann

Deckwerk baut Folien aus einem festen Layout-Katalog. Deine Aufgabe sind Storyline, eine Botschaft pro Folie, die Wahl des Layouts und knapper Text. Positionen, Schriftgrößen und Farben setzt die Engine; sie misst jede Folie und meldet Probleme zurück. Setze nie Koordinaten und erfinde keine Layouts.

## 0. Voraussetzung

Die Werkzeuge kommen vom MCP-Server `deckwerk` (in Claude Code `mcp__deckwerk__…`). Fehlen sie, ist Deckwerk nicht eingetragen. Dann sag dem Nutzer: in der Deckwerk-App Einrichtung → Agenten → „In Claude Code einrichten“ bzw. „In Codex einrichten“, danach eine neue Sitzung starten. Baue die Präsentation nicht stattdessen per Skript, HTML oder python-pptx nach.

## 1. Zuerst den Guide lesen

Rufe `read_guide` mit `part` 1, 2, … auf, bis die Antwort „Teil n von n“ meldet. Er enthält den Design-Guide und den Layout-Katalog mit allen Feldnamen. Ohne ihn rätst du Felder (Schemafehler) und Gestaltung. Einmal pro Sitzung genügt.

## 2. Briefing und Material

- Höchstens 2–3 Rückfragen: Zielgruppe, Ziel oder Entscheidung, Umfang und Anlass. Fehlt etwas, triff eine sinnvolle Annahme und nenne sie.
- **Format:** Standard ist 16:9. Für Instagram (Karussell 4:5 oder 1:1, Story 9:16) oder Druck (A4) beim Anlegen `create_deck` mit `format` aufrufen; Gerüst und Textmenge stehen im Guide §3 (Karussell, A4-Dokument mit `doc-text`/`offer`, Flyer mit `flyer`; beidseitig `flyer` + `flyer-back`).
- **Quellmaterial:** Nennt der Nutzer Dateien (Bericht, README, Tabelle, Notizen), lies sie selbst und übernimm nur belegte Zahlen. Fehlt eine Zahl, nimm einen deutlich markierten Platzhalter und liste ihn am Ende auf. Nie stillschweigend erfinden.
- **Vorhandenes Deck:** `open_deck` mit dem Pfad, dann `get_deck`. Gezielt mit `update_slide` ändern statt neu bauen.

## 3. Idee, dann Storyline

Erst die Idee (Guide §2 „Die Idee“): Entwickle drei Leitideen (naheliegend, überraschend, gewagt), verwirf die naheliegende und nimm die stärkste, die zum Publikum passt. Mögliche Zutaten:
- ein Bild für das Ganze
- ein Einstieg mit Haken statt Agenda
- greifbare Vergleiche für Zahlen
- konkrete Beispiele aus dem Material
- ein Perspektivwechsel (Sicht des Kunden, Brief aus 2030, ein Tag im Leben von …)
- eine Serie von Ein-Satz-Folien als Schlagfolge
- Kapiteltrenner als Frage
- ein mutiger Höhepunkt (im Stil mutig zwei bis drei)
- ein Schluss, der den Anfang in Sprache oder Motiv aufgreift (nicht mit demselben Foto)

Nenne die Idee in einem Satz. Mutig sein heißt hier: in Idee, Sprache und Dramaturgie, nicht in Deko. Beim Chef-Update bleibt sie leise.

Dann zeige die Storyline als nummerierte Liste der Titel im Chat (Datenfolien als Aussage-Satz, Bühnenfolien kurz):
- Datenfolien tragen die Kernaussage als ganzen Satz mit höchstens ~80 Zeichen, möglichst mit Zahl oder konkretem Ergebnis. Bühnenfolien (statement, big-number, photo) kurz, dazu eine kurze Behauptung oder Frage: Titel in Form und Länge mischen.
- Test: Wer nur die Titel liest, versteht Argument und Empfehlung.
- Gerüst nach Anlass (Guide §3), Empfehlung früh (Pyramidenprinzip).
- Bei großen Decks auf ein OK warten, bei klarem Auftrag direkt weiterbauen.

## 4. Look

- Ohne Vorgabe: `propose_looks` mit drei eigenen Entwürfen: einem hellen, sachlichen, einem dunklen oder plakativen und einem Überraschungsentwurf, der unerwartet, aber aus dem Thema begründet ist. Sie sollen sich in der Struktur unterscheiden (Serif/Sans, titleSize, rule, sectionTone, labelFont, elements für die Bauteile: line, plain, solid nur im Stil mutig), nicht nur in der Farbe. Jedes Design trägt eine unerwartete Entscheidung (Guide §6). Im Stil mutig sind auch `plakat`, `magazin`, `neomono` und `pastell` Kandidaten. Lass den Nutzer wählen. Gibt er Marke, Farben oder Theme vor, rufe direkt `create_deck` auf.
- **Brand-Kit:** Hat der Nutzer in Deckwerk eine Marke (Farben, Schriften, Logo) gespeichert, wendet `create_deck` sie automatisch an und nennt das im Ergebnis. Dann Akzentfarbe und Schriften nicht überschreiben; `brand: null` nur auf ausdrücklichen Wunsch. Der Hausstil ergänzt die Marke (Ton, Anrede), die Marke bestimmt Farbe und Schrift.
- `create_deck` mit genau dem gewählten `customTheme`. Die Vorschau im Ergebnis wie ein Art Director prüfen.
- **Stil des Decks** (`style` in `create_deck`/`update_deck`): Ohne Vorgabe wählst du ihn beim Anlegen nach Anlass und nennst die Wahl in einem Halbsatz. Eine Vorgabe des Nutzers hat Vorrang; bestehende Decks nur auf Wunsch umstellen.
  - **Mutig** für Vortrag, Schule, Verein, Event, Kampagne, Kultur, Marketing, Produktvorstellung, Social-Karussell oder wenn der Nutzer „mutiger“, „plakativ“ bzw. „verspielter“ will. Dann erlaubt Guide §6 „Stil des Decks“ kräftigen Farbgrund (`vivid`), Plakat-Typo, mehr Farbflächen und markante Bilder.
  - **Sachlich** für Chef-Update, Entscheidungsvorlage, Antrag, Bericht, Finanzen, Projektstatus, A4-Dokument, Angebot: Zurückhaltung statt Deko. Eine Akzentfarbe, Hierarchie über Größe und Weißraum. Sticker, Blobs, Verläufe und Icons als Schmuck nur auf ausdrücklichen Wunsch.
- **Abwechslung:** Ein neues Deck unterscheidet sich im Designtyp (Grund neutral/getönt/dunkel, Serif/Sans, Titelgewicht, Bauteile line/plain) von den zuletzt gebauten Decks (Guide §6 „Abwechslung“), außer bei einer Serie oder mit Brand-Kit.

## 5. Bilder

- **Bildplan:** 2–5 Folien tragen ein Bild (Cover, Kapitelwechsel, Höhepunkt, Abschluss), nicht jede.
- **Variante `side`** (cover, closing, photo): Foto rechts auf 7/12, Text links ohne Verlauf; nimm sie, wenn das Foto keine ruhige Fläche hat. Vollbild mit Verlauf höchstens einmal pro Deck.
- **Erst suchen:** `find_images` (eigene Bilder, freie Fotos).
- **Dann erzeugen:** `generate_image` nur nach Guide §6 „KI-Bilder“:
  - ein Stilsatz für alle Bilder
  - alle Bilder des Plans in einer Antwort gleichzeitig anfordern
  - nie echte Personen, Logos, Marken oder Produkte des Nutzers
  - kein KI-Look
- Bildnachweis bzw. „Bild: KI-generiert“ in die Notes, `focus` nach der Vorschau setzen.

## 6. Folien bauen

- `add_slides` in Etappen von 4–6 Folien. Jede Antwort meldet Autofit und Lint pro Folie.
  - **Fehler sofort beheben:** Text kürzen, Folie teilen oder das Feld nach dem Katalog korrigieren.
  - **Warnungen bewusst entscheiden:**
    - `sparse` (wirkt leer): mehr Substanz (Zahl, Beispiel, Beleg), ein Foto, eine luftigere Form (statement, big-number) oder mit der Nachbarfolie zusammenlegen.
    - `density` (zu viel Text): kürzen, der Rest kommt in die Notes.
    - `monotone`, `rhythm`, `cards`, `breath`: Komposition (`frame`), Ton (`tone`) oder Layout wechseln.
    - `ki-sprache`, `ki-muster`: Floskel oder Muster umschreiben, konkret statt glatt (Guide §7 „Klingt nach KI“).
    - `mut`: einen mutigen Moment einbauen, z. B. `statement`/`big-number` Variante `poster` (Guide §6 „Mut wie ein Mensch“).
    - `ornament`: Eyebrow nur auf Cover und wo es Orientierung gibt (Kapitel, Stand), sonst weglassen.
    - `echo`: Schluss zeigt das Cover-Foto; anderes Motiv oder ohne Foto, den Bogen über Sprache oder Motiv schlagen.
    - `titel-formel`: Titel mischen (Bühnenfolien ein Wort oder kurzer Satz, eine Behauptung ≤ 5 Wörter, eine Frage).
- **Rhythmus:** Auf je vier Inhaltsfolien kommt eine luftige (statement, big-number, photo). Kapiteltrenner und Höhepunkt mit `tone` absetzen.
- **Diagramme** immer mit `highlight`; die Aussage steht im Titel, nicht im Chart.
- **Speaker Notes** zu jeder Inhaltsfolie: 2–4 Sätze, die der Redner sagt.
- **Animation:** ein Übergangstyp pro Deck, höchstens ein Build pro Folie, Morph nur gezielt (Guide §8).

## 7. Prüfen, höchstens drei Runden

1. `lint_deck` muss 0 Fehler melden.
2. `render_overview` wie ein Art Director ansehen: Erzählen die Titel die Geschichte? Stimmt der Rhythmus aus dicht und luftig? Wirkt eine Folie leer oder überladen? Passen die Fotos zusammen?
3. Die schwächsten 1–3 Folien gezielt verbessern. Details mit `render_slides` prüfen.

## 8. Abschluss

- `save_deck` speichert nach `~/Deckwerk/<titel>/deck.json`. Nenne den Pfad; der Nutzer öffnet die Datei in der Deckwerk-App (Doppelklick auf `deck.json`) und kann dort weiterarbeiten.
- Exportieren nur auf Wunsch: `export_deck` mit `pptx`, `docx` (Word: Text bearbeitbar, Gestaltung als Hintergrundbild), `pdf`, `png`, `zip` (alle Bilder plus PDF in einer Datei, für Karussells) oder `md` (Handout). Pfade nennen; bei Nicht-16:9 tragen die Dateien das Format im Namen (`-4x5`, `-a4`).
- Flyer für die Druckerei: `export_deck` mit `format: "print"` (`…-druck.pdf`, Endformat plus Beschnitt `bleed`, Standard 3 mm; `size` a3/a5). Vorher nicht gewählte Entwürfe löschen, damit die Seitenzahl (1 oder 2) zur Bestellung passt. Farben bleiben RGB; bei großer Auflage Probedruck raten. Lint `print-res` (Foto unter 250 ppi) vorher beheben.
- Kurzer Bericht: Folienzahl, Storyline in einem Satz, getroffene Annahmen und was der Nutzer ersetzen muss (Zahlen, Zitate, Fotos).

## Häufige Fehler

- Themen-Titel („Marktanalyse“) statt einer Aussage.
- Felder raten statt aus dem Katalog nehmen.
- Freie Elemente (`items`) mit Koordinaten ohne Not; sie sind nur für Layout `blank` oder auf Wunsch des Nutzers da.
- Zwei Botschaften auf einer Folie, weil „es noch draufpasst“.
- Erfundene Zahlen ohne Hinweis; runde Zahlen ohne Quelle statt echter mit Quelle und Stand.
- Alle Titel als gleich lange Satz-Zweizeiler; Executive Summary und KPI-Reihe als Pflichtteile statt nach Inhalt.
- Empfehlung erst auf der letzten Folie, „Danke für Ihre Aufmerksamkeit“ statt nächster Schritte.
