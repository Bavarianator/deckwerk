//! Reine Logik der Startseite (Start.tsx): Formatwahl, Beispiele, Filter, Datum, Regal-Anordnung.

use dw_model::{Deck, Profile, profile_of};

/// FORMAT_CHOICES: (id, Name im Menü, Format für „Leer beginnen“)
pub const FORMAT_CHOICES: &[(&str, &str, Option<&str>)] = &[
    ("auto", "Automatisch", None),
    ("praesentation", "Präsentation", None),
    ("flyer", "Flyer", Some("a4")),
    ("plakat", "Plakat", Some("a4")),
    ("dokument", "Dokument", Some("a4")),
    ("brief", "Brief", Some("a4")),
    ("bewerbung", "Bewerbung", Some("a4")),
    ("lebenslauf", "Lebenslauf", Some("a4")),
    ("einladung", "Einladung", Some("a4")),
    ("urkunde", "Urkunde", Some("a4-quer")),
    ("speisekarte", "Speisekarte", Some("a4")),
    ("visitenkarte", "Visitenkarte", Some("visitenkarte")),
    ("social", "Social-Post", Some("4:5")),
    ("story", "Story", Some("9:16")),
];

/// PAPERS (Format-Regal); die letzten drei nur in Pro
pub const PAPERS: &[&str] = &["praesentation", "dokument", "brief", "flyer", "urkunde", "social", "story", "visitenkarte", "video", "animation", "podcast"];
pub const PRO_PAPERS: &[(&str, &str)] = &[("video", "Video"), ("animation", "Animation"), ("podcast", "Podcast")];

/// EXAMPLES: (Wunsch, Format-ID)
pub const EXAMPLES: &[(&str, &str)] = &[
    ("Erstelle einen 10-Folien-Pitch für Ortho-Bot, ein KI-Rechtschreibtool für Schulen – Zielgruppe Geschäftsführung", "auto"),
    ("Projektstatus für die Geschäftsführung: ERP-Migration zu 70 % fertig, Budget im Plan, ein Risiko beim Datenimport", "auto"),
    ("Strategie 2027 für unser Vertriebsteam: drei Wachstumshebel, Roadmap und Budget, etwa 12 Folien", "auto"),
    (
        "Gestalte einen Flyer (A4) für unser Sommerfest am 12. Juli ab 15 Uhr im Innenhof: Musik, Grill, Kinderprogramm – Anmeldung über unsere Webseite",
        "flyer",
    ),
];

pub fn choice(id: &str) -> usize {
    FORMAT_CHOICES.iter().position(|c| c.0 == id).unwrap_or(0)
}

/// Papier im Regal zur Formatwahl (-1 = keins, bei „Automatisch“)
pub fn paper_of(choice: usize) -> i32 {
    PAPERS.iter().position(|p| *p == FORMAT_CHOICES[choice].0).map_or(-1, |i| i as i32)
}

/// FormatId (dw_model::FORMATS) für „Leer beginnen“
pub fn blank_format(choice: usize) -> &'static str {
    FORMAT_CHOICES[choice].2.unwrap_or("16:9")
}

pub fn blank_text(choice: usize) -> String {
    if choice == 0 { "Leer beginnen und frei gestalten".into() } else { format!("Leer beginnen: {}", FORMAT_CHOICES[choice].1) }
}

/// KINDS: alle, folien, druck, social, video, podcast
pub fn kind_of(d: &Deck) -> usize {
    if d.extra.get("podcast").is_some_and(|p| !p.is_null()) {
        return 5;
    }
    if d.slides.iter().any(|s| s.layout == "clip" || s.layout == "schnitt") {
        return 4;
    }
    match profile_of(d.size) {
        Profile::Slides => 1,
        Profile::Doc => 2,
        Profile::Social => 3,
    }
}

/// Suchtext wie titlesOf: Titel und Folientitel
pub fn titles(d: &Deck) -> String {
    std::iter::once(d.title.as_str())
        .chain(d.slides.iter().filter_map(|s| s.content.get("title").and_then(|t| t.as_str())))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn fits(d: &Deck, query: &str, kind: usize) -> bool {
    let q = query.trim().to_lowercase();
    (kind == 0 || kind_of(d) == kind) && (q.is_empty() || titles(d).contains(&q))
}

/// „3 Folien“, A4 zählt Seiten
pub fn pages(d: &Deck) -> String {
    let n = d.slides.len();
    let doc = profile_of(d.size) == Profile::Doc;
    let word = match (doc, n == 1) {
        (true, true) => "Seite",
        (true, false) => "Seiten",
        (false, true) => "Folie",
        (false, false) => "Folien",
    };
    format!("{n} {word}")
}

const MONTHS: [&str; 12] = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/// (Jahr, Monat 1–12, Tag) aus Tagen seit 1970 (Howard Hinnant, civil_from_days)
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// „Heute“, „Gestern“ oder „16. Oktober“ (when in Start.tsx).
// ponytail: Tage in UTC; Ortszeit braucht eine Zeitzonen-Bibliothek, kurz nach Mitternacht kann der Tag abweichen
pub fn when(ms: u64, now_ms: u64) -> String {
    let (d, n) = ((ms / 86_400_000) as i64, (now_ms / 86_400_000) as i64);
    match n - d {
        0 => "Heute".into(),
        1 => "Gestern".into(),
        _ => {
            let (_, m, day) = civil(d);
            format!("{day}. {}", MONTHS[m as usize - 1])
        }
    }
}

pub const CARD_W: f32 = 232.0;
const GAP: f32 = 32.0;
/// Titel und Datum unter dem Bild (12 + 20 + 4 + 18)
const TEXT_H: f32 = 60.0;

/// .home-shelf: Spalten à 232 px, Abstand 32; Bild max. 232 hoch; Zeilenhöhe = höchstes Bild der Zeile.
/// Eingabe: Seitenverhältnisse (h/w); Rückgabe: (x, y, Bildhöhe) je Karte und Gesamthöhe.
pub fn shelf(ratios: &[f32], width: f32) -> (Vec<(f32, f32, f32)>, f32) {
    let cols = (((width + GAP) / (CARD_W + GAP)).floor() as usize).max(1);
    let mut out = vec![];
    let mut y = 0.0;
    for row in ratios.chunks(cols) {
        let hs: Vec<f32> = row.iter().map(|r| (CARD_W * r).min(CARD_W)).collect();
        let row_h = hs.iter().copied().fold(0.0, f32::max);
        for (c, h) in hs.into_iter().enumerate() {
            out.push((c as f32 * (CARD_W + GAP), y, h));
        }
        y += row_h + TEXT_H + GAP;
    }
    (out, (y - GAP).max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        let day = 86_400_000;
        let now = 1_792_281_600_000 + 3_600_000; // 18.10.2026 01:00 UTC
        assert_eq!(when(now, now), "Heute");
        assert_eq!(when(now - day, now), "Gestern");
        assert_eq!(when(now - 2 * day, now), "16. Oktober");
        assert_eq!(when(0, now), "1. Januar");
    }

    #[test]
    fn shelf_rows() {
        // 1024 px = 4 Spalten; Hochformat wird auf 232 begrenzt, Zeilenhöhe = höchstes Bild
        let (pos, h) = shelf(&[0.5625, 1.414, 0.5625, 0.5625, 0.5625], 1024.0);
        assert_eq!(pos[1], (264.0, 0.0, 232.0));
        assert_eq!(pos[3].0, 3.0 * 264.0);
        assert_eq!(pos[4], (0.0, 232.0 + 60.0 + 32.0, 130.5));
        assert_eq!(h, 324.0 + 130.5 + 60.0);
        assert_eq!(shelf(&[0.5], 100.0).0[0].0, 0.0);
    }

    #[test]
    fn formats_and_filters() {
        assert_eq!(paper_of(choice("flyer")), 3);
        assert_eq!(paper_of(0), -1);
        assert_eq!(blank_format(choice("social")), "4:5");
        assert_eq!(blank_text(choice("brief")), "Leer beginnen: Brief");
        let d = crate::editor::new_deck("Quartal Vertrieb", "a4");
        assert_eq!(kind_of(&d), 2);
        assert_eq!(pages(&d), "1 Seite");
        assert!(fits(&d, "vertrieb", 0) && fits(&d, "", 2) && !fits(&d, "", 1) && !fits(&d, "xyz", 0));
    }
}
