//! Team (layouts-extra.tsx Team, layouts-extra.css „.team“): Porträt rund oder Initialen, Name, Rolle, Zeile.

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::samples::{rep, words};
use crate::tree::{BoxSpec, Div, Kind};

pub const VARIANTS: &[&str] = &[];

pub const DEF: Def = Def {
    footer: true,
    frames: &["center"],
    tone: None,
    hero: false,
    build,
    samples,
};

fn initials(name: &str) -> String {
    let n = name.trim_start_matches("Dr.").trim_start_matches("Prof.").trim();
    n.split_whitespace()
        .filter_map(|w| w.chars().next())
        .take(2)
        .collect::<String>()
        .to_uppercase()
}

fn build(cx: &Cx, c: &Value, _: Option<&str>) -> Result<Body, Error> {
    let people = arr(c, "people");
    let n = people.len();
    let few = n <= 4;
    let (pic, pic_mb) = if few { (176., 12.) } else { (104., 4.) };
    let mut cells = Vec::new();
    for (i, p) in people.iter().enumerate() {
        let b = Some(i as u32);
        let name = req(p, "name")?;
        let st = Style::DEFAULT.rel().none().wh(pic, pic).mb(pic_mb);
        let pic_div = match p.get("image").and_then(|im| photo(cx, &format!("people.{i}.image"), im, st.clone())) {
            Some(mut d) => {
                if let Kind::Img(spec) = &mut d.kind {
                    spec.build = b;
                    spec.round = true;
                }
                d
            }
            None => {
                let mut ini = cx.t(Role::H2, format!("_ini.{i}.t"), &initials(name));
                ini.build = b;
                ini.color = cx.pal.accent;
                Div::new(st.items(AlignItems::CENTER).justify(JustifyContent::CENTER))
                    .boxel(BoxSpec {
                        ellipse: true,
                        ..bx(format!("_ini.{i}"), b, Some(cx.tk.accent_tint))
                    })
                    .kids([t(ini)])
            }
        };
        let small = if few { Role::Label } else { Role::Small };
        let mut nm = cx.t(if few { Role::H2 } else { Role::H3 }, format!("people.{i}.name"), name);
        let mut role = cx.t(small, format!("people.{i}.role"), req(p, "role")?);
        role.color = cx.pal.accent;
        role.weight = 700.;
        let mut kids = vec![pic_div];
        for spec in [&mut nm, &mut role] {
            spec.build = b;
            spec.center = true;
        }
        kids.extend([t(nm), t(role)]);
        if let Some(line) = s(p, "line") {
            let mut spec = cx.t(small, format!("people.{i}.line"), line);
            spec.build = b;
            spec.center = true;
            spec.color = cx.pal.muted;
            kids.push(t(spec));
        }
        cells.push(Div::new(col(8.).items(AlignItems::CENTER).min_w0().max_w(300.)).kids(kids));
    }
    let mut st = grid_cols(cx, &vec![1.; if n > 4 { 3 } else { n.max(1) }], 0., Stack::Narrow);
    st.gap = Size { width: length(32.), height: length(24.) };
    st.align_content = AlignContent::START;
    st.justify_items = AlignItems::CENTER;
    let st = st.grow().min_h0();
    Ok(vec![header(cx, c, 2)?, Div::new(st).kids(cells).clip().fit("people")].into())
}

fn samples() -> [(&'static str, Value); 3] {
    [
        (
            "min",
            json!({ "title": "Zwei Gründer, ein Ziel", "people": [{ "name": "Anna Berg", "role": "CEO" }, { "name": "Tom Kraus", "role": "CTO" }] }),
        ),
        (
            "typ",
            json!({ "eyebrow": "Team", "title": "Ein Team aus Schule, Sprachforschung und Software", "people": [
                { "name": "Julia Hartmann", "role": "CEO · Lehrerin a. D.", "line": "12 Jahre Grundschule, kennt den Alltag" },
                { "name": "Dr. Emre Yilmaz", "role": "Forschung", "line": "Promotion in Sprachdidaktik" },
                { "name": "Lena Vogt", "role": "CTO", "line": "Baute Lernapps für 2 Mio Nutzer" },
                { "name": "Paul Neumann", "role": "Vertrieb Schulen", "line": "Kontakte zu 300 Schulträgern" },
            ] }),
        ),
        (
            "max",
            json!({ "eyebrow": words(28, 0), "title": words(90, 0), "people": rep(6, |i| json!({ "name": words(28, i), "role": words(40, i + 1), "line": words(70, i + 2), "image": { "src": "" } })) }),
        ),
    ]
}
