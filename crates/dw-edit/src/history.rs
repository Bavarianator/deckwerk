//! Undo des Decks als Patch-Historie (RUST-REWRITE.md §8.5) statt kompletter Snapshots (App.tsx:36,151-164).
//! Ein Schritt speichert nur die geänderten Pfade mit Wert davor und danach; gleiche `tag`s fassen sich
//! zusammen (Ziehen, Tippen, eine KI-Runde = ein Schritt).

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum Key {
    Field(String),
    Index(usize),
}

/// Wert an `path` vorher/nachher; `None` = fehlt (Feld neu bzw. gelöscht).
#[derive(Debug, Clone, PartialEq)]
pub struct Patch {
    pub path: Vec<Key>,
    pub before: Option<Value>,
    pub after: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
struct Step {
    tag: Option<String>,
    patches: Vec<Patch>,
}

#[derive(Debug, Default)]
pub struct History {
    undo: Vec<Step>,
    redo: Vec<Step>,
}

const MAX_STEPS: usize = 500;

/// Unterschiede `a` → `b`. Objekte feldweise, Arrays gleicher Länge elementweise, sonst ganz ersetzt.
pub fn diff(a: &Value, b: &Value) -> Vec<Patch> {
    let mut out = Vec::new();
    diff_into(a, b, &mut Vec::new(), &mut out);
    out
}

fn diff_into(a: &Value, b: &Value, path: &mut Vec<Key>, out: &mut Vec<Patch>) {
    if a == b {
        return;
    }
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for (k, va) in x {
                path.push(Key::Field(k.clone()));
                match y.get(k) {
                    Some(vb) => diff_into(va, vb, path, out),
                    None => out.push(Patch {
                        path: path.clone(),
                        before: Some(va.clone()),
                        after: None,
                    }),
                }
                path.pop();
            }
            for (k, vb) in y {
                if !x.contains_key(k) {
                    path.push(Key::Field(k.clone()));
                    out.push(Patch {
                        path: path.clone(),
                        before: None,
                        after: Some(vb.clone()),
                    });
                    path.pop();
                }
            }
        }
        (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
            for (i, (va, vb)) in x.iter().zip(y).enumerate() {
                path.push(Key::Index(i));
                diff_into(va, vb, path, out);
                path.pop();
            }
        }
        _ => out.push(Patch {
            path: path.clone(),
            before: Some(a.clone()),
            after: Some(b.clone()),
        }),
    }
}

/// Setzt `v` (bzw. löscht bei `None`) an `path`. false, wenn der Elternpfad fehlt.
fn put(root: &mut Value, path: &[Key], v: Option<&Value>) -> bool {
    let Some((last, parent)) = path.split_last() else {
        if let Some(v) = v {
            *root = v.clone();
        }
        return true;
    };
    let mut cur = root;
    for k in parent {
        cur = match (k, cur) {
            (Key::Field(f), Value::Object(o)) => match o.get_mut(f) {
                Some(n) => n,
                None => return false,
            },
            (Key::Index(i), Value::Array(a)) => match a.get_mut(*i) {
                Some(n) => n,
                None => return false,
            },
            _ => return false,
        };
    }
    match (last, cur, v) {
        (Key::Field(f), Value::Object(o), Some(v)) => {
            o.insert(f.clone(), v.clone());
        }
        (Key::Field(f), Value::Object(o), None) => {
            o.remove(f);
        }
        (Key::Index(i), Value::Array(a), Some(v)) if *i < a.len() => a[*i] = v.clone(),
        _ => return false,
    }
    true
}

impl History {
    /// Übernimmt `after` als neuen Stand von `doc` und merkt sich die Änderung. Gleicher `tag` wie der
    /// letzte Schritt → zusammengefasst. Liefert false, wenn sich nichts geändert hat.
    pub fn commit(&mut self, doc: &mut Value, after: Value, tag: Option<&str>) -> bool {
        let patches = diff(doc, &after);
        if patches.is_empty() {
            return false;
        }
        *doc = after;
        self.redo.clear();
        if let (Some(t), Some(last)) = (tag, self.undo.last_mut())
            && last.tag.as_deref() == Some(t)
        {
            merge(&mut last.patches, patches);
            return true;
        }
        self.undo.push(Step {
            tag: tag.map(str::to_string),
            patches,
        });
        if self.undo.len() > MAX_STEPS {
            self.undo.remove(0);
        }
        true
    }

    /// Nächster Schritt beginnt neu, auch bei gleichem Tag (z. B. Maus losgelassen).
    pub fn seal(&mut self) {
        if let Some(s) = self.undo.last_mut() {
            s.tag = None;
        }
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    /// Letzten Schritt zurücknehmen. `Ok(false)`: nichts zu tun. `Err`: `doc` passt nicht zur Historie
    /// (Pfad fehlt); dann bleiben `doc` und der Schritt unverändert.
    pub fn undo(&mut self, doc: &mut Value) -> Result<bool, PatchError> {
        let Some(s) = self.undo.last() else {
            return Ok(false);
        };
        *doc = apply(doc, s.patches.iter().rev().map(|p| (p, p.before.as_ref())))?;
        let s = self.undo.pop().expect("geprüft");
        self.redo.push(Step { tag: None, ..s });
        self.seal(); // nach Undo fasst kein Tag mehr mit einem älteren Schritt zusammen
        Ok(true)
    }

    pub fn redo(&mut self, doc: &mut Value) -> Result<bool, PatchError> {
        let Some(s) = self.redo.last() else {
            return Ok(false);
        };
        *doc = apply(doc, s.patches.iter().map(|p| (p, p.after.as_ref())))?;
        let s = self.redo.pop().expect("geprüft");
        self.undo.push(Step { tag: None, ..s });
        Ok(true)
    }

    /// Speicher grob: Anzahl gespeicherter Patches (für Tests/Anzeige).
    pub fn patch_count(&self) -> usize {
        self.undo
            .iter()
            .chain(&self.redo)
            .map(|s| s.patches.len())
            .sum()
    }
}

/// Patch passt nicht zum Dokument (z. B. Deck außerhalb der Historie geändert).
#[derive(Debug, Clone, PartialEq)]
pub struct PatchError(pub Vec<Key>);

impl std::fmt::Display for PatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Undo-Pfad fehlt: {:?}", self.0)
    }
}

impl std::error::Error for PatchError {}

/// Alle Patches auf eine Kopie; nur wenn jeder passt, gilt das Ergebnis (kein halbes Undo).
fn apply<'a>(
    doc: &Value,
    patches: impl Iterator<Item = (&'a Patch, Option<&'a Value>)>,
) -> Result<Value, PatchError> {
    let mut out = doc.clone();
    for (p, v) in patches {
        if !put(&mut out, &p.path, v) {
            return Err(PatchError(p.path.clone()));
        }
    }
    Ok(out)
}

/// Neue Patches an einen Schritt hängen; gleicher Pfad → erster `before`, letzter `after`.
fn merge(into: &mut Vec<Patch>, new: Vec<Patch>) {
    let overlaps = |a: &[Key], b: &[Key]| a.starts_with(b) || b.starts_with(a);
    for p in new {
        // Nur zusammenfassen, wenn danach kein überlappender Pfad kam, sonst stimmt die Reihenfolge beim Redo nicht
        match into.iter().rposition(|q| q.path == p.path) {
            Some(i) if !into[i + 1..].iter().any(|q| overlaps(&q.path, &p.path)) => {
                into[i].after = p.after
            }
            _ => into.push(p),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn deck() -> Value {
        json!({"title": "T", "slides": [
            {"layout": "cover", "content": {"title": "Alt"}},
            {"layout": "bullets", "content": {"items": ["a", "b"]}, "items": [{"id": "x", "x": 1, "y": 2}]}
        ]})
    }

    #[test]
    fn diff_is_minimal() {
        let a = deck();
        let mut b = a.clone();
        b["slides"][0]["content"]["title"] = json!("Neu");
        let d = diff(&a, &b);
        assert_eq!(d.len(), 1);
        assert_eq!(
            d[0].path,
            vec![
                Key::Field("slides".into()),
                Key::Index(0),
                Key::Field("content".into()),
                Key::Field("title".into())
            ]
        );
        // Array anderer Länge: ganz ersetzt
        b["slides"][1]["content"]["items"] = json!(["a", "b", "c"]);
        b["slides"][1]["variant"] = json!("cards");
        assert_eq!(diff(&a, &b).len(), 3);
    }

    #[test]
    fn undo_redo_roundtrip() {
        let mut doc = deck();
        let orig = doc.clone();
        let mut h = History::default();
        let mut next = doc.clone();
        next["slides"][1]["items"][0]["x"] = json!(50);
        next["slides"][0]["tone"] = json!("accent");
        assert!(h.commit(&mut doc, next.clone(), None));
        assert!(
            !h.commit(&mut doc, next.clone(), None),
            "keine Änderung, kein Schritt"
        );
        let mut n2 = doc.clone();
        n2["slides"]
            .as_array_mut()
            .unwrap()
            .push(json!({"layout": "closing", "content": {}}));
        h.commit(&mut doc, n2.clone(), None);
        assert!(h.undo(&mut doc).unwrap());
        assert_eq!(doc, next);
        assert!(h.undo(&mut doc).unwrap());
        assert_eq!(doc, orig, "Feld „tone“ wieder entfernt");
        assert!(!h.undo(&mut doc).unwrap());
        assert!(h.redo(&mut doc).unwrap() && h.redo(&mut doc).unwrap());
        assert_eq!(doc, n2);
        assert!(!h.redo(&mut doc).unwrap());
        // neue Änderung verwirft Redo
        h.undo(&mut doc).unwrap();
        let mut n3 = doc.clone();
        n3["title"] = json!("X");
        h.commit(&mut doc, n3, None);
        assert!(!h.can_redo());
    }

    #[test]
    fn tags_coalesce() {
        let mut doc = deck();
        let orig = doc.clone();
        let mut h = History::default();
        for x in [10, 20, 30] {
            let mut n = doc.clone();
            n["slides"][1]["items"][0]["x"] = json!(x);
            h.commit(&mut doc, n, Some("drag-x"));
        }
        assert_eq!(h.patch_count(), 1, "nur ein Patch für drei Züge");
        h.seal();
        let mut n = doc.clone();
        n["slides"][1]["items"][0]["x"] = json!(40);
        h.commit(&mut doc, n, Some("drag-x"));
        h.undo(&mut doc).unwrap();
        assert_eq!(doc["slides"][1]["items"][0]["x"], 30);
        h.undo(&mut doc).unwrap();
        assert_eq!(doc, orig);
    }

    #[test]
    fn undo_seals_tag() {
        // tippen, Strg+Z, weitertippen: der neue Text bildet einen eigenen Schritt
        let mut doc = deck();
        let mut h = History::default();
        let set = |d: &Value, t: &str| {
            let mut n = d.clone();
            n["title"] = json!(t);
            n
        };
        let n = set(&doc, "A");
        h.commit(&mut doc, n, Some("typing"));
        let n = set(&doc, "AB");
        h.commit(&mut doc, n, Some("typing"));
        h.undo(&mut doc).unwrap();
        assert_eq!(doc["title"], "T");
        h.redo(&mut doc).unwrap();
        let n = set(&doc, "ABC");
        h.commit(&mut doc, n, Some("typing"));
        h.undo(&mut doc).unwrap();
        assert_eq!(
            doc["title"], "AB",
            "Redo-Schritt und neuer Text bleiben getrennt"
        );
    }

    #[test]
    fn broken_path_is_reported() {
        let mut doc = deck();
        let mut h = History::default();
        let mut n = doc.clone();
        n["slides"][1]["items"][0]["x"] = json!(9);
        h.commit(&mut doc, n, None);
        // Deck außerhalb der Historie umgebaut: Folie 1 hat keine Items mehr
        doc["slides"][1].as_object_mut().unwrap().remove("items");
        let before = doc.clone();
        assert!(h.undo(&mut doc).is_err());
        assert_eq!(doc, before, "nichts halb angewendet");
        assert!(h.can_undo(), "Schritt bleibt");
    }
}
