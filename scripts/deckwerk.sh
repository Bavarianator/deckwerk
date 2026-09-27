#!/bin/sh
# Startet Deckwerk (Desktop-Eintrag; mit --mcp als MCP-Server für Claude Code, daher Build-Ausgabe nach stderr). Baut vorher neu, wenn sich Quellen seit dem letzten Build geändert haben.
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
# Wayland: das verborgene Druckfenster malt nie, printToPDF hängt → Electron immer über XWayland starten
set -- --ozone-platform=x11 "$@"
# --mcp: Claude Code wartet höchstens 30 s auf den Server, ein Build dauert länger → vorhandenen Build nehmen
case " $* " in *" --mcp "*) [ -f out/main/index.js ] && exec ./node_modules/.bin/electron . "$@" ;; esac
# Zweiter Klick während eines Builds: nicht parallel bauen (leert out/ unter dem ersten weg), das erste Fenster kommt gleich
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/deckwerk-build.lock"
flock -n 9 || { notify-send -a Deckwerk -i "$PWD/assets/icon.png" Deckwerk 'Wird noch gebaut – das Fenster öffnet sich gleich.' 2>/dev/null; exit 0; }
if [ ! -f out/main/index.js ] || [ -n "$(find src assets package.json -newer out/main/index.js -print -quit)" ]; then
  notify-send -a Deckwerk -i "$PWD/assets/icon.png" Deckwerk 'Neue Version wird gebaut (etwa 1 Minute) …' 2>/dev/null
  ./node_modules/.bin/electron-vite build >&2 || { notify-send -u critical -a Deckwerk Deckwerk 'Build fehlgeschlagen. Details: npm run build' 2>/dev/null; exit 1; }
fi
exec 9>&-
exec ./node_modules/.bin/electron . "$@"
