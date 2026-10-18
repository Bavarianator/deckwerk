//! Beispielinhalte min/typ/max aus layouts.ts (Stresstest, Katalog-Vorschau); die Inhalte stehen je Layout in layouts/.

use dw_model::Deck;
use serde_json::{Value, json};

const WORDS: &str = "Digitalisierung Kundenzufriedenheit steigt deutlich durch neue Prozesse im Vertrieb und Wachstumsstrategie für internationale Märkte mit messbarem Mehrwert";

/// Deterministischer „Worst Case“-Text aus Geschäftswörtern, höchstens `max` Zeichen (layouts.ts words()).
pub fn words(max: usize, offset: usize) -> String {
    let w: Vec<&str> = WORDS.split(' ').collect();
    let len = |s: &str| s.encode_utf16().count();
    let mut s = String::new();
    for i in offset.. {
        let word = w[i % w.len()];
        let next = if s.is_empty() {
            word.to_string()
        } else {
            format!("{s} {word}")
        };
        if len(&next) > max {
            return if s.is_empty() {
                word.chars().take(max).collect()
            } else {
                s
            };
        }
        s = next;
    }
    unreachable!()
}

pub fn rep(n: usize, f: impl Fn(usize) -> Value) -> Value {
    Value::Array((0..n).map(f).collect())
}

/// [min, typ, max] eines Layouts (aus `layouts/<id>.rs`).
pub fn samples(layout: &str) -> Option<[(&'static str, Value); 3]> {
    crate::layouts::get(layout).map(|d| (d.samples)())
}

/// Deck mit einer Folie (16:9, Theme beratung).
pub fn deck(layout: &str, variant: &str, content: Value) -> Deck {
    serde_json::from_value(json!({
        "title": "Beispiel",
        "theme": { "id": "beratung" },
        "slides": [{ "id": "s1", "layout": layout, "variant": variant, "content": content }],
    }))
    .expect("Beispieldeck")
}

#[cfg(test)]
mod tests {
    #[test]
    fn words_like_ts() {
        assert_eq!(super::words(28, 0), "Digitalisierung");
        assert_eq!(
            super::words(40, 2),
            "steigt deutlich durch neue Prozesse im"
        );
        assert_eq!(super::words(5, 0), "Digit");
    }
}
