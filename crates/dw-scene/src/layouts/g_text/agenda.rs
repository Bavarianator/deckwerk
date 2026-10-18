//! Agenda (layouts.tsx Agenda, slide.css „agenda“ und Bauteile el-*): Titel links, nummerierte Punkte rechts.

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::{baseline, baseline_row};
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::{BoxSpec, Div};

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let items = arr(c, "items");
    let n = items.len();
    // wenige Punkte: große Nummern, Beschreibung in Textgröße
    let few = n <= 4;
    let active = c.get("active").and_then(Value::as_u64).map(|a| a as usize);
    let mut title = cx.t(Role::H1, "title", req(c, "title")?);
    title.max_lines = Some(2);
    let side = Div::new(col(0.).pad(18., 0., 0., 0.)).kids([t(title)]);

    let mut rows = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let b = Some(i as u32);
        let on = active == Some(i);
        let mut num = cx.t(
            if few { Role::Kpi } else { Role::H2 },
            format!("_num.{i}"),
            &format!("{:02}", i + 1),
        );
        num.build = b;
        num.color = cx.pal.accent;
        if few {
            num.weight = 400.;
        }
        match el {
            Elements::Line => {
                num.size = cx.fs_raw(Role::Label);
                num.lh = 1.32;
            }
            Elements::Plain => {
                num.weight = 400.;
                num.color = cx.pal.muted;
                if !few {
                    num.size = cx.fs_raw(Role::H2) * 1.6;
                    num.lh = 1.;
                }
            }
            Elements::Solid => {}
        }
        let mut head = cx.t(Role::H2, format!("items.{i}.title"), req(it, "title")?);
        head.build = b;
        if on && el != Elements::Solid {
            head.color = cx.pal.accent;
        }
        let (bl_num, bl_head) = (baseline(&num), baseline(&head));
        let mut texts = vec![t(head)];
        if let Some(d) = s(it, "desc") {
            let mut spec = cx.t(
                if few { Role::Body } else { Role::Small },
                format!("items.{i}.desc"),
                d,
            );
            spec.build = b;
            texts.push(t(spec));
        }
        let w = num.size * 1.7;
        let mut num_st = Style::DEFAULT.none();
        num_st.size.width = Dimension::length(w);
        let num = t_styled(num, num_st);
        let text = Div::new(col(4.).grow().min_w0()).kids(texts);
        // few: Nummer mittig zu Titel und Beschreibung; line setzt die kleine Nummer auf die Grundlinie
        let centered = few && el != Elements::Line;
        let pv = if few { 22. } else { 18. };
        let mut st = row(28.).pad(pv, 24., pv, 24.).items(if centered {
            AlignItems::CENTER
        } else {
            AlignItems::FLEX_START
        });
        st.border.bottom = px(1.);
        let kids = if centered {
            vec![num, text]
        } else {
            baseline_row(vec![(num, 0., bl_num), (text, 0., bl_head)])
        };
        let mut d = Div::new(st);
        if on {
            d.style = d.style.rel();
            if el == Elements::Line {
                let mut bar = abs(Some(0.), None, Some(18.), Some(18.));
                bar.size.width = Dimension::length(2.);
                d = d.kids([Div::new(bar).paint(cx.pal.accent)]);
            }
            let solid = el == Elements::Solid;
            d = d.boxel(BoxSpec {
                radius: if solid { tk.radius as f32 } else { 0. },
                ..bx("_active", b, solid.then_some(tk.accent_tint))
            });
        } else if i + 1 < n && el != Elements::Plain {
            d.border = Some(tk.border);
        }
        rows.push(d.kids(kids));
    }
    let list = Div::new(col(0.).min_h0()).kids(rows).fit("items").clip();
    let st = Style {
        grid_template_columns: if cx.narrow {
            vec![fr(1.)]
        } else {
            vec![length(320.), fr(1.)]
        },
        ..grid(if cx.narrow { 28. } else { 64. })
    }
    .grow()
    .min_h0();
    Ok(vec![Div::new(st).kids([side, list])].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Agenda", "items": [{ "title": "Ausgangslage" }, { "title": "Lösung" }, { "title": "Nächste Schritte" }] }),
        ),
        (
            "typ",
            json!({
                "title": "Agenda",
                "items": [
                    { "title": "Ausgangslage", "desc": "Wo wir heute stehen" },
                    { "title": "Marktchance", "desc": "Warum jetzt der richtige Zeitpunkt ist" },
                    { "title": "Unser Plan", "desc": "Drei Hebel für Wachstum" },
                    { "title": "Investition & Ask", "desc": "Was wir brauchen" },
                ],
                "active": 1,
            }),
        ),
        (
            "max",
            json!({ "title": words(30, 0), "items": rep(6, |i| json!({ "title": words(40, i), "desc": words(70, i + 2) })) }),
        ),
    ]
}
