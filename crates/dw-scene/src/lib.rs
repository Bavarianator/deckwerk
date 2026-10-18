//! Folien-Engine ohne Browser: Layouts als Box-Bäume (taffy), Text mit parley, Autofit wie measure.ts.
//! Ergebnis je Folie: `Scene` zum Malen und `Measured` für Lint und PPTX.
//!
//! Aufbau: `blocks` (Rahmen, Kopf, Fußzeile, Punkte, Stil-Helfer), `decor` (Hintergrundebene), `layouts/<id>.rs`
//! (je Layout eine Datei, Registry in `layouts/mod.rs`), `text` + `wrap` (Satz, balance/pretty), `tree` (taffy → Szene).

mod blocks;
mod chart;
mod decor;
mod fonts;
mod icons;
mod layouts;
pub mod samples;
mod table;
mod text;
pub mod theme;
mod tree;
mod wrap;

use dw_model::{Deck, Fit, Measured, Scene, profile_of};
use dw_theme::{HeroTone, Tokens, Tone, font_factor, resolve_theme, with_tone};

pub use blocks::FrameId;
pub use fonts::FontStore;
pub use layouts::{Def, LAYOUTS, Layout, all_layouts};
pub use theme::Theme;
pub use tree::SlotLines;

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

/// (Titelstufe, Textstufe), billigste zuerst; bei Gleichstand erst den Text verkleinern (measure.ts:7).
pub fn combos() -> [(u32, u32); 16] {
    let mut c: [(u32, u32); 16] = std::array::from_fn(|i| ((i >> 2) as u32, (i & 3) as u32));
    c.sort_by_key(|&(h, b)| (h + b, h));
    c
}

/// Rendert eine Folie: Autofit über die 16 Stufen, dann Szene und gemessene Elemente.
pub fn render_slide(
    deck: &Deck,
    index: usize,
    fonts: &mut FontStore,
) -> Result<(Scene, Measured), Error> {
    render_slide_lines(deck, index, fonts).map(|(s, m, _)| (s, m))
}

/// Wie `render_slide`, dazu die Zeilentexte je Text-Slot (Umbruchstellen prüfen).
pub fn render_slide_lines(
    deck: &Deck,
    index: usize,
    fonts: &mut FontStore,
) -> Result<(Scene, Measured, Vec<SlotLines>), Error> {
    let slide = deck.slides.get(index).ok_or(Error::NoSlide(index))?;
    let def =
        layouts::get(&slide.layout).ok_or_else(|| Error::UnknownLayout(slide.layout.clone()))?;
    let size = deck.size();
    let (w, h) = (size.w as f32, size.h as f32);
    let profile = profile_of(deck.size);

    // Folien-Ton: Folie vor heroTone (Titel/Schluss) vor Layout-Standard (sectionTone des Themes geht vor)
    let base = resolve_theme(&deck.theme, None);
    let hero = matches!(slide.layout.as_str(), "cover" | "closing")
        .then_some(base.hero_tone)
        .flatten()
        .and_then(|t| match t {
            HeroTone::Field => Some(Tone::Accent),
            HeroTone::Invert => Some(Tone::Invert),
            HeroTone::Normal => None,
        });
    let tone = slide
        .tone
        .as_deref()
        .and_then(|t| serde_json::from_value(serde_json::Value::from(t)).ok())
        .or(hero)
        .or(def.tone.map(|t| base.section_tone.unwrap_or(t)));
    let theme = match tone {
        Some(t) => with_tone(&base, t),
        None => base,
    };
    let tk = Tokens::new(&theme, w as f64, h as f64);
    let frame = slide
        .frame
        .as_deref()
        .filter(|f| def.frames.contains(f))
        .and_then(FrameId::parse)
        .unwrap_or(FrameId::Top);
    let cx0 = blocks::Cx {
        deck,
        index,
        theme: &theme,
        tk: &tk,
        pal: blocks::Pal {
            text: tk.text,
            muted: tk.muted,
            accent: tk.accent,
        },
        head: 0,
        body: 0,
        k: font_factor(profile, w as f64),
        w,
        h,
        frame,
        profile,
        tall: w / h <= 1.2,
        narrow: w <= 800.,
    };
    let run = |head: u32, body: u32, fonts: &mut FontStore| -> Result<tree::Laid, Error> {
        let cx = blocks::Cx {
            head: head as usize,
            body: body as usize,
            ..cx0.clone()
        };
        let root =
            layouts::build_slide(&cx, &slide.layout, slide.variant.as_deref(), &slide.content)?;
        Ok(tree::lay(root, fonts, w, h, tk.bg))
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
        background: tree::color(tk.bg),
        nodes: laid.nodes,
    };
    Ok((scene, Measured { els: laid.els, fit }, laid.lines))
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
