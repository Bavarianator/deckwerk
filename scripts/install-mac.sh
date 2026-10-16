#!/bin/sh
# Deckwerk für macOS installieren oder aktualisieren:
#   curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/install-mac.sh | sh
# Lädt die DMG des neuesten Releases per curl (dadurch ohne Quarantäne-Markierung, Gatekeeper fragt nicht nach)
# und kopiert Deckwerk.app nach /Applications. Optional ein Release wählen: … | sh -s v0.1.0
set -e
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "Deckwerk braucht einen Mac mit Apple Silicon (M1 oder neuer)." >&2; exit 1; }
BASE=https://github.com/Bavarianator/deckwerk/releases
# Ohne Argument: neuestes Release, mit Argument: dieses Release (z. B. v0.1.0)
if [ -n "$1" ]; then URLS="$BASE/download/$1/Deckwerk-arm64.dmg"
# ponytail: Fallback auf den „latest“-Prerelease des alten Forks, solange hier noch kein Release eine DMG trägt; danach streichen
else URLS="$BASE/latest/download/Deckwerk-arm64.dmg https://github.com/Bavarianator/deckwerk-macos/releases/download/latest/Deckwerk-arm64.dmg"; fi

TMP=$(mktemp -d); trap 'hdiutil detach -quiet "$MNT" 2>/dev/null; rm -rf "$TMP"' EXIT
for URL in $URLS; do curl -fL --progress-bar "$URL" -o "$TMP/Deckwerk.dmg" && break; done
[ -s "$TMP/Deckwerk.dmg" ] || { echo "Download fehlgeschlagen: $URLS" >&2; exit 1; }
echo "Geladen: $URL"
MNT=$(hdiutil attach -nobrowse -readonly "$TMP/Deckwerk.dmg" | tail -1 | cut -f3)
osascript -e 'quit app "Deckwerk"' 2>/dev/null || true
rm -rf /Applications/Deckwerk.app
ditto "$MNT/Deckwerk.app" /Applications/Deckwerk.app
echo "Deckwerk ist installiert: /Applications/Deckwerk.app (Launchpad, Spotlight)."

# Deckwerk als MCP-Server in die gefundenen Agenten-CLIs eintragen (die Einrichtung in der App kann das auch).
# Vibe und Codex warten sonst nur 10 bzw. 60 s auf den Start und auf Werkzeuge; Rendern dauert länger.
BIN=/Applications/Deckwerk.app/Contents/MacOS/Deckwerk
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"
# Claude Code und Codex bekommen dazu den Skill mit dem Arbeitsablauf (wie die Einrichtung in ipc.ts)
SKILL=/Applications/Deckwerk.app/Contents/Resources/app.asar.unpacked/skills/deckwerk/SKILL.md
skill_to() { [ -f "$SKILL" ] && mkdir -p "$1/deckwerk" && cp "$SKILL" "$1/deckwerk/SKILL.md"; }
if command -v claude >/dev/null; then
  claude mcp remove -s user deckwerk >/dev/null 2>&1 || true
  claude mcp add -s user deckwerk -- "$BIN" --mcp >/dev/null && { skill_to "$HOME/.claude/skills" || true; } && echo "In Claude Code eingetragen, mit Skill."
fi
if command -v vibe >/dev/null; then
  vibe mcp remove deckwerk >/dev/null 2>&1 || true
  vibe mcp add deckwerk --transport stdio --command "$BIN" --arg=--mcp --startup-timeout-sec 90 --tool-timeout-sec 300 >/dev/null && echo "In Vibe eingetragen."
fi
if command -v codex >/dev/null; then
  codex mcp remove deckwerk >/dev/null 2>&1 || true
  codex mcp add deckwerk -- "$BIN" --mcp >/dev/null &&
    perl -0pi -e 's/^\[mcp_servers\.deckwerk\]\n/$&startup_timeout_sec = 90\ntool_timeout_sec = 300\n/m' "${CODEX_HOME:-$HOME/.codex}/config.toml" &&
    { skill_to "${CODEX_HOME:-$HOME/.codex}/skills" || true; } && echo "In Codex eingetragen, mit Skill."
fi
open /Applications/Deckwerk.app
