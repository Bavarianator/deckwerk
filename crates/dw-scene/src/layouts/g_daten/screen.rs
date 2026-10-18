//! Bildschirm (layouts-demo.tsx Screen, layouts-demo.css „.dws“): Screenshot im Rahmen, Bildunterschrift daneben.
//! ponytail: Fenster über aspect-ratio statt cq-Rechnung, ohne Mauszeiger, Video und Schatten (ohne); Ausbau bei Refcheck-Abweichung

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::tree::{BoxSpec, Div, Kind};

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, _: Option<&str>) -> Result<Body, Error> {
    let tk = cx.tk;
    let frame = s(c, "frame").unwrap_or("browser");
    let bar = matches!(frame, "browser" | "fenster");
    let (pad, r) = match frame {
        "handy" => (10., 40.),
        "browser" | "fenster" => (1., (tk.radius as f32).min(12.)),
        _ => (0., (tk.radius as f32).min(12.)),
    };
    let ar = if frame == "handy" { 9. / 19.5 } else { 16. / 10. };
    let mut kids = Vec::new();
    if let Some(title) = s(c, "title") {
        kids.push(header(cx, &json!({ "title": title }), 2)?);
    }
    let mut win = Vec::new();
    if bar {
        let h = cx.fs_raw(Role::Small) * 2.6;
        let url = s(c, "url").map(|u| {
            let mut spec = cx.t(Role::Small, "url", u);
            spec.nowrap = true;
            if frame == "fenster" {
                spec.color = cx.pal.text;
            }
            t(spec)
        });
        let inner = if frame == "browser" {
            let mut st = row(0.).items(AlignItems::CENTER).justify(JustifyContent::CENTER).pad(0., 16., 0., 16.);
            st.min_size.width = LengthPercentageAuto::percent(0.5);
            st.size.height = Dimension::percent(0.7);
            vec![Div::new(st).kids(url).boxel(BoxSpec { radius: 999., ..bx("_url", None, Some(tk.bg)) })]
        } else {
            url.into_iter().collect()
        };
        win.push(Div::new(row(0.).none().h(h).items(AlignItems::CENTER).justify(JustifyContent::CENTER).pad(0., 16., 0., 16.)).kids(inner));
    }
    let inset = || abs(Some(0.), Some(0.), Some(0.), Some(0.));
    let img = c
        .get("image")
        .and_then(|im| photo(cx, "image", im, inset()))
        .map(|mut d| {
            if let Kind::Img(spec) = &mut d.kind {
                spec.radius = (r - pad).max(0.);
                spec.focus = (0.5, 0.);
                spec.look = None;
            }
            d
        })
        .unwrap_or_else(|| Div::new(inset()).paint(tk.surface2));
    let mut mst = Style::DEFAULT.rel().grow().min_h0();
    mst.aspect_ratio = Some(ar);
    win.push(Div::new(mst).kids([img]).clip());
    let fill = if frame == "handy" { cx.pal.text } else { tk.surface };
    let mut wst = col(0.).none().pad(pad, pad, pad, pad);
    wst.size.height = Dimension::percent(1.);
    wst.max_size.width = LengthPercentageAuto::percent(1.);
    let stage = Div::new(wst).kids(win).boxel(BoxSpec { radius: r, ..bx("_frame", None, Some(fill)) });
    let mut dk = vec![stage];
    if let Some(cap) = s(c, "caption") {
        dk.push(t_styled(cx.t(Role::Body, "caption", cap), Style::DEFAULT.grow().min_w0().max_w(420.)));
    }
    let st = if cx.tall { col(28.) } else { row(40.) }.grow().min_h0();
    if cx.tall {
        dk.reverse(); // Bildunterschrift über dem Fenster
    }
    kids.push(Div::new(st).kids(dk).fit("caption"));
    Ok(kids.into())
}

fn samples() -> [(&'static str, Value); 3] {
    let fill = |s: &str, n: usize| {
        let mut out = s.to_string();
        while out.chars().count() < n {
            out.push_str(" wert");
        }
        out.chars().take(n).collect::<String>()
    };
    [
        ("min", json!({ "image": { "src": "" }, "frame": "handy" })),
        (
            "typ",
            json!({ "title": "Der Export dauert drei Klicks", "image": { "src": "" }, "url": "example.com/export",
                "caption": "Format wählen, prüfen, herunterladen: Die Datei lässt sich sofort in PowerPoint bearbeiten.",
                "cursor": [{ "x": 0.2, "y": 0.3 }, { "x": 0.62, "y": 0.55, "click": true }, { "x": 0.84, "y": 0.86, "click": true, "zoom": 2 }] }),
        ),
        (
            "max",
            json!({ "title": fill("Der Export dauert drei Klicks", 60), "image": { "src": "" }, "frame": "browser", "url": fill("example.com/export", 60),
                "caption": fill("Format wählen, prüfen, herunterladen", 140) }),
        ),
    ]
}
