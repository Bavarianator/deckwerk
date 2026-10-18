//! `cargo run -p dw-refcheck -- [--out target/refcheck] [--layout <id>] [--theme <id>] [--format <ordner>] [--strict] [--json <datei>]`:
//! dw-scene gegen die Chromium-Referenzen in tests/refs/<theme>/<format>/ (Decks aus decks.json).
//! Layouts, die dw-scene noch nicht kann, zählen als „fehlt“. Exit-Code 0; mit --strict 1, sobald eine Kombination abweicht.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use dw_model::{Deck, Measured};
use dw_raster::{RasterOpts, render_rgba};
use dw_refcheck::{BOX_TOL, SIZE_TOL, SlotText, compare, lines_diff, pixel_diff};
use dw_scene::{Error, FontStore, render_slide_lines};
use serde_json::{Map, Value, json};

type Res<T> = Result<T, Box<dyn std::error::Error>>;

#[derive(Default)]
struct Count {
    same: usize,
    differ: usize,
    missing: usize,
}

fn arg<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn dirs(p: &Path) -> Res<Vec<PathBuf>> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(p)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.is_dir())
        .collect();
    v.sort();
    Ok(v)
}

fn name(p: &Path) -> String {
    p.file_name().unwrap_or_default().to_string_lossy().into()
}

fn main() -> Res<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let strict = args.iter().any(|a| a == "--strict");
    let (only_layout, only_theme, only_format) = (
        arg(&args, "--layout"),
        arg(&args, "--theme"),
        arg(&args, "--format").map(|f| f.replace(':', "x")),
    );
    let out = arg(&args, "--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target/refcheck"));
    let mut fonts = FontStore::from_dir(&FontStore::default_dir())?;

    let mut layouts: BTreeMap<String, Count> = BTreeMap::new();
    let mut combos = Vec::new();
    println!(
        "{:<44} {:>9} {:>9} {:>6} {:>6} {:>7} {:>5}  {:>12} {:>7}  größte Abweichung",
        "Kombination",
        "Stufe ref",
        "dw-scene",
        "Zeilen",
        "Umbr.",
        "Box px",
        "Slots",
        "Ø Δ RGB",
        "Δ>32"
    );
    for theme_dir in dirs(&root.join("tests/refs"))? {
        let theme = name(&theme_dir);
        if only_theme.is_some_and(|t| t != theme) {
            continue;
        }
        for dir in dirs(&theme_dir)? {
            let format = name(&dir);
            if only_format.as_deref().is_some_and(|f| f != format) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(dir.join("decks.json")) else {
                continue;
            };
            let decks: Map<String, Value> = serde_json::from_str(&text)?;
            let img_dir = out.join(&theme).join(&format);
            std::fs::create_dir_all(&img_dir)?;
            for (stem, deck) in &decks {
                let deck: Deck = serde_json::from_value(deck.clone())?;
                let layout = deck.slides[0].layout.clone();
                if only_layout.is_some_and(|l| l != layout) {
                    continue;
                }
                let tag = format!("{theme}/{format}/{stem}");
                let count = layouts.entry(layout.clone()).or_default();
                let (scene, ours, our_lines) = match render_slide_lines(&deck, 0, &mut fonts) {
                    Ok(r) => r,
                    Err(Error::UnknownLayout(_)) => {
                        count.missing += 1;
                        combos.push(json!({ "theme": theme, "format": format, "stem": stem, "layout": layout, "status": "fehlt" }));
                        continue;
                    }
                    Err(e) => {
                        count.differ += 1;
                        println!("✗ {tag:<42} Fehler: {e}");
                        combos.push(json!({ "theme": theme, "format": format, "stem": stem, "layout": layout, "status": "abweichend", "error": e.to_string() }));
                        continue;
                    }
                };
                let reference: Measured = serde_json::from_str(&std::fs::read_to_string(
                    dir.join(format!("{stem}.measured.json")),
                )?)?;
                let r = compare(&reference, &ours);
                let ref_lines = read_lines(&dir.join(format!("{stem}.lines.json")))?;
                let our_lines: Vec<SlotText> =
                    our_lines.into_iter().map(|l| (l.slot, l.lines)).collect();
                let ld = lines_diff(&ref_lines, &our_lines);
                let ok = r.ok() && ld.is_empty();

                let png = dir.join(format!("{stem}.png"));
                let px = if png.exists() {
                    let ref_png = image::open(&png)?.to_rgb8();
                    let our_png =
                        image::DynamicImage::from(render_rgba(&scene, 2., &RasterOpts::default())?)
                            .to_rgb8();
                    let (px, diff) = pixel_diff(&ref_png, &our_png);
                    our_png.save(img_dir.join(format!("{stem}.png")))?;
                    diff.save(img_dir.join(format!("{stem}.diff.png")))?;
                    Some(px)
                } else {
                    None
                };

                if ok {
                    count.same += 1;
                } else {
                    count.differ += 1;
                }
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
                let n_or = |n: usize| {
                    if n == 0 {
                        "=".into()
                    } else {
                        format!("{n}≠")
                    }
                };
                println!(
                    "{} {:<42} {:>9} {:>9} {:>6} {:>6} {:>7.1} {:>5}  {:>12} {:>6}  {}{}",
                    if ok { "✓" } else { "✗" },
                    tag,
                    fit(r.fit_ref),
                    fit(r.fit_ours),
                    n_or(lines_bad),
                    n_or(ld.len()),
                    r.max_box(),
                    if r.slots_same() {
                        "=".into()
                    } else {
                        format!("-{}+{}", r.missing.len(), r.extra.len())
                    },
                    px.as_ref().map_or("–".into(), |p| format!(
                        "{:.1}/{:.1}/{:.1}",
                        p.mean[0], p.mean[1], p.mean[2]
                    )),
                    px.as_ref()
                        .map_or("–".into(), |p| format!("{:.1}%", p.over32 * 100.)),
                    worst,
                    if px.as_ref().is_none_or(|p| p.size_same) {
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
                for d in &ld {
                    println!("    Umbruch {}: {:?} → {:?}", d.slot, d.reference, d.ours);
                }
                for s in &r.missing {
                    println!("    fehlt: {s}");
                }
                for s in &r.extra {
                    println!("    zusätzlich: {s}");
                }
                combos.push(json!({
                    "theme": theme, "format": format, "stem": stem, "layout": layout,
                    "status": if ok { "gleich" } else { "abweichend" },
                    "fitRef": [r.fit_ref.0, r.fit_ref.1, r.fit_ref.2], "fitOurs": [r.fit_ours.0, r.fit_ours.1, r.fit_ours.2],
                    "maxBoxPx": r.max_box(), "linesDiff": ld.iter().map(|d| &d.slot).collect::<Vec<_>>(),
                    "missingSlots": r.missing, "extraSlots": r.extra,
                    "pixelOver32": px.as_ref().map(|p| p.over32),
                }));
            }
        }
    }

    println!(
        "\n{:<24} {:>7} {:>10} {:>6}",
        "Layout", "gleich", "abweichend", "fehlt"
    );
    let mut sum = Count::default();
    let (mut l_same, mut l_differ) = (0, 0);
    for (id, c) in &layouts {
        println!("{id:<24} {:>7} {:>10} {:>6}", c.same, c.differ, c.missing);
        sum.same += c.same;
        sum.differ += c.differ;
        sum.missing += c.missing;
        l_same += usize::from(c.differ == 0 && c.missing == 0);
        l_differ += usize::from(c.differ > 0);
    }
    let total = sum.same + sum.differ + sum.missing;
    println!(
        "\nAbdeckung: {l_same}/{} Layouts vollständig gleich, {l_differ} abweichend; Kombinationen {}/{total} gleich, {} abweichend, {} fehlen.\n\
         Gleich = Stufe, Zeilenzahlen und Umbruchstellen gleich, sizePx/lineHeightPx ≤ {SIZE_TOL}, Boxen ≤ {BOX_TOL} px, gleiche Slots. Bilder: {}",
        layouts.len(),
        sum.same,
        sum.differ,
        sum.missing,
        out.display()
    );
    if let Some(path) = arg(&args, "--json") {
        let layouts: Map<String, Value> = layouts
            .iter()
            .map(|(id, c)| {
                (
                    id.clone(),
                    json!({ "gleich": c.same, "abweichend": c.differ, "fehlt": c.missing }),
                )
            })
            .collect();
        let report = json!({ "gesamt": total, "gleich": sum.same, "abweichend": sum.differ, "fehlt": sum.missing, "layouts": layouts, "kombinationen": combos });
        std::fs::write(path, serde_json::to_string_pretty(&report)?)?;
    }
    if strict && sum.differ > 0 {
        std::process::exit(1);
    }
    Ok(())
}

fn read_lines(p: &Path) -> Res<Vec<SlotText>> {
    let v: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(p)?)?;
    Ok(v.into_iter()
        .map(|e| {
            let slot = e["slot"].as_str().unwrap_or_default().to_string();
            let lines = e["lines"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|l| l.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            (slot, lines)
        })
        .collect())
}

fn amax(d: &[f64; 4]) -> f64 {
    d.iter().fold(0., |m, v| m.max(v.abs()))
}
