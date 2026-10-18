//! Inhalt einer Folie als Formular (ContentForm.tsx). Rust hat noch kein Layout-Schema; die Felder kommen aus dem
//! Inhalt selbst, fehlende optionale Felder aus dem typ-Beispiel des Layouts. Pfade sind JSON-Pointer.

use serde_json::{Map, Value};

use crate::names::field_name;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Long,
    Number,
    Bool,
    /// Überschrift einer Gruppe (Objekt)
    Group,
    /// Liste mit „+ Eintrag“
    List,
    /// Kopf eines Listeneintrags (Objekt) mit ↑ ↓ ✕
    Item,
    /// fehlendes Feld aus dem Beispiel hinzufügen
    Add,
}

impl Kind {
    pub fn id(self) -> &'static str {
        match self {
            Kind::Text => "text",
            Kind::Long => "long",
            Kind::Number => "number",
            Kind::Bool => "bool",
            Kind::Group => "group",
            Kind::List => "list",
            Kind::Item => "item",
            Kind::Add => "add",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub kind: Kind,
    pub label: String,
    pub value: String,
    pub depth: usize,
    pub path: String,
    /// Eintrag einer Liste: Index und Länge der Liste (für ↑ ↓ ✕)
    pub item: Option<(usize, usize)>,
}

const LONG_KEYS: [&str; 6] = ["text", "body", "quote", "desc", "notes", "sub"];

fn esc(k: &str) -> String {
    k.replace('~', "~0").replace('/', "~1")
}

fn leaf(v: &Value, key: &str) -> Option<(Kind, String)> {
    Some(match v {
        Value::String(s) => {
            let long = s.len() > 80 || s.contains('\n') || LONG_KEYS.contains(&key);
            (if long { Kind::Long } else { Kind::Text }, s.clone())
        }
        Value::Number(n) => (Kind::Number, n.to_string()),
        Value::Bool(b) => (Kind::Bool, b.to_string()),
        _ => return None,
    })
}

/// Formularzeilen zum Inhalt; `sample` = typ-Beispiel des Layouts (für fehlende Felder).
pub fn rows(content: &Value, sample: Option<&Value>) -> Vec<Row> {
    let mut out = vec![];
    if let Value::Object(o) = content {
        object(&mut out, o, sample.and_then(Value::as_object), "", 0);
    }
    out
}

fn object(out: &mut Vec<Row>, o: &Map<String, Value>, sample: Option<&Map<String, Value>>, path: &str, depth: usize) {
    for (k, v) in o {
        let p = format!("{path}/{}", esc(k));
        value(out, v, sample.and_then(|s| s.get(k)), k, field_name(k), &p, depth, None);
    }
    for (k, _) in sample.into_iter().flatten().filter(|(k, _)| !o.contains_key(*k)) {
        out.push(Row {
            kind: Kind::Add,
            label: field_name(k).into(),
            value: String::new(),
            depth,
            path: format!("{path}/{}", esc(k)),
            item: None,
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn value(
    out: &mut Vec<Row>,
    v: &Value,
    sample: Option<&Value>,
    key: &str,
    label: &str,
    path: &str,
    depth: usize,
    item: Option<(usize, usize)>,
) {
    let row = |kind, value: String| Row { kind, label: label.into(), value, depth, path: path.into(), item };
    if let Some((kind, s)) = leaf(v, key) {
        out.push(row(kind, s));
        return;
    }
    match v {
        Value::Object(o) => {
            out.push(row(if item.is_some() { Kind::Item } else { Kind::Group }, String::new()));
            object(out, o, sample.and_then(Value::as_object), path, depth + 1);
        }
        Value::Array(a) => {
            out.push(row(Kind::List, a.len().to_string()));
            for (i, x) in a.iter().enumerate() {
                let s = sample.and_then(|s| s.get(i).or_else(|| s.get(0)));
                value(out, x, s, key, &format!("{}.", i + 1), &format!("{path}/{i}"), depth + 1, Some((i, a.len())));
            }
        }
        _ => {} // null: nichts zu bearbeiten
    }
}

/// Eingabe in eine Feldzeile übernehmen; Zahlen müssen sich lesen lassen. `false` = nichts geändert.
pub fn set_text(content: &mut Value, path: &str, kind: Kind, text: &str) -> bool {
    let new = match kind {
        Kind::Text | Kind::Long => Value::String(text.into()),
        Kind::Number => match text.trim().replace(',', ".").parse::<f64>() {
            // 3 statt 3.0, damit ganze Zahlen ganz bleiben
            Ok(n) if n.fract() == 0.0 && n.abs() < 1e15 => Value::from(n as i64),
            Ok(n) => serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number),
            Err(_) => return false,
        },
        Kind::Bool => Value::Bool(text == "true"),
        _ => return false,
    };
    match content.pointer_mut(path) {
        Some(v) if *v != new && !new.is_null() => {
            *v = new;
            true
        }
        _ => false,
    }
}

fn split(path: &str) -> Option<(&str, &str)> {
    path.rfind('/').map(|i| (&path[..i], &path[i + 1..]))
}

/// Wert unter `path` im Beispiel; bei Listen der Eintrag mit gleichem Index, sonst der erste (sampleAt).
pub fn sample_at<'a>(sample: &'a Value, path: &str) -> Option<&'a Value> {
    let mut v = sample;
    for k in path.split('/').skip(1) {
        let k = k.replace("~1", "/").replace("~0", "~");
        v = match v {
            Value::Array(a) => k.parse::<usize>().ok().and_then(|i| a.get(i)).or_else(|| a.first())?,
            Value::Object(o) => o.get(&k)?,
            _ => return None,
        };
    }
    Some(v)
}

/// Leere Fassung eines Werts: Texte leer, Zahlen 0, Listen behalten ihre Länge.
fn blank(v: &Value) -> Value {
    match v {
        Value::String(_) => Value::String(String::new()),
        Value::Number(_) => Value::from(0),
        Value::Array(a) => Value::Array(a.iter().map(blank).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), blank(v))).collect()),
        x => x.clone(),
    }
}

/// Fehlendes Feld aus dem Beispiel anlegen.
pub fn add_field(content: &mut Value, path: &str, sample: Option<&Value>) -> bool {
    let Some((parent, key)) = split(path) else { return false };
    let Some(fresh) = sample.and_then(|s| sample_at(s, path)).cloned() else { return false };
    let key = key.replace("~1", "/").replace("~0", "~");
    match content.pointer_mut(parent) {
        Some(Value::Object(o)) if !o.contains_key(&key) => {
            o.insert(key, fresh);
            true
        }
        _ => false,
    }
}

/// Eintrag anhängen: Beispiel an dieser Stelle, sonst eine geleerte Kopie des letzten Eintrags.
pub fn list_add(content: &mut Value, path: &str, sample: Option<&Value>) -> bool {
    let Some(Value::Array(a)) = content.pointer_mut(path) else { return false };
    let at = format!("{path}/{}", a.len());
    let fresh = sample.and_then(|s| sample_at(s, &at)).cloned().or_else(|| a.last().map(blank));
    match fresh {
        Some(f) => {
            a.push(f);
            true
        }
        None => false,
    }
}

/// Listeneintrag entfernen oder um `d` verschieben (d = 0: entfernen).
pub fn list_item(content: &mut Value, item_path: &str, d: i32) -> bool {
    let Some((list, i)) = split(item_path) else { return false };
    let Ok(i) = i.parse::<usize>() else { return false };
    let Some(Value::Array(a)) = content.pointer_mut(list) else { return false };
    if i >= a.len() {
        return false;
    }
    if d == 0 {
        a.remove(i);
        return true;
    }
    let j = i as i64 + i64::from(d);
    if j < 0 || j as usize >= a.len() {
        return false;
    }
    a.swap(i, j as usize);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rows_from_content_and_sample() {
        let c = json!({ "title": "Hallo", "points": [{ "title": "A", "text": "x" }, "frei"], "n": 3, "on": true });
        let s = json!({ "title": "", "subtitle": "Beispiel", "points": [] });
        let r = rows(&c, Some(&s));
        let k: Vec<(Kind, &str, usize)> = r.iter().map(|r| (r.kind, r.path.as_str(), r.depth)).collect();
        assert_eq!(
            k,
            vec![
                (Kind::Text, "/title", 0),
                (Kind::List, "/points", 0),
                (Kind::Item, "/points/0", 1),
                (Kind::Text, "/points/0/title", 2),
                (Kind::Long, "/points/0/text", 2),
                (Kind::Text, "/points/1", 1),
                (Kind::Number, "/n", 0),
                (Kind::Bool, "/on", 0),
                (Kind::Add, "/subtitle", 0),
            ]
        );
        assert_eq!(r[0].label, "Titel");
        assert_eq!(r[1].label, "Punkte");
        assert_eq!(r[5].item, Some((1, 2)));
    }

    #[test]
    fn edit_and_lists() {
        let mut c = json!({ "title": "A", "n": 1, "items": ["a", "b"] });
        assert!(set_text(&mut c, "/title", Kind::Text, "B"));
        assert!(!set_text(&mut c, "/title", Kind::Text, "B"));
        assert!(!set_text(&mut c, "/n", Kind::Number, "x"));
        assert!(set_text(&mut c, "/n", Kind::Number, "2,5"));
        assert!(set_text(&mut c, "/n", Kind::Number, "4"));
        assert_eq!(c["n"], json!(4));
        assert!(list_add(&mut c, "/items", None));
        assert_eq!(c["items"], json!(["a", "b", ""]));
        assert!(list_item(&mut c, "/items/0", 1));
        assert_eq!(c["items"], json!(["b", "a", ""]));
        assert!(!list_item(&mut c, "/items/0", -1));
        assert!(list_item(&mut c, "/items/2", 0));
        assert_eq!(c["items"], json!(["b", "a"]));
        let s = json!({ "subtitle": "Sub", "items": ["x", "y", "z"] });
        assert!(add_field(&mut c, "/subtitle", Some(&s)));
        assert_eq!(c["subtitle"], "Sub");
        assert!(list_add(&mut c, "/items", Some(&s)));
        assert_eq!(c["items"][2], "z");
    }
}
