#!/bin/sh
# Deckwerk installieren oder aktualisieren (Linux, macOS; Windows über WSL):
#   curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/install.sh | sh
# Aus einem vorhandenen Checkout heraus (./scripts/install.sh) wird dieser Ordner benutzt.
# DECKWERK_DIR (Zielordner, Standard ~/deckwerk) und DECKWERK_REPO (Git-URL) überschreiben die Voreinstellungen.
set -eu

REPO="${DECKWERK_REPO:-https://github.com/Bavarianator/deckwerk.git}"
DIR="${DECKWERK_DIR:-$HOME/deckwerk}"
case "$0" in */install.sh) [ -f "$(dirname "$0")/../package.json" ] && DIR="$(cd "$(dirname "$0")/.." && pwd)" ;; esac

need() { command -v "$1" >/dev/null 2>&1 || { echo "Deckwerk braucht $1 ($2)." >&2; exit 1; }; }
need git "https://git-scm.com"
need node "Node.js 22 oder neuer, https://nodejs.org"
need npm "wird mit Node.js installiert"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || { echo "Node.js $major ist zu alt, Deckwerk braucht 22 oder neuer." >&2; exit 1; }

if [ -d "$DIR/.git" ]; then
  echo "→ Aktualisiere $DIR"
  git -C "$DIR" pull --ff-only || echo "  Hinweis: Update nicht geladen (offline oder lokale Änderungen), baue den vorhandenen Stand."
else
  echo "→ Lade Deckwerk nach $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

echo "→ Installiere Abhängigkeiten (dauert beim ersten Mal ein paar Minuten)"
npm ci --no-audit --no-fund
echo "→ Baue die App"
npx electron-vite build
chmod +x scripts/deckwerk.sh

# Startmenü-Eintrag (Linux)
if [ "$(uname)" = Linux ]; then
  mkdir -p "$HOME/.local/share/applications"
  cat > "$HOME/.local/share/applications/deckwerk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Deckwerk
GenericName=KI-Präsentationsstudio
Comment=Präsentationen mit KI erstellen, prüfen und als PowerPoint exportieren
Exec=$DIR/scripts/deckwerk.sh
Icon=$DIR/assets/icon.png
Terminal=false
Categories=Office;Presentation;
Keywords=Präsentation;Folien;PowerPoint;PPTX;KI;Pitch;
StartupWMClass=deckwerk
StartupNotify=true
EOF
  echo "→ Startmenü-Eintrag angelegt"
fi

# Claude Code: Deckwerk als MCP-Server für alle Projekte (sonst später im Einrichtungsassistenten der App)
if command -v claude >/dev/null 2>&1; then
  claude mcp remove -s user deckwerk >/dev/null 2>&1 || true
  claude mcp add -s user deckwerk -- "$DIR/scripts/deckwerk.sh" --mcp >/dev/null && echo "→ In Claude Code eingerichtet (neue Sitzung starten)"
fi

echo "Fertig. Starten: Startmenü „Deckwerk“ oder $DIR/scripts/deckwerk.sh"
