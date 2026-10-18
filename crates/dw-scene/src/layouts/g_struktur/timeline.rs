//! Zeitstrahl (layouts.tsx Timeline, slide.css „tl“): Achse, Punkt je Meilenstein, offene Spalten.

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::{BoxSpec, Div};

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &["band"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let items = arr(c, "items");
    let n = items.len();
    let roomy = n <= 4;
    let role = if roomy { Role::H2 } else { Role::H3 };
    let mut kids = Vec::new();
    if el != Elements::Plain {
        let (top, h) = if el == Elements::Line { (7., 2.) } else { (6., 4.) };
        kids.push(
            Div::new(abs(Some(0.), Some(0.), Some(top), None).h(h)).boxel(bx(
                "_axis",
                None,
                Some(tk.border),
            )),
        );
    }
    for (i, it) in items.iter().enumerate() {
        let b = Some(i as u32);
        let dot = match el {
            Elements::Plain => None,
            Elements::Line => Some(
                Div::new(Style::DEFAULT.none().wh(24., 4.).margin(6., 0., 28., 0.))
                    .boxel(bx(format!("_dot.{i}"), b, Some(cx.pal.accent))),
            ),
            Elements::Solid => Some(
                Div::new(Style::DEFAULT.none().wh(16., 16.).mb(22.)).boxel(BoxSpec {
                    ellipse: true,
                    radius: 8.,
                    border: Some((tk.bg, 3.)),
                    ..bx(format!("_dot.{i}"), b, Some(cx.pal.accent))
                }),
            ),
        };
        let mut date = cx.t(role, format!("items.{i}.date"), req(it, "date")?);
        date.build = b;
        date.color = cx.pal.accent;
        date.nowrap = true;
        if roomy {
            date.size = cx.fs_raw(Role::H2) * 1.5;
            date.lh = 1.1;
        }
        let mut title = cx.t(role, format!("items.{i}.title"), req(it, "title")?);
        title.build = b;
        let mut ck = vec![t(date), t(title)];
        if let Some(d) = s(it, "desc") {
            let mut spec = cx.t(Role::Body, format!("items.{i}.desc"), d);
            spec.build = b;
            spec.color = cx.pal.muted;
            ck.push(t(spec));
        }
        let pad = if roomy { (0., 12., 4., 0.) } else { (0., 0., 0., 0.) };
        let card = Div::new(
            col(12.)
                .grow()
                .min_h0()
                .min_w0()
                .pad(pad.0, pad.1, pad.2, pad.3),
        )
        .kids(ck)
        .boxel(bx(format!("_card.{i}"), b, None))
        .fit(&format!("_card.{i}"))
        .clip();
        kids.push(Div::new(col(0.).rel().min_w0()).kids(dot.into_iter().chain([card])));
    }
    let k = columns(cx, n, Stack::Tall);
    let mut st = Style {
        grid_template_columns: vec![repeat(k as u16, vec![fr(1.)])],
        ..grid(0.)
    }
    .rel();
    st.gap.width = px(28.);
    // margin: 0 0 auto; im Split mittig
    st.margin.bottom = auto_lp();
    Ok(vec![header(cx, c, 2)?, Div::new(st).kids(kids).fit("items")].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Drei Meilensteine bis zum Launch", "items": [{ "date": "Q1", "title": "Pilot" }, { "date": "Q2", "title": "Beta" }, { "date": "Q3", "title": "Launch" }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Roadmap",
                "title": "In vier Schritten zur Marktreife bis Ende 2027",
                "items": [
                    { "date": "Q4 2026", "title": "Pilot mit 3 Kunden", "desc": "Validierung der Kernfunktionen" },
                    { "date": "Q1 2027", "title": "Beta-Programm", "desc": "25 Kunden, Feedback-Schleifen" },
                    { "date": "Q2 2027", "title": "Marktstart DACH", "desc": "Vertrieb und Partner an Bord" },
                    { "date": "Q4 2027", "title": "Internationalisierung", "desc": "Start in Benelux und Nordics" },
                ],
            }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(90, 0), "items": rep(5, |i| json!({ "date": "Q4 2027 ff.", "title": words(26, i), "desc": words(80, i + 2) })) }),
        ),
    ]
}
