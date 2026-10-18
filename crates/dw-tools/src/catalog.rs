//! Layout-Katalog für die Werkzeuge: Felder, JSON-Schema und Beispielinhalt je Layout aus layouts*.ts
//! (data/catalog.json, erzeugt von tests/gen/gen-tools.ts), dazu die lucide-Namen für search_icons.
//! ponytail: Die Schemas kommen als Daten aus TS, bis dw-model die Layout-Schemas als Rust-Typen hat; zod-Refinements
//! (z. B. Schriftnamen im Inhalt) prüft die Daten-Fassung nicht.

use std::sync::OnceLock;

use dw_lint::{LayoutInfo, SchemaIssue};
use serde::Deserialize;
use serde_json::Value;

use crate::schema::{bare, pretty, stray_keys, validate};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub id: String,
    pub name: String,
    pub when: String,
    #[serde(default)]
    pub variants: Option<Vec<String>>,
    #[serde(default)]
    pub frames: Option<Vec<String>>,
    #[serde(default)]
    pub sizes: Option<Vec<String>>,
    pub default_build: String,
    #[serde(default)]
    pub pro: bool,
    pub schema: Value,
    /// samples.typ
    pub typ: Value,
}

#[derive(Deserialize)]
struct Catalog {
    layouts: Vec<Layout>,
    icons: Vec<String>,
}

fn catalog() -> &'static Catalog {
    static C: OnceLock<Catalog> = OnceLock::new();
    C.get_or_init(|| {
        serde_json::from_str(include_str!("../data/catalog.json")).expect("data/catalog.json")
    })
}

/// Alle Layouts (auch Pro: Pro-Decks bleiben in Deckwerk lesbar), Katalogreihenfolge
pub fn all() -> &'static [Layout] {
    &catalog().layouts
}

pub fn get(id: &str) -> Option<&'static Layout> {
    all().iter().find(|l| l.id == id)
}

/// LAYOUT_IDS: angebotene Layouts der Edition
pub fn ids() -> Vec<&'static str> {
    all()
        .iter()
        .filter(|l| crate::PRO || !l.pro)
        .map(|l| l.id.as_str())
        .collect()
}

pub fn icons() -> &'static [String] {
    &catalog().icons
}

/// Was dw-lint vom Katalog braucht
pub fn lint_infos() -> &'static [LayoutInfo] {
    static L: OnceLock<Vec<LayoutInfo>> = OnceLock::new();
    L.get_or_init(|| {
        all()
            .iter()
            .map(|l| LayoutInfo {
                id: l.id.clone(),
                sizes: l.sizes.clone(),
                frames: l.frames.is_some(),
                default_build: Some(l.default_build.clone()),
            })
            .collect()
    })
}

/// SchemaCheck für dw-lint: None = Layout unbekannt
pub fn schema_check(layout: &str, content: &Value) -> Option<Vec<SchemaIssue>> {
    get(layout).map(|l| validate(&l.schema, content))
}

// Feinsatz rekursiv über alle Strings; Quellen, Links und Symbolnamen bleiben unberührt (code: Quelltext)
const NO_TYPESET: [&str; 11] = [
    "src", "image", "url", "href", "link", "poster", "icon", "qr", "focus", "video", "code",
];

pub fn typeset_deep(v: &Value, key: Option<&str>) -> Value {
    if key.is_some_and(|k| NO_TYPESET.contains(&k)) {
        return v.clone();
    }
    match v {
        Value::String(s) => Value::String(dw_lint::typeset(s)),
        Value::Array(a) => Value::Array(a.iter().map(|x| typeset_deep(x, key)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), typeset_deep(x, Some(k))))
                .collect(),
        ),
        _ => v.clone(),
    }
}

fn abs_to_asset(v: &mut Value) {
    if let Some(s) = v.as_str()
        && std::path::Path::new(s).is_absolute()
    {
        *v = Value::String(crate::asset_url(std::path::Path::new(s)));
    }
}

/// Prüft content gegen das Layout-Schema (tools.ts validateContent). Unbekannte Felder (z. B. „kicker“ statt „eyebrow“)
/// würde zod still verwerfen; der Inhalt fehlte dann ohne Meldung, deshalb sind sie ein Fehler.
pub fn validate_content(layout: &str, content: &Value, at: &str) -> Result<Value, String> {
    let Some(def) = get(layout) else {
        return Err(format!(
            "{at}: Unbekanntes Layout \"{layout}\". Erlaubt: {}",
            ids().join(", ")
        ));
    };
    let issues = validate(&def.schema, content);
    let mut stray: Vec<String> = vec![];
    for k in stray_keys(&def.schema, content, "") {
        if !stray.contains(&k) {
            stray.push(k);
        }
    }
    if issues.is_empty() && stray.is_empty() {
        let mut c = typeset_deep(content, None);
        // der Renderer lädt Videos und Bilder nur über asset://
        if layout == "clip" {
            if let Some(v) = c.get_mut("video") {
                abs_to_asset(v);
            }
            for o in c
                .get_mut("overlays")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if let Some(i) = o.get_mut("image") {
                    abs_to_asset(i);
                }
            }
        }
        if layout == "schnitt" {
            for t in c
                .get_mut("tracks")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                for k in t
                    .get_mut("clips")
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
                {
                    if let Some(s) = k.get_mut("src") {
                        abs_to_asset(s);
                    }
                }
            }
        }
        return Ok(c);
    }
    let mut lines = vec![format!("{at} ({layout}): Inhalt ungültig.")];
    if !stray.is_empty() {
        lines.push(format!("Unbekannte Felder: {}", stray.join("; ")));
    }
    if !issues.is_empty() {
        lines.push(pretty(&issues));
        lines.push("Zu lang: kürzen oder Folie teilen.".into());
    }
    lines.push(format!(
        "Schema von {layout}: {}",
        Value::Object(bare(&def.schema))
    ));
    Err(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn katalog_und_inhalt() {
        assert_eq!(all().len(), 47);
        assert_eq!(ids().len(), if crate::PRO { 47 } else { 43 });
        assert!(icons().iter().any(|n| n == "shield-check"));
        for l in all() {
            assert!(
                validate_content(&l.id, &l.typ, "x").is_ok(),
                "{}: {:?}",
                l.id,
                validate_content(&l.id, &l.typ, "x")
            );
        }
        let e = validate_content("cover", &json!({"title": "Hi", "kicker": "x"}), "slides[0]")
            .unwrap_err();
        assert!(e.starts_with("slides[0] (cover): Inhalt ungültig.\nUnbekannte Felder: kicker (erlaubt: eyebrow, title"), "{e}");
        assert!(
            e.contains("✖ Too small: expected string to have >=3 characters\n  → at title"),
            "{e}"
        );
        let ok = validate_content("cover", &json!({"title": "Das \"neue\" Deck"}), "x").unwrap();
        assert_eq!(ok["title"], "Das „neue“ Deck");
    }
}
