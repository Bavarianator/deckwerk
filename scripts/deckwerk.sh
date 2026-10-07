#!/bin/sh
# Startet Deckwerk (Desktop-Eintrag; mit --mcp als MCP-Server für Claude Code, daher Build-Ausgabe nach stderr).
# Ohne Build wird vorher gebaut. Ist er nur veraltet, startet sofort der vorhandene und die neue Version entsteht im Hintergrund
# (gilt ab dem nächsten Start): Ein Neubau dauert auf einem ausgelasteten 2-Kern-Rechner mehrere Minuten.
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1
# Wayland: das verborgene Druckfenster malt nie, printToPDF hängt → Electron immer über XWayland starten.
# MCP-Clients wie Vibe oder Codex geben dem Server eine Umgebung ohne DISPLAY: dann ohne Bildschirm rendern (etwas langsamer)
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then set -- --ozone-platform=x11 "$@"; else set -- --ozone-platform=headless --disable-gpu "$@"; fi
# Ohne User-Namespaces (z. B. Ubuntu 24.04 mit AppArmor-Sperre) bricht Chromiums Sandbox den Start ab; wie AppRun im AppImage
command -v unshare >/dev/null 2>&1 && ! unshare -Ur true 2>/dev/null && set -- --no-sandbox "$@"
# --mcp: Claude Code wartet höchstens 30 s auf den Server, ein Build dauert länger → vorhandenen Build nehmen
case " $* " in *" --mcp "*) [ -f out/main/index.js ] && exec ./node_modules/.bin/electron . "$@" ;; esac
note() { notify-send -a Deckwerk -i "$PWD/assets/icon.png" "$@" 2>/dev/null; }
# Eine Sperre für alle Builds: ein zweiter Klick baut nicht parallel (das leerte out/ unter dem ersten weg)
exec 9>"${XDG_RUNTIME_DIR:-/tmp}/deckwerk-build.lock"
lock() { ! command -v flock >/dev/null || flock "$@" 9; }
log="${XDG_RUNTIME_DIR:-/tmp}/deckwerk-build.log" failed="${XDG_RUNTIME_DIR:-/tmp}/deckwerk-build.failed"
newer() { [ -n "$(find src assets package.json -newer "$1" -print -quit)" ]; }
# Ohne jeden Build auf den laufenden warten; mit Build und belegter Sperre sofort den vorhandenen starten
if lock -n || { [ ! -f out/main/index.js ] && { note Deckwerk 'Ein Build läuft noch, das Fenster öffnet sich danach.'; lock; }; }; then
  # Fertigen Hintergrund-Build übernehmen: kopieren statt umbenennen, damit laufende Instanzen (App, MCP-Server) ihre
  # gehashten Chunks behalten. Was danach älter als eine Woche ist, stammt aus keinem aktuellen Build.
  # ponytail: Einstiegsdateien werden mitkopiert statt zuletzt; ein Start in genau dieser Sekunde könnte Chunks vermissen
  if [ -f out.next/.fertig ]; then
    mkdir -p out && cp -a out.next/main out.next/preload out.next/renderer out/ && rm -rf out.next && find out -type f -mtime +7 -delete
  fi
  if [ ! -f out/main/index.js ]; then
    note Deckwerk 'Deckwerk wird gebaut (einige Minuten) …'
    ./node_modules/.bin/electron-vite build >&2 || { note -u critical Deckwerk 'Build fehlgeschlagen. Details: npm run build'; exit 1; }
  elif newer out/main/index.js && { [ ! -f "$failed" ] || newer "$failed"; }; then
    # Veraltet: im Hintergrund mit niedriger Priorität neu bauen (gilt ab dem nächsten Start). Der Subshell erbt fd 9 und
    # hält die Sperre bis zum Ende. Ein gescheiterter Build wird erst nach der nächsten Quelländerung wiederholt.
    ( rm -rf out.next
      if nice -n 15 ./node_modules/.bin/electron-vite build --outDir out.next; then
        touch out.next/.fertig && rm -f "$failed" && note Deckwerk 'Neue Version ist fertig und gilt ab dem nächsten Start.'
      else rm -rf out.next; touch "$failed"; note -u critical Deckwerk "Neue Version ließ sich nicht bauen. Details: $log"; fi ) </dev/null >"$log" 2>&1 &
  fi
fi
exec 9>&-
exec ./node_modules/.bin/electron . "$@"
