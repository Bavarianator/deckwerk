//! Lesen und Schreiben verliert nichts: examples/*.json und ein Measured mit jeder Element-Art.

use dw_model::{Deck, Measured};
use serde_json::Value;

// JS kennt nur eine Zahlenart: 100 und 100.0 gelten als gleich
fn norm(v: Value) -> Value {
    match v {
        Value::Number(n) => serde_json::json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.into_iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, norm(v))).collect()),
        v => v,
    }
}

#[test]
fn examples() {
    let n = check_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples"));
    assert!(n >= 10, "nur {n} Beispiele gefunden");
    // weitere Beispiele, z. B. DW_EXAMPLES=/home/bayernator/deckwerk/examples
    if let Ok(dir) = std::env::var("DW_EXAMPLES") {
        assert!(check_dir(&dir) > 0, "keine Beispiele in {dir}");
    }
}

fn check_dir(dir: &str) -> usize {
    let mut n = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let orig: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let deck: Deck = serde_json::from_value(orig.clone())
            .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert_eq!(
            norm(serde_json::to_value(&deck).unwrap()),
            norm(orig),
            "{}",
            path.display()
        );
        n += 1;
    }
    n
}

#[test]
fn unknown_item_values() {
    let orig = serde_json::json!({"title": "T", "theme": {"id": "x"}, "slides": [{"id": "s", "layout": "l", "content": {},
        "items": [{"id": "i", "kind": "sticker", "x": 1, "y": 2, "w": 3, "h": 4,
            "spec": {"type": "radar", "categories": [], "series": []}}]}]});
    let deck: Deck = serde_json::from_value(orig.clone()).unwrap();
    let kind = &deck.slides[0].items.as_ref().unwrap()[0].kind;
    assert_eq!(*kind, dw_model::ItemKind::Other("sticker".into()));
    assert_eq!(norm(serde_json::to_value(&deck).unwrap()), norm(orig));
}

#[test]
fn measured_all_kinds() {
    let base = r#""slot": "s", "box": {"x": 1, "y": 2.5, "w": 3, "h": 4}"#;
    let json = format!(
        r##"{{
        "fit": {{"ok": false, "head": 2, "body": 3, "overflow": [{{"slot": "body", "overPx": 12.5, "kind": "lines"}}]}},
        "els": [
          {{"kind": "text", {base}, "build": 1, "rot": 5, "anim": "fade", "animDir": "up", "animSpeed": "fast", "link": "#2",
            "font": "head", "role": "title", "sizePx": 48, "effect": {{"type": "neon", "color": "#ff0000"}}, "fontFace": "Inter",
            "lineHeightPx": 52, "trackingPx": -1.2, "align": "left", "upper": false,
            "runs": [{{"text": "Hallo", "bold": true, "italic": false, "underline": true, "color": "#111111", "breakAfter": true,
                      "link": "https://x", "sizePx": 20, "trackingPx": 0.5}}, {{"text": "Welt", "bold": false, "italic": true, "color": "#222222"}}],
            "list": {{"type": "bullet", "indentPx": 24}}, "lines": 2, "bg": "#ffffff"}},
          {{"kind": "box", {base}, "fill": {{"color": "#ff0000", "alpha": 0.5}}, "border": {{"color": "#000000", "width": 2}}, "radius": 8,
            "shadow": {{"color": "#000000", "alpha": 0.2, "blur": 10, "offsetY": 4}}, "ellipse": false,
            "gradient": {{"angle": 135, "stops": [{{"color": "#000000", "alpha": 1, "pos": 0}}, {{"color": "#ffffff", "alpha": 0, "pos": 1}}]}},
            "shape": "star", "lineStart": "dot", "lineEnd": "arrow", "dash": "dash"}},
          {{"kind": "img", {base}, "src": "asset://local/a.jpg", "radius": 0, "fit": "cover", "focus": {{"x": 0.5, "y": 0.3}}, "under": true,
            "nat": {{"w": 4000, "h": 3000}}, "look": "duotone", "alt": "Foto", "mask": "circle",
            "adjust": {{"bright": 10, "contrast": -5, "sat": 0, "blur": 3}}, "alpha": 0.8, "round": true, "flip": true,
            "crop": {{"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8}}}},
          {{"kind": "icon", {base}, "svg": "<svg/>", "png": "data:image/png;base64,AA", "name": "star", "qr": "https://q", "color": "#123456"}},
          {{"kind": "chart", {base}, "spec": {{"type": "waterfall", "categories": ["A", "B"], "series": [{{"name": "S", "values": [1, -2.5]}}],
            "unit": "€", "highlight": "B", "annotate": "cagr"}}}},
          {{"kind": "media", {base}, "media": "video", "src": "asset://local/v.mp4", "poster": "asset://local/p.jpg"}},
          {{"kind": "table", {base}, "cells": [["Kopf", "Wert"], ["a", "1"]], "colW": [100, 50], "rowH": [30, 28], "sizePx": 16,
            "font": "body", "fontFace": "Inter", "color": "#111111", "line": "#cccccc", "align": ["left", "right"]}}
        ]
      }}"##
    );
    let orig: Value = serde_json::from_str(&json).unwrap();
    let m: Measured = serde_json::from_value(orig.clone()).unwrap();
    assert_eq!(m.els.len(), 7);
    assert_eq!(norm(serde_json::to_value(&m).unwrap()), norm(orig));
}
