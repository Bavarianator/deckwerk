//! Differenztest gegen export-docx.ts: Fixture aus tests/gen/gen-docx.ts, dieselben Seiten in Rust, XML-Teile byte-gleich.

use std::io::{Cursor, Read};

use dw_docx::{DocxInput, DocxPage, build_docx};
use serde_json::{Value, json};

#[test]
fn docx_matches_ts() {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/docx.json");
    let f: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let png = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    let pages = f["pages"].as_array().unwrap().iter().map(|els| DocxPage {
        measured: serde_json::from_value(json!({ "els": els, "fit": { "ok": true, "head": 0, "body": 0, "overflow": [] } })).unwrap(),
        background: png.clone(),
    });
    let inp = DocxInput {
        title: f["title"].as_str().unwrap().into(),
        author: "Deckwerk".into(),
        size: serde_json::from_value(f["size"].clone()).unwrap(),
        head_font: f["head"].as_str().unwrap().into(),
        body_font: f["body"].as_str().unwrap().into(),
        pages: pages.collect(),
        fonts: vec![],
    };
    let bytes = build_docx(&inp).unwrap();
    let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut names: Vec<_> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().unwrap().to_string()).collect();
    let mut want: Vec<String> = serde_json::from_value(f["files"].clone()).unwrap();
    names.sort();
    want.sort();
    assert_eq!(names, want);
    for (name, xml) in f["parts"].as_object().unwrap() {
        let mut s = String::new();
        z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
        assert_eq!(s, xml.as_str().unwrap(), "{name}");
    }
}
