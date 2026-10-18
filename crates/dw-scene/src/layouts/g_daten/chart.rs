//! Diagramm (layouts.tsx ChartSlide, slide.css .chart-wrap/.chart-meta/.take-card).

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::g_struktur::source;
use super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
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

/// Zahl deutsch mit `dec` Nachkommastellen.
fn de(x: f64, dec: usize) -> String {
    format!("{x:.dec$}").replace('.', ",")
}

/// annotation() aus charts.ts: CAGR/Differenz aus den Daten gerechnet.
// ponytail: delta mit fester einer Nachkommastelle statt decimals(spec), bei Abweichung im Refcheck nachziehen
fn annotation(spec: &Value) -> Option<String> {
    let kind = s(spec, "annotate")?;
    if matches!(s(spec, "type"), Some("donut" | "waterfall")) {
        return None;
    }
    let series = spec.get("series")?.as_array()?;
    let ser = series
        .iter()
        .find(|x| s(spec, "highlight").is_some() && s(x, "name") == s(spec, "highlight"))
        .or(series.first())?;
    let v: Vec<f64> = ser.get("values")?.as_array()?.iter().filter_map(Value::as_f64).collect();
    let n = v.len().checked_sub(1).filter(|&n| n >= 1)?;
    let (a, b) = (v[0], v[n]);
    let cats = strs(spec, "categories");
    let span = format!("{}–{}", cats.first()?, cats.get(n)?);
    let signed = |x: f64, dec| format!("{}{}", if x < 0. { '−' } else { '+' }, de(x.abs(), dec));
    if kind == "cagr" {
        return (a > 0. && b > 0.)
            .then(|| format!("CAGR {span}: {} %", signed(((b / a).powf(1. / n as f64) - 1.) * 100., 1)));
    }
    let unit = match s(spec, "unit") {
        Some("%") => " Pp.".to_string(),
        Some(u) => format!(" {u}"),
        None => String::new(),
    };
    let rel = if s(spec, "unit") != Some("%") && a != 0. {
        format!(" ({} %)", signed((b - a) / a.abs() * 100., 0))
    } else {
        String::new()
    };
    Some(format!("{span}: {}{unit}{rel}", signed(b - a, 1)))
}

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let spec = c.get("chart").ok_or_else(|| Error::Content("chart fehlt".into()))?;
    let unit = s(spec, "unit");
    let note = annotation(spec);
    let mut chart_col = Vec::new();
    if unit.is_some() || note.is_some() {
        let mut meta = row(16.).none().items(AlignItems::CENTER);
        meta.justify_content = JustifyContent::SPACE_BETWEEN;
        let mut kids = vec![match unit {
            Some(u) => t(cx.t(Role::Small, "_unit", &format!("in {u}"))),
            None => Div::new(Style::DEFAULT),
        }];
        if let Some(n) = note {
            let mut tx = cx.t(Role::Small, "_ann.text", &n);
            tx.build = Some(0);
            tx.color = cx.pal.accent;
            tx.weight = 700.;
            // .chart-ann: Pille mit Akzentrand; line/plain ohne Rahmen
            let pill = el == Elements::Solid;
            let st = Style::DEFAULT.none();
            let st = if pill { st.pad(4., 14., 4., 14.) } else { st };
            kids.push(Div::new(st).kids([t(tx)]).boxel(BoxSpec {
                radius: if pill { 999. } else { 0. },
                border: pill.then_some((cx.pal.accent, 1.5)),
                ..bx("_ann", Some(0), None)
            }));
        }
        chart_col.push(Div::new(meta).kids(kids));
    }
    let mut cst = Style::DEFAULT.grow().min_h0().min_w0();
    if s(spec, "type") == Some("donut") {
        cst.max_size.width = length(620.);
    }
    chart_col.push(chart(cx, "chart", Some(0), spec, cst)?);
    let mut kids = vec![Div::new(col(8.).min_w0().min_h0()).kids(chart_col)];
    let take = c.get("takeaway").filter(|v| v.is_object());
    if let Some(tv) = take {
        let b = Some(1);
        let mut inner = Vec::new();
        if el == Elements::Line {
            inner.push(top_line(2., cx.pal.accent));
        }
        if let Some(v) = s(tv, "value") {
            inner.push(t(kpi_value(cx, "takeaway.value", v, b)));
        }
        let mut tx = cx.t(Role::Body, "takeaway.text", req(tv, "text")?);
        tx.build = b;
        inner.push(t(tx));
        let (pad, fill) = match el {
            Elements::Solid => ([32.; 4], Some(tk.accent_tint)),
            Elements::Line => ([28., 0., 4., 0.], None),
            Elements::Plain => ([0., 0., 4., 0.], None),
        };
        let mut st = col(12.).pad(pad[0], pad[1], pad[2], pad[3]).min_w0().min_h0().rel();
        if el != Elements::Line {
            st.justify_content = JustifyContent::CENTER;
        }
        kids.push(
            Div::new(st)
                .kids(inner)
                .boxel(BoxSpec {
                    radius: if fill.is_some() { tk.radius as f32 } else { 0. },
                    ..bx("_take", b, fill)
                })
                .fit("_take")
                .clip(),
        );
    }
    let cols = if take.is_some() && !cx.narrow {
        vec![minmax(length(0.), fr(1.)), length(330.)]
    } else {
        vec![minmax(length(0.), fr(1.))]
    };
    let st = Style {
        grid_template_columns: cols,
        grid_template_rows: vec![minmax(length(0.), fr(1.))],
        ..grid(36.)
    }
    .grow()
    .min_h0();
    let mut out = vec![header(cx, c, 2)?, Div::new(st).kids(kids)];
    out.extend(source(cx, "source", s(c, "source")));
    Ok(out.into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Preis und Menge tragen das EBIT-Plus", "chart": { "type": "waterfall", "categories": ["2025", "Preis", "Menge", "Kosten", "2026"], "series": [{ "name": "EBIT", "values": [4.2, 1.1, 0.8, -0.9, 5.2] }], "unit": "Mio €" } }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Umsatzentwicklung",
                "title": "Der Umsatz hat sich seit 2023 mehr als verdoppelt",
                "chart": { "type": "bar", "categories": ["2022", "2023", "2024", "2025", "2026e"], "series": [{ "name": "Umsatz", "values": [1.1, 1.4, 2.0, 2.6, 3.3] }, { "name": "Plan", "values": [1.0, 1.5, 1.9, 2.4, 3.0] }], "unit": "Mio €", "highlight": "Umsatz", "annotate": "cagr" },
                "takeaway": { "value": "+136 %", "text": "Wachstum seit 2023 – getrieben durch das neue Abo-Modell" },
                "source": "Geschäftsberichte 2022–2025, 2026 Prognose",
            }),
        ),
        (
            "max",
            json!({
                "eyebrow": words(28, 0), "title": words(90, 0),
                "chart": { "type": "bar", "categories": rep(12, |i| json!(format!("Kategorie {}", i + 1))), "series": rep(4, |i| json!({ "name": words(24, i), "values": rep(12, |j| json!(10 + ((i * 7 + j * 13) % 40))) })), "unit": "Mio €" },
                "takeaway": { "value": "+136 %", "text": words(110, 0) },
                "source": words(90, 0),
            }),
        ),
    ]
}
