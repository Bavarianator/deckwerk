//! Podcast-Bühne: deck.podcast laden, Schnitte (clean-Semantik aus dw-podcast), Wellenform, Export per ffmpeg.
use crate::{AppWindow, PodCut, Podcast};
use dw_podcast::graph::{GraphOpts, build_graph, encode_args, graph_file, norm, peaks, peaks_args, script_flag};
use dw_podcast::{AutoClean, Episode, LUFS, auto_cuts};
use slint::{ComponentHandle, ModelRc, VecModel};
use std::path::{Path, PathBuf};

fn load(p: &Path) -> Option<(serde_json::Value, Episode)> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()?;
    let ep = serde_json::from_value(v.get("podcast")?.clone()).ok()?;
    Some((v, ep))
}

fn save(p: &Path, ep: &Episode) {
    if let Some((mut v, _)) = load(p) {
        v["podcast"] = serde_json::to_value(ep).unwrap_or_default();
        let _ = dw_store::write_atomic(p, serde_json::to_string_pretty(&v).unwrap_or_default().as_bytes());
    }
}

fn show(ui: &AppWindow, ep: &Episode) {
    let g = ui.global::<Podcast>();
    let f = |t: f64| format!("{}:{:04.1}", (t / 60.0) as u32, t % 60.0);
    g.set_tracks(ModelRc::new(VecModel::from(ep.tracks.iter().map(|t| t.name.clone().unwrap_or(t.src.clone()).into()).collect::<Vec<_>>())));
    g.set_cuts(ModelRc::new(VecModel::from(ep.cuts.iter().map(|c| PodCut {
        start: f(c.start).into(), end: f(c.end).into(),
        why: c.why.map(|w| format!("{w:?}")).unwrap_or_default().into(),
    }).collect::<Vec<_>>())));
    g.set_info(format!("{} → {}", f(ep.duration), f(dw_podcast::edited_length(&ep.cuts, ep.duration))).into());
}

/// true, wenn die Datei ein Podcast-Deck ist und die Bühne gezeigt wird
pub fn open(ui: &AppWindow, path: &Path) -> bool {
    let Some((_, ep)) = load(path) else { return false };
    show(ui, &ep);
    let g = ui.global::<Podcast>();
    g.set_progress(-1.0);
    // ponytail: Peaks nur der ersten Spur, synchron; Mix/Cache wenn lange Dateien stocken
    let src = ep.tracks.first().and_then(|t| dw_store::Store::open(dw_store::Edition::from_env()).ok()?.resolve_media(&t.src, path.parent()?).ok());
    if let (Some(src), Ok(bin)) = (src, dw_video::ffmpeg::ffmpeg_bin()) {
        if let Ok(o) = std::process::Command::new(bin).args(peaks_args(&src.display().to_string())).output() {
            if let Ok(pk) = peaks(&o.stdout[..]) {
                let step = (pk.data.len() / 600).max(1);
                let d: Vec<f32> = pk.data.chunks(step).map(|c| c.iter().cloned().fold(0.0, f64::max) as f32).collect();
                g.set_peaks(ModelRc::new(VecModel::from(d)));
            }
        }
    }
    let (w, p) = (ui.as_weak(), path.to_path_buf());
    g.on_remove_cut({ let (w, p) = (w.clone(), p.clone()); move |i| {
        let Some((_, mut ep)) = load(&p) else { return };
        if (i as usize) < ep.cuts.len() { ep.cuts.remove(i as usize); }
        save(&p, &ep);
        if let Some(ui) = w.upgrade() { show(&ui, &ep); }
    }});
    g.on_clean({ let (w, p) = (w.clone(), p.clone()); move || {
        let Some((_, mut ep)) = load(&p) else { return };
        // ponytail: ohne Transkript/Stille-Messung nur Hand-Schnitte + Regeln aus auto_cuts; dw-asr anschließen für Füllwörter
        ep.cuts = auto_cuts(&ep, None, &[], &AutoClean::default());
        save(&p, &ep);
        if let Some(ui) = w.upgrade() { show(&ui, &ep); }
    }});
    g.on_export({ let (w, p) = (w.clone(), p.clone()); move || export(w.clone(), p.clone()) });
    g.on_back(move || if let Some(ui) = w.upgrade() { ui.set_screen("start".into()) });
    ui.set_screen("podcast".into());
    true
}

fn export(w: slint::Weak<AppWindow>, p: PathBuf) {
    let Some((_, ep)) = load(&p) else { return };
    let Ok((inputs, graph)) = build_graph(&ep, &GraphOpts::default()) else { return };
    let (Ok(store), Some(dir)) = (dw_store::Store::open(dw_store::Edition::from_env()), p.parent()) else { return };
    // Quellen wie podcast.ts fileOf: nur Medien unter Deck- oder Asset-Ordner
    let mut args = Vec::new();
    for s in &inputs {
        let Ok(f) = store.resolve_media(s, dir) else { return };
        args.extend(["-i".to_string(), f.display().to_string()]);
    }
    let total = dw_podcast::edited_length(&ep.cuts, ep.duration).max(0.1);
    let out = p.with_file_name("podcast.mp3");
    let gfile = p.with_file_name(".podcast-graph.txt"); // neben dem Deck, nicht /tmp (tmpfs)
    // ponytail: Lautheit einstufig (loudnorm ohne Messlauf), Musik, Intro/Outro-Längen und Kapitel fehlen; measured_norm + meta_txt für volle TS-Gleichheit
    if std::fs::write(&gfile, graph_file(&graph, &norm(LUFS))).is_err() { return }
    let Ok(bin) = dw_video::ffmpeg::ffmpeg_bin() else { return };
    let ver = std::process::Command::new(&bin).arg("-version").output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    args.extend([script_flag(&ver).to_string(), gfile.display().to_string(), "-map".into(), "[a]".into()]);
    args.extend(encode_args("mp3"));
    args.extend(["-progress".into(), "pipe:1".into(), "-y".into(), out.display().to_string()]);
    std::thread::spawn(move || {
        use std::io::BufRead;
        let set = |v: f32| { let w = w.clone(); let _ = slint::invoke_from_event_loop(move || if let Some(ui) = w.upgrade() { ui.global::<Podcast>().set_progress(v) }); };
        let Ok(mut c) = std::process::Command::new(&bin).args(&args).stdout(std::process::Stdio::piped()).spawn() else { return };
        for l in std::io::BufReader::new(c.stdout.take().unwrap()).lines().map_while(Result::ok) {
            if let Some(us) = l.strip_prefix("out_time_us=").and_then(|s| s.parse::<f64>().ok()) { set((us / 1e6 / total).min(1.0) as f32); }
        }
        let _ = c.wait();
        let _ = std::fs::remove_file(&gfile);
        set(-1.0);
    });
}
