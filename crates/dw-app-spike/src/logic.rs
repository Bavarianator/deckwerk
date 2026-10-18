//! Slot-Pfade und Speichern (Treffer, Koordinaten und Editor liegen in dw-edit).

use std::path::{Path, PathBuf};

use serde_json::Value;

fn step<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v {
        Value::Array(a) => a.get(key.parse::<usize>().ok()?),
        _ => v.get(key),
    }
}

/// Text am Slot-Pfad („items.0.text“); None, wenn der Pfad fehlt oder kein String ist (z. B. „_footer.page“).
pub fn get_slot<'a>(content: &'a Value, slot: &str) -> Option<&'a str> {
    slot.split('.').try_fold(content, step)?.as_str()
}

/// Ersetzt einen vorhandenen String am Slot-Pfad; legt nichts neu an.
pub fn set_slot(content: &mut Value, slot: &str, text: &str) -> bool {
    let mut v = content;
    for key in slot.split('.') {
        let next = match v {
            Value::Array(a) => key.parse::<usize>().ok().and_then(|i| a.get_mut(i)),
            Value::Object(o) => o.get_mut(key),
            _ => None,
        };
        match next {
            Some(n) => v = n,
            None => return false,
        }
    }
    if !v.is_string() {
        return false;
    }
    *v = Value::String(text.to_string());
    true
}

/// `deck.json` → `deck.edited.json` daneben.
pub fn edited_path(orig: &Path) -> PathBuf {
    let stem = orig.file_stem().and_then(|s| s.to_str()).unwrap_or("deck");
    orig.with_file_name(format!("{stem}.edited.json"))
}

/// Schreibt erst `<ziel>.part`, dann rename: Ein Absturz hinterlässt nie eine halbe Datei.
pub fn save_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut part = path.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    std::fs::write(&part, bytes)?;
    std::fs::rename(&part, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn slot_get_set() {
        let mut c = json!({"title": "A", "items": [{"text": "x"}], "left": {"points": ["p", "q"]}});
        assert_eq!(get_slot(&c, "items.0.text"), Some("x"));
        assert_eq!(get_slot(&c, "left.points.1"), Some("q"));
        assert_eq!(get_slot(&c, "_footer.page"), None);
        assert_eq!(get_slot(&c, "items"), None);
        assert!(set_slot(&mut c, "left.points.1", "Grüße"));
        assert_eq!(c["left"]["points"][1], "Grüße");
        assert!(set_slot(&mut c, "title", "Ä"));
        assert!(!set_slot(&mut c, "items.5.text", "neu"));
        assert!(!set_slot(&mut c, "items", "kein String"));
    }

    #[test]
    fn atomic_save() {
        let dir = std::env::temp_dir().join(format!("dw-app-spike-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = edited_path(&dir.join("spike.json"));
        assert_eq!(p.file_name().unwrap(), "spike.edited.json");
        save_atomic(&p, b"{}").unwrap();
        save_atomic(&p, b"{\"a\":1}").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"{\"a\":1}");
        assert!(!dir.join("spike.edited.json.part").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
