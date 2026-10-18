//! Gemeinsam bearbeiten: dreiseitiges Zusammenführen von Decks (Basis = letzter gemeinsamer Stand, mine, theirs),
//! Port von `src/shared/merge3.ts`. Bildpfade sind lokal absolut (asset://local/…), im geteilten Ordner relativ
//! (assets/<name>); verglichen wird immer in der portablen Form.
//!
//! Arbeitet auf `serde_json::Value` wie die TS-Fassung auf rohem JSON; `undefined` (Schlüssel fehlt) ist `None`.
// ponytail: Ergebnis wird geklont statt Teilbäume per Referenz zu teilen, Rc/Arc-Decks falls Undo-Speicher drückt

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::Path;

// FNV-1a über die UTF-8-Bytes: kurz, ohne Krypto, auf jedem Gerät gleich
fn fnv1a(s: &str) -> String {
    let h = s.bytes().fold(0x811c9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x01000193));
    format!("{h:08x}")
}

// wie decodeURIComponent: kaputte Kodierung → None
fn decode_uri(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Bildpfad portabel machen: asset://-URL einer Datei in <dir>/assets/<name> → "assets/<name>"; jede andere
/// asset://-Datei → "assets/<fnv1a-hex(absoluter Pfad)>-<basename>"; alles andere unverändert.
/// dir = absoluter lokaler Deck-Ordner ohne Schlussstrich.
pub fn portable_path(v: &str, dir: &str) -> String {
    let Some(rest) = v.strip_prefix("asset://local") else { return v.into() };
    if !rest.starts_with('/') {
        return v.into();
    }
    let abs = decode_uri(rest).unwrap_or_else(|| rest.into()); // kaputte Kodierung: roh weiter
    let mut d = dir.replace('\\', "/"); // Windows: C:\x → /C:/x wie in pathToFileURL
    if !d.starts_with('/') {
        d.insert(0, '/');
    }
    let name = &abs[abs.rfind('/').map_or(0, |i| i + 1)..];
    if abs == format!("{d}/assets/{name}") { format!("assets/{name}") } else { format!("assets/{}-{name}", fnv1a(&abs)) }
}

// Kopie mit f auf jedem String (key = Feldname); __proto__ fällt weg wie in TS
fn map_strings(x: &Value, f: &dyn Fn(&str, &str) -> String, key: &str) -> Value {
    match x {
        Value::String(s) => Value::String(f(s, key)),
        Value::Array(a) => Value::Array(a.iter().map(|v| map_strings(v, f, key)).collect()),
        Value::Object(o) => Value::Object(o.iter().filter(|(k, _)| *k != "__proto__").map(|(k, v)| (k.clone(), map_strings(v, f, k))).collect()),
        _ => x.clone(),
    }
}

/// Deck-Kopie mit portablen Bildpfaden (für den Upload)
pub fn portable_deck(deck: &Value, dir: &str) -> Value {
    map_strings(deck, &|s, _| portable_path(s, dir), "")
}

/// kanonisches JSON (Schlüssel sortiert, Strings über portable_path) – für „hat sich etwas geändert?“; None → ""
// ponytail: 1 und 1.0 gelten als verschieden (in JS gleich), f64-Normalisierung falls das je vorkommt
pub fn canon_json(x: Option<&Value>, dir: &str) -> String {
    match x {
        None => String::new(),
        Some(Value::String(s)) => Value::String(portable_path(s, dir)).to_string(),
        Some(Value::Array(a)) => format!("[{}]", a.iter().map(|v| canon_json(Some(v), dir)).collect::<Vec<_>>().join(",")),
        Some(Value::Object(o)) => {
            let mut k: Vec<_> = o.keys().collect();
            k.sort();
            let parts: Vec<_> = k.iter().map(|k| format!("{}:{}", Value::String((*k).clone()), canon_json(o.get(*k), dir))).collect();
            format!("{{{}}}", parts.join(","))
        }
        Some(v) => v.to_string(),
    }
}

// kanonische Gleichheit wie canon_json(a) == canon_json(b), ohne Strings zu bauen
fn same(a: &Value, b: &Value, dir: &str) -> bool {
    match (a, b) {
        (Value::String(x), Value::String(y)) => x == y || (x.starts_with("asset://") || y.starts_with("asset://")) && portable_path(x, dir) == portable_path(y, dir),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y, dir)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w, dir))),
        _ => canon_json(Some(a), dir) == canon_json(Some(b), dir),
    }
}

enum Ids<'a> {
    Map(Vec<&'a str>, HashMap<&'a str, &'a Value>),
    Dup,
    Plain,
}

// id → Eintrag, wenn alle Einträge Objekte mit eindeutiger String-id sind; Dup = IDs vorhanden, aber nicht so; Plain = keine IDs
fn by_id(a: &[Value]) -> Ids<'_> {
    let (mut keys, mut m) = (vec![], HashMap::new());
    for x in a {
        match x.get("id").and_then(Value::as_str) {
            Some(id) if !m.contains_key(id) => {
                keys.push(id);
                m.insert(id, x);
            }
            _ => return if a.iter().any(|y| y.get("id").is_some_and(Value::is_string)) { Ids::Dup } else { Ids::Plain },
        }
    }
    Ids::Map(keys, m)
}

// gemeinsame Einträge in derselben relativen Reihenfolge wie in der Basis?
fn same_order(base: &[&str], x: &[&str]) -> bool {
    let a = base.iter().filter(|id| x.contains(id));
    let b = x.iter().filter(|id| base.contains(id));
    a.eq(b)
}

struct Ctx<'a> {
    dir: &'a str,
    on_conflict: &'a mut dyn FnMut(&str),
}

impl Ctx<'_> {
    fn eq(&self, a: Option<&Value>, b: Option<&Value>) -> bool {
        match (a, b) {
            (Some(x), Some(y)) if std::ptr::eq(x, y) => true,
            (Some(x), Some(y)) => same(x, y, self.dir),
            (x, y) => x.is_none() && y.is_none(),
        }
    }

    fn go(&mut self, b: Option<&Value>, l: Option<&Value>, t: Option<&Value>, path: &str) -> Option<Value> {
        // l zuerst: sind alle gleich, bleiben die eigenen (lokalen) Bildpfade
        if self.eq(l, t) || self.eq(t, b) {
            return l.cloned();
        }
        if self.eq(l, b) {
            return t.cloned();
        }
        if let (Some(Value::Object(b)), Some(Value::Object(l)), Some(Value::Object(t))) = (b, l, t) {
            let mut out = Map::new();
            for k in l.keys().chain(t.keys().filter(|k| !l.contains_key(*k))) {
                if let Some(v) = self.go(b.get(k), l.get(k), t.get(k), &format!("{path}/{k}")) {
                    out.insert(k.clone(), v);
                }
            }
            return Some(Value::Object(out));
        }
        if let (Some(Value::Array(ba)), Some(Value::Array(la)), Some(Value::Array(ta))) = (b, l, t) {
            match (by_id(ba), by_id(la), by_id(ta)) {
                (Ids::Map(bi, mb), Ids::Map(li, ml), Ids::Map(ti, mt)) => {
                    let mut keep = HashMap::new();
                    for id in li.iter().chain(ti.iter().filter(|id| !ml.contains_key(*id))) {
                        let (bv, lv, tv) = (mb.get(id).copied(), ml.get(id).copied(), mt.get(id).copied());
                        // fehlt eine Seite, entscheidet go: unverändert gegenüber gelöscht → gelöscht, geändert gegenüber gelöscht → Konflikt, l gewinnt
                        let v = if (lv.is_some() && tv.is_some()) || bv.is_some() { self.go(bv, lv, tv, &format!("{path}/{id}")) } else { lv.or(tv).cloned() };
                        if let Some(v) = v {
                            keep.insert(*id, v);
                        }
                    }
                    // nur theirs umsortiert → deren Reihenfolge
                    let (first, other) = if same_order(&bi, &li) && !same_order(&bi, &ti) { (&ti, &li) } else { (&li, &ti) };
                    let mut ids: Vec<&str> = first.iter().copied().filter(|id| keep.contains_key(id)).collect();
                    // Neues der anderen Seite hinter seinen dortigen Vorgänger, ohne Vorgänger an den Anfang
                    let mut prev: Option<&str> = None;
                    for &id in other.iter() {
                        if !keep.contains_key(id) {
                            continue;
                        }
                        if !ids.contains(&id) {
                            let at = prev.and_then(|p| ids.iter().position(|x| *x == p)).map_or(0, |i| i + 1);
                            ids.insert(at, id);
                        }
                        prev = Some(id);
                    }
                    return Some(Value::Array(ids.iter().filter_map(|id| keep.remove(id)).collect()));
                }
                (Ids::Plain, Ids::Plain, Ids::Plain) if ba.len() == la.len() && la.len() == ta.len() => {
                    let v = (0..la.len()).map(|i| self.go(Some(&ba[i]), Some(&la[i]), Some(&ta[i]), &format!("{path}/{i}")).unwrap_or(Value::Null));
                    return Some(Value::Array(v.collect()));
                }
                _ => {}
            }
        }
        (self.on_conflict)(path);
        l.cloned()
    }
}

/// generischer 3-Wege-Merge (Gleichheit kanonisch über dir); on_conflict je Stelle, an der beide Seiten verschieden geändert haben, mine gewinnt
pub fn merge3(b: &Value, l: &Value, t: &Value, dir: &str, on_conflict: &mut dyn FnMut(&str)) -> Value {
    Ctx { dir, on_conflict }.go(Some(b), Some(l), Some(t), "").unwrap_or(Value::Null)
}

/// Decks zusammenführen; liefert das Deck und die Zahl der Konflikte
pub fn merge_deck(base: &Value, mine: &Value, theirs: &Value, dir: &str) -> (Value, usize) {
    let mut n = 0;
    let deck = merge3(base, mine, theirs, dir, &mut |_| n += 1);
    (deck, n)
}

/// Undo/Redo-Snapshots auf einen fremden Stand umsetzen: jeder Snapshot s → merge_deck(base, s, theirs, dir).0
pub fn rebase(stack: &[Value], base: &Value, theirs: &Value, dir: &str) -> Vec<Value> {
    stack.iter().map(|s| merge_deck(base, s, theirs, dir).0).collect()
}

// Felder mit Dateipfaden: Folien (src, image, poster), Videos (clip.video, Einblendung video), Brand-Kit (logo, logoDark),
// eigene Schrift (regular, bold), Excel-Link (file; nie ein Asset, fällt also immer weg)
const FILE_KEYS: [&str; 9] = ["src", "image", "poster", "video", "logo", "logoDark", "regular", "bold", "file"];

/// relativer Asset-Name aus einem fremden Stand: genau assets/<name>, ohne / \ und .., Endung aus MEDIA_EXT
pub fn is_asset_rel(s: &str) -> bool {
    s.strip_prefix("assets/").is_some_and(|n| !n.is_empty() && !n.contains(['/', '\\'])) && !s.contains("..") && dw_store::media_kind(Path::new(s)).is_some()
}

/// fremde deck.json (Pfade RELATIV wie im Upload) prüfen und bereinigen: Form wie readDeck, Folien-IDs Strings; jeder String,
/// der mit asset: oder file: beginnt, wird geleert; Bildfelder nur "assets/<name>" (is_asset_rel) oder data:-URL, sonst geleert.
pub fn sanitize(raw: &Value) -> Result<Value, String> {
    let theme_ok = |t: &Value| t.is_object() || t.as_str().is_some_and(|s| !s.is_empty());
    let Some(slides) = raw.get("slides").and_then(Value::as_array).filter(|_| raw.is_object() && raw.get("theme").is_some_and(theme_ok)) else {
        return Err("Das ist keine gültige deck.json.".into());
    };
    if !slides.iter().all(|s| s.get("id").is_some_and(Value::is_string)) {
        return Err("Eine Folie in der deck.json hat keine gültige ID.".into());
    }
    let pre = |u: &str, p: &str| u.get(..p.len()).is_some_and(|x| x.eq_ignore_ascii_case(p));
    Ok(map_strings(
        raw,
        &|s, key| {
            // so, wie ein URL-Parser den Anfang liest: Tab/Zeilenumbruch fallen überall weg, Steuerzeichen und Leerzeichen vorn
            let u: String = s.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
            let u = u.trim_start_matches(|c| c <= '\x20');
            // fremde lokale Dateien nie anfassen; „File: Bericht“ als Text bleibt
            for p in ["asset:", "file:"] {
                if pre(u, p) && u[p.len()..].chars().next().is_some_and(|c| !c.is_whitespace()) {
                    return String::new();
                }
            }
            if !FILE_KEYS.contains(&key) || u.is_empty() || pre(u, "data:") || is_asset_rel(s) { s.into() } else { String::new() }
        },
        "",
    ))
}

#[cfg(test)]
mod tests;
