//! Aufzählung (layouts.tsx Bullets, slide.css „bullets“ und Bauteile el-*): Liste oder bis 4 Karten.

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::{BoxSpec, Div};

pub const VARIANTS: &[&str] = &["list", "cards"];

pub const DEF: Def = Def {
    footer: true,
    frames: &["split", "band", "center"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let items = arr(c, "items");
    let n = items.len();
    let sub = items.iter().any(|it| s(it, "sub").is_some());
    let cards = n <= 4 && v == Some("cards");
    let few = !cards && n <= 3;
    let side = cx.frame == FrameId::Split && !cx.tall; // neben dem Titel mittig
    let body = cx.fs_raw(Role::Body);
    let mut list = Vec::new();
    for (i, it) in items.iter().enumerate() {
        let b = Some(i as u32);
        let icon_box = |mb: f32| {
            s(it, "icon").map(|name| {
                Div::new(
                    row(0.)
                        .items(AlignItems::CENTER)
                        .justify(JustifyContent::CENTER)
                        .none()
                        .wh(40., 40.)
                        .mb(mb),
                )
                .boxel(bx(format!("_ib.{i}"), b, None))
                .kids([icon(format!("_icon.{i}"), b, name, cx.pal.text, 26.)])
            })
        };
        let mut main = cx.t(
            if cards { Role::H3 } else { Role::Body },
            format!("items.{i}.text"),
            s(it, "text").unwrap_or_default(),
        );
        main.build = b;
        if few {
            main.size *= 1.25;
        }
        if sub {
            main.weight = 700.;
        }
        let mut texts = vec![t(main)];
        if let Some(st) = s(it, "sub") {
            let role = if few {
                Role::Body
            } else if n <= 4 {
                Role::Label
            } else {
                Role::Small
            };
            let mut spec = cx.t(role, format!("items.{i}.sub"), st);
            spec.build = b;
            spec.color = cx.pal.muted;
            texts.push(t(spec));
        }
        let mut tst = col(if cards { 8. } else { 4. }).grow().min_w0();
        if sub && (s(it, "icon").is_some() || cards) {
            tst = tst.pad(1., 0., 0., 0.);
        }
        let text = Div::new(tst).kids(texts);
        if cards {
            let mark = icon_box(18.).unwrap_or_else(|| {
                let mut num = cx.t(Role::Label, format!("_n.{i}"), &(i + 1).to_string());
                num.build = b;
                num.family = family(&tk.font_head);
                num.center = true;
                if el == Elements::Plain {
                    num.weight = 400.;
                    num.color = cx.pal.muted;
                    num.size = cx.fs_raw(Role::H1);
                    num.lh = 1.;
                } else {
                    num.weight = 700.;
                    num.color = cx.pal.accent;
                }
                // solid: Kachel 40×40 mit Nummer mittig; line/plain: Nummer ohne Kachel, linksbündig
                let st = if el == Elements::Solid {
                    row(0.)
                        .items(AlignItems::CENTER)
                        .justify(JustifyContent::CENTER)
                        .none()
                        .wh(40., 40.)
                } else {
                    row(0.).items(AlignItems::CENTER).none()
                };
                Div::new(st.mb(18.))
                    .boxel(bx(format!("_ib.{i}"), b, None))
                    .kids([t(num)])
            });
            let (pad, fill, radius) = match el {
                Elements::Solid => ((32., 28., 32., 28.), Some(tk.surface), tk.radius as f32),
                Elements::Line => ((28., 0., 4., 0.), None, 0.),
                Elements::Plain => ((0., 0., 4., 0.), None, 0.),
            };
            let st = col(12.)
                .pad(pad.0, pad.1, pad.2, pad.3)
                .min_w0()
                .min_h0()
                .rel();
            let line = (el == Elements::Line).then(|| top_line(1., cx.pal.text));
            list.push(
                Div::new(st)
                    .kids(line.into_iter().chain([mark, text]))
                    .boxel(BoxSpec {
                        radius,
                        ..bx(format!("_card.{i}"), b, fill)
                    })
                    .fit(&format!("_card.{i}"))
                    .clip(),
            );
        } else {
            let k = if few { 1.25 } else { 1. };
            let mt = body * k * 0.69 - 5.;
            let mark = icon_box(0.).or_else(|| match el {
                // Strich 14×2 statt Punkt, mittig zur ersten Zeile
                Elements::Line => Some(
                    Div::new(Style::DEFAULT.none().wh(14., 2.).mt(mt).rel_top(4.)).boxel(bx(
                        format!("_dot.{i}"),
                        b,
                        Some(cx.pal.accent),
                    )),
                ),
                Elements::Solid => Some(Div::new(Style::DEFAULT.none().wh(10., 10.).mt(mt)).boxel(
                    BoxSpec {
                        radius: 3.,
                        ..bx(format!("_dot.{i}"), b, Some(cx.pal.accent))
                    },
                )),
                Elements::Plain => None,
            });
            let align = if !sub && s(it, "icon").is_some() {
                AlignItems::CENTER
            } else {
                AlignItems::FLEX_START
            };
            list.push(Div::new(row(22.).items(align)).kids(mark.into_iter().chain([text])));
        }
    }
    let st = if cards {
        Style {
            grid_template_columns: vec![repeat(n as u16, vec![fr(1.)])],
            grid_auto_rows: vec![minmax(length(260.), taffy::style_helpers::auto())],
            align_content: if side {
                AlignContent::CENTER
            } else {
                AlignContent::START
            },
            ..grid(24.)
        }
        .grow()
        .min_h0()
    } else {
        col(if few { 40. } else { 26. })
            .justify(if side {
                JustifyContent::CENTER
            } else {
                JustifyContent::FLEX_START
            })
            .grow()
            .min_h0()
            .max_wo(cx.measure(1000.))
    };
    Ok(vec![
        header(cx, c, 2)?,
        Div::new(st).kids(list).fit("items").clip(),
    ]
    .into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Zwei Gründe sprechen für den Wechsel", "items": [{ "text": "Geringere Kosten" }, { "text": "Schnellere Abläufe" }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Warum jetzt",
                "title": "Drei Entwicklungen machen den Markt jetzt attraktiv",
                "items": [
                    { "text": "Regulierung schafft Nachfrage", "sub": "Ab 2027 wird digitale Dokumentation Pflicht" },
                    { "text": "Wettbewerb ist fragmentiert", "sub": "Kein Anbieter hat mehr als 8 % Marktanteil" },
                    { "text": "Kunden sind wechselbereit", "sub": "62 % planen einen Anbieterwechsel in 24 Monaten" },
                ],
            }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(90, 0), "items": rep(5, |i| json!({ "text": words(80, i), "sub": words(110, i + 3), "icon": "check" })) }),
        ),
    ]
}
