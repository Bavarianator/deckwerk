//! Vollbildfoto (layouts.tsx PhotoSlide, slide.css „photo“). Ohne Foto ist side wie text-bottom.
//! ponytail: ohne Foto fehlt der Ton accent (Def.tone ist fest), bis build_slide einen Ton aus dem Inhalt kennt

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::words;
use crate::tree::{BoxSpec, Div, Kind};

pub const VARIANTS: &[&str] = &["text-bottom", "text-left", "card", "side"];

pub const DEF: Def = Def {
    footer: false,
    frames: &[],
    tone: None,
    hero: true,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let inset = || abs(Some(0.), Some(0.), Some(0.), Some(0.));
    let img = c.get("image").and_then(|im| photo(cx, "image", im, inset()));
    let card = v == Some("card");
    let side = img.is_some() && v == Some("side");
    let left = v == Some("text-left");
    let cxp = if img.is_some() && !card && !side {
        on_photo(cx)
    } else {
        cx.clone()
    };
    let cx = &cxp;
    let mut kids: Vec<Div> = eyebrow(cx, s(c, "eyebrow"), false).into_iter().collect();
    let mut title = cx.t(Role::H1, "title", req(c, "title")?);
    title.max_lines = Some(if side { 5 } else { 3 });
    kids.push(t(title));
    if let Some(sub) = s(c, "subtitle") {
        let mut spec = cx.t(Role::Body, "subtitle", sub);
        spec.max_lines = Some(if side { 4 } else { 3 });
        spec.color = cx.pal.muted;
        kids.push(t(spec));
    }
    let text = if card {
        // ponytail: Karte ohne Schatten und ohne Alpha 0,97, bis BoxSpec beides kann
        Div::new(col(16.).max_w(640.).pad(40., 44., 40., 44.))
            .kids(kids)
            .boxel(BoxSpec {
                radius: cx.tk.radius as f32,
                ..bx("_card", None, Some(cx.theme.c.bg))
            })
    } else {
        Div::new(col(14.).max_w(if left { 600. } else { 920. })).kids(kids)
    };
    let justify = if side {
        JustifyContent::FLEX_START
    } else if left {
        JustifyContent::CENTER
    } else {
        JustifyContent::FLEX_END
    };
    let st = col(0.).grow().min_h0().justify(justify).pad(0., 0., 4., 0.);
    let content = vec![Div::new(st).kids([text])];
    Ok(match img {
        Some(img) if side => Body {
            content,
            media: vec![media(cx, MediaSide::Side, vec![img])],
            safe: Some(media_safe(cx, MediaSide::Side)),
        },
        Some(mut img) => {
            if let Kind::Img(spec) = &mut img.kind {
                spec.under = true;
            }
            let sc = if card { None } else { scrim(cx, if left { "left" } else { "bottom" }) };
            Body {
                content,
                media: vec![Div::new(inset()).kids([img].into_iter().chain(sc))],
                safe: None,
            }
        }
        None => content.into(),
    })
}

fn samples() -> [(&'static str, Value); 3] {
    let no = json!({ "src": "" });
    [
        ("min", json!({ "title": "Hier fängt es an", "image": no })),
        (
            "typ",
            json!({ "eyebrow": "Vor Ort", "title": "Jede dritte Schule arbeitet schon digital – der Rest wartet auf Lösungen", "subtitle": "Besuch an der Grundschule Nord, September 2026", "image": no }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(80, 0), "subtitle": words(140, 2), "image": no }),
        ),
    ]
}
