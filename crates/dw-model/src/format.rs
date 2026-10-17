//! Formate (Magic Resize) aus deck.ts: Größe in CSS-px, 96 px = 1 Zoll.

use serde::{Deserialize, Serialize};

// streng f64: Müll in size ("w": "/../..") lehnt schon das Lesen des Decks ab
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

pub struct Format {
    pub id: &'static str,
    pub name: &'static str,
    pub w: f64,
    pub h: f64,
}

const fn f(id: &'static str, name: &'static str, w: f64, h: f64) -> Format {
    Format { id, name, w, h }
}

pub const FORMATS: &[Format] = &[
    f("16:9", "Präsentation 16:9", 1280.0, 720.0),
    f("4:3", "Präsentation 4:3", 960.0, 720.0),
    f("1:1", "Quadrat (Instagram-Post)", 1080.0, 1080.0),
    f("4:5", "Hochformat 4:5 (Instagram)", 1080.0, 1350.0),
    f("9:16", "Story / Reel 9:16", 720.0, 1280.0),
    f("a4", "A4 Hochformat", 794.0, 1123.0),
    f("a4-quer", "A4 Querformat", 1123.0, 794.0),
    f("og", "Link-Vorschau 1200×630", 1200.0, 630.0),
    f("visitenkarte", "Visitenkarte 85×55 mm", 321.0, 208.0), // Druck: Endformat bei 96 dpi
    #[cfg(feature = "pro")]
    f("panel", "Twitch-Panel 320×160", 320.0, 160.0), // Stream-Paket; PNG kommt doppelt so groß
];

pub fn format(id: &str) -> Option<&'static Format> {
    FORMATS.iter().find(|f| f.id == id)
}

fn is(s: Size, id: &str) -> bool {
    format(id).is_some_and(|f| f.w == s.w && f.h == s.h)
}

pub fn is_a4(s: Size) -> bool {
    is(s, "a4") || is(s, "a4-quer")
}

/// Kürzel für Dateinamen (4x5, a4 …), Sondergrößen als 800x600, 16:9 leer.
/// Nur endliche Zahlen: Aus JSON kommt kein NaN/∞ (Size ist streng), der Guard fängt programmatisch erzeugte Werte.
pub fn format_suffix(size: Option<Size>) -> String {
    let Some(s) = size else { return String::new() };
    if !s.w.is_finite() || !s.h.is_finite() || (s.w == 1280.0 && s.h == 720.0) {
        return String::new();
    }
    let id = match FORMATS.iter().find(|f| f.w == s.w && f.h == s.h) {
        Some(f) => f.id.to_string(),
        None => format!("{}x{}", s.w, s.h), // f64-Display wie JS: 800, nicht 800.0
    };
    format!("-{}", id.replacen(':', "x", 1))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    Slides,
    Social,
    Doc,
}

/// Druck (A4, Visitenkarte) = Dokument, Quadrat/Hochformat = Social, sonst Folien.
pub fn profile_of(size: Option<Size>) -> Profile {
    let s = size.unwrap_or(Size {
        w: 1280.0,
        h: 720.0,
    });
    if is_a4(s) || is(s, "visitenkarte") {
        Profile::Doc
    } else if s.w / s.h <= 1.2 {
        Profile::Social
    } else {
        Profile::Slides
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suffix() {
        let sz = |w, h| Some(Size { w, h });
        assert_eq!(format_suffix(None), "");
        assert_eq!(format_suffix(sz(1280.0, 720.0)), "");
        assert_eq!(format_suffix(sz(1080.0, 1350.0)), "-4x5");
        assert_eq!(format_suffix(sz(794.0, 1123.0)), "-a4");
        assert_eq!(format_suffix(sz(800.0, 600.0)), "-800x600");
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(format_suffix(sz(bad, 720.0)), "");
            assert_eq!(format_suffix(sz(1280.0, bad)), "");
        }
        // negative Zahlen sind endlich: nur Ziffern, Minus und x, nie ein Pfad
        let neg = format_suffix(sz(-1.0, -2.5));
        assert_eq!(neg, "--1x-2.5");
        assert!(!neg.contains('/') && !neg.contains(".."));
    }

    #[test]
    fn profile() {
        let sz = |w, h| Some(Size { w, h });
        assert_eq!(profile_of(None), Profile::Slides);
        assert_eq!(profile_of(sz(1123.0, 794.0)), Profile::Doc);
        assert_eq!(profile_of(sz(321.0, 208.0)), Profile::Doc);
        assert_eq!(profile_of(sz(1080.0, 1350.0)), Profile::Social);
        assert_eq!(profile_of(sz(960.0, 720.0)), Profile::Slides);
    }
}
