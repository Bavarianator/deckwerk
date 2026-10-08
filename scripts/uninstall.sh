#!/bin/sh
# Deckwerk entfernen: die App (~/.local/share/deckwerk bzw. den Quellcode-Ordner, aus dem dieses Skript läuft),
# Startmenü-Eintrag, Dateizuordnung und die Einträge (MCP-Server, Skill) in Claude Code, Vibe und Codex. Deine Decks unter ~/Deckwerk bleiben.
#   curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/uninstall.sh | sh
#   oder aus einer Quellcode-Installation: ~/deckwerk/scripts/uninstall.sh
set -u
APP="${DECKWERK_APP:-$HOME/.local/share/deckwerk}"
SRC=
case "$0" in */uninstall.sh)
  SRC="$(cd "$(dirname "$0")/.." && pwd)"
  grep -q '"name": "deckwerk"' "$SRC/package.json" 2>/dev/null || { echo "$SRC ist kein Deckwerk-Ordner, breche ab." >&2; exit 1; } ;;
esac
[ -x "$APP/AppRun" ] || APP=
if [ -t 0 ]; then
  printf 'Deckwerk entfernen (%s)? Deine Decks unter ~/Deckwerk bleiben. [j/N] ' "${SRC:-$APP}"
  read -r ok
  case "$ok" in j|J|ja|Ja) ;; *) echo "Abgebrochen."; exit 0 ;; esac
fi

command -v claude >/dev/null 2>&1 && claude mcp remove -s user deckwerk >/dev/null 2>&1 && echo "→ Aus Claude Code entfernt"
command -v vibe >/dev/null 2>&1 && vibe mcp remove deckwerk >/dev/null 2>&1 && echo "→ Aus Vibe entfernt"
command -v codex >/dev/null 2>&1 && codex mcp remove deckwerk >/dev/null 2>&1 && echo "→ Aus Codex entfernt"
rm -rf "$HOME/.claude/skills/deckwerk" "${CODEX_HOME:-$HOME/.codex}/skills/deckwerk" && echo "→ Skill aus Claude Code und Codex entfernt"

rm -f "$HOME/.local/bin/deckwerk" "$HOME/.local/share/applications/deckwerk.desktop" "$HOME/.local/share/mime/packages/deckwerk.xml"
command -v update-mime-database >/dev/null 2>&1 && update-mime-database "$HOME/.local/share/mime" >/dev/null 2>&1
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1
echo "→ Startmenü-Eintrag und Dateizuordnung entfernt"

for d in "$APP" "$SRC"; do [ -n "$d" ] && rm -rf "$d" && echo "→ $d entfernt"; done
echo "Fertig. Deine Decks unter ~/Deckwerk sind noch da."
