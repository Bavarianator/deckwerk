#!/bin/sh
# Deckwerk entfernen: Programmordner, Startmenü-Eintrag, Dateizuordnung und die Einträge in Claude Code, Vibe und Codex.
# Deine Decks unter ~/Deckwerk bleiben erhalten. Aufruf: ~/deckwerk/scripts/uninstall.sh
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
grep -q '"name": "deckwerk"' "$DIR/package.json" 2>/dev/null || { echo "$DIR ist kein Deckwerk-Ordner, breche ab." >&2; exit 1; }
if [ -t 0 ]; then
  printf 'Deckwerk aus %s entfernen? Deine Decks unter ~/Deckwerk bleiben. [j/N] ' "$DIR"
  read -r ok
  case "$ok" in j|J|ja|Ja) ;; *) echo "Abgebrochen."; exit 0 ;; esac
fi

command -v claude >/dev/null 2>&1 && claude mcp remove -s user deckwerk >/dev/null 2>&1 && echo "→ Aus Claude Code entfernt"
command -v vibe >/dev/null 2>&1 && vibe mcp remove deckwerk >/dev/null 2>&1 && echo "→ Aus Vibe entfernt"
command -v codex >/dev/null 2>&1 && codex mcp remove deckwerk >/dev/null 2>&1 && echo "→ Aus Codex entfernt"

rm -f "$HOME/.local/share/applications/deckwerk.desktop" "$HOME/.local/share/mime/packages/deckwerk.xml"
command -v update-mime-database >/dev/null 2>&1 && update-mime-database "$HOME/.local/share/mime" >/dev/null 2>&1
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1
echo "→ Startmenü-Eintrag und Dateizuordnung entfernt"

rm -rf "$DIR" && echo "→ $DIR entfernt"
echo "Fertig. Deine Decks unter ~/Deckwerk sind noch da."
