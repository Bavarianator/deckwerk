//! Videoclip (layouts-extra.tsx Clip, layouts-extra.css „.clip“): Grund über die ganze Folie, Hook oben mit Verlauf.
//! ponytail: kein Standbild (?frame=) und kein invert-Ton auf hellen Themes, bis Bild-Host und Def.tone das können

use dw_theme::Role;
use serde_json::{Value, json};

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::{BoxSpec, Div};

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: false,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _: Option<&str>) -> Result<Body, Error> {
    let d = cx.theme.c.bg;
    let mut media = vec![Div::new(abs(Some(0.), Some(0.), Some(0.), Some(0.))).paint(d)];
    let mut kids = Vec::new();
    if let Some(hook) = s(c, "hook") {
        let hex = d.to_hex();
        let stops = [(0., 0.85), (0.55, 0.55), (1., 0.)];
        let gradient = dw_model::Gradient {
            angle: 180.,
            stops: stops
                .iter()
                .map(|&(pos, alpha)| dw_model::GradientStop { color: hex.clone(), alpha, pos })
                .collect(),
        };
        media.push(Div::new(abs(Some(0.), Some(0.), Some(0.), None).h(cx.h * 0.45)).boxel(BoxSpec {
            gradient: Some(gradient),
            ..bx("_scrim", None, None)
        }));
        let mut spec = cx.t(Role::H1, "hook", hook);
        spec.max_lines = Some(4);
        kids.push(t(spec));
    }
    let st = col(0.).grow().min_h0().pad(48., 0., 0., 0.);
    Ok(Body {
        content: vec![Div::new(st).kids(kids)],
        media: vec![Div::new(abs(Some(0.), Some(0.), Some(0.), Some(0.))).kids(media).clip()],
        safe: None,
    })
}

fn samples() -> [(&'static str, Value); 3] {
    [
        ("min", json!({ "video": "", "parts": [{ "start": 0, "end": 4 }] })),
        (
            "typ",
            json!({ "video": "", "hook": "Warum neun von zehn Pitches scheitern", "parts": [{ "start": 12.4, "end": 21.8, "focus": 0.5 }, { "start": 40.1, "end": 52 }, { "start": 63, "end": 70.5 }], "captions": "wort", "cover": 45.2 }),
        ),
        (
            "max",
            json!({ "video": "", "hook": words(70, 0), "parts": rep(8, |i| json!({ "start": i * 10, "end": i * 10 + 8, "focus": 1 })), "captions": "satz" }),
        ),
    ]
}
