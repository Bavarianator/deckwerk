//! Serienbrief (merge.ts): CSV-Zeilen füllen `{{Spalte}}` in Titel, Inhalt, Textfeldern, Tabellenzellen und Notizen.

use std::sync::LazyLock;

use dw_model::Deck;
use regex::{Captures, Regex};
use serde_json::Value;

use crate::js::{WS, trim};

static PH: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"\{{\{{[{WS}]*([^{{}}]+?)[{WS}]*\}}\}}")).unwrap());

/// Eine CSV-Zeile: Spalte → Wert in Spaltenreihenfolge (doppelte Spalte: Wert der letzten wie `Object.fromEntries`).
pub type Row = Vec<(String, String)>;

fn get<'a>(row: &'a Row, k: &str) -> Option<&'a str> {
    row.iter().find(|(c, _)| c == k).map(|(_, v)| v.as_str())
}

/// CSV mit Kopfzeile; Trennzeichen , oder ; (häufigeres in der Kopfzeile außerhalb von Anführungszeichen), "" escapt ein Anführungszeichen.
pub fn parse_csv(text: &str) -> Vec<Row> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let (mut comma, mut semi) = (0, 0);
    let mut q = false;
    for c in text.chars() {
        if c == '"' {
            q = !q;
        } else if !q && (c == '\n' || c == '\r') {
            break;
        } else if !q && c == ',' {
            comma += 1;
        } else if !q && c == ';' {
            semi += 1;
        }
    }
    let sep = if semi > comma { ';' } else { ',' };
    let cs: Vec<char> = text.chars().collect();
    let mut rows: Vec<Vec<String>> = Vec::new();
    let (mut row, mut cell, mut quoted, mut start) = (Vec::new(), String::new(), false, true); // start: Zellanfang, nur dort öffnet " (RFC 4180)
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if quoted {
            if c == '"' && cs.get(i + 1) == Some(&'"') {
                cell.push('"');
                i += 1;
            } else if c == '"' {
                quoted = false;
            } else {
                cell.push(c);
            }
            i += 1;
            continue;
        }
        if c == '"' && start {
            quoted = true;
        } else if c == sep {
            row.push(std::mem::take(&mut cell));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && cs.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut cell));
            rows.push(std::mem::take(&mut row));
        } else {
            cell.push(c);
        }
        start = c == sep || c == '\n' || c == '\r';
        i += 1;
    }
    row.push(cell);
    rows.push(row);
    let mut rows = rows.into_iter().filter(|r| r.iter().any(|v| !trim(v).is_empty()));
    let keys: Vec<String> = rows.next().unwrap_or_default();
    rows.map(|r| {
        let mut out: Row = Vec::new();
        for (i, k) in keys.iter().enumerate() {
            let (k, v) = (trim(k).to_string(), r.get(i).map(|v| trim(v).to_string()).unwrap_or_default());
            match out.iter_mut().find(|(c, _)| *c == k) {
                Some(e) => e.1 = v,
                None => out.push((k, v)),
            }
        }
        out
    })
    .collect()
}

fn fill(s: &str, row: &Row) -> String {
    PH.replace_all(s, |c: &Captures| get(row, &c[1]).unwrap_or(&c[0]).to_string()).into_owned()
}

fn walk(v: &mut Value, f: &mut impl FnMut(&mut String)) {
    match v {
        Value::String(s) => f(s),
        Value::Array(a) => a.iter_mut().for_each(|x| walk(x, f)),
        Value::Object(o) => o.values_mut().for_each(|x| walk(x, f)),
        _ => {}
    }
}

/// Kopie des Decks mit ersetzten Platzhaltern; unbekannte bleiben stehen.
pub fn fill_deck(deck: &Deck, row: &Row) -> Deck {
    let mut d = deck.clone();
    let mut f = |s: &mut String| *s = fill(s, row);
    f(&mut d.title);
    for s in &mut d.slides {
        walk(&mut s.content, &mut f);
        if let Some(Value::String(n)) = s.extra.get_mut("notes")
            && !n.is_empty()
        {
            f(n);
        }
        for it in s.items.iter_mut().flatten() {
            if let Some(t) = it.text.as_mut().filter(|t| !t.is_empty()) {
                f(t);
            }
            for c in it.cells.iter_mut().flatten().flatten() {
                f(c);
            }
        }
    }
    d
}

/// Namen aller `{{Platzhalter}}` im Deck (gleiche Felder wie `fill_deck`), in Fundreihenfolge.
pub fn placeholders(deck: &Deck) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let mut add = |s: &str| {
        for c in PH.captures_iter(s) {
            if !names.iter().any(|n| n == &c[1]) {
                names.push(c[1].to_string());
            }
        }
    };
    add(&deck.title);
    for s in &deck.slides {
        let mut v = s.content.clone();
        walk(&mut v, &mut |t| add(t));
        if let Some(Value::String(n)) = s.extra.get("notes") {
            add(n);
        }
        for it in s.items.iter().flatten() {
            if let Some(t) = &it.text {
                add(t);
            }
            for c in it.cells.iter().flatten().flatten() {
                add(c);
            }
        }
    }
    names
}
