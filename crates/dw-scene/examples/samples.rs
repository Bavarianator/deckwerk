//! Rendert min/typ/max aller Layouts mit Theme beratung:
//! `cargo run -p dw-scene --example samples [-- <out>]` → <out>/<layout>-<variant>-<sample>.{measured,scene}.json

use std::path::PathBuf;

use dw_scene::{FontStore, LAYOUTS, render_slide, samples};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/dw-scene-samples")
        });
    std::fs::create_dir_all(&out)?;
    let mut fonts = FontStore::from_dir(&FontStore::default_dir())?;
    let mut n = 0;
    for (layout, variants, _) in LAYOUTS {
        for variant in *variants {
            for (name, content) in samples::samples(layout).expect("Beispiele") {
                let deck = samples::deck(layout, variant, content);
                let t = std::time::Instant::now();
                let (scene, measured) = render_slide(&deck, 0, &mut fonts)?;
                let stem = format!("{layout}-{variant}-{name}");
                std::fs::write(
                    out.join(format!("{stem}.measured.json")),
                    serde_json::to_string_pretty(&measured)?,
                )?;
                std::fs::write(
                    out.join(format!("{stem}.scene.json")),
                    serde_json::to_string_pretty(&scene)?,
                )?;
                let f = &measured.fit;
                println!(
                    "{stem}: ok={} head={} body={} overflow={} ({:.1} ms)",
                    f.ok,
                    f.head,
                    f.body,
                    f.overflow.len(),
                    t.elapsed().as_secs_f64() * 1000.
                );
                n += 1;
            }
        }
    }
    println!("{n} Paare nach {}", out.display());
    Ok(())
}
