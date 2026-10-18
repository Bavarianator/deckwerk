//! Optionsvergleich (layouts-extra.tsx Options, layouts-extra.css „opt“): Kriterien × Optionen mit Harvey Balls.

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::words_x as words;
use crate::Error;
use crate::blocks::*;
use crate::samples::rep;
use crate::tree::{BoxSpec, Div, Fill, Kind};

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &["band"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn at(mut st: Style, col: usize, row: usize) -> Style {
    st.grid_column = Line {
        start: line(col as i16 + 1),
        end: span(1),
    };
    st.grid_row = Line {
        start: line(row as i16 + 1),
        end: span(1),
    };
    st
}

/// Harvey Ball 0–4 (svg 30 × 30, Kreis r 13 im 32er-Raster, Strich 2, Sektor ab 12 Uhr im Uhrzeigersinn).
/// Ring als Icon (Slot icon:…), die Viertel als harte radiale Flächen im Hintergrundbild (ohne eigenen Slot).
fn harvey(cx: &Cx, slot: String, score: f64, build: Option<u32>) -> Div {
    let q = score.round().clamp(0., 4.) as usize;
    let c = cx.pal.text;
    let col = dw_model::Color {
        r: c.r,
        g: c.g,
        b: c.b,
        a: 255,
    };
    let clear = dw_model::Color { a: 0, ..col };
    // Radius 13/32 × 30 relativ zur Ecken-Entfernung (farthest-corner) der 15er-Viertel bzw. der ganzen Box
    let stop = (13. * 30. / 32.) / (15. * std::f32::consts::SQRT_2);
    let disc = |l: f32, t: f32, w: f32, center: (f64, f64)| {
        Div::new(abs(Some(l), None, Some(t), None).wh(w, w)).paint(Fill::Radial(
            center,
            vec![(stop, col), (stop, clear)],
        ))
    };
    let mut kids: Vec<Div> = match q {
        4 => vec![disc(0., 0., 30., (0.5, 0.5))],
        _ => [
            disc(15., 0., 15., (0., 1.)),
            disc(15., 15., 15., (0., 0.)),
            disc(0., 15., 15., (1., 0.)),
        ]
        .into_iter()
        .take(q)
        .collect(),
    };
    // lucide circle: r 10 im 24er-Raster (12,5 px statt 12,2), Strich 1,5 × 30/24 ≈ 2 × 30/32
    kids.push(Div {
        kind: Kind::Icon {
            slot,
            build,
            name: "circle".into(),
            color: c,
            stroke: 1.5,
        },
        ..Div::new(abs(Some(0.), None, Some(0.), None).wh(30., 30.))
    });
    Div::new(Style::DEFAULT.none().wh(30., 30.).rel()).kids(kids)
}

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let b0 = Some(0);
    let crit = strs(c, "criteria");
    let opts = arr(c, "options");
    let rec = c
        .get("recommended")
        .and_then(Value::as_u64)
        .map(|r| r as usize)
        .filter(|&r| r < opts.len());
    let rows = crit.len() + 2; // Kopf, Kriterien, Fazit
    let mut kids = Vec::new();
    if let Some(r) = rec {
        let mut st = Style::DEFAULT.rel();
        st.grid_column = Line {
            start: line(r as i16 + 2),
            end: span(1),
        };
        st.grid_row = Line {
            start: line(1),
            end: line(rows as i16 + 1),
        };
        let (border, radius) = match el {
            Elements::Solid => {
                st = st.mt(-8.);
                st.border = Rect {
                    left: px(2.),
                    right: px(2.),
                    top: px(2.),
                    bottom: px(2.),
                };
                (Some((cx.pal.accent, 2.)), tk.radius as f32)
            }
            _ => (None, 0.),
        };
        let line = (el == Elements::Line).then(|| top_line(2., cx.pal.accent));
        kids.push(Div::new(st).kids(line).boxel(BoxSpec {
            border,
            radius,
            ..bx("_rec", None, None)
        }));
    }
    for (j, o) in opts.iter().enumerate() {
        let hl = Some(j) == rec;
        let mut hk = Vec::new();
        if hl {
            let mut e = cx.t(Role::Eyebrow, "_badge.text", "Empfehlung");
            e.tracking_em = 0.1;
            e.color = if el == Elements::Solid {
                tk.on_accent
            } else {
                cx.pal.accent
            };
            e.center = true;
            let (st, fill) = if el == Elements::Solid {
                (Style::DEFAULT.pad(5., 12., 5., 12.), Some(tk.fill))
            } else {
                (Style::DEFAULT, None)
            };
            hk.push(Div::new(st).kids([t(e)]).boxel(BoxSpec {
                radius: if fill.is_some() { 999. } else { 0. },
                ..bx("_badge", None, fill)
            }));
        }
        let mut name = cx.t(Role::H3, format!("options.{j}.name"), req(o, "name")?);
        name.build = b0;
        name.center = true;
        if hl && el != Elements::Solid {
            name.color = cx.pal.accent;
        }
        hk.push(t(name));
        let mut st = col(10.)
            .items(AlignItems::CENTER)
            .justify(JustifyContent::FLEX_END)
            .pad(14., 12., 14., 12.);
        st.border.bottom = px(1.5);
        let mut head = Div::new(at(st, j + 1, 0)).kids(hk);
        head.border = Some(cx.pal.text);
        kids.push(head);
    }
    let rule = |mut st: Style| {
        if el != Elements::Plain {
            st.border.bottom = px(1.);
        }
        st
    };
    for (i, k) in crit.iter().enumerate() {
        let mut l = cx.t(Role::Label, format!("criteria.{i}"), k);
        l.build = b0;
        let st = rule(row(0.).items(AlignItems::CENTER).pad(0., 12., 0., 2.));
        let mut d = Div::new(at(st, 0, i + 1)).kids([t(l)]);
        d.border = Some(tk.border);
        kids.push(d);
    }
    for (j, o) in opts.iter().enumerate() {
        let scores = o.get("scores").and_then(Value::as_array);
        for i in 0..crit.len() {
            let sc = scores
                .and_then(|a| a.get(i))
                .and_then(Value::as_f64)
                .unwrap_or(0.);
            let st = rule(Style {
                display: Display::Grid,
                align_items: AlignItems::CENTER,
                justify_items: AlignItems::CENTER,
                align_content: AlignContent::CENTER,
                justify_content: JustifyContent::CENTER,
                ..Style::DEFAULT
            });
            let mut d = Div::new(at(st, j + 1, i + 1)).kids([harvey(
                cx,
                format!("options.{j}.scores.{i}"),
                sc,
                b0,
            )]);
            d.border = Some(tk.border);
            kids.push(d);
        }
    }
    for (j, o) in opts.iter().enumerate() {
        if let Some(note) = s(o, "note") {
            let mut n = cx.t(Role::Small, format!("options.{j}.note"), note);
            n.build = b0;
            n.center = true;
            kids.push(Div::new(at(col(0.).pad(14., 12., 12., 12.), j + 1, rows - 1)).kids([t(n)]));
        }
    }
    let cols = if cx.narrow {
        vec![fr(1.)]
    } else {
        let mut v = vec![fr(1.3)];
        v.push(repeat(opts.len() as u16, vec![fr(1.)]));
        v
    };
    let st = Style {
        grid_template_columns: cols,
        grid_template_rows: vec![
            auto(),
            repeat(crit.len().max(1) as u16, vec![fr(1.)]),
            auto(),
        ],
        gap: Size {
            width: px(14.),
            height: px(0.),
        },
        ..Style::DEFAULT
    };
    let st = Style {
        display: Display::Grid,
        ..st
    }
    .grow()
    .min_h0();
    Ok(vec![header(cx, c, 2)?, Div::new(st).kids(kids).fit("options")].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Option B ist die bessere Wahl", "criteria": ["Kosten", "Tempo"], "options": [{ "name": "Option A", "scores": [2, 1] }, { "name": "Option B", "scores": [3, 4] }], "recommended": 1 }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Entscheidung",
                "title": "Die Partnerlösung bringt uns am schnellsten und günstigsten ans Ziel",
                "criteria": ["Zeit bis zum Start", "Kosten im ersten Jahr", "Kontrolle über Daten", "Risiko"],
                "options": [
                    { "name": "Eigenentwicklung", "scores": [1, 1, 4, 2], "note": "Volle Kontrolle, aber 14 Monate Vorlauf" },
                    { "name": "Partnerlösung", "scores": [4, 3, 3, 3], "note": "Start in 8 Wochen, Daten bleiben in DE" },
                    { "name": "Zukauf", "scores": [3, 0, 2, 1], "note": "Schnell, aber teuer und schwer integrierbar" },
                ],
                "recommended": 1,
            }),
        ),
        (
            "max",
            json!({
                "eyebrow": words(28, 0), "title": words(90, 0), "criteria": rep(6, |i| json!(words(32, i))),
                "options": rep(3, |i| json!({ "name": words(24, i), "scores": rep(6, |j| json!((i + j) % 5)), "note": words(70, i + 1) })),
                "recommended": 2,
            }),
        ),
    ]
}
