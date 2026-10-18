//! Export-Job: dieselben Aufrufe wie dw-cli `render` (dw-scene → dw-raster/dw-pdf/dw-pptx).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use dw_model::{Deck, El, Measured, Scene, format_suffix};
use dw_scene::Theme;
use dw_store::Store;

use crate::ExportFormat;
use crate::jobs::{Ctl, Outcome};

pub type RenderFn<'a> = dyn Fn(&Deck, usize) -> Result<(Scene, Measured), String> + 'a;

/// `out` und `deck_dir` hat der Aufrufer mit dw-store geprüft; geschrieben wird nur über `write_atomic`.
/// Ausgeblendete Folien fehlen in PNG/PDF, PowerPoint behält sie versteckt (engine.ts exportDeck).
pub fn run(
    store: &Store,
    deck: &Deck,
    deck_dir: &Path,
    formats: &[ExportFormat],
    out: &Path,
    render: &RenderFn<'_>,
    ctl: &Ctl,
) -> Outcome {
    let mut warnings = vec![];
    let mut done = vec![];
    // Schritte für den Fortschritt: je Folie setzen + je Format
    let total = (deck.slides.len() + formats.len()).max(1) as f32;
    let mut step = 0.0;
    macro_rules! check {
        () => {
            if let Err(s) = ctl.check() {
                return Outcome::Stopped(s);
            }
            step += 1.0;
            ctl.progress(step / total);
        };
    }
    for i in 0..deck.slides.len() {
        match render(deck, i) {
            Ok((scene, m)) => done.push((i, scene, m)),
            Err(e) => warnings.push(format!(
                "Folie {} ({}) übersprungen: {e}",
                i + 1,
                deck.slides[i].layout
            )),
        }
        check!();
    }
    if done.is_empty() {
        return Outcome::Failed("Keine Folie renderbar.".into());
    }
    let stem = format!(
        "{}{}",
        dw_store::file_slug(&deck.title),
        format_suffix(deck.size)
    );
    let hidden = |i: usize| deck.slides[i].hidden == Some(true);
    let visible: Vec<&(usize, Scene, Measured)> = done.iter().filter(|d| !hidden(d.0)).collect();
    let mut files = vec![];
    for f in formats {
        let r = match f {
            ExportFormat::Png | ExportFormat::Pdf if visible.is_empty() => {
                Err("Alle Folien sind ausgeblendet. Blende mindestens eine ein, um nach PNG oder PDF zu exportieren.".into())
            }
            ExportFormat::Png => png(store, deck, &visible, &out.join(&stem), ctl),
            ExportFormat::Pdf => {
                let scenes: Vec<Scene> = visible.iter().map(|d| d.1.clone()).collect();
                let file = out.join(format!("{stem}.pdf"));
                dw_pdf::render_pdf(&scenes, &Default::default())
                    .map_err(|e| e.to_string())
                    .and_then(|b| dw_store::write_atomic(&file, &b).map_err(|e| e.to_string()))
                    .map(|_| file)
            }
            ExportFormat::Pptx => {
                let file = out.join(format!("{stem}.pptx"));
                pptx(store, deck, deck_dir, &done, &mut warnings)
                    .and_then(|b| dw_store::write_atomic(&file, &b).map_err(|e| e.to_string()))
                    .map(|_| file)
            }
        };
        match r {
            Ok(p) => files.push(p),
            Err(e) => return Outcome::Failed(e),
        }
        check!();
    }
    Outcome::Done(files, warnings)
}

/// <out>/<stem>/NN.png; Nummer = Position unter den sichtbaren Folien wie dw-cli
fn png(
    store: &Store,
    deck: &Deck,
    visible: &[&(usize, Scene, Measured)],
    dir: &Path,
    ctl: &Ctl,
) -> Result<PathBuf, String> {
    // prüft auch, dass <stem>/ kein Symlink nach draußen ist
    let dir = &store.export_dir(dir).map_err(|e| e.to_string())?;
    for (i, scene, _) in visible {
        if ctl.check().is_err() {
            break; // der Aufrufer meldet den Abbruch
        }
        let nn = deck.slides[..*i]
            .iter()
            .filter(|s| s.hidden != Some(true))
            .count()
            + 1;
        let bytes =
            dw_raster::render_png(scene, 2.0, &Default::default()).map_err(|e| e.to_string())?;
        dw_store::write_atomic(&dir.join(format!("{nn:02}.png")), &bytes)
            .map_err(|e| e.to_string())?;
    }
    Ok(dir.to_path_buf())
}

fn transition_of(deck: &Deck, i: usize) -> Option<String> {
    let s = deck.slides.get(i)?;
    if i == 0 {
        return None;
    }
    s.extra
        .get("transition")
        .and_then(|v| v.as_str())
        .or(deck.transition.as_deref())
        .map(str::to_string)
}

fn pptx(
    store: &Store,
    deck: &Deck,
    deck_dir: &Path,
    done: &[(usize, Scene, Measured)],
    warnings: &mut Vec<String>,
) -> Result<Vec<u8>, String> {
    let theme = Theme::by_id(&deck.theme.id).unwrap_or_else(Theme::beratung);
    let mut media = HashMap::new();
    let mut slides = vec![];
    let mut opts = dw_pptx::PptxOpts {
        auto: deck.mode.as_deref() == Some("auto"),
        ..Default::default()
    };
    for (i, scene, m) in done {
        for e in &m.els {
            let El::Img(img) = e else { continue };
            if media.contains_key(&img.src) {
                continue;
            }
            // SVG kann dw-pptx noch nicht einbetten
            let ext = Path::new(&img.src)
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !["png", "jpg", "jpeg", "gif", "webp"].contains(&ext.as_str()) {
                warnings.push(format!(
                    "Bild {} nicht eingebettet (Format .{ext})",
                    img.src
                ));
                continue;
            }
            match store
                .resolve_media(&img.src, deck_dir)
                .and_then(|p| std::fs::read(p).map_err(|e| e.to_string()))
            {
                Ok(b) => {
                    media.insert(img.src.clone(), b);
                }
                Err(e) => warnings.push(format!("Bild nicht eingebettet: {e}")),
            }
        }
        let s = &deck.slides[*i];
        let morph = [*i, i + 1]
            .iter()
            .any(|&j| transition_of(deck, j).as_deref() == Some("morph"));
        slides.push(dw_pptx::PptxSlide {
            measured: m.clone(),
            background_png: Some(
                dw_raster::render_png(
                    scene,
                    2.0,
                    &dw_raster::RasterOpts {
                        skip_exported: true,
                    },
                )
                .map_err(|e| e.to_string())?,
            ),
            notes: s
                .extra
                .get("notes")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            hidden: s.hidden == Some(true),
            morph,
        });
        opts.slides.push(dw_pptx::SlideOpts {
            transition: transition_of(deck, *i),
            ..Default::default()
        });
    }
    let out = dw_pptx::build_pptx_with(
        &dw_pptx::PptxInput {
            title: deck.title.clone(),
            author: "Deckwerk".into(),
            size: deck.size(),
            head_font: theme.head_family,
            body_font: theme.body_family,
            media,
            slides,
        },
        &opts,
    )
    .map_err(|e| e.to_string())?;
    warnings.extend(out.warnings);
    Ok(out.bytes)
}
