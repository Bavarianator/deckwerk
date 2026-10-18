//! Layout-Gruppe „Druck“: doc-text, offer, flyer, flyer-back, application-cover, certificate, invitation, letter, business-card, cv, menu.
//! Diese Datei (und Unterdateien unter `layouts/g_druck/`) gehört allein dem Agent dieser Gruppe.
//! Neues Layout: `mod <id>;` (Datei `layouts/g_druck/<id>.rs`, Vorlage `layouts/two_column.rs`) und eine Zeile in `LAYOUTS`.

mod certificate;
mod doc_text;
mod menu;
mod offer;

use super::{Def, Layout};
use crate::blocks::*;
use crate::tree::Div;
use dw_theme::Role;
use taffy::prelude::*;

pub const LAYOUTS: &[Layout] = &[
    ("doc-text", doc_text::VARIANTS, doc_text::DEF),
    ("offer", offer::VARIANTS, offer::DEF),
    ("certificate", certificate::VARIANTS, certificate::DEF),
    ("menu", menu::VARIANTS, menu::DEF),
];

pub fn find(id: &str) -> Option<&'static Def> {
    LAYOUTS.iter().find(|l| l.0 == id).map(|l| &l.2)
}

/// Quellenzeile unter dem Inhalt (.source: flex none, margin-top 18).
fn source(cx: &Cx, text: Option<&str>) -> Option<Div> {
    text.map(|s| t_styled(cx.t(Role::Footer, "source", s), Style::DEFAULT.none().mt(18.)))
}
