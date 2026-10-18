//! Titelfolie (layouts.tsx Cover, slide.css „cover / closing“). Ohne Foto ist side wie left.
//! ponytail: Foto-Varianten (Backdrop, SidePhoto) fehlen noch; kommen mit den Foto-Layouts

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::words;
use crate::tree::Div;

pub const VARIANTS: &[&str] = &["left", "center", "bottom", "side"];

pub const DEF: Def = Def {
    footer: false,
    frames: &[],
    tone: None,
    hero: true,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let (center, bottom) = (v == Some("center"), v == Some("bottom"));
    let mut main = col(24.)
        .justify(if bottom {
            JustifyContent::FLEX_END
        } else {
            JustifyContent::CENTER
        })
        .grow()
        .min_h0()
        .max_wo(cx.measure(if bottom { 1100. } else { 1000. }));
    if bottom {
        main = main.pad(0., 0., 28., 0.);
    }
    if center {
        main.align_items = AlignItems::CENTER;
        main.margin.left = auto_lp();
        main.margin.right = auto_lp();
    }
    let mut title = cx.t(Role::Display, "title", req(c, "title")?);
    title.max_lines = Some(3);
    title.center = center;
    if bottom {
        title.size *= 1.15;
        title.lh = 1.02;
    }
    let mut kids: Vec<Div> = eyebrow(cx, s(c, "eyebrow"), center).into_iter().collect();
    kids.push(t(title));
    if let Some(sub) = s(c, "subtitle") {
        let mut spec = cx.t(Role::Body, "subtitle", sub);
        spec.max_lines = Some(2);
        spec.color = cx.pal.muted;
        spec.center = center;
        kids.push(t_styled(spec, Style::DEFAULT.max_w(860.)));
    }
    let mut foot = row(0.).items(AlignItems::FLEX_END).none().h(28.);
    if center {
        foot.justify_content = JustifyContent::CENTER;
    }
    let meta = s(c, "meta").map(|m| {
        let mut spec = cx.t(Role::Label, "meta", m);
        spec.color = cx.pal.muted;
        t(spec)
    });
    // cover-top: Logo nur auf Titel- und Schlussfolie (kein Wasserzeichen)
    let logo = cx.theme.logo.as_deref().map(|src| {
        img(
            "_logo",
            src,
            true,
            (0., 0.5),
            Style::DEFAULT.none().wh(200., 40.),
        )
    });
    Ok(vec![Div::new(col(0.).grow()).kids([
        Div::new(col(0.).none().h(40.)).kids(logo),
        Div::new(main).kids(kids),
        Div::new(foot).kids(meta),
    ])]
    .into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        ("min", json!({ "title": "Q3-Review" })),
        (
            "typ",
            json!({ "eyebrow": "Strategie 2027", "title": "Wie wir den Umsatz in 18 Monaten verdoppeln", "subtitle": "Wachstumsplan für die Geschäftsführung", "meta": "Max Muster · Oktober 2026" }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(70, 0), "subtitle": words(120, 3), "meta": words(60, 5) }),
        ),
    ]
}
