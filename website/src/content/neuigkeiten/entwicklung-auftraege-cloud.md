---
titel: "Im Entwicklungsstand: Aufträge fürs ganze Deck und schnellerer Cloud-Abgleich"
datum: 2026-10-07
zusammenfassung: "Noch nicht in einer Version: Die KI bearbeitet alle Folien auf einmal, Texte lassen sich per Klick umschreiben, und der Cloud-Abgleich zeigt Fortschritt."
---

Diese Neuerungen sind im Entwicklungsstand nach Version 0.1.6. Sie erscheinen mit der nächsten Version. Wer Deckwerk aus dem Quellcode startet, hat sie schon. Bis zur Veröffentlichung kann sich die Oberfläche noch ändern, deshalb beschreiben wir hier das Verhalten und nicht jede Schaltfläche bis ins Detail.

Der Artikel ist in Abschnitte gegliedert, die jeweils eine Neuerung erklären. Die größten Änderungen betreffen die Arbeit mit der KI und am ganzen Deck. Dazu kommen Verbesserungen am Editor und am Cloud-Abgleich, die im Alltag oft mehr Zeit sparen, als man auf den ersten Blick erwartet.

## Aufträge fürs ganze Deck

Bisher hat die KI eine Folie nach der anderen bearbeitet. Wenn du ein ganzes Deck übersetzen oder kürzen wolltest, musstest du jede Folie einzeln anstoßen. Das ist mühsam und fehleranfällig, weil man leicht eine Folie vergisst oder unterschiedlich formuliert.

Jetzt kannst du der KI einen Auftrag für alle Folien zugleich geben. Die Aufträge findest du im ✦-Menü der KI-Leiste. Die Aufträge gelten für das gesamte Deck.

- **Übersetzen:** das ganze Deck in eine andere Sprache, etwa ins Englische.
- **Notizen schreiben:** für jede Folie Notizen, die dir beim Vortrag helfen.
- **Kürzen:** das Deck auf die wichtigsten Sätze zurückführen.
- **Zusammenfassen:** aus dem Deck einen zusammenhängenden Text machen, etwa für eine E-Mail oder einen Bericht.
- **Rechtschreibung prüfen:** alle Folien auf Fehler durchgehen und Vorschläge machen. Du entscheidest für jede Änderung selbst, ob sie übernommen wird.

Wichtig ist, dass du die Ergebnisse prüfst. Die KI übersetzt gut, aber Fachbegriffe, Eigennamen und Zahlen sollten von dir kontrolliert werden, bevor das Deck das Haus verlässt.

## Text umschreiben per Klick

Nicht jeder Text braucht einen eigenen Auftrag. Oft willst du nur eine einzelne Überschrift oder einen Absatz straffen. Dafür gibt es das Umschreiben per Klick.

Markierst du ein Textfeld, auch eines, das zu einem Layout gehört, zeigt das ✦-Menü oben „Gewählter Text“ mit diesen Aktionen: kürzer, ausführlicher, einfacher, förmlicher, lockerer, korrigieren und übersetzen. Darunter stehen die Aufträge für das ganze Deck. Du musst keinen Auftrag formulieren, ein Klick genügt.

Das ist besonders nützlich bei Layout-Feldern. Dort liegt der meiste Text einer Präsentation, aber bisher bot das Menü nur für frei platzierte Textelemente Aktionen an. Jetzt funktioniert es für beides gleich.

## Versionsverlauf mit Vorschau

Eine Präsentation entsteht selten in einem Rutsch. Du änderst etwas, gefällt es dir nicht, und du möchtest den früheren Stand zurück. Dafür gibt es den Versionsverlauf.

Alte Stände eines Decks bleiben darin erhalten. Du siehst sie als Vorschau, ohne das aktuelle Deck zu verändern. Findest du den richtigen Stand, stellst du ihn mit einem Klick wieder her. So kannst du auch Experimente wagen, etwa eine ganz neue Gliederung, weil du dir sicher sein kannst, dass der alte Stand nicht verloren geht.

Der Versionsverlauf ersetzt keine Sicherung im Sinne eines Backups. Er hilft beim Zurückgehen innerhalb eines Decks, nicht beim Schutz vor einem beschädigten Datenträger. Für den letzteren Fall bleibt der Abgleich mit der Cloud die bessere Wahl.

## Rechtschreibprüfung mit Vorschlägen

Die Rechtschreibprüfung läuft für Deutsch und Englisch. Ein Rechtsklick auf eine markierte Stelle zeigt die Vorschläge, und du übernimmst den passenden mit einem Klick. Das funktioniert auch beim Bearbeiten des Folientextes, also während du tippst.

Die Prüfung lässt sich abschalten, falls sie dich stört oder du einen Text in einer Fachsprache schreibst, die sie nicht kennt. Schaltest du sie aus, lädt Deckwerk auch keine Wörterbücher mehr herunter. Die Sprache wird nur gesetzt, wenn die Prüfung eingeschaltet ist, und ein Schalter springt zurück, wenn das Speichern fehlschlägt.

## Ebenen-Panel

Auf einer Folie liegen oft viele Elemente übereinander: Texte, Formen, Bilder, Linien. Wer ein Element auswählen will, das von einem anderen verdeckt wird, hat es bisher nicht leicht. Das Ebenen-Panel listet alle Elemente der Folie auf.

Du wählst ein Element über die Liste aus. Du ziehst die Reihenfolge um, damit ein Element vor oder hinter einem anderen liegt. Und du sperrst ein Element, damit es beim Arbeiten nicht verrutscht. Gesperrte Elemente lassen sich nicht verschieben, bis du die Sperre wieder löst.

Das Panel ist besonders hilfreich bei Folien mit vielen Ebenen, etwa bei einem Diagramm mit Beschriftungen oder einer Folie mit Hintergrundbild und darüberliegendem Text.

## Suchen und Ersetzen im ganzen Deck

Mit `Strg+F` suchst du im gesamten Deck, mit `Strg+H` ersetzt du. Das ist der Weg, wenn sich ein Produktname geändert hat, eine Telefonnummer falsch ist oder ein Begriff einheitlich werden soll.

Gesucht wird im sichtbaren Text: im Folieninhalt, in freien Textfeldern, in den Notizen und im Deck-Titel. Bilder, Links, QR-Codes und Auswahlwerte bleiben unberührt. Markdown-Links werden nur im Text ersetzt, damit keine Adresse versehentlich kaputtgeht.

„Alle ersetzen“ lässt sich mit einem einzigen Rückgängig-Schritt zurücknehmen. Das ist wichtig, weil ein Ersetzen über das ganze Deck mit einem Klick passiert. Prüfe vorher, was gefunden wird, und nimm den Schritt nur zurück, wenn es nötig ist.

## Folien ausblenden

Manchmal willst du eine Folie nicht löschen, sondern nur für den Moment weglassen. Eine Zahlenfolie, die nur Antwort auf eine mögliche Frage ist, oder eine Schlussfolie für eine Fassung des Vortrags, die du sonst nicht brauchst. Dafür blendest du die Folie aus.

Eine ausgeblendete Folie bleibt im Deck, wird aber beim Präsentieren übersprungen. Auch beim Export als PDF, PNG, Word oder Handout fehlt sie. In der PowerPoint-Datei bleibt sie versteckt erhalten, sodass du sie dort mit wenigen Klicks wieder einblenden kannst. Das ist praktisch, wenn ein Deck für zwei Anlässe gebraucht wird, mit unterschiedlichen Folien.

Die KI weiß davon. Wenn sie eine Auflistung der Folien erstellt, markiert sie ausgeblendete Folien mit dem Zusatz „(ausgeblendet)“, damit du sie nicht versehentlich übersiehst.

## Bild per KI erzeugen

Nicht jedes Bild findest du fertig. Manchmal brauchst du eine Illustration, die es so noch nicht gibt. Im Einfügen-Panel gibt es dafür den Bereich „Bild erzeugen“.

Du beschreibst das Bild, wählst Querformat, Hochformat oder Quadrat und startest die Erzeugung. Die Einstellungen für den Anbieter der Bild-KI findest du in den Einstellungen unter Bilder. Ist dort noch kein Anbieter gesetzt, führt dich das Panel direkt dorthin.

Im selben Panel findest du „Deine Bilder“. Dort erscheinen die neuesten sechzig Bilder aus deinem Deckwerk-Ordner, damit du eigene Fotos und frühere Erzeugnisse wiederverwenden kannst, ohne sie erneut zu suchen.

## Cloud-Abgleich

Der Abgleich mit der Cloud ist technisch der Bereich mit den größten Verbesserungen. Die Änderungen sind unscheinbar, verändern aber, wie sich der Abgleich im Alltag anfühlt.

- **Mehrere Dateien gleichzeitig.** Bis zu vier Dateien werden parallel übertragen. Ein erster Abgleich mit 175 Dateien und 119 MB dauerte zuvor über elf Minuten, davon waren nur etwa dreieinhalb Minuten echte Übertragung. Der Rest war Wartezeit, die jetzt wegfällt.
- **Sichtbarer Fortschritt.** Der Abgleich zeigt, wie viele Dateien verglichen und wie viele übertragen sind, und die Größe in Megabyte. Die Anzeige erscheint in den Einstellungen und in der Cloud-Ansicht.
- **Zeitlimit je Anfrage.** Ein Server, der nicht antwortet, hat den Abgleich früher für immer blockiert. Jetzt gibt es für jede Anfrage eine Grenze, die sich aus der Dateigröße und einer angenommenen Mindestgeschwindigkeit ergibt. Was bereits erledigt ist, bleibt gemerkt, und der nächste Lauf macht dort weiter.
- **Zwischenstand alle 20 Übertragungen.** Die App sichert den Stand regelmäßig. Wird sie mitten im ersten großen Upload beendet, lädt der nächste Lauf schon hochgeladene Dateien nicht erneut herunter.
- **Keine internen Kennungen.** Bei Nextcloud mit Single Sign-on erschien früher eine lange Hexadezimal-Zeichenkette als Nutzername. Diese Kennung wird nicht mehr angezeigt.

Wer viele Decks und Bilder synchronisiert, merkt den Unterschied vor allem beim ersten Abgleich auf einem neuen Rechner. Danach laufen die Läufe deutlich ruhiger, weil nur noch geänderte Dateien übertragen werden.

## Was du ausprobieren kannst

Wenn du Deckwerk aus dem Quellcode startest, kannst du die Neuerungen sofort testen. Ein sinnvoller Einstieg ist, ein bestehendes Deck zu übersetzen und danach mit dem Versionsverlauf zum Original zurückzugehen. So siehst du, wie die Aufträge und der Verlauf zusammenspielen. Danach lohnt sich ein Blick auf das Ebenen-Panel, wenn du eine Folie mit vielen Elementen hast.

Rückmeldungen sind willkommen, gerade wenn etwas unerwartet reagiert. Die Entwicklung läuft laufend, und kleine Hinweise aus dem Alltag fließen oft direkt in die nächste Fassung ein.
