//! Marktgröße (layouts-extra.tsx MarketSize, layouts-extra.css „ms“): TAM/SAM/SOM als verschachtelte Kreise und Legende.

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::{source, words_x};
use crate::Error;
use crate::blocks::*;
use crate::tree::{BoxSpec, Div};

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let empty = Value::Null;
    let rings = [
        ("tam", 1., tk.surface2),
        ("sam", 0.64, tk.accent_tint),
        ("som", 0.3, tk.fill),
    ];
    // .ms-ring: left 50 %, bottom 0, translateX(-50 %), Breite/Höhe in % des Quadrats
    let ring_divs = rings.iter().enumerate().map(|(i, &(k, p, fill))| {
        let mut st = Style {
            position: Position::Absolute,
            ..Style::DEFAULT
        };
        st.inset = Rect {
            left: LengthPercentageAuto::percent((1. - p) / 2.),
            right: auto_lp(),
            top: auto_lp(),
            bottom: pxa(0.),
        };
        st.size = Size {
            width: Dimension::percent(p),
            height: Dimension::percent(p),
        };
        Div::new(st).boxel(BoxSpec {
            ellipse: true,
            radius: 9999.,
            ..bx(format!("_ring.{k}"), Some(i as u32), Some(fill))
        })
    });
    // height: min(440px, 100%); aspect-ratio: 1
    let mut rst = Style::DEFAULT.rel();
    rst.size.height = Dimension::percent(1.);
    rst.max_size.height = pxa(440.);
    // Chromium überträgt max-height über aspect-ratio auf die Breite, taffy nicht
    rst.max_size.width = pxa(440.);
    rst.aspect_ratio = Some(1.);
    let ring_box = Div::new(rst).kids(ring_divs);
    let mut items = Vec::new();
    for (i, &(k, _, fill)) in rings.iter().enumerate() {
        let b = Some(i as u32);
        let kv = c.get(k).unwrap_or(&empty);
        let dot = Div::new(Style::DEFAULT.none().wh(22., 22.).mt(16.)).boxel(BoxSpec {
            ellipse: true,
            radius: 11.,
            border: (k == "tam").then_some((tk.border, 1.)),
            ..bx(format!("_dot.{k}"), b, Some(fill))
        });
        let mut val = cx.t(Role::Kpi, format!("{k}.value"), req(kv, "value")?);
        val.build = b;
        if k == "som" {
            val.color = cx.pal.accent;
        }
        // ponytail: <strong> in Akzentfarbe kann TextSpec nicht; TAM/SAM/SOM nur fett
        let mut lab = cx.t(
            Role::Label,
            format!("{k}.label"),
            &format!("**{}** · {}", k.to_uppercase(), req(kv, "label")?),
        );
        lab.build = b;
        items.push(
            Div::new(row(20.).items(AlignItems::FLEX_START)).kids([
                dot,
                Div::new(col(4.).min_w0()).kids([t(val), t(lab)]),
            ]),
        );
    }
    let legend = Div::new(col(28.).justify(JustifyContent::CENTER).min_h0())
        .kids(items)
        .fit("tam")
        .clip();
    let st = Style {
        grid_template_columns: if cx.narrow {
            vec![fr(1.)]
        } else {
            vec![taffy::style_helpers::auto(), fr(1.)]
        },
        align_items: AlignItems::CENTER,
        ..grid(64.)
    }
    .grow()
    .min_h0();
    let mut out = vec![header(cx, c, 2)?, Div::new(st).kids([ring_box, legend])];
    out.extend(source(cx, "source", s(c, "source")));
    Ok(out.into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Der Markt ist groß genug", "tam": { "value": "2 Mrd €", "label": "Gesamtmarkt" }, "sam": { "value": "400 Mio €", "label": "Erreichbar" }, "som": { "value": "20 Mio €", "label": "Unser Ziel" } }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Markt", "title": "Schon 5 % der Grundschulen in DACH tragen ein profitables Geschäft",
                "tam": { "value": "1,2 Mrd €", "label": "Digitale Lernmittel an Schulen in DACH" },
                "sam": { "value": "180 Mio €", "label": "Deutsch und Rechtschreibung, Klasse 1–6" },
                "som": { "value": "9 Mio €", "label": "5 % der Grundschulen bis 2029" },
                "source": "Bildungsbericht 2026, eigene Hochrechnung",
            }),
        ),
        (
            "max",
            json!({
                "eyebrow": words_x(28, 0), "title": words_x(90, 0),
                "tam": { "value": "€ 12,3 Mrd", "label": words_x(60, 0) }, "sam": { "value": "€ 1,23 Mrd", "label": words_x(60, 2) },
                "som": { "value": "€ 123 Mio", "label": words_x(60, 4) }, "source": words_x(90, 0),
            }),
        ),
    ]
}
