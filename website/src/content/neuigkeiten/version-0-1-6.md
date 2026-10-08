---
titel: "Version 0.1.6: Einstellungen, Formate und Anmelden ohne Terminal"
datum: 2026-10-07
zusammenfassung: "Die Einstellungen sind eine eigene Seite, Konten verbindest du ohne Terminal, und es gibt Word-Export, ein Flyer-Layout und ein Druck-PDF mit Beschnitt."
---

Version 0.1.6 macht Deckwerk bequemer beim Einrichten und bringt neue Ausgabeformate. Die größte Änderung betrifft gar keine Folie. Alles, was mit Konten, Cloud und Schlüsseln zu tun hat, lässt sich jetzt in der App erledigen, ohne dass du Dateien von Hand bearbeitest oder ein Terminal öffnest.

Wer Deckwerk schon länger nutzt, merkt vor allem den Unterschied beim Einrichten. Wer neu dazukommt, bekommt eine Oberfläche, die beim ersten Start nicht mit Einstellungen überfrachtet ist. Die folgenden Abschnitte erklären die Neuerungen der Reihe nach.

## Einstellungen auf einer Seite

Bisher war die Einrichtung über mehrere Dialoge verteilt. Man musste wissen, wo welcher Schalter liegt, und ging leicht an einer Stelle vorbei. Jetzt liegt alles auf einer Vollbild-Seite mit einer Navigation links. Die Bereiche heißen **KI-Zugang**, **Cloud**, **Bilder**, **Marke**, **Agenten** und **Allgemeines**.

Du erreichst die Einstellungen über das Zahnrad in der Kopfleiste. Das Zahnrad ist jetzt überall verfügbar: im Start wie im Editor. Mit „Fertig“ oder „Zurück“ kommst du wieder an deine Arbeit, ohne dass ein offener Dialog im Weg steht.

Die Bereiche haben klare Aufgaben:

- **KI-Zugang** verwaltet die Konten für Claude Code, Codex und Vibe sowie die Schlüssel, die die KI braucht. Hier wählst du auch das Modell.
- **Cloud** richtet den Abgleich mit deinem Speicherdienst ein. Mehr dazu im nächsten Abschnitt.
- **Bilder** enthält die Einstellungen für die Bild-KI und die Fotosuche. Dort trägst du den Schlüssel für Unsplash ein.
- **Marke** ist für dein Brand-Kit gedacht: Farben, Schriften und Logo, die beim Anlegen neuer Decks angewendet werden.
- **Agenten** zeigt, welche Assistenten Deckwerk bereits kennen, und bietet die Einrichtung an, wenn sie noch fehlt.
- **Allgemeines** enthält die Version, den Speicherort deiner Decks und Hinweise zum Datenschutz.

Der Einrichtungsassistent beim ersten Start ist deshalb kürzer geworden. Er führt dich nur noch durch drei Schritte: Willkommen, KI-Zugang und Fertig. Alles Weitere findest du später in den Einstellungen, wenn du es brauchst. Das hält den Start leicht, und die Einstellungen bleiben trotzdem vollständig.

## Anmelden ohne Terminal

Früher musstest du Schlüssel von Hand in Dateien eintragen und Befehle im Terminal ausführen. Das war für viele die Hürde, bevor sie überhaupt eine Folie gebaut hatten. Jetzt verbindest du die Konten direkt in der App.

- **Claude Code** und **Codex** melden sich über den Browser an. Die App startet die Anmeldung, zeigt dir die Adresse und den Code an und wartet, bis du den Vorgang im Browser abgeschlossen hast. Du kannst den Vorgang jederzeit abbrechen.
- **Der Status** zeigt, mit welchem Konto du angemeldet bist und welches Abo dahintersteckt. So siehst du auf einen Blick, ob die Verbindung noch steht.
- **Abmelden** geht mit einem Klick. Danach ist der Zugang auf diesem Rechner entfernt.
- **Nextcloud** verbindest du über einen Anmeldeablauf im Browser. Die App legt dafür ein eigenes App-Passwort an. Dein Hauptpasswort gibt Deckwerk dabei nicht weiter und speichert es nicht.
- **Der Mistral-Schlüssel** für Vibe wird in den Einstellungen eingetragen. Vibe findet ihn danach von selbst.
- **Der Unsplash-Schlüssel** für Fotos steht im Bereich Bilder. Ist er gesetzt, hat er Vorrang vor dem Schlüssel aus der Umgebung deines Rechners.

Wenn du das Terminal lieber nutzt, funktioniert der bisherige Weg weiterhin. Die App ersetzt ihn nur, damit du ihn nicht mehr brauchst.

## Cloud einfacher

Der Abgleich mit einem Speicherdienst war bisher der Punkt, an dem man sich am ehesten verlaufen hat. Man musste wissen, wie die Adresse lautet, ob ein Pfad mit Schrägstrich endet und welcher Anmeldename gilt. Jetzt wählst du einen Anbieter aus einer Liste, und die App kümmert sich um den Rest.

Die Anbieter lassen sich in drei Gruppen einteilen:

- **Nextcloud** und **MagentaCLOUD** meldest du im Browser an. Du musst keine Adresse eintragen.
- **Dropbox, OneDrive, Google Drive und iCloud** laufen über den Sync-Ordner, den dieser Dienst auf deinem Rechner anlegt. Deckwerk findet ihn selbst. Die Daten bewegen sich dann über den Dienst, den du ohnehin nutzt, und du musst keine Zugangsdaten eingeben.
- **Weitere Dienste** wie HiDrive, pCloud, Koofr, kDrive, Synology oder die Storage Box trägst du mit Nutzer und Passwort ein. Zu jedem Anbieter gibt es einen Link zur passenden Anleitung, damit du die richtige Adresse findest.

Bei jedem Abgleich schützt Deckwerk deine Daten. Das Ziel des Sync-Ordners darf nie dein lokaler Ordner `~/Deckwerk` sein, und die App prüft das bei jeder Anfrage neu. Außerdem spiegelt sie Systemdateien wie `desktop.ini` oder `Thumbs.db` nicht mit. Liegt eine iCloud-Datei nur als Platzhalter auf dem Rechner, bricht der Abgleich mit einem Hinweis ab, statt Daten stillschweigend leer zu übertragen.

Zusätzlich zeigt der Abgleich jetzt seinen Fortschritt. Wer einen großen Ordner zum ersten Mal synchronisiert, sieht, wie viele Dateien verglichen und wie viele übertragen sind. Das endlose „Gleicht gerade ab …“ gibt es nicht mehr.

## Neue Formate

Ein Deck ist nicht mehr nur eine Präsentation. Die Formatwahl steht direkt neben dem Modell, und du entscheidest, was am Ende entstehen soll:

- **Präsentation** für Vortrag, Pitch und Bericht. Das ist der bisherige Standard mit Folien für den Bildschirm und den PowerPoint-Export.
- **Flyer** für A4 mit Druck-PDF und Beschnitt. Der Flyer hat ein Foto oben, einen Aktionsblock und einen QR-Code. Mehr dazu im Artikel [Flyer und Word](../flyer-und-word/).
- **Dokument** für Word (DOCX). Jede Folie wird zu einer Seite, und der Text steht in bearbeitbaren Textfeldern.
- **Social-Post** und **Story** für Beiträge in den sozialen Netzen.

Ist das Format auf „Automatisch“, wählt die KI passend zu deiner Beschreibung. Ein gewähltes Format gibt die KI als Vorgabe weiter, und es gilt auch, wenn du mit einer leeren Folie beginnst. So bleibt ein Flyer ein Flyer, auch wenn du ihn von Grund auf neu anlegst.

Die Vorlagen auf der Startseite zeigen nur die Layouts, die zum gewählten Format passen. Eine Story bekommt also keine Folienvorlage, die für den Querformat-Bildschirm gedacht ist.

## Kleinere Änderungen

- Mit `?` öffnest du die Übersicht der Tastenkürzel. Details dazu im Artikel [Tastenkürzel](../tastenkuerzel/).
- Im Editor überlappte der Titel in der Kopfleiste die Knöpfe rechts. Das ist behoben. Der Titel bekommt jetzt den Platz, den er braucht, und die Knöpfe bleiben lesbar.
- Die Vorlage „Flyer“ steht auf der Startseite, dazu der Vorschlag „Flyer für ein Sommerfest“. Der Vorschlag setzt das Format gleich mit, du musst es also nicht von Hand umstellen.
- Vor dem Druck-PDF erscheint ein Hinweis zu RGB und CMYK sowie die Empfehlung, vorab einen Probedruck zu machen.

## Was du jetzt tun kannst

Wenn du bisher nur die Standardpräsentation genutzt hast, lohnt sich ein Blick in die Einstellungen. Dort findest du die Konten, die Cloud und das Brand-Kit an einer Stelle. Danach kannst du mit demselben Briefing ein Flyer- oder Word-Dokument anlegen, ohne neu zu beginnen. Die Texte bleiben gleich, nur das Format ändert sich.
