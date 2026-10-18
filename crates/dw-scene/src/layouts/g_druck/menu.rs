//! Speisekarte A4 (layouts-extra.tsx Menu, layouts-extra.css .sk-*): Abschnitte mit Gerichten, Preis rechts.
//! ponytail: two teilt die Abschnitte hälftig statt CSS-Spalten mit Umbruch im Abschnitt; Zeilen oben statt auf Grundlinie,
//! --head-fit gilt als 1. Ausbau: Spaltenausgleich nach gemessener Höhe.

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::Div;

pub const VARIANTS: &[&str] = &["one", "two"];

pub const DEF: Def = Def {
    footer: false,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let fb = cx.fs_raw(Role::Body);
    let hs = cx.fs(Role::H1) / cx.fs_raw(Role::H1);
    let mut head = Vec::new();
    if let Some(e) = s(c, "eyebrow") {
        let mut spec = cx.t(Role::Eyebrow, "eyebrow", e);
        spec.color = cx.pal.text;
        spec.size = cx.fs_raw(Role::Eyebrow) * 1.2;
        head.push(t(spec));
    }
    let mut title = cx.t(Role::H1, "title", req(c, "title")?);
    title.max_lines = Some(2);
    title.size = cx.fs_raw(Role::H1) * hs.min(1.25) * 1.8;
    title.lh = 1.04;
    head.push(t(title));
    if let Some(x) = s(c, "intro") {
        head.push(t_styled(cx.t(Role::Body, "intro", x), Style::DEFAULT.max_wo(Some(540.))));
    }
    let secs = arr(c, "sections");
    let mut divs = Vec::new();
    for (i, sec) in secs.iter().enumerate() {
        let b = Some(i as u32);
        let p = |j: usize, k: &str| format!("sections.{i}.items.{j}.{k}");
        // .sk-sec::before: Haarlinie in Textfarbe mit 25 % Deckkraft
        let mut kids = vec![
            Div::new(Style { size: Size { width: percent(1.), height: length(1.) }, ..abs(Some(0.), Some(0.), Some(0.), None) })
                .paint(cx.pal.muted),
        ];
        let mut h = cx.t(Role::H2, format!("sections.{i}.heading"), req(sec, "heading")?);
        h.build = b;
        h.color = cx.pal.accent;
        h.size = cx.fs_raw(Role::H2) * 1.15;
        kids.push(t_styled(h, Style::DEFAULT.mb(fb * 0.3)));
        for (j, it) in arr(sec, "items").iter().enumerate() {
            let h3 = |slot: String, x: &str| {
                let mut spec = cx.t(Role::H3, slot, x);
                spec.build = b;
                spec.size = cx.fs_raw(Role::H3) * 1.15;
                spec
            };
            let mut name = vec![t(h3(p(j, "name"), req(it, "name")?))];
            if let Some(tag) = s(it, "tag") {
                let mut spec = cx.t(Role::Small, p(j, "tag"), tag);
                spec.build = b;
                name.push(t(spec));
            }
            let mut nst = row(0.).min_w0();
            nst.flex_wrap = FlexWrap::Wrap;
            nst.gap.width = px(10.);
            let mut price = h3(p(j, "price"), req(it, "price")?);
            price.nowrap = true;
            let mut ik = vec![Div::new(nst).kids(name), t(price)];
            if let Some(x) = s(it, "text") {
                let mut spec = cx.t(Role::Small, p(j, "text"), x);
                spec.build = b;
                spec.size = cx.fs_raw(Role::Small) * 1.08;
                let mut st = Style::DEFAULT;
                st.grid_column = taffy::Line { start: line(1), end: line(-1) };
                ik.push(t_styled(spec, st));
            }
            let mut st = Style {
                grid_template_columns: vec![minmax(length(0.), fr(1.)), taffy::style_helpers::auto()],
                ..grid(0.)
            }
            .pad(fb * 0.4, 0., fb * 0.4, 0.);
            st.gap = Size { width: px(20.), height: px(2.) };
            kids.push(Div::new(st).kids(ik));
        }
        let mut st = col(0.).rel().pad(fb * 0.8, 0., 0., 0.);
        if i > 0 && v != Some("two") {
            st = st.mt(fb * 1.4);
        }
        divs.push(Div::new(st).kids(kids));
    }
    let cols: Vec<Div> = if v == Some("two") {
        let half = divs.len().div_ceil(2);
        let right = divs.split_off(half);
        [divs, right]
            .into_iter()
            .map(|d| Div::new(col(fb * 1.4).min_w0()).kids(d))
            .collect()
    } else {
        vec![Div::new(col(0.).min_w0()).kids(divs)]
    };
    let mut gst = Style {
        grid_template_columns: vec![minmax(length(0.), fr(1.)); cols.len()],
        align_items: AlignItems::START,
        ..grid(0.)
    }
    .grow()
    .min_h0();
    gst.gap.width = px(40.);
    let mut out = vec![
        Div::new(col(14.).none().mb(fb * 2.)).kids(head),
        Div::new(gst).kids(cols).fit("sections").clip(),
    ];
    if let Some(x) = s(c, "note") {
        out.push(t_styled(cx.t(Role::Small, "note", x), Style::DEFAULT.none().mt(20.)));
    }
    Ok(out.into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Speisekarte", "sections": [{ "heading": "Heute", "items": [{ "name": "Linsensuppe", "price": "6,50" }] }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Herbst · ab 1. Oktober", "title": "Herbstkarte",
                "intro": "Wir kochen mit Gemüse aus dem Umland und Fleisch von Höfen, die wir kennen.",
                "sections": [
                    { "heading": "Vorspeisen", "items": [
                        { "name": "Kürbissuppe", "text": "Hokkaido, Ingwer, geröstete Kerne", "price": "7,50", "tag": "vegan" },
                        { "name": "Feldsalat", "text": "Birne, Walnuss, Ziegenkäse, Honig-Senf-Dressing", "price": "9,80", "tag": "G, H" },
                    ] },
                    { "heading": "Hauptgerichte", "items": [
                        { "name": "Rinderroulade", "text": "Rotkohl, Kartoffelklöße, Schmorsauce", "price": "21,50", "tag": "A, I" },
                        { "name": "Kürbisrisotto", "text": "Salbeibutter, Bergkäse", "price": "16,90", "tag": "G" },
                        { "name": "Saibling", "text": "Aus dem Fichtelgebirge, mit Petersilienkartoffeln und Rahmspinat", "price": "23,00", "tag": "D, G" },
                    ] },
                    { "heading": "Nachspeisen", "items": [
                        { "name": "Zwetschgendatschi", "text": "Mit geschlagener Sahne", "price": "5,50", "tag": "A, C, G" },
                    ] },
                ],
                "note": "Allergene: A Gluten, C Ei, D Fisch, G Milch, H Schalenfrüchte, I Sellerie. Alle Preise in Euro inkl. MwSt.",
            }),
        ),
        (
            "max",
            json!({
                "eyebrow": words(40, 0), "title": words(40, 0), "intro": words(160, 0),
                "sections": rep(3, |i| json!({ "heading": words(30, i), "items": rep(4, |j| json!({ "name": words(40, i + j), "text": words(80, j), "price": "1.234,50 €", "tag": words(20, j) })) })),
                "note": words(220, 0),
            }),
        ),
    ]
}
