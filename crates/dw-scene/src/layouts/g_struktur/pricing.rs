//! Preise (layouts-extra.tsx Pricing, layouts-extra.css „pr“): 2–4 Preisstufen als Karten, eine hervorgehoben.

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::{source, words_x};
use crate::Error;
use crate::blocks::*;
use crate::samples::rep;
use crate::tree::Div;

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &["band"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let tiers = arr(c, "tiers");
    // .pr-card (padding 34 30, gap 18) verliert gegen .card aus slide.css, das später geladen wird
    let cs = CardStyle::default();
    let mut cards = Vec::new();
    for (i, tr) in tiers.iter().enumerate() {
        let b = Some(i as u32);
        let hl = tr.get("highlight").and_then(Value::as_bool) == Some(true);
        let cc = card_cx(cx, hl);
        let mut name = cc.t(Role::Eyebrow, format!("tiers.{i}.name"), req(tr, "name")?);
        name.build = b;
        name.color = cc.pal.accent;
        let mut price = cc.t(Role::Kpi, format!("tiers.{i}.price"), req(tr, "price")?);
        price.build = b;
        if hl && el != Elements::Solid {
            price.color = cx.pal.accent;
        }
        let mut pk = vec![t(price)];
        if let Some(p) = s(tr, "period") {
            let mut sp = cc.t(Role::Small, format!("tiers.{i}.period"), p);
            sp.build = b;
            pk.push(t(sp));
        }
        let mut pst = col(2.);
        let mut pd = None;
        if el != Elements::Plain {
            pst = pst.pad(0., 0., 14., 0.);
            pst.border.bottom = px(1.);
            // auf der Akzentfläche: onAccent zu 30 % über fill
            pd = Some(if hl && el == Elements::Solid {
                dw_color::mix(tk.on_accent, tk.fill, 0.7)
            } else {
                tk.border
            });
        }
        let mut pr = Div::new(pst).kids(pk);
        pr.border = pd;
        let fs = strs(tr, "features");
        let feats = fs.iter().enumerate().map(|(j, f)| {
            let chk = (el != Elements::Plain).then(|| {
                let mut d = icon(format!("_chk.{i}.{j}"), b, "check", cc.pal.accent, 18.);
                d.style = d.style.mt(3.);
                d
            });
            let mut sp = cc.t(Role::Label, format!("tiers.{i}.features.{j}"), f);
            sp.build = b;
            Div::new(row(16.).items(AlignItems::FLEX_START))
                .kids(chk.into_iter().chain([t_styled(sp, Style::DEFAULT.grow())]))
        });
        let feat = Div::new(col(10.)).kids(feats);
        cards.push(card(cx, format!("_card.{i}"), b, hl, &cs, vec![t(name), pr, feat]));
    }
    let mut st = grid_cols(cx, &vec![1.; tiers.len()], 24., Stack::Narrow);
    if el != Elements::Solid {
        st.gap.width = px(40.);
    }
    st.align_content = AlignContent::START;
    st.align_items = AlignItems::STRETCH;
    let pr = Div::new(st.grow().min_h0()).kids(cards).fit("tiers").clip();
    let mut out = vec![header(cx, c, 2)?, pr];
    out.extend(source(cx, "note", s(c, "note")));
    Ok(out.into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Zwei Pakete", "tiers": [{ "name": "Basis", "price": "19 €", "features": ["1 Klasse", "E-Mail-Support"] }, { "name": "Schule", "price": "149 €", "features": ["Alle Klassen", "Schulung"], "highlight": true }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Preise", "title": "Die Schullizenz rechnet sich schon ab vier Klassen",
                "tiers": [
                    { "name": "Klasse", "price": "19 €", "period": "pro Monat", "features": ["Eine Klasse bis 30 Kinder", "Wochenbericht", "E-Mail-Support"] },
                    { "name": "Schule", "price": "149 €", "period": "pro Monat", "features": ["Alle Klassen", "Schulung fürs Kollegium", "Auswertung pro Jahrgang", "Telefon-Support"], "highlight": true },
                    { "name": "Träger", "price": "auf Anfrage", "features": ["Mehrere Schulen", "Zentrale Verwaltung", "Eigener Ansprechpartner"] },
                ],
                "note": "Alle Preise zzgl. MwSt., jährliche Abrechnung",
            }),
        ),
        (
            "max",
            json!({
                "eyebrow": words_x(28, 0), "title": words_x(90, 0),
                "tiers": rep(4, |i| json!({ "name": words_x(20, i), "price": "€ 1.234", "period": words_x(16, i), "features": rep(4, |j| json!(words_x(36, i + j))), "highlight": i == 1 })),
                "note": words_x(100, 0),
            }),
        ),
    ]
}
