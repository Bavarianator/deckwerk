//! Stream-Bildschirm (layouts-extra.tsx StreamScreen, layouts-extra.css „ss-“): Titel übergroß, unten handle und Uhrzeit.

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::words;
use crate::tree::Div;

pub const VARIANTS: &[&str] = &["start", "pause", "ende"];

pub const DEF: Def = Def {
    footer: false,
    frames: &[],
    tone: None,
    hero: true,
    build,
    samples,
};

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let k = match v {
        Some("pause") => "pause",
        Some("ende") => "ende",
        _ => "start",
    };
    let mut title = cx.t(Role::Display, "title", req(c, "title")?);
    title.size *= 1.45;
    title.lh = 1.;
    title.tracking_em = -0.03;
    title.max_lines = Some(2);
    title.build = Some(0);
    let mut main = vec![t_styled(title, Style::DEFAULT.max_w(1080.))];
    if let Some(sub) = s(c, "subtitle") {
        let mut spec = cx.t(Role::H2, "subtitle", sub);
        spec.color = cx.pal.muted;
        spec.max_lines = Some(2);
        spec.build = Some(0);
        main.push(t_styled(spec, Style::DEFAULT.max_w(860.)));
    }
    let main_st = col(24.).grow().min_h0().justify(JustifyContent::CENTER);
    let mut kids = vec![Div::new(main_st).kids(main)];
    let (handle, time) = (s(c, "handle"), s(c, "time"));
    if handle.is_some() || time.is_some() {
        let left = match handle {
            Some(h) => {
                let mut spec = cx.t(if k == "ende" { Role::H2 } else { Role::Label }, "handle", h);
                // nur ein Akzent pro Bildschirm: bei ende trägt ihn der handle, sonst die Uhrzeit
                if k == "ende" {
                    spec.color = cx.pal.accent;
                }
                t_styled(spec, Style::DEFAULT.min_w0())
            }
            None => Div::new(Style::DEFAULT),
        };
        let mut foot = vec![
            // .ss-foot::before: Haarlinie (currentColor 20 %) ~ Theme-Rand
            Div::new(abs(Some(0.), Some(0.), Some(0.), None).h(1.)).paint(cx.tk.border),
            left,
        ];
        if let Some(tm) = time {
            let label = match k {
                "pause" => "Weiter um",
                "ende" => "Nächster Stream",
                _ => "Start",
            };
            let mut clock = cx.t(Role::H1, "time", tm);
            clock.nowrap = true;
            if k != "ende" {
                clock.color = cx.pal.accent;
            }
            let st = col(4.).none().items(AlignItems::FLEX_END);
            foot.push(Div::new(st).kids([t(cx.t(Role::Eyebrow, "_time.label", label)), t(clock)]));
        }
        let st = row(40.)
            .justify(JustifyContent::SPACE_BETWEEN)
            .items(AlignItems::FLEX_END)
            .none()
            .rel()
            .pad(20., 0., 6., 0.);
        kids.push(Div::new(st).kids(foot));
    }
    let st = col(40.).grow().min_h0().justify(JustifyContent::SPACE_BETWEEN);
    Ok(vec![Div::new(st).kids(kids)].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        ("min", json!({ "title": "Pause" })),
        (
            "typ",
            json!({ "title": "Gleich geht's los", "subtitle": "Wir bauen heute die Brücke über den Fluss fertig", "handle": "twitch.tv/name", "time": "20:00" }),
        ),
        (
            "max",
            json!({ "title": words(40, 0), "subtitle": words(80, 0), "handle": words(40, 1), "time": "20:00 Uhr" }),
        ),
    ]
}
