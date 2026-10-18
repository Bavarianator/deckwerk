//! Fließtext A4 (layouts-extra.tsx DocText, layouts-extra.css .doc*): eine oder zwei Spalten mit Abschnitten.

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
    footer: true,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let secs = arr(c, "sections");
    let two = v == Some("two");
    let half = if two { secs.len().div_ceil(2) } else { secs.len() };
    let column = |items: &[&Value], off: usize| -> Result<Div, Error> {
        let mut kids = Vec::new();
        for (i, sec) in items.iter().enumerate() {
            let n = off + i;
            let b = Some(n as u32);
            let mut sk = Vec::new();
            if let Some(h) = s(sec, "heading") {
                let mut spec = cx.t(Role::H3, format!("sections.{n}.heading"), h);
                spec.build = b;
                sk.push(t(spec));
            }
            let mut spec = cx.t(Role::Body, format!("sections.{n}.text"), req(sec, "text")?);
            spec.build = b;
            sk.push(t(spec));
            kids.push(Div::new(col(6.)).kids(sk));
        }
        Ok(Div::new(col(22.).min_w0()).kids(kids))
    };
    let mut out = vec![header(cx, c, 2)?];
    if let Some(lead) = s(c, "lead") {
        let mut spec = cx.t(Role::Body, "lead", lead);
        spec.build = Some(0);
        spec.size *= 1.2;
        spec.lh = 1.4;
        out.push(t_styled(spec, Style::DEFAULT.none().mb(22.)));
    }
    let mut cols = vec![column(&secs[..half], 0)?];
    if two {
        cols.push(column(&secs[half..], half)?);
    }
    let st = Style {
        grid_template_columns: if two { vec![fr(1.), fr(1.)] } else { vec![fr(1.)] },
        grid_auto_rows: vec![minmax(length(0.), taffy::style_helpers::auto())],
        align_content: AlignContent::START,
        gap: Size { width: px(40.), height: px(24.) },
        ..grid(24.)
    }
    .grow()
    .min_h0();
    out.push(Div::new(st).kids(cols).fit("sections").clip());
    out.extend(super::source(cx, s(c, "source")));
    Ok(out.into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Kurzinfo zum Vorhaben", "sections": [{ "text": "Ein Absatz genügt." }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Projektinfo", "title": "Ortho-Bot startet im Herbst an 20 Pilotschulen",
                "lead": "Der Pilot läuft ein Schuljahr lang und wird wissenschaftlich begleitet. Die ersten Ergebnisse liegen im März 2027 vor.",
                "sections": [
                    { "heading": "Worum es geht", "text": "Ortho-Bot erkennt typische Fehlerarten in freien Texten und übt gezielt die passende Regel. Lehrkräfte sehen den Fortschritt pro Kind und Klasse." },
                    { "heading": "Was wir brauchen", "text": "Zwanzig Schulen mit je einer Klasse der Jahrgangsstufe 3 oder 4 und eine feste Ansprechperson im Kollegium.\nDie Anmeldung ist bis zum 15. Oktober möglich." },
                    { "heading": "Datenschutz", "text": "Alle Daten werden in Deutschland verarbeitet. Es gibt keine Klarnamen, die Zuordnung läuft über Kürzel der Lehrkraft." },
                ],
                "source": "Stand Oktober 2026",
            }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(80, 0), "lead": words(300, 0), "sections": rep(3, |i| json!({ "heading": words(50, i), "text": words(700, i) })), "source": words(90, 0) }),
        ),
    ]
}
