//! Rich-Text-Modell: Klartext plus Format je Byte; Ein- und Ausgabe im deck.json-Format.
//!
//! deck.json kennt in Texten nur `**fett**` und `[Text](https://…)` (slide.tsx `rich`, dw-scene `text::rich`).
//! Kursiv und Farbe gibt es nur für das ganze freie Element (`Item.italic`, `Item.color`); einheitliche
//! Werte landen dort, gemischte gehen beim Speichern verloren (`Serialized::lossy`).

use std::ops::Range;
use std::sync::Arc;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Attrs {
    pub bold: bool,
    pub italic: bool,
    pub link: Option<Arc<str>>,
    /// RGBA, `None` = Farbe des Elements
    pub color: Option<u32>,
}

/// Text mit Format je Byte.
// ponytail: ein Attrs je Byte, O(n) je Bearbeitung; Folientexte sind kurz, Rope/Spannenbaum erst bei langen Texten
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RichText {
    text: String,
    attrs: Vec<Attrs>,
    /// Kursiv/Farbe des Elements, wenn der Text leer ist (sonst gingen sie beim Leeren verloren)
    base: Attrs,
}

/// Zeilenende wie `.` in JS-Regex (ohne s-Flag): \n, \r, U+2028, U+2029
fn js_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `\s` in JS: Unicode-Leerraum plus U+FEFF
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Ergebnis von `RichText::serialize`: Text für den Slot, dazu Werte für das ganze Element.
#[derive(Debug, Clone, PartialEq)]
pub struct Serialized {
    pub text: String,
    /// alles kursiv → `Item.italic`
    pub italic: bool,
    /// eine Farbe für alles → `Item.color`
    pub color: Option<u32>,
    /// Format, das deck.json nicht speichern kann (teilweise kursiv/farbig, fetter Link)
    pub lossy: bool,
}

impl RichText {
    pub fn plain(text: &str) -> Self {
        RichText {
            text: text.to_string(),
            attrs: vec![Attrs::default(); text.len()],
            base: Attrs::default(),
        }
    }

    /// Liest den Slot-Text wie `rich()` in slide.tsx.
    pub fn parse(src: &str) -> Self {
        let mut out = RichText::default();
        let mut i = 0;
        while i < src.len() {
            let rest = &src[i..];
            // \*\*.+?\*\*  (. ohne Zeilenumbruch, mindestens ein Zeichen)
            if let Some(body) = rest.strip_prefix("**") {
                let end = body
                    .char_indices()
                    .skip(1)
                    .find(|&(j, _)| body[j..].starts_with("**"))
                    .map(|(j, _)| j);
                if let Some(j) = end.filter(|&j| !body[..j].contains(js_line_end)) {
                    out.push(
                        &body[..j],
                        Attrs {
                            bold: true,
                            ..Attrs::default()
                        },
                    );
                    i += 4 + j;
                    continue;
                }
            }
            if let Some((text, url, len)) = parse_link(rest) {
                out.push(
                    text,
                    Attrs {
                        link: Some(url.into()),
                        ..Attrs::default()
                    },
                );
                i += len;
                continue;
            }
            let ch = rest.chars().next().expect("nicht leer");
            out.push(&rest[..ch.len_utf8()], Attrs::default());
            i += ch.len_utf8();
        }
        out
    }

    /// Item-Text mit Element-Format (`Item.italic`, `Item.color`) als Grundformat.
    pub fn parse_item(src: &str, italic: bool, color: Option<u32>) -> Self {
        let mut r = Self::parse(src);
        for a in &mut r.attrs {
            a.italic = italic;
            a.color = color;
        }
        r.base = Attrs {
            italic,
            color,
            ..Attrs::default()
        };
        r
    }

    /// Zurück ins deck.json-Format.
    pub fn serialize(&self) -> Serialized {
        let italic = if self.attrs.is_empty() {
            self.base.italic
        } else {
            self.attrs.iter().all(|a| a.italic)
        };
        let color = self.attrs.first().unwrap_or(&self.base).color;
        let one_color = self.attrs.iter().all(|a| a.color == color);
        let mut lossy = !(italic || self.attrs.iter().all(|a| !a.italic)) || !one_color;
        let mut text = String::new();
        for (r, a) in self.runs() {
            let t = &self.text[r];
            if let Some(url) = &a.link {
                lossy |= a.bold;
                text.push_str(&format!("[{t}]({url})"));
            } else if a.bold {
                // `.` im Muster passt nicht auf \n: fett je Zeile schließen
                for (k, line) in t.split('\n').enumerate() {
                    if k > 0 {
                        text.push('\n');
                    }
                    if !line.is_empty() {
                        text.push_str(&format!("**{line}**"));
                    }
                }
            } else {
                text.push_str(t);
            }
        }
        // Liest das Ergebnis anders zurück (Sternchen am Rand einer fetten Spanne, wörtliches `**` oder
        // `[x](https://…)` im Klartext)? TS kennt kein Escaping, also nur melden.
        let back = RichText::parse(&text);
        let key = |a: &Attrs| (a.bold, a.link.clone());
        lossy |= back.text != self.text
            || back
                .attrs
                .iter()
                .zip(&self.attrs)
                .any(|(x, y)| key(x) != key(y));
        Serialized {
            text,
            italic,
            color: color.filter(|_| one_color),
            lossy,
        }
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn len(&self) -> usize {
        self.text.len()
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    /// Element-Format bei leerem Text
    pub fn base(&self) -> &Attrs {
        &self.base
    }

    pub fn attrs_at(&self, i: usize) -> Option<&Attrs> {
        self.attrs.get(i)
    }

    /// Zusammenhängende Bereiche gleichen Formats.
    pub fn runs(&self) -> Vec<(Range<usize>, &Attrs)> {
        let mut out: Vec<(Range<usize>, &Attrs)> = Vec::new();
        for (i, a) in self.attrs.iter().enumerate() {
            match out.last_mut() {
                Some((r, b)) if *b == a => r.end = i + 1,
                _ => out.push((i..i + 1, a)),
            }
        }
        out
    }

    fn push(&mut self, s: &str, a: Attrs) {
        self.text.push_str(s);
        self.attrs.extend(std::iter::repeat_n(a, s.len()));
    }

    /// Ersetzt `range` durch `s` mit Format `a`.
    pub fn replace(&mut self, range: Range<usize>, s: &str, a: &Attrs) {
        if s.is_empty() && range.len() == self.text.len() && !self.attrs.is_empty() {
            let first = &self.attrs[0];
            self.base = Attrs {
                italic: first.italic,
                color: first.color,
                ..Attrs::default()
            };
        }
        self.text.replace_range(range.clone(), s);
        self.attrs
            .splice(range, std::iter::repeat_n(a.clone(), s.len()));
    }

    /// Ändert das Format in `range`.
    pub fn format(&mut self, range: Range<usize>, f: impl Fn(&mut Attrs)) {
        for a in &mut self.attrs[range] {
            f(a);
        }
    }

    pub fn all(&self, range: Range<usize>, f: impl Fn(&Attrs) -> bool) -> bool {
        !range.is_empty() && self.attrs[range].iter().all(f)
    }
}

/// `[Text](http:|https:|mailto:…)` am Anfang → (Text, URL, Länge in Bytes).
fn parse_link(rest: &str) -> Option<(&str, &str, usize)> {
    let body = rest.strip_prefix('[')?;
    let close = body.find(']').filter(|&c| c > 0)?;
    let after = body[close + 1..].strip_prefix('(')?;
    if !["http:", "https:", "mailto:"]
        .iter()
        .any(|p| after.starts_with(p))
    {
        return None;
    }
    let scheme = if after.starts_with("https:") {
        6
    } else if after.starts_with("mailto:") {
        7
    } else {
        5
    };
    // [^)\s]+ : mindestens ein Zeichen nach dem Schema
    let end = after.find(|c: char| c == ')' || js_space(c))?;
    (end > scheme && after[end..].starts_with(')'))
        .then(|| (&body[..close], &after[..end], 1 + close + 2 + end + 1))
}

/// Gültiges Linkziel für deck.json (sonst würde der Text beim nächsten Lesen nicht als Link erkannt).
pub fn valid_url(url: &str) -> bool {
    // gleiche Regel wie beim Lesen, damit ein gesetzter Link nach dem Speichern wieder einer ist
    parse_link(&format!("[x]({url})")).is_some_and(|(_, u, _)| u == url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        for s in [
            "",
            "Hallo Welt",
            "Ein **fettes** Wort",
            "**ganz fett**",
            "Mehr unter [deckwerk.de](https://deckwerk.de) und **hier**.",
            "Zeile 1\nZeile **2**",
            "Grüße **äöü** – „Zitat“",
            "[Mail](mailto:a@b.de)",
        ] {
            assert_eq!(RichText::parse(s).serialize().text, s, "{s}");
        }
    }

    #[test]
    fn parse_like_ts() {
        let r = RichText::parse("a **b** [c](https://x.y) **");
        assert_eq!(r.as_str(), "a b c **");
        assert!(r.attrs_at(2).unwrap().bold);
        assert_eq!(r.attrs_at(4).unwrap().link.as_deref(), Some("https://x.y"));
        // kein Link ohne Schema, kein fett über Zeilenumbruch, „****“ bleibt Text
        assert_eq!(RichText::parse("[c](x.y)").as_str(), "[c](x.y)");
        assert_eq!(RichText::parse("**a\nb**").as_str(), "**a\nb**");
        assert_eq!(RichText::parse("****").as_str(), "****");
    }

    #[test]
    fn bold_across_lines_reparses() {
        let mut r = RichText::plain("ab\ncd");
        r.format(0..5, |a| a.bold = true);
        let s = r.serialize().text;
        assert_eq!(s, "**ab**\n**cd**");
        assert_eq!(RichText::parse(&s).runs().len(), 3);
    }

    #[test]
    fn item_level_formats() {
        let r = RichText::parse_item("x **y**", true, Some(0xff0000ff));
        let s = r.serialize();
        assert_eq!(
            (s.text.as_str(), s.italic, s.color, s.lossy),
            ("x **y**", true, Some(0xff0000ff), false)
        );
        let mut r = RichText::plain("ab");
        r.format(0..1, |a| a.italic = true);
        assert!(r.serialize().lossy);
        let mut r = RichText::plain("ab");
        r.format(0..2, |a| {
            a.bold = true;
            a.link = Some("https://x".into())
        });
        let s = r.serialize();
        assert_eq!(s.text, "[ab](https://x)");
        assert!(s.lossy);
    }

    #[test]
    fn replace_keeps_attrs_aligned() {
        let mut r = RichText::parse("a **b** c");
        r.replace(
            2..3,
            "BBB",
            &Attrs {
                bold: true,
                ..Default::default()
            },
        );
        assert_eq!(r.serialize().text, "a **BBB** c");
        r.replace(0..1, "ä", &Attrs::default());
        assert_eq!(r.serialize().text, "ä **BBB** c");
        assert!(
            valid_url("https://a.b/c") && !valid_url("javascript:x") && !valid_url("https://a b")
        );
    }

    #[test]
    fn link_and_bold_rules_like_js() {
        assert_eq!(
            RichText::parse("[a](https:)").as_str(),
            "[a](https:)",
            "leeres Ziel ist kein Link"
        );
        assert_eq!(RichText::parse("[a](http:x)").as_str(), "a");
        assert_eq!(
            RichText::parse("[a](https://x\u{2028}y)").as_str(),
            "[a](https://x\u{2028}y)"
        );
        assert_eq!(
            RichText::parse("[a](https://x\u{feff})").as_str(),
            "[a](https://x\u{feff})"
        );
        assert_eq!(RichText::parse("**a\rb**").as_str(), "**a\rb**");
        assert!(!valid_url("https:") && !valid_url("mailto:") && valid_url("mailto:a@b.de"));
    }

    #[test]
    fn unrepresentable_is_lossy() {
        // fett mit Sternchen am Rand, wörtliches ** und Link-Markdown im Klartext
        let mut r = RichText::plain("*a*");
        r.format(0..3, |a| a.bold = true);
        assert!(r.serialize().lossy);
        assert!(RichText::plain("x ** y ** z").serialize().lossy);
        assert!(RichText::plain("[a](https://b)").serialize().lossy);
        assert!(!RichText::plain("5 * 3").serialize().lossy);
        // leerer Item-Text behält kursiv und Farbe, auch nach dem Leeren
        let s = RichText::parse_item("", true, Some(7)).serialize();
        assert_eq!((s.italic, s.color), (true, Some(7)));
        let mut r = RichText::parse_item("ab", true, Some(7));
        r.replace(0..2, "", &Attrs::default());
        let s = r.serialize();
        assert_eq!((s.italic, s.color), (true, Some(7)));
    }
}
