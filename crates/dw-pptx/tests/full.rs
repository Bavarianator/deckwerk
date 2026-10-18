// cargo test -j2 -p dw-pptx --test full [-- --ignored für den LibreOffice-Smoke]
// Voller Umfang in einer Datei: Diagramm, Icon (SVG), Medien, Bildmasken, Texteffekt, Animationen, Morph-Paar,
// Abschnitte, Agenda-Link, eingebettete Schrift. Ausgabe unter target/dw-pptx-test/ (nicht /tmp).
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::PathBuf;
use std::process::Command;

use base64::Engine;
use dw_model::{Measured, Size};
use dw_pptx::{EmbedFont, PptxInput, PptxOpts, PptxOutput, PptxSlide, SlideOpts, build_pptx_with};
use serde_json::{Value, json};

fn out_dir(name: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/dw-pptx-test").join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x * 255 / w) as u8, (y * 255 / h) as u8, 160]));
    let mut buf = Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
    buf.into_inner()
}

fn el(kind: &str, slot: &str, b: [f64; 4], extra: Value) -> Value {
    let mut v = json!({ "kind": kind, "slot": slot, "box": { "x": b[0], "y": b[1], "w": b[2], "h": b[3] } });
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    v
}

fn text(slot: &str, b: [f64; 4], t: &str, extra: Value) -> Value {
    let mut v = el("text", slot, b, json!({ "font": "head", "role": "title", "sizePx": 40, "lineHeightPx": 48, "trackingPx": 0,
        "align": "left", "upper": false, "runs": [{ "text": t, "bold": true, "italic": false, "color": "#1a1a1a" }], "lines": 1, "bg": "#ffffff" }));
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    v
}

fn measured(els: Vec<Value>) -> Measured {
    serde_json::from_value(json!({ "els": els, "fit": { "ok": true, "head": 0, "body": 0, "overflow": [] } })).unwrap()
}

fn font() -> Vec<u8> {
    std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/fonts/DMSans-Regular.ttf")).unwrap()
}

// fsType im OS/2-Eintrag auf „restricted“ setzen
fn restricted(mut ttf: Vec<u8>) -> Vec<u8> {
    let n = u16::from_be_bytes([ttf[4], ttf[5]]) as usize;
    for i in 0..n {
        let o = 12 + i * 16;
        if &ttf[o..o + 4] == b"OS/2" {
            let at = u32::from_be_bytes(ttf[o + 8..o + 12].try_into().unwrap()) as usize;
            ttf[at + 8..at + 10].copy_from_slice(&2u16.to_be_bytes());
        }
    }
    ttf
}

fn build() -> PptxOutput {
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#c03a2b"/></svg>"##;
    let icon_png = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png(96, 96)));
    let chart = |slot: &str, kind: &str, b| {
        el("chart", slot, b, json!({ "build": 1, "spec": { "type": kind, "categories": ["Nord", "Süd", "West"],
            "series": [{ "name": "Umsatz", "values": [12, 15.5, -3] }, { "name": "Kosten", "values": [8, 9, 4] }] } }))
    };
    let s1 = vec![
        text("title", [80.0, 40.0, 800.0, 60.0], "Hallo Morph", json!({ "build": 0 })),
        text("items.0.title", [80.0, 120.0, 500.0, 40.0], "Der Markt", json!({ "sizePx": 24, "font": "body", "fontFace": "DM Sans" })),
        text("effekt", [80.0, 170.0, 500.0, 60.0], "Leuchtschrift", json!({ "effect": { "type": "neon", "color": "#ff9900" } })),
        chart("chart", "bar", [640.0, 120.0, 560.0, 300.0]),
        el("icon", "items.ico", [80.0, 260.0, 64.0, 64.0], json!({ "svg": svg, "png": icon_png, "anim": "tumble" })),
        el("img", "photo", [160.0, 260.0, 200.0, 200.0], json!({ "src": "foto.png", "radius": 0, "fit": "cover", "focus": { "x": 0.5, "y": 0.5 },
            "mask": "circle", "look": "duotone", "adjust": { "bright": 10, "blur": 20 }, "alt": "Ein Foto" })),
        el("media", "items.vid", [400.0, 460.0, 320.0, 180.0], json!({ "media": "video", "src": "clip.mp4", "poster": "foto.png" })),
        el("media", "items.weg", [760.0, 460.0, 320.0, 180.0], json!({ "media": "audio", "src": "fehlt.mp3" })),
    ];
    let s2 = vec![
        text("headline", [80.0, 300.0, 800.0, 60.0], "Hallo Morph", json!({ "anim": "fade" })),
        text("neu", [80.0, 400.0, 800.0, 60.0], "Neu auf Folie zwei", json!({ "build": 0 })),
    ];
    let s3 = vec![chart("line", "line", [80.0, 80.0, 1000.0, 500.0]), text("t", [80.0, 600.0, 800.0, 60.0], "Kapitel Markt", json!({}))];
    let slides: Vec<PptxSlide> = [s1, s2, s3]
        .into_iter()
        .map(|els| PptxSlide { measured: measured(els), background_png: Some(png(64, 36)), notes: None, hidden: false, morph: false })
        .collect();
    let input = PptxInput {
        title: "Voller Umfang".into(),
        author: "Deckwerk".into(),
        size: Size { w: 1280.0, h: 720.0 },
        head_font: "DM Sans".into(),
        body_font: "Carlito".into(),
        media: HashMap::from([
            ("foto.png".to_string(), png(300, 200)),
            ("clip.mp4".to_string(), b"\0\0\0\x18ftypmp42 kein echtes Video".to_vec()),
        ]),
        slides,
    };
    let opts = PptxOpts {
        auto: false,
        fonts: vec![
            EmbedFont { family: "DM Sans".into(), regular: font(), ..Default::default() },
            EmbedFont { family: "Gesperrt".into(), regular: restricted(font()), ..Default::default() },
        ],
        slides: vec![
            SlideOpts {
                build: Some("stagger".into()),
                items: HashMap::from([("items.ico".to_string(), (Some("after".to_string()), 0.5))]),
                section: Some("Einstieg mit Agenda".into()),
                agenda: vec![(0, 2)],
                ..Default::default()
            },
            SlideOpts { transition: Some("morph".into()), build: Some("fade".into()), ..Default::default() },
            SlideOpts {
                transition: Some("fade".into()),
                transition_speed: Some("slow".into()),
                section: Some("01 Markt".into()),
                build: Some("fade".into()),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    build_pptx_with(&input, &opts).unwrap()
}

fn unpack(bytes: &[u8], dir: &std::path::Path) -> HashMap<String, Vec<u8>> {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut files = HashMap::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = f.name().unwrap().to_string();
        let mut buf = vec![];
        f.read_to_end(&mut buf).unwrap();
        let path = dir.join(&name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &buf).unwrap();
        files.insert(name, buf);
    }
    files
}

fn xmllint(dir: &std::path::Path, files: &HashMap<String, Vec<u8>>) {
    for name in files.keys().filter(|n| n.ends_with(".xml") || n.ends_with(".rels")) {
        let st = Command::new("xmllint").arg("--noout").arg(dir.join(name)).status().unwrap();
        assert!(st.success(), "xmllint: {name}");
    }
}

#[test]
fn full_package() {
    let dir = out_dir("full");
    let out = build();
    std::fs::write(dir.join("voll.pptx"), &out.bytes).unwrap();
    let files = unpack(&out.bytes, &dir.join("x"));
    xmllint(&dir.join("x"), &files);
    let get = |n: &str| String::from_utf8(files.get(n).unwrap_or_else(|| panic!("{n} fehlt")).clone()).unwrap();

    // eingebettete xlsx ist selbst ein gültiges Paket
    let book = files.get("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx").expect("xlsx fehlt");
    let bdir = dir.join("xlsx");
    let bfiles = unpack(book, &bdir);
    xmllint(&bdir, &bfiles);
    let sheet = String::from_utf8(bfiles["xl/worksheets/sheet1.xml"].clone()).unwrap();
    assert!(sheet.contains("<t>Süd</t>") && sheet.contains("<v>15.5</v>") && sheet.contains("<v>-3</v>"));

    let ct = get("[Content_Types].xml");
    for want in ["Extension=\"fntdata\"", "Extension=\"xlsx\"", "Extension=\"svg\"", "Extension=\"mp4\"", "/ppt/charts/chart2.xml", "drawingml.chart+xml"] {
        assert!(ct.contains(want), "Content-Types ohne {want}");
    }
    let pres = get("ppt/presentation.xml");
    assert!(pres.contains(r#"embedTrueTypeFonts="1""#));
    let notes_sz = pres.find("<p:notesSz").unwrap();
    let fonts = pres.find("<p:embeddedFontLst>").unwrap();
    let ext = pres.find("<p:extLst>").unwrap();
    assert!(notes_sz < fonts && fonts < ext, "Reihenfolge notesSz < embeddedFontLst < extLst");
    assert!(pres.contains(r#"<p:font typeface="DM Sans" pitchFamily="34" charset="0"/>"#));
    assert!(!pres.contains("Gesperrt"), "restricted-Schrift darf nicht eingebettet werden");
    assert_eq!(pres.matches("<p14:section ").count(), 2);
    assert!(pres.contains(r#"name="01 Markt""#));
    assert!(files.contains_key("ppt/fonts/font1.fntdata") && !files.contains_key("ppt/fonts/font2.fntdata"));
    assert!(get("ppt/_rels/presentation.xml.rels").contains("relationships/font"));

    // Warnungen kommen zurück statt nur nach stderr
    assert!(out.warnings.iter().any(|w| w.contains("Gesperrt") && w.contains("restricted")), "{:?}", out.warnings);
    assert!(out.warnings.iter().any(|w| w.contains("items.weg") && w.contains("fehlt")), "{:?}", out.warnings);

    let s1 = get("ppt/slides/slide1.xml");
    let r1 = get("ppt/slides/_rels/slide1.xml.rels");
    // Agenda-Punkt → Kapitel (Folie 3); Folie 2 nutzt Morph, daher „!!dw:“ schon auf Folie 1
    let agenda = s1.split(r#"name="!!dw:items.0.title""#).nth(1).unwrap().split("</p:cNvPr>").next().unwrap();
    assert!(agenda.contains("ppaction://hlinksldjump") && r1.contains(r#"Target="slide3.xml""#));
    // Icon: PNG + SVG
    assert!(s1.contains("asvg:svgBlip") && r1.contains(".svg\""));
    // Medien mit Poster; fehlende Datei ohne leere Box
    assert!(s1.contains("<a:videoFile r:link=") && s1.contains("<p14:media") && r1.contains("relationships/video"));
    assert!(r1.contains("2007/relationships/media") && !s1.contains("items.weg"));
    // Bild: Maske, Duotone, Korrektur, Alt-Text
    let photo = s1.split(r#"name="!!dw:photo""#).nth(1).unwrap().split("</p:pic>").next().unwrap();
    assert!(photo.contains(r#"prst="ellipse""#) && photo.contains("<a:duotone>") && photo.contains("<a:blur ") && photo.contains("<a:lum "));
    assert!(s1.contains(r#"descr="Ein Foto""#));
    // Texteffekt, Diagrammrahmen
    assert!(s1.contains("<a:glow "));
    assert!(s1.contains(r#"<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="#));
    // Animation: Aufbau (stagger → float 42), Diagramm als bldGraphic, Purzeln → Zoom (53), Start „nach“ mit 0,5 s
    assert!(s1.contains(r#"presetID="42""#) && s1.contains("<p:bldGraphic ") && s1.contains(r#"presetID="53""#));
    assert!(s1.contains(r#"<p:cond delay="500"/>"#));
    assert!(!s1.contains("<p:transition"), "Folie 1 hat keinen Übergang");

    // Morph-Paar: gleicher Name auf beiden Folien, Folie 2 animiert das herübergewanderte Element nicht
    let s2 = get("ppt/slides/slide2.xml");
    assert!(s1.contains(r#"name="!!dw:title""#) && s2.contains(r#"name="!!dw:title""#));
    assert!(s2.contains(r#"<p159:morph option="byObject"/>"#) && s2.contains("<mc:Fallback>"));
    let id_of = |s: &str, name: &str| s.split(&format!(r#"name="{name}""#)).next().unwrap().rsplit("id=\"").next().unwrap().split('"').next().unwrap().to_string();
    let (moved, fresh) = (id_of(&s2, "!!dw:title"), id_of(&s2, "!!dw:neu"));
    assert!(!s2.contains(&format!(r#"spid="{moved}""#)), "herübergewandertes Element animiert");
    assert!(s2.contains(&format!(r#"spid="{fresh}""#)));
    // Folie 3: Übergang mit Tempo (p14:dur), Linie mit Namen am Ende
    let s3 = get("ppt/slides/slide3.xml");
    assert!(s3.contains(r#"p14:dur="800""#) && s3.contains("<p:fade/>"));
    let c2 = get("ppt/charts/chart2.xml");
    assert!(c2.contains("<c:lineChart>") && c2.contains(r#"<c:showSerName val="1"/>"#) && c2.contains("<c:manualLayout>"));
    let c1 = get("ppt/charts/chart1.xml");
    assert!(c1.contains(r#"<c:tickLblPos val="low"/>"#) && c1.contains(r#"<c:legendPos val="t"/>"#));
}

#[test]
#[ignore = "LibreOffice, langsam"]
fn libreoffice_renders_full() {
    let dir = out_dir("full-soffice");
    let file = dir.join("voll.pptx");
    std::fs::write(&file, build().bytes).unwrap();
    let soffice = std::env::var("HOME").map(|h| format!("{h}/.local/bin/soffice")).unwrap();
    let st = Command::new(soffice).args(["--headless", "--convert-to", "pdf", "--outdir"]).arg(&dir).arg(&file).status().unwrap();
    assert!(st.success());
    let pdf = dir.join("voll.pdf");
    let out = Command::new("pdftotext").arg(&pdf).arg("-").output().unwrap();
    let txt = String::from_utf8_lossy(&out.stdout);
    // Diagrammbeschriftungen (Kategorien, Werte, Legende) zeigen, dass LibreOffice das Diagramm liest
    for t in ["Hallo Morph", "Der Markt", "Leuchtschrift", "Nord", "Süd", "Umsatz", "15,5", "Neu auf Folie zwei", "Kosten"] {
        assert!(txt.contains(t), "{t:?} fehlt im PDF:\n{txt}");
    }
    let fonts = Command::new("pdffonts").arg(&pdf).output().unwrap();
    eprintln!("{}", String::from_utf8_lossy(&fonts.stdout));
}
