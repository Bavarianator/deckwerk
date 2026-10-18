//! Kennzahlen (layouts.tsx KpiGrid, slide.css „kpis“): Zahlenzeile mit Trennlinien (plain) oder Karten (cards).

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::Div;

pub const VARIANTS: &[&str] = &["plain", "cards"];

pub const DEF: Def = Def {
    footer: true,
    frames: &["band", "center"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let kpis = arr(c, "kpis");
    let n = kpis.len();
    let plain = v != Some("cards");
    let f = c
        .get("focus")
        .and_then(Value::as_i64)
        .unwrap_or(if plain { 0 } else { -1 });
    let focus = (f >= 0 && (f as usize) < n).then_some(f as usize);
    let fr_: Vec<f32> = (0..n)
        .map(|i| if Some(i) == focus { 1.3 } else { 1. })
        .collect();
    let k = columns(cx, n, Stack::Kpis);
    let label_role = if n <= 3 { Role::Body } else { Role::Label };
    let kpi = cx.fs_raw(Role::Kpi);
    let vals = kpis
        .iter()
        .enumerate()
        .map(|(i, it)| {
            let mut val = cx.t(Role::Kpi, format!("kpis.{i}.value"), req(it, "value")?);
            val.unit = true;
            val.build = Some(i as u32);
            val.color = if Some(i) == focus { cx.pal.accent } else { cx.pal.text };
            if Some(i) == focus {
                val.size = kpi * 1.5;
            }
            Ok(val)
        })
        .collect::<Result<Vec<_>, Error>>()?;
    let mut kids = Vec::new();
    for (i, it) in kpis.iter().enumerate() {
        let b = Some(i as u32);
        let hl = Some(i) == focus;
        if plain {
            // .kpi-plain: Raster mit justify-content: flex-start, also eine auto-Spalte so breit wie der breiteste
            // Inhalt. subgrid (Zeilen über alle Karten einer Reihe gleich) ohne taffy-subgrid: Zeile 1 fest auf die
            // höchste Kennzahl der Reihe, die Label-Zeile füllt die gestreckte Karte, das Delta steht unten.
            let row_of = |j: usize| j / k;
            let bl: Vec<(f32, f32)> = vals
                .iter()
                .map(|v| (super::super::g_text::baseline(v), v.line_height_px()))
                .collect();
            let peers = || (0..n).filter(|&j| row_of(j) == row_of(i));
            let top = peers().map(|j| bl[j].0).fold(0., f32::max);
            let r1 = peers().map(|j| top - bl[j].0 + bl[j].1).fold(0., f32::max);
            let (pl, pr) = (if i == 0 { 0. } else { 28. }, 28.);
            let rule = (i > 0 && el != Elements::Plain).then(|| {
                let mut st = abs(Some(0.), None, Some(8.), Some(8.));
                st.size.width = Dimension::length(2.);
                Div::new(st).boxel(bx(format!("_rule.{i}"), b, Some(tk.border)))
            });
            let mut st = grid(10.).rel().min_w0().pad(8., pr, 8., pl);
            st.grid_template_columns = vec![taffy::style_helpers::auto()];
            st.grid_template_rows = vec![length(r1), fr(1.), taffy::style_helpers::auto()];
            st.justify_content = JustifyContent::START;
            st.align_content = AlignContent::START;
            let mut lab = cx.t(label_role, format!("kpis.{i}.label"), req(it, "label")?);
            lab.build = b;
            let mut ck = vec![
                t_styled(
                    vals[i].clone(),
                    Style {
                        align_self: Some(AlignItems::START),
                        ..Style::DEFAULT.mt(top - bl[i].0)
                    },
                ),
                t(lab),
            ];
            match s(it, "delta") {
                Some(d) => ck.push(kpi_delta(cx, i, d, s(it, "sentiment"), b)),
                // leere dritte subgrid-Zeile: nur die halbe Lücke (10 − 0) / 2 als Rand des Labels
                None => {
                    st.grid_template_rows.pop();
                    st.padding.bottom = px(13.);
                }
            }
            kids.push(
                Div::new(st)
                    .kids(rule)
                    .kids(ck)
                    .boxel(bx(format!("_card.{i}"), b, None))
                    .fit(&format!("_card.{i}")),
            );
        } else {
            let cc = card_cx(cx, hl);
            let mut val = kpi_value(&cc, format!("kpis.{i}.value"), req(it, "value")?, b);
            if el != Elements::Solid && focus.is_some() {
                val.color = if hl { cx.pal.accent } else { cx.pal.text };
            }
            let mut lab = cc.t(label_role, format!("kpis.{i}.label"), req(it, "label")?);
            lab.build = b;
            let mut ck = vec![t(val), t(lab)];
            if let Some(d) = s(it, "delta") {
                // hervorgehobene Karte: --good/--bad = onAccent
                ck.push(if hl && el == Elements::Solid {
                    kpi_delta(&cc, i, d, None, b)
                } else {
                    kpi_delta(&cc, i, d, s(it, "sentiment"), b)
                });
            }
            let st = CardStyle {
                solid: [36., 30., 36., 30.],
                gap: 10.,
                ..CardStyle::default()
            };
            kids.push(card(cx, format!("_card.{i}"), b, hl, &st, ck));
        }
    }
    let mut st = grid_cols(cx, &fr_, if plain { 0. } else { 24. }, Stack::Kpis)
        .grow()
        .min_h0();
    st.align_content = AlignContent::START;
    st.grid_auto_rows = vec![if plain {
        minmax(length(0.), taffy::style_helpers::auto())
    } else {
        minmax(length(220.), taffy::style_helpers::auto())
    }];
    let mut out = vec![header(cx, c, 2)?, Div::new(st).kids(kids)];
    out.extend(super::source(cx, "source", s(c, "source")));
    Ok(out.into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Zwei Zahlen zeigen den Erfolg", "kpis": [{ "value": "98 %", "label": "Verfügbarkeit" }, { "value": "4,8", "label": "Kundenbewertung" }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Ergebnisse Q3",
                "title": "Wir wachsen schneller als der Markt – und profitabel",
                "kpis": [
                    { "value": "+34 %", "label": "Umsatzwachstum", "delta": "+12 % ggü. Plan", "sentiment": "positive" },
                    { "value": "2,4 Mio", "label": "Wiederkehrender Umsatz (ARR)", "delta": "+0,6 Mio", "sentiment": "positive" },
                    { "value": "1,8 %", "label": "Monatliche Kündigungsrate", "delta": "−0,4 Pp.", "sentiment": "positive" },
                ],
                "focus": 0,
                "source": "Interne Finanzdaten, Stand 30.09.2026",
            }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(90, 0), "kpis": rep(4, |i| json!({ "value": "€ 12,4 M", "label": words(48, i), "delta": "+12,5 % ggü.", "sentiment": "positive" })), "source": words(90, 0) }),
        ),
    ]
}
