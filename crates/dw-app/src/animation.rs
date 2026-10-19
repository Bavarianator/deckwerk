//! Übergang und Aufbau pro Folie (deck.ts TRANSITIONS/BUILDS) für das „Anpassen“-Panel.
// ponytail: Morph/Übergänge in der Präsentation später (PresentWindow und dw-canvas spielen noch keine ab); Element-Animation (Item.anim) und Deck-Übergang folgen mit der Element-Auswahl im Inspector.

pub const TRANSITIONS: &[(&str, &str)] = &[
    ("none", "Ohne"), ("fade", "Überblenden"), ("push", "Schieben"), ("morph", "Morph"), ("dissolve", "Auflösen"),
    ("wipe", "Wischen"), ("cover", "Überdecken"), ("split", "Teilen"), ("circle", "Kreis"), ("zoom", "Zoom"),
    ("slide", "Gleiten"), ("stack", "Stapel"), ("color", "Farbwischen"),
];
pub const BUILDS: &[(&str, &str)] = &[
    ("none", "Ohne"), ("fade", "Einblenden"), ("list", "Liste"), ("stagger", "Nacheinander"), ("wipe", "Wischen"),
    ("zoom-kpi", "Zahlen-Zoom"), ("pan", "Schwenken"), ("pop", "Pop"), ("words", "Wort für Wort"), ("photo", "Foto-Zoom"),
];
pub const SPEEDS: &[(&str, &str)] = &[("slow", "Langsam"), ("fast", "Schnell")];

/// Auswahlliste mit „Standard“ vorn; Index 0 = Feld entfernen
pub fn options(list: &[(&str, &str)], std: &str) -> Vec<String> {
    std::iter::once(std.to_string()).chain(list.iter().map(|x| x.1.to_string())).collect()
}

pub fn index(list: &[(&str, &str)], v: Option<&str>) -> i32 {
    v.and_then(|v| list.iter().position(|x| x.0 == v)).map_or(0, |i| i as i32 + 1)
}

pub fn value(list: &[(&'static str, &str)], i: i32) -> Option<&'static str> {
    (i > 0).then(|| list.get(i as usize - 1).map(|x| x.0)).flatten()
}

#[test]
fn roundtrip() {
    assert_eq!(value(TRANSITIONS, index(TRANSITIONS, Some("morph"))), Some("morph"));
    assert_eq!(value(BUILDS, 0), None);
}
