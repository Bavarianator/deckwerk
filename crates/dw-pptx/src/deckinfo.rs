//! Aus dem Deck abgeleitete Export-Angaben (pptx-post.ts addSections, agendaLinks) für `SlideOpts`.

use std::collections::HashSet;

use dw_model::Deck;
use serde_json::Value;

/// Abschnittsname je Folie: Kapiteltrenner (`section`) → „Nummer Titel“, sonst None.
pub fn sections(deck: &Deck) -> Vec<Option<String>> {
    deck.slides
        .iter()
        .map(|s| {
            (s.layout == "section").then(|| {
                ["number", "title"]
                    .iter()
                    .filter_map(|k| truthy(s.content.get(k)))
                    .collect::<Vec<_>>()
                    .join(" ")
            })
        })
        .collect()
}

// JS filter(Boolean) + String(): leere Texte, 0 und null fallen weg
fn truthy(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) if n.as_f64() != Some(0.0) => Some(n.to_string()),
        Value::Bool(true) => Some("true".into()),
        _ => None,
    }
}

// Wörter ab 4 Buchstaben, klein (\p{L}{4,})
fn words(s: &str) -> HashSet<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphabetic())
        .filter(|w| w.chars().count() >= 4)
        .map(str::to_string)
        .collect()
}

/// Agenda anklickbar: je Agenda-Folie (Punkt k → Kapiteltrenner) mit einem gemeinsamen Wort (≥ 4 Buchstaben) im Titel.
/// Index wie `deck.slides`; ohne Treffer bleibt der Punkt ohne Link.
pub fn agenda_links(deck: &Deck) -> Vec<Vec<(usize, usize)>> {
    let title = |v: &Value| v.get("title").and_then(Value::as_str).unwrap_or("").to_string();
    deck.slides
        .iter()
        .enumerate()
        .map(|(i, s)| {
            if s.layout != "agenda" {
                return vec![];
            }
            let items = s.content.get("items").and_then(Value::as_array);
            items
                .into_iter()
                .flatten()
                .enumerate()
                .filter_map(|(k, it)| {
                    let w = words(&title(it));
                    deck.slides
                        .iter()
                        .enumerate()
                        .position(|(j, x)| {
                            j != i
                                && x.layout == "section"
                                && words(&title(&x.content)).iter().any(|y| w.contains(y))
                        })
                        .map(|to| (k, to))
                })
                .collect()
        })
        .collect()
}
