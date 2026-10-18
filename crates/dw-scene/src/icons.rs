//! lucide-Icons (assets/lucide.txt, erzeugt von tools/gen-icons.mjs aus lucide-react) als SVG-Pfaddaten im 24er-Raster.

use std::collections::HashMap;
use std::sync::OnceLock;

const DATA: &str = include_str!("../assets/lucide.txt");

fn table() -> &'static HashMap<&'static str, &'static str> {
    static T: OnceLock<HashMap<&str, &str>> = OnceLock::new();
    T.get_or_init(|| {
        DATA.lines()
            .filter(|l| !l.starts_with('#'))
            .filter_map(|l| l.split_once('\t'))
            .collect()
    })
}

/// Pfaddaten eines Icons (auch alte Namen); None = unbekannt.
pub fn path(name: &str) -> Option<&'static str> {
    let d = table().get(name)?;
    match d.strip_prefix('=') {
        Some(target) => table().get(target).copied(),
        None => Some(d),
    }
}

/// Wie Icon in slide.tsx: unbekannte Namen zeigen Sparkles.
pub fn path_or_default(name: &str) -> &'static str {
    path(name).or_else(|| path("sparkles")).unwrap_or("")
}

#[cfg(test)]
mod tests {
    #[test]
    fn lookup() {
        assert_eq!(super::path("check"), Some("M20 6 9 17l-5-5"));
        assert!(super::path("activity-square").is_some()); // Alias
        assert!(super::path("arrow-up-right").is_some());
        assert!(super::table().len() > 2000);
        assert_eq!(
            super::path_or_default("gibt-es-nicht"),
            super::path("sparkles").unwrap()
        );
        // alle Pfade lesbar
        for d in super::table().values().filter(|d| !d.starts_with('=')) {
            assert!(kurbo::BezPath::from_svg(d).is_ok(), "{d}");
        }
    }
}
