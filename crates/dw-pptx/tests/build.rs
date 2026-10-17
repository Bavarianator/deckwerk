// cargo test -j2 -p dw-pptx [-- --ignored für den LibreOffice-Smoke]
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::PathBuf;
use std::process::Command;

use dw_model::{Measured, Size};
use dw_pptx::{PptxInput, PptxSlide, build_pptx};
use serde_json::json;

fn out_dir(name: &str) -> PathBuf {
    // nicht /tmp: das LibreOffice-Flatpak sieht /tmp nicht
    let d = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/dw-pptx-test")
        .join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, _| image::Rgb([(x * 255 / w) as u8, 120, 200]));
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
    buf.into_inner()
}

fn base(slot: &str, x: f64, y: f64, w: f64, h: f64) -> serde_json::Value {
    json!({ "slot": slot, "box": { "x": x, "y": y, "w": w, "h": h } })
}

fn merge(mut a: serde_json::Value, b: serde_json::Value) -> serde_json::Value {
    a.as_object_mut()
        .unwrap()
        .extend(b.as_object().unwrap().clone());
    a
}

fn run(text: &str, extra: serde_json::Value) -> serde_json::Value {
    merge(
        json!({ "text": text, "bold": false, "italic": false, "color": "#1a1a1a" }),
        extra,
    )
}

fn text(
    slot: &str,
    y: f64,
    runs: Vec<serde_json::Value>,
    extra: serde_json::Value,
) -> serde_json::Value {
    merge(
        merge(
            base(slot, 80.0, y, 900.0, 120.0),
            json!({ "kind": "text", "font": "body", "role": "body", "sizePx": 28, "lineHeightPx": 36, "trackingPx": -0.5, "align": "left", "upper": false, "runs": runs, "lines": 2, "bg": "#ffffff" }),
        ),
        extra,
    )
}

fn input() -> PptxInput {
    let els = json!([
        text(
            "title",
            60.0,
            vec![
                run("Fett und ", json!({ "bold": true })),
                run(
                    "kursiv mit Link",
                    json!({ "italic": true, "underline": true, "link": "https://example.org/?a=1&b=2", "color": "#c03" })
                )
            ],
            json!({ "font": "head", "sizePx": 48 })
        ),
        text(
            "escape",
            200.0,
            vec![run("Achtung <&\" Zeichen", json!({}))],
            json!({})
        ),
        text(
            "list",
            300.0,
            vec![
                run("Erster Punkt", json!({ "breakAfter": true })),
                run("Zweiter Punkt", json!({ "breakAfter": true })),
                run("Dritter Punkt mit Folienlink", json!({ "link": "#2" })),
            ],
            json!({ "list": { "type": "number", "indentPx": 32 } })
        ),
        text(
            "deadlink",
            440.0,
            vec![run("toter Link", json!({ "link": "#9" }))],
            json!({ "align": "center" })
        ),
        merge(
            base("panel", 1000.0, 60.0, 220.0, 160.0),
            json!({ "kind": "box", "radius": 12, "ellipse": false,
            "fill": { "color": "#ff0000", "alpha": 1 },
            "gradient": { "angle": 180, "stops": [{ "color": "#0b3d91", "alpha": 1, "pos": 0 }, { "color": "#ffffff", "alpha": 0.5, "pos": 1 }] },
            "shadow": { "color": "#000", "alpha": 0.3, "blur": 12, "offsetY": 4 },
            "border": { "color": "#333333", "width": 2 }, "dash": "dash" })
        ),
        merge(
            base("panel", 1000.0, 260.0, 220.0, 0.0),
            json!({ "kind": "box", "radius": 0, "ellipse": false, "shape": "line", "border": { "color": "#333", "width": 2 }, "lineEnd": "arrow" })
        ),
        merge(
            base("photo", 1000.0, 300.0, 200.0, 200.0),
            json!({ "kind": "img", "src": "asset:///bilder/foto.png", "radius": 0, "fit": "cover", "focus": { "x": 0.5, "y": 0.5 } })
        ),
        merge(
            base("table", 80.0, 520.0, 600.0, 150.0),
            json!({ "kind": "table", "cells": [["Name", "Wert"], ["Umsatz", "1,2 Mio."], ["Kosten & Co", "0,8 Mio."]],
            "colW": [400, 200], "rowH": [50, 50, 50], "sizePx": 20, "font": "body", "color": "#111111", "line": "#cccccc", "align": ["left", "right"] })
        ),
    ]);
    let measured = |els: serde_json::Value| -> Measured {
        serde_json::from_value(
            json!({ "els": els, "fit": { "ok": true, "head": 0, "body": 0, "overflow": [] } }),
        )
        .unwrap()
    };
    PptxInput {
        title: "Spike <Test> & Co".into(),
        author: "Deckwerk".into(),
        size: Size {
            w: 1280.0,
            h: 720.0,
        },
        head_font: "Arimo".into(),
        body_font: "Carlito".into(),
        media: HashMap::from([("asset:///bilder/foto.png".to_string(), png(400, 200))]),
        slides: vec![
            PptxSlide {
                measured: measured(els),
                background_png: Some(png(64, 36)),
                notes: Some("Sprechernotiz <eins>\nZeile zwei".into()),
                hidden: false,
                morph: true,
            },
            PptxSlide {
                measured: measured(json!([
                    text(
                        "title",
                        60.0,
                        vec![run("Zweite Folie", json!({}))],
                        json!({})
                    ),
                    text(
                        "tiny",
                        200.0,
                        vec![run("winzig", json!({ "link": "#+2" }))],
                        json!({ "sizePx": 0.5 })
                    ),
                    merge(
                        base("one", 100.0, 400.0, 100.0, 100.0),
                        json!({ "kind": "box", "radius": 0, "ellipse": false,
                        "gradient": { "angle": 90, "stops": [{ "color": "#00ff00", "alpha": 1, "pos": 0 }] } })
                    ),
                    merge(
                        base("none", 300.0, 400.0, 100.0, 100.0),
                        json!({ "kind": "box", "radius": 0, "ellipse": false,
                        "fill": { "color": "#ff0000", "alpha": 1 }, "gradient": { "angle": 90, "stops": [] } })
                    ),
                ])),
                background_png: None,
                notes: None,
                hidden: true,
                morph: false,
            },
        ],
    }
}

fn unpack(bytes: &[u8], dir: &std::path::Path) -> Vec<(String, String)> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut xmls = vec![];
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut buf = vec![];
        f.read_to_end(&mut buf).unwrap();
        let path = dir.join(&name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &buf).unwrap();
        if name.ends_with(".xml") || name.ends_with(".rels") {
            xmls.push((name, String::from_utf8(buf).unwrap()));
        }
    }
    xmls
}

#[test]
fn package_is_wellformed() {
    let dir = out_dir("wellformed");
    let bytes = build_pptx(&input()).unwrap();
    std::fs::write(dir.join("spike.pptx"), &bytes).unwrap();
    let xmls = unpack(&bytes, &dir.join("x"));
    for (name, _) in &xmls {
        let st = Command::new("xmllint")
            .arg("--noout")
            .arg(dir.join("x").join(name))
            .status()
            .unwrap();
        assert!(st.success(), "xmllint: {name}");
    }
    let get = |n: &str| {
        xmls.iter()
            .find(|(p, _)| p == n)
            .map(|(_, s)| s.as_str())
            .unwrap_or_else(|| panic!("{n} fehlt"))
    };
    let s1 = get("ppt/slides/slide1.xml");
    let ct = get("[Content_Types].xml");
    assert!(
        ct.contains("/ppt/slides/slide2.xml")
            && ct.contains("/ppt/notesSlides/notesSlide1.xml")
            && ct.contains(r#"Extension="png""#)
    );
    assert!(get("ppt/presentation.xml").contains(r#"<p:sldSz cx="12192000" cy="6858000"/>"#));
    let s2 = get("ppt/slides/slide2.xml");
    assert!(s2.contains(r#"show="0""#));
    // Verlauf mit < 2 Stops: Vollton bzw. ohne Füllung; sz ≥ 100; „#+2“ ist kein Folienlink
    assert!(!s2.contains("gradFill"));
    let shape = |n: &str| {
        s2.split(&format!(r#"name="dw:{n}""#))
            .nth(1)
            .unwrap()
            .split("</p:sp>")
            .next()
            .unwrap()
            .to_string()
    };
    assert!(shape("one").contains(r#"<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>"#));
    assert!(shape("none").contains("<a:noFill/>") && !shape("none").contains("FF0000"));
    for sz in s1.split(" sz=\"").skip(1).chain(s2.split(" sz=\"").skip(1)) {
        let v: i64 = sz.split('"').next().unwrap().parse().unwrap();
        assert!(v >= 100, "sz {v} < 100");
    }
    assert!(!s2.contains("hlinkClick"));
    for g in s1.split("<a:gsLst>").skip(1) {
        assert!(
            g.split("</a:gsLst>")
                .next()
                .unwrap()
                .matches("<a:gs ")
                .count()
                >= 2
        );
    }
    // Hintergrund als p:bg vor dem spTree, nicht als Bild
    assert!(s1.contains(
        r#"<p:cSld><p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="#
    ));
    assert!(!s1.contains("Hintergrund") && !s2.contains("<p:bg>"));
    assert!(get("docProps/core.xml").contains("Spike &lt;Test&gt; &amp; Co"));
    // Namen: Morph-Präfix, Doppelte, IDs eindeutig
    assert!(s1.contains(r#"name="!!dw:title""#) && s1.contains(r#"name="!!dw:panel#2""#));
    let ids: Vec<&str> = s1
        .split("<p:cNvPr id=\"")
        .skip(1)
        .map(|s| s.split('"').next().unwrap())
        .collect();
    let uniq: std::collections::HashSet<_> = ids.iter().collect();
    assert_eq!(ids.len(), uniq.len(), "cNvPr-IDs doppelt: {ids:?}");
    // Text
    assert!(
        s1.contains(r#"<a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t""#)
    );
    assert!(
        s1.contains(r#"lang="de-DE""#)
            && s1.contains(r#"<a:spcPts val="2700"/>"#)
            && s1.contains(r#"spc="-38""#)
    );
    assert_eq!(
        s1.matches("startAt=").count(),
        1,
        "startAt nur am ersten Absatz"
    );
    assert!(s1.contains("ppaction://hlinksldjump"));
    assert_eq!(
        s1.matches("hlinkClick").count(),
        2,
        "#9 darf keinen Link erzeugen"
    );
    let rels = get("ppt/slides/_rels/slide1.xml.rels");
    assert!(
        rels.contains("https://example.org/?a=1&amp;b=2")
            && rels.contains(r#"TargetMode="External""#)
            && rels.contains(r#"Target="slide2.xml""#)
    );
    // Box: genau eine Füllung, Verlauf CSS 180° → 90°
    let panel = s1
        .split(r#"name="!!dw:panel""#)
        .nth(1)
        .unwrap()
        .split("</p:sp>")
        .next()
        .unwrap();
    assert!(
        panel.contains(r#"<a:lin ang="5400000" scaled="0"/>"#)
            && !panel.contains("<a:solidFill><a:srgbClr val=\"FF0000\"")
    );
    assert!(
        panel.contains("outerShdw")
            && panel.contains(r#"<a:prstDash val="dash"/>"#)
            && panel.contains("roundRect")
    );
    // Bild: cover 400×200 in 200×200 → links/rechts je 25 %, Alt-Text nie der Pfad
    assert!(s1.contains(r#"<a:srcRect l="25000" t="0" r="25000" b="0"/>"#));
    assert!(!s1.contains("foto.png") && !s1.contains("bilder"));
    // Tabelle
    assert!(
        s1.contains(r#"<a:gridCol w="3810000"/>"#)
            && s1.contains(r#"<a:tr h="476250">"#)
            && s1.contains(r#"marL="76200""#)
    );
    assert!(s1.contains(r#"<a:lnB w="19050">"#) && s1.contains(r#"<a:lnB w="9525">"#));
    assert!(get("ppt/notesSlides/notesSlide1.xml").contains("Sprechernotiz &lt;eins&gt;"));
}

#[test]
fn user_text_is_escaped() {
    let bytes = build_pptx(&input()).unwrap();
    let xmls = unpack(&bytes, &out_dir("escape"));
    let s1 = &xmls
        .iter()
        .find(|(p, _)| p == "ppt/slides/slide1.xml")
        .unwrap()
        .1;
    assert!(s1.contains("Achtung &lt;&amp;"), "Text nicht escaped");
    assert!(!s1.contains("<&"));
    assert!(s1.contains("Kosten &amp; Co"));
}

#[test]
fn bad_color_is_rejected() {
    let mut inp = input();
    if let dw_model::El::Text(t) = &mut inp.slides[1].measured.els[0] {
        t.runs[0].color = r#"000"/><evil/>"#.into();
    }
    assert!(matches!(build_pptx(&inp), Err(dw_pptx::Error::Color(_))));
}

#[test]
#[ignore = "LibreOffice, langsam"]
fn libreoffice_renders_texts() {
    let dir = out_dir("soffice");
    let file = dir.join("spike.pptx");
    std::fs::write(&file, build_pptx(&input()).unwrap()).unwrap();
    let soffice = std::env::var("HOME")
        .map(|h| format!("{h}/.local/bin/soffice"))
        .unwrap();
    let st = Command::new(soffice)
        .args(["--headless", "--convert-to", "pdf", "--outdir"])
        .arg(&dir)
        .arg(&file)
        .status()
        .unwrap();
    assert!(st.success());
    let out = Command::new("pdftotext")
        .arg(dir.join("spike.pdf"))
        .arg("-")
        .output()
        .unwrap();
    let txt = String::from_utf8_lossy(&out.stdout);
    for t in [
        "Fett und",
        "kursiv mit Link",
        "Achtung <&\" Zeichen",
        "Erster Punkt",
        "Umsatz",
        "1,2 Mio.",
        "Kosten & Co",
    ] {
        assert!(txt.contains(t), "{t:?} fehlt im PDF:\n{txt}");
    }
}
