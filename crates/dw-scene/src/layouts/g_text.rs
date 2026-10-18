//! Layout-Gruppe „Text“: agenda, section, statement, closing, summary, blank, big-number, quote.
//! Diese Datei (und Unterdateien unter `layouts/g_text/`) gehört allein dem Agent dieser Gruppe.
//! Neues Layout: `mod <id>;` (Datei `layouts/g_text/<id>.rs`, Vorlage `layouts/two_column.rs`) und eine Zeile in `LAYOUTS`.

mod agenda;
mod big_number;
mod blank;
mod closing;
mod quote;
mod section;
mod statement;
mod summary;

use super::{Def, Layout};
use crate::blocks::pxa;
use crate::text::TextSpec;
use crate::tree::{Div, ImgSpec, Kind};

pub const LAYOUTS: &[Layout] = &[
    ("agenda", agenda::VARIANTS, agenda::DEF),
    ("section", section::VARIANTS, section::DEF),
    ("statement", statement::VARIANTS, statement::DEF),
    ("closing", closing::VARIANTS, closing::DEF),
    ("summary", summary::VARIANTS, summary::DEF),
    ("blank", blank::VARIANTS, blank::DEF),
    ("big-number", big_number::VARIANTS, big_number::DEF),
    ("quote", quote::VARIANTS, quote::DEF),
];

pub fn find(id: &str) -> Option<&'static Def> {
    LAYOUTS.iter().find(|l| l.0 == id).map(|l| &l.2)
}

/// words() aus layouts-extra.ts: eigene Wortliste der Profi-Layouts (summary, big-number).
fn words_x(max: usize, offset: usize) -> String {
    const W: &str = "Wettbewerbsfähigkeit Kundenbindung verbessert deutlich durch schnellere Abläufe im Vertrieb und klare Verantwortung für messbare Ergebnisse";
    let w: Vec<&str> = W.split(' ').collect();
    let len = |s: &str| s.encode_utf16().count();
    let mut s = String::new();
    for i in offset.. {
        let word = w[i % w.len()];
        let next = if s.is_empty() {
            word.to_string()
        } else {
            format!("{s} {word}")
        };
        if len(&next) > max {
            return if s.is_empty() {
                word.chars().take(max).collect()
            } else {
                s
            };
        }
        s = next;
    }
    unreachable!()
}

/// hhea-Aufstieg/-Abstieg (je em) der beiliegenden Schriften.
const METRICS: &[(&str, f32, f32)] = &[
    ("Archivo", 0.878, 0.210),
    ("Archivo Black", 0.878, 0.210),
    ("DM Sans", 0.992, 0.310),
    ("DM Serif Display", 1.036, 0.335),
    ("Fraunces", 0.978, 0.255),
    ("IBM Plex Mono", 1.025, 0.275),
    ("IBM Plex Sans", 1.025, 0.275),
    ("IBM Plex Serif", 1.025, 0.275),
    ("Instrument Serif", 0.990, 0.310),
    ("Inter", 0.96875, 0.2412),
    ("Lora", 1.006, 0.274),
    ("Manrope", 1.066, 0.300),
    ("Playfair Display", 1.082, 0.251),
    ("Plus Jakarta Sans", 1.038, 0.222),
    ("Source Sans 3", 1.024, 0.400),
    ("Source Serif 4", 1.036, 0.335),
    ("Space Grotesk", 0.984, 0.292),
];

/// Erste Grundlinie eines Texts ab Boxoberkante wie Blink: Aufstieg und Abstieg gerundet, Grundlinie gerundet.
/// Für align-items: baseline, das tree.rs (taffy ohne Baselines) nicht kann.
/// ponytail: Metriken als Tabelle der beiliegenden Schriften; gehört als Baseline-Messung nach tree.rs
pub(super) fn baseline(spec: &TextSpec) -> f32 {
    let (a, d) = spec
        .family
        .split(',')
        .map(|f| f.trim().trim_matches(['\'', '"']))
        .find_map(|f| METRICS.iter().find(|m| m.0 == f).map(|m| (m.1, m.2)))
        .unwrap_or((1.025, 0.275));
    let (a, d) = ((a * spec.size).round(), (d * spec.size).round());
    (a + (spec.size * spec.lh - (a + d)) / 2.).round()
}

/// Zeile mit align-items: baseline (die Zeile selbst steht auf flex-start): je Kind (Div, margin-top, Grundlinie)
/// wird der obere Rand so gesetzt, dass alle Grundlinien auf der tiefsten liegen.
fn baseline_row(kids: Vec<(Div, f32, f32)>) -> Vec<Div> {
    let top = kids.iter().map(|k| k.1 + k.2).fold(f32::MIN, f32::max);
    kids.into_iter()
        .map(|(mut d, _, bl)| {
            d.style.margin.top = pxa(top - bl);
            d
        })
        .collect()
}

/// Bildvorgabe eines fertigen Bild-Divs ändern (under, round).
fn img_mut(mut d: Div, f: impl FnOnce(&mut ImgSpec)) -> Div {
    if let Kind::Img(spec) = &mut d.kind {
        f(spec);
    }
    d
}

/// Platzhalter ohne Foto (.placeholder): Fläche surface2 über die ganze Box, landet im Hintergrundbild.
fn placeholder(cx: &crate::blocks::Cx) -> Div {
    Div::new(crate::blocks::abs(Some(0.), Some(0.), Some(0.), Some(0.))).paint(cx.tk.surface2)
}

/// Bildquelle eines Foto-Felds (photoOf: String oder {src}); None = Feld fehlt.
fn photo_src(v: &serde_json::Value) -> Option<&str> {
    match v {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Object(o) => Some(o.get("src").and_then(|s| s.as_str()).unwrap_or("")),
        _ => None,
    }
}
