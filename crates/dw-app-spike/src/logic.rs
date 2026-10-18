//! Reine Editor-Logik ohne UI: Koordinaten, Treffer, Slot-Pfade, Speichern.

use std::path::{Path, PathBuf};

use dw_model::{El, ElBox};
use serde_json::Value;

/// Folie (sw×sh) eingepasst in die Stage (w×h), mittig: (Faktor, Versatz x, Versatz y).
pub fn fit(w: f64, h: f64, sw: f64, sh: f64) -> (f64, f64, f64) {
    let f = (w / sw).min(h / sh);
    (f, (w - sw * f) / 2.0, (h - sh * f) / 2.0)
}

/// Stage-Punkt → Folienpixel.
pub fn to_slide(x: f64, y: f64, w: f64, h: f64, sw: f64, sh: f64) -> (f64, f64) {
    let (f, ox, oy) = fit(w, h, sw, sh);
    ((x - ox) / f, (y - oy) / f)
}

/// Kleinstes Element unter dem Punkt (das spezifischste); Rotation bleibt im Spike unberücksichtigt.
pub fn hit(els: &[El], x: f64, y: f64) -> Option<usize> {
    let inside = |b: &ElBox| x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
    els.iter()
        .enumerate()
        .filter(|(_, e)| !e.base().slot.is_empty() && inside(&e.base().bbox))
        .min_by(|(_, a), (_, b)| {
            let area = |e: &El| e.base().bbox.w * e.base().bbox.h;
            area(a).total_cmp(&area(b))
        })
        .map(|(i, _)| i)
}

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
    fn coords_roundtrip() {
        // 1280×720 in 800×600: Faktor 0,625, oben/unten je 75 px Rand
        let (f, ox, oy) = fit(800.0, 600.0, 1280.0, 720.0);
        assert_eq!((f, ox, oy), (0.625, 0.0, 75.0));
        assert_eq!(to_slide(400.0, 300.0, 800.0, 600.0, 1280.0, 720.0), (640.0, 360.0));
        assert_eq!(to_slide(0.0, 75.0, 800.0, 600.0, 1280.0, 720.0), (0.0, 0.0));
    }

    fn text_el(slot: &str, x: f64, y: f64, w: f64, h: f64) -> El {
        serde_json::from_value(json!({
            "kind": "text", "slot": slot, "box": {"x": x, "y": y, "w": w, "h": h},
            "font": "body", "role": "body", "sizePx": 20, "lineHeightPx": 24, "trackingPx": 0,
            "align": "left", "upper": false, "runs": [], "lines": 1, "bg": "#fff"
        }))
        .expect("TextEl")
    }

    #[test]
    fn hit_prefers_smallest() {
        let els = vec![
            text_el("title", 0.0, 0.0, 500.0, 300.0),
            text_el("items.0.text", 100.0, 100.0, 50.0, 20.0),
        ];
        assert_eq!(hit(&els, 110.0, 110.0), Some(1));
        assert_eq!(hit(&els, 10.0, 10.0), Some(0));
        assert_eq!(hit(&els, 600.0, 10.0), None);
    }

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
