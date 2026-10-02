#!/bin/sh
# Deckwerk installieren oder aktualisieren (Linux; Windows über WSL; auf dem Mac geht es zu deckwerk-macos weiter):
#   curl -fsSL https://raw.githubusercontent.com/Bavarianator/deckwerk/master/scripts/install.sh | sh
# Standard: die fertige App aus dem neuesten Release (kein Git, kein Node) nach ~/.local/share/deckwerk (DECKWERK_APP).
# Aus dem Quellcode: DECKWERK_SOURCE=1 (Git + Node 22 nach DECKWERK_DIR, Standard ~/deckwerk, auf dem neuesten
# Release-Tag, DECKWERK_REF wählt einen anderen), ein vorhandener Checkout dort oder ./scripts/install.sh im Checkout.
set -eu

# macOS hat eine eigene Fassung (fertige, signierte App): an deren Installer übergeben
if [ "$(uname)" = Darwin ]; then
  MAC=https://raw.githubusercontent.com/Bavarianator/deckwerk-macos/main/install.sh
  echo "→ macOS: Deckwerk für den Mac kommt aus github.com/Bavarianator/deckwerk-macos"
  script=$(curl -fsSL "$MAC") || { echo "Mac-Installer nicht erreichbar: $MAC" >&2; exit 1; }
  exec sh -c "$script"
fi

REPO="${DECKWERK_REPO:-https://github.com/Bavarianator/deckwerk.git}"
DIR="${DECKWERK_DIR:-$HOME/deckwerk}"
APP="${DECKWERK_APP:-$HOME/.local/share/deckwerk}"
# ponytail: nur x86_64 als fertige App; andere Architekturen bauen aus dem Quellcode
APPIMAGE="${DECKWERK_APPIMAGE:-https://github.com/Bavarianator/deckwerk/releases/latest/download/Deckwerk-x86_64.AppImage}"
CHECKOUT=
case "$0" in */install.sh) [ -f "$(dirname "$0")/../package.json" ] && DIR="$(cd "$(dirname "$0")/.." && pwd)" && CHECKOUT=1 ;; esac
SOURCE="${DECKWERK_SOURCE:-}"
{ [ -n "$CHECKOUT" ] || [ -d "$DIR/.git" ] || [ "$(uname -m)" != x86_64 ]; } && SOURCE=1

need() { command -v "$1" >/dev/null 2>&1 || { echo "Deckwerk braucht $1 ($2)." >&2; exit 1; }; }

if [ -z "$SOURCE" ]; then
  need curl "zum Herunterladen"
  echo "→ Lade Deckwerk (neuester Release)"
  # neben dem Ziel statt in /tmp (oft ein kleines RAM-Dateisystem): entpackt ~400 MB, danach nur umbenennen
  mkdir -p "$(dirname "$APP")"
  tmp=$(mktemp -d "$(dirname "$APP")/.deckwerk-XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  case "$APPIMAGE" in
    http*) curl -fL --progress-bar -o "$tmp/Deckwerk.AppImage" "$APPIMAGE" ;;
    *) cp "$APPIMAGE" "$tmp/Deckwerk.AppImage" ;;
  esac
  chmod +x "$tmp/Deckwerk.AppImage"
  # Entpacken statt einhängen: braucht kein FUSE und startet schneller. AppRun schaltet die Chromium-Sandbox nur dort ab,
  # wo das System keine User-Namespaces erlaubt (z. B. Ubuntu 24.04).
  (cd "$tmp" && ./Deckwerk.AppImage --appimage-extract >/dev/null)
  # bei vollem Datenträger entstehen still leere Dateien: dann die alte Version behalten
  [ -s "$tmp/squashfs-root/v8_context_snapshot.bin" ] && [ -x "$tmp/squashfs-root/AppRun" ] ||
    { echo "Entpacken fehlgeschlagen (genug Speicherplatz in $(dirname "$APP")?). Die bisherige Version bleibt." >&2; exit 1; }
  rm -rf "$APP.alt" && { [ ! -e "$APP" ] || mv "$APP" "$APP.alt"; } && mv "$tmp/squashfs-root" "$APP" && rm -rf "$APP.alt"
  RUN="$APP/AppRun"
  ICON="$APP/deckwerk.png"
  SKILL="$APP/resources/app.asar.unpacked/skills/deckwerk/SKILL.md"
  # MCP-Server: Vibe und Codex starten ihn ohne DISPLAY, dann headless (gleicher Aufruf wie mcpCmd in src/main/ipc.ts)
  WRAP='if [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then exec "$0" --ozone-platform=x11 --mcp; else exec "$0" --ozone-platform=headless --disable-gpu --mcp; fi'
  set -- /bin/sh -c "$WRAP" "$RUN"
else
  need git "https://git-scm.com"
  need node "Node.js 22 oder neuer, https://nodejs.org"
  need npm "wird mit Node.js installiert"
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] || { echo "Node.js $major ist zu alt, Deckwerk braucht 22 oder neuer." >&2; exit 1; }
  latest() { git ls-remote --tags --refs --sort=-v:refname "$REPO" 'v*' 2>/dev/null | head -1 | sed 's#.*refs/tags/##'; }
  if [ -n "$CHECKOUT" ]; then
    echo "→ Baue den Checkout $DIR"
  elif [ -d "$DIR/.git" ]; then
    echo "→ Aktualisiere $DIR"
    if git -C "$DIR" symbolic-ref -q HEAD >/dev/null; then
      # auf einem Zweig (z. B. zum Entwickeln): nur vorspulen, nie den Zweig wechseln
      git -C "$DIR" pull --ff-only || echo "  Hinweis: Update nicht geladen (offline oder lokale Änderungen), baue den vorhandenen Stand."
    else
      ref="${DECKWERK_REF:-$(latest)}"
      { [ -n "$ref" ] && git -C "$DIR" fetch -q --depth 1 origin "$ref" && git -C "$DIR" checkout -q --detach FETCH_HEAD && echo "  Stand: $ref"; } ||
        echo "  Hinweis: Update nicht geladen (offline oder lokale Änderungen), baue den vorhandenen Stand."
    fi
  else
    ref="${DECKWERK_REF:-$(latest)}"
    echo "→ Lade Deckwerk ${ref:-(neuester Stand)} nach $DIR"
    git -c advice.detachedHead=false clone -q --depth 1 ${ref:+--branch "$ref"} "$REPO" "$DIR"
  fi
  cd "$DIR"
  echo "→ Installiere Abhängigkeiten (dauert beim ersten Mal ein paar Minuten)"
  npm ci --no-audit --no-fund
  echo "→ Baue die App"
  npx electron-vite build
  chmod +x scripts/deckwerk.sh
  RUN="$DIR/scripts/deckwerk.sh"
  ICON="$DIR/assets/icon.png"
  SKILL="$DIR/skills/deckwerk/SKILL.md"
  set -- "$RUN" --mcp
fi

# Startmenü-Eintrag und Dateizuordnung: Doppelklick auf eine deck.json öffnet sie in Deckwerk
mkdir -p "$HOME/.local/share/applications" "$HOME/.local/share/mime/packages"
cat > "$HOME/.local/share/mime/packages/deckwerk.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="application/x-deckwerk">
    <comment>Deckwerk-Präsentation</comment>
    <sub-class-of type="application/json"/>
    <glob pattern="deck.json" weight="60"/>
  </mime-type>
</mime-info>
XML
cat > "$HOME/.local/share/applications/deckwerk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Deckwerk
GenericName=KI-Präsentationsstudio
Comment=Präsentationen mit KI erstellen, prüfen und als PowerPoint exportieren
Exec="$RUN" %f
Icon=$ICON
MimeType=application/x-deckwerk;
Terminal=false
Categories=Office;Presentation;
Keywords=Präsentation;Folien;PowerPoint;PPTX;KI;Pitch;
StartupWMClass=deckwerk
StartupNotify=true
EOF
command -v update-mime-database >/dev/null 2>&1 && update-mime-database "$HOME/.local/share/mime" >/dev/null 2>&1 || true
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
command -v xdg-mime >/dev/null 2>&1 && xdg-mime default deckwerk.desktop application/x-deckwerk 2>/dev/null || true
echo "→ Startmenü-Eintrag und Dateizuordnung (deck.json) angelegt"

# Deckwerk als MCP-Server in Claude Code, Vibe und Codex (für alle Projekte; "$@" = Befehl und Argumente des Servers).
# Vibe und Codex warten von sich aus nur kurz; Codex kann die Wartezeit nicht per `mcp add` setzen, daher in der config.toml.
# Claude Code und Codex bekommen dazu den Skill mit dem Arbeitsablauf (gleiches SKILL.md-Format, wie die Einrichtung in ipc.ts)
skill_to() { [ -f "$SKILL" ] && mkdir -p "$1/deckwerk" && cp "$SKILL" "$1/deckwerk/SKILL.md"; }
if command -v claude >/dev/null 2>&1; then
  claude mcp remove -s user deckwerk >/dev/null 2>&1 || true
  claude mcp add -s user deckwerk -- "$@" >/dev/null && { skill_to "$HOME/.claude/skills" || true; } && echo "→ In Claude Code eingerichtet, mit Skill (neue Sitzung starten)"
fi
vibe_add() { # --arg=… je Argument; mit Leerzeichen hielte Vibe „--mcp“ für eine eigene Option
  cmd=$1; shift; n=$#
  for a in "$@"; do set -- "$@" "--arg=$a"; done
  shift "$n"
  vibe mcp add --transport stdio --command "$cmd" "$@" --startup-timeout-sec 90 --tool-timeout-sec 300 deckwerk >/dev/null
}
if command -v vibe >/dev/null 2>&1; then
  vibe mcp remove deckwerk >/dev/null 2>&1 || true
  vibe_add "$@" && echo "→ In Vibe eingerichtet"
fi
if command -v codex >/dev/null 2>&1; then
  codex mcp remove deckwerk >/dev/null 2>&1 || true
  codex mcp add deckwerk -- "$@" >/dev/null 2>&1 &&
    sed -i '/^\[mcp_servers\.deckwerk\]$/a startup_timeout_sec = 90\ntool_timeout_sec = 300' "${CODEX_HOME:-$HOME/.codex}/config.toml" &&
    { skill_to "${CODEX_HOME:-$HOME/.codex}/skills" || true; } && echo "→ In Codex eingerichtet, mit Skill"
fi

echo "Fertig. Starten: Startmenü „Deckwerk“ oder $RUN"
