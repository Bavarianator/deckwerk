//! Layout-Gruppe „Struktur“: kpi-grid, timeline, process, options, matrix, pros-cons, problem-solution, funnel, market-size, pricing.
//! Diese Datei (und Unterdateien unter `layouts/g_struktur/`) gehört allein dem Agent dieser Gruppe.
//! Neues Layout: `mod <id>;` (Datei `layouts/g_struktur/<id>.rs`, Vorlage `layouts/two_column.rs`) und eine Zeile in `LAYOUTS`.

use super::{Def, Layout};

pub const LAYOUTS: &[Layout] = &[];

pub fn find(id: &str) -> Option<&'static Def> {
    LAYOUTS.iter().find(|l| l.0 == id).map(|l| &l.2)
}
