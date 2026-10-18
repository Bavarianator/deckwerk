//! Layout-Gruppe „Druck“: doc-text, offer, flyer, flyer-back, application-cover, certificate, invitation, letter, business-card, cv, menu.
//! Diese Datei (und Unterdateien unter `layouts/g_druck/`) gehört allein dem Agent dieser Gruppe.
//! Neues Layout: `mod <id>;` (Datei `layouts/g_druck/<id>.rs`, Vorlage `layouts/two_column.rs`) und eine Zeile in `LAYOUTS`.

use super::{Def, Layout};

pub const LAYOUTS: &[Layout] = &[];

pub fn find(id: &str) -> Option<&'static Def> {
    LAYOUTS.iter().find(|l| l.0 == id).map(|l| &l.2)
}
