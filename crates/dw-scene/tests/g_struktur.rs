//! Gruppe „Struktur“: alle Varianten × min/typ/max rendern, typ ohne Überlauf (Autofit ok).

use dw_scene::{FontStore, all_layouts, render_slide, samples};

const IDS: &[&str] = &[
    "kpi-grid", "timeline", "process", "options", "matrix", "pros-cons", "problem-solution", "funnel",
    "market-size", "pricing",
];

#[test]
fn struktur_renders() {
    let mut fonts = FontStore::from_dir(&FontStore::default_dir()).expect("Schriften");
    let mut errs = Vec::new();
    for id in IDS {
        let Some((_, variants, _)) = all_layouts().find(|l| l.0 == *id) else {
            eprintln!("{id}: nicht registriert");
            continue;
        };
        let vs: Vec<&str> = if variants.is_empty() { vec!["default"] } else { variants.to_vec() };
        for v in vs {
            for (name, content) in samples::samples(id).unwrap() {
                match render_slide(&samples::deck(id, v, content), 0, &mut fonts) {
                    Ok((_, m)) if name == "typ" && !(m.fit.ok && m.fit.overflow.is_empty()) => {
                        errs.push(format!("{id}/{v}/{name}: Autofit {:?}", m.fit))
                    }
                    Ok(_) => {}
                    Err(e) => errs.push(format!("{id}/{v}/{name}: {e}")),
                }
            }
        }
    }
    assert!(errs.is_empty(), "{}", errs.join("\n"));
}

// DUMP-TEMP
#[test]
#[ignore]
fn dump() {
    let spec = std::env::var("DUMP").unwrap();
    let (dir, stem) = spec.rsplit_once('/').unwrap();
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/refs/");
    let decks: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{root}{dir}/decks.json")).unwrap()).unwrap();
    let deck: dw_model::Deck = serde_json::from_value(decks[stem].clone()).unwrap();
    let mut fonts = FontStore::from_dir(&FontStore::default_dir()).unwrap();
    let (_, m) = render_slide(&deck, 0, &mut fonts).unwrap();
    for e in &m.els {
        let b = e.base();
        let lines = if let dw_model::El::Text(t) = e { format!(" {}", t.lines) } else { String::new() };
        println!("{} {:.1} {:.1} {:.1} {:.1}{}", b.slot, b.bbox.x, b.bbox.y, b.bbox.w, b.bbox.h, lines);
    }
}
