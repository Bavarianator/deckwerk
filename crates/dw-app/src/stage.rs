//! Folien in Bilder: `StageRenderer` setzt die Folie (dw-scene) und rastert sie auf Wunsch (dw-raster, CPU);
//! `Worker` führt das im Hintergrund-Thread aus, rendert nur geänderte Folien und hängt den Lint an. Mit GPU zeichnet
//! die Oberfläche die Szene selbst über dw-canvas (ui.rs), der Worker liefert dann nur Szene und Messung.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

use dw_model::{Deck, Measured, Scene};
use dw_scene::FontStore;

/// RGBA-Pixel, Zeile für Zeile
#[derive(Clone)]
pub struct Pixels {
    pub w: u32,
    pub h: u32,
    pub rgba: Arc<Vec<u8>>,
}

#[derive(Clone)]
pub struct Rendered {
    /// leer (1×1), wenn nicht gerastert wurde
    pub pixels: Pixels,
    /// gesetzte Folie für den GPU-Weg
    pub scene: Option<Arc<Scene>>,
    /// None = Layout (noch) nicht renderbar; das Bild ist dann ein ruhiger Platzhalter
    pub measured: Option<Measured>,
    pub error: Option<String>,
    pub lint: Vec<dw_lint::Issue>,
}

/// Setzt eine Folie und rastert sie in einer Skalierung (1 = Folienpixel), `raster = false`: nur Szene und Messung.
/// Läuft im Hintergrund-Thread.
pub trait StageRenderer: Send {
    fn render(&mut self, deck: &Deck, index: usize, scale: f32, raster: bool) -> Rendered;
}

/// CPU-Weg: dw-scene setzt, dw-raster rastert.
pub struct CpuRenderer {
    fonts: FontStore,
}

impl CpuRenderer {
    pub fn new() -> CpuRenderer {
        let fonts = FontStore::from_dir(&FontStore::default_dir()).unwrap_or_else(|e| {
            eprintln!("Schriften: {e}");
            FontStore::new()
        });
        CpuRenderer { fonts }
    }
}

/// Platzhalter in der Folienfläche (Grund wie --panel-2 der Oberfläche)
pub fn placeholder(w: f64, h: f64, scale: f32) -> Pixels {
    let (w, h) = (((w as f32) * scale).round().max(1.0) as u32, ((h as f32) * scale).round().max(1.0) as u32);
    let px = [0xef, 0xef, 0xf1, 0xff];
    Pixels { w, h, rgba: Arc::new(px.iter().copied().cycle().take((w * h * 4) as usize).collect()) }
}

impl StageRenderer for CpuRenderer {
    fn render(&mut self, deck: &Deck, index: usize, scale: f32, raster: bool) -> Rendered {
        let size = deck.size();
        let r = dw_scene::render_slide(deck, index, &mut self.fonts).map_err(|e| e.to_string()).and_then(|(scene, m)| {
            let pixels = if raster {
                let img = dw_raster::render_rgba(&scene, scale, &Default::default()).map_err(|e| e.to_string())?;
                Pixels { w: img.width(), h: img.height(), rgba: Arc::new(img.into_raw()) }
            } else {
                placeholder(1.0, 1.0, 1.0)
            };
            Ok((pixels, scene, m))
        });
        match r {
            Ok((pixels, scene, m)) => Rendered { lint: lint(deck, index, &m), pixels, scene: Some(Arc::new(scene)), measured: Some(m), error: None },
            Err(e) => Rendered {
                pixels: placeholder(size.w, size.h, scale),
                scene: None,
                measured: None,
                error: Some(e),
                lint: vec![],
            },
        }
    }
}

/// Lint einer Folie. Schema-Prüfung und Satzspiegel fehlen in Rust noch: Inhalt gilt als gültig.
pub fn lint(deck: &Deck, index: usize, m: &Measured) -> Vec<dw_lint::Issue> {
    let layouts: Vec<dw_lint::LayoutInfo> = dw_scene::all_layouts()
        .map(|(id, _, def)| dw_lint::LayoutInfo {
            id: id.to_string(),
            sizes: None,
            frames: !def.frames.is_empty(),
            default_build: None,
        })
        .collect();
    let known = |id: &str| layouts.iter().any(|l| l.id == id);
    let schema = |id: &str, _: &serde_json::Value| known(id).then(Vec::new);
    let ctx = dw_lint::LintCtx { layouts: &layouts, theme: Default::default(), schema: &schema, film: None };
    dw_lint::lint_slide(deck, index, m, &ctx)
}

/// Wofür ein Auftrag ist; je Ziel zählt nur der neueste Auftrag.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Target {
    Stage,
    Strip(usize),
    Present(usize),
    /// Vorschaubild auf der Startseite, als PNG im Cache abgelegt
    Start(PathBuf),
    /// Look: große Vorschau bzw. Theme-Leiste (Index im Katalog)
    LookPreview,
    Look(usize),
}

pub struct Job {
    pub target: Target,
    pub deck: Arc<Deck>,
    pub index: usize,
    pub scale: f32,
    /// false: nur setzen (GPU zeichnet)
    pub raster: bool,
    /// zusätzlich als PNG schreiben (Startseiten-Cache)
    pub save: Option<PathBuf>,
}

pub struct Done {
    pub target: Target,
    pub index: usize,
    /// Hash der Folie: Stage verwirft veraltete Ergebnisse
    pub key: u64,
    pub out: Rendered,
}

/// Was das Bild einer Folie bestimmt: Theme, Größe, Titel (Fußzeile), Position, Anzahl und die Folie selbst.
pub fn slide_key(deck: &Deck, index: usize, scale: f32) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let slide = deck.slides.get(index);
    serde_json::to_string(&(&deck.theme, deck.size, &deck.title, index, deck.slides.len(), slide))
        .unwrap_or_default()
        .hash(&mut h);
    scale.to_bits().hash(&mut h);
    h.finish()
}

const CACHE_MAX: usize = 96;

/// Render-Thread mit Ergebnis-Cache. `done` wird im Thread aufgerufen.
pub struct Worker {
    tx: Sender<Job>,
}

impl Worker {
    pub fn start(mut r: Box<dyn StageRenderer>, done: impl Fn(Done) + Send + 'static) -> Worker {
        let (tx, rx) = channel::<Job>();
        std::thread::Builder::new()
            .name("render".into())
            .spawn(move || run(&mut *r, &rx, &done))
            .expect("Render-Thread");
        Worker { tx }
    }

    pub fn send(&self, job: Job) {
        let _ = self.tx.send(job);
    }
}

fn run(r: &mut dyn StageRenderer, rx: &Receiver<Job>, done: &dyn Fn(Done)) {
    // ponytail: Cache leert sich ganz, wenn er voll ist; LRU, falls das beim Blättern stört
    let mut cache: HashMap<u64, Rendered> = HashMap::new();
    while let Ok(first) = rx.recv() {
        let mut jobs = vec![first];
        jobs.extend(rx.try_iter());
        // neuester Auftrag je Ziel; Stage zuerst, damit die große Ansicht nicht auf Vorschaubilder wartet
        let mut latest: Vec<Job> = vec![];
        for j in jobs {
            latest.retain(|l| l.target != j.target);
            latest.push(j);
        }
        latest.sort_by_key(|j| j.target != Target::Stage);
        for job in latest {
            let key = slide_key(&job.deck, job.index, job.scale);
            let ck = key ^ u64::from(job.raster);
            let out = match cache.get(&ck) {
                Some(o) => o.clone(),
                None => {
                    let o = r.render(&job.deck, job.index, job.scale, job.raster);
                    if cache.len() >= CACHE_MAX {
                        cache.clear();
                    }
                    cache.insert(ck, o.clone());
                    o
                }
            };
            if let Some(p) = &job.save
                && out.measured.is_some()
            {
                save_png(p, &out.pixels);
            }
            done(Done { target: job.target, index: job.index, key, out });
        }
    }
}

fn save_png(p: &std::path::Path, px: &Pixels) {
    let Some(img) = image::RgbaImage::from_raw(px.w, px.h, px.rgba.to_vec()) else { return };
    let mut bytes = vec![];
    if img.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).is_ok() {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = dw_store::write_atomic(p, &bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Count(Arc<Mutex<usize>>);
    impl StageRenderer for Count {
        fn render(&mut self, deck: &Deck, _: usize, scale: f32, _: bool) -> Rendered {
            *self.0.lock().unwrap() += 1;
            Rendered { pixels: placeholder(deck.size().w, deck.size().h, scale), scene: None, measured: None, error: None, lint: vec![] }
        }
    }

    #[test]
    fn renders_only_changed_slides() {
        let n = Arc::new(Mutex::new(0));
        let (tx, rx) = channel();
        let w = Worker::start(Box::new(Count(n.clone())), move |d| tx.send(d.key).unwrap());
        let mut deck = crate::editor::new_deck("A", "16:9");
        let job = |d: &Deck| Job { target: Target::Strip(0), deck: Arc::new(d.clone()), index: 0, scale: 0.1, raster: true, save: None };
        w.send(job(&deck));
        let k1 = rx.recv().unwrap();
        w.send(job(&deck));
        assert_eq!(rx.recv().unwrap(), k1);
        assert_eq!(*n.lock().unwrap(), 1);
        deck.slides[0].content["title"] = "B".into();
        w.send(job(&deck));
        assert_ne!(rx.recv().unwrap(), k1);
        assert_eq!(*n.lock().unwrap(), 2);
    }

    #[test]
    fn cpu_renders_core_layout_and_placeholder() {
        let mut r = CpuRenderer::new();
        let mut deck = crate::editor::new_deck("Hallo", "16:9");
        let ok = r.render(&deck, 0, 0.1, true);
        assert!(ok.measured.is_some(), "{:?}", ok.error);
        assert_eq!((ok.pixels.w, ok.pixels.h), (128, 72));
        deck.slides[0].layout = "gibt-es-nicht".into();
        let ph = r.render(&deck, 0, 0.1, true);
        assert!(ph.measured.is_none() && ph.error.is_some());
        assert_eq!(ph.pixels.rgba.len(), 128 * 72 * 4);
    }
}
