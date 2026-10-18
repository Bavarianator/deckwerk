//! Reine Prüf- und Textlogik aus `src/shared`: Folien-, Deck-, Motion-, Theme- und Clip-Lint, Klartext, Feinsatz,
//! Suchen/Ersetzen, Serienbrief, Handout und die Transkript-Werkzeuge. Befund-Texte wortgleich wie in TS.
//!
//! Was in TS aus dem Layout-Katalog (zod-Schemas), aus `resolveTheme` oder dem Film-Lint kommt, reicht der Aufrufer
//! herein ([`LintCtx`], [`SchemaCheck`]), bis dw-theme und die Layouts in Rust verdrahtet sind.

pub mod find;
pub mod handout;
pub mod js;
pub mod klartext;
pub mod lint;
pub mod merge;
pub mod theme;
pub mod typo;
pub mod video;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use find::{FindOpts, Hit, Only, find_in_deck, replace_in_deck};
pub use handout::{fmt_sec, handout, speak_sec};
pub use klartext::klartext;
pub use lint::{LayoutInfo, LintCtx, LintTheme, lint_deck, lint_motion, lint_slide};
pub use merge::{Row, fill_deck, parse_csv, placeholders};
pub use theme::{lint_looks, lint_theme};
pub use typo::typeset;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warn,
}

/// Befund zu einer Folie (lint.ts `Issue`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub slide: usize,
    pub slide_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    pub severity: Severity,
    pub rule: String,
    pub message: String,
}

/// Fehler der Schema-Prüfung (zod `issue`): Pfad als Text-Teile (Indizes als Ziffern), Meldung wörtlich.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaIssue {
    pub path: Vec<String>,
    pub message: String,
}

/// Prüft `content` gegen das Schema des Layouts; `None` = Layout unbekannt.
pub type SchemaCheck<'a> = dyn Fn(&str, &Value) -> Option<Vec<SchemaIssue>> + 'a;
