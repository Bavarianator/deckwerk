// cargo test -j2 -p dw-pptx --test diff  (Fixtures neu: node crates/dw-pptx/tests/gen/gen.mjs)
// Differenztests gegen die TS-Quelle: dieselbe Eingabe wie in tests/fixtures, XML normalisiert verglichen
// (Attribute sortiert, ohne xmlns, ohne Leerraum-Text), EOT bytegleich, Diagramme über ihre fachlichen Werte.
use std::collections::{BTreeMap, HashMap};
use std::io::{Cursor, Read};
use std::path::PathBuf;

use dw_model::{ChartSpec, Deck, Measured, Size};
use dw_pptx::anim::{self, AnimStep, Kind, ShapeInfo, Trigger};
use dw_pptx::{Palette, PptxInput, PptxOpts, PptxSlide, SlideOpts, build_pptx_with};
use quick_xml::Reader;
use quick_xml::events::Event;
use serde_json::{Value, json};

fn fixture(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap()
}

/// Ereignisliste mit sortierten Attributen, ohne xmlns und Leerraum-Text; Fragmente mit mehreren Wurzeln erlaubt.
fn canon(xml: &str) -> Vec<String> {
    let mut r = Reader::from_str(xml);
    let mut out = vec![];
    loop {
        match r.read_event().unwrap() {
            Event::Start(e) => out.push(tag(&e)),
            Event::Empty(e) => {
                out.push(tag(&e));
                out.push(format!("</{}>", e.name().0));
            }
            Event::End(e) => out.push(format!("</{}>", e.name().0)),
            Event::Text(t) => {
                let s = t.xml10_content().trim().to_string();
                if !s.is_empty() {
                    out.push(s);
                }
            }
            Event::GeneralRef(g) => out.push(format!("&{};", g.xml10_content())),
            Event::Eof => break,
            _ => {}
        }
    }
    out
}

#[allow(deprecated)] // unescape_value reicht für Vergleiche
fn attrs(e: &quick_xml::events::BytesStart) -> Vec<(String, String)> {
    let mut a: Vec<(String, String)> = e
        .attributes()
        .map(|a| {
            let a = a.unwrap();
            (
                a.key.0.to_string(),
                a.unescape_value().unwrap().to_string(),
            )
        })
        .filter(|(k, _)| !k.starts_with("xmlns"))
        .collect();
    a.sort();
    a
}

fn tag(e: &quick_xml::events::BytesStart) -> String {
    let a: String = attrs(e).iter().map(|(k, v)| format!(" {k}={v:?}")).collect();
    format!("<{}{a}>", e.name().0)
}

fn same(rust: &str, ts: &str, what: &str) {
    let (r, t) = (canon(rust), canon(ts));
    if r != t {
        let k = r.iter().zip(&t).position(|(a, b)| a != b).unwrap_or(r.len().min(t.len()));
        panic!(
            "{what}: Abweichung bei Ereignis {k}\nRust: {:?}\nTS:   {:?}",
            &r[k.saturating_sub(3)..(k + 4).min(r.len())],
            &t[k.saturating_sub(3)..(k + 4).min(t.len())]
        );
    }
}

#[test]
fn transitions_match_ts() {
    let f = fixture("transitions.json");
    let cases = f.as_array().unwrap();
    for c in cases {
        let (t, speed) = (c["t"].as_str().unwrap(), c["speed"].as_str());
        // bewusste Abweichung: Morph mit p14:dur verlangt in Rust auch p14
        let ts = c["xml"].as_str().unwrap();
        let ts = if ts.contains("p14:dur") { ts.replace(r#"Requires="p159""#, r#"Requires="p159 p14""#) } else { ts.to_string() };
        same(&anim::transition_xml(t, speed), &ts, &format!("Übergang {t}/{speed:?}"));
    }
    assert_eq!(cases.len(), 39);
}

fn shapes_of(f: &Value) -> HashMap<String, ShapeInfo> {
    f["shapes"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let id = i as u32 + 2;
            let info = match s["kind"].as_str().unwrap() {
                "sp" => {
                    let paras: Vec<Vec<String>> = serde_json::from_value(s.get("paras").cloned().unwrap_or(json!([]))).unwrap();
                    ShapeInfo::text(id, s["txBox"].as_bool().unwrap_or(false), &paras)
                }
                "pic" => ShapeInfo::other(id, Kind::Pic, false),
                _ => ShapeInfo::other(id, Kind::Frame, s["chart"].as_bool().unwrap_or(false)),
            };
            (s["name"].as_str().unwrap().to_string(), info)
        })
        .collect()
}

#[test]
fn timing_matches_ts() {
    let f = fixture("timing.json");
    let shapes = shapes_of(&f);
    let groups: BTreeMap<u32, Vec<String>> = f["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| (g[0].as_u64().unwrap() as u32, serde_json::from_value(g[1].clone()).unwrap()))
        .collect();
    let items = f["items"].as_array().unwrap();
    let mut n = 0;
    for c in f["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        // Presets und Element-Animationen rechnet Rust selbst aus der Eingabe, sonst die Schritte der Fixture
        let steps: Vec<AnimStep> = if let Some(rest) = name.strip_prefix("preset-") {
            let (preset, mode) = rest.rsplit_once('-').unwrap();
            anim::steps_for(preset, &groups, mode == "auto")
        } else if name.starts_with("item-") {
            let it = &items[n];
            n += 1;
            let auto = it["mode"] == "auto";
            let st = anim::item_step(
                it["shape"].as_str().unwrap(),
                it["anim"].as_str().unwrap(),
                it["dir"].as_str(),
                it["speed"].as_str(),
                anim::start_of(it["start"].as_str(), auto),
                it["delay"].as_f64().unwrap(),
            )
            .unwrap();
            if it["anim"] == "breathe" {
                vec![AnimStep { trigger: Trigger::With, delay_ms: Some(0), ..st }]
            } else {
                vec![st]
            }
        } else {
            serde_json::from_value(c["steps"].clone()).unwrap()
        };
        let mut warns = vec![];
        let xml = anim::transition_xml(c["transition"].as_str().unwrap_or("none"), c["speed"].as_str())
            + &anim::timing_xml(&shapes, &steps, &mut |w| warns.push(w));
        let ts = c["xml"].as_str().unwrap();
        let ts = if ts.contains("p14:dur") { ts.replace(r#"Requires="p159""#, r#"Requires="p159 p14""#) } else { ts.to_string() };
        same(&xml, &ts, name);
        if name == "paragraphs" {
            assert_eq!(warns.len(), 3, "{warns:?}");
        }
    }
    assert_eq!(n, items.len());
}

fn measured(els: Value) -> Measured {
    serde_json::from_value(json!({ "els": els, "fit": { "ok": true, "head": 0, "body": 0, "overflow": [] } })).unwrap()
}

fn png() -> Vec<u8> {
    let mut buf = Cursor::new(Vec::new());
    image::RgbImage::from_pixel(4, 4, image::Rgb([1, 2, 3]))
        .write_to(&mut buf, image::ImageFormat::Png)
        .unwrap();
    buf.into_inner()
}

fn input(slides: Vec<Value>) -> PptxInput {
    PptxInput {
        title: "Diff".into(),
        author: "Deckwerk".into(),
        size: Size { w: 1280.0, h: 720.0 },
        head_font: "Arimo".into(),
        body_font: "Carlito".into(),
        media: HashMap::from([("bild.png".to_string(), png())]),
        slides: slides
            .into_iter()
            .map(|els| PptxSlide { measured: measured(els), background_png: None, notes: None, hidden: false, morph: false })
            .collect(),
    }
}

fn part(bytes: &[u8], name: &str) -> String {
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}

fn img(slot: &str, extra: Value) -> Value {
    let mut v = json!({ "kind": "img", "slot": slot, "box": { "x": 0, "y": 0, "w": 100, "h": 100 }, "src": "bild.png", "radius": 0, "fit": "cover", "focus": { "x": 0.5, "y": 0.5 } });
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    v
}

// Abschnitt zwischen `start` (inklusive Tag-Ende) und `end`, je Vorkommen
fn between<'a>(s: &'a str, start: &str, end: &str) -> Vec<&'a str> {
    s.split(start).skip(1).map(|p| &p[..p.find(end).unwrap()]).collect()
}

#[test]
fn blip_adjust_and_recolor_match_ts() {
    let f = fixture("blip.json");
    let d = f["duotone"].as_array().unwrap();
    let cases = f["cases"].as_array().unwrap();
    let els: Vec<Value> = cases
        .iter()
        .enumerate()
        .map(|(i, c)| img(&format!("i{i}"), json!({ "adjust": c["adjust"], "look": c["look"] })))
        .collect();
    let opts = PptxOpts {
        palette: Palette { duotone: (d[0].as_str().unwrap().into(), d[1].as_str().unwrap().into()), ..Palette::default() },
        ..Default::default()
    };
    let out = build_pptx_with(&input(vec![json!(els)]), &opts).unwrap();
    let s = part(&out.bytes, "ppt/slides/slide1.xml");
    let blips: Vec<String> = s
        .split("<a:blip r:embed=\"")
        .skip(1)
        .map(|p| {
            let p = &p[p.find('"').unwrap() + 1..];
            if p.starts_with("/>") { String::new() } else { p[1..p.find("</a:blip>").unwrap()].to_string() }
        })
        .collect();
    assert_eq!(blips.len(), cases.len());
    for (c, b) in cases.iter().zip(&blips) {
        same(b, c["kids"].as_str().unwrap(), &format!("Blip {c}"));
    }
}

#[test]
fn masks_match_ts() {
    let f = fixture("masks.json");
    let cases = f.as_array().unwrap();
    let els: Vec<Value> = cases.iter().map(|c| img("m", json!({ "mask": c["mask"] }))).collect();
    let out = build_pptx_with(&input(vec![json!(els)]), &PptxOpts::default()).unwrap();
    let s = part(&out.bytes, "ppt/slides/slide1.xml");
    let geoms: Vec<&str> = s.split("<p:pic>").skip(1).map(|p| between(p, "</a:xfrm>", "</p:spPr>")[0]).collect();
    assert_eq!(geoms.len(), cases.len());
    for (c, g) in cases.iter().zip(geoms) {
        same(g, c["geom"].as_str().unwrap(), &format!("Maske {}", c["mask"]));
    }
}

#[test]
fn text_effects_match_ts() {
    let f = fixture("effects.json");
    let cases = f.as_array().unwrap();
    let els: Vec<Value> = cases
        .iter()
        .map(|c| json!({ "kind": "text", "slot": "t", "box": { "x": 0, "y": 0, "w": 500, "h": 100 }, "font": "body", "role": "body",
            "sizePx": c["sizePx"], "effect": { "type": c["type"], "color": c["color"] }, "lineHeightPx": 30, "trackingPx": 0, "align": "left",
            "upper": false, "runs": [{ "text": "x", "bold": false, "italic": false, "color": "#112233" }], "lines": 1, "bg": "#fff" }))
        .collect();
    let out = build_pptx_with(&input(vec![json!(els)]), &PptxOpts::default()).unwrap();
    let s = part(&out.bytes, "ppt/slides/slide1.xml");
    let rprs: Vec<&str> = s.split("<a:rPr ").skip(1).map(|p| &p[p.find('>').unwrap() + 1..p.find("<a:latin").unwrap()]).collect();
    assert_eq!(rprs.len(), cases.len());
    for (c, r) in cases.iter().zip(rprs) {
        same(r, c["rpr"].as_str().unwrap(), &format!("Effekt {} {}", c["type"], c["sizePx"]));
    }
}

#[test]
fn sections_and_agenda_match_ts() {
    for c in fixture("sections.json").as_array().unwrap() {
        let deck: Deck = serde_json::from_value(c["deck"].clone()).unwrap();
        let agenda = dw_pptx::agenda_links(&deck);
        let sparse: Vec<Value> = agenda
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.is_empty())
            .map(|(i, l)| json!([i, l.iter().map(|(k, to)| json!([k, to])).collect::<Vec<_>>()]))
            .collect();
        assert_eq!(json!(sparse), c["agenda"], "Agenda-Links");
        let n = deck.slides.len();
        let opts = PptxOpts {
            slides: dw_pptx::sections(&deck).into_iter().map(|section| SlideOpts { section, ..Default::default() }).collect(),
            ..Default::default()
        };
        let out = build_pptx_with(&input(vec![json!([]); n]), &opts).unwrap();
        let p = part(&out.bytes, "ppt/presentation.xml");
        let ext = p.find("<p:extLst>").map(|k| &p[k..p.find("</p:presentation>").unwrap()]).unwrap_or("");
        let guid = regex_free_guid(ext);
        same(&guid, c["sections"].as_str().unwrap(), "Abschnitte");
    }
}

// id="{…}" → id="{GUID}" wie in der Fixture (TS würfelt die GUIDs)
fn regex_free_guid(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(k) = rest.find("id=\"{") {
        out += &rest[..k + 5];
        let e = rest[k..].find('}').unwrap() + k;
        out += "GUID";
        rest = &rest[e..];
    }
    out + rest
}

/// Fachliche Werte eines Diagramms: Pfad (ser/dPt/dLbl gezählt) + ausgewählte Attribute bzw. Text, sortiert.
/// Unterschiede in Hilfselementen (effectLst, dritte axId, multiLvlStrRef statt strRef) zählen nicht.
fn signature(xml: &str) -> Vec<String> {
    const KEEP: &[(&str, &[&str])] = &[
        ("barDir", &["val"]), ("grouping", &["val"]), ("gapWidth", &["val"]), ("overlap", &["val"]), ("holeSize", &["val"]),
        ("firstSliceAng", &["val"]), ("orientation", &["val"]), ("tickLblPos", &["val"]), ("delete", &["val"]), ("axPos", &["val"]),
        ("legendPos", &["val"]), ("dLblPos", &["val"]), ("showVal", &["val"]), ("showSerName", &["val"]), ("symbol", &["val"]),
        ("size", &["val"]), ("smooth", &["val"]), ("idx", &["val"]), ("numFmt", &["formatCode"]), ("srgbClr", &["val"]),
        ("ln", &["w"]), ("latin", &["typeface"]), ("defRPr", &["sz", "b"]), ("x", &["val"]), ("y", &["val"]), ("w", &["val"]),
        ("h", &["val"]), ("noFill", &[]),
    ];
    let mut r = Reader::from_str(xml);
    let mut path: Vec<String> = vec![];
    let mut counts: Vec<HashMap<String, usize>> = vec![HashMap::new()];
    let mut out = vec![];
    let local = |n: &str| n.rsplit(':').next().unwrap().to_string();
    let open = |e: &quick_xml::events::BytesStart, path: &mut Vec<String>, counts: &mut Vec<HashMap<String, usize>>, out: &mut Vec<String>| {
        let n = local(e.name().0);
        let seg = match n.as_str() {
            "ser" | "dPt" | "dLbl" => {
                let c = counts.last_mut().unwrap().entry(n.clone()).or_default();
                *c += 1;
                format!("{n}#{c}")
            }
            "multiLvlStrRef" => "strRef".into(),
            "multiLvlStrCache" => "strCache".into(),
            _ => n.clone(),
        };
        if n != "lvl" {
            path.push(seg);
        } else {
            path.push(String::new());
        }
        counts.push(HashMap::new());
        if let Some((_, keys)) = KEEP.iter().find(|(k, _)| *k == n) {
            let a = attrs(e);
            let mut v: Vec<String> = keys
                .iter()
                .map(|k| {
                    let val = a.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str());
                    // fehlendes b = nicht fett
                    format!("{k}={}", val.unwrap_or(if *k == "b" { "0" } else { "" }))
                })
                .collect();
            v.sort();
            out.push(format!("{} {}", path.iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("/"), v.join(" ")));
        }
    };
    loop {
        match r.read_event().unwrap() {
            Event::Start(e) => open(&e, &mut path, &mut counts, &mut out),
            Event::Empty(e) => {
                open(&e, &mut path, &mut counts, &mut out);
                path.pop();
                counts.pop();
            }
            Event::End(_) => {
                path.pop();
                counts.pop();
            }
            Event::Text(t) => {
                let s = t.xml10_content().trim().to_string();
                if !s.is_empty() && path.last().is_some_and(|p| p == "v") {
                    out.push(format!("{} = {s}", path.iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("/")));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    // Diagramm-weite dLbls (von den Serien überschrieben) und die Donut-Beschriftungen (alle aus) schreibt Rust knapper;
    // lineChart/grouping verlangt das Schema, pptxgenjs lässt es weg
    out.retain(|l| {
        !["Chart/dLbls/", "doughnutChart/ser#1/dLbls", "doughnutChart/ser#1/spPr", "lineChart/grouping"]
            .iter()
            .any(|k| l.contains(k))
    });
    out.sort();
    out
}

#[test]
fn charts_match_ts() {
    let cases = fixture("charts.json");
    for c in cases.as_array().unwrap() {
        let spec: ChartSpec = serde_json::from_value(c["spec"].clone()).unwrap();
        let p = &c["palette"];
        let s = |k: &str| p[k].as_str().unwrap().to_string();
        let palette = Palette {
            bg: s("bg"), text: s("text"), muted: s("muted"), border: s("border"), good: s("good"), bad: s("bad"),
            chart: serde_json::from_value(p["chart"].clone()).unwrap(),
            duotone: (p["duotone"][0].as_str().unwrap().into(), p["duotone"][1].as_str().unwrap().into()),
        };
        let what = format!("{} {:?} {:?}", c["theme"], spec.kind, spec.highlight);
        let (per, pts) = dw_pptx::chart::chart_colors(&spec, &palette);
        let low = |v: &[String]| v.iter().map(|x| x.to_lowercase()).collect::<Vec<_>>();
        let ts_per: Vec<String> = serde_json::from_value(c["colors"]["perSeries"].clone()).unwrap();
        let ts_pts: Option<Vec<String>> = serde_json::from_value(c["colors"]["perPoint"].clone()).unwrap_or(None);
        assert_eq!(low(&per), low(&ts_per), "Farben {what}");
        assert_eq!(pts.map(|p| low(&p)), ts_pts.map(|p| low(&p)), "Punktfarben {what}");

        let rust = String::from_utf8(dw_pptx::chart::chart_xml(&spec, &palette, c["font"].as_str().unwrap()).unwrap()).unwrap();
        let (r, t) = (signature(&rust), signature(c["xml"].as_str().unwrap()));
        let only_r: Vec<_> = r.iter().filter(|l| !t.contains(l)).collect();
        let only_t: Vec<_> = t.iter().filter(|l| !r.contains(l)).collect();
        assert!(only_r.is_empty() && only_t.is_empty(), "Diagramm {what}\nnur Rust: {only_r:#?}\nnur TS: {only_t:#?}");
        assert_eq!(r.len(), t.len(), "Diagramm {what}: Anzahl");
    }
}

#[test]
fn eot_is_bytewise_equal() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let ttf = std::fs::read(root.join("assets/fonts/DMSans-Regular.ttf")).unwrap();
    let eot = std::fs::read(root.join("crates/dw-pptx/tests/fixtures/DMSans-Regular.eot")).unwrap();
    assert_eq!(dw_pptx::fonts::fs_type(&ttf).unwrap() & 2, 0, "Fixture-Schrift darf nicht restricted sein");
    assert!(dw_pptx::fonts::ttf_to_eot(&ttf).unwrap() == eot, "EOT weicht ab");
    assert_eq!(dw_pptx::fonts::family_of(&ttf).unwrap(), "DM Sans");
}

#[test]
fn eot_masks_restricted_bit_in_mixed_fstype() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut ttf = std::fs::read(root.join("assets/fonts/DMSans-Regular.ttf")).unwrap();
    let n = u16::from_be_bytes([ttf[4], ttf[5]]) as usize;
    let os2 = (0..n).map(|i| 12 + i * 16).find(|&o| &ttf[o..o + 4] == b"OS/2").unwrap();
    let at = u32::from_be_bytes(ttf[os2 + 8..os2 + 12].try_into().unwrap()) as usize;
    ttf[at + 8..at + 10].copy_from_slice(&0x0006u16.to_be_bytes());
    assert_eq!(dw_pptx::fonts::fs_type(&ttf).unwrap(), 0x0006);
    let eot = dw_pptx::fonts::ttf_to_eot(&ttf).unwrap();
    // fsType steht im EOT-Header an Byte 32 (little-endian)
    assert_eq!(u16::from_le_bytes([eot[32], eot[33]]), 0x0004);
}

#[test]
fn chart_without_series_is_skipped() {
    let els = json!([{ "kind": "chart", "slot": "c", "box": { "x": 0, "y": 0, "w": 100, "h": 100 },
        "spec": { "type": "bar", "categories": ["a"], "series": [] } },
        { "kind": "text", "slot": "t", "box": { "x": 0, "y": 0, "w": 500, "h": 100 }, "font": "body", "role": "body", "sizePx": 20,
          "lineHeightPx": 30, "trackingPx": 0, "align": "left", "upper": false, "lines": 1, "bg": "#fff",
          "runs": [{ "text": "a", "bold": false, "italic": false, "color": "#000", "link": "#9" }, { "text": "b", "bold": false, "italic": false, "color": "#000", "link": "#9" }] }]);
    let out = build_pptx_with(&input(vec![els]), &PptxOpts::default()).unwrap();
    let mut z = zip::ZipArchive::new(Cursor::new(&out.bytes)).unwrap();
    assert!(z.by_name("ppt/charts/chart1.xml").is_err());
    assert!(out.warnings.iter().any(|w| w.contains("ohne Datenreihe")), "{:?}", out.warnings);
    assert_eq!(out.warnings.iter().filter(|w| w.contains("ins Leere")).count(), 1, "{:?}", out.warnings);
}
