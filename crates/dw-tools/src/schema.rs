//! Eingabeschemas per schemars (draft-07 wie das MCP-SDK aus zod) und eine Prüfung, die dieselben Schemas auswertet:
//! Meldungen wie zod (`prettifyError`), damit sich die KI an denselben Texten korrigiert wie heute.

use std::marker::PhantomData;

use dw_lint::SchemaIssue;
use dw_lint::js::{len16, num};
use regex::Regex;
use schemars::generate::SchemaSettings;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value, json};

/// Feld, das `null` sein darf (zod `.nullable()`): `Null(None)` = null. Optional dazu als `Option<Null<T>>` mit [`some`].
#[derive(Debug, Clone, PartialEq)]
pub struct Null<T>(pub Option<T>);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Null<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Option::<T>::deserialize(d).map(Null)
    }
}

const KEEP: &str = "x-dw-null"; // Markierung: dieses null ist gewollt (Null<T>), alle anderen setzt schemars für Option<T>

impl<T: JsonSchema> JsonSchema for Null<T> {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        format!("Null_{}", T::schema_name()).into()
    }
    fn inline_schema() -> bool {
        true
    }
    fn json_schema(g: &mut SchemaGenerator) -> Schema {
        json_schema!({ "anyOf": [g.subschema_for::<T>(), { "type": "null", "x-dw-null": true }] })
    }
}

/// `#[serde(default, deserialize_with = "some")]`: fehlt = None, null = Some(Null(None))
pub fn some<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// Ganzzahl (zod `.int()`): Schema ohne `format`, liest auch 3.0
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, Default)]
pub struct Int(pub i64);

impl<'de> Deserialize<'de> for Int {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let x = f64::deserialize(d)?;
        Ok(Int(x as i64))
    }
}

impl JsonSchema for Int {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "Int".into()
    }
    fn inline_schema() -> bool {
        true
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "integer" })
    }
}

/// Beliebiger Wert (zod `z.unknown()` in Records)
pub type Any = Value;

/// String-Feld mit fester Werteliste aus einem Katalog (Layouts, Themes, Formate …); Schema per [`Enum::schema`].
pub trait Values {
    fn values() -> Vec<Value>;
    fn description() -> Option<String> {
        None
    }
}

/// Wert aus einer Liste, die erst zur Laufzeit feststeht (`Values`); im Code ein String.
#[derive(Debug, Clone, PartialEq)]
pub struct Enum<V>(pub String, PhantomData<V>);

impl<V> Enum<V> {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de, V> Deserialize<'de> for Enum<V> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d).map(|s| Enum(s, PhantomData))
    }
}

impl<V: Values> JsonSchema for Enum<V> {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        std::any::type_name::<V>()
            .rsplit("::")
            .next()
            .unwrap_or("Enum")
            .to_string()
            .into()
    }
    fn inline_schema() -> bool {
        true
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        let vals = V::values();
        let t = if vals.first().is_some_and(Value::is_number) {
            "number"
        } else {
            "string"
        };
        let mut s = json_schema!({ "type": t, "enum": vals });
        if let Some(d) = V::description() {
            s.insert("description".into(), d.into());
        }
        s
    }
}

/// Feste Werteliste als Typ für `Enum<_>`, optional mit Beschreibung des Typs (zod `.describe()` vor `.nullable()`)
#[macro_export]
macro_rules! values {
    ($name:ident, [$($v:expr),+ $(,)?] $(, $d:expr)?) => {
        pub struct $name;
        impl $crate::schema::Values for $name {
            fn values() -> Vec<serde_json::Value> {
                vec![$(serde_json::json!($v)),+]
            }
            $(fn description() -> Option<String> {
                Some($d.to_string())
            })?
        }
    };
}

/// zod `z.literal(false)`
pub struct False;

impl JsonSchema for False {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "False".into()
    }
    fn inline_schema() -> bool {
        true
    }
    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "boolean", "const": false })
    }
}

/// LAYOUT_IDS der Edition
pub struct LayoutIds;
impl Values for LayoutIds {
    fn values() -> Vec<Value> {
        crate::catalog::ids().into_iter().map(Value::from).collect()
    }
}

/// FORMAT_IDS der Edition (panel nur in Pro, dw-model)
pub struct FormatIds;
impl Values for FormatIds {
    fn values() -> Vec<Value> {
        dw_model::FORMATS
            .iter()
            .map(|f| Value::from(f.id))
            .collect()
    }
}

/// Alle Themes (THEME_IDS)
pub struct ThemeIds;
impl Values for ThemeIds {
    fn values() -> Vec<Value> {
        dw_theme::themes()
            .iter()
            .map(|t| Value::from(t.id.as_str()))
            .collect()
    }
}

/// Angebotene Themes (CATALOG_THEMES)
pub struct CatalogThemeIds;
impl Values for CatalogThemeIds {
    fn values() -> Vec<Value> {
        dw_theme::catalog_themes()
            .map(|t| Value::from(t.id.as_str()))
            .collect()
    }
}

/// Schema eines Eingabetyps wie zod → JSON-Schema: draft-07, eingebettet, ohne Titel, ohne `format` außer uri,
/// optionale Felder ohne null (nur `Null<T>` erlaubt null).
pub fn schema_of<T: JsonSchema>() -> Value {
    let mut set = SchemaSettings::draft07();
    set.inline_subschemas = true;
    let mut v = set.into_generator().into_root_schema_for::<T>().to_value();
    if let Some(o) = v.as_object_mut() {
        o.remove("title");
    }
    tidy(&mut v);
    strip_keep(&mut v);
    v
}

fn is_null(v: &Value) -> bool {
    v.get("type") == Some(&json!("null"))
}

fn tidy(v: &mut Value) {
    match v {
        Value::Array(a) => a.iter_mut().for_each(tidy),
        Value::Object(o) => {
            o.values_mut().for_each(tidy);
            if o.get("format")
                .and_then(Value::as_str)
                .is_some_and(|f| f != "uri")
            {
                o.remove("format");
            }
            // Tupel wie zod: keine weiteren Elemente
            if o.get("items").is_some_and(Value::is_array) {
                o.entry("additionalItems").or_insert(json!(false));
            }
            let keep = o.contains_key(KEEP);
            if let Some(Value::Array(t)) = o.get_mut("type")
                && t.contains(&json!("null"))
                && !keep
            {
                t.retain(|x| x != "null");
                if t.len() == 1 {
                    let x = t.remove(0);
                    o.insert("type".into(), x);
                }
                if let Some(Value::Array(e)) = o.get_mut("enum") {
                    e.retain(|x| !x.is_null());
                }
            }
            if let Some(Value::Array(alts)) = o.get_mut("anyOf")
                && alts.iter().any(|a| is_null(a) && a.get(KEEP).is_none())
            {
                alts.retain(|a| !is_null(a) || a.get(KEEP).is_some());
                if alts.len() == 1 {
                    let Some(Value::Object(inner)) = o
                        .remove("anyOf")
                        .and_then(|mut a| a.as_array_mut().map(|a| a.remove(0)))
                    else {
                        unreachable!()
                    };
                    for (k, x) in inner {
                        o.entry(k).or_insert(x);
                    }
                }
            }
        }
        _ => {}
    }
}

fn strip_keep(v: &mut Value) {
    match v {
        Value::Array(a) => a.iter_mut().for_each(strip_keep),
        Value::Object(o) => {
            o.remove(KEEP);
            o.values_mut().for_each(strip_keep);
        }
        _ => {}
    }
}

// ---------- Prüfung ----------

fn type_name(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn type_ok(t: &str, v: &Value) -> bool {
    match t {
        "string" => v.is_string(),
        "number" => v.is_number(),
        "integer" => v.as_f64().is_some_and(|x| x.fract() == 0.0),
        "boolean" => v.is_boolean(),
        "object" => v.is_object(),
        "array" => v.is_array(),
        "null" => v.is_null(),
        _ => true,
    }
}

fn values_text(e: &[Value]) -> String {
    e.iter()
        .map(|x| x.to_string())
        .collect::<Vec<_>>()
        .join("|")
}

struct Ck<'a> {
    out: &'a mut Vec<SchemaIssue>,
}

impl Ck<'_> {
    fn add(&mut self, path: &[String], message: String) {
        self.out.push(SchemaIssue {
            path: path.to_vec(),
            message,
        });
    }

    /// v = None: Pflichtfeld fehlt
    fn check(&mut self, s: &Value, v: Option<&Value>, path: &mut Vec<String>) {
        let Some(s) = s.as_object() else { return };
        if let Some(alts) = s
            .get("anyOf")
            .or_else(|| s.get("oneOf"))
            .and_then(Value::as_array)
        {
            return self.union(alts, v, path);
        }
        let Some(v) = v else {
            if let Some(e) = s.get("enum").and_then(Value::as_array) {
                return self.add(
                    path,
                    format!("Invalid option: expected one of {}", values_text(e)),
                );
            }
            let t = s.get("type").and_then(Value::as_str).unwrap_or("value");
            let t = if t == "integer" { "number" } else { t };
            return self.add(
                path,
                format!("Invalid input: expected {t}, received undefined"),
            );
        };
        if let Some(c) = s.get("const") {
            if !same(c, v) {
                self.add(path, format!("Invalid input: expected {c}"));
            }
            return;
        }
        let types: Vec<&str> = match s.get("type") {
            Some(Value::String(t)) => vec![t],
            Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
            _ => vec![],
        };
        if !types.is_empty() && !types.iter().any(|t| type_ok(t, v)) {
            let int = types.contains(&"integer") && v.is_number();
            let want = if int {
                "int"
            } else if types[0] == "integer" {
                "number"
            } else {
                types[0]
            };
            return self.add(
                path,
                format!(
                    "Invalid input: expected {want}, received {}",
                    type_name(Some(v))
                ),
            );
        }
        if v.is_null() {
            return;
        }
        if let Some(e) = s.get("enum").and_then(Value::as_array) {
            if !e.iter().any(|x| same(x, v)) {
                self.add(
                    path,
                    format!("Invalid option: expected one of {}", values_text(e)),
                );
            }
            return;
        }
        let n = |k: &str| s.get(k).and_then(Value::as_f64);
        match v {
            Value::String(t) => {
                let len = len16(t) as f64;
                if let Some(m) = n("minLength").filter(|m| len < *m) {
                    self.add(
                        path,
                        format!("Too small: expected string to have >={} characters", num(m)),
                    );
                }
                if let Some(m) = n("maxLength").filter(|m| len > *m) {
                    self.add(
                        path,
                        format!("Too big: expected string to have <={} characters", num(m)),
                    );
                }
                if let Some(p) = s.get("pattern").and_then(Value::as_str)
                    && !Regex::new(p).is_ok_and(|r| r.is_match(t))
                {
                    self.add(path, format!("Invalid string: must match pattern /{p}/"));
                }
                if s.get("format").and_then(Value::as_str) == Some("uri") && !url_ok(t) {
                    self.add(path, "Invalid URL".into());
                }
            }
            Value::Number(x) => {
                let x = x.as_f64().unwrap_or(f64::NAN);
                if let Some(m) = n("minimum").filter(|m| x < *m) {
                    self.add(
                        path,
                        format!("Too small: expected number to be >={}", num(m)),
                    );
                }
                if let Some(m) = n("exclusiveMinimum").filter(|m| x <= *m) {
                    self.add(
                        path,
                        format!("Too small: expected number to be >{}", num(m)),
                    );
                }
                if let Some(m) = n("maximum").filter(|m| x > *m) {
                    self.add(path, format!("Too big: expected number to be <={}", num(m)));
                }
            }
            Value::Array(a) => {
                let len = a.len() as f64;
                if let Some(m) = n("minItems").filter(|m| len < *m) {
                    self.add(
                        path,
                        format!("Too small: expected array to have >={} items", num(m)),
                    );
                }
                if let Some(m) = n("maxItems").filter(|m| len > *m) {
                    self.add(
                        path,
                        format!("Too big: expected array to have <={} items", num(m)),
                    );
                }
                match s.get("items") {
                    Some(Value::Array(tuple)) => {
                        for (k, (is, x)) in tuple.iter().zip(a).enumerate() {
                            path.push(k.to_string());
                            self.check(is, Some(x), path);
                            path.pop();
                        }
                    }
                    Some(is) => {
                        for (k, x) in a.iter().enumerate() {
                            path.push(k.to_string());
                            self.check(is, Some(x), path);
                            path.pop();
                        }
                    }
                    None => {}
                }
            }
            Value::Object(o) => {
                let props = s.get("properties").and_then(Value::as_object);
                let req: Vec<&str> = s
                    .get("required")
                    .and_then(Value::as_array)
                    .map(|r| r.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                for (k, ps) in props.into_iter().flatten() {
                    let x = o.get(k);
                    if x.is_none() && !req.contains(&k.as_str()) {
                        continue;
                    }
                    path.push(k.clone());
                    self.check(ps, x, path);
                    path.pop();
                }
                if let Some(ap) = s.get("additionalProperties").filter(|a| a.is_object()) {
                    for (k, x) in o {
                        if props.is_some_and(|p| p.contains_key(k)) {
                            continue;
                        }
                        path.push(k.clone());
                        self.check(ap, Some(x), path);
                        path.pop();
                    }
                }
            }
            _ => {}
        }
    }

    fn union(&mut self, alts: &[Value], v: Option<&Value>, path: &mut Vec<String>) {
        let issues = |alt: &Value, path: &mut Vec<String>| {
            let mut out = vec![];
            Ck { out: &mut out }.check(alt, v, path);
            out
        };
        let mut tried = vec![];
        for a in alts {
            let x = issues(a, path);
            if x.is_empty() {
                return;
            }
            tried.push(x);
        }
        // nullable oder Unterscheidung über ein const-Feld (discriminatedUnion): Fehler der einen passenden Variante
        let real: Vec<usize> = (0..alts.len()).filter(|&k| !is_null(&alts[k])).collect();
        let tag = v.and_then(Value::as_object).and_then(|o| {
            real.iter().copied().find(|&k| {
                alts[k]
                    .get("properties")
                    .and_then(Value::as_object)
                    .is_some_and(|p| {
                        p.iter().any(|(name, ps)| {
                            ps.get("const")
                                .is_some_and(|c| o.get(name).is_some_and(|x| same(c, x)))
                        })
                    })
            })
        });
        match (real.len(), tag, v) {
            (_, _, None) if real.len() == 1 => self.out.append(&mut tried[real[0]]),
            (1, _, Some(_)) => self.out.append(&mut tried[real[0]]),
            (_, Some(k), _) => self.out.append(&mut tried[k]),
            _ => self.add(path, "Invalid input".into()),
        }
    }
}

fn same(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

/// zod `.url()` (new URL): Schema und Rest ohne Leerzeichen
fn url_ok(s: &str) -> bool {
    static R: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9+.\-]*:[^\s]+$").unwrap());
    R.is_match(s)
}

/// Prüft `v` gegen ein Schema; Befunde nach Pfadlänge sortiert wie `z.prettifyError`.
pub fn validate(schema: &Value, v: &Value) -> Vec<SchemaIssue> {
    let mut out = vec![];
    Ck { out: &mut out }.check(schema, Some(v), &mut vec![]);
    out.sort_by_key(|i| i.path.len());
    out
}

/// zod `prettifyError`: „✖ Meldung“ und darunter „→ at pfad“
pub fn pretty(issues: &[SchemaIssue]) -> String {
    issues
        .iter()
        .map(|i| {
            let mut p = String::new();
            for seg in &i.path {
                if seg.parse::<usize>().is_ok() {
                    p += &format!("[{seg}]");
                } else {
                    if !p.is_empty() {
                        p.push('.');
                    }
                    p += seg;
                }
            }
            if p.is_empty() {
                format!("✖ {}", i.message)
            } else {
                format!("✖ {}\n  → at {p}", i.message)
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Ganzzahlige Kommazahlen (3.0) als Ganzzahl, damit serde sie in i64-Felder liest
pub fn ints(v: &mut Value) {
    match v {
        Value::Number(n) if n.is_f64() => {
            let x = n.as_f64().unwrap();
            if x.fract() == 0.0 && x.abs() < 9.0e15 {
                *v = json!(x as i64);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(ints),
        Value::Object(o) => o.values_mut().for_each(ints),
        _ => {}
    }
}

/// Felder, die das Schema nicht kennt, als „pfad.feld (erlaubt: …)“; Array-Indizes zu [] zusammengefasst (tools.ts strayKeys)
pub fn stray_keys(s: &Value, v: &Value, path: &str) -> Vec<String> {
    if let Some(alts) = s.get("anyOf").and_then(Value::as_array) {
        let fit = |o: &Value| -> i64 {
            match (
                o.get("properties").and_then(Value::as_object),
                v.as_object(),
            ) {
                (Some(p), Some(m)) => m.keys().filter(|k| p.contains_key(*k)).count() as i64,
                _ if o.get("items").is_some() && v.is_array() => 0,
                _ => -1,
            }
        };
        let Some(first) = alts.first() else {
            return vec![];
        };
        let best = alts
            .iter()
            .skip(1)
            .fold(first, |a, o| if fit(o) > fit(a) { o } else { a });
        return if fit(best) < 0 {
            vec![]
        } else {
            stray_keys(best, v, path)
        };
    }
    if let (Some(p), Some(m)) = (
        s.get("properties").and_then(Value::as_object),
        v.as_object(),
    ) {
        return m
            .iter()
            .flat_map(|(k, x)| match p.get(k) {
                Some(ps) => stray_keys(ps, x, &format!("{path}{k}.")),
                None => vec![format!(
                    "{path}{k} (erlaubt: {})",
                    p.keys().cloned().collect::<Vec<_>>().join(", ")
                )],
            })
            .collect();
    }
    if let (Some(is), Some(a)) = (s.get("items").filter(|i| i.is_object()), v.as_array()) {
        return a
            .iter()
            .flat_map(|x| stray_keys(is, x, &format!("{path}[].")))
            .collect();
    }
    vec![]
}

/// Schema-Objekt ohne `$schema` (für Fehlermeldungen)
pub fn bare(s: &Value) -> Map<String, Value> {
    let mut o = s.as_object().cloned().unwrap_or_default();
    o.remove("$schema");
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meldungen_wie_zod() {
        let s = json!({"type":"object","properties":{
            "a":{"type":"string","minLength":3,"maxLength":5},"n":{"type":"integer","minimum":1,"maximum":9},
            "e":{"type":"string","enum":["x","y"]},"arr":{"type":"array","items":{"type":"string"},"minItems":1,"maxItems":2},
            "u":{"type":"string","format":"uri"},"o":{"type":"object","properties":{"k":{"type":"boolean"}},"required":["k"]},
            "t":{"type":"array","items":[{"type":"string"},{"type":"number"}],"minItems":2,"maxItems":2},
            "r":{"type":"string","pattern":"^#[0-9a-f]{6}$"},"nn":{"anyOf":[{"type":"string"},{"type":"null"}]}},
            "required":["a","n","e","arr","o","nn"]});
        let v = json!({"a":"abcdefg","n":2.5,"e":"q","arr":[],"u":"kein url","o":{"k":"x"},"t":["a","b"],"r":"#zz","nn":3});
        assert_eq!(
            pretty(&validate(&s, &v)),
            "✖ Too big: expected string to have <=5 characters\n  → at a\n✖ Invalid input: expected int, received number\n  → at n\n✖ Invalid option: expected one of \"x\"|\"y\"\n  → at e\n✖ Too small: expected array to have >=1 items\n  → at arr\n✖ Invalid URL\n  → at u\n✖ Invalid string: must match pattern /^#[0-9a-f]{6}$/\n  → at r\n✖ Invalid input: expected string, received number\n  → at nn\n✖ Invalid input: expected boolean, received string\n  → at o.k\n✖ Invalid input: expected number, received string\n  → at t[1]"
        );
        assert_eq!(
            pretty(&validate(&s, &json!({}))).lines().next(),
            Some("✖ Invalid input: expected string, received undefined")
        );
    }
}
