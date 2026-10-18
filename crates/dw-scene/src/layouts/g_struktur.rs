//! Layout-Gruppe „Struktur“: kpi-grid, timeline, process, options, matrix, pros-cons, problem-solution, funnel, market-size, pricing.
//! Diese Datei (und Unterdateien unter `layouts/g_struktur/`) gehört allein dem Agent dieser Gruppe.
//! Neues Layout: `mod <id>;` (Datei `layouts/g_struktur/<id>.rs`, Vorlage `layouts/two_column.rs`) und eine Zeile in `LAYOUTS`.

mod funnel;
mod kpi_grid;
mod market_size;
mod matrix;
mod options;
mod pricing;
mod problem_solution;
mod process;
mod pros_cons;
mod timeline;

use dw_theme::Role;

use super::{Def, Layout};
use crate::blocks::{Cx, StyleExt, t_styled};
use crate::tree::Div;
use taffy::prelude::Style;

pub const LAYOUTS: &[Layout] = &[
    ("kpi-grid", kpi_grid::VARIANTS, kpi_grid::DEF),
    ("timeline", timeline::VARIANTS, timeline::DEF),
    ("process", process::VARIANTS, process::DEF),
    ("options", options::VARIANTS, options::DEF),
    ("matrix", matrix::VARIANTS, matrix::DEF),
    ("pros-cons", pros_cons::VARIANTS, pros_cons::DEF),
    ("problem-solution", problem_solution::VARIANTS, problem_solution::DEF),
    ("funnel", funnel::VARIANTS, funnel::DEF),
    ("market-size", market_size::VARIANTS, market_size::DEF),
    ("pricing", pricing::VARIANTS, pricing::DEF),
];

pub fn find(id: &str) -> Option<&'static Def> {
    LAYOUTS.iter().find(|l| l.0 == id).map(|l| &l.2)
}

/// Quellenzeile unter dem Inhalt (`<T role="footer" className="source">`, .source: flex none, margin-top 18).
// ponytail: fehlt in blocks.rs, lokal gebaut
pub(super) fn source(cx: &Cx, slot: &str, text: Option<&str>) -> Option<Div> {
    text.map(|s| t_styled(cx.t(Role::Footer, slot, s), Style::DEFAULT.none().mt(18.)))
}

/// words() aus layouts-extra.ts: eigene Wortliste, sonst wie samples::words.
pub(super) fn words_x(max: usize, offset: usize) -> String {
    const W: &str = "Wettbewerbsfähigkeit Kundenbindung verbessert deutlich durch schnellere Abläufe im Vertrieb und klare Verantwortung für messbare Ergebnisse";
    let w: Vec<&str> = W.split(' ').collect();
    let len = |s: &str| s.encode_utf16().count();
    let mut s = String::new();
    for i in offset.. {
        let next = if s.is_empty() {
            w[i % w.len()].to_string()
        } else {
            format!("{s} {}", w[i % w.len()])
        };
        if len(&next) > max {
            // JS: next.slice(0, max) in UTF-16-Einheiten; die Wörter sind BMP, also Zeichen
            return if s.is_empty() { next.chars().take(max).collect() } else { s };
        }
        s = next;
    }
    unreachable!()
}
