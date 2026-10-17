//! `deckwerk render <deck.json>`: Deck ohne Browser nach PNG, PDF und PPTX (Ersatz für `electron . --render`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand, ValueEnum};
use dw_model::{Deck, El, Measured, Scene, format_suffix};
use dw_scene::{FontStore, Theme, render_slide};

#[derive(Parser)]
#[command(name = "deckwerk", version, about = "Deckwerk ohne Browser")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Deck nach PNG, PDF und PPTX exportieren und Autofit je Folie berichten
    Render {
        deck: PathBuf,
        #[arg(long, default_value = "exports")]
        out: PathBuf,
        #[arg(long, value_delimiter = ',', default_value = "png,pdf,pptx")]
        formats: Vec<Fmt>,
        /// zusätzlich Druck-PDF im A-Format (A4-Seiten skaliert, wie PRINT_SIZES)
        #[arg(long)]
        print: Option<PrintSize>,
        /// Beschnitt in mm für das Druck-PDF (0–5)
        #[arg(long, value_parser = parse_bleed)]
        bleed: Option<f32>,
        /// Druck-PDF als PDF/X-4 in CMYK
        #[arg(long)]
        cmyk: bool,
        /// Zeitmessung je Schritt auf stderr
        #[arg(long, short)]
        verbose: bool,
    },
}

#[derive(Clone, Copy, PartialEq, ValueEnum)]
enum Fmt {
    Png,
    Pdf,
    Pptx,
}

#[derive(Clone, Copy, ValueEnum)]
enum PrintSize {
    A2,
    A3,
    A4,
    A5,
    A6,
}

impl PrintSize {
    fn mm(self) -> (f32, f32) {
        match self {
            PrintSize::A2 => (420.0, 594.0),
            PrintSize::A3 => (297.0, 420.0),
            PrintSize::A4 => (210.0, 297.0),
            PrintSize::A5 => (148.0, 210.0),
            PrintSize::A6 => (105.0, 148.0),
        }
    }
    fn id(self) -> &'static str {
        match self {
            PrintSize::A2 => "a2",
            PrintSize::A3 => "a3",
            PrintSize::A4 => "a4",
            PrintSize::A5 => "a5",
            PrintSize::A6 => "a6",
        }
    }
}

fn parse_bleed(s: &str) -> Result<f32, String> {
    match s.parse::<f32>() {
        Ok(v) if (0.0..=5.0).contains(&v) => Ok(v),
        _ => Err("Beschnitt muss zwischen 0 und 5 mm liegen".into()),
    }
}

/// wie engine.ts slug(): Dateiname aus dem Decktitel
fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.to_lowercase().chars() {
        match c {
            'ä' => out.push_str("ae"),
            'ö' => out.push_str("oe"),
            'ü' => out.push_str("ue"),
            'ß' => out.push_str("ss"),
            'a'..='z' | '0'..='9' => out.push(c),
            _ if !out.ends_with('-') => out.push('-'),
            _ => {}
        }
    }
    let t = out.trim_matches('-');
    if t.is_empty() {
        "deck".into()
    } else {
        t.into()
    }
}

fn report(i: usize, layout: &str, m: &Measured) -> String {
    let f = &m.fit;
    let state = if !f.ok {
        let list: Vec<String> = f
            .overflow
            .iter()
            .map(|o| format!("{} +{:.0} px ({:?})", o.slot, o.over_px, o.kind))
            .collect();
        format!("Überlauf {}", list.join(", "))
    } else if f.head + f.body > 0 {
        format!("Autofit {}/{}", f.head, f.body)
    } else {
        "OK".into()
    };
    format!("Folie {} ({layout}): {state}", i + 1)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%'
            && let (Some(h), Some(l)) = (
                b.get(i + 1).and_then(|&c| hex(c)),
                b.get(i + 2).and_then(|&c| hex(c)),
            )
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// ~/Deckwerk/assets bzw. $DECKWERK_HOME/assets
fn asset_dir() -> Option<PathBuf> {
    let home = std::env::var_os("DECKWERK_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| Path::new(&h).join("Deckwerk")))?;
    home.join("assets").canonicalize().ok()
}

/// Bilder der Folie für die PPTX; relative Pfade gelten ab dem Deck-Ordner wie localizeDeck.
/// Nur Dateien unter dem Deck- oder Asset-Ordner: eine fremde deck.json soll keine beliebigen Dateien einbetten.
fn collect_media(els: &[El], roots: &[PathBuf], dir: &Path, media: &mut HashMap<String, Vec<u8>>) {
    for e in els {
        let El::Img(img) = e else { continue };
        if media.contains_key(&img.src) {
            continue;
        }
        let raw = &img.src;
        let p = match raw
            .strip_prefix("asset://")
            .or_else(|| raw.strip_prefix("file://"))
        {
            Some(rest) => percent_decode(rest),
            None => raw.clone(),
        };
        let ext = Path::new(&p)
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        // nur Bilddateien (MEDIA_EXT); SVG kann dw-pptx noch nicht einbetten
        if !["png", "jpg", "jpeg", "gif", "webp"].contains(&ext.as_str()) {
            eprintln!("Warnung: Bild {raw} nicht eingebettet (Format .{ext} nicht unterstützt)");
            continue;
        }
        let Ok(path) = dir.join(&p).canonicalize() else {
            eprintln!("Warnung: Bild {raw} nicht gefunden");
            continue;
        };
        if !roots.iter().any(|r| path.starts_with(r)) {
            eprintln!(
                "Warnung: Bild {raw} liegt außerhalb von Deck- und Asset-Ordner, nicht eingebettet"
            );
            continue;
        }
        match std::fs::read(&path) {
            Ok(bytes) => {
                media.insert(raw.clone(), bytes);
            }
            Err(e) => eprintln!("Warnung: Bild {raw}: {e}"),
        }
    }
}

fn transition_of(deck: &Deck, i: usize) -> Option<&str> {
    let s = deck.slides.get(i)?;
    if i == 0 {
        return None;
    }
    s.extra
        .get("transition")
        .and_then(|v| v.as_str())
        .or(deck.transition.as_deref())
}

#[allow(clippy::too_many_arguments)]
fn render(
    file: &Path,
    out: &Path,
    formats: &[Fmt],
    print: Option<PrintSize>,
    bleed: Option<f32>,
    cmyk: bool,
    verbose: bool,
) -> Result<bool> {
    let clock = Instant::now();
    let step = |name: &str, t: Instant| {
        if verbose {
            eprintln!("⏱ {name}: {} ms", t.elapsed().as_millis());
        }
    };
    let t = Instant::now();
    let text = std::fs::read_to_string(file).with_context(|| format!("{}", file.display()))?;
    let deck: Deck = serde_json::from_str(&text)
        .with_context(|| format!("{}: kein gültiges Deck", file.display()))?;
    let dir = file.parent().unwrap_or(Path::new("."));
    let mut fonts = FontStore::from_dir(&FontStore::default_dir())?;
    step("Deck und Schriften laden", t);

    // Index, Szene, Messung; nicht unterstützte Layouts fallen im Spike heraus
    let mut done: Vec<(usize, Scene, Measured)> = Vec::new();
    let t = Instant::now();
    for (i, s) in deck.slides.iter().enumerate() {
        match render_slide(&deck, i, &mut fonts) {
            Ok((scene, m)) => {
                println!("{}", report(i, &s.layout, &m));
                done.push((i, scene, m));
            }
            Err(e) => eprintln!("Warnung: Folie {} ({}) übersprungen: {e}", i + 1, s.layout),
        }
    }
    step("Folien setzen", t);
    if done.is_empty() {
        eprintln!("Keine Folie renderbar.");
        return Ok(false);
    }

    std::fs::create_dir_all(out)?;
    let name = slug(&deck.title);
    let stem = format!("{name}{}", format_suffix(deck.size));
    let base = out.join(&stem);
    // nicht with_extension: Sondergrößen wie 800.5x600 enthalten Punkte
    let file_of = |ext: &str| out.join(format!("{stem}.{ext}"));
    let hidden = |i: usize| deck.slides[i].hidden == Some(true);
    // Ausgeblendete Folien fehlen in PNG/PDF; PowerPoint behält sie versteckt (engine.ts exportDeck)
    let visible: Vec<&(usize, Scene, Measured)> = done.iter().filter(|d| !hidden(d.0)).collect();
    let want_print = print.is_some() || bleed.is_some() || cmyk;
    if visible.is_empty() && (want_print || formats.iter().any(|f| *f != Fmt::Pptx)) {
        eprintln!(
            "Alle Folien sind ausgeblendet. Blende mindestens eine ein, um nach PNG oder PDF zu exportieren."
        );
    }
    let mut wrote = false;

    if !visible.is_empty() && formats.contains(&Fmt::Png) {
        let t = Instant::now();
        std::fs::create_dir_all(&base)?;
        // Nummer = Position unter den sichtbaren Folien, damit NN.png stabil bleibt, wenn Layouts dazukommen
        for (i, scene, _) in &visible {
            let nn = deck.slides[..*i]
                .iter()
                .filter(|s| s.hidden != Some(true))
                .count()
                + 1;
            let png = dw_raster::render_png(scene, 2.0, &Default::default())?;
            std::fs::write(base.join(format!("{nn:02}.png")), png)?;
        }
        eprintln!("→ png: {}", base.display());
        wrote = true;
        step("PNG", t);
    }
    let scenes = || visible.iter().map(|d| d.1.clone()).collect::<Vec<_>>();
    if !visible.is_empty() && formats.contains(&Fmt::Pdf) {
        let t = Instant::now();
        let f = file_of("pdf");
        std::fs::write(&f, dw_pdf::render_pdf(&scenes(), &Default::default())?)?;
        eprintln!("→ pdf: {}", f.display());
        wrote = true;
        step("PDF", t);
    }
    if !visible.is_empty() && want_print {
        let t = Instant::now();
        let size = deck.size();
        let quer = size.w > size.h;
        let trim = print.map(|p| {
            let (w, h) = p.mm();
            if quer { (h, w) } else { (w, h) }
        });
        let f = match print {
            Some(p) => out.join(format!(
                "{name}-{}{}-druck.pdf",
                p.id(),
                if quer { "-quer" } else { "" }
            )),
            None => out.join(format!("{stem}-druck.pdf")),
        };
        let opts = dw_pdf::PdfOpts {
            bleed_mm: bleed.unwrap_or(3.0),
            trim,
            cmyk,
        };
        std::fs::write(&f, dw_pdf::render_pdf(&scenes(), &opts)?)?;
        eprintln!("→ print: {}", f.display());
        wrote = true;
        step("Druck-PDF", t);
    }
    if formats.contains(&Fmt::Pptx) {
        let t = Instant::now();
        let theme = Theme::by_id(&deck.theme.id).unwrap_or_else(Theme::beratung);
        let mut media = HashMap::new();
        let roots: Vec<PathBuf> = dir.canonicalize().into_iter().chain(asset_dir()).collect();
        let mut slides = Vec::new();
        for (i, scene, m) in &done {
            collect_media(&m.els, &roots, dir, &mut media);
            let morph = [*i, i + 1]
                .iter()
                .any(|&j| transition_of(&deck, j) == Some("morph"));
            let s = &deck.slides[*i];
            slides.push(dw_pptx::PptxSlide {
                measured: m.clone(),
                background_png: Some(dw_raster::render_png(
                    scene,
                    2.0,
                    &dw_raster::RasterOpts {
                        skip_exported: true,
                    },
                )?),
                notes: s
                    .extra
                    .get("notes")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                hidden: hidden(*i),
                morph,
            });
        }
        let bytes = dw_pptx::build_pptx(&dw_pptx::PptxInput {
            title: deck.title.clone(),
            author: "Deckwerk".into(),
            size: deck.size(),
            head_font: theme.head_family.into(),
            body_font: theme.body_family.into(),
            media,
            slides,
        })?;
        let f = file_of("pptx");
        std::fs::write(&f, bytes)?;
        eprintln!("→ pptx: {}", f.display());
        wrote = true;
        step("PPTX", t);
    }
    step("gesamt", clock);
    Ok(wrote)
}

fn main() -> Result<()> {
    let Cli { cmd } = Cli::parse();
    let Cmd::Render {
        deck,
        out,
        formats,
        print,
        bleed,
        cmyk,
        verbose,
    } = cmd;
    if formats.is_empty() {
        bail!("keine Formate");
    }
    if !render(&deck, &out, &formats, print, bleed, cmyk, verbose)? {
        std::process::exit(1);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn slug_like_engine() {
        assert_eq!(
            super::slug("Überblick: Wachstum 2027!"),
            "ueberblick-wachstum-2027"
        );
        assert_eq!(super::slug("Straße"), "strasse");
        assert_eq!(super::slug("../../etc"), "etc");
        assert_eq!(super::slug("—"), "deck");
    }

    #[test]
    fn percent_decode() {
        assert_eq!(super::percent_decode("/a%20b/%C3%BC.png"), "/a b/ü.png");
        assert_eq!(super::percent_decode("50%"), "50%");
    }

    #[test]
    fn media_only_from_deck_or_assets() {
        let tmp = std::env::temp_dir().join(format!("dw-cli-media-{}", std::process::id()));
        let (deck, other) = (tmp.join("deck mit leer"), tmp.join("fremd"));
        std::fs::create_dir_all(&deck).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(deck.join("ü.png"), b"a").unwrap();
        std::fs::write(other.join("x.png"), b"b").unwrap();
        let img = |src: &str| -> super::El {
            serde_json::from_value(serde_json::json!({ "kind": "img", "slot": "photo",
                "box": { "x": 0, "y": 0, "w": 1, "h": 1 }, "src": src, "radius": 0,
                "fit": "cover", "focus": { "x": 0.5, "y": 0.5 } }))
            .unwrap()
        };
        let d = deck.canonicalize().unwrap();
        let enc = format!("asset://{}", d.join("ü.png").display())
            .replace(' ', "%20")
            .replace('ü', "%C3%BC");
        let els = [
            img(&enc),
            img("ü.png"),
            img("../fremd/x.png"),
            img(&format!("file://{}", other.join("x.png").display())),
            img("bild.svg"),
        ];
        let mut media = std::collections::HashMap::new();
        super::collect_media(&els, std::slice::from_ref(&d), &deck, &mut media);
        let mut keys: Vec<&String> = media.keys().collect();
        keys.sort();
        assert_eq!(keys, [&enc, &"ü.png".to_string()]);
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
