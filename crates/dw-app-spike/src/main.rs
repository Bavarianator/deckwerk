//! P0-Spike: Slint-Editor über der Rust-Engine. `dw-app-spike <deck.json> [--quit-after <s>]`

mod logic;

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use dw_model::{Deck, El, Measured};
use dw_raster::RasterOpts;
use dw_scene::{FontStore, render_slide};
use slint::{ComponentHandle, Model, Rgba8Pixel, SharedPixelBuffer, Timer, TimerMode, VecModel};

slint::include_modules!();

const STAGE_SCALE: f32 = 1.0;
const THUMB_SCALE: f32 = 0.15;

struct Job {
    seq: u64,
    deck: Arc<Deck>,
    index: usize,
    stage: bool,
}

struct Done {
    seq: u64,
    index: usize,
    stage: Option<SharedPixelBuffer<Rgba8Pixel>>,
    thumb: SharedPixelBuffer<Rgba8Pixel>,
    // Ok: (Measured, Satz ms, Raster ms); Err: Grund für den Platzhalter
    result: Result<(Measured, f64, f64), String>,
}

fn placeholder(w: f32, h: f32, scale: f32) -> SharedPixelBuffer<Rgba8Pixel> {
    let (w, h) = ((w * scale).round() as u32, (h * scale).round() as u32);
    let mut b = SharedPixelBuffer::<Rgba8Pixel>::new(w.max(1), h.max(1));
    b.make_mut_slice().fill(Rgba8Pixel::new(214, 214, 208, 255));
    b
}

fn run_job(job: &Job, fonts: &mut FontStore) -> Done {
    let size = job.deck.size();
    let t0 = Instant::now();
    let rendered = render_slide(&job.deck, job.index, fonts);
    let t_layout = t0.elapsed().as_secs_f64() * 1e3;
    let opts = RasterOpts::default();
    match rendered.map_err(|e| e.to_string()).and_then(|(scene, measured)| {
        let t1 = Instant::now();
        let raster = |scale| {
            dw_raster::render_rgba(&scene, scale, &opts)
                .map(|img| SharedPixelBuffer::clone_from_slice(img.as_raw(), img.width(), img.height()))
                .map_err(|e| e.to_string())
        };
        let stage = job.stage.then(|| raster(STAGE_SCALE)).transpose()?;
        let t_raster = t1.elapsed().as_secs_f64() * 1e3;
        let thumb = raster(THUMB_SCALE)?;
        Ok((stage, thumb, measured, t_raster))
    }) {
        Ok((stage, thumb, measured, t_raster)) => Done {
            seq: job.seq,
            index: job.index,
            stage,
            thumb,
            result: Ok((measured, t_layout, t_raster)),
        },
        Err(e) => Done {
            seq: job.seq,
            index: job.index,
            stage: job.stage.then(|| placeholder(size.w as f32, size.h as f32, STAGE_SCALE)),
            thumb: placeholder(size.w as f32, size.h as f32, THUMB_SCALE),
            result: Err(e),
        },
    }
}

/// Render-Thread: hält den FontStore, nimmt immer nur den neuesten Auftrag je Folie und Art.
fn worker(rx: Receiver<Job>) {
    let mut fonts = match FontStore::from_dir(&FontStore::default_dir()) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Schriften: {e}");
            FontStore::new()
        }
    };
    while let Ok(first) = rx.recv() {
        let mut jobs = vec![first];
        jobs.extend(rx.try_iter());
        let mut latest: Vec<Job> = Vec::new();
        for j in jobs {
            latest.retain(|l| (l.index, l.stage) != (j.index, j.stage));
            latest.push(j);
        }
        for job in latest {
            let done = run_job(&job, &mut fonts);
            let _ = slint::invoke_from_event_loop(move || {
                STATE.with(|s| {
                    if let Some(s) = s.borrow_mut().as_mut() {
                        s.apply(done);
                    }
                })
            });
        }
    }
}

struct State {
    ui: slint::Weak<AppWindow>,
    path: PathBuf,
    deck: Deck,
    index: usize,
    measured: Option<Measured>,
    sel: Option<String>,
    // (Slot, Originaltext für Esc)
    edit: Option<(String, String)>,
    seq: u64,
    tx: Sender<Job>,
    thumbs: Rc<VecModel<Thumb>>,
    info: String,
    msg: String,
    debounce: Timer,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with_state(f: impl FnOnce(&mut State)) {
    STATE.with(|s| {
        if let Some(s) = s.borrow_mut().as_mut() {
            f(s)
        }
    })
}

impl State {
    fn ui(&self) -> AppWindow {
        self.ui.upgrade().expect("Fenster")
    }

    fn request(&mut self, index: usize, stage: bool) {
        if stage {
            self.seq += 1;
        }
        let _ = self.tx.send(Job {
            seq: self.seq,
            deck: Arc::new(self.deck.clone()),
            index,
            stage,
        });
    }

    fn apply(&mut self, d: Done) {
        let ui = self.ui();
        let label = match &d.result {
            Ok(_) => String::new(),
            Err(_) => self.deck.slides[d.index].layout.clone(),
        };
        self.thumbs.set_row_data(
            d.index,
            Thumb {
                image: slint::Image::from_rgba8(d.thumb),
                label: label.clone().into(),
            },
        );
        let Some(stage) = d.stage else { return };
        if d.index != self.index || d.seq != self.seq {
            return; // veraltet: neuere Eingabe ist schon unterwegs
        }
        ui.set_stage_image(slint::Image::from_rgba8(stage));
        match d.result {
            Ok((m, tl, tr)) => {
                self.info = format!(
                    "Satz {tl:.1} ms + Raster {tr:.1} ms · Autofit Titel {} Text {}{}",
                    m.fit.head,
                    m.fit.body,
                    if m.fit.ok { "" } else { " (läuft über)" }
                );
                ui.set_placeholder("".into());
                eprintln!("Folie {}: {}", d.index + 1, self.info); // Messwerte für Skripte
                self.measured = Some(m);
            }
            Err(e) => {
                self.info = e;
                ui.set_placeholder(format!("Layout „{label}“ im Spike nicht unterstützt").into());
                self.measured = None;
            }
        }
        self.sync();
    }

    fn el(&self, slot: &str) -> Option<&El> {
        self.measured.as_ref()?.els.iter().find(|e| e.base().slot == slot)
    }

    /// Auswahl, Editor-Geometrie und Statuszeile aus dem Zustand neu setzen.
    fn sync(&self) {
        let ui = self.ui();
        ui.set_current(self.index as i32);
        let slot = self.edit.as_ref().map(|e| &e.0).or(self.sel.as_ref());
        let el = slot.and_then(|s| self.el(s));
        ui.set_sel_visible(el.is_some());
        if let Some(el) = el {
            let b = el.base().bbox;
            ui.set_sel_x(b.x as f32);
            ui.set_sel_y(b.y as f32);
            ui.set_sel_w(b.w as f32);
            ui.set_sel_h(b.h as f32);
            if let El::Text(t) = el {
                ui.set_edit_font_size(t.size_px as f32);
            }
        }
        let slide = &self.deck.slides[self.index];
        ui.set_status(
            format!(
                "Folie {}/{} · {} · {} · {}",
                self.index + 1,
                self.deck.slides.len(),
                slide.layout,
                self.info,
                if self.msg.is_empty() {
                    slot.map_or("keine Auswahl".to_string(), |s| format!("Auswahl: {s}"))
                } else {
                    self.msg.clone()
                }
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
        self.request(index, true);
        self.sync();
    }

    fn click(&mut self, x: f64, y: f64, w: f64, h: f64, double: bool) {
        if self.edit.is_some() {
            if !double {
                self.commit(); // Klick außerhalb des Editors beendet
            }
            return;
        }
        self.msg.clear();
        let size = self.deck.size();
        let (sx, sy) = logic::to_slide(x, y, w, h, size.w, size.h);
        self.sel = self
            .measured
            .as_ref()
            .and_then(|m| logic::hit(&m.els, sx, sy).map(|i| m.els[i].base().slot.clone()));
        if double {
            self.start_edit();
        }
        self.sync();
    }

    fn start_edit(&mut self) {
        let Some(slot) = self.sel.clone() else { return };
        if !matches!(self.el(&slot), Some(El::Text(_))) {
            return;
        }
        let content = &self.deck.slides[self.index].content;
        let Some(text) = logic::get_slot(content, &slot).map(str::to_string) else {
            self.msg = format!("{slot}: nicht bearbeitbar");
            self.sync();
            return;
        };
        let ui = self.ui();
        ui.set_edit_text(text.clone().into());
        self.edit = Some((slot, text));
        ui.set_editing(true);
        self.sync();
        ui.invoke_focus_editor();
    }

    fn edit_changed(&mut self, text: &str) {
        let Some((slot, _)) = &self.edit else { return };
        let slot = slot.clone();
        logic::set_slot(&mut self.deck.slides[self.index].content, &slot, text);
        self.debounce
            .start(TimerMode::SingleShot, Duration::from_millis(150), || {
                with_state(|s| {
                    let i = s.index;
                    s.request(i, true);
                });
            });
    }

    fn end_edit(&mut self) {
        self.edit = None;
        self.debounce.stop();
        let ui = self.ui();
        ui.set_editing(false);
        ui.invoke_focus_keys();
        let i = self.index;
        self.request(i, true);
        self.sync();
    }

    fn commit(&mut self) {
        if self.edit.is_some() {
            self.end_edit();
        }
    }

    fn cancel(&mut self) {
        if let Some((slot, orig)) = self.edit.clone() {
            logic::set_slot(&mut self.deck.slides[self.index].content, &slot, &orig);
            self.end_edit();
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
    while let Some(a) = args.next() {
        match a.as_str() {
            "--quit-after" => {
                quit_after = Some(args.next().context("--quit-after <s>")?.parse::<f64>()?)
            }
            "--type-test" => type_test = Some(args.next().context("--type-test <text>")?),
            _ if path.is_none() => path = Some(PathBuf::from(a)),
            _ => bail!("unbekanntes Argument: {a}"),
        }
    }
    let path = path
        .context("Aufruf: dw-app-spike <deck.json> [--quit-after <s>] [--type-test <text>]")?;
    let deck: Deck = serde_json::from_slice(
        &std::fs::read(&path).with_context(|| format!("{} lesen", path.display()))?,
    )
    .context("deck.json")?;
    if deck.slides.is_empty() {
        bail!("Deck ohne Folien");
    }

    let ui = AppWindow::new()?;
    let size = deck.size();
    ui.set_slide_w(size.w as f32);
    ui.set_slide_h(size.h as f32);
    ui.set_win_title(format!("Deckwerk-Spike – {}", deck.title).into());
    let thumbs = Rc::new(VecModel::from(
        (0..deck.slides.len())
            .map(|_| Thumb {
                image: slint::Image::from_rgba8(placeholder(size.w as f32, size.h as f32, THUMB_SCALE)),
                label: "".into(),
            })
            .collect::<Vec<_>>(),
    ));
    ui.set_thumbs(thumbs.clone().into());

    let (tx, rx) = channel();
    std::thread::spawn(move || worker(rx));
    let n = deck.slides.len();
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            ui: ui.as_weak(),
            path,
            deck,
            index: 0,
            measured: None,
            sel: None,
            edit: None,
            seq: 0,
            tx,
            thumbs,
            info: "rendert …".into(),
            msg: String::new(),
            debounce: Timer::default(),
        })
    });
    with_state(|s| {
        s.request(0, true);
        for i in 1..n {
            s.request(i, false);
        }
        s.sync();
    });

    ui.on_stage_clicked(|x, y, w, h, double| {
        with_state(|s| s.click(x.into(), y.into(), w.into(), h.into(), double))
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
    ui.on_start_edit(|| with_state(State::start_edit));
    ui.on_save(|| with_state(State::save));
    ui.on_edit_changed(|t| with_state(|s| s.edit_changed(&t)));
    ui.on_edit_commit(|| with_state(State::commit));
    ui.on_edit_cancel(|| with_state(State::cancel));
    ui.invoke_focus_keys();

    let _quit = quit_after.map(|secs| {
        let t = Timer::default();
        t.start(TimerMode::SingleShot, Duration::from_secs_f64(secs), || {
            let _ = slint::quit_event_loop();
        });
        t
    });
    let _test = type_test.map(|text| run_type_test(&ui, text));
    ui.run()?;
    Ok(())
}

/// Eingabetest über Slints Event-Schnittstelle (wie echte Tasten, aber ohne Plattform-IME):
/// Doppelklick auf den Titel, Text tippen, nach 3 s Enter und Strg+S.
fn run_type_test(ui: &AppWindow, text: String) -> Timer {
    use slint::platform::{Key, PointerEventButton, WindowEvent};
    let ui = ui.as_weak();
    let step = std::cell::Cell::new(0u32);
    let t = Timer::default();
    t.start(TimerMode::Repeated, Duration::from_millis(500), move || {
        let Some(ui) = ui.upgrade() else { return };
        let w = ui.window();
        let key = |k: slint::SharedString| {
            w.dispatch_event(WindowEvent::KeyPressed { text: k.clone() });
            w.dispatch_event(WindowEvent::KeyReleased { text: k });
        };
        match step.get() {
            0 => {
                // warten, bis die erste Folie gemessen ist; Stage-Ursprung wie im .slint (12 + 200 + 12, 12)
                let mut target = None;
                with_state(|s| {
                    let size = s.deck.size();
                    if let Some(b) = s.el("title").map(|e| e.base().bbox) {
                        let win = w.size().to_logical(w.scale_factor());
                        let (sw, sh) = (f64::from(win.width) - 236.0, f64::from(win.height) - 52.0);
                        let (f, ox, oy) = logic::fit(sw, sh, size.w, size.h);
                        target = Some((
                            224.0 + ox + (b.x + b.w / 2.0) * f,
                            12.0 + oy + (b.y + b.h / 2.0) * f,
                        ));
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
                for c in text.chars() {
                    key(c.to_string().into());
                }
            }
            6 => key(Key::Return.into()),
            7 => {
                w.dispatch_event(WindowEvent::KeyPressed { text: Key::Control.into() });
                key("s".into());
                w.dispatch_event(WindowEvent::KeyReleased { text: Key::Control.into() });
            }
            _ => {}
        }
        step.set(step.get() + 1);
    });
    t
}
