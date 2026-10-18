//! Gruppe „Druck“: jede Variante × min/typ/max rendert im A4-Format, typ passt ohne Überlauf.

use dw_model::Measured;
use dw_scene::{FontStore, all_layouts, render_slide, samples};

/// (Layout, Format w×h)
const IDS: &[(&str, f64, f64)] = &[
    ("doc-text", 794., 1123.),
    ("offer", 794., 1123.),
    ("certificate", 1123., 794.),
    ("menu", 794., 1123.),
];

fn render(layout: &str, (w, h): (f64, f64), variant: &str, sample: &str, fonts: &mut FontStore) -> Measured {
    let content = samples::samples(layout)
        .unwrap()
        .into_iter()
        .find(|(n, _)| *n == sample)
        .unwrap()
        .1;
    let mut deck = samples::deck(layout, variant, content);
    deck.size = Some(serde_json::from_value(serde_json::json!({ "w": w, "h": h })).unwrap());
    render_slide(&deck, 0, fonts)
        .unwrap_or_else(|e| panic!("{layout}/{variant}/{sample}: {e}"))
        .1
}

#[test]
fn all_variants_render_a4() {
    let mut f = FontStore::from_dir(&FontStore::default_dir()).expect("Schriften");
    for &(id, w, h) in IDS {
        let (_, variants, _) = all_layouts()
            .find(|l| l.0 == id)
            .unwrap_or_else(|| panic!("{id} fehlt"));
        let vs: &[&str] = if variants.is_empty() { &[""] } else { variants };
        for v in vs {
            for s in ["min", "typ", "max"] {
                let m = render(id, (w, h), v, s, &mut f);
                if s == "typ" {
                    assert!(m.fit.ok, "{id}/{v}/typ: {:?}", m.fit);
                }
            }
        }
    }
}
