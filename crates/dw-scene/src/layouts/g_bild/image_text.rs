//! Bild + Text (layouts.tsx ImageText, slide.css „image + text“): Foto randabfallend, Text im Satzspiegel daneben.

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::placeholder;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::Div;

pub const VARIANTS: &[&str] = &["image-left", "image-right"];

pub const DEF: Def = Def {
    footer: true,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let side = if v == Some("image-right") {
        MediaSide::Right
    } else {
        MediaSide::Left
    };
    let inset = || abs(Some(0.), Some(0.), Some(0.), Some(0.));
    let img = c
        .get("image")
        .and_then(|im| photo(cx, "image", im, inset()))
        .unwrap_or_else(|| placeholder(cx));
    let mut hdr = header(cx, c, 3)?;
    hdr.style.margin.bottom = pxa(6.);
    let mut kids = vec![hdr];
    if let Some(text) = s(c, "text") {
        let mut spec = cx.t(Role::Body, "text", text);
        spec.build = Some(0);
        spec.color = cx.pal.muted;
        kids.push(t(spec));
    }
    kids.extend(points(cx, &strs(c, "points"), "points", Some(0), 1., 10., cx.pal.accent));
    let st = col(22.).grow().min_h0().justify(JustifyContent::CENTER);
    Ok(Body {
        content: vec![Div::new(st).kids(kids).clip().fit("_body")],
        media: vec![media(cx, side, vec![img])],
        safe: Some(media_safe(cx, side)),
    })
}

fn samples() -> [(&'static str, Value); 3] {
    let no = json!({ "src": "" });
    [
        ("min", json!({ "title": "So sieht es aus", "image": no })),
        (
            "typ",
            json!({ "eyebrow": "Produkt", "title": "Ein Dashboard für alle Standorte", "text": "Alle Kennzahlen live an einem Ort. Abweichungen werden automatisch erkannt und gemeldet.", "points": ["Echtzeit-Daten", "Automatische Warnungen", "Mobil verfügbar"], "image": no }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(80, 0), "text": words(240, 0), "points": rep(4, |i| json!(words(64, i))), "image": no }),
        ),
    ]
}
