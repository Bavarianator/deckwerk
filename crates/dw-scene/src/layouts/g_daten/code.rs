//! Code (layouts-demo.tsx Code, layouts-demo.css „.dwc“): ein Textfeld in Mono auf einer Fläche, Notiz darunter.
//! ponytail: ohne Syntaxfarben und Fokus-Dämpfung (ein Lauf je Textfeld), bis TextSpec Läufe mit Farben kann

use dw_theme::Role;
use serde_json::{Value, json};
use taffy::prelude::*;

use super::super::Def;
use crate::Error;
use crate::blocks::*;
use crate::tree::{BoxSpec, Div};

pub const VARIANTS: &[&str] = &["editor", "terminal"];

pub const DEF: Def = Def {
    footer: true,
    frames: &[],
    tone: None,
    hero: false,
    build,
    samples,
};

/// codeLines (layouts-demo.ts): Tabs als zwei Leerzeichen, ohne Leerzeilen am Anfang und Ende.
fn code_lines(code: &str) -> Vec<String> {
    let c = code.replace('\r', "").replace('\t', "  ");
    let c = c.trim_end();
    let start = c.find(|ch: char| !ch.is_whitespace()).map(|i| c[..i].rfind('\n').map_or(0, |n| n + 1)).unwrap_or(0);
    c[start..].split('\n').map(str::to_string).collect()
}

fn build(cx: &Cx, c: &Value, v: Option<&str>) -> Result<Body, Error> {
    let terminal = v == Some("terminal");
    let lines = code_lines(req(c, "code")?);
    let big = lines.len() <= 10 && lines.iter().all(|l| l.chars().count() <= 60);
    let mut kids = Vec::new();
    if let (Some(title), false) = (s(c, "title"), terminal) {
        kids.push(header(cx, &json!({ "title": title }), 2)?);
    }
    let mut panel = Vec::new();
    if terminal {
        let mut bar = cx.t(Role::Label, if s(c, "title").is_some() { "title" } else { "_bar" }, s(c, "title").unwrap_or("Terminal"));
        bar.color = cx.pal.muted;
        panel.push(t(bar));
    }
    // Leerzeilen tragen ein Leerzeichen, sonst gingen sie in der PPTX verloren
    let text: Vec<&str> = lines.iter().map(|l| if l.trim().is_empty() { " " } else { l.as_str() }).collect();
    let mut spec = cx.t(if big { Role::Body } else { Role::Small }, "code", &text.join("\n"));
    spec.family = "'IBM Plex Mono'".into();
    spec.lh = 1.4;
    spec.tracking_em = 0.;
    spec.face = Some(cx.theme.mono.as_ref().map_or("Courier New".into(), |m| m.pptx.clone()));
    panel.push(t(spec));
    let mut pst = col(14.).none().pad(20., 24., 20., 24.);
    pst.max_size.width = LengthPercentageAuto::percent(1.);
    pst.min_size.width = pxa(560.);
    let mut body = vec![Div::new(pst).kids(panel).boxel(BoxSpec {
        radius: cx.tk.radius as f32,
        ..bx("_panel", None, Some(cx.tk.surface))
    })];
    if let Some(note) = s(c, "note") {
        let mut spec = cx.t(Role::Label, "note", note);
        spec.color = cx.pal.muted;
        body.push(t_styled(spec, Style::DEFAULT.max_wo(cx.measure(1000.))));
    }
    let st = col(20.).grow().min_h0().items(AlignItems::FLEX_START);
    kids.push(Div::new(st).kids(body).clip().fit("code"));
    Ok(kids.into())
}

fn fill(s: &str, n: usize) -> String {
    let mut out = s.to_string();
    while out.chars().count() < n {
        out.push_str(" wert");
    }
    out.chars().take(n).collect()
}

fn samples() -> [(&'static str, Value); 3] {
    let max: Vec<String> = (0..20)
        .map(|i| fill(&format!("    summe_{i} = berechne(region=\"Nord\", quartal={i}, faktor=1.25)  # Prüfwert"), 90))
        .collect();
    [
        ("min", json!({ "code": "print(\"Hallo, Welt\")" })),
        (
            "typ",
            json!({ "title": "Eine Abfrage liefert den Wochenumsatz", "lang": "ts", "focus": "6-7",
                "code": "// Bestellungen der letzten sieben Tage laden\nconst seit = new Date(Date.now() - 7 * 864e5)\nconst res = await fetch(`/api/orders?since=${seit.toISOString()}`)\nif (!res.ok) throw new Error(`HTTP ${res.status}`)\n\nconst orders = await res.json()\nconst umsatz = orders.reduce((s, o) => s + o.total, 0)\nconsole.log(`${orders.length} Bestellungen, ${umsatz} €`)",
                "note": "reduce summiert die Beträge aller Bestellungen in einem Durchlauf." }),
        ),
        (
            "max",
            json!({ "title": fill("Der Bericht entsteht in einem Durchlauf", 50), "lang": "python", "focus": "3-5,8", "reveal": "tippen",
                "code": max.join("\n"), "note": fill("Jede Zeile berechnet eine Region; die markierten Zeilen fließen in den Bericht ein", 140) }),
        ),
    ]
}
