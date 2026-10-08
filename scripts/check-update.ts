// Update-Prüfung (Versionsvergleich, wann sich die App selbst ersetzen darf), ohne Netz: npx esbuild scripts/check-update.ts --bundle --platform=node --format=esm --outfile=out/check-update.mjs && node out/check-update.mjs
import { ok } from 'node:assert'
import { isNewer } from '../src/main/update'

ok(isNewer('0.1.6', 'v0.1.7') && isNewer('0.1.9', '0.2.0') && isNewer('0.9.0', '1.0'), 'neuere Version erkannt')
ok(isNewer('0.1.9', '0.1.10'), 'Zahlen statt Text vergleichen')
ok(!isNewer('0.1.6', '0.1.6') && !isNewer('0.1.7', '0.1.6'), 'gleich oder älter ist kein Update')
console.log('check-update: ok')
