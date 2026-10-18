//! Problem und Lösung (layouts-extra.tsx ProblemSolution, layouts-extra.css „psol“): zwei Karten, Pfeil dazwischen.

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::words_x;
use crate::Error;
use crate::blocks::*;
use crate::samples::rep;
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
    let solid = el == Elements::Solid;
    let empty = Value::Null;
    let body = cx.fs_raw(Role::Body);
    let card = |k: &str, i: u32| {
        let sol = k == "solution";
        let b = Some(i);
        let sv = c.get(k).unwrap_or(&empty);
        // solid: Lösung auf der Akzentfläche (--accent = onAccent), Problem auf surface2
        let cc = if sol && solid { cx.on_fill() } else { cx.clone() };
        let mut eb = cc.t(
            Role::Eyebrow,
            format!("{k}.heading"),
            s(sv, "heading").unwrap_or(if sol { "Mit uns" } else { "Heute" }),
        );
        eb.build = b;
        eb.color = if !sol {
            cc.pal.text
        } else if solid {
            cc.pal.muted
        } else {
            cx.pal.accent
        };
        let mut kids = vec![t(eb)];
        if let Some(tx) = s(sv, "text") {
            let mut h = cc.t(Role::H2, format!("{k}.text"), tx);
            h.build = b;
            h.color = if !sol {
                cc.pal.muted
            } else if solid {
                cc.pal.text
            } else {
                cx.pal.accent
            };
            kids.push(t(h));
        }
        let dot = if sol { cc.pal.accent } else { cc.pal.text };
        for (j, p) in strs(sv, "points").iter().enumerate() {
            let mark = match el {
                Elements::Plain => None,
                Elements::Line => Some(
                    Div::new(Style::DEFAULT.none().wh(14., 2.).mt(body * 0.69 - 1.))
                        .boxel(bx(format!("_pd.{k}.{j}"), b, Some(dot))),
                ),
                Elements::Solid => Some(
                    Div::new(Style::DEFAULT.none().wh(8., 8.).mt(body * 0.69 - 4.)).boxel(BoxSpec {
                        ellipse: true,
                        radius: 4.,
                        ..bx(format!("_pd.{k}.{j}"), b, Some(cc.pal.accent))
                    }),
                ),
            };
            let mut spec = cc.t(Role::Body, format!("{k}.points.{j}"), p);
            spec.build = b;
            kids.push(
                Div::new(row(14.).items(AlignItems::FLEX_START))
                    .kids(mark.into_iter().chain([t_styled(spec, Style::DEFAULT.grow())])),
            );
        }
        let (pad, fill) = match el {
            // .ps-card (padding 40 36, gap 18) verliert gegen .card aus slide.css, das später geladen wird
            Elements::Solid => (
                (32., 32., 32., 32.),
                Some(if sol { tk.fill } else { tk.surface2 }),
            ),
            Elements::Line => ((28., 0., 4., 0.), None),
            Elements::Plain => ((0., 0., 4., 0.), None),
        };
        let mut st = col(14.)
            .pad(pad.0, pad.1, pad.2, pad.3)
            .justify(if solid {
                JustifyContent::CENTER
            } else {
                JustifyContent::FLEX_START
            })
            .min_w0()
            .min_h0()
            .rel();
        st.align_self = Some(AlignSelf::STRETCH);
        let line = (el == Elements::Line).then(|| {
            if sol {
                top_line(2., cx.pal.accent)
            } else {
                top_line(1., cx.pal.text)
            }
        });
        let slot = format!("_card.{k}");
        Div::new(st)
            .kids(line.into_iter().chain(kids))
            .boxel(BoxSpec {
                radius: if fill.is_some() { tk.radius as f32 } else { 0. },
                ..bx(slot.clone(), b, fill)
            })
            .fit(&slot)
            .clip()
    };
    let (abg, afg) = if solid {
        (Some(cx.pal.text), tk.bg)
    } else {
        (None, cx.pal.muted)
    };
    let arrow = Div::new(
        row(0.)
            .items(AlignItems::CENTER)
            .justify(JustifyContent::CENTER)
            .wh(64., 64.),
    )
    .boxel(BoxSpec {
        ellipse: true,
        radius: 32.,
        ..bx("_arrow", Some(1), abg)
    })
    .kids([icon("_arrow.icon".into(), Some(1), "arrow-right", afg, 28.)]);
    let st = Style {
        grid_template_columns: if cx.narrow {
            vec![fr(1.)]
        } else {
            vec![fr(1.), length(64.), fr(1.)]
        },
        align_items: AlignItems::CENTER,
        // line/plain: Zeile so hoch wie der Inhalt, mittig (align-content: safe center)
        align_content: if solid {
            AlignContent::NORMAL
        } else {
            AlignContent::SAFE_CENTER
        },
        ..grid(20.)
    }
    .grow()
    .min_h0();
    Ok(vec![
        header(cx, c, 2)?,
        Div::new(st).kids([card("problem", 0), arrow, card("solution", 1)]),
    ]
    .into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Aus Papier wird digital", "problem": { "text": "Formulare auf Papier" }, "solution": { "text": "Ein Klick im Portal" } }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Unser Ansatz", "title": "Aus drei Wochen Papierweg wird ein Antrag in zehn Minuten",
                "problem": { "heading": "Heute", "text": "Anträge wandern per Hauspost durch vier Abteilungen.", "points": ["Ø 21 Tage Bearbeitung", "Jeder fünfte Antrag unvollständig", "Kein Status für Bürger"] },
                "solution": { "heading": "Mit dem Portal", "text": "Bürger stellen den Antrag online, das System prüft sofort.", "points": ["Ø 10 Minuten bis zur Eingangsbestätigung", "Pflichtfelder verhindern Lücken", "Status jederzeit online"] },
            }),
        ),
        (
            "max",
            json!({
                "eyebrow": words_x(28, 0), "title": words_x(90, 0),
                "problem": { "heading": words_x(28, 0), "text": words_x(140, 0), "points": rep(3, |i| json!(words_x(70, i))) },
                "solution": { "heading": words_x(28, 1), "text": words_x(140, 2), "points": rep(3, |i| json!(words_x(70, i + 2))) },
            }),
        ),
    ]
}
