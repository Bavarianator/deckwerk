#!/bin/sh
# Deckwerk Pro entfernen: die App (~/.local/share/deckwerk-pro bzw. den Quellcode-Ordner, aus dem dieses Skript läuft),
# Startmenü-Eintrag, Dateizuordnung und die Einträge (MCP-Server, Skill deckwerk-pro) in Claude Code, Vibe und Codex. Deine Decks unter ~/DeckwerkPro
# und ein installiertes Deckwerk bleiben.
#   curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk-pro/HEAD/scripts/uninstall.sh | sh
#   oder aus einer Quellcode-Installation: ~/deckwerk-pro/scripts/uninstall.sh
set -u
APP="${DECKWERK_APP:-$HOME/.local/share/deckwerk-pro}"
SRC=
case "$0" in */uninstall.sh)
  SRC="$(cd "$(dirname "$0")/.." && pwd)"
  grep -q '"name": "deckwerk-pro"' "$SRC/package.json" 2>/dev/null || { echo "$SRC ist kein Deckwerk-Pro-Ordner, breche ab." >&2; exit 1; } ;;
esac
[ -x "$APP/AppRun" ] || APP=
if [ -t 0 ]; then
  printf 'Deckwerk Pro entfernen (%s)? Deine Decks unter ~/DeckwerkPro bleiben. [j/N] ' "${SRC:-$APP}"
  read -r ok
  case "$ok" in j|J|ja|Ja) ;; *) echo "Abgebrochen."; exit 0 ;; esac
fi

command -v claude >/dev/null 2>&1 && claude mcp remove -s user deckwerk-pro >/dev/null 2>&1 && echo "→ Aus Claude Code entfernt"
command -v vibe >/dev/null 2>&1 && vibe mcp remove deckwerk-pro >/dev/null 2>&1 && echo "→ Aus Vibe entfernt"
command -v codex >/dev/null 2>&1 && codex mcp remove deckwerk-pro >/dev/null 2>&1 && echo "→ Aus Codex entfernt"
# Standard-App für deck.json nur zurücknehmen, wenn sie Deckwerk Pro ist (ein Standard auf Deckwerk bleibt unberührt)
if command -v xdg-mime >/dev/null 2>&1 && [ "$(xdg-mime query default application/x-deckwerk 2>/dev/null)" = deckwerk-pro.desktop ]; then
  sed -i '/^application\/x-deckwerk=deckwerk-pro\.desktop;\{0,1\}$/d' "${XDG_CONFIG_HOME:-$HOME/.config}/mimeapps.list" 2>/dev/null && echo "→ Standard-App für deck.json zurückgesetzt"
fi
rm -rf "$HOME/.claude/skills/deckwerk-pro" "${CODEX_HOME:-$HOME/.codex}/skills/deckwerk-pro" && echo "→ Skill aus Claude Code und Codex entfernt"

rm -f "$HOME/.local/bin/deckwerk-pro" "$HOME/.local/share/applications/deckwerk-pro.desktop" "$HOME/.local/share/mime/packages/deckwerk-pro.xml"
command -v update-mime-database >/dev/null 2>&1 && update-mime-database "$HOME/.local/share/mime" >/dev/null 2>&1
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1
echo "→ Startmenü-Eintrag und Dateizuordnung entfernt"

for d in "$APP" "$SRC"; do [ -n "$d" ] && rm -rf "$d" && echo "→ $d entfernt"; done
echo "Fertig. Deine Decks unter ~/DeckwerkPro sind noch da."
