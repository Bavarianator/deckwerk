//! Große Zahl (layouts-extra.tsx BigNumber, layouts-extra.css „bign“): Zahl, Aussage, Einordnung, Foto rechts;
//! Variante poster (ohne Foto): Zahl übergroß unten, Aussage oben rechts.

use dw_model::Profile;
use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::{photo_src, placeholder, words_x};
use crate::Error;
use crate::blocks::*;
use crate::tree::Div;

pub const VARIANTS: &[&str] = &["plain", "poster"];

pub const DEF: Def = Def {
    footer: true,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let inset = || abs(Some(0.), Some(0.), Some(0.), Some(0.));
    let image = c.get("image").filter(|i| photo_src(i).is_some());
    let mut value = cx.t(Role::Hero, "value", req(c, "value")?);
    value.build = Some(0);
    value.unit = true;
    value.color = cx.pal.accent;
    let mut label = cx.t(Role::H1, "label", req(c, "label")?);
    label.build = Some(0);
    let context = s(c, "context").map(|x| {
        let mut spec = cx.t(Role::Body, "context", x);
        spec.build = Some(0);
        spec.color = cx.pal.muted;
        t(spec)
    });
    let source = s(c, "source").map(|x| t_styled(cx.t(Role::Footer, "source", x), Style::DEFAULT.none().mt(18.)).clip());
    if v == Some("poster") && image.is_none() {
        let k = if cx.profile == Profile::Social {
            1.2
        } else if cx.narrow {
            1.3
        } else {
            1.8
        };
        value.size = cx.fs_raw(Role::Hero) * k;
        value.lh = 1.;
        label.max_lines = Some(5);
        let eb = match s(c, "eyebrow") {
            Some(e) => t(cx.t(Role::Eyebrow, "eyebrow", e)),
            None => Div::new(Style::DEFAULT),
        };
        let mut side_st = col(16.).none();
        if !cx.narrow {
            side_st.size.width = Dimension::length(440.);
        }
        let side = Div::new(side_st).kids([t(label)].into_iter().chain(context));
        let top = if cx.narrow {
            col(24.)
        } else {
            row(64.).justify(JustifyContent::SPACE_BETWEEN)
        };
        let bign = Div::new(col(32.).grow().min_h0().justify(JustifyContent::SPACE_BETWEEN))
            .kids([
                Div::new(top).kids([eb, side]),
                t_styled(value, Style::DEFAULT.none()).clip(),
            ])
            .fit("_body")
            .clip();
        return Ok(vec![bign].into_iter().chain(source).collect::<Vec<_>>().into());
    }
    value.lh = 0.95;
    label.max_lines = Some(if image.is_some() { 4 } else { 3 });
    let mut kids: Vec<Div> = s(c, "eyebrow")
        .map(|e| t(cx.t(Role::Eyebrow, "eyebrow", e)))
        .into_iter()
        .collect();
    kids.push(t(value));
    kids.push(t_styled(label, Style::DEFAULT.max_w(900.)));
    kids.extend(context);
    let bign = Div::new(
        col(22.)
            .grow()
            .min_h0()
            .justify(JustifyContent::CENTER)
            .max_wo(cx.measure(980.)),
    )
    .kids(kids)
    .fit("_body")
    .clip();
    let content: Vec<Div> = [bign].into_iter().chain(source).collect();
    Ok(match image {
        Some(im) => {
            let pic = photo(cx, "image", im, inset()).unwrap_or_else(|| placeholder(cx));
            Body {
                content,
                media: vec![media(cx, MediaSide::Right, vec![pic])],
                safe: Some(media_safe(cx, MediaSide::Right)),
            }
        }
        None => content.into(),
    })
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "value": "41 %", "label": "Weniger Fehler nach sechs Monaten" }),
        ),
        (
            "typ",
            json!({ "eyebrow": "Wirkung", "value": "−41 %", "label": "Mit Ortho-Bot machen Kinder nach sechs Monaten deutlich weniger Fehler", "context": "Pilot mit 412 Kindern an 6 Grundschulen, gleiche Unterrichtszeit wie die Vergleichsgruppe.", "source": "Pilotauswertung 2026" }),
        ),
        (
            "max",
            json!({ "eyebrow": words_x(28, 0), "value": "€ 12,4 M", "label": words_x(90, 0), "context": words_x(160, 0), "source": words_x(90, 0), "image": { "src": "" } }),
        ),
    ]
}
