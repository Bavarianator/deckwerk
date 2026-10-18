//! Prozess (layouts.tsx Process, slide.css „proc“): 3–4 Schritte als offene Spalten mit Kopflinie und Nummer.

use dw_theme::{Elements, Role};
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
    frames: &["band"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let steps = arr(c, "steps");
    let field = |k: &str| -> Vec<&str> { steps.iter().filter_map(|st| s(st, k)).collect() };
    // wenige Schritte: große Nummern, größere Titel und Beschreibungen
    let few = cx.wide()
        && steps.len() <= 3
        && longest_word(&field("title")) <= 14
        && longest_word(&field("desc")) <= 20;
    let mut kids = Vec::new();
    for (i, it) in steps.iter().enumerate() {
        let b = Some(i as u32);
        let mut num = cx.t(
            if few { Role::Kpi } else { Role::H1 },
            format!("_n.{i}"),
            &format!("{:02}", i + 1),
        );
        num.build = b;
        num.color = cx.pal.accent;
        num.lh = 1.;
        match el {
            Elements::Line => {
                num.size = cx.fs_raw(Role::Label);
                num.lh = 1.32;
            }
            Elements::Plain => {
                num.weight = 400.;
                num.color = cx.pal.muted;
            }
            Elements::Solid => {}
        }
        let ic = s(it, "icon").map(|name| icon(format!("_icon.{i}"), b, name, cx.pal.accent, 28.));
        let head = Div::new(
            row(0.)
                .items(AlignItems::CENTER)
                .justify(JustifyContent::SPACE_BETWEEN)
                .mb(8.),
        )
        .kids([t(num)].into_iter().chain(ic));
        let mut title = cx.t(Role::H2, format!("steps.{i}.title"), req(it, "title")?);
        title.build = b;
        if few {
            title.size = cx.fs_raw(Role::H2) * 1.35;
        }
        let mut ck = vec![head, t(title)];
        if let Some(d) = s(it, "desc") {
            let mut spec = cx.t(Role::Body, format!("steps.{i}.desc"), d);
            spec.build = b;
            spec.color = cx.pal.muted;
            if few {
                spec.size = cx.fs_raw(Role::Body) * 1.2;
            }
            ck.push(t(spec));
        }
        // ::before: Linie über der Spalte (landet im Hintergrundbild)
        let line = match el {
            Elements::Plain => None,
            Elements::Line => Some((1., cx.pal.text)),
            Elements::Solid => Some((2., tk.border)),
        }
        .map(|(h, c)| Div::new(abs(Some(0.), Some(12.), Some(0.), None).h(h)).paint(c));
        let pt = if few {
            36.
        } else if el == Elements::Plain {
            0.
        } else {
            28.
        };
        let mut st = col(if few { 20. } else { 14. })
            .pad(pt, 12., if cx.tall { 12. } else { 4. }, 0.)
            .min_h0()
            .min_w0()
            .rel();
        st = if cx.tall { st.none() } else { st.grow() };
        kids.push(
            Div::new(st)
                .kids(line.into_iter().chain(ck))
                .boxel(bx(format!("_card.{i}"), b, None))
                .fit(&format!("_card.{i}"))
                .clip(),
        );
    }
    let mut st = if cx.tall { col(8.) } else { row(28.) }.items(AlignItems::STRETCH);
    st.margin.bottom = auto_lp();
    Ok(vec![header(cx, c, 2)?, Div::new(st).kids(kids)].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "So funktioniert es", "steps": [{ "title": "Anmelden" }, { "title": "Verbinden" }, { "title": "Loslegen" }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Vorgehen",
                "title": "Vom Erstgespräch zum Go-live in sechs Wochen",
                "steps": [
                    { "title": "Analyse", "desc": "Workshops mit allen Fachbereichen" },
                    { "title": "Konzept", "desc": "Zielbild und Umsetzungsplan" },
                    { "title": "Umsetzung", "desc": "Einrichtung und Datenübernahme" },
                    { "title": "Go-live", "desc": "Schulung und Begleitung im Betrieb" },
                ],
            }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(90, 0), "steps": rep(4, |i| json!({ "title": words(26, i), "desc": words(90, i + 1), "icon": "check" })) }),
        ),
    ]
}
