//! Layout-Katalog (layouts.ts + layouts.tsx): je Layout eine Datei mit Varianten, Bau-Funktion und Beispielen.
//!
//! # Neues Layout portieren
//! Layouts sind in Gruppen aufgeteilt, die je ein Agent allein besitzt: `g_text.rs`, `g_struktur.rs`, `g_bild.rs`,
//! `g_daten.rs`, `g_druck.rs`, `g_pro.rs` (Feature `pro`). Diese Datei muss dafür nicht geändert werden.
//! 1. `src/layouts/g_<gruppe>/<id>.rs` anlegen (Bindestriche → `_`), Vorlage: `two_column.rs`. Die Datei enthält
//!    - `pub const VARIANTS: &[&str]` (layouts.ts `variants`, leer = keine),
//!    - `pub const DEF: Def` mit `footer`, `frames` (erlaubte Kompositionen außer top), `tone`, `hero`
//!      (Dekor wie `Frame decor="hero"`), `build` und `samples`,
//!    - `fn build(cx, content, variant) -> Result<Body, Error>`: Komponente aus layouts.tsx/layouts-extra.tsx
//!      mit den Bausteinen aus `crate::blocks` (header, eyebrow, points, card, grid_cols/Stack, media/media_safe,
//!      photo/scrim/on_photo, img, icon/icon_mark, table, chart, kpi_value/kpi_delta, quote_mark/quote_by,
//!      logo_tile, Stil-Helfer). Klassen aus slide.css/layouts-extra.css werden zu taffy-Stilen; Theme-Hebel über
//!      `cx.elements()`, `cx.tk`, Formate über `cx.tall`/`cx.narrow`/`cx.profile`, Komposition über `cx.frame`.
//!      Rahmen und Fußzeile setzt `build_slide`; Fotos am Rand gehen über `Body { media, safe }`.
//!    - `fn samples()` = min/typ/max aus layouts.ts (für Tests und dw-refcheck).
//! 2. In `g_<gruppe>.rs` `mod <id>;` und eine Zeile in dessen `LAYOUTS` ergänzen.

mod bullets;
mod cover;
mod g_bild;
mod g_daten;
mod g_druck;
#[cfg(feature = "pro")]
mod g_pro;
mod g_struktur;
mod g_text;
mod two_column;

use dw_theme::Tone;
use serde_json::Value;

use crate::Error;
use crate::blocks::{self, Body, Cx};
use crate::tree::Div;

/// Eigenschaften eines Layouts (LayoutDef in layouts.ts) samt Bau-Funktion.
pub struct Def {
    /// Fußzeile (Kapitel, Seite)
    pub footer: bool,
    /// erlaubte Kompositionen außer top
    pub frames: &'static [&'static str],
    /// Ton des Layouts (Kapitel: accent), sectionTone des Themes geht vor
    pub tone: Option<Tone>,
    /// Dekor in der kräftigen Fassung (Cover, Kapitel, Statement)
    pub hero: bool,
    pub(crate) build: fn(&Cx, &Value, Option<&str>) -> Result<Body, Error>,
    /// [min, typ, max]
    pub samples: fn() -> [(&'static str, Value); 3],
}

/// (id, Varianten, Def): so bleibt `for (id, variants, _) in LAYOUTS` für Aufrufer gleich.
pub type Layout = (&'static str, &'static [&'static str], Def);

/// Kern-Layouts mit Chromium-Referenzen (dw-refcheck); alle Layouts liefert `all_layouts()`.
pub const LAYOUTS: &[Layout] = &[
    ("cover", cover::VARIANTS, cover::DEF),
    ("bullets", bullets::VARIANTS, bullets::DEF),
    ("two-column", two_column::VARIANTS, two_column::DEF),
];

/// Kern-Layouts und alle Gruppen.
pub fn all_layouts() -> impl Iterator<Item = &'static Layout> {
    let groups: [&'static [Layout]; 5] = [
        g_text::LAYOUTS,
        g_struktur::LAYOUTS,
        g_bild::LAYOUTS,
        g_daten::LAYOUTS,
        g_druck::LAYOUTS,
    ];
    #[cfg(feature = "pro")]
    let pro = g_pro::LAYOUTS;
    #[cfg(not(feature = "pro"))]
    let pro: &'static [Layout] = &[];
    LAYOUTS
        .iter()
        .chain(groups.into_iter().flatten())
        .chain(pro)
}

pub fn get(id: &str) -> Option<&'static Def> {
    let pro = || {
        #[cfg(feature = "pro")]
        return g_pro::find(id);
        #[cfg(not(feature = "pro"))]
        None
    };
    LAYOUTS
        .iter()
        .find(|l| l.0 == id)
        .map(|l| &l.2)
        .or_else(|| g_text::find(id))
        .or_else(|| g_struktur::find(id))
        .or_else(|| g_bild::find(id))
        .or_else(|| g_daten::find(id))
        .or_else(|| g_druck::find(id))
        .or_else(pro)
}

/// Inhalt des Layouts im Rahmen (Frame) der Folie.
pub(crate) fn build_slide(cx: &Cx, layout: &str, v: Option<&str>, c: &Value) -> Result<Div, Error> {
    let def = get(layout).ok_or_else(|| Error::UnknownLayout(layout.to_string()))?;
    let body = (def.build)(cx, c, v)?;
    Ok(blocks::frame(cx, layout, def.footer, def.hero, body))
}
