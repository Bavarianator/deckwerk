//! Zustand eines offenen Decks ohne UI: Folienoperationen, Inhaltsfelder, Layout/Variante/Theme, Undo/Redo.

use std::path::PathBuf;

use dw_model::{Deck, Slide};
use serde_json::{Value, json};

use crate::form::{self, Kind};

const UNDO_MAX: usize = 100;

pub struct Editor {
    pub deck: Deck,
    pub path: Option<PathBuf>,
    pub index: usize,
    /// ungespeicherte Änderungen
    pub dirty: bool,
    // ponytail: ganze Deck-Stände wie App.tsx; Patch-Historie (§8.5), wenn Decks groß werden
    past: Vec<Deck>,
    future: Vec<Deck>,
    /// gleiche Aktion hintereinander (Tippen in einem Feld) = ein Undo-Schritt
    last_tag: Option<String>,
    seq: u64,
}

/// typ-Beispiel eines Layouts (dw-scene), `None` = Layout nicht portiert
pub fn sample(layout: &str) -> Option<Value> {
    dw_scene::samples::samples(layout).map(|s| s[1].1.clone())
}

pub fn variants(layout: &str) -> &'static [&'static str] {
    dw_scene::all_layouts().find(|l| l.0 == layout).map_or(&[], |l| l.1)
}

impl Editor {
    pub fn new(deck: Deck, path: Option<PathBuf>) -> Editor {
        Editor { deck, path, index: 0, dirty: false, past: vec![], future: vec![], last_tag: None, seq: 0 }
    }

    pub fn slide(&self) -> &Slide {
        &self.deck.slides[self.index]
    }

    pub fn can_undo(&self) -> bool {
        !self.past.is_empty()
    }
    pub fn can_redo(&self) -> bool {
        !self.future.is_empty()
    }

    /// Änderung als Undo-Schritt; `tag` fasst gleiche Aktionen hintereinander zusammen. `f` meldet, ob sich etwas änderte.
    fn change(&mut self, tag: Option<String>, f: impl FnOnce(&mut Deck, &mut usize) -> bool) -> bool {
        let before = self.deck.clone();
        let mut index = self.index;
        if !f(&mut self.deck, &mut index) {
            return false;
        }
        self.index = index.min(self.deck.slides.len().saturating_sub(1));
        if tag.is_none() || tag != self.last_tag {
            self.past.push(before);
            if self.past.len() > UNDO_MAX {
                self.past.remove(0);
            }
        }
        self.last_tag = tag;
        self.future.clear();
        self.dirty = true;
        true
    }

    pub fn undo(&mut self) -> bool {
        let Some(d) = self.past.pop() else { return false };
        self.future.push(std::mem::replace(&mut self.deck, d));
        self.after_history();
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(d) = self.future.pop() else { return false };
        self.past.push(std::mem::replace(&mut self.deck, d));
        self.after_history();
        true
    }

    fn after_history(&mut self) {
        self.index = self.index.min(self.deck.slides.len().saturating_sub(1));
        self.last_tag = None;
        self.dirty = true;
    }

    pub fn select(&mut self, i: usize) {
        if i < self.deck.slides.len() {
            self.index = i;
            self.last_tag = None;
        }
    }

    fn new_id(&mut self) -> String {
        loop {
            self.seq += 1;
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis());
            let id = format!("s{ms:x}{}", self.seq);
            if !self.deck.slides.iter().any(|s| s.id == id) {
                return id;
            }
        }
    }

    /// Neue Folie hinter der aktuellen, im Layout der aktuellen (Beispielinhalt), sonst Aufzählung.
    pub fn add_slide(&mut self) -> bool {
        let layout = Some(self.slide().layout.clone())
            .filter(|l| sample(l).is_some())
            .unwrap_or_else(|| "bullets".into());
        let slide = new_slide(self.new_id(), &layout);
        self.change(None, |d, i| {
            *i += 1;
            d.slides.insert(*i, slide);
            true
        })
    }

    pub fn duplicate(&mut self) -> bool {
        let mut s = self.slide().clone();
        s.id = self.new_id();
        self.change(None, |d, i| {
            *i += 1;
            d.slides.insert(*i, s);
            true
        })
    }

    /// Die letzte Folie bleibt: ein Deck ohne Folien lehnt dw-store ab.
    pub fn delete(&mut self) -> bool {
        self.change(None, |d, i| {
            if d.slides.len() <= 1 {
                return false;
            }
            d.slides.remove(*i);
            *i = (*i).min(d.slides.len() - 1);
            true
        })
    }

    pub fn move_by(&mut self, delta: i32) -> bool {
        self.change(None, |d, i| {
            let j = *i as i64 + i64::from(delta);
            if j < 0 || j as usize >= d.slides.len() {
                return false;
            }
            let s = d.slides.remove(*i);
            d.slides.insert(j as usize, s);
            *i = j as usize;
            true
        })
    }

    /// Layout wechseln: Felder mit gleichem Namen und Typ wandern mit, der Rest kommt aus dem Beispiel.
    pub fn set_layout(&mut self, layout: &str) -> bool {
        let Some(mut content) = sample(layout) else { return false };
        let old = self.slide().content.clone();
        if let (Some(new), Some(old)) = (content.as_object_mut(), old.as_object()) {
            for (k, v) in new.iter_mut() {
                if let Some(o) = old.get(k).filter(|o| std::mem::discriminant(*o) == std::mem::discriminant(v)) {
                    *v = o.clone();
                }
            }
        }
        let keep_variant = |v: &Option<String>| v.as_deref().filter(|v| variants(layout).contains(v)).map(str::to_string);
        let layout = layout.to_string();
        self.change(None, |d, i| {
            let s = &mut d.slides[*i];
            if s.layout == layout {
                return false;
            }
            s.variant = keep_variant(&s.variant);
            s.layout = layout;
            s.content = content;
            true
        })
    }

    /// `None` = Standardvariante
    pub fn set_variant(&mut self, v: Option<&str>) -> bool {
        let v = v.map(str::to_string);
        self.change(None, |d, i| {
            let s = &mut d.slides[*i];
            if s.variant == v {
                return false;
            }
            s.variant = v;
            true
        })
    }

    pub fn set_theme(&mut self, id: &str) -> bool {
        let id = id.to_string();
        self.change(None, |d, _| {
            if d.theme.id == id && d.theme.custom.is_none() {
                return false;
            }
            d.theme.id = id;
            d.theme.custom = None; // eigenes Theme ginge sonst vor
            true
        })
    }

    /// Eingabe in ein Formularfeld (Tippen im selben Feld = ein Undo-Schritt)
    pub fn set_field(&mut self, path: &str, kind: Kind, text: &str) -> bool {
        let tag = format!("{}:{path}", self.slide().id);
        self.change(Some(tag), |d, i| form::set_text(&mut d.slides[*i].content, path, kind, text))
    }

    /// Knöpfe im Formular: add (Feld), list-add, up, down, remove
    pub fn form_action(&mut self, path: &str, action: &str) -> bool {
        let sample = sample(&self.slide().layout);
        self.change(None, |d, i| {
            let c = &mut d.slides[*i].content;
            match action {
                "add" => form::add_field(c, path, sample.as_ref()),
                "list-add" => form::list_add(c, path, sample.as_ref()),
                "up" => form::list_item(c, path, -1),
                "down" => form::list_item(c, path, 1),
                "remove" => form::list_item(c, path, 0),
                _ => false,
            }
        })
    }

    /// Folie aus- bzw. einblenden (fehlt dann beim Präsentieren und in PNG/PDF)
    pub fn toggle_hidden(&mut self) -> bool {
        self.change(None, |d, i| {
            let s = &mut d.slides[*i];
            s.hidden = if s.hidden == Some(true) { None } else { Some(true) };
            true
        })
    }

    /// Sprechernotizen (Tippen = ein Undo-Schritt)
    pub fn set_notes(&mut self, text: &str) -> bool {
        let tag = format!("notes-{}", self.slide().id);
        self.change(Some(tag), |d, i| {
            let ex = &mut d.slides[*i].extra;
            let old = ex.get("notes").and_then(Value::as_str).unwrap_or("");
            if old == text {
                return false;
            }
            if text.is_empty() {
                ex.remove("notes");
            } else {
                ex.insert("notes".into(), Value::String(text.into()));
            }
            true
        })
    }

    pub fn notes(&self) -> &str {
        self.slide().extra.get("notes").and_then(Value::as_str).unwrap_or("")
    }

    /// Ton, Komposition oder Dekor der Folie; `None` = Standard
    pub fn set_prop(&mut self, key: &str, v: Option<&str>) -> bool {
        let v = v.map(str::to_string);
        let key = key.to_string();
        self.change(None, |d, i| {
            let s = &mut d.slides[*i];
            let slot = match key.as_str() {
                "tone" => &mut s.tone,
                "frame" => &mut s.frame,
                _ => {
                    let old = s.extra.get(&key).and_then(Value::as_str).map(str::to_string);
                    if old == v {
                        return false;
                    }
                    match v {
                        Some(x) => s.extra.insert(key, Value::String(x)),
                        None => s.extra.remove(&key),
                    };
                    return true;
                }
            };
            if *slot == v {
                return false;
            }
            *slot = v;
            true
        })
    }

    /// Neuer Stand von außen (KI-Runde) als ein Undo-Schritt
    pub fn replace(&mut self, deck: Deck) -> bool {
        self.change(None, |d, _| {
            if *d == deck || deck.slides.is_empty() {
                return false;
            }
            *d = deck;
            true
        })
    }

    /// Speichern (atomar, mit Version); ohne Pfad entsteht ein Ordner aus dem Titel.
    pub fn save(&mut self, store: &dw_store::Store) -> Result<PathBuf, String> {
        let p = store.save_deck(self.path.as_deref(), &self.deck).map_err(|e| e.to_string())?;
        self.path = Some(p.clone());
        self.dirty = false;
        Ok(p)
    }

    pub fn rows(&self) -> Vec<form::Row> {
        form::rows(&self.slide().content, sample(&self.slide().layout).as_ref())
    }
}

pub fn new_slide(id: String, layout: &str) -> Slide {
    serde_json::from_value(json!({ "id": id, "layout": layout, "content": sample(layout).unwrap_or(json!({})) }))
        .expect("Folie")
}

/// Neues Deck im Format (`dw_model::FORMATS`-ID) mit einer Titelfolie.
pub fn new_deck(title: &str, format: &str) -> Deck {
    let f = dw_model::format(format).unwrap_or(&dw_model::FORMATS[0]);
    let size = (f.id != "16:9").then(|| json!({ "w": f.w, "h": f.h }));
    let mut d = json!({
        "title": title,
        "theme": { "id": "beratung" },
        "slides": [{ "id": "s1", "layout": "cover", "content": { "title": title } }],
    });
    if let Some(s) = size {
        d["size"] = s;
    }
    serde_json::from_value(d).expect("neues Deck")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ed() -> Editor {
        let mut d = new_deck("Test", "16:9");
        d.slides.push(new_slide("s2".into(), "bullets"));
        Editor::new(d, None)
    }

    #[test]
    fn slide_ops_and_undo() {
        let mut e = ed();
        assert_eq!(e.deck.slides.len(), 2);
        e.select(1);
        assert!(e.duplicate());
        assert_eq!(e.index, 2);
        assert_eq!(e.deck.slides[2].layout, "bullets");
        assert_ne!(e.deck.slides[2].id, "s2");
        assert!(e.move_by(-2));
        assert_eq!(e.index, 0);
        assert_eq!(e.deck.slides[1].layout, "cover");
        assert!(!e.move_by(-1));
        assert!(e.delete());
        assert_eq!(e.deck.slides.len(), 2);
        assert!(e.add_slide());
        assert_eq!(e.deck.slides.len(), 3);
        assert_eq!(e.index, 1);
        // fünf Schritte zurück = Ausgangslage
        for _ in 0..4 {
            assert!(e.undo());
        }
        assert!(!e.undo());
        assert_eq!(e.deck.slides.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["s1", "s2"]);
        assert!(e.redo());
        assert_eq!(e.deck.slides.len(), 3);
        assert!(e.dirty);
    }

    #[test]
    fn props_notes_hidden() {
        let mut e = ed();
        assert!(e.set_notes("Hallo"));
        assert!(e.set_notes("Hallo Welt"));
        assert_eq!(e.notes(), "Hallo Welt");
        assert!(e.set_prop("tone", Some("accent")));
        assert!(!e.set_prop("tone", Some("accent")));
        assert!(e.set_prop("decor", Some("dots")));
        assert_eq!(e.slide().extra["decor"], "dots");
        assert!(e.set_prop("decor", None));
        assert!(e.toggle_hidden());
        assert_eq!(e.slide().hidden, Some(true));
        assert!(e.toggle_hidden());
        assert_eq!(e.slide().hidden, None);
        e.undo();
        assert_eq!(e.slide().hidden, Some(true));
    }

    #[test]
    fn last_slide_stays() {
        let mut e = ed();
        assert!(e.delete());
        assert!(!e.delete());
        assert_eq!(e.deck.slides.len(), 1);
    }

    #[test]
    fn typing_is_one_step() {
        let mut e = ed();
        assert!(e.set_field("/title", Kind::Text, "A"));
        assert!(e.set_field("/title", Kind::Text, "AB"));
        assert_eq!(e.slide().content["title"], "AB");
        assert!(e.undo());
        assert_eq!(e.slide().content["title"], "Test");
        assert!(!e.undo());
    }

    #[test]
    fn layout_switch_keeps_fields() {
        let mut e = ed();
        e.select(1);
        assert!(e.set_field("/title", Kind::Text, "Bleibt"));
        assert!(e.set_variant(Some("x")));
        assert!(e.set_layout("two-column"));
        assert_eq!(e.slide().layout, "two-column");
        assert_eq!(e.slide().content["title"], "Bleibt");
        assert_eq!(e.slide().variant, None);
        assert!(!e.set_layout("gibt-es-nicht"));
        assert!(e.set_theme("keynote"));
        assert_eq!(e.deck.theme.id, "keynote");
    }

    #[test]
    fn new_deck_formats() {
        let d = new_deck("Hallo", "4:5");
        assert_eq!(d.size().w, 1080.0);
        assert_eq!(d.slides[0].content["title"], "Hallo");
        dw_store::check_deck(&d).unwrap();
        assert!(new_deck("x", "16:9").size.is_none());
    }
}
