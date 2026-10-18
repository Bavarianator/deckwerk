//! Icon-Raster (layouts-extra.tsx IconGrid, layouts-extra.css „.ig“): 3–6 Merkmale, Icon links, Text daneben.

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::Div;

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
    let items = arr(c, "items");
    let n = items.len();
    let few = n <= 4;
    let mut cells = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let b = Some(i as u32);
        // .ig-badge 48 × 48, Icon 30 mittig
        let badge = Div::new(
            row(0.)
                .items(AlignItems::CENTER)
                .justify(JustifyContent::CENTER)
                .none()
                .wh(48., 48.),
        )
        .boxel(crate::tree::BoxSpec {
            ellipse: true,
            ..bx(format!("_badge.{i}"), b, None)
        })
        .kids([icon(format!("_icon.{i}"), b, req(it, "icon")?, cx.pal.text, 30.)]);
        let mut head = cx.t(if few { Role::H2 } else { Role::H3 }, format!("items.{i}.head"), req(it, "head")?);
        head.build = b;
        let mut tk = vec![t(head)];
        if let Some(sub) = s(it, "sub") {
            let mut spec = cx.t(if few { Role::Body } else { Role::Label }, format!("items.{i}.sub"), sub);
            spec.build = b;
            spec.color = cx.pal.muted;
            tk.push(t(spec));
        }
        let text = Div::new(col(6.).grow().min_w0().pad(6., 0., 0., 0.)).kids(tk);
        cells.push(Div::new(row(22.).items(AlignItems::FLEX_START).min_w0()).kids([badge, text]));
    }
    let k = if n == 4 { 2 } else { 3 };
    let st = Style {
        grid_template_columns: vec![minmax(length(0.), fr(1.)); k],
        gap: Size { width: length(48.), height: length(40.) },
        align_content: AlignContent::START,
        ..grid(0.)
    }
    .grow()
    .min_h0();
    Ok(vec![header(cx, c, 2)?, Div::new(st).kids(cells).clip().fit("items")].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Drei Gründe", "items": [{ "icon": "zap", "head": "Schnell" }, { "icon": "shield-check", "head": "Sicher" }, { "icon": "smile", "head": "Einfach" }] }),
        ),
        (
            "typ",
            json!({ "eyebrow": "Vorteile", "title": "Sechs Gründe, warum Schulen nach dem Pilot bleiben", "items": [
                { "icon": "zap", "head": "Sofort startklar", "sub": "Keine Installation, läuft im Browser" },
                { "icon": "shield-check", "head": "DSGVO-konform", "sub": "Server in Deutschland, keine Werbung" },
                { "icon": "users", "head": "Für jede Klasse", "sub": "Passt sich dem Niveau jedes Kindes an" },
                { "icon": "chart-line", "head": "Sichtbarer Fortschritt", "sub": "Wochenbericht für Lehrkräfte" },
                { "icon": "clock", "head": "10 Minuten am Tag", "sub": "Fügt sich in den Unterricht ein" },
                { "icon": "heart", "head": "Motivierend", "sub": "Kleine Erfolge statt roter Striche" },
            ] }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(90, 0), "items": rep(6, |i| json!({ "icon": "sparkles", "head": words(28, i), "sub": words(90, i) })) }),
        ),
    ]
}
