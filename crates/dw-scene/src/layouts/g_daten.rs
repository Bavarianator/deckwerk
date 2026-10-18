//! Layout-Gruppe „Daten“: chart, table, code, screen, gantt (Pro).
//! Diese Datei (und Unterdateien unter `layouts/g_daten/`) gehört allein dem Agent dieser Gruppe.
//! Neues Layout: `mod <id>;` (Datei `layouts/g_daten/<id>.rs`, Vorlage `layouts/two_column.rs`) und eine Zeile in `LAYOUTS`.

mod chart;
mod code;
mod screen;
mod table;

use super::{Def, Layout};

pub const LAYOUTS: &[Layout] = &[
    ("chart", chart::VARIANTS, chart::DEF),
    ("table", table::VARIANTS, table::DEF),
    ("code", code::VARIANTS, code::DEF),
    ("screen", screen::VARIANTS, screen::DEF),
];

pub fn find(id: &str) -> Option<&'static Def> {
    LAYOUTS.iter().find(|l| l.0 == id).map(|l| &l.2)
}
