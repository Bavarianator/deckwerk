# Chromium-Referenzen (RUST-REWRITE.md §4.6)

`<theme>/<format>/<layout>-<variant>-<sample>.{measured.json,lines.json,png}` stammen aus der alten Electron-Engine, je ein Deck mit einer Folie:

- `measured.json`: `engine.measure()` (Autofit-Stufe, Elemente je Slot)
- `lines.json`: je Text-Slot (`[data-pptx="text"]`, Dokumentreihenfolge) die sichtbaren Zeilentexte, gruppiert wie `lineTops` in `measure.ts`
- `png`: `engine.renderPng(…, 2 × Breite)` (2×)
- `decks.json` je Ordner: die Eingabe je Kombination; `dw-refcheck` rendert genau diese Decks

Umfang (`refs.ts`): alle Layouts aus `LAYOUTS` (inkl. layouts-extra/-demo) × alle Varianten (ohne Varianten: `default`).
beratung: min/typ/max in 16:9, typ in 4:5 und a4; keynote und corporate: typ in 16:9.
Layouts mit `sizes` nur in ihren Formaten (beratung min/typ/max, sonst typ). Format-Ordner: `16x9`, `4x5`, `a4`, `a4-quer`, …

## Vergleich

```sh
cargo run -j2 --release -p dw-refcheck -- [--layout <id>] [--theme <id>] [--format 16x9] [--strict] [--json target/refcheck.json] [--out target/refcheck]
```

Gleich = Autofit-Stufe, Zeilenzahlen und Umbruchstellen (`lines.json`) gleich, sizePx/lineHeightPx ≤ 0,01, Boxen ≤ 2 px, gleiche Slots.
Layouts, die dw-scene noch nicht kennt (`Error::UnknownLayout`), zählen als „fehlt“. `--strict` scheitert nur an abweichenden.

## Neu erzeugen

In einer Kopie unter `target/` bauen (nicht `/tmp`, nie im geteilten Checkout – `out/` ist dort geteilt). Eine Electron-Instanz, seriell, ~1 h:

```sh
D=/home/bayernator/deckwerk-design; S=$D/target/refs-engine
I=/home/bayernator/deckwerk/.claude/worktrees/integ-wip/node_modules   # vollständig, aber ohne Electron-Binary
rm -rf $S && mkdir -p $S/node_modules && cd $D && cp -r src examples assets package.json electron.vite.config.ts tsconfig.json $S/
for e in $I/* $I/.bin; do [ "$(basename $e)" = electron ] || ln -s $e $S/node_modules/; done
ln -s /home/bayernator/deckwerk/node_modules/electron $S/node_modules/electron
cp $D/tests/refs/refs.ts $S/src/main/refs.ts
# checkLayouts verzweigt bei DW_REFS in writeRefs:
sed -i "/^export async function checkLayouts/a\\  if (process.env.DW_REFS) return (await import('./refs')).writeRefs(engine, process.env.DW_REFS)" $S/src/main/check.ts
cd $S && npx electron-vite build
DECKWERK_HOME=$S/home DW_REFS=$S/refs-out xvfb-run -a npx electron . --ozone-platform=x11 --remote-debugging-port=9377 --check
# eingrenzen: DW_LAYOUTS=cover,bullets; danach übernehmen:
cp -r $S/refs-out/* $D/tests/refs/
```

Ändern sich `samples` in den TS-Layouts, die Referenzen neu erzeugen; `dw-scene` rendert immer das Deck aus `decks.json`.
