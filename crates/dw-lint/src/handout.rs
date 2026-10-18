//! Handout (handout.ts, Canva „Deck → Doc“): Titel als Überschrift, übrige Texte als Liste, Tabellen, Notizen als Zitat.

use dw_model::{Deck, ItemKind};
use serde_json::Value;

use crate::js::{self, trim};

const SKIP: [&str; 14] = ["image", "src", "icon", "logo", "url", "href", "qr", "photo", "focus", "look", "color", "video", "captions", "pauses"];

fn texts(v: &Value, k: &str, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            let skip = SKIP.iter().any(|x| x.eq_ignore_ascii_case(k));
            if !(skip || s.starts_with("asset:") || s.starts_with("http:") || s.starts_with("https:") || trim(s).is_empty()) {
                out.push(trim(s).to_string());
            }
        }
        Value::Array(a) => a.iter().for_each(|x| texts(x, k, out)),
        Value::Object(o) => o.iter().for_each(|(kk, x)| texts(x, kk, out)),
        _ => {}
    }
}

// /\n+/g → ' '
fn one_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut nl = false;
    for c in s.chars() {
        if c == '\n' {
            if !nl {
                out.push(' ');
            }
            nl = true;
        } else {
            out.push(c);
            nl = false;
        }
    }
    out
}

// Zeile 0 = Kopf; | in Zellen escapen, Zeilenumbrüche zu Leerzeichen
fn md_table(c: &[Vec<String>], out: &mut Vec<String>) {
    let row = |r: &[String]| format!("| {} |", r.iter().map(|x| one_line(&x.replace('|', "\\|"))).collect::<Vec<_>>().join(" | "));
    out.push(row(&c[0]));
    out.push(format!("|{}|", vec!["---"; c[0].len()].join("|")));
    out.extend(c[1..].iter().map(|r| row(r)));
}

pub fn handout(deck: &Deck) -> String {
    let mut out = vec![format!("# {}", deck.title), String::new()];
    for (i, s) in deck.slides.iter().enumerate() {
        let mut c = s.content.as_object().cloned().unwrap_or_default();
        // statement/quote haben keinen Titel
        let key = ["title", "text", "quote"].into_iter().find(|k| c.get(*k).and_then(Value::as_str).is_some_and(|v| !trim(v).is_empty()));
        let title = key.map_or("Folie".to_string(), |k| trim(c[k].as_str().unwrap()).to_string());
        if let Some(k) = key {
            c.shift_remove(k);
        }
        let mut body = Vec::new();
        texts(&Value::Object(c), "", &mut body);
        for it in s.items.iter().flatten() {
            if it.kind == ItemKind::Text
                && let Some(t) = &it.text
            {
                texts(&Value::String(t.clone()), "", &mut body);
            }
        }
        out.push(format!("## {}. {}", i + 1, one_line(&title)));
        out.push(String::new());
        out.extend(body.iter().map(|t| format!("- {}", one_line(t))));
        for it in s.items.iter().flatten() {
            if it.kind == ItemKind::Table
                && let Some(cells) = it.cells.as_ref().filter(|c| !c.is_empty())
            {
                out.push(String::new());
                md_table(cells, &mut out);
            }
        }
        if let Some(n) = s.extra.get("notes").and_then(Value::as_str).map(trim).filter(|n| !n.is_empty()) {
            out.push(String::new());
            out.extend(n.split('\n').map(|l| format!("> {l}")));
        }
        out.push(String::new());
    }
    out.join("\n")
}

/// Sprechzeit der Notizen in Sekunden (~130 Wörter pro Minute, freier Vortrag).
pub fn speak_sec(notes: Option<&str>) -> f64 {
    js::round(js::words(notes.unwrap_or("")).len() as f64 / 130.0 * 60.0)
}

pub fn fmt_sec(s: f64) -> String {
    if s < 60.0 { format!("{} s", js::num(s)) } else { format!("{} min", js::num(js::round(s / 60.0))) }
}
