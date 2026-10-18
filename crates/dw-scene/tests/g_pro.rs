//! Gruppe „Pro“: jede Variante × min/typ/max rendert, typ passt ohne Überlauf.
#![cfg(feature = "pro")]

use dw_scene::{FontStore, all_layouts, render_slide, samples};

#[test]
fn all_variants_render() {
    let mut f = FontStore::from_dir(&FontStore::default_dir()).expect("Schriften");
    for id in ["stream-screen", "panel"] {
        let (_, variants, _) = all_layouts()
            .find(|l| l.0 == id)
            .unwrap_or_else(|| panic!("{id} fehlt"));
        let vs: &[&str] = if variants.is_empty() { &[""] } else { variants };
        for v in vs {
            for (s, content) in samples::samples(id).unwrap() {
                let mut deck = samples::deck(id, v, content);
                if id == "panel" {
                    deck.size = serde_json::from_value(serde_json::json!({ "w": 320, "h": 160 })).unwrap();
                }
                let m = render_slide(&deck, 0, &mut f)
                    .unwrap_or_else(|e| panic!("{id}/{v}/{s}: {e}"))
                    .1;
                if s == "typ" {
                    assert!(m.fit.ok, "{id}/{v}/typ: {:?}", m.fit);
                }
            }
        }
    }
}
