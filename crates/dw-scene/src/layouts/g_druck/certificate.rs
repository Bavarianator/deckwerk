//! Urkunde A4 quer (layouts-extra.tsx Certificate, layouts-extra.css .ur-*): Kopf, Name groß, Datum und Unterschriften.
//! ponytail: Brand-Logo (.ur-logo) fehlt und --head-fit gilt als 1; nachziehen, wenn Theme-Logo und Kopf-Autofit portiert sind

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
    footer: false,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let hs = |r| cx.fs(r) / cx.fs_raw(r);
    let mut head = Vec::new();
    if let Some(e) = s(c, "eyebrow") {
        let mut spec = cx.t(Role::Eyebrow, "eyebrow", e);
        spec.color = cx.pal.accent;
        spec.size = cx.fs_raw(Role::Eyebrow) * 1.25;
        spec.tracking_em = 0.06;
        head.push(t(spec));
    }
    let mut title = cx.t(Role::H1, "title", req(c, "title")?);
    title.max_lines = Some(2);
    title.size = cx.fs_raw(Role::H1) * hs(Role::H1).min(1.25) * 1.15;
    head.push(t(title));
    let mut name = cx.t(Role::Display, "recipient", req(c, "recipient")?);
    name.max_lines = Some(2);
    name.build = Some(0);
    name.size = cx.fs_raw(Role::Display) * hs(Role::Display) * 1.6;
    name.lh = 1.04;
    let mut main = vec![t(name)];
    // Breite: zwei von drei Spalten der Fußzeile (Satzspiegel 1123 − 2 × 104)
    let gap = 48.;
    let inner = cx.w - 208.;
    if let Some(x) = s(c, "text") {
        let mut spec = cx.t(Role::Body, "text", x);
        spec.build = Some(0);
        spec.size = cx.fs_raw(Role::Body) * 1.2;
        spec.lh = 1.45;
        main.push(t_styled(spec, Style::DEFAULT.max_wo(Some((inner - 2. * gap) * 2. / 3. + gap))));
    }
    let mut out = vec![
        Div::new(col(12.).none()).kids(head),
        Div::new(
            Style { flex_grow: 1., flex_shrink: 0., ..col(24.) }
                .justify(JustifyContent::CENTER)
                .pad(36., 0., 36., 0.),
        )
        .kids(main),
    ];
    let signers = arr(c, "signers");
    let date = s(c, "date");
    if date.is_some() || !signers.is_empty() {
        let mut kids = Vec::new();
        if let Some(d) = date {
            let mut spec = cx.t(Role::Body, "date", d);
            spec.build = Some(1);
            kids.push(t_styled(spec, Style::DEFAULT.mt(12.)));
        }
        for (i, sg) in signers.iter().enumerate() {
            let mut sk = vec![
                Div::new(Style { size: Size { width: percent(1.), height: length(1.) }, ..abs(Some(0.), Some(0.), Some(0.), None) })
                    .paint(cx.pal.text),
            ];
            if let Some(n) = s(sg, "name") {
                let mut spec = cx.t(Role::Body, format!("signers.{i}.name"), n);
                spec.build = Some(1);
                spec.weight = 700.;
                sk.push(t(spec));
            }
            let mut spec = cx.t(Role::Body, format!("signers.{i}.role"), req(sg, "role")?);
            spec.build = Some(1);
            spec.color = cx.pal.muted;
            sk.push(t(spec));
            kids.push(Div::new(col(2.).rel().pad(12., 0., 0., 0.).min_w0()).kids(sk));
        }
        let mut st = Style {
            grid_template_columns: vec![minmax(length(0.), fr(1.)); 3],
            align_items: AlignItems::START,
            ..grid(0.)
        }
        .none()
        .pad(48., 0., 0., 0.);
        st.gap.width = px(gap);
        out.push(Div::new(st).kids(kids));
    }
    Ok(Body {
        content: out,
        media: Vec::new(),
        safe: Some(taffy::Rect { left: pxa(104.), right: pxa(104.), top: pxa(88.), bottom: pxa(80.) }),
    })
}

fn samples() -> [(&'static str, Value); 3] {
    [
        ("min", json!({ "title": "Urkunde", "recipient": "Mara" })),
        (
            "typ",
            json!({
                "eyebrow": "Teilnahmebescheinigung", "title": "Erste-Hilfe-Kurs", "recipient": "Mara",
                "text": "hat am 8. Oktober 2026 erfolgreich am Erste-Hilfe-Kurs mit neun Unterrichtseinheiten teilgenommen. Inhalte: Notruf, stabile Seitenlage, Herz-Lungen-Wiederbelebung und der Einsatz eines Defibrillators.",
                "date": "Musterstadt, 8. Oktober 2026",
                "signers": [{ "name": "Jonas", "role": "Kursleitung" }, { "role": "Geschäftsführung" }],
            }),
        ),
        (
            "max",
            json!({ "eyebrow": words(40, 0), "title": words(50, 0), "recipient": words(50, 0), "text": words(260, 0), "date": words(50, 0), "signers": rep(2, |i| json!({ "name": words(40, i), "role": words(40, i + 1) })) }),
        ),
    ]
}
