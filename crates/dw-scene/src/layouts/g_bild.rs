//! Layout-Gruppe „Bild“: image-text, photo, gallery, team, logos, icon-grid, clip.
//! Diese Datei (und Unterdateien unter `layouts/g_bild/`) gehört allein dem Agent dieser Gruppe.
//! Neues Layout: `mod <id>;` (Datei `layouts/g_bild/<id>.rs`, Vorlage `layouts/two_column.rs`) und eine Zeile in `LAYOUTS`.

mod clip;
mod gallery;
mod icon_grid;
mod image_text;
mod logos;
mod photo;
mod team;

use super::{Def, Layout};
use crate::blocks::{Cx, abs};
use crate::tree::Div;

pub const LAYOUTS: &[Layout] = &[
    ("image-text", image_text::VARIANTS, image_text::DEF),
    ("photo", photo::VARIANTS, photo::DEF),
    ("gallery", gallery::VARIANTS, gallery::DEF),
    ("team", team::VARIANTS, team::DEF),
    ("logos", logos::VARIANTS, logos::DEF),
    ("icon-grid", icon_grid::VARIANTS, icon_grid::DEF),
    ("clip", clip::VARIANTS, clip::DEF),
];

pub fn find(id: &str) -> Option<&'static Def> {
    LAYOUTS.iter().find(|l| l.0 == id).map(|l| &l.2)
}

/// Platzhalter ohne Foto (.placeholder): Fläche surface2 über die ganze Box.
fn placeholder(cx: &Cx) -> Div {
    Div::new(abs(Some(0.), Some(0.), Some(0.), Some(0.))).paint(cx.tk.surface2)
}
