//! Rich-Text-Editor auf parley: Cursor, Auswahl, Bewegung, Einfügen/Löschen, Format, Undo, IME-Preedit,
//! Hit-Test und Rechtecke für das Overlay. Koordinaten sind px relativ zur linken oberen Ecke der Textbox.

use std::ops::Range;
use std::sync::Arc;

use kurbo::Rect;
use parley::{
    Affinity, Alignment, AlignmentOptions, BoundingBox, Cursor, FontContext, FontFamily, FontStyle,
    FontWeight, Layout, LayoutContext, LineHeight, Selection, StyleProperty, WhiteSpaceCollapse,
};

use crate::rich::{Attrs, RichText, valid_url};

/// Grundstil des Textelements (aus `TextEl` bzw. Theme).
#[derive(Debug, Clone)]
pub struct TextStyle {
    /// CSS-Schriftliste wie in dw-scene („'Inter', sans-serif“)
    pub family: String,
    pub size: f32,
    /// Zeilenhöhe als Faktor der Schriftgröße
    pub line_height: f32,
    pub tracking_px: f32,
    pub weight: f32,
    pub color: u32,
    pub link_color: u32,
    /// Umbruchbreite; None = eine Zeile je Absatz
    pub width: Option<f32>,
    pub align: Alignment,
    /// text-transform: uppercase wie auf der Folie (ß → SS ändert die Länge, siehe `Editor::disp`)
    pub upper: bool,
}

impl Default for TextStyle {
    fn default() -> Self {
        TextStyle {
            family: "sans-serif".into(),
            size: 20.,
            line_height: 1.2,
            tracking_px: 0.,
            weight: 400.,
            color: 0x000000ff,
            link_color: 0x2f6fd6ff,
            width: None,
            align: Alignment::Start,
            upper: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Move {
    Left,
    Right,
    WordLeft,
    WordRight,
    Up,
    Down,
    LineStart,
    LineEnd,
    Start,
    End,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Insert,
    Delete,
    Other,
}

#[derive(Debug, Clone)]
struct Snap {
    doc: RichText,
    sel: (usize, usize),
}

const UNDO_MAX: usize = 200;

pub struct Editor {
    doc: RichText,
    style: TextStyle,
    fcx: FontContext,
    lcx: LayoutContext<u32>,
    layout: Layout<u32>,
    /// Angezeigter Text (nach `upper`) und Zeichengrenzen (Roh-Byte, Anzeige-Byte) inkl. Ende.
    /// Auswahl und parley-Layout rechnen in Anzeige-Bytes, Dokument und API in Roh-Bytes.
    shown: String,
    bounds: Vec<(usize, usize)>,
    /// Auswahl in Anzeige-Bytes
    sel: Selection,
    /// Format für die nächste Eingabe (Strg+B bei leerer Auswahl)
    typing: Attrs,
    compose: Option<Range<usize>>,
    /// Text vor Beginn der Komposition (für Abbrechen)
    compose_snap: Option<Snap>,
    undo: Vec<Snap>,
    redo: Vec<Snap>,
    last: Kind,
}

impl Editor {
    /// `fcx` mit den Schriften der Folie (z. B. ein Klon aus dem Font-Speicher der App).
    pub fn new(fcx: FontContext, doc: RichText, style: TextStyle) -> Self {
        let mut e = Editor {
            doc,
            style,
            fcx,
            lcx: LayoutContext::new(),
            layout: Layout::new(),
            shown: String::new(),
            bounds: vec![(0, 0)],
            sel: Selection::default(),
            typing: Attrs::default(),
            compose: None,
            compose_snap: None,
            undo: Vec::new(),
            redo: Vec::new(),
            last: Kind::Other,
        };
        e.relayout();
        let end = e.doc.len();
        e.set_sel(end, end);
        e
    }

    pub fn doc(&self) -> &RichText {
        &self.doc
    }

    pub fn text(&self) -> &str {
        self.doc.as_str()
    }

    pub fn layout(&self) -> &Layout<u32> {
        &self.layout
    }

    pub fn style(&self) -> &TextStyle {
        &self.style
    }

    /// Neue Breite/Größe nach Autofit; Text und Auswahl bleiben.
    pub fn set_style(&mut self, style: TextStyle) {
        self.style = style;
        let (a, f) = self.sel_bytes();
        self.relayout();
        self.set_sel(a, f);
    }

    /// (Anker, Fokus) in Bytes.
    pub fn sel_bytes(&self) -> (usize, usize) {
        (
            self.r(self.sel.anchor().index()),
            self.r(self.sel.focus().index()),
        )
    }

    pub fn selection(&self) -> Range<usize> {
        self.range_raw(self.sel.text_range())
    }

    /// Angezeigter Text, wie ihn das Layout setzt.
    pub fn shown(&self) -> &str {
        &self.shown
    }

    /// Roh-Byte → Anzeige-Byte
    fn d(&self, raw: usize) -> usize {
        match self.bounds.binary_search_by_key(&raw, |b| b.0) {
            Ok(i) => self.bounds[i].1,
            Err(i) => self.bounds[i.saturating_sub(1)].1,
        }
    }

    /// Anzeige-Byte → Roh-Byte; mitten in einer Erweiterung (ß → SS) der Anfang des Zeichens.
    fn r(&self, disp: usize) -> usize {
        match self.bounds.binary_search_by_key(&disp, |b| b.1) {
            Ok(i) => self.bounds[i].0,
            Err(i) => self.bounds[i.saturating_sub(1)].0,
        }
    }

    fn on_bound(&self, disp: usize) -> bool {
        self.bounds.binary_search_by_key(&disp, |b| b.1).is_ok()
    }

    fn range_raw(&self, r: Range<usize>) -> Range<usize> {
        self.r(r.start)..self.r(r.end)
    }

    pub fn selected_text(&self) -> &str {
        &self.doc.as_str()[self.selection()]
    }

    pub fn is_composing(&self) -> bool {
        self.compose.is_some()
    }

    pub fn compose_range(&self) -> Option<Range<usize>> {
        self.compose.clone()
    }

    pub fn typing_attrs(&self) -> &Attrs {
        &self.typing
    }

    // ---------- Layout ----------

    fn relayout(&mut self) {
        let raw = self.doc.as_str();
        self.shown.clear();
        self.bounds.clear();
        for (i, c) in raw.char_indices() {
            self.bounds.push((i, self.shown.len()));
            if self.style.upper {
                self.shown.extend(c.to_uppercase());
            } else {
                self.shown.push(c);
            }
        }
        self.bounds.push((raw.len(), self.shown.len()));
        let d = |r: Range<usize>| self.d(r.start)..self.d(r.end);
        let runs: Vec<(Range<usize>, Attrs)> = self
            .doc
            .runs()
            .into_iter()
            .map(|(r, a)| (d(r), a.clone()))
            .collect();
        let compose = self.compose.clone().map(d);
        let s = &self.style;
        let text = self.shown.as_str();
        let mut b = self.lcx.ranged_builder(&mut self.fcx, text, 1.0, false);
        b.push_default(StyleProperty::FontFamily(FontFamily::Source(
            s.family.clone().into(),
        )));
        b.push_default(StyleProperty::FontSize(s.size));
        b.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(
            s.line_height,
        )));
        b.push_default(StyleProperty::LetterSpacing(s.tracking_px));
        b.push_default(StyleProperty::FontWeight(FontWeight::new(s.weight)));
        b.push_default(StyleProperty::Brush(s.color));
        b.push_default(StyleProperty::WhiteSpaceCollapse(
            WhiteSpaceCollapse::PreserveBreaks,
        ));
        for (r, a) in &runs {
            if a.bold {
                b.push(StyleProperty::FontWeight(FontWeight::new(700.)), r.clone());
            }
            if a.italic {
                b.push(StyleProperty::FontStyle(FontStyle::Italic), r.clone());
            }
            if let Some(c) = a.color {
                b.push(StyleProperty::Brush(c), r.clone());
            }
            if a.link.is_some() {
                b.push(StyleProperty::Brush(s.link_color), r.clone());
                b.push(StyleProperty::Underline(true), r.clone());
            }
        }
        if let Some(c) = compose {
            b.push(StyleProperty::Underline(true), c);
        }
        b.build_into(&mut self.layout, text);
        self.layout.break_all_lines(s.width);
        self.layout.align(s.align, AlignmentOptions::default());
    }

    /// Cursor an Roh-Byte `i`
    fn cursor(&self, i: usize) -> Cursor {
        Cursor::from_byte_index(
            &self.layout,
            self.d(i.min(self.doc.len())),
            Affinity::Downstream,
        )
    }

    fn set_sel(&mut self, anchor: usize, focus: usize) {
        self.sel = Selection::new(self.cursor(anchor), self.cursor(focus));
    }

    /// Eingabeformat = Format links vom Cursor; Link nur innerhalb eines Links (am Rand nicht weiterziehen).
    fn pick_typing(&mut self) {
        let i = self.selection().start;
        let before = i.checked_sub(1).and_then(|j| self.doc.attrs_at(j)).cloned();
        let after = self.doc.attrs_at(i).cloned();
        let mut a = before
            .clone()
            .or(after.clone())
            .unwrap_or_else(|| self.doc.base().clone());
        if before.and_then(|b| b.link) != after.and_then(|b| b.link) {
            a.link = None;
        }
        self.typing = a;
    }

    // ---------- Undo ----------

    fn snap(&self) -> Snap {
        Snap {
            doc: self.doc.clone(),
            sel: self.sel_bytes(),
        }
    }

    /// Vor einer Änderung: neuer Undo-Schritt, außer beim Weitertippen bzw. -löschen (bis Leerraum).
    fn checkpoint(&mut self, kind: Kind, coalesce: bool) {
        if !(coalesce && kind == self.last && kind != Kind::Other) {
            self.undo.push(self.snap());
            if self.undo.len() > UNDO_MAX {
                self.undo.remove(0);
            }
        }
        self.redo.clear();
        self.last = kind;
    }

    fn restore(&mut self, s: Snap) {
        self.doc = s.doc;
        self.compose = None;
        self.compose_snap = None;
        self.relayout();
        self.set_sel(s.sel.0, s.sel.1);
        self.pick_typing();
        self.last = Kind::Other;
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn undo(&mut self) -> bool {
        self.cancel_compose();
        let Some(s) = self.undo.pop() else {
            return false;
        };
        self.redo.push(self.snap());
        self.restore(s);
        true
    }

    pub fn redo(&mut self) -> bool {
        self.cancel_compose();
        let Some(s) = self.redo.pop() else {
            return false;
        };
        self.undo.push(self.snap());
        self.restore(s);
        true
    }

    // ---------- Bearbeiten ----------

    fn replace_sel(&mut self, s: &str) {
        let r = self.selection();
        let a = self.typing.clone();
        self.doc.replace(r.clone(), s, &a);
        self.relayout();
        let end = r.start + s.len();
        self.set_sel(end, end);
    }

    /// Text an der Auswahl einfügen (ersetzt sie).
    pub fn insert(&mut self, s: &str) {
        if self.compose.is_some() {
            return self.commit_compose(s);
        }
        let ws = s.chars().any(char::is_whitespace);
        self.checkpoint(Kind::Insert, self.sel.is_collapsed());
        self.replace_sel(s);
        if ws {
            self.last = Kind::Other; // Leerraum schließt das Wort ab, danach beginnt ein neuer Undo-Schritt
        }
    }

    fn delete_range(&mut self, r: Range<usize>) {
        if r.is_empty() {
            return;
        }
        self.checkpoint(Kind::Delete, r.len() <= 4 && self.sel.is_collapsed());
        self.doc.replace(r.clone(), "", &Attrs::default());
        self.relayout();
        self.set_sel(r.start, r.start);
        self.pick_typing();
    }

    /// Rücktaste (ein Zeichen bzw. die Auswahl).
    pub fn backspace(&mut self) {
        let r = self.selection();
        if !r.is_empty() {
            return self.delete_range(r);
        }
        let t = self.doc.as_str();
        // ponytail: löscht ein Unicode-Zeichen, nicht einen Graphem-Cluster (Emoji-Sequenzen brauchen mehrere Tasten)
        if let Some((i, _)) = t[..r.start].char_indices().next_back() {
            self.delete_range(i..r.start);
        }
    }

    /// Entf.
    pub fn delete(&mut self) {
        let r = self.selection();
        if !r.is_empty() {
            return self.delete_range(r);
        }
        if let Some(c) = self.doc.as_str()[r.start..].chars().next() {
            self.delete_range(r.start..r.start + c.len_utf8());
        }
    }

    /// Strg+Rücktaste
    pub fn backspace_word(&mut self) {
        let r = if self.sel.is_collapsed() {
            let s = self.sel.previous_visual_word(&self.layout, true);
            self.range_raw(s.text_range())
        } else {
            self.selection()
        };
        self.delete_range(r);
    }

    /// Strg+Entf
    pub fn delete_word(&mut self) {
        let r = if self.sel.is_collapsed() {
            self.range_raw(self.sel.next_visual_word(&self.layout, true).text_range())
        } else {
            self.selection()
        };
        self.delete_range(r);
    }

    // ---------- Format ----------

    fn toggle(&mut self, get: fn(&Attrs) -> bool, set: fn(&mut Attrs, bool)) {
        let r = self.selection();
        if r.is_empty() {
            let on = !get(&self.typing);
            set(&mut self.typing, on);
            return;
        }
        self.checkpoint(Kind::Other, false);
        let on = !self.doc.all(r.clone(), get);
        self.doc.format(r, |a| set(a, on));
        self.relayout();
        let (a, f) = self.sel_bytes();
        self.set_sel(a, f);
    }

    /// Strg+B
    pub fn toggle_bold(&mut self) {
        self.toggle(|a| a.bold, |a, v| a.bold = v);
    }

    /// Strg+I
    pub fn toggle_italic(&mut self) {
        self.toggle(|a| a.italic, |a, v| a.italic = v);
    }

    /// Link auf die Auswahl setzen (`None` entfernt ihn). Ungültige Ziele werden abgelehnt.
    pub fn set_link(&mut self, url: Option<&str>) -> bool {
        let r = self.selection();
        if r.is_empty() || url.is_some_and(|u| !valid_url(u)) {
            return false;
        }
        self.checkpoint(Kind::Other, false);
        let link: Option<Arc<str>> = url.map(Into::into);
        self.doc.format(r, |a| a.link = link.clone());
        self.relayout();
        true
    }

    /// Farbe (RGBA) auf die Auswahl bzw. die nächste Eingabe; `None` = Elementfarbe.
    pub fn set_color(&mut self, color: Option<u32>) {
        let r = self.selection();
        if r.is_empty() {
            self.typing.color = color;
            return;
        }
        self.checkpoint(Kind::Other, false);
        self.doc.format(r, |a| a.color = color);
        self.relayout();
    }

    // ---------- Cursor und Auswahl ----------

    pub fn move_cursor(&mut self, m: Move, extend: bool) {
        let s = &self.sel;
        // Ohne Shift kollabiert eine Auswahl bei ←/→ an ihrem Rand, wie in Browsern
        if !extend && !s.is_collapsed() && matches!(m, Move::Left | Move::Right) {
            let r = self.selection();
            let i = if m == Move::Left { r.start } else { r.end };
            self.set_sel(i, i);
        } else {
            self.sel = self.moved(m, extend);
            // Nicht mitten in einer Erweiterung (ß → SS) stehen bleiben: weiter in dieselbe Richtung
            for _ in 0..4 {
                if self.on_bound(self.sel.focus().index()) {
                    break;
                }
                self.sel = self.moved(m, extend);
            }
        }
        self.last = Kind::Other;
        self.pick_typing();
    }

    fn moved(&self, m: Move, extend: bool) -> Selection {
        let l = &self.layout;
        let s = &self.sel;
        {
            match m {
                Move::Left => s.previous_visual(l, extend),
                Move::Right => s.next_visual(l, extend),
                Move::WordLeft => s.previous_visual_word(l, extend),
                Move::WordRight => s.next_visual_word(l, extend),
                Move::Up => s.previous_line(l, extend),
                Move::Down => s.next_line(l, extend),
                Move::LineStart => s.line_start(l, extend),
                Move::LineEnd => s.line_end(l, extend),
                Move::Start => {
                    let c = Cursor::from_byte_index(l, 0, Affinity::Downstream);
                    if extend { s.extend(c) } else { c.into() }
                }
                Move::End => {
                    let c = Cursor::from_byte_index(l, self.shown.len(), Affinity::Upstream);
                    if extend { s.extend(c) } else { c.into() }
                }
            }
        }
    }

    pub fn select_all(&mut self) {
        self.set_sel(0, self.doc.len());
        self.pick_typing();
    }

    pub fn select_range(&mut self, r: Range<usize>) {
        let t = self.doc.as_str();
        if r.end <= t.len() && t.is_char_boundary(r.start) && t.is_char_boundary(r.end) {
            self.set_sel(r.start, r.end);
            self.last = Kind::Other;
            self.pick_typing();
        }
    }

    /// Auswahl nach einem Treffer auf Zeichengrenzen ziehen
    fn snap_sel(&mut self) {
        let (a, f) = self.sel_bytes();
        if !self.on_bound(self.sel.anchor().index()) || !self.on_bound(self.sel.focus().index()) {
            self.set_sel(a, f);
        }
    }

    /// Hit-Test: Punkt (Box-Koordinaten) → Byte-Index des Cursors.
    pub fn hit(&self, x: f32, y: f32) -> usize {
        self.r(Cursor::from_point(&self.layout, x, y).index())
    }

    /// Klick; mit `extend` (Shift) wird die Auswahl bis zum Punkt erweitert.
    pub fn click(&mut self, x: f32, y: f32, extend: bool) {
        self.sel = if extend {
            self.sel.extend_to_point(&self.layout, x, y)
        } else {
            Selection::from_point(&self.layout, x, y)
        };
        self.snap_sel();
        self.last = Kind::Other;
        self.pick_typing();
    }

    /// Ziehen mit gedrückter Maus.
    pub fn drag_to(&mut self, x: f32, y: f32) {
        self.sel = self.sel.extend_to_point(&self.layout, x, y);
        self.snap_sel();
        self.last = Kind::Other;
        self.pick_typing();
    }

    pub fn double_click(&mut self, x: f32, y: f32) {
        self.sel = Selection::word_from_point(&self.layout, x, y);
        self.snap_sel();
        self.last = Kind::Other;
        self.pick_typing();
    }

    // ---------- IME ----------

    /// Preedit setzen (winit `Ime::Preedit`); `cursor` = Byte-Bereich im Preedit-Text.
    /// Leerer Text beendet die Komposition ohne Ergebnis (wie winit vor `Commit`).
    pub fn set_compose(&mut self, text: &str, cursor: Option<(usize, usize)>) {
        if text.is_empty() {
            // Stand von vorher inkl. ersetzter Auswahl; ein folgendes Commit ersetzt sie dann
            return self.cancel_compose();
        }
        let start = match self.compose.clone() {
            Some(r) => {
                let a = self.typing.clone();
                self.doc.replace(r.clone(), text, &a);
                r.start
            }
            None => {
                self.compose_snap = Some(self.snap());
                let r = self.selection();
                let a = self.typing.clone();
                self.doc.replace(r.clone(), text, &a);
                r.start
            }
        };
        self.compose = Some(start..start + text.len());
        self.relayout();
        // IME-Bytes können falsch liegen: auf Zeichengrenzen im Preedit klemmen
        let clamp = |i: usize| {
            let mut i = i.min(text.len());
            while !text.is_char_boundary(i) {
                i -= 1;
            }
            i
        };
        let (a, f) = cursor.map_or((text.len(), text.len()), |c| (clamp(c.0), clamp(c.1)));
        self.set_sel(start + a, start + f);
    }

    /// Ergebnis der Komposition übernehmen (winit `Ime::Commit`); ein Undo-Schritt.
    pub fn commit_compose(&mut self, text: &str) {
        // Preedit zurücknehmen (Undo springt zum Stand vor der Komposition), dann als eigener Schritt einfügen
        self.cancel_compose();
        self.last = Kind::Other;
        self.insert(text);
        self.last = Kind::Other;
    }

    /// Komposition abbrechen (Esc während Preedit): Stand von vorher, auch die Auswahl.
    pub fn cancel_compose(&mut self) {
        let snap = self.compose_snap.take();
        if self.compose.is_some()
            && let Some(s) = snap
        {
            let last = self.last;
            let typing = self.typing.clone();
            self.restore(s);
            self.last = last;
            self.typing = typing;
        }
    }

    // ---------- Geometrie fürs Overlay ----------

    fn rect(b: BoundingBox) -> Rect {
        Rect::new(b.x0, b.y0, b.x1, b.y1)
    }

    /// Cursor-Rechteck (Breite `w`); None bei Auswahl.
    pub fn cursor_rect(&self, w: f32) -> Option<Rect> {
        self.sel
            .is_collapsed()
            .then(|| Self::rect(self.sel.focus().geometry(&self.layout, w)))
    }

    /// Rechteck des Fokus-Endes, auch bei Auswahl (IME-Kandidatenfenster).
    pub fn focus_rect(&self) -> Rect {
        Self::rect(self.sel.focus().geometry(&self.layout, 1.))
    }

    /// Ein Rechteck je Zeile der Auswahl.
    pub fn selection_rects(&self) -> Vec<Rect> {
        self.sel
            .geometry(&self.layout)
            .into_iter()
            .map(|(b, _)| Self::rect(b))
            .collect()
    }

    /// Rechtecke unter dem Preedit (Unterstreichung).
    pub fn compose_rects(&self) -> Vec<Rect> {
        let Some(r) = &self.compose else {
            return vec![];
        };
        Selection::new(self.cursor(r.start), self.cursor(r.end))
            .geometry(&self.layout)
            .into_iter()
            .map(|(b, _)| Self::rect(b))
            .collect()
    }

    pub fn height(&self) -> f32 {
        self.layout.height()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fonts_for_tests;

    fn ed(md: &str) -> Editor {
        let style = TextStyle {
            family: "Archivo".into(),
            width: Some(200.),
            ..TextStyle::default()
        };
        Editor::new(fonts_for_tests(), RichText::parse(md), style)
    }

    fn md(e: &Editor) -> String {
        e.doc().serialize().text
    }

    #[test]
    fn insert_and_delete() {
        let mut e = ed("Hallo");
        assert_eq!(e.sel_bytes(), (5, 5));
        e.insert(" Welt");
        assert_eq!(e.text(), "Hallo Welt");
        e.backspace();
        assert_eq!(e.text(), "Hallo Wel");
        e.move_cursor(Move::Start, false);
        e.delete();
        assert_eq!(e.text(), "allo Wel");
        e.insert("Ä");
        e.backspace();
        e.backspace();
        assert_eq!(e.text(), "allo Wel", "Rücktaste am Anfang tut nichts");
        e.select_all();
        e.insert("neu");
        assert_eq!(e.text(), "neu");
    }

    #[test]
    fn multibyte_backspace() {
        let mut e = ed("Grüß");
        e.backspace();
        e.backspace();
        assert_eq!(e.text(), "Gr");
    }

    #[test]
    fn word_and_line_moves() {
        let mut e = ed("eins zwei drei");
        e.move_cursor(Move::Start, false);
        e.move_cursor(Move::WordRight, false);
        let first = e.sel_bytes().1;
        assert!(first == 4 || first == 5, "Wortende {first}");
        e.move_cursor(Move::End, false);
        e.move_cursor(Move::WordLeft, true);
        assert_eq!(e.selected_text(), "drei");
        e.backspace_word();
        assert_eq!(e.text(), "eins zwei ");
        e.move_cursor(Move::Start, false);
        e.delete_word();
        assert!(e.text().starts_with("zwei") || e.text().starts_with(" zwei"));
        // Zeilen: schmale Box, mehrere Zeilen
        let mut e = ed("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk");
        assert!(e.layout().len() > 1, "bricht um");
        e.move_cursor(Move::Start, false);
        e.move_cursor(Move::Down, false);
        let down = e.sel_bytes().1;
        assert!(down > 0);
        e.move_cursor(Move::Up, false);
        assert_eq!(e.sel_bytes().1, 0);
        e.move_cursor(Move::LineEnd, false);
        let end = e.sel_bytes().1;
        assert!(end > 0 && end <= down + 1);
        e.move_cursor(Move::LineStart, false);
        assert_eq!(e.sel_bytes().1, 0);
    }

    #[test]
    fn collapse_on_arrows() {
        let mut e = ed("abcdef");
        e.select_range(1..4);
        e.move_cursor(Move::Left, false);
        assert_eq!(e.sel_bytes(), (1, 1));
        e.select_range(1..4);
        e.move_cursor(Move::Right, false);
        assert_eq!(e.sel_bytes(), (4, 4));
        e.move_cursor(Move::Right, true);
        assert_eq!(e.selection(), 4..5);
    }

    #[test]
    fn bold_toggle_and_span_edges() {
        let mut e = ed("ein Wort hier");
        e.select_range(4..8);
        e.toggle_bold();
        assert_eq!(md(&e), "ein **Wort** hier");
        // Tippen am Ende der fetten Spanne bleibt fett, am Anfang davor nicht
        e.move_cursor(Move::Right, false);
        e.insert("e");
        assert_eq!(md(&e), "ein **Worte** hier");
        e.select_range(3..3);
        e.insert("X");
        assert_eq!(md(&e), "einX **Worte** hier");
        // erneut umschalten entfernt fett, teilweise fett → ganz fett
        e.select_range(5..10);
        e.toggle_bold();
        assert_eq!(md(&e), "einX Worte hier");
        e.select_range(6..8);
        e.toggle_bold();
        e.select_range(5..10);
        e.toggle_bold();
        assert_eq!(md(&e), "einX **Worte** hier");
        // leere Auswahl: Strg+B gilt für die nächste Eingabe
        e.move_cursor(Move::End, false);
        e.toggle_bold();
        e.insert("!");
        assert_eq!(md(&e), "einX **Worte** hier**!**");
    }

    #[test]
    fn links_and_colors() {
        let mut e = ed("siehe [hier](https://a.de) mehr");
        assert_eq!(e.text(), "siehe hier mehr");
        // am Linkende tippen verlängert den Link nicht, mittendrin schon
        e.select_range(10..10);
        e.insert("!");
        assert_eq!(md(&e), "siehe [hier](https://a.de)! mehr");
        e.select_range(8..8);
        e.insert("e");
        assert_eq!(md(&e), "siehe [hieer](https://a.de)! mehr");
        e.select_range(0..5);
        assert!(!e.set_link(Some("javascript:alert(1)")));
        assert!(e.set_link(Some("mailto:x@y.de")));
        assert_eq!(md(&e), "[siehe](mailto:x@y.de) [hieer](https://a.de)! mehr");
        e.select_range(0..5);
        e.set_link(None);
        e.set_color(Some(0xff0000ff));
        let s = e.doc().serialize();
        assert!(
            s.lossy && s.color.is_none(),
            "Teilfarbe ist nicht speicherbar"
        );
        e.select_all();
        e.set_color(Some(0xff0000ff));
        assert_eq!(e.doc().serialize().color, Some(0xff0000ff));
        e.select_all();
        e.toggle_italic();
        assert!(e.doc().serialize().italic);
    }

    #[test]
    fn undo_redo_coalesces_typing() {
        let mut e = ed("");
        for c in "Hallo Welt".chars() {
            e.insert(&c.to_string());
        }
        e.undo();
        assert_eq!(e.text(), "Hallo ", "Undo nimmt das letzte Wort");
        e.undo();
        assert_eq!(e.text(), "");
        assert!(!e.undo());
        e.redo();
        assert_eq!(e.text(), "Hallo ");
        e.redo();
        assert_eq!(e.text(), "Hallo Welt");
        assert!(!e.redo());
        e.select_range(0..5);
        e.toggle_bold();
        e.undo();
        assert_eq!(md(&e), "Hallo Welt");
        assert_eq!(e.selection(), 0..5, "Auswahl kommt mit zurück");
        e.redo();
        assert_eq!(md(&e), "**Hallo** Welt");
        // neue Änderung verwirft Redo
        e.undo();
        e.insert("x");
        assert!(!e.redo());
        // Löschen in Folge ist ein Schritt
        let mut e = ed("abcdef");
        e.backspace();
        e.backspace();
        e.backspace();
        e.undo();
        assert_eq!(e.text(), "abcdef");
    }

    #[test]
    fn ime_compose_commit_cancel() {
        let mut e = ed("ab");
        e.set_compose("に", Some((3, 3)));
        assert!(e.is_composing());
        assert_eq!(e.text(), "abに");
        e.set_compose("にほ", Some((6, 6)));
        assert_eq!(e.text(), "abにほ");
        assert_eq!(e.compose_range(), Some(2..8));
        assert_eq!(e.sel_bytes(), (8, 8));
        assert!(!e.compose_rects().is_empty());
        // winit: leeres Preedit, dann Commit
        e.set_compose("", None);
        assert_eq!(e.text(), "ab");
        e.commit_compose("日本");
        assert_eq!(e.text(), "ab日本");
        assert!(!e.is_composing());
        e.undo();
        assert_eq!(e.text(), "ab", "Komposition ist ein Undo-Schritt");
        // Preedit ersetzt die Auswahl; Abbrechen stellt sie wieder her
        e.select_range(0..1);
        e.set_compose("ü", None);
        assert_eq!(e.text(), "üb");
        e.cancel_compose();
        assert_eq!(e.text(), "ab");
        assert_eq!(e.selection(), 0..1);
        // Commit direkt nach Preedit (ohne leeres Preedit) ersetzt das Preedit
        e.move_cursor(Move::End, false);
        e.set_compose("k", None);
        e.commit_compose("か");
        assert_eq!(e.text(), "abか");
        // Format der Eingabe gilt auch für komponierten Text
        e.toggle_bold();
        e.set_compose("x", None);
        e.commit_compose("字");
        assert_eq!(md(&e), "abか**字**");
    }

    #[test]
    fn hit_test_and_rects() {
        let mut e = ed("Hallo Welt");
        let c0 = {
            e.move_cursor(Move::Start, false);
            e.cursor_rect(1.).unwrap()
        };
        e.move_cursor(Move::End, false);
        let c1 = e.cursor_rect(1.).unwrap();
        assert!(c1.x0 > c0.x0 + 50.);
        assert!(c0.height() > 15.);
        // Rechteck → Hit-Test liefert denselben Index
        for i in [0usize, 3, 6, 10] {
            e.select_range(i..i);
            let r = e.cursor_rect(1.).unwrap();
            assert_eq!(
                e.hit(r.x0 as f32 + 0.5, r.center().y as f32),
                i,
                "Index {i}"
            );
        }
        assert_eq!(e.hit(-50., 5.), 0);
        assert_eq!(e.hit(1000., 5.), 10);
        e.click(1000., 5., false);
        assert_eq!(e.sel_bytes(), (10, 10));
        e.click(-5., 5., true);
        assert_eq!(e.selection(), 0..10);
        assert!(e.cursor_rect(1.).is_none());
        assert_eq!(e.selection_rects().len(), 1);
        e.double_click(c1.x0 as f32 - 5., c1.center().y as f32);
        assert_eq!(e.selected_text(), "Welt");
        // mehrzeilige Auswahl → ein Rechteck je Zeile
        let mut e = ed("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk");
        e.select_all();
        assert_eq!(e.selection_rects().len(), e.layout().len());
    }

    #[test]
    fn ime_abort_keeps_selection_and_undo() {
        // Preedit-Abbruch (leeres Preedit) stellt Text und Auswahl wieder her
        let mut e = ed("abc");
        e.select_range(0..2);
        e.set_compose("x", None);
        e.set_compose("", None);
        assert_eq!((e.text(), e.selection()), ("abc", 0..2));
        // danach: weiter bearbeiten, Undo springt nicht auf einen alten Kompositions-Stand
        e.move_cursor(Move::End, false);
        e.insert("d");
        e.undo();
        assert_eq!(e.text(), "abc");
        e.redo();
        assert_eq!(e.text(), "abcd");
        assert!(!e.redo());
        // Commit ohne Preedit: ein normaler Undo-Schritt
        e.commit_compose("日");
        assert_eq!(e.text(), "abcd日");
        e.undo();
        assert_eq!(e.text(), "abcd");
        e.undo();
        assert_eq!(e.text(), "abc");
        // IME-Cursor mitten in einem Zeichen wird geklemmt
        e.set_compose("ä", Some((1, 1)));
        assert_eq!(e.sel_bytes(), (3, 3));
    }

    #[test]
    fn display_mapping_upper_and_typeset_chars() {
        // „“, geschütztes Leerzeichen vor % und Gedankenstrich: Mehrbyte-Zeichen, Cursor bleibt an Zeichengrenzen
        let mut e = ed("„Zitat“ 50\u{a0}% – fertig");
        e.move_cursor(Move::Start, false);
        let mut seen = vec![0];
        for _ in 0..e.text().chars().count() {
            e.move_cursor(Move::Right, false);
            seen.push(e.sel_bytes().1);
        }
        let want: Vec<usize> = e
            .text()
            .char_indices()
            .map(|(i, _)| i)
            .skip(1)
            .chain([e.text().len()])
            .collect();
        assert_eq!(&seen[1..], &want[..]);
        for i in [0, 3, 8, 11, 13, 18] {
            e.select_range(i..i);
            let r = e.cursor_rect(1.).unwrap();
            assert_eq!(
                e.hit(r.x0 as f32 + 0.5, r.center().y as f32),
                i,
                "Index {i}"
            );
        }
        // upper: ß → SS ist im Layout länger als im Text
        let mut s = TextStyle {
            family: "Archivo".into(),
            ..TextStyle::default()
        };
        s.upper = true;
        let mut e = Editor::new(fonts_for_tests(), RichText::parse("Maß **ab**"), s);
        assert_eq!(e.shown(), "MASS AB");
        e.move_cursor(Move::Start, false);
        e.move_cursor(Move::Right, false);
        e.move_cursor(Move::Right, false);
        e.move_cursor(Move::Right, false);
        assert_eq!(e.sel_bytes().1, 4, "über „ß“ in einem Schritt");
        e.move_cursor(Move::Left, false);
        assert_eq!(e.sel_bytes().1, 2);
        e.select_range(5..7);
        assert_eq!(e.selected_text(), "ab");
        let r = e.selection_rects()[0];
        e.move_cursor(Move::End, false);
        let end = e.cursor_rect(1.).unwrap();
        assert!((r.x1 - end.x0).abs() < 1., "Auswahl endet am Textende");
        assert_eq!(e.hit(end.x0 as f32 + 0.5, end.center().y as f32), 7);
        e.insert("c");
        assert_eq!(e.doc().serialize().text, "Maß **abc**");
    }

    #[test]
    fn restyle_keeps_selection() {
        let mut e = ed("Hallo Welt");
        e.select_range(2..4);
        let mut s = e.style().clone();
        s.size = 40.;
        s.width = Some(60.);
        e.set_style(s);
        assert_eq!(e.selection(), 2..4);
        assert!(e.layout().len() > 1);
    }
}
