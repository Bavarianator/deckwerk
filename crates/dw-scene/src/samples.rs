//! Beispielinhalte min/typ/max aus layouts.ts (Stresstest, Katalog-Vorschau).

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

fn rep(n: usize, f: impl Fn(usize) -> Value) -> Value {
    Value::Array((0..n).map(f).collect())
}

/// [min, typ, max] eines Layouts.
pub fn samples(layout: &str) -> Option<[(&'static str, Value); 3]> {
    Some(match layout {
        "cover" => [
            ("min", json!({ "title": "Q3-Review" })),
            (
                "typ",
                json!({ "eyebrow": "Strategie 2027", "title": "Wie wir den Umsatz in 18 Monaten verdoppeln", "subtitle": "Wachstumsplan für die Geschäftsführung", "meta": "Max Muster · Oktober 2026" }),
            ),
            (
                "max",
                json!({ "eyebrow": words(28, 0), "title": words(70, 0), "subtitle": words(120, 3), "meta": words(60, 5) }),
            ),
        ],
        "bullets" => [
            (
                "min",
                json!({ "title": "Zwei Gründe sprechen für den Wechsel", "items": [{ "text": "Geringere Kosten" }, { "text": "Schnellere Abläufe" }] }),
            ),
            (
                "typ",
                json!({
                    "eyebrow": "Warum jetzt",
                    "title": "Drei Entwicklungen machen den Markt jetzt attraktiv",
                    "items": [
                        { "text": "Regulierung schafft Nachfrage", "sub": "Ab 2027 wird digitale Dokumentation Pflicht" },
                        { "text": "Wettbewerb ist fragmentiert", "sub": "Kein Anbieter hat mehr als 8 % Marktanteil" },
                        { "text": "Kunden sind wechselbereit", "sub": "62 % planen einen Anbieterwechsel in 24 Monaten" },
                    ],
                }),
            ),
            (
                "max",
                json!({ "eyebrow": words(28, 0), "title": words(90, 0), "items": rep(5, |i| json!({ "text": words(80, i), "sub": words(110, i + 3), "icon": "check" })) }),
            ),
        ],
        "two-column" => [
            (
                "min",
                json!({ "title": "Heute gegenüber morgen", "left": { "heading": "Heute" }, "right": { "heading": "Morgen" } }),
            ),
            (
                "typ",
                json!({
                    "title": "Die neue Plattform halbiert den manuellen Aufwand",
                    "left": { "heading": "Heute", "points": ["6 Systeme, keine Schnittstellen", "Berichte per Excel", "3 Tage bis zur Freigabe"] },
                    "right": { "heading": "Mit Deckwerk", "points": ["Eine Plattform für alles", "Berichte in Echtzeit", "Freigabe in 2 Stunden"] },
                }),
            ),
            (
                "max",
                json!({
                    "eyebrow": words(28, 0), "title": words(90, 0),
                    "left": { "heading": words(40, 0), "text": words(200, 0), "points": rep(4, |i| json!(words(64, i))) },
                    "right": { "heading": words(40, 2), "text": words(200, 3), "points": rep(4, |i| json!(words(64, i + 1))) },
                }),
            ),
        ],
        _ => return None,
    })
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
