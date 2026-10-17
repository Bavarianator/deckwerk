//! Folien-Engine ohne Browser: Layouts als Box-Bäume (taffy), Text mit parley, Autofit wie measure.ts.
//! Ergebnis je Folie: `Scene` zum Malen und `Measured` für Lint und PPTX.

mod fonts;
mod layouts;
pub mod samples;
mod text;
pub mod theme;
mod tree;

use dw_model::{Deck, Fit, Measured, Profile, Scene, profile_of};

pub use fonts::FontStore;
pub use layouts::LAYOUTS;
pub use theme::Theme;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("keine Folie {0}")]
    NoSlide(usize),
    #[error("unbekanntes Layout: {0}")]
    UnknownLayout(String),
    #[error("Inhalt: {0}")]
    Content(String),
    #[error("Schrift: {0}")]
    Font(String),
}

// Folien, die absichtlich luftig sind, haben keine Fußzeile (lint.ts AIRY)
const AIRY: &[&str] = &[
    "cover",
    "section",
    "statement",
    "big-number",
    "photo",
    "quote",
    "closing",
    "blank",
    "clip",
];

/// (Titelstufe, Textstufe), billigste zuerst; bei Gleichstand erst den Text verkleinern (measure.ts:7).
pub fn combos() -> [(u32, u32); 16] {
    let mut c: [(u32, u32); 16] = std::array::from_fn(|i| ((i >> 2) as u32, (i & 3) as u32));
    c.sort_by_key(|&(h, b)| (h + b, h));
    c
}

/// Fußzeile wie Frame (slide.tsx): Kapitel links, „3 / 12“ rechts; A4 mit Decktitel und Seite.
fn footer_of(deck: &Deck, index: usize) -> Option<layouts::FooterInfo> {
    let slide = &deck.slides[index];
    let doc = profile_of(deck.size) == Profile::Doc;
    let nav = !doc && deck.extra.get("style").and_then(|v| v.as_str()) != Some("mutig");
    if !doc && AIRY.contains(&slide.layout.as_str()) {
        return None;
    }
    let left = if doc {
        Some(deck.title.clone())
    } else if nav {
        deck.slides[..index]
            .iter()
            .rev()
            .find(|s| s.layout == "section")
            .and_then(|s| s.content.get("title")?.as_str().map(str::to_string))
    } else {
        None
    };
    let page = if doc {
        Some((index + 1).to_string())
    } else if nav {
        Some(format!("{} / {}", index + 1, deck.slides.len()))
    } else {
        None
    };
    (left.is_some() || page.is_some()).then_some(layouts::FooterInfo { left, page })
}

/// Rendert eine Folie: Autofit über die 16 Stufen, dann Szene und gemessene Elemente.
/// Unbekannte Themes fallen wie in resolveTheme auf das erste Katalog-Theme (beratung) zurück.
pub fn render_slide(
    deck: &Deck,
    index: usize,
    fonts: &mut FontStore,
) -> Result<(Scene, Measured), Error> {
    let slide = deck.slides.get(index).ok_or(Error::NoSlide(index))?;
    let theme = Theme::by_id(&deck.theme.id).unwrap_or_else(Theme::beratung);
    let size = deck.size();
    let (w, h) = (size.w as f32, size.h as f32);
    let k = theme::font_factor(profile_of(deck.size), w);
    let footer = footer_of(deck, index);
    let run = |head: u32, body: u32, fonts: &mut FontStore| -> Result<tree::Laid, Error> {
        let cx = layouts::Cx {
            theme: &theme,
            head,
            body,
            k,
            w,
            h,
        };
        let root = layouts::build(
            &cx,
            &slide.layout,
            slide.variant.as_deref(),
            &slide.content,
            footer.as_ref(),
        )?;
        Ok(tree::lay(root, fonts, w, h, theme.bg))
    };
    let mut done = None;
    for (head, body) in combos() {
        let laid = run(head, body, fonts)?;
        if laid.overflow.is_empty() {
            done = Some((
                laid,
                Fit {
                    ok: true,
                    head,
                    body,
                    overflow: vec![],
                },
            ));
            break;
        }
    }
    let (laid, fit) = match done {
        Some(d) => d,
        None => {
            let laid = run(3, 3, fonts)?;
            let overflow = laid.overflow.clone();
            (
                laid,
                Fit {
                    ok: false,
                    head: 3,
                    body: 3,
                    overflow,
                },
            )
        }
    };
    let scene = Scene {
        width: w,
        height: h,
        background: tree::color(theme.bg),
        nodes: laid.nodes,
    };
    Ok((scene, Measured { els: laid.els, fit }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn combos_order() {
        let c = super::combos();
        assert_eq!(&c[..5], &[(0, 0), (0, 1), (1, 0), (0, 2), (1, 1)]);
        assert_eq!(c[15], (3, 3));
    }
}
