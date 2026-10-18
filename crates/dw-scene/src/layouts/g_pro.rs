//! Layout-Gruppe „Pro (Feature `pro`)“: stream-screen, panel, schnitt.
//! Diese Datei (und Unterdateien unter `layouts/g_pro/`) gehört allein dem Agent dieser Gruppe.
//! Neues Layout: `mod <id>;` (Datei `layouts/g_pro/<id>.rs`, Vorlage `layouts/two_column.rs`) und eine Zeile in `LAYOUTS`.
// ponytail: schnitt (Video-Timeline) fehlt noch, braucht Standbild aus dem Video; als eigenes Modul nachziehen

mod panel;
mod stream_screen;

use super::{Def, Layout};

pub const LAYOUTS: &[Layout] = &[
    ("stream-screen", stream_screen::VARIANTS, stream_screen::DEF),
    ("panel", panel::VARIANTS, panel::DEF),
];

pub fn find(id: &str) -> Option<&'static Def> {
    LAYOUTS.iter().find(|l| l.0 == id).map(|l| &l.2)
}
