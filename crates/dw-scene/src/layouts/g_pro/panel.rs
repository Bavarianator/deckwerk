//! Twitch-Panel 320 × 160 (layouts-extra.tsx Panel, layouts-extra.css „pn-“): Überschrift links unten über kurzer Akzentlinie.
//! ponytail: feste 34 px statt calc(34px * (0.7 + 0.3 * --head-fit)); Autofit über die Typo-Skala greift nicht

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::words;
use crate::tree::Div;

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: false,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let mut spec = cx.t(Role::H1, "label", req(c, "label")?);
    spec.size = 34.;
    spec.lh = 1.05;
    spec.tracking_em = -0.01;
    spec.max_lines = Some(2);
    let line = Div::new(Style::DEFAULT.none().wh(28., 3.)).paint(cx.pal.accent);
    let st = col(12.)
        .grow()
        .min_h0()
        .justify(JustifyContent::FLEX_END)
        .pad(0., 0., 6., 0.);
    // .pn-safe: Text mindestens 24 px vom Rand (Lint frame)
    let safe = Rect {
        left: pxa(24.),
        right: pxa(24.),
        top: pxa(24.),
        bottom: pxa(24.),
    };
    Ok(Body {
        content: vec![Div::new(st).kids([line, t(spec)])],
        media: vec![],
        safe: Some(safe),
    })
}

fn samples() -> [(&'static str, Value); 3] {
    [
        ("min", json!({ "label": "FAQ" })),
        ("typ", json!({ "label": "Über mich" })),
        ("max", json!({ "label": words(20, 0) })),
    ]
}
