//! Podcast-Schnitt ohne Electron und UI: Episode (deck.podcast), Schnitte mit clean-Semantik (Hand bleibt, automatische neu),
//! Pausen weichen Wörtern aus, Transkript über alle Spuren, Lint, Zusammenfassung und der ffmpeg-Graph des Exports.
//! Gleiche Ausgabe wie `shared/podcast.ts`/`main/podcast.ts` (Differenztest `tests/podcast_diff.rs`); gefixt: K22, K23 (§7.2), L9 (§7.5).

// !(a > b) mit Absicht: NaN fällt wie in JS durch die Prüfung
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod episode;
pub mod graph;

pub use episode::*;
