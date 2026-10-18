//! Pro-Timeline ohne Electron und UI: Datenmodell (kompatibel zu deck.json), Schnitt-Operationen, Lint, Farbkorrektur,
//! Umwandlung aus Clip-Folien, ffmpeg-Argumente je Abschnitt, Export-Bausteine, Wellenform und xmeml.
//! Gleiche Ausgabe wie die TS-Quellen (Differenztest `tests/timeline_diff.rs`) außer an den markierten Befunden aus RUST-REWRITE.md §7.2:
//! K14 (xfade-Versatz im Bild), K15 (estimate mit Ausgabe-fps), K16 (set prüft out > in), K17 (hide nimmt auch den Ton), K18 (xmeml mit Pegel/Farbe/Zuschnitt/Untertiteln).

// !(a > b) mit Absicht: NaN fällt wie in JS durch die Prüfung
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod edit;
pub mod export;
pub mod from_clips;
pub mod grade;
pub mod graph;
pub mod media;
pub mod model;
pub mod xmeml;

pub use edit::*;
pub use model::*;
