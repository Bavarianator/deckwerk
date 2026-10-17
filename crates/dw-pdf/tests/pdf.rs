//! Prüft die PDFs mit poppler (pdfinfo, pdftotext, pdftoppm) und Ghostscript (ink_cov: Farbauftrag je Kanal in %).

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use dw_model::*;
use dw_pdf::{PdfOpts, render_pdf, total_area_coverage};
use kurbo::{Affine, Point, Rect, Shape};
use skrifa::MetadataProvider;

const FONT: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../assets/fonts/IBMPlexSans-Regular.ttf"
);

fn c(hex: &str) -> Color {
    Color::from_hex(hex).unwrap()
}

fn rect(r: Rect, fill: Paint) -> Node {
    Node::Rect {
        meta: NodeMeta::default(),
        rect: r,
        radius: 0.0,
        fill: Some(fill),
        stroke: None,
        shadow: None,
    }
}

fn text(s: &str, x: f32, y: f32, size: f32, color: Color) -> Node {
    let data = Arc::new(std::fs::read(FONT).unwrap());
    let f = skrifa::FontRef::new(&data).unwrap();
    let (cmap, adv) = (
        f.charmap(),
        f.glyph_metrics(
            skrifa::instance::Size::new(size),
            skrifa::instance::LocationRef::default(),
        ),
    );
    let mut cx = x;
    let glyphs = s
        .chars()
        .map(|ch| {
            let id = cmap.map(ch).unwrap();
            let g = Glyph {
                id: id.to_u32(),
                x: cx,
                y,
            };
            cx += adv.advance_width(id).unwrap();
            g
        })
        .collect();
    Node::Glyphs {
        meta: NodeMeta::default(),
        run: GlyphRun {
            font: FontData {
                data,
                index: 0,
                family: "IBM Plex Sans".into(),
                weight: 400,
                italic: false,
            },
            size,
            color,
            glyphs,
            text: s.into(),
        },
    }
}

fn photo() -> Vec<u8> {
    let mut png = Vec::new();
    image::RgbaImage::from_fn(64, 32, |x, y| {
        image::Rgba([(x * 4) as u8, (y * 8) as u8, 160, 255])
    })
    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
    .unwrap();
    png
}

fn slide() -> Scene {
    let stops = vec![
        Stop {
            offset: 0.0,
            color: c("#b0431a"),
        },
        Stop {
            offset: 1.0,
            color: c("#1a5fb0"),
        },
    ];
    Scene {
        width: 1280.0,
        height: 720.0,
        background: c("#f4efe6"),
        nodes: vec![
            rect(
                Rect::new(80.0, 80.0, 600.0, 300.0),
                Paint::Linear {
                    start: Point::new(80.0, 0.0),
                    end: Point::new(600.0, 0.0),
                    stops,
                },
            ),
            Node::Image {
                meta: NodeMeta::default(),
                rect: Rect::new(700.0, 80.0, 1200.0, 400.0),
                src: ImageSrc::Bytes(Arc::new(photo())),
                fit: ImgFit::Cover,
                focus: (0.5, 0.5),
                radius: 24.0,
            },
            Node::Group {
                meta: NodeMeta::default(),
                transform: Affine::translate((80.0, 360.0)),
                opacity: 0.6,
                clip: Some(Rect::new(0.0, 0.0, 300.0, 120.0).to_path(0.1)),
                blend: Blend::Normal,
                children: vec![rect(
                    Rect::new(0.0, 0.0, 500.0, 200.0),
                    Paint::Solid(c("#1a5fb0")),
                )],
            },
            text("Hallo Deckwerk", 80.0, 620.0, 64.0, Color::BLACK),
        ],
    }
}

fn out(name: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    p
}

fn run(cmd: &str, args: &[&str]) -> String {
    let o = Command::new(cmd)
        .args(args)
        .output()
        .unwrap_or_else(|e| panic!("{cmd}: {e}"));
    assert!(
        o.status.success(),
        "{cmd} {args:?}: {}",
        String::from_utf8_lossy(&o.stderr)
    );
    String::from_utf8_lossy(&o.stdout).into_owned() + &String::from_utf8_lossy(&o.stderr)
}

fn field<'a>(info: &'a str, key: &str) -> &'a str {
    info.lines()
        .find(|l| l.starts_with(key))
        .unwrap_or_else(|| panic!("{key} fehlt in\n{info}"))[key.len()..]
        .trim()
}

fn nums(s: &str) -> Vec<f32> {
    s.split_whitespace()
        .filter_map(|v| v.parse().ok())
        .collect()
}

#[test]
fn bildschirm_pdf() {
    let pdf = render_pdf(&[slide(), slide()], &PdfOpts::default()).unwrap();
    let f = out("bildschirm.pdf");
    std::fs::write(&f, pdf).unwrap();
    let f = f.to_str().unwrap();
    let info = run("pdfinfo", &[f]);
    assert_eq!(field(&info, "Pages:"), "2");
    assert!(
        field(&info, "Page size:").starts_with("960 x 540 pts"),
        "{info}"
    );
    let txt = run("pdftotext", &[f, "-"]);
    assert!(txt.contains("Hallo Deckwerk"), "Text: {txt:?}");
}

/// Weniger Glyphen als Zeichen (Ligatur): Text genau einmal in der Textebene.
#[test]
fn text_cluster_einmal() {
    let mut t = text("Hallo Deckwerk", 20.0, 100.0, 48.0, Color::BLACK);
    if let Node::Glyphs { run, .. } = &mut t {
        run.text = "Hallo Deckwerk!".into();
    }
    let s = Scene {
        width: 600.0,
        height: 200.0,
        background: Color::WHITE,
        nodes: vec![t],
    };
    let f = out("cluster.pdf");
    std::fs::write(&f, render_pdf(&[s], &PdfOpts::default()).unwrap()).unwrap();
    let txt = run("pdftotext", &[f.to_str().unwrap(), "-"]);
    assert_eq!(txt.matches("Deckwerk").count(), 1, "Text: {txt:?}");
}

#[test]
fn druck_pdf_boxen() {
    let a4 = Scene {
        width: 794.0,
        height: 1123.0,
        ..slide()
    };
    let pdf = render_pdf(
        &[a4],
        &PdfOpts {
            bleed_mm: 3.0,
            trim: Some((210.0, 297.0)),
            cmyk: false,
        },
    )
    .unwrap();
    let f = out("druck.pdf");
    std::fs::write(&f, pdf).unwrap();
    let info = run("pdfinfo", &["-box", f.to_str().unwrap()]);
    eprintln!(
        "Boxen:\n{}",
        info.lines()
            .filter(|l| l.contains("Box") || l.starts_with("Page size"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    let pt = |mm: f32| mm * 72.0 / 25.4;
    let close = |a: &[f32], b: &[f32]| {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 0.02)
    };
    let (b, w, h) = (pt(3.0), pt(210.0), pt(297.0));
    assert!(
        close(
            &nums(field(&info, "MediaBox:")),
            &[0.0, 0.0, w + 2.0 * b, h + 2.0 * b]
        ),
        "{info}"
    );
    assert!(
        close(
            &nums(field(&info, "BleedBox:")),
            &[0.0, 0.0, w + 2.0 * b, h + 2.0 * b]
        ),
        "{info}"
    );
    assert!(
        close(&nums(field(&info, "TrimBox:")), &[b, b, b + w, b + h]),
        "{info}"
    );
}

/// Mittlere Abweichung je Kanal (0–255) zwischen PDF (pdftoppm) und PNG (dw-raster).
#[test]
fn pdf_gleich_png() {
    let scene = slide();
    let png = dw_raster::render_rgba(&scene, 1.0, &dw_raster::RasterOpts::default()).unwrap();
    let f = out("vergleich.pdf");
    std::fs::write(
        &f,
        render_pdf(std::slice::from_ref(&scene), &PdfOpts::default()).unwrap(),
    )
    .unwrap();
    let base = out("vergleich");
    run(
        "pdftoppm",
        &[
            "-r",
            "96",
            "-png",
            "-singlefile",
            f.to_str().unwrap(),
            base.to_str().unwrap(),
        ],
    );
    let pdf = image::open(base.with_extension("png")).unwrap().to_rgba8();
    assert_eq!(pdf.dimensions(), png.dimensions());
    let (mut sum, mut n) = (0u64, 0u64);
    for (a, b) in pdf.pixels().zip(png.pixels()) {
        for i in 0..3 {
            sum += u64::from(a[i].abs_diff(b[i]));
            n += 1;
        }
    }
    let mean = sum as f64 / n as f64;
    eprintln!("Pixeldiff PDF↔PNG: {mean:.3} von 255");
    assert!(mean < 2.0, "mittlere Abweichung {mean}");
}

#[test]
fn pdfx4_cmyk() {
    let pdf = render_pdf(
        &[slide()],
        &PdfOpts {
            bleed_mm: 3.0,
            trim: Some((297.0, 167.0)),
            cmyk: true,
        },
    )
    .unwrap();
    let f = out("pdfx4.pdf");
    std::fs::write(&f, &pdf).unwrap();
    let raw = String::from_utf8_lossy(&pdf);
    for need in [
        "/GTS_PDFX",
        "(FOGRA39)",
        "(PDF/X-4)",
        "/Trapped/False",
        "pdfxid:GTS_PDFXVersion",
        "%PDF-1.6",
    ] {
        assert!(raw.contains(need), "fehlt: {need}");
    }
    assert!(!raw.contains("/DeviceRGB"), "RGB-Farbraum im PDF/X-4");
    let f = f.to_str().unwrap();
    assert!(run("pdftotext", &[f, "-"]).contains("Hallo Deckwerk"));
    let ink = run(
        "gs",
        &[
            "-q",
            "-dNOPAUSE",
            "-dBATCH",
            "-o",
            "-",
            "-sDEVICE=ink_cov",
            f,
        ],
    );
    eprintln!("ink_cov Folie (%): {}", ink.trim());
    let v = nums(&ink);
    assert!(v.len() >= 4 && v[..4].iter().all(|x| *x > 0.0), "{ink}");

    // Schwarzer Text auf Weiß → nur K
    let s = Scene {
        width: 400.0,
        height: 200.0,
        background: Color::WHITE,
        nodes: vec![text("Schwarz", 20.0, 120.0, 72.0, Color::BLACK)],
    };
    let f = out("pdfx4-text.pdf");
    std::fs::write(
        &f,
        render_pdf(
            &[s],
            &PdfOpts {
                cmyk: true,
                ..Default::default()
            },
        )
        .unwrap(),
    )
    .unwrap();
    let ink = run(
        "gs",
        &[
            "-q",
            "-dNOPAUSE",
            "-dBATCH",
            "-o",
            "-",
            "-sDEVICE=ink_cov",
            f.to_str().unwrap(),
        ],
    );
    eprintln!("ink_cov schwarzer Text (%): {}", ink.trim());
    let v = nums(&ink);
    assert!(
        v[0] == 0.0 && v[1] == 0.0 && v[2] == 0.0 && v[3] > 1.0,
        "{ink}"
    );
}

#[test]
fn farbauftrag() {
    let scene = |n: Node| Scene {
        width: 100.0,
        height: 100.0,
        background: Color::WHITE,
        nodes: vec![n],
    };
    let weiss = total_area_coverage(&scene(Node::Group {
        meta: NodeMeta::default(),
        transform: Affine::IDENTITY,
        opacity: 1.0,
        clip: None,
        blend: Blend::Normal,
        children: vec![],
    }));
    let text_k = total_area_coverage(&scene(text("K", 0.0, 50.0, 20.0, Color::BLACK)));
    let tief = total_area_coverage(&scene(rect(
        Rect::new(0.0, 0.0, 10.0, 10.0),
        Paint::Solid(Color::BLACK),
    )));
    eprintln!(
        "Farbauftrag: weiß {weiss:.1} %, schwarzer Text {text_k:.1} %, #000-Fläche {tief:.1} %"
    );
    assert!(weiss < 1.0);
    assert!((text_k - 100.0).abs() < 0.5);
    assert!(tief > 250.0 && tief <= 400.0);
}
