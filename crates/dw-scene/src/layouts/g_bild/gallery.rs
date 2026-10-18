//! Bildergalerie (layouts.tsx Gallery, slide.css „gallery“): 2–4 Fotos nebeneinander, mosaic = eins groß links.
//! ponytail: `look` des Inhalts wird nicht an die Bilder gereicht, Theme-Bildstil gilt

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::placeholder;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::{Div, Kind};

pub const VARIANTS: &[&str] = &["row", "mosaic"];

pub const DEF: Def = Def {
    footer: true,
    frames: &["band", "center"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let images = arr(c, "images");
    let n = images.len();
    let mosaic = v == Some("mosaic") && n > 2;
    let cell = |i: usize, it: &Value| {
        let b = Some(i as u32);
        // .gal-img: position relative, flex 1, Radius, overflow hidden
        let st = Style::DEFAULT.rel().grow().min_h0();
        let img = it
            .get("image")
            .and_then(|im| photo(cx, &format!("images.{i}.image"), im, st.clone()));
        let img = match img {
            Some(mut d) => {
                if let Kind::Img(spec) = &mut d.kind {
                    spec.build = b;
                    spec.radius = cx.tk.radius as f32;
                }
                d
            }
            None => Div::new(st).kids([placeholder(cx)]).clip(),
        };
        let mut kids = vec![img];
        if let Some(cap) = s(it, "caption") {
            let mut spec = cx.t(Role::Label, format!("images.{i}.caption"), cap);
            spec.build = b;
            spec.color = cx.pal.muted;
            kids.push(t(spec));
        }
        let mut st = col(12.).min_h0();
        if mosaic && i == 0 {
            st.grid_row = Line { start: line(1), end: line(-1) };
        }
        Div::new(st).kids(kids)
    };
    let cells: Vec<Div> = images.iter().enumerate().map(|(i, it)| cell(i, it)).collect();
    let fr0 = |f: f32| minmax(length(0.), fr(f));
    let (cols, rows) = if mosaic {
        (vec![fr0(1.55), fr0(1.)], vec![fr0(1.); n - 1])
    } else {
        (vec![fr0(1.); n.max(1)], vec![fr0(1.)])
    };
    let st = Style {
        grid_template_columns: cols,
        grid_template_rows: rows,
        ..grid(24.)
    }
    .grow()
    .min_h0();
    Ok(vec![header(cx, c, 2)?, Div::new(st).kids(cells).fit("images")].into())
}

fn samples() -> [(&'static str, Value); 3] {
    let no = || json!({ "image": { "src": "" } });
    let typ: Vec<Value> = ["Grundschule Nord", "Realschule Mitte", "Gymnasium Süd"]
        .map(|c| json!({ "image": { "src": "" }, "caption": c }))
        .into();
    [
        ("min", json!({ "title": "Zwei Standorte", "images": rep(2, |_| no()) })),
        (
            "typ",
            json!({ "eyebrow": "Eindrücke", "title": "Drei Pilotschulen zeigen, wie es im Alltag aussieht",
                "images": typ }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(80, 0), "images": rep(4, |i| json!({ "image": { "src": "" }, "caption": words(40, i) })) }),
        ),
    ]
}
