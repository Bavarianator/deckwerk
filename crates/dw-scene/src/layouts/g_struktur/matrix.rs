//! 2×2-Matrix (layouts-extra.tsx Matrix, layouts-extra.css „mx“): vier Quadranten, Punkte nach x/y in Prozent.

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::words_x as words;
use crate::Error;
use crate::blocks::*;
use crate::samples::rep;
use crate::tree::{BoxSpec, Div};

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &["split", "band"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn pct(v: f64) -> LengthPercentageAuto {
    LengthPercentageAuto::percent((v / 100.) as f32)
}

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let solid = el == Elements::Solid;
    let items = arr(c, "items");
    let quads = strs(c, "quadrants");
    let highlight = s(c, "highlight");

    let axis = |slot: &str, text: String| {
        let mut a = cx.t(Role::Small, slot, &text);
        a.weight = 700.;
        a.color = cx.pal.text;
        a
    };
    let mut plot = Vec::new();
    // el-plain: Achsenkreuz als zwei 1-px-Linien in der Mitte (Hintergrund)
    if el == Elements::Plain {
        let mut v = Style::DEFAULT;
        v.position = Position::Absolute;
        v.inset = Rect {
            left: pct(50.),
            right: auto_lp(),
            top: pxa(0.),
            bottom: pxa(0.),
        };
        v.size.width = Dimension::length(1.);
        v.margin.left = pxa(-0.5);
        let mut h = Style::DEFAULT;
        h.position = Position::Absolute;
        h.inset = Rect {
            left: pxa(0.),
            right: pxa(0.),
            top: pct(50.),
            bottom: auto_lp(),
        };
        h.size.height = Dimension::length(1.);
        h.margin.top = pxa(-0.5);
        plot.push(Div::new(v).paint(tk.border));
        plot.push(Div::new(h).paint(tk.border));
    }
    for i in 0..4 {
        let q1 = i == 1;
        let (align, justify) = match i {
            1 => (AlignItems::FLEX_START, JustifyContent::FLEX_END),
            2 => (AlignItems::FLEX_END, JustifyContent::FLEX_START),
            3 => (AlignItems::FLEX_END, JustifyContent::FLEX_END),
            _ => (AlignItems::FLEX_START, JustifyContent::FLEX_START),
        };
        let mut st = row(0.)
            .items(align)
            .justify(justify)
            .pad(12., if solid { 14. } else { 0. }, 12., if solid { 14. } else { 0. })
            .rel();
        if !solid {
            st = st.min_w0();
        }
        let fill = solid.then_some(if q1 { tk.accent_tint } else { tk.surface });
        let line = (el == Elements::Line).then(|| {
            if q1 {
                top_line(2., cx.pal.accent)
            } else {
                top_line(1., cx.pal.text)
            }
        });
        let label = quads.get(i).map(|q| {
            let mut l = cx.t(Role::Small, format!("quadrants.{i}"), q);
            l.weight = 700.;
            if q1 {
                l.color = if solid { cx.pal.text } else { cx.pal.accent };
            }
            t(l)
        });
        plot.push(
            Div::new(st)
                .kids(line.into_iter().chain(label))
                .boxel(BoxSpec {
                    radius: if solid { 4. } else { 0. },
                    ..bx(format!("_q.{i}"), None, fill)
                }),
        );
    }
    for (i, it) in items.iter().enumerate() {
        let b = Some(i as u32);
        let label = req(it, "label")?;
        let x = it.get("x").and_then(Value::as_f64).unwrap_or(0.);
        let y = it.get("y").and_then(Value::as_f64).unwrap_or(0.);
        let hl = highlight.is_none_or(|h| h == label);
        let up = y < 12.;
        let (align, side_m) = if x < 22. {
            (AlignItems::FLEX_START, Some(true))
        } else if x > 78. {
            (AlignItems::FLEX_END, Some(false))
        } else {
            (AlignItems::CENTER, None)
        };
        // translateY(-9px) bzw. (-100% + 9px): als Rand, „up“ von unten verankert
        let mut st = Style {
            position: Position::Absolute,
            display: Display::Flex,
            flex_direction: if up {
                FlexDirection::ColumnReverse
            } else {
                FlexDirection::Column
            },
            gap: Size {
                width: px(6.),
                height: px(6.),
            },
            align_items: align,
            ..Style::DEFAULT
        };
        st.size.width = Dimension::length(0.);
        st.inset.left = pct(x);
        if up {
            st.inset.bottom = pct(y);
            st.margin.bottom = pxa(-9.);
        } else {
            st.inset.top = pct(100. - y);
            st.margin.top = pxa(-9.);
        }
        let kid = |mut s: Style| {
            match side_m {
                Some(true) => s.margin.left = pxa(-9.),
                Some(false) => s.margin.right = pxa(-9.),
                None => {}
            }
            s
        };
        let dot = Div::new(kid(Style::DEFAULT.none().wh(18., 18.))).boxel(BoxSpec {
            ellipse: true,
            ..bx(
                format!("_dot.{i}"),
                b,
                Some(if hl { cx.pal.accent } else { cx.pal.muted }),
            )
        });
        let mut l = cx.t(Role::Small, format!("items.{i}.label"), label);
        l.build = b;
        l.nowrap = true;
        if hl && highlight.is_some() {
            l.weight = 700.;
        }
        plot.push(Div::new(st).kids([dot, t_styled(l, kid(Style::DEFAULT))]));
    }
    let two = if solid {
        vec![fr(1.), fr(1.)]
    } else {
        vec![minmax(length(0.), fr(1.)); 2]
    };
    let plot_st = Style {
        grid_template_columns: two,
        grid_template_rows: vec![fr(1.), fr(1.)],
        ..grid(4.)
    }
    .grow()
    .min_h0()
    .rel();
    let mut xs = Style::DEFAULT.none();
    xs.align_self = Some(AlignSelf::FLEX_END);
    let mut area_st = col(8.).min_h0();
    if !solid {
        area_st = area_st.min_w0();
    }
    let area = Div::new(area_st).kids([
        t_styled(
            axis("y", format!("↑ {}", req(c, "y")?)),
            Style::DEFAULT.none(),
        ),
        Div::new(plot_st).kids(plot),
        t_styled(axis("x", format!("{} →", req(c, "x")?)), xs),
    ]);
    let mut kids = vec![area];
    if let Some(take) = s(c, "takeaway") {
        let nb = Some(items.len() as u32);
        let mut tx = cx.t(Role::Body, "takeaway", take);
        tx.build = nb;
        let (pad, fill) = match el {
            Elements::Solid => ([32.; 4], Some(tk.surface)),
            Elements::Line => ([24., 0., 4., 0.], None),
            Elements::Plain => ([0., 0., 4., 0.], None),
        };
        let line = (el == Elements::Line).then(|| top_line(1., cx.pal.text));
        let mut st = col(14.)
            .pad(pad[0], pad[1], pad[2], pad[3])
            .min_w0()
            .min_h0()
            .rel();
        st.align_self = Some(AlignSelf::CENTER);
        kids.push(
            Div::new(st)
                .kids(line.into_iter().chain([t(tx)]))
                .boxel(BoxSpec {
                    radius: if fill.is_some() { tk.radius as f32 } else { 0. },
                    ..bx("_take", nb, fill)
                })
                .fit("_take")
                .clip(),
        );
    }
    let cols = if kids.len() > 1 && !cx.narrow {
        vec![fr(1.), length(300.)]
    } else {
        vec![fr(1.)]
    };
    let st = Style {
        grid_template_columns: cols,
        ..grid(40.)
    }
    .grow()
    .min_h0();
    Ok(vec![header(cx, c, 2)?, Div::new(st).kids(kids)].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Zwei Themen gehen zuerst", "x": "Nutzen", "y": "Machbarkeit", "items": [{ "label": "Self-Service", "x": 70, "y": 70 }, { "label": "Neues CRM", "x": 70, "y": 30 }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Priorisierung",
                "title": "Self-Service und Rechnungsprozess bringen den größten Nutzen bei wenig Aufwand",
                "x": "Nutzen für Kunden",
                "y": "Umsetzbarkeit",
                "quadrants": ["Später prüfen", "Sofort umsetzen", "Verwerfen", "Groß planen"],
                "items": [
                    { "label": "Self-Service-Portal", "x": 82, "y": 78 },
                    { "label": "Rechnungsprozess", "x": 64, "y": 88 },
                    { "label": "Chatbot", "x": 38, "y": 64 },
                    { "label": "Neues CRM", "x": 76, "y": 22 },
                    { "label": "Filialumbau", "x": 26, "y": 18 },
                ],
                "highlight": "Self-Service-Portal",
                "takeaway": "Zwei Vorhaben liegen klar im Zielquadranten und lassen sich mit bestehenden Teams bis Q2 umsetzen.",
            }),
        ),
        (
            "max",
            json!({
                "eyebrow": words(28, 0), "title": words(90, 0),
                "x": words(28, 0), "y": words(28, 1),
                "quadrants": rep(4, |i| json!(words(24, i))),
                "items": rep(8, |i| json!({ "label": words(22, i), "x": ([22, 50, 78][i % 3]), "y": ([72, 50, 28][i / 3]) })),
                "highlight": words(22, 3), "takeaway": words(140, 0),
            }),
        ),
    ]
}
