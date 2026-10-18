//! Tabelle (layouts-extra.tsx Table, layouts-extra.css .tb-*): Zeilen als Raster aus `<T>`, nicht .free-table.

use dw_theme::Role;
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
    frames: &["band", "center"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn cells(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

// ponytail: Zahlenspalten nicht rechtsbündig und keine Trennlinien je Zeile (TextSpec/Div ohne text-align/border-bottom), im Refcheck nachziehen
fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let columns = cells(c.get("columns").unwrap_or(&Value::Null));
    let rows: Vec<Vec<String>> = c
        .get("rows")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(cells).collect())
        .unwrap_or_default();
    if columns.len() < 2 || rows.is_empty() {
        return Err(Error::Content("table: columns/rows fehlen".into()));
    }
    let hl = c.get("highlight");
    let hl_row = hl.and_then(|h| h.get("row")).and_then(Value::as_u64).map(|r| r as usize);
    let hl_col = hl.and_then(|h| h.get("col")).and_then(Value::as_u64).map(|r| r as usize);
    let roomy = rows.len() <= 4 && columns.len() <= 4; // wenige Zeilen: Lesegröße
    let row_div = |r: Option<usize>, vals: &[String], fill: Option<_>, pad_y: f32| -> Div {
        let kids = vals.iter().enumerate().map(|(i, v)| {
            let role = if roomy && r.is_some() { Role::Body } else { Role::Label };
            let slot = match r {
                None => format!("columns.{i}"),
                Some(r) => format!("rows.{r}.{i}"),
            };
            let mut spec = cx.t(role, slot, v);
            spec.build = Some(r.map_or(0, |r| r as u32 + 1));
            if r.is_none() {
                spec.weight = 700.;
                spec.color = cx.pal.muted;
            } else if Some(i) == hl_col {
                spec.weight = 700.;
                spec.color = cx.pal.accent;
            } else if i == 0 || r == hl_row {
                spec.weight = 700.;
            }
            t(spec)
        });
        let st = Style {
            grid_template_columns: std::iter::once(minmax(length(0.), fr(1.4)))
                .chain((1..columns.len()).map(|_| minmax(length(0.), fr(1.))))
                .collect(),
            align_items: AlignItems::CENTER,
            gap: Size { width: length(20.), height: length(0.) },
            ..grid(0.)
        }
        .none()
        .pad(if r.is_none() { 0. } else { pad_y }, 14., pad_y, 14.);
        let d = Div::new(st).kids(kids);
        match (r, fill) {
            (Some(r), Some(f)) => d.boxel(BoxSpec {
                radius: tk.radius as f32,
                ..bx(format!("_hl.{r}"), Some(r as u32 + 1), Some(f))
            }),
            _ => d,
        }
    };
    let pad_y = if roomy { 16. } else { 11. };
    let mut kids = vec![row_div(None, &columns, None, 11.)];
    kids.extend(rows.iter().enumerate().map(|(r, row)| {
        let fill = (Some(r) == hl_row).then_some(tk.accent_tint);
        row_div(Some(r), row, fill, pad_y)
    }));
    let tb = Div::new(col(0.).grow().min_h0()).kids(kids).fit("rows");
    let mut out = vec![header(cx, c, 2)?, tb];
    out.extend(source(cx, "source", s(c, "source")));
    Ok(out.into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Nord liegt vorn", "columns": ["Region", "Umsatz"], "rows": [["Nord", "2,4 Mio"], ["Süd", "1,9 Mio"]] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Regionen", "title": "Der Norden wächst am stärksten und trägt fast die Hälfte des Plus",
                "columns": ["Region", "Umsatz 2026", "Wachstum", "Marge"],
                "rows": [["Nord", "2,4 Mio €", "+18 %", "31 %"], ["West", "2,1 Mio €", "+9 %", "28 %"], ["Süd", "1,9 Mio €", "+6 %", "26 %"], ["Ost", "1,2 Mio €", "+4 %", "22 %"]],
                "highlight": { "row": 0 }, "source": "Controlling, Stand 30.09.2026",
            }),
        ),
        (
            "max",
            json!({
                "eyebrow": words(28, 0), "title": words(90, 0),
                "columns": rep(5, |i| json!(words(24, i))),
                "rows": rep(6, |r| rep(5, |i| json!(if i > 0 { "€ 12.345,6".to_string() } else { words(32, r) }))),
                "highlight": { "col": 2 }, "source": words(90, 0),
            }),
        ),
    ]
}
