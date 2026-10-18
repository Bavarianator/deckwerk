//! Angebot A4 (layouts-extra.tsx Offer, layouts-extra.css .of*): Positionen, Summen, Konditionen.
//! ponytail: align-items baseline der Zeilen als flex-start (Body/Label nah beieinander), Baseline-Ausrichtung über g_text::baseline, wenn Refcheck es verlangt

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::Div;

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

/// Rechtsbündige Zahl (.of .num): Text in einer Zeile mit justify end.
fn num(spec: crate::text::TextSpec) -> Div {
    let mut spec = spec;
    spec.nowrap = true;
    Div::new(row(0.).justify(JustifyContent::FLEX_END).min_w0()).kids([t(spec)])
}

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let muted = |role, slot: &str, text: &str| {
        let mut spec = cx.t(role, slot, text);
        spec.color = cx.pal.muted;
        spec
    };
    let mut out = vec![header(cx, c, 2)?];
    let (to, meta) = (s(c, "to"), s(c, "meta"));
    if to.is_some() || meta.is_some() {
        let mut kids = Vec::new();
        if let Some(to) = to {
            kids.push(t(cx.t(Role::Label, "to", to)));
        }
        if let Some(m) = meta {
            let mut spec = muted(Role::Label, "meta", m);
            spec.nowrap = true;
            kids.push(Div::new(row(0.).grow().justify(JustifyContent::FLEX_END)).kids([t(spec)]));
        }
        out.push(Div::new(row(40.).none().mb(22.).justify(JustifyContent::SPACE_BETWEEN)).kids(kids));
    }
    let line = |kids: Vec<Div>, head: bool| {
        let mut st = Style {
            grid_template_columns: vec![minmax(length(0.), fr(1.)), length(110.), length(120.)],
            ..grid(16.)
        }
        .none()
        .pad(if head { 0. } else { 11. }, 0., 11., 0.);
        st.border.bottom = px(1.);
        let mut d = Div::new(st).kids(kids);
        d.border = Some(cx.tk.border);
        d
    };
    let mut rows = vec![line(
        vec![
            t(muted(Role::Label, "_h.name", "Position")),
            num(muted(Role::Label, "_h.qty", "Menge")),
            num(muted(Role::Label, "_h.price", "Betrag")),
        ],
        true,
    )];
    let items = arr(c, "items");
    for (i, it) in items.iter().enumerate() {
        let b = Some(i as u32);
        let mk = |role, k: &str, text: &str, m: bool| {
            let slot = format!("items.{i}.{k}");
            let mut spec = if m { muted(role, &slot, text) } else { cx.t(role, slot, text) };
            spec.build = b;
            spec
        };
        let mut name = vec![t(mk(Role::Body, "name", req(it, "name")?, false))];
        if let Some(d) = s(it, "detail") {
            name.push(t(mk(Role::Label, "detail", d, true)));
        }
        rows.push(line(
            vec![
                Div::new(col(2.).min_w0()).kids(name),
                num(mk(Role::Body, "qty", s(it, "qty").unwrap_or(""), false)),
                num(mk(Role::Body, "price", req(it, "price")?, false)),
            ],
            false,
        ));
    }
    let totals = arr(c, "totals");
    let last = totals.len().saturating_sub(1);
    let mut tot = Vec::new();
    for (i, tv) in totals.iter().enumerate() {
        let sum = i == last;
        let role = if sum { Role::H3 } else { Role::Body };
        let mut l = cx.t(role, format!("totals.{i}.label"), req(tv, "label")?);
        let mut v = cx.t(role, format!("totals.{i}.value"), req(tv, "value")?);
        l.build = Some(items.len() as u32);
        v.build = l.build;
        v.nowrap = true;
        let mut st = row(16.).justify(JustifyContent::SPACE_BETWEEN);
        let mut kids = Vec::new();
        if sum {
            // .sum::before: 2px-Linie in Textfarbe, landet im Hintergrundbild
            st = st.rel().mt(8.).pad(12., 0., 0., 0.);
            let bar = Div::new(Style { size: Size { width: percent(1.), height: length(2.) }, ..abs(Some(0.), Some(0.), Some(0.), None) })
                .paint(cx.pal.text);
            kids.push(bar);
        }
        kids.extend([t(l), t(v)]);
        tot.push(Div::new(st).kids(kids));
    }
    let mut tst = col(6.).none();
    tst.size.width = percent(0.56);
    tst.margin = taffy::Rect { left: auto_lp(), right: pxa(0.), top: pxa(18.), bottom: pxa(0.) };
    rows.push(Div::new(tst).kids(tot));
    out.push(Div::new(col(0.).grow().min_h0()).kids(rows).fit("items").clip());
    if let Some(terms) = s(c, "terms") {
        out.push(t_styled(muted(Role::Label, "terms", terms), Style::DEFAULT.none().mt(18.)));
    }
    Ok(out.into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Angebot Webseiten-Relaunch", "items": [{ "name": "Konzept und Design", "price": "4.800 €" }], "totals": [{ "label": "Gesamt", "value": "4.800 €" }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Angebot 2026-041", "title": "Angebot Webseiten-Relaunch", "to": "Muster GmbH\nMusterweg 1\n12345 Musterstadt", "meta": "04.10.2026 · gültig bis 03.11.2026",
                "items": [
                    { "name": "Konzept und Design", "detail": "Strukturplan, Gestaltung von fünf Seitentypen", "qty": "1 Pauschale", "price": "4.800 €" },
                    { "name": "Umsetzung", "detail": "Programmierung, Anbindung an das Redaktionssystem", "qty": "40 Std.", "price": "3.600 €" },
                    { "name": "Inhalte und Fotos", "qty": "1 Pauschale", "price": "1.200 €" },
                    { "name": "Schulung", "detail": "Zwei Termine à zwei Stunden", "qty": "4 Std.", "price": "360 €" },
                ],
                "totals": [{ "label": "Netto", "value": "9.960 €" }, { "label": "Umsatzsteuer 19 %", "value": "1.892,40 €" }, { "label": "Gesamt", "value": "11.852,40 €" }],
                "terms": "Zahlbar innerhalb von 14 Tagen nach Rechnungsstellung. Lieferzeit: sechs Wochen ab Beauftragung.",
            }),
        ),
        (
            "max",
            json!({ "eyebrow": words(40, 0), "title": words(60, 0), "to": words(120, 0), "meta": words(80, 0), "items": rep(8, |i| json!({ "name": words(60, i), "detail": words(100, i), "qty": "120 Std.", "price": "12.345,67 €" })), "totals": rep(3, |i| json!({ "label": words(24, i), "value": "123.456,78 €" })), "terms": words(260, 0) }),
        ),
    ]
}
