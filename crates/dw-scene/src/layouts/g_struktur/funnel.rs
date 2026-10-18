//! Trichter (layouts-extra.tsx Funnel, layouts-extra.css „fn“): Balken je Stufe, größter Abfall in Akzent.

use dw_theme::{Elements, Role};
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use super::words_x as words;
use crate::Error;
use crate::blocks::*;
use crate::samples::rep;
use crate::tree::{BoxSpec, Div};

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &["band"],
    tone: None,
    hero: false,
    build,
    samples,
};

/// num() in layouts-extra.tsx: Zahl aus „12.400“, „38 %“, „1,2 Mio“ (parseFloat-Präfix); None = NaN
fn num(s: &str) -> Option<f64> {
    let s = s.split('–').next().unwrap_or("");
    let ch: Vec<char> = s.chars().collect();
    // .(?=\d{3}) entfernen
    let mut t = String::new();
    for (i, &c) in ch.iter().enumerate() {
        if c == '.' && ch.len() > i + 3 && ch[i + 1..i + 4].iter().all(char::is_ascii_digit) {
            continue;
        }
        t.push(c);
    }
    let t = t.replacen(',', ".", 1);
    let t: String = t
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
        .collect();
    // parseFloat: längstes gültiges Präfix
    let (mut end, mut dot, mut digit) = (0, false, false);
    for (i, c) in t.char_indices() {
        match c {
            '-' if i == 0 => {}
            '.' if !dot => dot = true,
            '0'..='9' => digit = true,
            _ => break,
        }
        end = i + 1;
    }
    if !digit {
        return None;
    }
    t[..end].trim_end_matches('.').parse().ok()
}

fn build(cx: &Cx, c: &Value, _v: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let el = cx.elements();
    let stages = arr(c, "stages");
    let n = stages.len();
    let vals: Vec<Option<f64>> = stages
        .iter()
        .map(|st| s(st, "value").and_then(num))
        .collect();
    let conv: Option<Vec<f64>> = vals.iter().all(|x| x.is_some_and(|x| x > 0.)).then(|| {
        vals.iter()
            .enumerate()
            .map(|(i, x)| {
                if i > 0 {
                    x.unwrap() / vals[i - 1].unwrap()
                } else {
                    1.
                }
            })
            .collect()
    });
    // indexOf(Math.min(...conv.slice(1))) über die ganze Liste wie im TS
    let drop: i64 = conv.as_ref().map_or(-1, |cv| {
        let m = cv[1..].iter().copied().fold(f64::INFINITY, f64::min);
        cv.iter().position(|&x| x == m).map_or(-1, |p| p as i64)
    });
    let mut rows = Vec::new();
    for (i, st) in stages.iter().enumerate() {
        let b = Some(i as u32);
        let hl = drop < 0 || i as i64 == drop;
        let mut val = cx.t(Role::H3, format!("stages.{i}.value"), req(st, "value")?);
        val.build = b;
        val.nowrap = true;
        val.color = if hl { tk.on_accent } else { cx.pal.text };
        let pct = 100. - (i as f32 * 55.) / (n.max(2) - 1) as f32;
        let mut bar_st = row(0.)
            .items(AlignItems::CENTER)
            .h(64.)
            .pad(0., 0., 0., 20.);
        bar_st.size.width = Dimension::percent(pct / 100.);
        bar_st.justify_self = Some(AlignSelf::START);
        let bar = Div::new(bar_st)
            .boxel(BoxSpec {
                radius: tk.radius as f32,
                ..bx(
                    format!("_bar.{i}"),
                    b,
                    Some(if hl { tk.fill } else { tk.surface2 }),
                )
            })
            .kids([t(val)]);
        let mut label = cx.t(Role::Label, format!("stages.{i}.label"), req(st, "label")?);
        label.build = b;
        label.weight = 700.;
        let mut side = vec![t(label)];
        if let (Some(cv), true) = (&conv, i > 0) {
            let mut cs = cx.t(
                Role::Small,
                format!("_conv.{i}"),
                &format!("{} % der Vorstufe", (cv[i] * 100.).round()),
            );
            cs.build = b;
            if i as i64 == drop {
                cs.color = cx.pal.accent;
                cs.weight = 700.;
            }
            side.push(t(cs));
        }
        rows.push(
            Div::new(Style {
                grid_template_columns: vec![fr(1.), length(220.)],
                align_items: AlignItems::CENTER,
                ..grid(20.)
            })
            .kids([bar, Div::new(col(2.)).kids(side)]),
        );
    }
    let bars = Div::new(col(10.).justify(JustifyContent::CENTER).min_h0())
        .kids(rows)
        .fit("stages")
        .clip();
    let mut kids = vec![bars];
    if let Some(take) = s(c, "takeaway") {
        let nb = Some(n as u32);
        let mut tx = cx.t(Role::Body, "takeaway", take);
        tx.build = nb;
        // .card.take-card; line/plain: ohne Fläche, line mit 2-px-Akzentlinie
        let (pad, fill, j) = match el {
            Elements::Solid => ([32.; 4], Some(tk.accent_tint), JustifyContent::CENTER),
            Elements::Line => ([28., 0., 4., 0.], None, JustifyContent::FLEX_START),
            Elements::Plain => ([0., 0., 4., 0.], None, JustifyContent::CENTER),
        };
        let line = (el == Elements::Line).then(|| top_line(2., cx.pal.accent));
        kids.push(
            Div::new(
                col(12.)
                    .pad(pad[0], pad[1], pad[2], pad[3])
                    .justify(j)
                    .min_w0()
                    .min_h0()
                    .rel(),
            )
            .kids(line.into_iter().chain([t(tx)]))
            .boxel(BoxSpec {
                radius: if fill.is_some() { tk.radius as f32 } else { 0. },
                ..bx("_take", nb, fill)
            })
            .fit("_take")
            .clip(),
        );
    }
    let cols = if kids.len() > 1 && !cx.narrow {
        vec![fr(1.), length(320.)]
    } else {
        vec![fr(1.)]
    };
    let st = Style {
        grid_template_columns: cols,
        align_items: AlignItems::CENTER,
        ..grid(40.)
    }
    .grow()
    .min_h0();
    Ok(vec![header(cx, c, 2)?, Div::new(st).kids(kids)].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Jeder zehnte Lead wird Kunde", "stages": [{ "label": "Leads", "value": "400" }, { "label": "Angebote", "value": "120" }, { "label": "Kunden", "value": "40" }] }),
        ),
        (
            "typ",
            json!({
                "eyebrow": "Vertrieb", "title": "Der größte Verlust liegt zwischen Demo und Angebot",
                "stages": [{ "label": "Website-Besucher", "value": "48.000" }, { "label": "Anfragen", "value": "2.100" }, { "label": "Demos", "value": "640" }, { "label": "Angebote", "value": "190" }, { "label": "Neue Schulen", "value": "84" }],
                "takeaway": "Nur 30 % der Demos führen zu einem Angebot – hier setzt das neue Pilotpaket an.",
            }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(90, 0), "stages": rep(5, |i| json!({ "label": words(28, i), "value": "€ 1.234,5" })), "takeaway": words(120, 0) }),
        ),
    ]
}

#[cfg(test)]
mod tests {
    #[test]
    fn num_like_ts() {
        assert_eq!(super::num("48.000"), Some(48000.));
        assert_eq!(super::num("€ 1.234,5"), Some(1234.5));
        assert_eq!(super::num("1,2 Mio"), Some(1.2));
        assert_eq!(super::num("38 %"), Some(38.));
        assert_eq!(super::num("10–20"), Some(10.));
        assert_eq!(super::num("viele"), None);
    }
}
