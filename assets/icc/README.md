# ICC-Profil für den CMYK-Druck

`FOGRA39L_coated.icc`: Ausgabeprofil für Offset auf gestrichenem Papier (FOGRA39, ISO 12647-2:2004), genutzt von `src/main/print-pdf.ts` als Output-Intent im PDF/X-4.

- Herkunft: colord 1.4.8 (https://www.freedesktop.org/software/colord/), Datei `/usr/share/color/icc/colord/FOGRA39L_coated.icc`; dort mit `cd-create-profile` (ArgyllCMS) aus den FOGRA39L-Messdaten erzeugt.
- Lizenz: Das Profil trägt im Copyright-Tag „This profile is free of known copyright restrictions“ und in seinen Metadaten `License: CC0`. Es ist nicht das ECI-Profil „ISO Coated v2“, beschreibt aber dieselbe Druckbedingung.
- SHA-256: `3054263e7b257708ff067d019118587b8e4da79a326d1d2e33427e6f89d871d7`
