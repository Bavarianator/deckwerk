//! Pro und Contra (layouts-extra.tsx ProsCons, layouts-extra.css „pc“): zwei Listen, darunter das Urteil.

use dw_color::Rgb;
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
    let body = cx.fs_raw(Role::Body);
    let col_of = |k: &str, i: u32| {
        let pros = k == "pros";
        let b = Some(i);
        let lk = if pros { "prosLabel" } else { "consLabel" };
        let mut head = cx.t(
            Role::H2,
            lk,
            s(c, lk).unwrap_or(if pros { "Dafür" } else { "Dagegen" }),
        );
        head.build = b;
        let mut hst = Style::DEFAULT.min_w0();
        let mut hd = None;
        if el == Elements::Solid {
            hst = hst.pad(0., 0., 12., 0.);
            hst.border.bottom = px(2.);
            hd = Some(tk.border);
        }
        let mut h = t_styled(head, hst);
        h.border = hd;
        let mut kids = vec![h];
        let good = if pros { tk.good } else { tk.bad };
        for (j, p) in strs(c, k).iter().enumerate() {
            // Kreis mit Haken/Kreuz (solid), nur Zeichen in good/bad (line), nichts (plain)
            let badge = (el != Elements::Plain).then(|| {
                let (w, fill, ic) = match el {
                    Elements::Solid => (32., Some(good), Rgb::WHITE),
                    _ => (18., None, good),
                };
                Div::new(
                    row(0.)
                        .items(AlignItems::CENTER)
                        .justify(JustifyContent::CENTER)
                        .none()
                        .wh(w, 32.)
                        .mt(body * 0.69 - 16.),
                )
                .boxel(BoxSpec {
                    ellipse: true,
                    radius: w / 2.,
                    ..bx(format!("_pb.{k}.{j}"), b, fill)
                })
                .kids([icon(
                    format!("_pi.{k}.{j}"),
                    b,
                    if pros { "check" } else { "x" },
                    ic,
                    18.,
                )])
            });
            let mut spec = cx.t(Role::Body, format!("{k}.{j}"), p);
            spec.build = b;
            kids.push(
                Div::new(row(16.).items(AlignItems::FLEX_START))
                    .kids(badge.into_iter().chain([t_styled(spec, Style::DEFAULT.grow())])),
            );
        }
        let mut st = col(18.).min_w0();
        let mut d = None;
        if el == Elements::Line {
            st = st.pad(20., 0., 0., 0.);
            st.border.top = px(1.);
            d = Some(cx.pal.text);
        }
        let mut dv = Div::new(st).kids(kids);
        dv.border = d;
        dv
    };
    let cols = Div::new(Style {
        grid_template_columns: vec![minmax(length(0.), fr(1.)); if cx.narrow { 1 } else { 2 }],
        ..grid(56.)
    })
    .kids([col_of("pros", 0), col_of("cons", 1)]);
    let mut kids = vec![cols];
    if let Some(v) = s(c, "verdict") {
        let b = Some(2);
        let (cv, st, fill) = match el {
            Elements::Solid => (cx.on_fill(), (22., 28., 22., 28.), Some(tk.fill)),
            Elements::Line => (cx.clone(), (22., 0., 4., 0.), None),
            Elements::Plain => (cx.clone(), (0., 0., 4., 0.), None),
        };
        let color = if el == Elements::Solid { cv.pal.text } else { cx.pal.accent };
        let mut spec = cv.t(Role::H3, "verdict", v);
        spec.build = b;
        spec.color = color;
        let mut vs = row(18.).items(AlignItems::CENTER).pad(st.0, st.1, st.2, st.3).rel();
        if el == Elements::Plain {
            vs = vs.mt(16.);
        }
        let line = (el == Elements::Line).then(|| top_line(2., cx.pal.accent));
        kids.push(
            Div::new(vs)
                .boxel(BoxSpec {
                    radius: if fill.is_some() { tk.radius as f32 } else { 0. },
                    ..bx("_verdict", b, fill)
                })
                .kids(line.into_iter().chain([
                    icon("_vi".into(), b, "scale", color, 26.),
                    t(spec),
                ])),
        );
    }
    let pc = Div::new(col(24.).grow().min_h0()).kids(kids).fit("pros").clip();
    Ok(vec![header(cx, c, 2)?, pc].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Der Umzug lohnt sich", "pros": ["Mehr Platz", "Bessere Lage"], "cons": ["Höhere Miete", "Umzugskosten"] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Abwägung", "title": "Der zweite Standort lohnt sich trotz höherer Miete",
                "pros": ["60 zusätzliche Plätze in der Innenstadt", "Mittagsgeschäft mit Büros in Laufweite", "Küche entlastet den Stammladen"],
                "cons": ["Miete 38 % über dem Stammladen", "Sechs neue Stellen im Service", "Umbau dauert vier Monate"],
                "verdict": "Ab 140 Gästen am Tag trägt sich der Standort – der Stammladen schafft heute 190.",
            }),
        ),
        (
            "max",
            json!({
                "eyebrow": words_x(28, 0), "title": words_x(90, 0), "prosLabel": words_x(20, 0), "consLabel": words_x(20, 2),
                "pros": rep(4, |i| json!(words_x(70, i))), "cons": rep(4, |i| json!(words_x(70, i + 3))), "verdict": words_x(120, 0),
            }),
        ),
    ]
}
