//! P0-Spike: Slint-Editor über der Rust-Engine, Folie per vello auf wgpu (Fallback vello_cpu),
//! Textbearbeitung mit dw-edit (parley, IME über winit).
//! `dw-app-spike <deck.json> [--quit-after <s>] [--type-test <text>] [--cpu]` (auch `DW_NO_GPU=1`)

mod logic;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use dw_edit::stage::{self, Hit, View};
use dw_edit::{Alignment, Editor, FontContext, Move, RichText, TextStyle};
use dw_model::{Align, Deck, El, FontRole, Measured, TextEl};
use dw_raster::RasterOpts;
use dw_scene::{FontStore, render_slide};
use kurbo::Point;
use slint::platform::Key;
use slint::winit_030::{EventResult, WinitWindowAccessor, winit};
use slint::{
    ComponentHandle, Model, Rgba8Pixel, SharedPixelBuffer, SharedString, Timer, TimerMode, VecModel,
};

slint::include_modules!();

const THUMB_SCALE: f32 = 0.15;
// Stage-Ursprung im Fenster wie im .slint (12 + 200 + 12, 12)
const STAGE_X: f64 = 224.;
const STAGE_Y: f64 = 12.;

struct Job {
    deck: Arc<Deck>,
    index: usize,
}

struct Done {
    index: usize,
    thumb: SharedPixelBuffer<Rgba8Pixel>,
    ok: bool,
}

fn placeholder(w: f32, h: f32, scale: f32) -> SharedPixelBuffer<Rgba8Pixel> {
    let (w, h) = ((w * scale).round() as u32, (h * scale).round() as u32);
    let mut b = SharedPixelBuffer::<Rgba8Pixel>::new(w.max(1), h.max(1));
    b.make_mut_slice().fill(Rgba8Pixel::new(214, 214, 208, 255));
    b
}

fn load_fonts() -> FontStore {
    FontStore::from_dir(&FontStore::default_dir()).unwrap_or_else(|e| {
        eprintln!("Schriften: {e}");
        FontStore::new()
    })
}

/// Thumbnail-Thread (vello_cpu): nimmt je Folie nur den neuesten Auftrag.
fn worker(rx: Receiver<Job>) {
    let mut fonts = load_fonts();
    while let Ok(first) = rx.recv() {
        let mut latest: Vec<Job> = Vec::new();
        for j in std::iter::once(first).chain(rx.try_iter()) {
            latest.retain(|l| l.index != j.index);
            latest.push(j);
        }
        for job in latest {
            let size = job.deck.size();
            let thumb = render_slide(&job.deck, job.index, &mut fonts)
                .map_err(|e| e.to_string())
                .and_then(|(scene, _)| {
                    dw_raster::render_rgba(&scene, THUMB_SCALE, &RasterOpts::default())
                        .map_err(|e| e.to_string())
                })
                .map(|img| {
                    SharedPixelBuffer::clone_from_slice(img.as_raw(), img.width(), img.height())
                });
            let done = Done {
                index: job.index,
                ok: thumb.is_ok(),
                thumb: thumb
                    .unwrap_or_else(|_| placeholder(size.w as f32, size.h as f32, THUMB_SCALE)),
            };
            let _ = slint::invoke_from_event_loop(move || with_state(|s| s.apply_thumb(done)));
        }
    }
}

/// Laufende Textbearbeitung.
struct Edit {
    slot: String,
    orig: String,
    ed: Editor,
    /// linke obere Ecke der Textbox auf der Folie
    origin: (f64, f64),
    dragging: bool,
}

/// Messwerte eines Bildes, das noch nicht auf dem Schirm ist.
struct Pending {
    t0: Instant,
    px: (u32, u32),
    key: bool,
    layout_ms: f64,
    draw_ms: f64,
}

struct State {
    ui: slint::Weak<AppWindow>,
    path: PathBuf,
    deck: Deck,
    index: usize,
    measured: Option<Measured>,
    sel: Option<String>,
    edit: Option<Edit>,
    fonts: FontStore,
    edit_fonts: FontContext,
    gpu: Option<dw_canvas::GpuCanvas>,
    want_gpu: bool,
    history: dw_edit::History,
    tx: Sender<Job>,
    thumbs: Rc<VecModel<Thumb>>,
    info: String,
    msg: String,
    pending: Option<Pending>,
    notifier: bool,
    key_ms: Vec<f64>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with_state(f: impl FnOnce(&mut State)) {
    STATE.with(|s| {
        // try_borrow: der Render-Notifier kann während eines eigenen Aufrufs feuern
        if let Ok(mut s) = s.try_borrow_mut()
            && let Some(s) = s.as_mut()
        {
            f(s)
        }
    })
}

fn key(k: Key) -> String {
    SharedString::from(k).into()
}

fn srect(r: kurbo::Rect, o: (f64, f64)) -> SRect {
    SRect {
        x: (r.x0 + o.0) as f32,
        y: (r.y0 + o.1) as f32,
        w: r.width() as f32,
        h: r.height() as f32,
    }
}

impl State {
    fn ui(&self) -> AppWindow {
        self.ui.upgrade().expect("Fenster")
    }

    fn request_thumb(&self, index: usize) {
        let _ = self.tx.send(Job {
            deck: Arc::new(self.deck.clone()),
            index,
        });
    }

    fn apply_thumb(&mut self, d: Done) {
        let label = if d.ok {
            String::new()
        } else {
            self.deck.slides[d.index].layout.clone()
        };
        self.thumbs.set_row_data(
            d.index,
            Thumb {
                image: slint::Image::from_rgba8(d.thumb),
                label: label.into(),
            },
        );
    }

    /// Nur die aktuelle Folie neu setzen (Autofit über dw-scene) und zeichnen, synchron.
    fn render_stage(&mut self, t0: Instant, from_key: bool) {
        if self.want_gpu && self.gpu.is_none() {
            return; // wartet auf RenderingSetup
        }
        let ui = self.ui();
        let tl = Instant::now();
        let rendered = render_slide(&self.deck, self.index, &mut self.fonts);
        let layout_ms = tl.elapsed().as_secs_f64() * 1e3;
        let (scene, m) = match rendered {
            Ok(r) => r,
            Err(e) => {
                let layout = self.deck.slides[self.index].layout.clone();
                ui.set_placeholder(format!("Layout „{layout}“ im Spike nicht unterstützt").into());
                self.info = e.to_string();
                self.measured = None;
                return self.sync();
            }
        };
        // Textur in Bildschirmauflösung der Stage (höchstens 2×)
        let scale = (ui.get_stage_f() * ui.window().scale_factor()).clamp(0.25, 2.);
        let td = Instant::now();
        let image = match &mut self.gpu {
            Some(g) => g
                .render(&scene, scale)
                .and_then(|t| slint::Image::try_from(t).map_err(|e| e.to_string())),
            None => dw_raster::render_rgba(&scene, scale, &RasterOpts::default())
                .map(|img| {
                    slint::Image::from_rgba8(SharedPixelBuffer::clone_from_slice(
                        img.as_raw(),
                        img.width(),
                        img.height(),
                    ))
                })
                .map_err(|e| e.to_string()),
        };
        let draw_ms = td.elapsed().as_secs_f64() * 1e3;
        match image {
            Ok(img) => ui.set_stage_image(img),
            Err(e) => eprintln!("Zeichnen: {e}"),
        }
        ui.set_placeholder("".into());
        self.info = format!(
            "{} · Satz {layout_ms:.1} ms + Zeichnen {draw_ms:.1} ms · Autofit Titel {} Text {}{}",
            if self.gpu.is_some() { "GPU" } else { "CPU" },
            m.fit.head,
            m.fit.body,
            if m.fit.ok { "" } else { " (läuft über)" }
        );
        self.measured = Some(m);
        self.pending = Some(Pending {
            t0,
            px: ((scene.width * scale) as u32, (scene.height * scale) as u32),
            key: from_key,
            layout_ms,
            draw_ms,
        });
        self.restyle_editor();
        self.sync();
        if !self.notifier {
            self.frame_done();
        }
    }

    /// Nach dem Frame: Zeit Taste → Bild auf dem Schirm.
    fn frame_done(&mut self) {
        let Some(p) = self.pending.take() else { return };
        let total = p.t0.elapsed().as_secs_f64() * 1e3;
        if p.key {
            self.key_ms.push(total);
        }
        eprintln!(
            "{} Folie {} ({}×{} px): {} {total:.1} ms{} (Satz {:.1} ms, Zeichnen {:.1} ms)",
            if self.gpu.is_some() { "GPU" } else { "CPU" },
            self.index + 1,
            p.px.0,
            p.px.1,
            if p.key { "Taste→Bild" } else { "Bild" },
            if self.notifier { "" } else { " bis Übergabe" },
            p.layout_ms,
            p.draw_ms
        );
    }

    fn el(&self, slot: &str) -> Option<&El> {
        self.measured
            .as_ref()?
            .els
            .iter()
            .find(|e| e.base().slot == slot)
    }

    /// Editor-Stil aus dem gemessenen Textelement und den Theme-Schriften (wie dw-scene `blocks::family`).
    fn text_style(&self, t: &TextEl) -> TextStyle {
        let theme = dw_theme::resolve_theme(&self.deck.theme, None);
        let (font, weight) = match t.font {
            FontRole::Head => (&theme.head.font, f32::from(theme.head.weight)),
            FontRole::Body => (&theme.body, 400.),
        };
        let mut family = match &t.font_face {
            Some(f) => format!("'{f}'"),
            None => format!("'{}'", font.css),
        };
        if let Some(fb) = &font.fallback {
            family += &format!(", '{fb}'");
        }
        TextStyle {
            family: family + ", 'IBM Plex Sans'",
            size: t.size_px as f32,
            line_height: (t.line_height_px / t.size_px) as f32,
            tracking_px: t.tracking_px as f32,
            weight,
            width: Some(t.base.bbox.w as f32 + 0.01),
            align: match t.align {
                Align::Left => Alignment::Start,
                Align::Center => Alignment::Center,
                Align::Right => Alignment::End,
            },
            upper: t.upper,
            ..TextStyle::default()
        }
    }

    /// Autofit kann Größe und Box ändern: Editor-Layout nachziehen.
    fn restyle_editor(&mut self) {
        let Some(slot) = self.edit.as_ref().map(|e| e.slot.clone()) else {
            return;
        };
        let Some(El::Text(t)) = self.el(&slot).cloned() else {
            return;
        };
        let style = self.text_style(&t);
        if let Some(e) = &mut self.edit {
            e.origin = (t.base.bbox.x, t.base.bbox.y);
            e.ed.set_style(style);
        }
    }

    /// Auswahl, Editor-Overlay und Statuszeile aus dem Zustand neu setzen.
    fn sync(&self) {
        let ui = self.ui();
        ui.set_current(self.index as i32);
        let slot = self.edit.as_ref().map(|e| &e.slot).or(self.sel.as_ref());
        let el = slot.and_then(|s| self.el(s));
        ui.set_sel_visible(el.is_some());
        if let Some(el) = el {
            let b = el.base().bbox;
            ui.set_sel_x(b.x as f32);
            ui.set_sel_y(b.y as f32);
            ui.set_sel_w(b.w as f32);
            ui.set_sel_h(b.h as f32);
        }
        match &self.edit {
            Some(e) => {
                let caret = e.ed.cursor_rect(2.);
                ui.set_caret_visible(caret.is_some());
                if let Some(c) = caret {
                    ui.set_caret(srect(c, e.origin));
                }
                let rects = |v: Vec<kurbo::Rect>| {
                    let v: Vec<SRect> = v.into_iter().map(|r| srect(r, e.origin)).collect();
                    slint::ModelRc::new(VecModel::from(v))
                };
                ui.set_sel_rects(rects(e.ed.selection_rects()));
                ui.set_compose_rects(rects(e.ed.compose_rects()));
                // IME-Kandidatenfenster unter den Cursor (Stage-Versatz der eingepassten Folie)
                let win = ui.window().size().to_logical(ui.window().scale_factor());
                let v = self.view(f64::from(win.width) - 236., f64::from(win.height) - 52.);
                let r = e.ed.focus_rect();
                let p = v.to_screen(Point::new(r.x0 + e.origin.0, r.y0 + e.origin.1));
                ui.window().with_winit_window(|w| {
                    w.set_ime_cursor_area(
                        winit::dpi::LogicalPosition::new(STAGE_X + p.x, STAGE_Y + p.y),
                        winit::dpi::LogicalSize::new(2., r.height() * v.zoom),
                    )
                });
            }
            None => {
                ui.set_caret_visible(false);
                ui.set_sel_rects(Default::default());
                ui.set_compose_rects(Default::default());
            }
        }
        let slide = &self.deck.slides[self.index];
        let state = if !self.msg.is_empty() {
            self.msg.clone()
        } else if let Some(e) = &self.edit {
            format!(
                "bearbeitet: {}{}{}",
                e.slot,
                if e.ed.typing_attrs().bold {
                    " · fett"
                } else {
                    ""
                },
                if e.ed.is_composing() { " · IME" } else { "" }
            )
        } else {
            slot.map_or("keine Auswahl".to_string(), |s| format!("Auswahl: {s}"))
        };
        ui.set_status(
            format!(
                "Folie {}/{} · {} · {} · {}",
                self.index + 1,
                self.deck.slides.len(),
                slide.layout,
                self.info,
                state
            )
            .into(),
        );
    }

    fn go(&mut self, index: usize) {
        self.commit();
        if index >= self.deck.slides.len() {
            return;
        }
        self.index = index;
        self.sel = None;
        self.measured = None;
        self.msg.clear();
        self.render_stage(Instant::now(), false);
    }

    fn view(&self, w: f64, h: f64) -> View {
        let size = self.deck.size();
        View::fit((w, h), (size.w, size.h))
    }

    /// Zeiger auf der Stage: 0 gedrückt, 1 gezogen, 2 losgelassen, 3 Doppelklick.
    fn pointer(&mut self, kind: i32, x: f64, y: f64, w: f64, h: f64, shift: bool) {
        let p = self.view(w, h).to_slide(Point::new(x, y));
        if let Some(e) = &self.edit {
            let inside = self
                .el(&e.slot)
                .is_some_and(|el| stage::Geo::of_el(el).contains(p));
            let e = self.edit.as_mut().expect("bearbeitet");
            let (lx, ly) = ((p.x - e.origin.0) as f32, (p.y - e.origin.1) as f32);
            match kind {
                0 if inside => {
                    e.ed.click(lx, ly, shift);
                    e.dragging = true;
                }
                0 => return self.commit(), // Klick außerhalb beendet
                1 if e.dragging => e.ed.drag_to(lx, ly),
                2 => e.dragging = false,
                3 if inside => e.ed.double_click(lx, ly),
                _ => return,
            }
            return self.sync();
        }
        if kind != 0 && kind != 3 {
            return;
        }
        self.msg.clear();
        let items = self.deck.slides[self.index].items.as_deref().unwrap_or(&[]);
        // freie Elemente treffen zuerst; bearbeitbar sind im Spike nur Layout-Texte
        self.sel = self
            .measured
            .as_ref()
            .and_then(|m| match stage::hit(&m.els, items, p) {
                Some(Hit::El(i)) => Some(m.els[i].base().slot.clone()),
                _ => None,
            });
        if kind == 3 {
            self.start_edit(Some(p));
        }
        self.sync();
    }

    fn start_edit(&mut self, at: Option<Point>) {
        let Some(slot) = self.sel.clone() else { return };
        let Some(El::Text(t)) = self.el(&slot).cloned() else {
            return;
        };
        let Some(text) =
            logic::get_slot(&self.deck.slides[self.index].content, &slot).map(str::to_string)
        else {
            self.msg = format!("{slot}: nicht bearbeitbar");
            return self.sync();
        };
        let mut ed = Editor::new(
            self.edit_fonts.clone(),
            RichText::parse(&text),
            self.text_style(&t),
        );
        let origin = (t.base.bbox.x, t.base.bbox.y);
        match at {
            Some(p) => ed.click((p.x - origin.0) as f32, (p.y - origin.1) as f32, false),
            None => ed.select_all(),
        }
        self.edit = Some(Edit {
            slot,
            orig: text,
            ed,
            origin,
            dragging: false,
        });
        let ui = self.ui();
        ui.set_editing(true);
        ui.invoke_focus_editor();
        ui.window().with_winit_window(|w| w.set_ime_allowed(true));
        self.sync();
    }

    /// Editor → deck.json → Neusatz der Folie.
    fn edited(&mut self, t0: Instant) {
        let Some(e) = &self.edit else { return };
        let ser = e.ed.doc().serialize();
        let slot = e.slot.clone();
        // Layout-Slots kennen nur **fett** und Links: Kursiv/Farbe/Unspeicherbares nicht still verwerfen
        let warn = ser.lossy || ser.italic || ser.color.is_some();
        let note = "Format (kursiv/Farbe/Sonderzeichen) lässt sich im Slot nicht speichern";
        if warn && self.msg != note {
            eprintln!("{slot}: {note}");
        }
        self.msg = if warn { note.into() } else { String::new() };
        logic::set_slot(&mut self.deck.slides[self.index].content, &slot, &ser.text);
        self.render_stage(t0, true);
    }

    /// Taste im Editor; true = verbraucht.
    fn edit_key(&mut self, text: &str, ctrl: bool, shift: bool, alt: bool) -> bool {
        let t0 = Instant::now();
        let Some(e) = &mut self.edit else {
            return false;
        };
        let ed = &mut e.ed;
        let before = ed.doc().clone();
        let lower = text.to_lowercase();
        let mv = |m: Move, ed: &mut Editor| ed.move_cursor(m, shift);
        // Slints Sondertasten liegen im Unicode-Privatbereich
        let special = text
            .chars()
            .any(|c| c.is_control() || ('\u{f700}'..='\u{f8ff}').contains(&c));
        if text == key(Key::Escape) {
            if ed.is_composing() {
                ed.cancel_compose();
            } else {
                self.cancel();
                return true;
            }
        } else if text == key(Key::Return) && !shift {
            self.commit();
            return true;
        } else if text == key(Key::Return) {
            ed.insert("\n");
        } else if text == key(Key::Backspace) {
            if ctrl {
                ed.backspace_word()
            } else {
                ed.backspace()
            }
        } else if text == key(Key::Delete) {
            if ctrl { ed.delete_word() } else { ed.delete() }
        } else if text == key(Key::LeftArrow) {
            mv(if ctrl { Move::WordLeft } else { Move::Left }, ed)
        } else if text == key(Key::RightArrow) {
            mv(if ctrl { Move::WordRight } else { Move::Right }, ed)
        } else if text == key(Key::UpArrow) {
            mv(Move::Up, ed)
        } else if text == key(Key::DownArrow) {
            mv(Move::Down, ed)
        } else if text == key(Key::Home) {
            mv(if ctrl { Move::Start } else { Move::LineStart }, ed)
        } else if text == key(Key::End) {
            mv(if ctrl { Move::End } else { Move::LineEnd }, ed)
        } else if ctrl && lower == "b" {
            ed.toggle_bold();
        } else if ctrl && lower == "i" {
            ed.toggle_italic();
        } else if ctrl && lower == "a" {
            ed.select_all();
        } else if ctrl && (lower == "y" || (lower == "z" && shift)) {
            ed.redo();
        } else if ctrl && lower == "z" {
            ed.undo();
        } else if ctrl && lower == "s" {
            self.commit();
            self.save();
            return true;
        } else if !ctrl && !alt && !text.is_empty() && !special {
            ed.insert(text);
        } else {
            return false;
        }
        if *ed.doc() != before {
            self.edited(t0);
        } else {
            self.sync();
        }
        true
    }

    fn ime(&mut self, ev: &winit::event::Ime) {
        let t0 = Instant::now();
        let Some(e) = &mut self.edit else { return };
        let before = e.ed.doc().clone();
        match ev {
            winit::event::Ime::Preedit(text, cursor) => e.ed.set_compose(text, *cursor),
            winit::event::Ime::Commit(text) => e.ed.commit_compose(text),
            _ => return,
        }
        // Compositor schickt auch leere Preedits ohne Änderung: dann nur das Overlay
        if *e.ed.doc() != before {
            self.edited(t0);
        } else {
            self.sync();
        }
    }

    fn end_edit(&mut self) {
        self.edit = None;
        let ui = self.ui();
        ui.set_editing(false);
        ui.invoke_focus_keys();
        ui.window().with_winit_window(|w| w.set_ime_allowed(false));
        self.request_thumb(self.index);
        self.render_stage(Instant::now(), false);
    }

    /// Bearbeitung übernehmen: ein Undo-Schritt im Deck (Patch, kein Snapshot).
    fn commit(&mut self) {
        let Some(e) = self.edit.take() else { return };
        let now = serde_json::to_value(&self.deck).expect("Deck → JSON");
        // Stand vor der Bearbeitung als Basis, damit der Patch genau diese Änderung enthält
        let mut doc = now.clone();
        if let Some(c) = doc["slides"][self.index].get_mut("content") {
            logic::set_slot(c, &e.slot, &e.orig);
        }
        self.history.commit(&mut doc, now, None);
        self.end_edit();
    }

    fn cancel(&mut self) {
        if let Some(e) = self.edit.take() {
            logic::set_slot(&mut self.deck.slides[self.index].content, &e.slot, &e.orig);
            self.end_edit();
        }
    }

    fn undo(&mut self, redo: bool) {
        let mut v = serde_json::to_value(&self.deck).expect("Deck → JSON");
        let done = if redo {
            self.history.redo(&mut v)
        } else {
            self.history.undo(&mut v)
        };
        let done = done.unwrap_or_else(|e| {
            self.msg = format!("Rückgängig nicht möglich: {e}");
            eprintln!("{}", self.msg);
            self.sync();
            false
        });
        if done && let Ok(d) = serde_json::from_value::<Deck>(v) {
            self.deck = d;
            self.request_thumb(self.index);
            self.render_stage(Instant::now(), false);
        }
    }

    fn save(&mut self) {
        let out = logic::edited_path(&self.path);
        self.msg = match serde_json::to_vec_pretty(&self.deck)
            .map_err(anyhow::Error::from)
            .and_then(|b| Ok(logic::save_atomic(&out, &b)?))
        {
            Ok(()) => format!("gespeichert: {}", out.display()),
            Err(e) => format!("Speichern fehlgeschlagen: {e}"),
        };
        self.sync();
    }
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let (mut path, mut quit_after, mut type_test) = (None, None, None);
    let mut want_gpu = std::env::var_os("DW_NO_GPU").is_none();
    while let Some(a) = args.next() {
        match a.as_str() {
            "--quit-after" => {
                quit_after = Some(args.next().context("--quit-after <s>")?.parse::<f64>()?)
            }
            "--type-test" => type_test = Some(args.next().context("--type-test <text>")?),
            "--cpu" => want_gpu = false,
            _ if path.is_none() => path = Some(PathBuf::from(a)),
            _ => bail!("unbekanntes Argument: {a}"),
        }
    }
    let path = path.context(
        "Aufruf: dw-app-spike <deck.json> [--quit-after <s>] [--type-test <text>] [--cpu]",
    )?;
    let deck: Deck = serde_json::from_slice(
        &std::fs::read(&path).with_context(|| format!("{} lesen", path.display()))?,
    )
    .context("deck.json")?;
    if deck.slides.is_empty() {
        bail!("Deck ohne Folien");
    }

    // GPU: Slint rendert mit femtovg auf wgpu 30, vello teilt Device und Queue. Sonst Software-Renderer + vello_cpu.
    if want_gpu
        && let Err(e) = slint::BackendSelector::new()
            .backend_name("winit".into())
            .require_wgpu_30(slint::wgpu_30::WGPUConfiguration::Automatic({
                let mut w = slint::wgpu_30::WGPUSettings::default();
                w.device_required_limits = dw_canvas::required_limits();
                w
            }))
            .select()
    {
        eprintln!("Kein wgpu verfügbar ({e}), Fallback vello_cpu");
        want_gpu = false;
    }
    if !want_gpu {
        slint::BackendSelector::new()
            .backend_name("winit".into())
            .renderer_name("software".into())
            .select()
            .context("Slint-Backend")?;
    }

    let ui = match AppWindow::new() {
        Ok(ui) => ui,
        Err(e) if want_gpu => return rerun_cpu(&e.to_string()),
        Err(e) => return Err(e.into()),
    };
    let size = deck.size();
    ui.set_slide_w(size.w as f32);
    ui.set_slide_h(size.h as f32);
    ui.set_win_title(format!("Deckwerk-Spike – {}", deck.title).into());
    let thumbs = Rc::new(VecModel::from(
        (0..deck.slides.len())
            .map(|_| Thumb {
                image: slint::Image::from_rgba8(placeholder(
                    size.w as f32,
                    size.h as f32,
                    THUMB_SCALE,
                )),
                label: "".into(),
            })
            .collect::<Vec<_>>(),
    ));
    ui.set_thumbs(thumbs.clone().into());

    let (tx, rx) = channel();
    std::thread::spawn(move || worker(rx));
    let n = deck.slides.len();
    let edit_fonts = dw_edit::font_context_from_dir(&FontStore::default_dir())
        .unwrap_or_else(|_| dw_edit::font_context([]));
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            ui: ui.as_weak(),
            path,
            deck,
            index: 0,
            measured: None,
            sel: None,
            edit: None,
            fonts: load_fonts(),
            edit_fonts,
            gpu: None,
            want_gpu,
            history: dw_edit::History::default(),
            tx,
            thumbs,
            info: "rendert …".into(),
            msg: String::new(),
            pending: None,
            notifier: false,
            key_ms: Vec::new(),
        })
    });
    with_state(|s| {
        for i in 0..n {
            s.request_thumb(i);
        }
        s.render_stage(Instant::now(), false); // CPU sofort, GPU nach RenderingSetup
        s.sync();
    });

    // Software-Renderer kennt keine Notifier: dann wird bis zur Bildübergabe gemessen (frame_done direkt)
    let notifier = ui
        .window()
        .set_rendering_notifier(|state, api| match (state, api) {
            (
                slint::RenderingState::RenderingSetup,
                slint::GraphicsAPI::WGPU30 { device, queue, .. },
            ) => {
                let t = Instant::now();
                let gpu = dw_canvas::GpuCanvas::new(device.clone(), queue.clone());
                let ms = t.elapsed().as_secs_f64() * 1e3;
                // nicht im Notifier selbst rendern: erst nach dem laufenden Frame
                let _ = slint::invoke_from_event_loop(move || {
                    with_state(|s| {
                        match gpu {
                            Ok(g) => {
                                eprintln!("GPU: vello auf wgpu bereit ({ms:.0} ms Shader)");
                                s.gpu = Some(g);
                            }
                            Err(e) => {
                                eprintln!("vello-GPU nicht nutzbar ({e}), Fallback vello_cpu");
                                s.want_gpu = false;
                            }
                        }
                        s.render_stage(Instant::now(), false);
                    })
                });
            }
            (slint::RenderingState::RenderingSetup, _) => with_state(|s| {
                if s.want_gpu {
                    eprintln!("Renderer ohne wgpu, Fallback vello_cpu");
                    s.want_gpu = false;
                    let _ = slint::invoke_from_event_loop(|| {
                        with_state(|s| s.render_stage(Instant::now(), false))
                    });
                }
                eprintln!("CPU: vello_cpu + Slint-Software-Renderer");
            }),
            (slint::RenderingState::AfterRendering, _) => with_state(State::frame_done),
            _ => {}
        });
    with_state(|s| s.notifier = notifier.is_ok());

    // IME direkt von winit: Slint gibt Preedit/Commit nur an TextInput weiter
    ui.window().on_winit_window_event(|_, ev| {
        if let winit::event::WindowEvent::Ime(ime) = ev {
            let mut used = false;
            with_state(|s| {
                used = s.edit.is_some();
                s.ime(ime);
            });
            if used {
                return EventResult::PreventDefault;
            }
        }
        EventResult::Propagate
    });

    ui.on_stage_pointer(|k, x, y, w, h, shift| {
        with_state(|s| s.pointer(k, x.into(), y.into(), w.into(), h.into(), shift))
    });
    ui.on_select_slide(|i| with_state(|s| s.go(i as usize)));
    ui.on_nav(|d| {
        with_state(|s| {
            if let Some(i) = s.index.checked_add_signed(d as isize) {
                s.go(i)
            }
        })
    });
    ui.on_deselect(|| {
        with_state(|s| {
            s.sel = None;
            s.msg.clear();
            s.sync();
        })
    });
    ui.on_start_edit(|| with_state(|s| s.start_edit(None)));
    ui.on_save(|| with_state(State::save));
    ui.on_undo(|redo| with_state(|s| s.undo(redo)));
    ui.on_edit_key(|t, ctrl, shift, alt| {
        let mut used = false;
        with_state(|s| used = s.edit_key(&t, ctrl, shift, alt));
        used
    });
    ui.invoke_focus_keys();

    let _quit = quit_after.map(|secs| {
        let t = Timer::default();
        t.start(TimerMode::SingleShot, Duration::from_secs_f64(secs), || {
            with_state(|s| {
                if !s.key_ms.is_empty() {
                    let mut v = s.key_ms.clone();
                    v.sort_by(f64::total_cmp);
                    eprintln!(
                        "Taste→Bild ({}): {} Tasten, Median {:.1} ms, max {:.1} ms",
                        if s.gpu.is_some() { "GPU" } else { "CPU" },
                        v.len(),
                        v[v.len() / 2],
                        v[v.len() - 1]
                    );
                }
            });
            let _ = slint::quit_event_loop();
        });
        t
    });
    let _test = type_test.map(|text| run_type_test(&ui, text));
    match ui.run() {
        // wgpu fand kein passendes Gerät für das Fenster (z. B. Xvfb ohne DRI3): neu starten mit vello_cpu
        Err(e) if want_gpu && with_state_ret(|s| s.gpu.is_none()) => rerun_cpu(&e.to_string()),
        r => Ok(r?),
    }
}

fn with_state_ret(f: impl FnOnce(&State) -> bool) -> bool {
    let mut out = false;
    with_state(|s| out = f(s));
    out
}

/// Die Plattform lässt sich nach dem ersten Fenster nicht neu wählen; deshalb derselbe Aufruf mit `--cpu`.
fn rerun_cpu(why: &str) -> Result<()> {
    eprintln!("GPU-Start fehlgeschlagen ({why}), Fallback vello_cpu");
    let status = std::process::Command::new(std::env::current_exe()?)
        .args(std::env::args().skip(1))
        .arg("--cpu")
        .status()?;
    std::process::exit(status.code().unwrap_or(1));
}

/// Eingabetest über Slints Event-Schnittstelle (wie echte Tasten, aber ohne Plattform-IME):
/// Doppelklick auf den Titel, Strg+A, Text Taste für Taste (je 100 ms, damit jede Taste ein Bild bekommt),
/// Umschalt+← ×3 und Strg+B, IME-Preedit und -Commit über denselben Weg wie winit, dann Enter und Strg+S.
fn run_type_test(ui: &AppWindow, text: String) -> Timer {
    use slint::platform::{PointerEventButton, WindowEvent};
    let ui = ui.as_weak();
    let step = std::cell::Cell::new(0usize);
    let chars: Vec<char> = text.chars().collect();
    let t = Timer::default();
    t.start(TimerMode::Repeated, Duration::from_millis(100), move || {
        let Some(ui) = ui.upgrade() else { return };
        let w = ui.window();
        let press = |k: SharedString| {
            w.dispatch_event(WindowEvent::KeyPressed { text: k.clone() });
            w.dispatch_event(WindowEvent::KeyReleased { text: k });
        };
        let with_mod = |m: Key, k: SharedString| {
            w.dispatch_event(WindowEvent::KeyPressed { text: m.into() });
            press(k);
            w.dispatch_event(WindowEvent::KeyReleased { text: m.into() });
        };
        let i = step.get();
        let n = chars.len();
        match i {
            0 => {
                // warten, bis die erste Folie gemessen ist
                let mut target = None;
                with_state(|s| {
                    if let Some(b) = s.el("title").map(|e| e.base().bbox) {
                        let win = w.size().to_logical(w.scale_factor());
                        let v = s.view(f64::from(win.width) - 236., f64::from(win.height) - 52.);
                        let p = v.to_screen(Point::new(b.x + b.w / 2., b.y + b.h / 2.));
                        target = Some((STAGE_X + p.x, STAGE_Y + p.y));
                    }
                });
                let Some((x, y)) = target else { return };
                let position = slint::LogicalPosition::new(x as f32, y as f32);
                for _ in 0..2 {
                    let button = PointerEventButton::Left;
                    w.dispatch_event(WindowEvent::PointerMoved { position });
                    w.dispatch_event(WindowEvent::PointerPressed { position, button });
                    w.dispatch_event(WindowEvent::PointerReleased { position, button });
                }
            }
            1 => with_mod(Key::Control, "a".into()),
            _ if i - 2 < n => press(chars[i - 2].to_string().into()),
            _ if i - 2 == n => {
                for _ in 0..3 {
                    with_mod(Key::Shift, Key::LeftArrow.into());
                }
                with_mod(Key::Control, "b".into());
            }
            _ if i - 2 == n + 1 => with_state(|s| {
                if let Some(e) = &mut s.edit {
                    e.ed.move_cursor(Move::End, false);
                }
                s.ime(&winit::event::Ime::Preedit(" にほ".into(), Some((7, 7))));
            }),
            _ if i - 2 == n + 2 => with_state(|s| {
                s.ime(&winit::event::Ime::Preedit(String::new(), None));
                s.ime(&winit::event::Ime::Commit(" 日本".into()));
                if let Some(e) = &s.edit {
                    eprintln!("Text nach IME: {}", e.ed.doc().serialize().text);
                }
            }),
            _ if i - 2 == n + 4 => press(Key::Return.into()),
            _ if i - 2 == n + 5 => with_mod(Key::Control, "s".into()),
            _ => {}
        }
        step.set(i + 1);
    });
    t
}
