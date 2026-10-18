//! Zitat (layouts.tsx Quote, slide.css „quote“): großes Anführungszeichen, Zitat, Autor; Porträt rund links.
//! ponytail: Platzhalter-Porträt ohne Foto ist eckig (Fläche im Hintergrundbild kennt keinen Radius)

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::{img_mut, photo_src, placeholder};
use crate::Error;
use crate::blocks::*;
use crate::samples::words;
use crate::tree::Div;

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: false,
    frames: &[],
    tone: None,
    hero: true,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _: Option<&str>) -> Result<Body, Error> {
    let image = c.get("image").filter(|i| photo_src(i).is_some());
    let portrait = image.map(|im| {
        let mask = im.get("mask").and_then(Value::as_str).is_some();
        let st = Style::DEFAULT
            .none()
            .wh(300., if mask { 380. } else { 300. })
            .rel();
        match photo(cx, "image", im, st.clone()) {
            Some(p) => img_mut(p, |s| s.round = !mask),
            None => Div::new(st).kids([placeholder(cx)]).clip(),
        }
    });
    let mut text = cx.t(Role::Statement, "text", req(c, "text")?);
    text.max_lines = Some(5);
    text.build = Some(0);
    let mut body = col(22.).grow().min_w0().max_wo(cx.measure(1000.));
    if portrait.is_none() {
        body.margin.left = auto_lp();
        body.margin.right = auto_lp();
    }
    let body = Div::new(body).kids([
        quote_mark(cx),
        t(text),
        quote_by(cx, req(c, "author")?, s(c, "role"), Some(0)),
    ]);
    let st = row(72.).items(AlignItems::CENTER).grow().min_h0();
    Ok(vec![Div::new(st).kids(portrait.into_iter().chain([body]))].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "text": "Das hat uns wirklich Zeit gespart.", "author": "Anna Berg" }),
        ),
        (
            "typ",
            json!({ "text": "Seit dem Pilot korrigieren meine Schüler ihre Texte selbst – und verstehen endlich, warum.", "author": "Julia Hartmann", "role": "Deutschlehrerin, Grundschule Nord", "image": { "src": "" } }),
        ),
        (
            "max",
            json!({ "text": words(180, 0), "author": words(40, 0), "role": words(60, 3), "image": { "src": "" } }),
        ),
    ]
}
