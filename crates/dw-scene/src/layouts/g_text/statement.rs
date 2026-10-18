//! Kernaussage (layouts.tsx Statement, slide.css „section / statement“): links, zentriert oder als Plakat.
//! ponytail: **Wörter** werden fett statt in Akzentfarbe (.statement-text strong); TextSpec kennt keine Farbe für fett

use dw_model::Profile;
use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::words;
use crate::tree::Div;

pub const VARIANTS: &[&str] = &["left", "center", "poster"];

pub const DEF: Def = Def {
    footer: false,
    frames: &[],
    tone: None,
    hero: true,
    build,
    samples,
};

fn source(cx: &Cx, c: &Value) -> Option<Div> {
    s(c, "source").map(|src| {
        let mut spec = cx.t(Role::Label, "source", src);
        spec.color = cx.pal.muted;
        spec.build = Some(0);
        t(spec)
    })
}

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let text = req(c, "text")?;
    if v == Some("poster") {
        // Plakat nur für kurze Sätze; längerer Text fällt auf die normale Größe zurück
        let big = text.replace("**", "").encode_utf16().count() <= 60;
        let mut spec = cx.t(
            if big { Role::Display } else { Role::Statement },
            "text",
            text,
        );
        spec.build = Some(0);
        spec.max_lines = Some(if big { 3 } else { 4 });
        if big {
            let k = if cx.profile == Profile::Social {
                1.2
            } else {
                1.9
            };
            spec.size *= k;
            spec.lh = 0.96;
            spec.tracking_em = -0.035;
        }
        let mut kids = vec![t(spec)];
        if s(c, "eyebrow").is_some() || s(c, "source").is_some() {
            let foot = eyebrow(cx, s(c, "eyebrow"), false)
                .into_iter()
                .chain(source(cx, c));
            kids.push(Div::new(col(8.)).kids(foot));
        }
        let st = col(24.)
            .grow()
            .justify(JustifyContent::SPACE_BETWEEN)
            .items(AlignItems::FLEX_START);
        return Ok(vec![Div::new(st).kids(kids)].into());
    }
    let center = v == Some("center");
    let align = if center {
        AlignItems::CENTER
    } else {
        AlignItems::FLEX_START
    };
    let mut kids: Vec<Div> = eyebrow(cx, s(c, "eyebrow"), center).into_iter().collect();
    let mut spec = cx.t(Role::Statement, "text", text);
    spec.build = Some(0);
    spec.max_lines = Some(4);
    spec.center = center;
    kids.push(t_styled(spec, Style::DEFAULT.max_wo(cx.measure(1040.))));
    if let Some(mut src) = source(cx, c) {
        if let Div {
            kind: crate::tree::Kind::Text(spec),
            ..
        } = &mut src
        {
            spec.center = center;
        }
        let dash = (cx.elements() != Elements::Plain)
            .then(|| Div::new(Style::DEFAULT.none().wh(40., 2.)).paint(cx.pal.accent));
        kids.push(Div::new(col(14.).items(align)).kids(dash.into_iter().chain([src])));
    }
    let st = col(30.).grow().justify(JustifyContent::CENTER).items(align);
    Ok(vec![Div::new(st).kids(kids)].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        ("min", json!({ "text": "Kunden bleiben, wenn es **einfach** ist." })),
        (
            "typ",
            json!({ "eyebrow": "Die Erkenntnis", "text": "80 % unserer Neukunden kommen über Empfehlungen – **Zufriedenheit ist unser stärkster Vertriebskanal.**", "source": "Kundenbefragung 2026, n = 1.240" }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "text": words(140, 0), "source": words(60, 3) }),
        ),
    ]
}
