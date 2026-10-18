//! Executive Summary (layouts-extra.tsx Summary, layouts-extra.css „sum“): nummerierte Kernaussagen, Empfehlung rechts.

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::{baseline, baseline_row, words_x};
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

fn build(cx: &Cx, c: &Value, _: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let points = arr(c, "points");
    let last = points.len() as u32;
    let mut rows = Vec::new();
    for (i, p) in points.iter().enumerate() {
        let b = Some(i as u32);
        let mut num = cx.t(Role::H2, format!("_n.{i}"), &format!("{:02}", i + 1));
        num.build = b;
        num.color = cx.pal.accent;
        let mut num_st = Style::DEFAULT.none();
        num_st.size.width = Dimension::length(48.);
        let mut mt = 0.;
        match el {
            Elements::Line => {
                num.size = cx.fs_raw(Role::Label);
                num.weight = 700.;
            }
            Elements::Plain => {
                num_st.size.width = Dimension::auto();
                num.size = cx.fs_raw(Role::H2) * 1.6;
                mt = -0.3 * num.size;
                num.weight = 400.;
                num.lh = 1.;
                num.color = cx.pal.muted;
            }
            Elements::Solid => {}
        }
        let mut title = cx.t(Role::H3, format!("points.{i}.title"), req(p, "title")?);
        title.build = b;
        let (bl_num, bl_title) = (baseline(&num), baseline(&title));
        let mut texts = vec![t(title)];
        if let Some(x) = s(p, "text") {
            let mut spec = cx.t(Role::Small, format!("points.{i}.text"), x);
            spec.build = b;
            texts.push(t(spec));
        }
        let mut st = row(28.).pad(14., 0., 14., 0.).items(AlignItems::FLEX_START);
        let mut d = Div::new(st.clone());
        if el != Elements::Plain {
            st.border.top = px(1.);
            if i + 1 == points.len() {
                st.border.bottom = px(1.);
            }
            d = Div::new(st);
            d.border = Some(tk.border);
        }
        rows.push(d.kids(baseline_row(vec![
            (t_styled(num, num_st), mt, bl_num),
            (Div::new(col(6.).grow().min_w0()).kids(texts), 0., bl_title),
        ])));
    }
    let list = Div::new(col(0.).min_h0().justify(JustifyContent::CENTER))
        .kids(rows)
        .fit("points")
        .clip();
    let rec = s(c, "recommendation").map(|r| {
        let solid = el == Elements::Solid;
        let cr = if solid { cx.on_fill() } else { cx.clone() };
        let mut label = cr.t(Role::Eyebrow, "_rec.label", "Empfehlung");
        label.build = Some(last);
        label.color = if solid { tk.on_accent } else { cx.pal.accent };
        let mut body = cr.t(Role::Body, "recommendation", r);
        body.build = Some(last);
        let pad = match el {
            Elements::Solid => (32., 32., 32., 32.),
            Elements::Line => (24., 0., 4., 0.),
            Elements::Plain => (0., 0., 4., 0.),
        };
        let mut st = col(14.).pad(pad.0, pad.1, pad.2, pad.3).rel();
        st.align_self = Some(AlignSelf::CENTER);
        let line = (el == Elements::Line).then(|| top_line(2., cx.pal.accent));
        Div::new(st)
            .kids(line.into_iter().chain([t(label), t(body)]))
            .boxel(BoxSpec {
                radius: if solid { tk.radius as f32 } else { 0. },
                ..bx("_rec", Some(last), solid.then_some(tk.fill))
            })
            .fit("_rec")
    });
    let st = Style {
        grid_template_columns: if rec.is_some() && !cx.narrow {
            vec![fr(1.), length(340.)]
        } else {
            vec![fr(1.)]
        },
        ..grid(44.)
    }
    .grow()
    .min_h0();
    Ok(vec![
        header(cx, c, 2)?,
        Div::new(st).kids([list].into_iter().chain(rec)),
    ]
    .into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Wir empfehlen den Pilot", "points": [{ "title": "Der Bedarf ist belegt" }, { "title": "Das Risiko ist begrenzt" }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Executive Summary",
                "title": "Wir empfehlen, den Pilot im November mit 20 Schulen zu starten",
                "points": [
                    { "title": "Jedes vierte Kind hat erhebliche Rechtschreibschwächen", "text": "Lehrkräfte fehlt die Zeit für Einzelförderung – der Bedarf wächst." },
                    { "title": "Ortho-Bot senkt die Fehlerquote in sechs Monaten um 41 %", "text": "Pilot mit 6 Schulen und 412 Kindern, bei gleicher Unterrichtszeit." },
                    { "title": "Eine Schullizenz kostet weniger als ein Klassensatz Hefte", "text": "1.900 € pro Jahr statt rund 2.400 € für Arbeitshefte." },
                ],
                "recommendation": "Pilot mit 20 Partnerschulen ab November freigeben – Budget 38.000 €, Entscheidung bis 15. Oktober.",
            }),
        ),
        (
            "max",
            json!({ "eyebrow": words_x(28, 0), "title": words_x(90, 0), "points": rep(4, |i| json!({ "title": words_x(80, i), "text": words_x(130, i + 2) })), "recommendation": words_x(150, 3) }),
        ),
    ]
}
