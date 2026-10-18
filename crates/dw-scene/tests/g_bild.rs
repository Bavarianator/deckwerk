//! Gruppe „Bild“: jede Variante × min/typ/max rendert, typ passt ohne Überlauf.

use dw_model::Measured;
use dw_scene::{FontStore, all_layouts, render_slide, samples};

const IDS: &[&str] = &["image-text", "photo", "gallery", "team", "logos", "icon-grid", "clip", "code", "screen"];

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

