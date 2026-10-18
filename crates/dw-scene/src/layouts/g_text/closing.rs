//! Abschluss (layouts.tsx Closing, slide.css „cover / closing“ und „Bild neben Text“). Ohne Foto ist side wie left.
//! ponytail: QR-Code (qr) fehlt, bis es einen QR-Baustein gibt

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::img_mut;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::Div;

pub const VARIANTS: &[&str] = &["left", "side"];

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
    let side = img.is_some() && v == Some("side");
    let on = img.is_some() && !side;
    let cxp = if on { on_photo(cx) } else { cx.clone() };
    let cx = &cxp;

    let mut title = cx.t(Role::Display, "title", req(c, "title")?);
    title.max_lines = Some(if side { 4 } else { 3 });
    if side && !cx.tall {
        title.size *= 0.68; // schmale Spalte
        title.lh = 1.08;
    }
    let mut main_kids = vec![t(title)];
    if let Some(sub) = s(c, "subtitle") {
        let mut spec = cx.t(Role::Body, "subtitle", sub);
        spec.max_lines = Some(if side { 4 } else { 2 });
        spec.color = cx.pal.muted;
        main_kids.push(t_styled(spec, Style::DEFAULT.max_w(860.)));
    }
    let measure = if on {
        Some(892. - cx.tk.m_l as f32) // rechte Kante fest: dort läuft der Verlauf aus
    } else {
        cx.measure(1000.)
    };
    let main = col(if side { 20. } else { 24. })
        .grow()
        .min_h0()
        .justify(if side {
            JustifyContent::FLEX_START
        } else {
            JustifyContent::CENTER
        })
        .max_wo(measure);

    let contact: Vec<Div> = strs(c, "contact")
        .iter()
        .enumerate()
        .map(|(i, x)| {
            let mut spec = cx.t(Role::Label, format!("contact.{i}"), x);
            spec.color = cx.pal.muted;
            t(spec)
        })
        .collect();
    let logo = cx.theme.logo.as_deref().map(|src| logo_img(src, side));
    let mut bottom = if side {
        col(24.).items(AlignItems::FLEX_START)
    } else {
        row(0.)
            .justify(JustifyContent::SPACE_BETWEEN)
            .items(AlignItems::FLEX_END)
    }
    .none();
    bottom.min_size.height = pxa(40.);
    let mut bk = Vec::new();
    if !contact.is_empty() {
        let st = if side {
            col(6.).items(AlignItems::FLEX_START)
        } else {
            row(40.)
        };
        bk.push(Div::new(st).kids(contact));
    } else if !side {
        bk.push(Div::new(Style::DEFAULT));
    }
    // leere Kinder fallen in side weg (.closing-bottom > :empty)
    if logo.is_some() || !side {
        bk.push(Div::new(row(28.).items(AlignItems::FLEX_END)).kids(logo));
    }
    let content = vec![Div::new(col(0.).grow()).kids([
        Div::new(main).kids(main_kids),
        Div::new(bottom).kids(bk),
    ])];
    Ok(match img {
        Some(img) if side => Body {
            content,
            media: vec![media(cx, MediaSide::Side, vec![img])],
            safe: Some(media_safe(cx, MediaSide::Side)),
        },
        Some(img) => Body {
            content,
            media: vec![Div::new(inset()).kids(
                [img_mut(img, |s| s.under = true)]
                    .into_iter()
                    .chain(scrim(cx, "left")),
            )],
            safe: None,
        },
        None => content.into(),
    })
}

/// Logo der Schlussfolie (.cover-logo 200 × 40): rechts unten, in side links.
fn logo_img(src: &str, side: bool) -> Div {
    img(
        "_logo",
        src,
        true,
        (if side { 0. } else { 1. }, 0.5),
        Style::DEFAULT.none().wh(200., 40.),
    )
}

fn samples() -> [(&'static str, Value); 3] {
    [
        ("min", json!({ "title": "Danke" })),
        (
            "typ",
            json!({ "title": "Lassen Sie uns den Pilot im November starten", "subtitle": "Entscheidung bis 15. Oktober – Budget 120.000 €", "contact": ["Max Muster", "max.muster@firma.de", "+49 170 1234567"] }),
        ),
        (
            "max",
            json!({ "title": words(60, 0), "subtitle": words(120, 2), "contact": rep(3, |i| json!(words(48, i))) }),
        ),
    ]
}
