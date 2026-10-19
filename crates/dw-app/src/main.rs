//! Deckwerk als native App (Slint): `deckwerk-app [--open <deck.json>] [--shots <ordner>] [--selftest [deck.json]]`

mod animation;
mod chat;
mod editor;
mod export;
mod form;
mod names;
mod settings;
mod podcast;
mod stage;
mod start;
mod textedit;
mod ui;
mod video;

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use dw_daemon::ExportFormat;
use dw_store::{Edition, Store};

slint::include_modules!();

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |name: &str| args.iter().position(|a| a == name).map(|i| args.get(i + 1).filter(|v| !v.starts_with("--")).map(PathBuf::from));
    let store = Store::open(Edition::from_env()).context("Datenordner")?;
    if let Some(deck) = arg("--selftest") {
        return selftest(&store, deck.as_deref());
    }
    // GPU: Slint rendert mit femtovg auf wgpu 30, die Stage zeichnet vello auf demselben Device (dw-canvas).
    // Ohne wgpu (z. B. Xvfb ohne DRI3, `--cpu`, DW_NO_GPU): Software-Renderer, Stage über dw-raster.
    let mut gpu = !args.iter().any(|a| a == "--cpu") && std::env::var_os("DW_NO_GPU").is_none();
    if gpu
        && let Err(e) = slint::BackendSelector::new()
            .backend_name("winit".into())
            .require_wgpu_30(slint::wgpu_30::WGPUConfiguration::Automatic({
                let mut w = slint::wgpu_30::WGPUSettings::default();
                w.device_required_limits = dw_canvas::required_limits();
                w
            }))
            .select()
    {
        eprintln!("Kein wgpu ({e}), Software-Renderer");
        gpu = false;
    }
    if !gpu {
        slint::BackendSelector::new().backend_name("winit".into()).renderer_name("software".into()).select().context("Slint-Backend")?;
    }
    match ui::run(store, arg("--open").flatten(), arg("--shots").flatten()) {
        // wgpu fand kein Gerät für das Fenster: die Plattform lässt sich nicht neu wählen, also neu starten
        Err(e) if gpu => {
            eprintln!("GPU-Start fehlgeschlagen ({e}), neu mit --cpu");
            let status = std::process::Command::new(std::env::current_exe()?).args(&args).arg("--cpu").status()?;
            std::process::exit(status.code().unwrap_or(1));
        }
        r => r,
    }
}

/// Öffnen → Feld ändern → Speichern → Export PDF, über dieselben Funktionen wie die Oberfläche, ohne Fenster.
fn selftest(store: &Store, deck: Option<&Path>) -> Result<()> {
    let path = match deck {
        Some(p) => p.to_path_buf(),
        None => store.recent(1).into_iter().next().context("kein Deck im Datenordner")?.path,
    };
    let mut ed = editor::Editor::new(store.load_deck(&path).map_err(|e| anyhow::anyhow!("{e}"))?, Some(path.clone()));
    println!("geöffnet: {} ({} Folien)", path.display(), ed.deck.slides.len());

    // erste Folie mit Textfeld, die dw-scene rendern kann
    let ported = (0..ed.deck.slides.len()).find(|&i| editor::sample(&ed.deck.slides[i].layout).is_some());
    ed.select(ported.context("keine portierte Folie im Deck")?);
    let row = ed.rows().into_iter().find(|r| r.kind == form::Kind::Text).context("kein Textfeld")?;
    let text = format!("Selbsttest {}", std::process::id());
    if !ed.set_field(&row.path, row.kind, &text) {
        bail!("Feld {} unverändert", row.path);
    }
    println!("Feld {} auf Folie {} = {text:?}", row.path, ed.index + 1);

    let mut r = stage::CpuRenderer::new();
    let out = stage::StageRenderer::render(&mut r, &ed.deck, ed.index, 0.5, true);
    let m = out.measured.with_context(|| format!("Stage: {:?}", out.error))?;
    println!("Stage {}×{} · Autofit ok={} · {} Lint-Hinweise", out.pixels.w, out.pixels.h, m.fit.ok, out.lint.len());

    let saved = ed.save(store).map_err(anyhow::Error::msg)?;
    let back = store.load_deck(&saved).map_err(|e| anyhow::anyhow!("{e}"))?;
    if back.slides[ed.index].content.pointer(&row.path).and_then(|v| v.as_str()) != Some(text.as_str()) {
        bail!("gespeichertes Deck enthält die Änderung nicht");
    }
    println!("gespeichert: {}", saved.display());

    let files = export::run(store, &saved, vec![ExportFormat::Pdf], None, &|p| println!("Export {:.0} %", p * 100.0))
        .map_err(anyhow::Error::msg)?;
    let pdf = files.iter().find(|f| f.extension().is_some_and(|x| x == "pdf")).context("keine PDF-Datei")?;
    let head = std::fs::read(pdf)?;
    if !head.starts_with(b"%PDF") {
        bail!("{} ist kein PDF", pdf.display());
    }
    println!("PDF: {} ({} KB)", pdf.display(), head.len() / 1024);
    println!("Selbsttest ok");
    Ok(())
}
