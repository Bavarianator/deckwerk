//! Logo-Wand (layouts-extra.tsx Logos, layouts-extra.css „.lg“): bis 4 Kacheln je Zeile, ohne Bild der Name.

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::Kind;

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &["band", "center"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _: Option<&str>) -> Result<Body, Error> {
    let logos = arr(c, "logos");
    let mono = c.get("mono").and_then(Value::as_bool).unwrap_or(false);
    let mut tiles = Vec::new();
    for (i, l) in logos.iter().enumerate() {
        let b = Some(i as u32);
        let src = s(l, "src").unwrap_or("");
        let mut tile = logo_tile(cx, i, src, b);
        let last = tile.children.last_mut().expect("Logo");
        if src.is_empty() {
            // ohne Bild: Name statt Logo (.lg-name)
            let mut spec = cx.t(Role::H3, format!("logos.{i}.name"), s(l, "name").unwrap_or(""));
            spec.build = b;
            spec.center = true;
            spec.color = cx.pal.muted;
            *last = t(spec);
        } else if let Kind::Img(spec) = &mut last.kind {
            spec.slot = format!("logos.{i}.src");
            spec.build = b;
            spec.look = mono.then(|| "mono".to_string());
        }
        tiles.push(tile);
    }
    let mut st = grid_cols(cx, &vec![1.; logos.len().clamp(1, 4)], 20., Stack::Narrow);
    st.align_content = AlignContent::START;
    let st = st.grow().min_h0();
    Ok(vec![header(cx, c, 2)?, crate::tree::Div::new(st).kids(tiles).clip().fit("logos")].into())
}

fn samples() -> [(&'static str, Value); 3] {
    let typ: Vec<Value> = ["Stadt Nord", "Bildungswerk Süd", "Lernfabrik", "Kreis Mitte", "Grundschule am Park", "Schulverbund West"]
        .map(|name| json!({ "name": name }))
        .into();
    [
        (
            "min",
            json!({ "title": "Drei Partner", "logos": [{ "name": "Stadt Nord" }, { "name": "Bildungswerk" }, { "name": "Lernfabrik" }] }),
        ),
        (
            "typ",
            json!({ "eyebrow": "Partner", "title": "Über 40 Schulen und drei Träger arbeiten bereits mit uns", "logos": typ }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(90, 0), "logos": rep(12, |i| json!({ "name": words(22, i) })), "mono": true }),
        ),
    ]
}
