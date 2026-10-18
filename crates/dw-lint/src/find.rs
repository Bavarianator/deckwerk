//! Suchen & Ersetzen im ganzen Deck (find.ts): Folieninhalt, freie Textfelder, Tabellenzellen, Notizen und Deck-Titel.
//! Die Schema-Prüfung der Layouts (zod in TS) kommt als [`SchemaCheck`] vom Aufrufer.

use std::collections::{HashMap, HashSet};

use dw_model::{Deck, ItemKind};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::js::is_ws;
use crate::{SchemaCheck, typo::is_letter};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindOpts {
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
}

/// slide −1 = Deck-Titel; n = wievielter Treffer im selben Feld
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hit {
    pub slide: i64,
    #[serde(rename = "where")]
    pub at: String,
    pub n: usize,
    pub label: String,
    pub text: String,
}

/// Ein Treffer, auf den sich `replace_in_deck` beschränkt (aus `find_in_deck`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Only {
    pub slide: i64,
    #[serde(rename = "where")]
    pub at: String,
    pub n: usize,
}

// Kein sichtbarer Text: Bild-, Link-, QR- und Icon-Felder sowie Auswahlwerte; highlight wandert beim Ersetzen mit (refs)
const SKIP: [&str; 14] = ["image", "src", "icon", "qr", "video", "captions", "pauses", "type", "look", "focus", "mask", "sentiment", "annotate", "highlight"];

fn label_of(at: &str) -> &'static str {
    if at == "title" {
        return "Deck-Titel";
    }
    if at == "notes" {
        return "Notizen";
    }
    if at.starts_with("items.") {
        return "Textfeld";
    }
    match at.split('.').nth(1) {
        Some("title") => "Titel",
        Some("subtitle") => "Untertitel",
        Some("eyebrow") => "Überzeile",
        Some("source") => "Quelle",
        Some("chart") => "Diagramm",
        Some("items" | "points") => "Liste",
        _ => "Text",
    }
}

struct Pattern {
    re: Regex,
    whole: bool,
}

fn pattern(q: &str, o: FindOpts) -> Pattern {
    let flags = if o.case_sensitive { "" } else { "(?i)" };
    Pattern { re: Regex::new(&format!("{flags}{}", regex::escape(q))).unwrap(), whole: o.whole_word }
}

fn word_char(c: char) -> bool {
    c == '_' || is_letter(c) || {
        let mut b = [0; 4];
        static N: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"^\p{N}$").unwrap());
        N.is_match(c.encode_utf8(&mut b))
    }
}

/// Treffer (Byte-Bereiche) in s; die Adresse eines Markdown-Links [Text](url) zählt nicht.
fn matches(s: &str, p: &Pattern) -> Vec<(usize, usize)> {
    static URL: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| Regex::new(r"\]\([^)]*\)").unwrap());
    let urls: Vec<(usize, usize)> = URL.find_iter(s).map(|m| (m.start(), m.end())).collect();
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(m) = p.re.find_at(s, at) {
        // (?<![\p{L}\p{N}_]) … (?![\p{L}\p{N}_]): sonst ab dem nächsten Zeichen weitersuchen
        let ok = !p.whole || (!s[..m.start()].chars().next_back().is_some_and(word_char) && !s[m.end()..].chars().next().is_some_and(word_char));
        if ok {
            out.push((m.start(), m.end()));
            at = m.end().max(m.start() + 1);
        } else {
            at = m.start() + s[m.start()..].chars().next().map_or(1, char::len_utf8);
        }
        if at > s.len() {
            break;
        }
    }
    out.retain(|&(a, b)| !urls.iter().any(|&(x, y)| a < y && b > x));
    out
}

fn walk(v: &mut Value, f: &mut dyn FnMut(&mut String, &str), at: &str) {
    match v {
        Value::String(s) => f(s, at),
        Value::Array(a) => {
            for (j, x) in a.iter_mut().enumerate() {
                walk(x, f, &format!("{at}.{j}"));
            }
        }
        Value::Object(o) => {
            for (k, x) in o.iter_mut() {
                if !SKIP.contains(&k.as_str()) {
                    walk(x, f, &format!("{at}.{k}"));
                }
            }
        }
        _ => {}
    }
}

// Jeder sichtbare Text des Decks durch f(text, folie, where); where = Pfad wie 'content.items.0.text', 'items.<id>', 'notes', 'title'
fn map_texts(deck: &mut Deck, f: &mut dyn FnMut(&mut String, i64, &str)) {
    f(&mut deck.title, -1, "title");
    for (i, s) in deck.slides.iter_mut().enumerate() {
        let i = i as i64;
        walk(&mut s.content, &mut |t, w| f(t, i, w), "content");
        for it in s.items.iter_mut().flatten() {
            if it.kind == ItemKind::Text && it.text.as_ref().is_some_and(|t| !t.is_empty()) {
                f(it.text.as_mut().unwrap(), i, &format!("items.{}", it.id));
            } else if let Some(cells) = &mut it.cells {
                for (y, r) in cells.iter_mut().enumerate() {
                    for (x, c) in r.iter_mut().enumerate() {
                        f(c, i, &format!("items.{}.cells.{y}.{x}", it.id));
                    }
                }
            }
        }
        if let Some(Value::String(n)) = s.extra.get_mut("notes") {
            f(n, i, "notes");
        }
    }
}

fn units16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

pub fn find_in_deck(deck: &Deck, query: &str, opts: FindOpts) -> Vec<Hit> {
    if query.is_empty() {
        return Vec::new();
    }
    let re = pattern(query, opts);
    let mut hits = Vec::new();
    map_texts(&mut deck.clone(), &mut |s, slide, at| {
        let u = units16(s);
        for (n, (a, b)) in matches(s, &re).into_iter().enumerate() {
            // Ausschnitt wie in TS in UTF-16-Einheiten: 24 davor, 40 dahinter
            let (ia, ib) = (units16(&s[..a]).len(), units16(&s[..b]).len());
            let x = ia.saturating_sub(24);
            let y = (ib + 40).min(u.len());
            let mut snip = String::new();
            let mut ws = false;
            for c in String::from_utf16_lossy(&u[x..y]).chars() {
                if is_ws(c) {
                    if !ws {
                        snip.push(' ');
                    }
                    ws = true;
                } else {
                    snip.push(c);
                    ws = false;
                }
            }
            let text = format!("{}{snip}{}", if x > 0 { "…" } else { "" }, if ib + 40 < u.len() { "…" } else { "" });
            hits.push(Hit { slide, at: at.to_string(), n, label: label_of(at).to_string(), text });
        }
    });
    hits
}

fn set_path(v: Option<&Value>, path: &[&str], x: &str) -> Value {
    let Some((k, rest)) = path.split_first() else { return Value::String(x.into()) };
    match v {
        Some(Value::Array(a)) => Value::Array(a.iter().enumerate().map(|(i, y)| if i.to_string() == *k { set_path(Some(y), rest, x) } else { y.clone() }).collect()),
        _ => {
            let mut o = match v {
                Some(Value::Object(o)) => o.clone(),
                _ => Map::new(),
            };
            let next = set_path(o.get(*k), rest, x);
            o.insert(k.to_string(), next);
            Value::Object(o)
        }
    }
}

// Würde das Feld gegen das Layout-Schema verstoßen? Fehler anderer Felder zählen nicht.
fn breaks(schema: &SchemaCheck<'_>, layout: &str, content: &Value, at: &str, t: &str) -> bool {
    let path: Vec<&str> = at.split('.').skip(1).collect();
    let joined = path.join(".");
    schema(layout, &set_path(Some(content), &path, t)).is_some_and(|issues| issues.iter().any(|i| i.path.join(".") == joined))
}

/// only = nur dieser Treffer, sonst alle. skipped = Treffer, die nicht ersetzt wurden, weil das Feld danach ungültig wäre.
pub fn replace_in_deck(deck: &Deck, query: &str, replacement: &str, opts: FindOpts, only: Option<&Only>, schema: &SchemaCheck<'_>) -> (Deck, usize) {
    if query.is_empty() {
        return (deck.clone(), 0);
    }
    let re = pattern(query, opts);
    let mut renamed: HashMap<usize, HashMap<String, String>> = HashMap::new();
    let (mut changed, mut skipped) = (false, 0);
    let mut out = deck.clone();
    map_texts(&mut out, &mut |s, slide, at| {
        if only.is_some_and(|o| o.slide != slide || o.at != at) {
            return;
        }
        let ms = matches(s, &re);
        let pick: &[(usize, usize)] = match only {
            Some(o) => ms.get(o.n..(o.n + 1).min(ms.len())).unwrap_or(&[]),
            None => &ms,
        };
        if pick.is_empty() {
            return;
        }
        let mut t = s.clone();
        for &(a, b) in pick.iter().rev() {
            t.replace_range(a..b, replacement);
        }
        if at.starts_with("content.") {
            let sl = &deck.slides[slide as usize];
            if breaks(schema, &sl.layout, &sl.content, at, &t) {
                skipped += pick.len();
                return;
            }
        }
        changed = true;
        if at.starts_with("content.") {
            renamed.entry(slide as usize).or_default().insert(s.clone(), t.clone());
        }
        *s = t;
    });
    if !changed {
        return (deck.clone(), skipped);
    }
    // highlight folgt einer umbenannten Kategorie bzw. einem Label, wenn es den alten Namen auf der Folie nicht mehr gibt
    fn refs(v: &mut Value, map: &HashMap<String, String>, left: &HashSet<String>) {
        match v {
            Value::Array(a) => a.iter_mut().for_each(|x| refs(x, map, left)),
            Value::Object(o) => {
                for (k, x) in o.iter_mut() {
                    if let (true, Value::String(h)) = (k == "highlight", &x) {
                        if let Some(n) = map.get(h).filter(|n| !left.contains(h.as_str()) && !n.is_empty()) {
                            *x = Value::String(n.clone());
                        }
                    } else {
                        refs(x, map, left);
                    }
                }
            }
            _ => {}
        }
    }
    for (i, s) in out.slides.iter_mut().enumerate() {
        let Some(map) = renamed.get(&i) else { continue };
        let mut left = HashSet::new();
        walk(&mut s.content, &mut |t, _| {
            left.insert(t.clone());
        }, "");
        refs(&mut s.content, map, &left);
    }
    (out, skipped)
}
