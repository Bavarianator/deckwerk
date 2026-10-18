//! Kapiteltrenner (layouts.tsx Section, slide.css „section“): Titel unten links, Nummer übergroß darüber, Foto rechts.

use dw_theme::{Role, Tone};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::words;

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: false,
    frames: &[],
    tone: Some(Tone::Accent),
    hero: true,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _: Option<&str>) -> Result<Body, Error> {
    let inset = || abs(Some(0.), Some(0.), Some(0.), Some(0.));
    let img = c.get("image").and_then(|v| photo(cx, "image", v, inset()));
    let ph = img.is_some();
    let mut kids = Vec::new();
    if let Some(n) = s(c, "number") {
        let mut spec = cx.t(Role::Hero, "number", n);
        spec.color = cx.pal.muted;
        spec.lh = 0.9;
        let mut st = Style::DEFAULT;
        st.margin.bottom = auto_lp();
        kids.push(t_styled(spec, st));
    }
    let mut title = cx.t(Role::Display, "title", req(c, "title")?);
    title.max_lines = Some(if ph { 3 } else { 2 });
    kids.push(t(title));
    if let Some(sub) = s(c, "subtitle") {
        let mut spec = cx.t(Role::Body, "subtitle", sub);
        spec.max_lines = Some(if ph { 3 } else { 2 });
        spec.color = cx.pal.muted;
        kids.push(t_styled(spec, Style::DEFAULT.max_w(780.)));
    }
    let st = col(18.)
        .grow()
        .justify(JustifyContent::FLEX_END)
        .max_wo(cx.measure(980.))
        .pad(0., 0., 12., 0.);
    let content = vec![crate::tree::Div::new(st).kids(kids)];
    Ok(match img {
        Some(img) => Body {
            content,
            media: vec![media(cx, MediaSide::Right, vec![img])],
            safe: Some(media_safe(cx, MediaSide::Right)),
        },
        None => content.into(),
    })
}

fn samples() -> [(&'static str, Value); 3] {
    [
        ("min", json!({ "title": "Lösung" })),
        (
            "typ",
            json!({ "title": "Unser Plan", "subtitle": "Drei Hebel, die sich gegenseitig verstärken" }),
        ),
        (
            "max",
            json!({ "number": "12", "title": words(50, 0), "subtitle": words(100, 4) }),
        ),
    ]
}
