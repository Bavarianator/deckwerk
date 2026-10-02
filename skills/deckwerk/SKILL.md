---
name: deckwerk
description: Präsentationen mit Deckwerk bauen oder überarbeiten – Folien, Decks, Vorträge, Pitches, Chef-Updates, Schulungen, Handouts – und als PowerPoint (PPTX), PDF oder PNG exportieren. Nutzen, sobald jemand eine Präsentation, Folien, ein Deck, slides, a presentation oder eine pptx erstellen, aus einem Dokument oder Repo machen, verbessern, kürzen oder exportieren will oder eine deck.json öffnet. Arbeitet mit den MCP-Werkzeugen des Servers deckwerk (create_deck, add_slides, …).
---

# Deckwerk: Präsentationen, die man dem Chef zeigen kann

Deckwerk baut Folien aus einem festen Layout-Katalog. Deine Aufgabe sind Storyline, eine Botschaft pro Folie, die Wahl des Layouts und knapper Text. Positionen, Schriftgrößen und Farben setzt die Engine; sie misst jede Folie und meldet Probleme zurück. Setze nie Koordinaten und erfinde keine Layouts.

## 0. Voraussetzung

Die Werkzeuge kommen vom MCP-Server `deckwerk` (in Claude Code `mcp__deckwerk__…`). Fehlen sie, ist Deckwerk nicht eingetragen. Dann sag dem Nutzer: in der Deckwerk-App Einrichtung → Agenten → „In Claude Code einrichten“ bzw. „In Codex einrichten“, danach eine neue Sitzung starten. Baue die Präsentation nicht stattdessen per Skript, HTML oder python-pptx nach.

## 1. Zuerst den Guide lesen

Rufe `read_guide` mit `part` 1, 2, … auf, bis die Antwort „Teil n von n“ meldet. Er enthält den Design-Guide und den Layout-Katalog mit allen Feldnamen. Ohne ihn rätst du Felder (Schemafehler) und Gestaltung. Einmal pro Sitzung genügt.

## 2. Briefing und Material

- Höchstens 2–3 Rückfragen: Zielgruppe, Ziel oder Entscheidung, Umfang und Anlass. Fehlt etwas, triff eine sinnvolle Annahme und nenne sie.
- **Quellmaterial:** Nennt der Nutzer Dateien (Bericht, README, Tabelle, Notizen), lies sie selbst und übernimm nur belegte Zahlen. Fehlt eine Zahl, nimm einen deutlich markierten Platzhalter und liste ihn am Ende auf. Nie stillschweigend erfinden.
- **Vorhandenes Deck:** `open_deck` mit dem Pfad, dann `get_deck`. Gezielt mit `update_slide` ändern statt neu bauen.

## 3. Idee, dann Storyline

Erst die Idee (Guide §2 „Die Idee“): Entwickle zwei bis drei Leitideen und nimm die überraschendste, die zum Publikum passt. Mögliche Zutaten:
- ein Bild für das Ganze
- ein Einstieg mit Haken statt Agenda
- greifbare Vergleiche für Zahlen
- konkrete Beispiele aus dem Material
- genau ein mutiger Höhepunkt
- ein Schluss, der den Anfang aufgreift

Nenne die Idee in einem Satz. Mutig sein heißt hier: in Idee, Sprache und Dramaturgie, nicht in Deko. Beim Chef-Update bleibt sie leise.

Dann zeige die Storyline als nummerierte Liste von Action Titles im Chat:
- Jeder Titel ist die Kernaussage der Folie als ganzer Satz mit höchstens ~80 Zeichen, möglichst mit Zahl oder konkretem Ergebnis.
- Test: Wer nur die Titel liest, versteht Argument und Empfehlung.
- Gerüst nach Anlass (Guide §3), Empfehlung früh (Pyramidenprinzip).
- Bei großen Decks auf ein OK warten, bei klarem Auftrag direkt weiterbauen.

## 4. Look

- Ohne Vorgabe: `propose_looks` mit zwei eigenen Entwürfen, einem hellen, sachlichen und einem dunklen oder plakativen. Sie sollen sich in der Struktur unterscheiden (Serif/Sans, titleSize, rule, sectionTone), nicht nur in der Farbe. Lass den Nutzer wählen. Gibt er Marke, Farben oder Theme vor, rufe direkt `create_deck` auf.
- `create_deck` mit genau dem gewählten `customTheme`. Die Vorschau im Ergebnis wie ein Art Director prüfen.
- **Stil des Decks:** sachlich (Standard) oder mutig (`style` in `create_deck`/`update_deck`).
  - **Mutig** wählen, wenn der Nutzer es so einstellt oder „mutiger“, „plakativ“ bzw. „verspielter“ will, oder bei Event, Kampagne, Schule, Kultur. Dann erlaubt Guide §6 „Stil des Decks“ kräftigen Farbgrund (`vivid`), Plakat-Typo, mehr Farbflächen und markante Bilder.
  - **Sachlich:** Zurückhaltung statt Deko. Eine Akzentfarbe, Hierarchie über Größe und Weißraum. Sticker, Blobs, Verläufe und Icons als Schmuck nur auf ausdrücklichen Wunsch.

## 5. Bilder

- **Bildplan:** 2–5 Folien tragen ein Bild (Cover, Kapitelwechsel, Höhepunkt, Abschluss), nicht jede.
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
- Exportieren nur auf Wunsch: `export_deck` mit `pptx`, `pdf`, `png` oder `md` (Handout). Pfade nennen.
- Kurzer Bericht: Folienzahl, Storyline in einem Satz, getroffene Annahmen und was der Nutzer ersetzen muss (Zahlen, Zitate, Fotos).

## Häufige Fehler

- Themen-Titel („Marktanalyse“) statt einer Aussage.
- Felder raten statt aus dem Katalog nehmen.
- Freie Elemente (`items`) mit Koordinaten ohne Not; sie sind nur für Layout `blank` oder auf Wunsch des Nutzers da.
- Zwei Botschaften auf einer Folie, weil „es noch draufpasst“.
- Erfundene Zahlen ohne Hinweis.
- Empfehlung erst auf der letzten Folie, „Danke für Ihre Aufmerksamkeit“ statt nächster Schritte.
