//! Verdrahtung Slint ↔ Zustand: Start, Editor, Look, Einstellungen, Präsentieren, Chat.
//! Logik liegt in editor/form/start/stage/export; hier nur Abbildung auf die Oberfläche.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dw_daemon::ExportFormat;
use dw_model::Deck;
use dw_store::{Edition, RecentDeck, Store};
use slint::{ComponentHandle, Image, Model, ModelRc, Rgba8Pixel, SharedPixelBuffer, SharedString, Timer, TimerMode, VecModel};

use crate::chat::{ChatBackend, ChatReply, Offline};
use crate::editor::{self, Editor};
use crate::form::Row;
use crate::names::layout_name;
use crate::stage::{self, CpuRenderer, Done, Job, Pixels, Target, Worker};
use crate::start;
use crate::textedit::{self, Edit, KeyOut};
use crate::{AppWindow, ChatMsg, DeckCard, FormRow, PresentWindow, SRect, ThemeCard, Thumb};
use slint::winit_030::{EventResult, WinitWindowAccessor, winit};

const STAGE_SCALE: f32 = 1.0;
const AUTOSAVE: Duration = Duration::from_millis(1500);
const RERENDER: Duration = Duration::from_millis(120);
const STATUS: Duration = Duration::from_secs(4);
const FRAMES: &[(&str, &str)] = &[("top", "Titel oben"), ("split", "Titel links auf Farbfläche"), ("band", "Titel im Farbband"), ("center", "Zentriert")];
const TONES: [&str; 3] = ["normal", "accent", "invert"];
const DECORS: [&str; 7] = ["none", "blobs", "glow", "rings", "grid", "stripe", "dots"];
const MODELS: [&str; 4] = ["Auto", "Opus", "Sonnet", "Haiku"];

thread_local! {
    static APP: RefCell<Option<App>> = const { RefCell::new(None) };
}

fn with_app(f: impl FnOnce(&mut App)) {
    // try_with/try_borrow_mut: Rückrufe beim Abbau (Fenster, Timer) und verschachtelte Aufrufe laufen ins Leere
    let _ = APP.try_with(|a| {
        if let Ok(mut a) = a.try_borrow_mut()
            && let Some(a) = a.as_mut()
        {
            f(a)
        }
    });
}

fn image(p: &Pixels) -> Image {
    Image::from_rgba8(SharedPixelBuffer::<Rgba8Pixel>::clone_from_slice(&p.rgba, p.w, p.h))
}

fn model<T: Clone + 'static>(v: Vec<T>) -> ModelRc<T> {
    ModelRc::new(VecModel::from(v))
}

fn ss(s: impl AsRef<str>) -> SharedString {
    s.as_ref().into()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn ratio(d: &Deck) -> f32 {
    let s = d.size();
    (s.h / s.w) as f32
}

/// Filmstreifen: 160 px breit, doppelt aufgelöst für scharfe Vorschauen
fn thumb_scale(d: &Deck) -> f32 {
    320.0 / d.size().w as f32
}

/// Ein Deck auf der Startseite (eigenes oder Vorlage)
struct Entry {
    path: PathBuf,
    deck: Deck,
    sub: String,
    image: Option<Image>,
}

struct Present {
    win: PresentWindow,
    order: Vec<usize>,
    pos: usize,
    imgs: Vec<Option<Image>>,
}

struct Look {
    orig: String,
    sel: usize,
    imgs: Vec<Option<Image>>,
}

pub struct App {
    ui: slint::Weak<AppWindow>,
    store: Store,
    recent: Vec<Entry>,
    templates: Vec<Entry>,
    shown: Vec<usize>,
    shown_tpl: Vec<usize>,
    all: bool,
    shelf_w: f32,
    choice: usize,
    ed: Option<Editor>,
    rows: Vec<Row>,
    layout_ids: Vec<String>,
    worker: Worker,
    thumbs: Rc<VecModel<Thumb>>,
    chat: Rc<VecModel<ChatMsg>>,
    backend: Arc<Mutex<Box<dyn ChatBackend>>>,
    autosave: Timer,
    rerender: Timer,
    status: Option<(String, bool)>,
    status_timer: Timer,
    confirm: Option<usize>,
    prev_screen: String,
    look: Option<Look>,
    present: Option<Present>,
    /// GPU-Stage (dw-canvas auf Slints wgpu-Device); None = CPU über dw-raster
    gpu: Option<dw_canvas::GpuCanvas>,
    fcx: dw_edit::FontContext,
    /// Messung der gezeigten Folie (Treffer, Auswahl, Editor-Geometrie)
    measured: Option<dw_model::Measured>,
    sel: Option<String>,
    text: Option<Edit>,
}

pub fn run(store: Store, open: Option<PathBuf>, shots: Option<PathBuf>) -> anyhow::Result<()> {
    let ui = AppWindow::new()?;
    let worker = Worker::start(Box::new(CpuRenderer::new()), |d| {
        // Pixel sind Send, slint::Image nicht: das Bild entsteht im UI-Thread
        let _ = slint::invoke_from_event_loop(move || with_app(|a| a.done(d)));
    });
    let app = App {
        ui: ui.as_weak(),
        store,
        recent: vec![],
        templates: vec![],
        shown: vec![],
        shown_tpl: vec![],
        all: false,
        shelf_w: 1024.0,
        choice: 0,
        ed: None,
        rows: vec![],
        layout_ids: vec![],
        worker,
        thumbs: Rc::new(VecModel::default()),
        chat: Rc::new(VecModel::default()),
        backend: Arc::new(Mutex::new(Box::new(Offline))),
        autosave: Timer::default(),
        rerender: Timer::default(),
        status: None,
        status_timer: Timer::default(),
        confirm: None,
        prev_screen: "start".into(),
        look: None,
        present: None,
        gpu: None,
        fcx: dw_edit::font_context_from_dir(&dw_scene::FontStore::default_dir()).unwrap_or_else(|_| dw_edit::font_context([])),
        measured: None,
        sel: None,
        text: None,
    };
    ui.set_thumbs(app.thumbs.clone().into());
    ui.set_chat(app.chat.clone().into());
    ui.set_models(model(MODELS.iter().map(ss).collect()));
    ui.set_format_options(model(start::FORMAT_CHOICES.iter().map(|c| ss(c.1)).collect()));
    ui.set_version(ss(env!("CARGO_PKG_VERSION")));
    APP.with(|a| *a.borrow_mut() = Some(app));
    with_app(|a| {
        a.settings();
        a.load_templates();
        a.load_start();
        a.set_choice(0);
        if let Some(p) = open {
            a.open(&p);
        }
    });
    wire(&ui);
    if let Some(dir) = shots {
        shots_run(ui.as_weak(), dir);
    }
    // GPU: vello teilt Slints wgpu-Device; ohne wgpu (Software-Renderer) bleibt die CPU-Stage
    let _ = ui.window().set_rendering_notifier(|state, api| {
        if let (slint::RenderingState::RenderingSetup, slint::GraphicsAPI::WGPU30 { device, queue, .. }) = (state, api) {
            let gpu = dw_canvas::GpuCanvas::new(device.clone(), queue.clone());
            // nicht im Notifier selbst zeichnen: erst nach dem laufenden Frame
            let _ = slint::invoke_from_event_loop(move || {
                with_app(|a| match gpu {
                    Ok(g) => {
                        eprintln!("Stage: vello auf wgpu");
                        a.gpu = Some(g);
                        a.request_current();
                    }
                    Err(e) => eprintln!("vello-GPU nicht nutzbar ({e}), Stage über die CPU"),
                })
            });
        }
    });
    // IME direkt von winit: Slint gibt Preedit/Commit nur an TextInput weiter
    ui.window().on_winit_window_event(|_, ev| {
        let mut used = false;
        if let winit::event::WindowEvent::Ime(ime) = ev {
            with_app(|a| used = a.ime(ime));
        }
        if used { EventResult::PreventDefault } else { EventResult::Propagate }
    });
    ui.show()?;
    ui.invoke_focus_keys();
    slint::run_event_loop()?;
    with_app(|a| {
        a.commit_text();
        a.flush();
    });
    // App vor dem Thread-Ende abbauen, solange der Thread-Speicher noch lebt
    let app = APP.with(|a| a.borrow_mut().take());
    drop(app);
    Ok(())
}

fn wire(ui: &AppWindow) {
    // Start
    ui.on_start_submit(|t| with_app(|a| a.start_submit(t.to_string())));
    ui.on_pick_format(|i| with_app(|a| a.set_choice(i as usize)));
    ui.on_pick_paper(|i| with_app(|a| a.pick_paper(i as usize)));
    ui.on_chip(|i| with_app(|a| {
        if let Some((text, fmt)) = start::EXAMPLES.get(i as usize) {
            a.ui().set_home_text(ss(text));
            a.set_choice(start::choice(fmt));
        }
    }));
    ui.on_blank(|| with_app(|a| a.blank()));
    ui.on_open_dialog(|| with_app(|a| a.open_dialog()));
    ui.on_open_deck(|i| with_app(|a| {
        if let Some(p) = a.shown.get(i as usize).map(|&k| a.recent[k].path.clone()) {
            a.open(&p)
        }
    }));
    ui.on_open_template(|i| with_app(|a| a.open_template(i as usize)));
    ui.on_toggle_all(|| with_app(|a| {
        a.all = !a.all;
        a.layout_shelf();
    }));
    ui.on_find(|q, k| with_app(|a| {
        let ui = a.ui();
        ui.set_query(q);
        ui.set_kind_index(k);
        a.layout_shelf();
    }));
    ui.on_shelf_width(|w| with_app(|a| {
        if (w - a.shelf_w).abs() > 0.5 {
            a.shelf_w = w;
            a.layout_shelf();
        }
    }));
    ui.on_open_settings(|| with_app(|a| {
        let ui = a.ui();
        let s = ui.get_screen().to_string();
        if s != "settings" {
            a.prev_screen = s;
        }
        ui.set_screen("settings".into());
    }));
    ui.on_settings_done(|| with_app(|a| {
        let ui = a.ui();
        ui.set_screen(ss(&a.prev_screen));
        ui.invoke_focus_keys();
    }));
    ui.on_set_edition(|i| with_app(|a| a.set_edition(if i == 1 { Edition::Pro } else { Edition::Deckwerk })));

    // Editor
    ui.on_home(|| with_app(|a| a.back()));
    ui.on_undo(|| with_app(|a| a.edit(|e| e.undo(), true, true)));
    ui.on_redo(|| with_app(|a| a.edit(|e| e.redo(), true, true)));
    ui.on_save(|| with_app(|a| a.save()));
    ui.on_select_slide(|i| with_app(|a| {
        a.commit_text();
        a.sel = None;
        if let Some(e) = a.ed.as_mut() {
            e.select(i as usize);
        }
        a.show_slide();
    }));
    ui.on_slide_op(|op, i| with_app(|a| a.slide_op(&op, i as usize)));
    ui.on_move_slide(|i, d| with_app(|a| {
        if let Some(e) = a.ed.as_mut() {
            e.select(i as usize);
        }
        a.edit(|e| e.move_by(d), true, true);
    }));
    ui.on_confirmed(|| with_app(|a| {
        if let Some(i) = a.confirm.take() {
            if let Some(e) = a.ed.as_mut() {
                e.select(i);
            }
            a.edit(|e| e.delete(), true, true);
        }
    }));
    ui.on_pick_layout(|i| with_app(|a| {
        if let Some(id) = a.layout_ids.get(i as usize).cloned() {
            a.edit(|e| e.set_layout(&id), true, false);
        }
    }));
    ui.on_pick_variant(|i| with_app(|a| {
        let Some(e) = a.ed.as_ref() else { return };
        let v = editor::variants(&e.slide().layout).get(i as usize).copied();
        a.edit(|e| e.set_variant(v), true, false);
    }));
    ui.on_pick_frame(|i| with_app(|a| {
        let Some(e) = a.ed.as_ref() else { return };
        let f = frames_of(&e.slide().layout).get(i as usize).copied().filter(|f| *f != "top");
        a.edit(|e| e.set_prop("frame", f), true, false);
    }));
    ui.on_pick_tone(|i| with_app(|a| {
        let t = (i > 0).then(|| TONES[i as usize - 1]);
        a.edit(|e| e.set_prop("tone", t), true, false);
    }));
    ui.on_pick_decor(|i| with_app(|a| {
        let d = (i > 0).then(|| DECORS[i as usize - 1]);
        a.edit(|e| e.set_prop("decor", d), true, false);
    }));
    ui.on_field_edited(|i, t| with_app(|a| {
        let Some(r) = a.rows.get(i as usize).cloned() else { return };
        let switch = r.kind == crate::form::Kind::Bool;
        // ohne Neuaufbau des Formulars: sonst verliert das Feld beim Tippen den Fokus
        a.edit(|e| e.set_field(&r.path, r.kind, &t), switch, false);
        if let Some(row) = a.rows.get_mut(i as usize) {
            row.value = t.into();
        }
    }));
    ui.on_field_action(|i, act| with_app(|a| {
        let Some(r) = a.rows.get(i as usize).cloned() else { return };
        a.edit(|e| e.form_action(&r.path, &act), true, false);
    }));
    ui.on_notes_edited(|t| with_app(|a| {
        a.edit(|e| e.set_notes(&t), false, false);
        a.notes_time();
    }));
    ui.on_notes_ai(|| with_app(|a| {
        let Some(i) = a.ed.as_ref().map(|e| e.index) else { return };
        a.ask(format!(
            "Schreibe die Sprechernotizen für Folie {} neu: was ich dazu sage, 30–60 Sekunden, frei gesprochen, ohne den Folientext zu wiederholen. Ändere nur notes.",
            i + 1
        ));
    }));
    ui.on_ask(|t| with_app(|a| a.ask(t.to_string())));
    ui.on_bubble_close(|| with_app(|a| a.ui().set_bubble("".into())));
    ui.on_look(|| with_app(|a| a.look_open()));
    ui.on_look_pick(|i| with_app(|a| a.look_pick(i as usize)));
    ui.on_look_done(|| with_app(|a| a.look_close(true)));
    ui.on_look_cancel(|| with_app(|a| a.look_close(false)));
    ui.on_present(|cur| with_app(|a| a.present(cur)));
    ui.on_export(|f| with_app(|a| a.export(&f)));
    ui.on_stage_pointer(|k, x, y, shift| with_app(|a| a.pointer(k, f64::from(x), f64::from(y), shift)));
    ui.on_edit_key(|t, ctrl, shift, alt| {
        let mut used = false;
        with_app(|a| used = a.edit_key(&t, ctrl, shift, alt));
        used
    });
}

fn srect(r: kurbo::Rect, o: (f64, f64)) -> SRect {
    SRect { x: (r.x0 + o.0) as f32, y: (r.y0 + o.1) as f32, w: r.width() as f32, h: r.height() as f32 }
}

fn frames_of(layout: &str) -> Vec<&'static str> {
    let Some(def) = dw_scene::all_layouts().find(|l| l.0 == layout).map(|l| &l.2) else { return vec![] };
    if def.frames.is_empty() {
        return vec![];
    }
    std::iter::once("top").chain(def.frames.iter().copied()).collect()
}

impl App {
    fn ui(&self) -> AppWindow {
        self.ui.upgrade().expect("Fenster")
    }

    fn settings(&self) {
        let ui = self.ui();
        ui.set_edition(self.store.edition.name().into());
        ui.set_pro(self.store.edition == Edition::Pro);
        ui.set_edition_index(i32::from(self.store.edition == Edition::Pro));
        ui.set_data_dir(ss(self.store.root().display().to_string()));
    }

    fn set_edition(&mut self, ed: Edition) {
        if ed == self.store.edition {
            return;
        }
        self.flush();
        match Store::open(ed) {
            Ok(s) => self.store = s,
            Err(e) => return self.set_status(format!("Datenordner: {e}"), true),
        }
        self.ed = None;
        self.prev_screen = "start".into();
        self.settings();
        self.load_start();
    }

    // ---------- Start ----------

    /// Vorschaubild aus dem Cache (Pfad + Änderungszeit), sonst rendert der Worker es und legt es ab.
    fn cover(&self, path: &Path, deck: &Deck, mtime: u64) -> Option<Image> {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        std::hash::Hash::hash(&(path, mtime), &mut h);
        let file = self.store.root().join(".cache").join("thumbs").join(format!("{:016x}.png", std::hash::Hasher::finish(&h)));
        if file.exists()
            && let Ok(img) = Image::load_from_path(&file)
        {
            return Some(img);
        }
        let scale = 2.0 * start::CARD_W / deck.size().w as f32;
        self.worker.send(Job { target: Target::Start(path.to_path_buf()), deck: Arc::new(deck.clone()), index: 0, scale, raster: true, save: Some(file) });
        None
    }

    // ponytail: liest alle Decks beim Öffnen der Startseite (nicht bei jedem Fokus, L12); ein Index lohnt erst bei sehr vielen Decks
    fn load_start(&mut self) {
        let now = now_ms();
        let list: Vec<RecentDeck> = self.store.recent(10_000);
        self.recent = list
            .into_iter()
            .filter_map(|r| {
                let deck = self.store.load_deck(&r.path).ok()?;
                let sub = format!("{} · {}", start::when(r.mtime, now), start::pages(&deck));
                let image = self.cover(&r.path, &deck, r.mtime);
                Some(Entry { path: r.path, deck, sub, image })
            })
            .collect();
        for t in 0..self.templates.len() {
            if self.templates[t].image.is_none() {
                let (p, d) = (self.templates[t].path.clone(), self.templates[t].deck.clone());
                self.templates[t].image = self.cover(&p, &d, 0);
            }
        }
        self.layout_shelf();
    }

    /// Vorlagen = examples/*.json im Repo (später gebündelt)
    fn load_templates(&mut self) {
        let dir = std::env::var_os("DECKWERK_ASSETS")
            .map(|d| PathBuf::from(d).join("examples"))
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples"));
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect())
            .unwrap_or_default();
        files.sort();
        self.templates = files
            .into_iter()
            .filter_map(|p| {
                let deck: Deck = serde_json::from_str(&std::fs::read_to_string(&p).ok()?).ok()?;
                dw_store::check_deck(&deck).ok()?;
                // nur Vorlagen, deren Titelfolie die native Engine schon setzen kann
                editor::sample(&deck.slides[0].layout)?;
                Some(Entry { sub: start::pages(&deck), path: p, deck, image: None })
            })
            .collect();
    }

    fn layout_shelf(&mut self) {
        let ui = self.ui();
        let (q, kind) = (ui.get_query().to_string(), ui.get_kind_index().max(0) as usize);
        let filtering = !q.trim().is_empty() || kind > 0;
        let hits: Vec<usize> = (0..self.recent.len()).filter(|&i| start::fits(&self.recent[i].deck, &q, kind)).collect();
        let total = hits.len();
        self.shown = if self.all || filtering { hits } else { hits.into_iter().take(8).collect() };
        self.shown_tpl = (0..self.templates.len()).filter(|&i| start::fits(&self.templates[i].deck, &q, kind)).collect();
        let cards = |entries: &[Entry], idx: &[usize], w: f32| {
            let ratios: Vec<f32> = idx.iter().map(|&i| ratio(&entries[i].deck)).collect();
            let (pos, h) = start::shelf(&ratios, w);
            let v: Vec<DeckCard> = idx
                .iter()
                .zip(pos)
                .map(|(&i, (x, y, ch))| {
                    let e = &entries[i];
                    DeckCard {
                        title: ss(&e.deck.title),
                        sub: ss(&e.sub),
                        has_image: e.image.is_some(),
                        image: e.image.clone().unwrap_or_default(),
                        x,
                        y,
                        cover_h: ch,
                    }
                })
                .collect();
            (v, h)
        };
        let (decks, h) = cards(&self.recent, &self.shown, self.shelf_w);
        let (tpl, th) = cards(&self.templates, &self.shown_tpl, self.shelf_w);
        ui.set_decks(model(decks));
        ui.set_shelf_h(h);
        ui.set_templates(model(tpl));
        ui.set_tpl_h(th);
        ui.set_more_text(ss(if filtering || total <= 8 {
            String::new()
        } else if self.all {
            "Weniger anzeigen".into()
        } else {
            format!("Alle anzeigen ({total})")
        }));
    }

    fn set_choice(&mut self, c: usize) {
        self.choice = c.min(start::FORMAT_CHOICES.len() - 1);
        let ui = self.ui();
        ui.set_format_index(self.choice as i32);
        ui.set_paper_index(start::paper_of(self.choice));
        ui.set_blank_text(ss(start::blank_text(self.choice)));
    }

    /// Papier anklicken wählt das Format, nochmal klicken nimmt die Wahl zurück; Video/Animation/Podcast: Pro, kommt bald
    fn pick_paper(&mut self, i: usize) {
        let Some(id) = start::PAPERS.get(i) else { return };
        if let Some((_, name)) = start::PRO_PAPERS.iter().find(|p| p.0 == *id) {
            return self.soon(name);
        }
        let c = start::choice(id);
        self.set_choice(if c == self.choice { 0 } else { c });
    }

    fn soon(&self, title: &str) {
        let ui = self.ui();
        ui.set_soon_title(ss(title));
        ui.set_soon_open(true);
    }

    fn start_submit(&mut self, text: String) {
        let ui = self.ui();
        if text.trim().is_empty() {
            return ui.set_start_error("Dateien anhängen kommt mit der KI-Anbindung.".into());
        }
        let deck = editor::new_deck("Neues Deck", start::blank_format(self.choice));
        let backend = self.backend.clone();
        std::thread::spawn(move || {
            let r = backend.lock().unwrap_or_else(|p| p.into_inner()).ask(&deck, &text);
            let _ = slint::invoke_from_event_loop(move || with_app(|a| a.start_reply(r)));
        });
    }

    fn start_reply(&mut self, r: ChatReply) {
        if let Some(d) = r.deck {
            let mut e = Editor::new(d, None);
            match e.save(&self.store) {
                Ok(p) => return self.open(&p),
                Err(err) => return self.ui().set_start_error(ss(err)),
            }
        }
        self.ui().set_start_error(ss(r.text));
    }

    fn blank(&mut self) {
        let mut e = Editor::new(editor::new_deck("Unbenanntes Deck", start::blank_format(self.choice)), None);
        match e.save(&self.store) {
            Ok(p) => self.open(&p),
            Err(err) => self.ui().set_start_error(ss(format!("Anlegen fehlgeschlagen: {err}"))),
        }
    }

    /// Vorlage: Kopie im Datenordner, die Vorlage bleibt unverändert
    fn open_template(&mut self, i: usize) {
        let Some(t) = self.shown_tpl.get(i).map(|&k| self.templates[k].deck.clone()) else { return };
        let mut e = Editor::new(t, None);
        match e.save(&self.store) {
            Ok(p) => self.open(&p),
            Err(err) => self.ui().set_start_error(ss(format!("Vorlage: {err}"))),
        }
    }

    fn open_dialog(&self) {
        let root = self.store.root().to_path_buf();
        // Portal-Dialog blockiert: eigener Thread
        std::thread::spawn(move || {
            let f = rfd::FileDialog::new().set_title("Deck öffnen").set_directory(&root).add_filter("Deckwerk-Deck", &["json"]).pick_file();
            if let Some(f) = f {
                let _ = slint::invoke_from_event_loop(move || with_app(|a| a.open(&f)));
            }
        });
    }

    pub fn open(&mut self, path: &Path) {
        self.text = None;
        self.sel = None;
        self.measured = None;
        self.flush();
        let deck = match self.store.load_deck(path) {
            Ok(d) => d,
            Err(e) => return self.ui().set_start_error(ss(format!("Öffnen fehlgeschlagen: {e}"))),
        };
        let path = self.store.inside(path).unwrap_or_else(|_| path.to_path_buf());
        self.ed = Some(Editor::new(deck, Some(path)));
        self.status = None;
        self.chat.set_vec(vec![]);
        let ui = self.ui();
        ui.set_start_error("".into());
        ui.set_bubble("".into());
        ui.set_history_open(false);
        ui.set_view("slide".into());
        ui.set_screen("editor".into());
        self.all_thumbs();
        self.show_slide();
        ui.invoke_focus_keys();
    }

    fn back(&mut self) {
        self.commit_text();
        self.flush();
        self.ed = None;
        let ui = self.ui();
        ui.set_screen("start".into());
        ui.set_deck_title("".into());
        self.load_start();
    }

    // ---------- Editor ----------

    /// Änderung am Deck; `form`: Inspector neu aufbauen, `all`: alle Vorschaubilder (Reihenfolge/Theme geändert).
    fn edit(&mut self, f: impl FnOnce(&mut Editor) -> bool, form: bool, all: bool) {
        let Some(e) = self.ed.as_mut() else { return };
        if !f(e) {
            return;
        }
        if all {
            self.all_thumbs();
        }
        if form {
            self.show_slide();
        } else {
            // Tippen sammeln, dann einmal rendern
            self.rerender.start(TimerMode::SingleShot, RERENDER, || with_app(|a| a.request_current()));
            self.top_state();
        }
        self.autosave.start(TimerMode::SingleShot, AUTOSAVE, || with_app(|a| a.save()));
    }

    fn slide_op(&mut self, op: &str, i: usize) {
        if let Some(e) = self.ed.as_mut() {
            e.select(i);
        }
        match op {
            "delete" => {
                let Some(n) = self.ed.as_ref().map(|e| e.deck.slides.len()) else { return };
                if n < 2 {
                    return;
                }
                self.confirm = Some(i);
                let ui = self.ui();
                ui.set_confirm_title(ss(format!("Folie {} löschen?", i + 1)));
                ui.set_confirm_text("Mit Strg+Z holst du sie zurück.".into());
                ui.set_confirm_ok("Löschen".into());
                ui.set_confirm_open(true);
            }
            "add" | "add-blank" => self.edit(|e| e.add_slide(), true, true),
            "duplicate" => self.edit(|e| e.duplicate(), true, true),
            "hide" => self.edit(|e| e.toggle_hidden(), true, true),
            _ => {}
        }
    }

    fn set_status(&mut self, text: String, error: bool) {
        eprintln!("{text}");
        self.status = Some((text, error));
        self.top_state();
        self.status_timer.start(TimerMode::SingleShot, STATUS, || {
            with_app(|a| {
                a.status = None;
                a.top_state();
            })
        });
    }

    /// Titelzeile: Titel und Zustand („Gespeichert“, „Bearbeitet“ oder eine Meldung)
    fn top_state(&self) {
        let (Some(e), ui) = (self.ed.as_ref(), self.ui()) else { return };
        ui.set_deck_title(ss(&e.deck.title));
        ui.set_can_undo(e.can_undo());
        ui.set_can_redo(e.can_redo());
        let (text, err) = match &self.status {
            Some((t, err)) => (t.clone(), *err),
            None if e.dirty => ("Bearbeitet".into(), false),
            None if e.path.is_some() => ("Gespeichert".into(), false),
            None => ("Nicht gespeichert".into(), false),
        };
        ui.set_state_text(ss(text));
        ui.set_state_error(err);
    }

    fn save(&mut self) {
        self.autosave.stop();
        let Some(e) = self.ed.as_mut() else { return };
        if !e.dirty && e.path.is_some() {
            return;
        }
        if let Err(err) = e.save(&self.store) {
            self.set_status(err, true);
        }
        self.top_state();
    }

    /// vor Öffnen, Zurück, Beenden und Export: nichts Ungespeichertes verlieren
    fn flush(&mut self) {
        if self.ed.as_ref().is_some_and(|e| e.dirty) {
            self.save();
        }
    }

    fn notes_time(&self) {
        let Some(e) = self.ed.as_ref() else { return };
        let n = e.notes();
        self.ui().set_notes_time(ss(if n.trim().is_empty() {
            String::new()
        } else {
            let deck: f64 = e.deck.slides.iter().map(|s| dw_lint::speak_sec(s.extra.get("notes").and_then(|v| v.as_str()))).sum();
            format!("≈ {} · Deck ≈ {}", dw_lint::fmt_sec(dw_lint::speak_sec(Some(n))), dw_lint::fmt_sec(deck))
        }));
    }

    /// Inspector, Notizen und Stage für die aktuelle Folie
    fn show_slide(&mut self) {
        let Some(e) = self.ed.as_ref() else { return };
        let ui = self.ui();
        let slide = e.slide();
        let size = e.deck.size();
        ui.set_slide_w(size.w as f32);
        ui.set_slide_h(size.h as f32);
        ui.set_current(e.index as i32);
        ui.set_notes(ss(e.notes()));
        ui.set_slide_head(ss(format!("Folie {} · {}", e.index + 1, layout_name(&slide.layout)).to_uppercase()));
        let mut ids: Vec<String> = dw_scene::all_layouts().map(|l| l.0.to_string()).collect();
        if !ids.contains(&slide.layout) {
            ids.push(slide.layout.clone());
        }
        let ported = editor::sample(&slide.layout).is_some();
        ui.set_layouts(model(
            ids.iter()
                .map(|id| if editor::sample(id).is_some() { ss(layout_name(id)) } else { ss(format!("{} (noch nicht portiert)", layout_name(id))) })
                .collect(),
        ));
        ui.set_layout_index(ids.iter().position(|i| *i == slide.layout).unwrap_or(0) as i32);
        self.layout_ids = ids;
        let vars = editor::variants(&slide.layout);
        ui.set_variants(model(vars.iter().map(ss).collect()));
        ui.set_variant_index(slide.variant.as_deref().and_then(|v| vars.iter().position(|x| *x == v)).unwrap_or(0) as i32);
        let frames = frames_of(&slide.layout);
        ui.set_frames(model(frames.iter().map(|f| ss(FRAMES.iter().find(|x| x.0 == *f).map_or(*f, |x| x.1))).collect()));
        ui.set_frame_index(frames.iter().position(|f| Some(*f) == slide.frame.as_deref()).unwrap_or(0) as i32);
        let def_tone = dw_scene::all_layouts().find(|l| l.0 == slide.layout).and_then(|l| l.2.tone).map_or("normal", |t| t.as_str());
        let mut tones = vec![ss(format!("Standard ({def_tone})"))];
        tones.extend(TONES.iter().map(ss));
        ui.set_tones(model(tones));
        ui.set_tone_index(slide.tone.as_deref().and_then(|t| TONES.iter().position(|x| *x == t)).map_or(0, |i| i as i32 + 1));
        let mut decors = vec![ss("Theme-Standard")];
        decors.extend(DECORS.iter().map(ss));
        ui.set_decors(model(decors));
        let decor = slide.extra.get("decor").and_then(|v| v.as_str());
        ui.set_decor_index(decor.and_then(|d| DECORS.iter().position(|x| *x == d)).map_or(0, |i| i as i32 + 1));
        self.rows = e.rows();
        ui.set_form_note(if !ported {
            ss(format!("„{}“ ist in der nativen App noch nicht portiert. Der Inhalt bleibt erhalten.", layout_name(&slide.layout)))
        } else if self.rows.is_empty() {
            "Dieses Layout hat keine Inhaltsfelder.".into()
        } else {
            "".into()
        });
        ui.set_rows(model(
            self.rows
                .iter()
                .map(|r| FormRow {
                    kind: r.kind.id().into(),
                    label: ss(&r.label),
                    value: ss(&r.value),
                    depth: r.depth as i32,
                    item: r.item.is_some(),
                    can_up: r.item.is_some_and(|(j, _)| j > 0),
                    can_down: r.item.is_some_and(|(j, len)| j + 1 < len),
                })
                .collect(),
        ));
        self.notes_time();
        self.top_state();
        self.request_current();
    }

    /// Deck, wie es gerade aussieht: mit dem Text, der auf der Folie in Bearbeitung ist
    fn live(&self) -> Option<Deck> {
        let e = self.ed.as_ref()?;
        let mut d = e.deck.clone();
        if let Some(t) = &self.text
            && let Some(v) = d.slides[e.index].content.pointer_mut(&textedit::pointer(&t.slot))
        {
            *v = serde_json::Value::String(t.text());
        }
        Some(d)
    }

    fn stage_scale(&self) -> f32 {
        // GPU: Textur in Bildschirmauflösung (höchstens 2×), CPU: Folienpixel
        if self.gpu.is_some() { (STAGE_SCALE * self.ui().window().scale_factor()).clamp(1.0, 2.0) } else { STAGE_SCALE }
    }

    fn request_current(&self) {
        let (Some(e), Some(live)) = (self.ed.as_ref(), self.live()) else { return };
        let deck = Arc::new(live);
        let gpu = self.gpu.is_some();
        self.worker.send(Job { target: Target::Stage, deck: deck.clone(), index: e.index, scale: self.stage_scale(), raster: !gpu, save: None });
        if self.text.is_none() {
            self.worker.send(Job { target: Target::Strip(e.index), deck, index: e.index, scale: thumb_scale(&e.deck), raster: true, save: None });
        }
    }

    fn all_thumbs(&self) {
        let Some(e) = self.ed.as_ref() else { return };
        let n = e.deck.slides.len();
        // vorhandene Bilder stehen lassen, bis die neuen da sind
        while self.thumbs.row_count() > n {
            self.thumbs.remove(n);
        }
        while self.thumbs.row_count() < n {
            self.thumbs.push(Thumb::default());
        }
        let deck = Arc::new(e.deck.clone());
        let scale = thumb_scale(&e.deck);
        for i in 0..n {
            self.worker.send(Job { target: Target::Strip(i), deck: deck.clone(), index: i, scale, raster: true, save: None });
        }
    }

    /// Ergebnis aus dem Render-Thread; veraltete (Folie inzwischen geändert) fallen weg.
    fn done(&mut self, d: Done) {
        match &d.target {
            Target::Start(p) => {
                if d.out.measured.is_none() {
                    return;
                }
                let img = image(&d.out.pixels);
                for e in self.recent.iter_mut().chain(self.templates.iter_mut()).filter(|e| &e.path == p) {
                    e.image = Some(img.clone());
                }
                if self.ui().get_screen() == "start" {
                    self.layout_shelf();
                }
            }
            Target::Present(i) => {
                if let Some(p) = self.present.as_mut()
                    && let Some(slot) = p.imgs.get_mut(*i)
                {
                    *slot = Some(image(&d.out.pixels));
                    if p.order.get(p.pos) == Some(i) {
                        self.present_show();
                    }
                }
            }
            Target::Look(i) => {
                if let Some(l) = self.look.as_mut()
                    && let Some(slot) = l.imgs.get_mut(*i)
                {
                    *slot = Some(image(&d.out.pixels));
                    self.look_cards();
                }
            }
            Target::LookPreview => {
                if self.look.is_some() {
                    self.ui().set_look_preview(image(&d.out.pixels));
                }
            }
            Target::Strip(i) => {
                let Some(e) = self.ed.as_ref() else { return };
                if *i < self.thumbs.row_count() && stage::slide_key(&e.deck, *i, thumb_scale(&e.deck)) == d.key {
                    let s = &e.deck.slides[*i];
                    let label = if d.out.measured.is_some() { SharedString::new() } else { ss(layout_name(&s.layout)) };
                    self.thumbs.set_row_data(*i, Thumb { image: image(&d.out.pixels), has_image: true, hidden: s.hidden == Some(true), label });
                }
            }
            Target::Stage => {
                let (Some(e), Some(live)) = (self.ed.as_ref(), self.live()) else { return };
                if d.index != e.index || stage::slide_key(&live, e.index, self.stage_scale()) != d.key {
                    return;
                }
                let ui = self.ui();
                let scale = self.stage_scale();
                let gpu_img = match (&mut self.gpu, &d.out.scene) {
                    (Some(g), Some(scene)) => match g.render(scene, scale).and_then(|t| Image::try_from(t).map_err(|e| e.to_string())) {
                        Ok(img) => Some(img),
                        Err(err) => {
                            eprintln!("GPU-Stage: {err}");
                            None
                        }
                    },
                    _ => None,
                };
                match gpu_img {
                    Some(img) => ui.set_stage_image(img),
                    None if d.out.pixels.w > 1 || d.out.measured.is_none() => ui.set_stage_image(image(&d.out.pixels)),
                    None => {
                        // GPU fiel aus: dieselbe Folie über die CPU
                        self.gpu = None;
                        return self.request_current();
                    }
                }
                let Some(e) = self.ed.as_ref() else { return };
                let layout = &e.slide().layout;
                let (hint, level, lint) = hint(&d.out, layout);
                ui.set_stage_placeholder(if d.out.measured.is_some() {
                    "".into()
                } else {
                    ss(format!(
                        "„{}“ ist in der nativen App noch nicht portiert.\nDer Inhalt bleibt erhalten und lässt sich unter „Anpassen“ bearbeiten.",
                        layout_name(layout)
                    ))
                });
                ui.set_hint(ss(hint));
                ui.set_hint_level(level);
                ui.set_lint(model(lint.into_iter().map(SharedString::from).collect()));
                self.measured = d.out.measured.clone();
                self.restyle_text();
                self.overlay();
            }
        }
    }

    // ---------- Text auf der Folie (dw-edit) ----------

    fn text_el(&self, slot: &str) -> Option<dw_model::TextEl> {
        self.measured.as_ref()?.els.iter().find_map(|e| match e {
            dw_model::El::Text(t) if t.base.slot == slot => Some(t.clone()),
            _ => None,
        })
    }

    /// Auswahlrahmen, Cursor, Markierung und IME-Unterstreichung in Folienpixeln
    fn overlay(&self) {
        let ui = self.ui();
        let slot = self.text.as_ref().map(|t| t.slot.as_str()).or(self.sel.as_deref());
        let bbox = slot.and_then(|s| self.measured.as_ref()?.els.iter().find(|e| e.base().slot == s)).map(|e| e.base().bbox);
        ui.set_sel_visible(bbox.is_some());
        if let Some(b) = bbox {
            ui.set_sel(SRect { x: b.x as f32, y: b.y as f32, w: b.w as f32, h: b.h as f32 });
        }
        ui.set_editing(self.text.is_some());
        match &self.text {
            Some(t) => {
                let caret = t.ed.cursor_rect(2.);
                ui.set_caret_visible(caret.is_some());
                if let Some(c) = caret {
                    ui.set_caret(srect(c, t.origin));
                }
                let rects = |v: Vec<kurbo::Rect>| model(v.into_iter().map(|r| srect(r, t.origin)).collect());
                ui.set_sel_rects(rects(t.ed.selection_rects()));
                ui.set_compose_rects(rects(t.ed.compose_rects()));
            }
            None => {
                ui.set_caret_visible(false);
                ui.set_sel_rects(model(vec![]));
                ui.set_compose_rects(model(vec![]));
            }
        }
    }

    /// Autofit kann Größe und Box ändern: Editor-Layout nachziehen
    fn restyle_text(&mut self) {
        let Some(slot) = self.text.as_ref().map(|t| t.slot.clone()) else { return };
        let (Some(t), Some(live)) = (self.text_el(&slot), self.live()) else { return };
        let style = textedit::text_style(&live, &t);
        if let Some(e) = &mut self.text {
            e.origin = (t.base.bbox.x, t.base.bbox.y);
            e.ed.set_style(style);
        }
    }

    /// Zeiger auf der Folie (Folienpixel): 0 gedrückt, 1 gezogen, 2 losgelassen, 3 Doppelklick
    fn pointer(&mut self, kind: i32, x: f64, y: f64, shift: bool) {
        let p = kurbo::Point::new(x, y);
        if let Some(t) = &self.text {
            let inside = self.measured.as_ref().and_then(|m| m.els.iter().find(|e| e.base().slot == t.slot)).is_some_and(|el| dw_edit::stage::Geo::of_el(el).contains(p));
            let t = self.text.as_mut().expect("bearbeitet");
            let (lx, ly) = ((x - t.origin.0) as f32, (y - t.origin.1) as f32);
            match kind {
                0 if inside => {
                    t.ed.click(lx, ly, shift);
                    t.dragging = true;
                }
                0 => return self.commit_text(), // Klick daneben übernimmt
                1 if t.dragging => t.ed.drag_to(lx, ly),
                2 => t.dragging = false,
                3 if inside => t.ed.double_click(lx, ly),
                _ => return,
            }
            return self.overlay();
        }
        if kind != 0 && kind != 3 {
            return;
        }
        let Some(e) = self.ed.as_ref() else { return };
        let items = e.slide().items.as_deref().unwrap_or(&[]);
        self.sel = self.measured.as_ref().and_then(|m| match dw_edit::stage::hit(&m.els, items, p) {
            Some(dw_edit::stage::Hit::El(i)) => Some(m.els[i].base().slot.clone()),
            _ => None,
        });
        if kind == 3 {
            self.start_text(Some((x, y)));
        }
        self.overlay();
    }

    /// Doppelklick oder Enter auf einem Text-Slot
    fn start_text(&mut self, at: Option<(f64, f64)>) {
        let (Some(slot), Some(e)) = (self.sel.clone(), self.ed.as_ref()) else { return };
        let Some(t) = self.text_el(&slot) else { return };
        let Some(edit) = Edit::start(self.fcx.clone(), &e.deck, e.index, &slot, &t, at) else {
            return self.set_status(format!("{slot}: hier nicht bearbeitbar, nutze „Anpassen“"), false);
        };
        self.text = Some(edit);
        let ui = self.ui();
        ui.invoke_focus_keys();
        ui.window().with_winit_window(|w| w.set_ime_allowed(true));
        self.overlay();
    }

    fn edit_key(&mut self, key: &str, ctrl: bool, shift: bool, alt: bool) -> bool {
        let Some(t) = self.text.as_mut() else {
            // Enter auf einem ausgewählten Text beginnt die Bearbeitung, Esc hebt die Auswahl auf
            let ret: String = SharedString::from(slint::platform::Key::Return).into();
            let esc: String = SharedString::from(slint::platform::Key::Escape).into();
            if self.sel.is_some() && key == ret {
                self.start_text(None);
                return self.text.is_some();
            }
            if self.sel.is_some() && key == esc {
                self.sel = None;
                self.overlay();
                return true;
            }
            return false;
        };
        match textedit::key(t, key, ctrl, shift, alt) {
            KeyOut::Changed => {
                if t.lossy() {
                    self.set_status("Kursiv, Farbe und Sonderformate lassen sich in diesem Feld nicht speichern".into(), false);
                }
                self.overlay();
                self.request_current();
            }
            KeyOut::Moved => self.overlay(),
            KeyOut::Commit => self.commit_text(),
            KeyOut::Cancel => self.end_text(),
            KeyOut::Save => {
                self.commit_text();
                self.save();
            }
            KeyOut::Unused => return false,
        }
        true
    }

    fn ime(&mut self, ev: &winit::event::Ime) -> bool {
        let Some(t) = self.text.as_mut() else { return false };
        let before = t.ed.doc().clone();
        match ev {
            winit::event::Ime::Preedit(text, cursor) => t.ed.set_compose(text, *cursor),
            winit::event::Ime::Commit(text) => t.ed.commit_compose(text),
            _ => return true,
        }
        let changed = *t.ed.doc() != before;
        self.overlay();
        if changed {
            self.request_current();
        }
        true
    }

    /// Bearbeitung übernehmen: ein Undo-Schritt wie jede Feldänderung
    fn commit_text(&mut self) {
        let Some(t) = self.text.take() else { return };
        let text = t.text();
        if text != t.orig {
            let path = textedit::pointer(&t.slot);
            self.edit(|e| e.set_field(&path, crate::form::Kind::Text, &text), true, false);
        }
        self.end_text_ui();
    }

    fn end_text(&mut self) {
        self.text = None;
        self.end_text_ui();
    }

    fn end_text_ui(&mut self) {
        let ui = self.ui();
        ui.window().with_winit_window(|w| w.set_ime_allowed(false));
        ui.invoke_focus_keys();
        self.request_current();
        self.overlay();
    }

    // ---------- Look ----------

    fn look_open(&mut self) {
        let Some(e) = self.ed.as_ref() else { return };
        let themes: Vec<&dw_theme::Theme> = dw_theme::catalog_themes().collect();
        let sel = themes.iter().position(|t| t.id == e.deck.theme.id).unwrap_or(0);
        let n = e.deck.slides.len();
        let deck = e.deck.clone();
        let orig = e.deck.theme.id.clone();
        let scale = 224.0 / deck.size().w as f32;
        for (i, t) in themes.iter().enumerate() {
            let mut d = deck.clone();
            d.theme.id = t.id.clone();
            d.theme.custom = None;
            self.worker.send(Job { target: Target::Look(i), deck: Arc::new(d), index: 0, scale, raster: true, save: None });
        }
        self.look = Some(Look { orig, sel, imgs: vec![None; themes.len()] });
        let ui = self.ui();
        ui.set_look_sub(ss(format!(
            "Das Theme gilt für alle {n} {}. Deine Inhalte bleiben, wie sie sind.",
            if n == 1 { "Folie" } else { "Folien" }
        )));
        ui.set_screen("look".into());
        ui.invoke_focus_keys();
        self.look_pick(sel);
    }

    fn look_cards(&self) {
        let Some(l) = &self.look else { return };
        let ui = self.ui();
        ui.set_look_themes(model(
            dw_theme::catalog_themes()
                .zip(&l.imgs)
                .map(|(t, img)| ThemeCard { name: ss(&t.name), has_image: img.is_some(), image: img.clone().unwrap_or_default() })
                .collect(),
        ));
        ui.set_look_index(l.sel as i32);
    }

    fn look_pick(&mut self, i: usize) {
        let (Some(e), Some(t)) = (self.ed.as_ref(), dw_theme::catalog_themes().nth(i)) else { return };
        let ui = self.ui();
        ui.set_look_name(ss(&t.name));
        let fonts = if t.head.font.css == t.body.css { t.body.css.clone() } else { format!("{} und {}", t.head.font.css, t.body.css) };
        ui.set_look_desc(ss(format!("{} · {fonts}", if t.dark { "Dunkel" } else { "Hell" })));
        let mut d = e.deck.clone();
        d.theme.id = t.id.clone();
        d.theme.custom = None;
        let scale = 880.0 / d.size().w as f32;
        let index = e.index;
        self.worker.send(Job { target: Target::LookPreview, deck: Arc::new(d), index, scale, raster: true, save: None });
        if let Some(l) = self.look.as_mut() {
            l.sel = i;
        }
        self.look_cards();
    }

    fn look_close(&mut self, apply: bool) {
        let Some(l) = self.look.take() else { return };
        let ui = self.ui();
        ui.set_screen("editor".into());
        if apply && let Some(t) = dw_theme::catalog_themes().nth(l.sel) {
            let id = t.id.clone();
            if id != l.orig {
                self.edit(|e| e.set_theme(&id), true, true);
            }
        }
        ui.invoke_focus_keys();
    }

    // ---------- Präsentieren ----------

    /// F5 und Knopf ab Folie 1, Umschalt+F5 ab der aktuellen
    fn present(&mut self, from_current: bool) {
        let Some(e) = self.ed.as_ref() else { return };
        let order: Vec<usize> = (0..e.deck.slides.len()).filter(|&i| e.deck.slides[i].hidden != Some(true)).collect();
        if order.is_empty() {
            return self.set_status("Alle Folien sind ausgeblendet.".into(), true);
        }
        let win = match PresentWindow::new() {
            Ok(w) => w,
            Err(err) => return self.set_status(format!("Präsentation: {err}"), true),
        };
        // vorab rendern: in Full-HD-Breite, das Fenster skaliert
        let deck = Arc::new(e.deck.clone());
        let scale = (1920.0 / deck.size().w) as f32;
        let start = if from_current { order.iter().position(|&i| i >= e.index).unwrap_or(0) } else { 0 };
        for k in 0..order.len() {
            let i = order[(start + k) % order.len()];
            self.worker.send(Job { target: Target::Present(i), deck: deck.clone(), index: i, scale, raster: true, save: None });
        }
        win.on_nav(|d| {
            with_app(|a| {
                if let Some(p) = a.present.as_mut() {
                    p.pos = (p.pos as i64 + i64::from(d)).clamp(0, p.order.len() as i64 - 1) as usize;
                    a.present_show();
                }
            })
        });
        win.on_leave(|| with_app(|a| a.present_close()));
        win.window().on_close_requested(|| {
            with_app(|a| a.present = None);
            slint::CloseRequestResponse::HideWindow
        });
        let n = e.deck.slides.len();
        self.present = Some(Present { win, order, pos: start, imgs: vec![None; n] });
        self.present_show();
        if let Some(p) = &self.present {
            let _ = p.win.show();
            p.win.window().set_fullscreen(true);
            p.win.invoke_focus_keys();
        }
    }

    fn present_show(&self) {
        let Some(p) = &self.present else { return };
        let img = p.order.get(p.pos).and_then(|&i| p.imgs[i].clone());
        p.win.set_note(if img.is_some() { "".into() } else { "Folie wird vorbereitet …".into() });
        p.win.set_image(img.unwrap_or_default());
    }

    fn present_close(&mut self) {
        if let Some(p) = self.present.take() {
            let _ = p.win.hide();
            if let (Some(e), Some(&i)) = (self.ed.as_mut(), p.order.get(p.pos)) {
                e.select(i);
            }
            self.show_slide();
            self.ui().invoke_focus_keys();
        }
    }

    // ---------- Export ----------

    /// Wie TopBar → deck:export: in den Deck-Ordner, Meldung in der Titelzeile, danach Ordner zeigen
    fn export(&mut self, fmt: &str) {
        let format = match fmt {
            "pptx" => ExportFormat::Pptx,
            "pdf" => ExportFormat::Pdf,
            "png" => ExportFormat::Png,
            _ => return,
        };
        self.flush();
        let Some(path) = self.ed.as_ref().and_then(|e| e.path.clone()) else {
            return self.set_status("Es gibt noch kein Deck zum Exportieren.".into(), true);
        };
        let label = fmt.to_uppercase();
        self.status = Some((format!("Exportiere {label} …"), false));
        self.status_timer.stop();
        self.top_state();
        let store = self.store.clone();
        std::thread::spawn(move || {
            let progress = move |p: f32| {
                let text = format!("Exportiere {label} … {:.0} %", p * 100.0);
                let _ = slint::invoke_from_event_loop(move || {
                    with_app(|a| {
                        a.status = Some((text, false));
                        a.top_state();
                    })
                });
            };
            let r = crate::export::run(&store, &path, vec![format], None, &progress);
            let _ = slint::invoke_from_event_loop(move || with_app(|a| a.export_done(r)));
        });
    }

    fn export_done(&mut self, r: Result<Vec<PathBuf>, String>) {
        match r {
            Ok(files) => {
                let Some(first) = files.first() else { return };
                crate::export::open_folder(first);
                self.set_status(format!("Exportiert: {}", first.display()), false);
            }
            Err(e) => self.set_status(e, true),
        }
    }

    // ---------- KI-Leiste ----------

    fn ask(&mut self, text: String) {
        let Some(e) = self.ed.as_ref() else { return };
        let ui = self.ui();
        if text.trim().is_empty() {
            ui.set_bubble_kind("error".into());
            ui.set_bubble("Dateien anhängen kommt mit der KI-Anbindung.".into());
            return;
        }
        self.chat.push(ChatMsg { me: true, text: ss(&text) });
        let (deck, backend) = (e.deck.clone(), self.backend.clone());
        std::thread::spawn(move || {
            let reply = backend.lock().unwrap_or_else(|p| p.into_inner()).ask(&deck, &text);
            let _ = slint::invoke_from_event_loop(move || with_app(|a| a.reply(reply)));
        });
    }

    fn reply(&mut self, r: ChatReply) {
        let ui = self.ui();
        self.chat.push(ChatMsg { me: false, text: ss(&r.text) });
        ui.set_bubble_kind(if r.error { "error" } else { "ok" }.into());
        ui.set_bubble(ss(&r.text));
        if let Some(d) = r.deck {
            self.edit(|e| e.replace(d), true, true);
        }
    }
}

fn hint(r: &stage::Rendered, layout: &str) -> (String, i32, Vec<String>) {
    let Some(m) = &r.measured else {
        return (format!("{} ist noch nicht portiert", layout_name(layout)), 1, vec![]);
    };
    let errors = r.lint.iter().filter(|i| i.severity == dw_lint::Severity::Error).count();
    let fit = if m.fit.ok {
        format!("Autofit passt (Titel Stufe {}, Text Stufe {})", m.fit.head, m.fit.body)
    } else {
        "Autofit: Text läuft über, bitte kürzen".to_string()
    };
    let n = r.lint.len();
    let text = match n {
        0 => fit,
        1 => format!("{fit} · 1 Hinweis"),
        n => format!("{fit} · {n} Hinweise"),
    };
    let level = if !m.fit.ok || errors > 0 { 2 } else { i32::from(n > 0) };
    (text, level, r.lint.iter().take(3).map(|i| i.message.clone()).collect())
}

/// Bildschirmfotos für die Abnahme: Start, Editor, Anpassen, Export-Menü, Look, Einstellungen; danach beenden.
fn shots_run(ui: slint::Weak<AppWindow>, dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    // Debug-Builds rastern langsam: DW_SHOT_WAIT_MS
    let wait: u64 = std::env::var("DW_SHOT_WAIT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(4000);
    let steps: Vec<(u64, &'static str)> =
        vec![(wait, "start"), (1000, "start-decks"), (wait, "editor"), (wait, "editor-text"), (1500, "editor-anpassen"), (800, "export"), (wait, "look"), (800, "settings")];
    fn step(ui: slint::Weak<AppWindow>, dir: PathBuf, mut steps: Vec<(u64, &'static str)>) {
        if steps.is_empty() {
            let _ = slint::quit_event_loop();
            return;
        }
        let (ms, name) = steps.remove(0);
        Timer::single_shot(Duration::from_millis(ms), move || {
            let Some(w) = ui.upgrade() else { return };
            match w.window().take_snapshot() {
                Ok(buf) => {
                    let file = dir.join(format!("{name}.png"));
                    match image::RgbaImage::from_raw(buf.width(), buf.height(), buf.as_bytes().to_vec()).map(|img| img.save(&file)) {
                        Some(Ok(())) => eprintln!("Bild: {}", file.display()),
                        Some(Err(e)) => eprintln!("{}: {e}", file.display()),
                        None => eprintln!("{name}: Puffer passt nicht"),
                    }
                }
                Err(e) => eprintln!("Bildschirmfoto {name}: {e}"),
            }
            // nächste Ansicht vorbereiten
            match name {
                "start" => w.set_start_scroll(-(w.window().size().height as f32 / w.window().scale_factor() - 40.0)),
                "start-decks" => with_app(|a| {
                    if let Some(p) = a.shown.first().map(|&k| a.recent[k].path.clone()) {
                        a.open(&p);
                    }
                }),
                // Doppelklick auf den Titel und tippen: dw-edit auf der Folie
                "editor" => with_app(|a| {
                    if let Some(b) = a.text_el("title").map(|t| t.base.bbox) {
                        a.pointer(3, b.x + b.w - 2.0, b.y + b.h / 2.0, false);
                        let end: String = SharedString::from(slint::platform::Key::End).into();
                        a.edit_key(&end, true, false, false);
                        a.edit_key(" (bearbeitet)", false, false, false);
                    }
                }),
                "editor-text" => {
                    with_app(|a| a.commit_text());
                    w.set_panel("format".into());
                }
                "editor-anpassen" => w.set_export_open(true),
                "export" => {
                    w.set_export_open(false);
                    with_app(|a| a.look_open());
                }
                "look" => {
                    with_app(|a| a.look_close(false));
                    w.set_settings_page(5);
                    w.invoke_open_settings();
                }
                _ => {}
            }
            step(ui, dir, steps);
        });
    }
    step(ui, dir, steps);
}
