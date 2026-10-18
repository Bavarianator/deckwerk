//! Altes Spike-Theme, nur noch für Aufrufer, die die Schriftfamilien brauchen (dw-cli → PPTX).
//! Werte kommen aus dw-theme (resolve_theme); Layouts nutzen `dw_theme::Tokens` direkt.

use dw_model::ThemeRef;

#[derive(Debug, Clone)]
pub struct Theme {
    pub id: String,
    /// PPTX-Name der Titelschrift
    pub head_family: String,
    /// PPTX-Name der Textschrift
    pub body_family: String,
}

impl Theme {
    fn of(t: &dw_theme::Theme) -> Theme {
        Theme {
            id: t.id.clone(),
            head_family: t.head.font.pptx.clone(),
            body_family: t.body.pptx.clone(),
        }
    }

    pub fn beratung() -> Theme {
        Theme::of(dw_theme::theme("beratung").expect("Katalog-Theme beratung"))
    }

    /// Katalog-Theme nach ID.
    pub fn by_id(id: &str) -> Option<Theme> {
        dw_theme::theme(id).map(Theme::of)
    }

    /// Aufgelöstes Theme eines Decks (Brand, Schriften, eigenes Theme).
    pub fn resolve(r: &ThemeRef) -> Theme {
        Theme::of(&dw_theme::resolve_theme(r, None))
    }
}
