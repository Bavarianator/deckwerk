//! Editor-Logik ohne GUI: Rich-Text-Editor auf parley (mit IME-Preedit), Stage-Logik (Treffer, Auswahl,
//! Einrasten, Griffe, Zoom) und Patch-Undo für das Deck. Wird von dw-app (Slint) benutzt und ist ohne
//! Fenster testbar.

pub mod editor;
pub mod history;
pub mod rich;
pub mod stage;

pub use editor::{Editor, Move, TextStyle};
pub use history::History;
pub use parley::{Alignment, FontContext};
pub use rich::{Attrs, RichText, Serialized};

/// FontContext nur mit den übergebenen Schriftdateien (keine Systemschriften, wie dw-scene).
pub fn font_context(fonts: impl IntoIterator<Item = Vec<u8>>) -> FontContext {
    use parley::fontique::{Blob, Collection, CollectionOptions};
    let mut fcx = FontContext {
        collection: Collection::new(CollectionOptions {
            shared: false,
            system_fonts: false,
        }),
        source_cache: Default::default(),
    };
    for bytes in fonts {
        fcx.collection
            .register_fonts(Blob::new(std::sync::Arc::new(bytes)), None);
    }
    fcx
}

/// Alle .ttf/.otf eines Verzeichnisses.
pub fn font_context_from_dir(dir: &std::path::Path) -> std::io::Result<FontContext> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|x| x.to_str())
                .is_some_and(|x| x.eq_ignore_ascii_case("ttf") || x.eq_ignore_ascii_case("otf"))
        })
        .collect();
    paths.sort();
    Ok(font_context(
        paths.iter().filter_map(|p| std::fs::read(p).ok()),
    ))
}

#[cfg(test)]
pub(crate) fn fonts_for_tests() -> FontContext {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/fonts");
    font_context(
        [
            "Archivo-Regular.ttf",
            "Archivo-Bold.ttf",
            "Archivo-Italic.ttf",
        ]
        .map(|f| std::fs::read(dir.join(f)).expect("Testschrift")),
    )
}
