#!/bin/sh
# Startet Deckwerk (Desktop-Eintrag; mit --mcp als MCP-Server für Claude Code, daher Build-Ausgabe nach stderr). Baut vorher neu, wenn sich Quellen seit dem letzten Build geändert haben.
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
# Wayland: das verborgene Druckfenster malt nie, printToPDF hängt → Electron immer über XWayland starten.
# MCP-Clients wie Vibe oder Codex geben dem Server eine Umgebung ohne DISPLAY: dann ohne Bildschirm rendern (etwas langsamer)
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then set -- --ozone-platform=x11 "$@"; else set -- --ozone-platform=headless --disable-gpu "$@"; fi
# Ohne User-Namespaces (z. B. Ubuntu 24.04 mit AppArmor-Sperre) bricht Chromiums Sandbox den Start ab; wie AppRun im AppImage
command -v unshare >/dev/null 2>&1 && ! unshare -Ur true 2>/dev/null && set -- --no-sandbox "$@"
# --mcp: Claude Code wartet höchstens 30 s auf den Server, ein Build dauert länger → vorhandenen Build nehmen
case " $* " in *" --mcp "*) [ -f out/main/index.js ] && exec ./node_modules/.bin/electron . "$@" ;; esac
# Zweiter Klick während eines Builds: nicht parallel bauen (leert out/ unter dem ersten weg), das erste Fenster kommt gleich
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/deckwerk-build.lock"
! command -v flock >/dev/null || flock -n 9 || { notify-send -a Deckwerk -i "$PWD/assets/icon.png" Deckwerk 'Wird noch gebaut – das Fenster öffnet sich gleich.' 2>/dev/null; exit 0; }
if [ ! -f out/main/index.js ] || [ -n "$(find src assets package.json -newer out/main/index.js -print -quit)" ]; then
  notify-send -a Deckwerk -i "$PWD/assets/icon.png" Deckwerk 'Neue Version wird gebaut (etwa 1 Minute) …' 2>/dev/null
  ./node_modules/.bin/electron-vite build >&2 || { notify-send -u critical -a Deckwerk Deckwerk 'Build fehlgeschlagen. Details: npm run build' 2>/dev/null; exit 1; }
fi
exec 9>&-
exec ./node_modules/.bin/electron . "$@"
