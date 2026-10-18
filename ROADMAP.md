# Deckwerk: Roadmap

Stand 15.10.2026. Quellen: `CANVA-VERGLEICH.md` (§ „Noch offen“, §7, §8), `CANVA-AI-LUECKEN.md`, Branches und Memories. Keine Termine, nur Reihenfolge nach Wirkung.

**Leitplanken** (gelten für alles unten)
- Jede neue Funktion braucht einen nativen PPTX-Weg oder bleibt draußen. Die echte PPTX ist der Vorsprung vor Canva.
- Zurückhaltend gestalten: flach, eine Akzentfarbe, keine Deko als Standard. Neue Stil-Hebel nur als kleine Enums mit guten Optionen.
- Neues Tool → Zahlen in `agent-smoke.ts`, `mcp-smoke.ts`, `mcp-e2e.ts` anpassen; Ablauf-Änderungen in den Skill übernehmen.

## Jetzt: Offenes abschließen

Die Branches `feat/video-*`, `feat/startseite`, `feat/ki-routing`, `feat/asr-modelle`, `feat/parakeet-ultra`, `feat/gemeinsam-bearbeiten` und `feat/mensch-statt-ki` sind nicht alle in `master`.

1. **Branch-Aufräumen:** je Branch klären, ob gemergt, verworfen oder weitergeführt wird. `master` und Release-Version (`package.json` steht hier auf 0.1.6) angleichen.
2. **Startseite:** „eigener Weg“ und Video im Format-Regal fertigstellen; offen sind Website und Tests.
3. **Design-Tokens T8b:** Renderer-Schriften (Branch `ship/t8b-fonts-ui`).
4. **Cloud-Sync:** Android-Pfade, Rest der offenen Punkte aus `deckwerk-cloud-sync`.
5. **PowerPoint-Abnahme in echtem PowerPoint** (`examples/abnahme.json`): Texteffekte, `custGeom`-Masken, neue Übergänge. Braucht eine Person mit Office.

## Als Nächstes: Editor und Layouts

Nach Wirkung sortiert, aus dem Canva-Vergleich:

1. ~~Tabelle als freies Element, nativ in PowerPoint, mit Zeilen-/Spalten-Editor.~~ Erledigt 16.10. (5c60aae…11d6b19).
2. Aufzählungen und Links per Knopf in freien Textfeldern.
3. „Andere Gestaltung“: 3–4 Mini-Vorschauen, Layoutwechsel per `convertsTo`.
4. Verlauf-Editor (bis 3 Stopps, Winkel, radial) und `bg.pattern`.
5. Animationen: Geschwindigkeit, Verzögerung, Dauer, „mit/nach vorherigem“.
6. Lineale, Raster, gespeicherte Hilfslinien; Stil übertragen, Pipette.
7. Bildfilter-Presets und Tönung; Foto auf Platzhalter ziehen.
8. Schriftwahl mit Vorschau, weitere OFL-Familien.
9. Vorlagen-Galerie im Startbildschirm ausbauen.

## Danach: KI

1. Bild per KI bearbeiten (Objekt entfernen/ersetzen, Images-Edits-API; Keys sind vorhanden).
2. Magic Switch zu Social-Posts mit Bildunterschriften als eigenes Werkzeug.
3. Quiz und Umfrage als Layout oder Element (nur mit PPTX-Weg).
4. Kernprompt klein halten (heute ~15k), Router (Haiku/Codex/Vibe) weiter messen.

## Video

Läuft als eigener Strang (Schnitt, Highlights, ASR, Handy-Export, Effekte, Profi-Funktionen).
1. Stabilisieren: Quelle/Musik-Fixes, lange Videos, Export-Fortschritt.
2. Handy-Pfad (Parakeet, ffmpeg) auf weitere Geräte testen.
3. **Auflösung 4K und 8K:** Der Export ist heute auf 1080p ausgelegt (libx264, CRF 20, feste 30 fps, Platzschätzung und x264-Preset auf 1080p getrimmt).
   - Ausgabegröße wählbar: 720p, 1080p, 1440p, 4K (3840×2160), 8K (7680×4320) in 16:9, 9:16, 1:1.
   - Quelle nie hochskalieren: Standard = Quellgröße, gedeckelt auf die Auswahl; Hinweis, wenn die Quelle kleiner ist.
   - Bei 4K/8K H.265 (HEVC) anbieten, weil H.264 ab 4K Level und Dateigröße sprengt; Fallback auf H.264, wenn der ffmpeg-Build keinen Encoder hat.
   - Speicher und Zeit: Decoder-Grenze (heute 20 parallel) je Auflösung senken, Zeit- und Platzschätzung auf Pixelzahl skalieren, Warnung vor dem Start (8K ≈ 16× die Last von 1080p).
   - Vorschau, Frames, Szenenerkennung und Gesichtssuche bleiben auf Proxy-Größe (320 px), nur der Export rechnet in voller Größe.
   - Handy-Export: auf 1080p begrenzen (kein H.265/GPU, sherpa API 24); 4K/8K rechnet der PC.
   - Hardware-Encoder (NVENC, VAAPI, VideoToolbox im Mac-Fork) optional, mit Fallback auf Software.
   - Test: ein 4K-Beispielclip in CI (kurz, 3 s), 8K nur manuell.
4. **Weiteres im Export:**
   - Bildrate der Quelle übernehmen (24/25/30/50/60 statt fest 30), HDR/10 Bit mit Tonemapping nach SDR.
   - Qualitätsstufen (Entwurf / Standard / Hoch) statt fester CRF; Ziel-Dateigröße für Plattformen (z. B. 50 MB, 500 MB).
   - Plattform-Vorgaben: YouTube, Shorts, Reels, TikTok, Mastodon/Discord-Limit, je mit Größe, Länge und Bitrate.
   - Seitenverhältnis-Umwandlung in einem Rutsch (16:9 → 9:16 mit Gesichts-/Sprecher-Nachführung, unscharfer Rand bleibt als Alternative).
   - Mehrere Formate gleichzeitig aus einem Schnitt exportieren (Warteschlange, serielle Ausführung wegen RAM).
   - Export abbrechen und fortsetzen, Fortschritt je Teilstück.
   - Alternative Container und Audio: WebM/VP9/AV1, nur Audio (MP3/M4A), getrennte Spuren (Sprache/Musik), Lautheit auf −14 LUFS normieren.
   - Untertitel als eigene Datei (SRT gibt es) zusätzlich als WebVTT, Kapitelmarken aus den Highlights.
5. **Live-Chat einblenden** (Chat-Replay im Clip, wie bei Stream-Highlights üblich):
   - **Ausgangslage:** `import_video` lädt den Chat von YouTube (yt-dlp) und Twitch (`twitch-chat.ts`, TwitchDownloaderCLI) schon mit, bisher nur als Signal für `video_highlights`. Die Nachrichten mit Zeit, Name und Text liegen also vor.
   - **Lösung:** Chat als ASS-Spur bauen und über libass einbrennen. Das ist derselbe Weg wie bei Untertiteln und Bauchbinden, braucht also keine neue Abhängigkeit und rechnet auch auf dem Handy-ffmpeg.
     1. Chat auf das Clip-Fenster zuschneiden (`from`/`to`), Zeiten auf Clip-Beginn verschieben.
     2. Je Nachricht ein ASS-Ereignis: Name in Chat-Farbe, Text weiß, Schatten oder halbtransparenter Grund für Lesbarkeit. Die letzten 6–8 Nachrichten stehen untereinander, ältere schieben nach oben und blenden aus.
     3. Lage im Clip: Spalte links oder rechts unten, im 9:16-Short unter der Mitte außerhalb der Plattform-Oberfläche (Safe-Zone). Breite und Schriftgröße aus der Ausgabegröße abgeleitet, also auch für 4K.
     4. Neues Feld am Clip, z. B. `chat: { pos, zeilen, tempo }`, als Overlay-Art neben `bauchbinde`/`titel`; im Guide und Skill einen Satz dazu.
   - **Lesbarkeit und Maß:**
     - Höchstens eine Nachricht je 0,5 s, Spam und Wiederholungen („LUL“ × 20) zu „×20“ zusammenfassen.
     - Auf Wunsch nur die Nachrichten rund um die Highlight-Momente (Chat-Spitzen) zeigen.
     - Emotes: Phase 1 als Text, Phase 2 als Bild (Twitch/7TV/BTTV-CDN, einmal laden und zwischenspeichern).
   - **Kick** hat keinen Chat-Download in yt-dlp; erst nach Prüfung der öffentlichen API, sonst bleibt Kick ohne Chat.
   - **Schutz:** Nutzernamen sind personenbezogen. Standard „Namen ausblenden“ oder kürzen, Namen nur auf ausdrücklichen Wunsch; Hinweis auf die Rechte am Stream, wie schon beim Import.
   - **Ohne Aufzeichnung:** Laufende Livestreams gehen weiter erst nach dem Ende. Echte Live-Einblendung während der Übertragung (OBS-Overlay) ist ein anderes Produkt und bleibt draußen.
   - **Test:** kleine Chat-JSON-Fixture, ASS-Datei prüfen (Zeiten, Zeilenzahl, Zusammenfassung), ein 5-s-Clip im Export; `scripts/check-chat-overlay.ts` mit Aufruf in der ersten Zeile.
6. **Für Streamer** (Zielgruppe: Aufzeichnungen von 2–8 h zu Shorts, Highlights und Zusammenschnitten machen). Nach Wirkung sortiert, alles auf dem vorhandenen Weg (yt-dlp, Transkript, `video_highlights`, libass):
   1. **Highlights schärfer:** zusätzlich zum Chat-Signal Lautstärke-Spitzen (Schreien, Lachen), Szenenwechsel im Spiel (Kill, Sieg, Niederlage per Bildänderung) und Schlüsselwörter aus dem Transkript („clip it“, „was war das“) gewichten. Jedes Fenster bekommt eine kurze Begründung, damit man nicht blind glaubt.
   2. **Gameplay plus Kamera als Short (9:16):** Spielbild oben, Webcam unten, Layout aus Vorlagen wählbar. Kamera-Ausschnitt einmal markieren und für den ganzen Stream merken.
   3. **Wort-für-Wort-Untertitel im Short-Stil:** das gesprochene Wort hebt sich hervor, große Schrift, Schriftart und Farbe aus dem Brand-Kit des Kanals. Das ist die häufigste Erwartung bei Shorts und Reels.
   4. **Kanal-Vorlage („Hausstil“ fürs Video):** Logo, Farben, Untertitelstil, Intro/Outro, Musikpegel, Chat-Lage einmal speichern und auf jeden Clip anwenden, wie `brand.json` bei Folien.
   5. **Stapel-Export:** aus einem Stream die besten 5–10 Fenster in einem Auftrag als fertige Shorts, Warteschlange seriell wegen RAM, Vorschau-Kontaktabzug zum Aussortieren vorher.
   6. **Totzeiten und Füllwörter kürzen:** Pausen (gibt es) plus „ähm“, Ladebildschirme, AFK-Phasen und lange Stille erkennen und mit einem Klick herausnehmen; Schnitt bleibt vor dem Export sichtbar und umkehrbar.
   7. **Spoiler- und Peinlichkeitsfilter:** Passwörter, Mails und Privates auf dem Bildschirm per Texterkennung finden und verpixeln (Verpixeln gibt es); Schimpfwörter im Ton per Pieps stummschalten, falls die Plattform es verlangt.
   8. **Lizenzfreie Musik und Urheberrecht:** Hinweis bei Musik im Original-Ton (Twitch-VODs stumm geschaltete Abschnitte erkennen), Vorschlag aus lizenzfreien Quellen (`find_music` gibt es), Quellenangabe automatisch in die Beschreibung.
   9. **Titel, Beschreibung, Kapitel, Hashtags:** je Clip Textvorschläge für YouTube, TikTok, Shorts im Kanalstil; Kapitelmarken für den langen Zusammenschnitt aus den Highlights.
   10. **Thumbnail aus dem Clip:** bestes Standbild (Gesicht, Ausdruck) plus Titel in großer Schrift, Export als PNG 1280×720; nutzt die Folien-Engine, also auch mit Brand-Kit.
   11. **Mehrere Streamer in einem Clip:** zwei Quellen (Gast, Kollaboration) nebeneinander oder wechselnd nach Sprecher, mit Tonabgleich über das Transkript.
   12. **Alerts und Donations im Rückblick:** Follower-, Sub- und Spendenereignisse aus dem Chat-Log (Twitch) als Marker auf der Zeitleiste, damit Highlights rund um Raids und Subathons schneller zu finden sind.
   13. **Automatisch nach dem Stream:** Ordner oder Kanal beobachten, neue Aufzeichnung laden, transkribieren, Highlights vorschlagen und eine Benachrichtigung schicken. Nur nach Freigabe; Export startet nie von allein.
   - **Grenzen:** kein Live-Schnitt und kein OBS-Plugin, keine Upload-Automatik zu Plattformen (Konten und Schlüssel), nur Material mit Rechten. Plattform-Upload nur als Datei plus fertigem Text zum Einfügen.
7. Bewusst klein bleiben: Ziel ist Kurzclip aus Stream/Vortrag, kein Schnittprogramm. Mehrspur-Zeitleiste, Keyframes und Farbkorrektur bleiben draußen.

## Qualität und Betrieb

1. Stresstest `check:layouts` regelmäßig im Hintergrund, vor jedem Release in allen Formaten.
2. Befunde aus `SECURITY-REVIEW.md` abarbeiten, Review nach größeren IPC-/Sync-Änderungen wiederholen.
3. CI: Selbsttests der neuen Funktionen (Konnektor, Serienbrief, Link, Alt-Text) aufnehmen.
4. macOS-Fork `deckwerk-macos` nach jedem Release mit `macify.mjs` abgleichen.

## Bewusst draußen

Kommentare, Teilen-Links, Zusammenarbeit, Canva Live, Whiteboard, Stock-Bibliothek, Magic Eraser/Grab/Expand, Magic Layers/Animate, Bogentext, Show-Effekte (Glitch, Echo), Infografik-Langformat, weitere Social-Größen, Deko als Standard. Nur auf ausdrücklichen Wunsch.

## Offene Entscheidungen

1. Illustrationen: eigene SVGs oder offene Sets (Open Peeps, Humaaans, unDraw)?
2. Wer macht die PowerPoint-Abnahme, auf welcher Office-Version?
3. Pixelgenauer PPTX-Import: lohnt der Aufwand?
