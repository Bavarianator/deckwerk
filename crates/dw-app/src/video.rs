//! Video-Bildschirm (video.slint): öffnen, Momente mit Start/Ende, Standbild-Vorschau, Export über ffmpeg aus dw-video.
// ponytail: Schnitt per concat-Filter direkt hier; Effekte/Einblendungen aus dw-video::cut/fx später anschließen.

use std::path::PathBuf;
use std::rc::Rc;

use dw_video::ffmpeg::{self, Cancel};
use slint::{ComponentHandle, Model, SharedString, VecModel};

use crate::{AppWindow, VClip, Video};

fn secs(s: &str) -> f64 {
    s.trim().replace(',', ".").parse().unwrap_or(0.0)
}

fn frame(file: &str, t: f64) -> Option<slint::Image> {
    let args: Vec<String> = ["-ss", &t.to_string(), "-i", file, "-frames:v", "1", "-vf", "scale=960:-2", "-f", "image2pipe", "-vcodec", "png", "-"]
        .iter().map(|s| s.to_string()).collect();
    let png = ffmpeg::run(&args, None, &Cancel::new()).ok()?;
    let img = image::load_from_memory(&png).ok()?.to_rgba8();
    let buf = slint::SharedPixelBuffer::<slint::Rgba8Pixel>::clone_from_slice(img.as_raw(), img.width(), img.height());
    Some(slint::Image::from_rgba8(buf))
}

pub fn wire(ui: &AppWindow, back: impl Fn() + 'static) {
    let v = ui.global::<Video>();
    let clips = Rc::new(VecModel::<VClip>::default());
    v.set_clips(clips.clone().into());
    v.on_back(back);
    let w = ui.as_weak();
    v.on_open(move || {
        let Some(p) = rfd::FileDialog::new().add_filter("Video", &["mp4", "mov", "mkv", "webm", "m4v"]).pick_file() else { return };
        let ui = w.unwrap();
        let v = ui.global::<Video>();
        let file = p.to_string_lossy().to_string();
        match ffmpeg::probe(&p) {
            Ok(pr) => v.set_status(format!("{:.1} s", pr.duration).into()),
            Err(e) => return v.set_status(format!("Kein Video: {e}").into()),
        }
        v.set_file(file.clone().into());
        if let Some(i) = frame(&file, 0.0) { v.set_frame(i) }
    });
    let c = clips.clone();
    v.on_add_clip(move || {
        let start = c.iter().last().map(|l| secs(&l.end)).unwrap_or(0.0);
        c.push(VClip { start: format!("{start}").into(), end: format!("{}", start + 10.0).into() });
    });
    let c = clips.clone();
    v.on_set_clip(move |i, s, e| c.set_row_data(i as usize, VClip { start: s, end: e }));
    let c = clips.clone();
    v.on_remove_clip(move |i| { c.remove(i as usize); });
    let w = ui.as_weak();
    v.on_preview(move |t| {
        let ui = w.unwrap();
        let v = ui.global::<Video>();
        if let Some(i) = frame(&v.get_file(), secs(&t)) { v.set_frame(i) }
    });
    let w = ui.as_weak();
    let c = clips.clone();
    v.on_export(move || {
        let ui = w.unwrap();
        let v = ui.global::<Video>();
        let file = v.get_file().to_string();
        let parts: Vec<(f64, f64)> = c.iter().map(|l| (secs(&l.start), secs(&l.end))).filter(|(a, b)| b > a).collect();
        if parts.is_empty() { return v.set_status("Kein gültiger Moment".into()) }
        let out = PathBuf::from(&file).with_extension("schnitt.mp4");
        let total: f64 = parts.iter().map(|(a, b)| b - a).sum();
        let mut args: Vec<String> = Vec::new();
        for (a, b) in &parts {
            args.extend(["-ss".into(), a.to_string(), "-to".into(), b.to_string(), "-i".into(), file.clone()]);
        }
        let ins: String = (0..parts.len()).map(|i| format!("[{i}:v][{i}:a]")).collect();
        args.extend(["-filter_complex".into(), format!("{ins}concat=n={}:v=1:a=1[v][a]", parts.len()), "-map".into(), "[v]".into(), "-map".into(), "[a]".into()]);
        args.extend(dw_video::export::video(dw_video::export::preset_for(total, false), false));
        args.extend(["-c:a".into(), "aac".into(), out.to_string_lossy().to_string()]);
        v.set_progress(0.0);
        v.set_status("Exportiere …".into());
        let w = w.clone();
        std::thread::spawn(move || {
            let set = |p: f32, s: Option<String>| {
                let w = w.clone();
                let _ = slint::invoke_from_event_loop(move || if let Some(ui) = w.upgrade() {
                    let v = ui.global::<Video>();
                    v.set_progress(p);
                    if let Some(s) = s { v.set_status(SharedString::from(s)) }
                });
            };
            let mut on = |t: f64| set((t / total) as f32, None);
            let r = ffmpeg::run(&args, Some(&mut on), &Cancel::new());
            set(-1.0, Some(match r { Ok(_) => format!("Fertig: {}", out.display()), Err(e) => format!("Export fehlgeschlagen: {e}") }));
        });
    });
}
