---
titel: "Serienbrief, Links und Linien, die mitwandern"
datum: 2026-10-10
zusammenfassung: "Ab der nächsten Version macht Deckwerk aus einer Liste viele Urkunden oder Einladungen, verlinkt Elemente auf Folien und Webseiten, verbindet Formen mit Linien und setzt Text sorgfältiger."
---

Diesmal geht es um Kleinigkeiten, die im Alltag viel Arbeit sparen. Drei davon kennt man aus Canva: Serienbrief, Links und Verbindungslinien. Dazu kommen der Alternativtext für Bilder und ein paar Satzregeln, die man nicht sofort sieht, aber spürt.

## Serienbrief aus einer Liste

Zwanzig Teilnahmeurkunden, dreißig Namensschilder, eine Einladung für jede Familie der Klasse: Bisher hieß das, dieselbe Seite immer wieder zu kopieren und den Namen zu ändern. Jetzt gestaltest du die Seite einmal und setzt an die Stellen, die sich ändern, einen Platzhalter in doppelten geschweiften Klammern, zum Beispiel `{{Name}}` oder `{{Kurs}}`.

Dazu kommt eine Tabelle als CSV-Datei, wie sie jedes Tabellenprogramm speichert. Die erste Zeile nennt die Spalten, darunter steht je Zeile eine Person. Im Menü wählst du „Serienbrief (CSV) …“ und die Datei. Deckwerk legt für jede Zeile ein eigenes PDF an und benennt es nach dem ersten Wert der Zeile, meist also nach dem Namen. So findest du jede Urkunde sofort wieder.

Fehlt in der Tabelle eine Spalte, die im Text vorkommt, sagt Deckwerk das, bevor es losgeht, statt dreißig Urkunden mit `{{Kurs}}` zu drucken. Die KI kennt den Serienbrief ebenfalls. Sag ihr „Urkunden für alle aus teilnehmer.csv“, dann setzt sie die Platzhalter selbst und exportiert die ganze Serie, auch als PowerPoint, Word oder PNG.

## Links auf Folien und Webseiten

Freie Elemente wie Texte, Formen, Bilder und Icons können jetzt einen Link tragen. Im Bereich „Anpassen“ steht dafür das Feld „Link“. Eine Adresse wie `https://…` öffnet die Webseite, `#5` springt zu Folie 5.

Das ist praktisch für eine Übersicht am Anfang, von der aus du beim Vortrag direkt zu einem Kapitel springst, oder für einen Knopf „Zurück zur Übersicht“ auf jeder Kapitelfolie. Die Links funktionieren beim Präsentieren in Deckwerk und genauso in der exportierten PowerPoint. Zeigt ein Link auf eine Folie, die es nicht gibt, meldet die Prüfung das, bevor du vor Publikum stehst.

## Linien, die mitwandern

Für Abläufe, Organigramme und kleine Schaubilder braucht man Linien zwischen Kästen. Bisher musste jede Linie neu gezogen werden, sobald man einen Kasten verschob. Jetzt markierst du zwei Elemente und klickst „Mit Linie verbinden“. Die Linie hängt an beiden Enden und folgt, wenn du eines davon verschiebst oder seine Größe änderst.

Duplizierst du zwei verbundene Elemente samt Linie, hängt die Kopie der Linie an den Kopien, nicht an den Originalen. So baust du eine Kette aus Schritten schnell auf, ohne nachzuarbeiten. Strichart, Stärke und Pfeilspitzen stellst du wie bei jeder anderen Linie ein.

## Alternativtext für Bilder

Wer eine Präsentation verschickt, weiß nicht, wer sie liest. Menschen, die nicht oder schlecht sehen, lassen sich Folien vorlesen. Dafür braucht jedes Bild einen kurzen Text, der sagt, was darauf zu sehen ist. Im Bereich „Anpassen“ gibt es bei Bildern jetzt das Feld „Alternativtext“. Er wandert in die PowerPoint und wird dort von Screenreadern vorgelesen.

Fehlt der Text bei einem Bild, weist die Prüfung darauf hin. Ein kurzer Satz genügt, zum Beispiel „Team beim Aufbau des Messestands“.

## Satz wie vom Setzer

Ein paar Regeln, die gute Setzer seit jeher anwenden, fehlen generierten Folien fast immer. Deckwerk beachtet sie jetzt von selbst.

- **Hängende Anführungszeichen.** Beginnt ein Zitat mit „, steht das Zeichen links im Rand. Die Buchstaben fluchten dann mit dem Text darüber und darunter, statt um ein Zeichen eingerückt zu wirken.
- **Keine Einzelwörter.** Fließtext bricht so um, dass in der letzten Zeile nicht ein einzelnes Wort allein steht.
- **Große Titel enger.** Je größer eine Schrift, desto weiter wirken die Abstände zwischen den Buchstaben. Große Titel setzt Deckwerk deshalb etwas enger als kleine.
- **Gedankenstriche.** Ein Gedankenstrich beginnt keine neue Zeile, er bleibt beim Wort davor.

Einzeln fällt keine dieser Regeln auf. Zusammen machen sie den Unterschied zwischen einer Folie, die ordentlich aussieht, und einer, die gesetzt wirkt.

## So probierst du es aus

Den Serienbrief probierst du am schnellsten mit einer Urkunde aus der Galerie: Ersetze den Namen durch `{{Name}}`, leg eine CSV mit einer Spalte „Name“ an und wähle im Menü „Serienbrief (CSV) …“. Links und Linien findest du bei jedem freien Element im Bereich „Anpassen“. Mit Claude Code oder Codex geht alles ebenso, der Deckwerk-Skill kennt die neuen Felder.
