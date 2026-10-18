//! Text direkt auf der Folie bearbeiten (Stage.tsx: Doppelklick, Enter): dw-edit als Editor, Slot-Pfade wie
//! dw-scene („items.0.text“). Ohne Slint: die Oberfläche reicht Tasten herein und zeichnet Cursor und Auswahl.

use dw_edit::{Alignment, Editor, FontContext, Move, RichText, TextStyle};
use dw_model::{Align, Deck, FontRole, TextEl};
use serde_json::Value;

fn step<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    match v {
        Value::Array(a) => a.get(key.parse::<usize>().ok()?),
        _ => v.get(key),
    }
}

/// Text am Slot-Pfad; None, wenn der Pfad fehlt oder kein String ist (z. B. „_footer.page“).
pub fn get_slot<'a>(content: &'a Value, slot: &str) -> Option<&'a str> {
    slot.split('.').try_fold(content, step)?.as_str()
}

/// Slot-Pfad als JSON-Pointer für `Editor::set_field`
pub fn pointer(slot: &str) -> String {
    slot.split('.').map(|k| format!("/{}", k.replace('~', "~0").replace('/', "~1"))).collect()
}

/// Laufende Bearbeitung eines Text-Slots
pub struct Edit {
    pub slot: String,
    pub orig: String,
    pub ed: Editor,
    /// linke obere Ecke des Textfelds in Folienpixeln
    pub origin: (f64, f64),
    pub dragging: bool,
}

/// Editor-Stil aus dem gemessenen Textelement und den Theme-Schriften (wie dw-scene `blocks::family`).
pub fn text_style(deck: &Deck, t: &TextEl) -> TextStyle {
    let theme = dw_theme::resolve_theme(&deck.theme, None);
    let (font, weight) = match t.font {
        FontRole::Head => (&theme.head.font, f32::from(theme.head.weight)),
        FontRole::Body => (&theme.body, 400.),
    };
    let mut family = match &t.font_face {
        Some(f) => format!("'{f}'"),
        None => format!("'{}'", font.css),
    };
    if let Some(fb) = &font.fallback {
        family += &format!(", '{fb}'");
    }
    TextStyle {
        family: family + ", 'IBM Plex Sans'",
        size: t.size_px as f32,
        line_height: (t.line_height_px / t.size_px) as f32,
        tracking_px: t.tracking_px as f32,
        weight,
        width: Some(t.base.bbox.w as f32 + 0.01),
        align: match t.align {
            Align::Left => Alignment::Start,
            Align::Center => Alignment::Center,
            Align::Right => Alignment::End,
        },
        upper: t.upper,
        ..TextStyle::default()
    }
}

impl Edit {
    /// Bearbeitung beginnen; `at` = Klickpunkt in Folienpixeln (sonst alles markiert wie Enter)
    pub fn start(fcx: FontContext, deck: &Deck, index: usize, slot: &str, t: &TextEl, at: Option<(f64, f64)>) -> Option<Edit> {
        let text = get_slot(&deck.slides.get(index)?.content, slot)?.to_string();
        let mut ed = Editor::new(fcx, RichText::parse(&text), text_style(deck, t));
        let origin = (t.base.bbox.x, t.base.bbox.y);
        match at {
            Some((x, y)) => ed.click((x - origin.0) as f32, (y - origin.1) as f32, false),
            None => ed.select_all(),
        }
        Some(Edit { slot: slot.to_string(), orig: text, ed, origin, dragging: false })
    }

    /// Aktueller Text, wie er im Slot gespeichert wird (nur **fett** und Links)
    pub fn text(&self) -> String {
        self.ed.doc().serialize().text
    }

    /// Format, das der Slot nicht speichern kann (kursiv, Farbe, Sonderzeichen)
    pub fn lossy(&self) -> bool {
        let s = self.ed.doc().serialize();
        s.lossy || s.italic || s.color.is_some()
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum KeyOut {
    /// Text geändert: neu setzen
    Changed,
    /// nur Cursor/Auswahl
    Moved,
    Commit,
    Cancel,
    Save,
    Unused,
}

/// Taste im Editor. `text` ist Slints Tastentext (Sondertasten im Unicode-Privatbereich).
pub fn key(e: &mut Edit, text: &str, ctrl: bool, shift: bool, alt: bool) -> KeyOut {
    use slint::platform::Key;
    let k = |k: Key| -> String { slint::SharedString::from(k).into() };
    let before = e.ed.doc().clone();
    let lower = text.to_lowercase();
    let special = text.chars().any(|c| c.is_control() || ('\u{f700}'..='\u{f8ff}').contains(&c));
    if text == k(Key::Escape) {
        if !e.ed.is_composing() {
            return KeyOut::Cancel;
        }
        e.ed.cancel_compose();
    } else if text == k(Key::Return) && !shift {
        return KeyOut::Commit;
    } else if text == k(Key::Return) {
        e.ed.insert("\n");
    } else if text == k(Key::Backspace) {
        if ctrl { e.ed.backspace_word() } else { e.ed.backspace() }
    } else if text == k(Key::Delete) {
        if ctrl { e.ed.delete_word() } else { e.ed.delete() }
    } else if text == k(Key::LeftArrow) {
        e.ed.move_cursor(if ctrl { Move::WordLeft } else { Move::Left }, shift)
    } else if text == k(Key::RightArrow) {
        e.ed.move_cursor(if ctrl { Move::WordRight } else { Move::Right }, shift)
    } else if text == k(Key::UpArrow) {
        e.ed.move_cursor(Move::Up, shift)
    } else if text == k(Key::DownArrow) {
        e.ed.move_cursor(Move::Down, shift)
    } else if text == k(Key::Home) {
        e.ed.move_cursor(if ctrl { Move::Start } else { Move::LineStart }, shift)
    } else if text == k(Key::End) {
        e.ed.move_cursor(if ctrl { Move::End } else { Move::LineEnd }, shift)
    } else if ctrl && lower == "b" {
        e.ed.toggle_bold();
    } else if ctrl && lower == "i" {
        e.ed.toggle_italic();
    } else if ctrl && lower == "a" {
        e.ed.select_all();
    } else if ctrl && (lower == "y" || (lower == "z" && shift)) {
        e.ed.redo();
    } else if ctrl && lower == "z" {
        e.ed.undo();
    } else if ctrl && lower == "s" {
        return KeyOut::Save;
    } else if !ctrl && !alt && !text.is_empty() && !special {
        e.ed.insert(text);
    } else {
        return KeyOut::Unused;
    }
    if *e.ed.doc() != before { KeyOut::Changed } else { KeyOut::Moved }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn slots() {
        let c = json!({ "title": "A", "items": [{ "text": "x" }] });
        assert_eq!(get_slot(&c, "items.0.text"), Some("x"));
        assert_eq!(get_slot(&c, "_footer.page"), None);
        assert_eq!(pointer("items.0.text"), "/items/0/text");
    }

    #[test]
    fn typing_on_stage() {
        let deck = crate::editor::new_deck("Hallo", "16:9");
        let mut r = crate::stage::CpuRenderer::new();
        let m = crate::stage::StageRenderer::render(&mut r, &deck, 0, 0.1, false).measured.unwrap();
        let Some(dw_model::El::Text(t)) = m.els.iter().find(|e| e.base().slot == "title") else { panic!("kein Titel") };
        let fcx = dw_edit::font_context_from_dir(&dw_scene::FontStore::default_dir()).unwrap();
        let mut e = Edit::start(fcx, &deck, 0, "title", t, None).unwrap();
        assert_eq!(key(&mut e, "Neu", false, false, false), KeyOut::Changed);
        assert_eq!(e.text(), "Neu");
        assert_eq!(key(&mut e, "z", true, false, false), KeyOut::Changed);
        assert_eq!(e.text(), "Hallo");
        let enter: String = slint::SharedString::from(slint::platform::Key::Return).into();
        assert_eq!(key(&mut e, &enter, false, false, false), KeyOut::Commit);
    }
}
