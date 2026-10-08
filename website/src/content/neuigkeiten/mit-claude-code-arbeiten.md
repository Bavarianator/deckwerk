---
titel: "Mit Claude Code, Codex oder Vibe arbeiten"
datum: 2026-09-27
zusammenfassung: "Deckwerk läuft als MCP-Server: Dein KI-Assistent im Terminal baut Präsentationen direkt in der Deckwerk-App mit."
---

Du musst Folien nicht selbst klicken. Deckwerk stellt seine Werkzeuge als MCP-Server bereit, und Claude Code, Codex oder Vibe nutzen sie direkt. Du beschreibst im Terminal, was du brauchst, und der Assistent legt das Deck an, fügt Folien hinzu und prüft jede Folie auf Platz und Lesbarkeit. Das Ergebnis liegt danach in der Deckwerk-App, wo du es weiter bearbeitest.

Der Artikel erklärt, was ein MCP-Server ist, wie du die Verbindung einrichtest, was der Assistent dabei tut und welche Grenzen es gibt. Am Ende steht ein vollständiges Beispiel, das du nachbauen kannst.

## Was ein MCP-Server ist

MCP steht für Model Context Protocol. Gemeint ist ein Standard, über den ein KI-Assistent Werkzeuge einer anderen Anwendung benutzen kann. Deckwerk stellt solche Werkzeuge bereit: Ein Deck anlegen, Folien hinzufügen, eine Folie ändern, die Prüfung laufen lassen, das Deck speichern. Der Assistent ruft sie auf, wenn sie gebraucht werden, und erhält die Antwort zurück.

Für dich heißt das: Du sprichst mit dem Assistenten in deiner gewohnten Umgebung, und er übersetzt deine Wünsche in Aufrufe an Deckwerk. Du musst die Werkzeuge nicht kennen, und du musst keine Befehle eintippen, die über das Gesagte hinausgehen.

## So richtest du es ein

Die Einrichtung dauert wenige Minuten und passiert in der App:

1. Öffne in Deckwerk die Einstellungen und wähle den Bereich **Agenten**.
2. Trage Deckwerk in deinen Assistenten ein. Die App erkennt, welche Programme auf deinem Rechner installiert sind, und bietet die Einrichtung dort an. Du musst den Pfad zur Programmdatei nicht selbst suchen.
3. Teste die Verbindung. Die App prüft, ob der Assistent Deckwerk erreicht. Gelingt der Test, zeigt die Seite Beispiel-Prompts, die du kopieren kannst.

Zusätzlich legt die Einrichtung eine Anleitung ab, einen sogenannten Skill. Sie erklärt dem Assistenten den Ablauf: das Briefing klären, Titel festlegen, Folien in kleinen Paketen bauen und jede Rückmeldung der Prüfung sofort beheben. Du musst diesen Ablauf nicht kennen, der Assistent folgt ihm von selbst. Die Anleitung liegt bei Claude Code im Ordner für Skills, bei Codex im entsprechenden Ordner für Codex.

Die Anmeldung läuft ebenfalls über die App. Claude Code und Codex melden sich über den Browser an, für Vibe trägst du den Mistral-Schlüssel direkt in den Einstellungen ein. Ein Terminal brauchst du dafür nicht. Du brauchst es nur für die Arbeit mit dem Assistenten selbst, und dort auch nur, wenn du ihn aufrufst.

## Was der Assistent tut

Ein typischer Ablauf sieht so aus. Du gibst ihm eine Aufgabe. Er stellt dir gegebenenfalls ein oder zwei Rückfragen, etwa zur Zielgruppe oder zur Länge. Danach schlägt er eine Gliederung mit Titeln vor. Du prüfst sie und sagst, was du ändern willst.

Erst dann baut er die Folien. Er arbeitet dabei in Paketen von vier bis sechs Folien und wartet nach jedem Paket auf die Rückmeldung der Prüfung. Die Prüfung misst, ob der Text in die Folie passt, und meldet Folien, die zu voll sind oder deren Schrift zu klein wird. Der Assistent korrigiert diese Folien selbst, etwa durch kürzeren Text, bevor er weitermacht.

Am Ende prüft er das gesamte Deck noch einmal und speichert es. Du öffnest es in Deckwerk und arbeitest dort weiter wie an jedem anderen Deck.

## Ein vollständiges Beispiel

Du hast ein Projekt, zu dem du einen Pitch brauchst, und die Beschreibung steht in einer README-Datei im Projektordner. Dann schreibst du dem Assistenten:

„Erstelle mit Deckwerk einen 10-Folien-Pitch für mein Projekt aus der README. Die Zielgruppe sind Förderer, die Zeit sind zehn Minuten.“

Der Assistent liest die Datei und schlägt eine Gliederung vor. Vielleicht sieht sie so aus: Titel, Problem, Lösung, Wie es funktioniert, Markt, Stand, Team, Ziele, Finanzierung, Abschluss. Du bestätigst oder änderst einzelne Punkte.

Danach baut er die Folien in vier Paketen. Nach dem ersten Paket meldet die Prüfung vielleicht, dass die Folie „Wie es funktioniert“ zu voll ist. Der Assistent kürzt den Text und meldet, dass die Folie nun passt. So geht es weiter, bis alle zehn Folien stehen.

Zum Schluss erhältst du eine kurze Zusammenfassung: Wie viele Folien entstanden sind, welche Folien die Prüfung beanstandet hat und wie der Assistent das gelöst hat. Das Deck liegt gespeichert in der App, und du kannst jede Folie nachbessern.

## Was du beachten solltest

Der Assistent kennt nur das, was du ihm sagst. Er weiß nicht, wer im Publikum sitzt, wie lange du sprichst oder welche Zahlen intern besonders wichtig sind. Gib ihm das Briefing mit: Zielgruppe, Anlass, Länge und die Kernbotschaft. Je genauer die Beschreibung, desto weniger Korrekturen brauchst du.

Lies die Gliederung, bevor er Folien baut. Eine falsche Gliederung zu korrigieren ist schneller, als ein falsches Deck zu reparieren. Wenn der Assistent in der Gliederung eine Folie vergessen hat oder eine überflüssig findet, sag es jetzt, nicht erst am Ende.

Prüfe die Zahlen und Namen selbst. Der Assistent übernimmt, was in deiner Beschreibung steht. Wenn du Zahlen aus einer Quelle übernimmst, kontrolliere sie gegen die Quelle, bevor das Deck an jemand anderen geht.

Die Gestaltung ist ein Ergebnis der Prüfung, nicht der Kunst. Der Assistent sorgt dafür, dass der Text passt und die Schrift lesbar bleibt. Feinarbeit an Bildern, Farben und Abständen machst du danach in der App.

## Kurz gesagt

Einmal einrichten, dann im Terminal beschreiben, was du brauchst. Der Assistent baut das Deck in kleinen Schritten, korrigiert sich nach jeder Prüfung und speichert das Ergebnis. Du gibst die Richtung vor und kontrollierst die Gliederung und die Zahlen. Den Rest machst du in der App.
