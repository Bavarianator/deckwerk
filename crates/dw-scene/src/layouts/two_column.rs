//! Zwei Spalten (layouts.tsx TwoColumn, slide.css „two columns“ und Bauteile el-*).

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::{BoxSpec, Div};

pub const VARIANTS: &[&str] = &["rule", "equal", "highlight-right"];

pub const DEF: Def = Def {
    footer: true,
    frames: &["band"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let empty = Value::Null;
    let side = |k: &str| c.get(k).unwrap_or(&empty);
    let (l, r) = (side("left"), side("right"));
    let len = |s: &str| s.encode_utf16().count();
    // wenig Inhalt je Spalte: größer und luftiger
    let few = cx.wide()
        && longest_word(&[req(l, "heading")?, req(r, "heading")?]) <= 20
        && [l, r].iter().all(|col| {
            let p = strs(col, "points");
            p.len() <= 3 && len(s(col, "text").unwrap_or_default()) + len(&p.concat()) <= 160
        });
    let card = matches!(v, Some("equal") | Some("highlight-right"));
    let kb = if few { 1.15 } else { 1. };
    let mut cols = Vec::new();
    for (i, (k, colv)) in [("left", l), ("right", r)].into_iter().enumerate() {
        let b = Some(i as u32);
        let hl = v == Some("highlight-right") && k == "right";
        // solid: hervorgehobene Karte auf der Akzentfläche; line/plain: Text wie auf der Folie, Kopf in Akzent
        let fill = match el {
            Elements::Solid if hl => Some(tk.fill),
            Elements::Solid if card => Some(tk.surface),
            _ => None,
        };
        let cc = if hl && el == Elements::Solid {
            cx.on_fill()
        } else {
            cx.clone()
        };
        let mut head = cc.t(Role::H2, format!("{k}.heading"), req(colv, "heading")?);
        head.build = b;
        if few {
            head.size *= 1.3;
        }
        if hl && el != Elements::Solid {
            head.color = cx.pal.accent;
        }
        let line = match (el, card) {
            (Elements::Plain, _) => None,
            (Elements::Line, _) if hl => Some(top_line(2., cx.pal.accent)),
            (Elements::Line, _) => Some(top_line(1., cx.pal.text)),
            (Elements::Solid, false) => Some(top_line(4., cx.pal.text)),
            (Elements::Solid, true) => None,
        };
        let mut kids: Vec<Div> = line.into_iter().collect();
        kids.push(t(head));
        if let Some(text) = s(colv, "text") {
            let mut spec = cc.t(Role::Body, format!("{k}.text"), text);
            spec.build = b;
            spec.size *= kb;
            kids.push(t(spec));
        }
        kids.extend(points(
            &cc,
            &strs(colv, "points"),
            &format!("{k}.points"),
            b,
            kb,
            if few { 20. } else { 10. },
            cc.pal.accent,
        ));
        let top = if few { 36. } else { 28. };
        let pad = match (el, card) {
            (Elements::Plain, _) => (0., 0., 4., 0.),
            (Elements::Solid, true) if few => (36., 32., 36., 32.),
            (Elements::Solid, true) => (20., 28., 20., 28.),
            _ => (top, 0., 4., 0.),
        };
        let mut st = col(if few { 22. } else { 14. })
            .pad(pad.0, pad.1, pad.2, pad.3)
            .rel();
        if card {
            st = st.min_w0().min_h0();
        }
        let radius = if fill.is_some() { tk.radius as f32 } else { 0. };
        let mut d = Div::new(st)
            .kids(kids)
            .boxel(BoxSpec {
                radius,
                ..bx(format!("_card.{k}"), b, fill)
            })
            .fit(&format!("_card.{k}"));
        if card {
            d = d.clip();
        }
        cols.push(d);
    }
    let st = Style {
        grid_template_columns: if cx.narrow {
            vec![fr(1.)]
        } else {
            vec![fr(1.), fr(1.)]
        },
        grid_auto_rows: vec![minmax(length(0.), taffy::style_helpers::auto())],
        align_content: AlignContent::START,
        ..grid(28.)
    }
    .grow()
    .min_h0();
    Ok(vec![header(cx, c, 2)?, Div::new(st).kids(cols)].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Heute gegenüber morgen", "left": { "heading": "Heute" }, "right": { "heading": "Morgen" } }),
        ),
        (
            "typ",
            json!({
                "title": "Die neue Plattform halbiert den manuellen Aufwand",
                "left": { "heading": "Heute", "points": ["6 Systeme, keine Schnittstellen", "Berichte per Excel", "3 Tage bis zur Freigabe"] },
                "right": { "heading": "Mit Deckwerk", "points": ["Eine Plattform für alles", "Berichte in Echtzeit", "Freigabe in 2 Stunden"] },
            }),
        ),
        (
            "max",
            json!({
                "eyebrow": words(28, 0), "title": words(90, 0),
                "left": { "heading": words(40, 0), "text": words(200, 0), "points": rep(4, |i| json!(words(64, i))) },
                "right": { "heading": words(40, 2), "text": words(200, 3), "points": rep(4, |i| json!(words(64, i + 1))) },
            }),
        ),
    ]
}
