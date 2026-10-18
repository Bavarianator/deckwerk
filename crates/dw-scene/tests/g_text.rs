//! Gruppe „Text“: jede Variante × min/typ/max rendert, typ passt ohne Überlauf.

use dw_model::{El, Measured};
use dw_scene::{FontStore, all_layouts, render_slide, samples};

const IDS: &[&str] = &[
    "agenda",
    "section",
    "statement",
    "closing",
    "summary",
    "blank",
    "big-number",
    "quote",
];

fn render(layout: &str, variant: &str, sample: &str, fonts: &mut FontStore) -> Measured {
    let content = samples::samples(layout)
        .unwrap()
        .into_iter()
        .find(|(n, _)| *n == sample)
        .unwrap()
        .1;
    render_slide(&samples::deck(layout, variant, content), 0, fonts)
        .unwrap_or_else(|e| panic!("{layout}/{variant}/{sample}: {e}"))
        .1
}

#[test]
fn all_variants_render() {
    let mut f = FontStore::from_dir(&FontStore::default_dir()).expect("Schriften");
    for id in IDS {
        let (_, variants, _) = all_layouts()
            .find(|l| l.0 == *id)
            .unwrap_or_else(|| panic!("{id} fehlt"));
        let vs: &[&str] = if variants.is_empty() { &[""] } else { variants };
        for v in vs {
            for s in ["min", "typ", "max"] {
                let m = render(id, v, s, &mut f);
                if s == "typ" {
                    assert!(m.fit.ok, "{id}/{v}/typ: {:?}", m.fit);
                }
            }
        }
    }
}

#[test]
fn agenda_baseline_and_active() {
    let mut f = FontStore::from_dir(&FontStore::default_dir()).expect("Schriften");
    let m = render("agenda", "", "typ", &mut f);
    let y = |slot: &str| {
        m.els
            .iter()
            .map(El::base)
            .find(|b| b.slot == slot)
            .unwrap_or_else(|| panic!("kein {slot}"))
            .bbox
            .y
    };
    // Chromium (beratung, line): Nummer 6 px tiefer als der Titel, auf dessen Grundlinie
    assert!((y("_num.0") - y("items.0.title") - 6.).abs() < 0.5);
    assert!(y("_active") < y("items.1.title"));
}
