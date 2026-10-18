# Chromium-Referenzen (RUST-REWRITE.md §4.6)

`beratung/16x9/<layout>-<variant>-<sample>.{measured.json,png}` stammen aus der alten Electron-Engine:
`engine.measure()` und `engine.renderPng(…, 2560)` (2×) für cover, bullets und two-column × alle Varianten × min/typ/max,
Theme beratung, 16:9, je ein Deck mit einer Folie. `decks.json` hält die Eingabe je Kombination. `dw-refcheck` prüft damit,
dass die Referenz aus demselben Deck stammt wie `dw_scene::samples::deck` (`transition`/`mode` verlangt nur der TS-Typ, die Folie hängt nicht davon ab).

Vergleich: `cargo run -j2 -p dw-refcheck -- [--out target/refcheck] [--strict]`.

## Neu erzeugen

In einer Kopie bauen, nie im geteilten Checkout (`out/` ist dort geteilt):

```sh
DW=/home/bayernator/deckwerk            # alte Engine
S=$(mktemp -d)/refs-engine              # Kopie
mkdir -p $S && cd $DW && cp -r src examples assets package.json electron.vite.config.ts tsconfig.json $S/
ln -sfn $DW/node_modules $S/node_modules
cp /home/bayernator/deckwerk-design/tests/refs/refs.ts $S/src/main/refs.ts
# checkLayouts verzweigt bei DW_REFS in writeRefs:
sed -i "/^export async function checkLayouts/a\\  if (process.env.DW_REFS) return (await import('./refs')).writeRefs(engine, process.env.DW_REFS)" $S/src/main/check.ts
cd $S && npx electron-vite build
DECKWERK_HOME=$S/home DW_REFS=/home/bayernator/deckwerk-design/tests/refs/beratung/16x9 \
  npx electron . --ozone-platform=x11 --remote-debugging-port=9377 --check   # ohne Bildschirm: xvfb-run davor
```

Ändern sich `samples` in `layouts.ts` oder in `crates/dw-scene/src/samples.rs`, bricht `dw-refcheck` mit „Referenz-Deck weicht ab“ ab: dann beide angleichen und neu erzeugen.
