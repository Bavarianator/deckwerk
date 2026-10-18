//! `cargo run -p dw-refcheck -- [--out target/refcheck] [--strict]`: dw-scene gegen die Chromium-Referenzen in tests/refs.
//! Exit-Code 0 (Spike); mit --strict 1, sobald eine Kombination abweicht.

use std::path::{Path, PathBuf};

use dw_model::{Deck, Measured};
use dw_raster::{RasterOpts, render_rgba};
use dw_refcheck::{BOX_TOL, SIZE_TOL, compare, pixel_diff};
use dw_scene::{FontStore, LAYOUTS, render_slide, samples};
use serde_json::{Map, Value};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn main() -> Res<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let strict = args.iter().any(|a| a == "--strict");
    let out = args
        .iter()
        .position(|a| a == "--out")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target/refcheck"));
    std::fs::create_dir_all(&out)?;
    let refs = root.join("tests/refs/beratung/16x9");
    let decks: Map<String, Value> =
        serde_json::from_str(&std::fs::read_to_string(refs.join("decks.json"))?)?;
    let mut fonts = FontStore::from_dir(&FontStore::default_dir())?;

    println!(
        "{:<32} {:>9} {:>9} {:>6} {:>7} {:>5}  {:>12} {:>7}  größte Abweichung",
        "Kombination", "Stufe ref", "dw-scene", "Zeilen", "Box px", "Slots", "Ø Δ RGB", "Δ>32"
    );
    let (mut total, mut same) = (0, 0);
    for (layout, variants, _) in LAYOUTS {
        for variant in *variants {
            for (name, content) in samples::samples(layout).expect("Beispiele") {
                let stem = format!("{layout}-{variant}-{name}");
                total += 1;
                let deck = samples::deck(layout, variant, content);
                check_deck(&deck, decks.get(&stem), &stem)?;
                let reference: Measured = serde_json::from_str(&std::fs::read_to_string(
                    refs.join(format!("{stem}.measured.json")),
                )?)?;
                let (scene, ours) = render_slide(&deck, 0, &mut fonts)?;
                let r = compare(&reference, &ours);

                let ref_png = image::open(refs.join(format!("{stem}.png")))?.to_rgb8();
                let our_png =
                    image::DynamicImage::from(render_rgba(&scene, 2., &RasterOpts::default())?)
                        .to_rgb8();
                let (px, diff) = pixel_diff(&ref_png, &our_png);
                our_png.save(out.join(format!("{stem}.png")))?;
                diff.save(out.join(format!("{stem}.diff.png")))?;

                same += usize::from(r.ok());
                let fit = |f: (bool, u32, u32)| {
                    format!("h{}/b{}{}", f.1, f.2, if f.0 { "" } else { "!" })
                };
                let lines_bad = r.texts.iter().filter(|t| t.lines.0 != t.lines.1).count();
                let worst = r
                    .texts
                    .iter()
                    .map(|t| (t.slot.as_str(), t.d))
                    .chain(r.boxes.iter().map(|b| (b.slot.as_str(), b.d)))
                    .max_by(|a, b| amax(&a.1).total_cmp(&amax(&b.1)))
                    .map(|(s, d)| {
                        format!(
                            "{s} Δx{:+.1} Δy{:+.1} Δw{:+.1} Δh{:+.1}",
                            d[0], d[1], d[2], d[3]
                        )
                    })
                    .unwrap_or_default();
                println!(
                    "{} {:<30} {:>9} {:>9} {:>6} {:>7.1} {:>5}  {:>12} {:>6.1}%  {}{}",
                    if r.ok() { "✓" } else { "✗" },
                    stem,
                    fit(r.fit_ref),
                    fit(r.fit_ours),
                    if lines_bad == 0 {
                        "=".into()
                    } else {
                        format!("{lines_bad}≠")
                    },
                    r.max_box(),
                    if r.slots_same() {
                        "=".into()
                    } else {
                        format!("-{}+{}", r.missing.len(), r.extra.len())
                    },
                    format!("{:.1}/{:.1}/{:.1}", px.mean[0], px.mean[1], px.mean[2]),
                    px.over32 * 100.,
                    worst,
                    if px.size_same {
                        ""
                    } else {
                        " (PNG-Größe abweichend)"
                    },
                );
                for t in r
                    .texts
                    .iter()
                    .filter(|t| t.lines.0 != t.lines.1 || !t.size_same())
                {
                    println!(
                        "    {}: Zeilen {}→{}, sizePx {}→{}, lineHeightPx {:.2}→{:.2}",
                        t.slot,
                        t.lines.0,
                        t.lines.1,
                        t.size_px.0,
                        t.size_px.1,
                        t.line_height_px.0,
                        t.line_height_px.1
                    );
                }
                for s in &r.missing {
                    println!("    fehlt: {s}");
                }
                for s in &r.extra {
                    println!("    zusätzlich: {s}");
                }
            }
        }
    }
    println!(
        "\n{same}/{total} gleich innerhalb Toleranz (Stufe gleich, alle Zeilenzahlen gleich, sizePx/lineHeightPx ≤ {SIZE_TOL}, Boxen ≤ {BOX_TOL} px, gleiche Slots). Bilder: {}",
        out.display()
    );
    if strict && same < total {
        std::process::exit(1);
    }
    Ok(())
}

fn amax(d: &[f64; 4]) -> f64 {
    d.iter().fold(0., |m, v| m.max(v.abs()))
}

/// Die Referenz muss aus demselben Deck stammen; transition/mode verlangt nur der TS-Typ (für die Folie ohne Wirkung).
fn check_deck(ours: &Deck, reference: Option<&Value>, stem: &str) -> Res<()> {
    let mut r: Deck = serde_json::from_value(
        reference
            .ok_or(format!("{stem}: fehlt in decks.json"))?
            .clone(),
    )?;
    r.transition = None;
    r.mode = None;
    if &r != ours {
        return Err(format!("{stem}: Referenz-Deck weicht von samples::deck ab – Referenzen neu erzeugen (tests/refs/README.md)").into());
    }
    Ok(())
}
