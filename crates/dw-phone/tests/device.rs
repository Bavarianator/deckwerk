//! Am echten Handy (nur mit DW_PHONE=1 und `-- --ignored`): Clip-Export PC+Handy, Abbruch, Spracherkennung.
//! Eigene Dateien nur unter PHONE_DIR/rust-test, danach weg; Programme und Modelle der App werden mitbenutzt.
//! Modelle wie in der App unter $DECKWERK_HOME/models (Standard ~/Deckwerk/models).

use dw_phone::{PHONE_DIR, Phone, PhoneRunner, plan_remote};
use dw_video::export::{ClipJob, FinishOpts, SegOpts, clip_segs, clip_segs_with, finish};
use dw_video::ffmpeg::{self, Cancel, Error};
use dw_video::{Part, Size};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// ein Test zur Zeit aufs Handy
static ONE: Mutex<()> = Mutex::new(());

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn models() -> PathBuf {
    std::env::var_os("DECKWERK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap()).join("Deckwerk"))
        .join("models")
}

/// Handy mit eigenem Arbeitsordner; wartet, solange der Nutzer gerade transkribiert
fn phone() -> Option<Phone> {
    if std::env::var("DW_PHONE").as_deref() != Ok("1") {
        eprintln!("übersprungen: DW_PHONE=1 fehlt");
        return None;
    }
    let mut p = Phone::detect().expect("kein Handy per adb verbunden");
    let t0 = Instant::now();
    while p
        .shell("ps -A | grep sherpa; true")
        .unwrap()
        .contains("sherpa")
    {
        assert!(
            t0.elapsed() < Duration::from_secs(1800),
            "sherpa läuft seit 30 min auf dem Handy"
        );
        eprintln!("Handy transkribiert gerade, warte …");
        std::thread::sleep(Duration::from_secs(20));
    }
    p.work = format!("{PHONE_DIR}/rust-test");
    Some(p)
}

fn cleanup(p: &Phone) {
    assert!(p.work.ends_with("/rust-test"));
    p.shell(&format!("rm -rf {}", p.work)).unwrap();
}

fn work(name: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("dw-phone-device")
        .join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn decodes(f: &Path) {
    let o = std::process::Command::new(ffmpeg::ffmpeg_bin().unwrap())
        .args(["-v", "error", "-i"])
        .arg(f)
        .args(["-f", "null", "-"])
        .output()
        .unwrap();
    assert!(
        o.status.success() && o.stderr.is_empty(),
        "{}: {}",
        f.display(),
        String::from_utf8_lossy(&o.stderr)
    );
}

#[test]
#[ignore]
fn clip_export_handy_und_pc() {
    let Some(p) = phone() else { return };
    let _g = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let root = work("clip");
    let src = root.join("quelle.mp4");
    ffmpeg::run(
        &s(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=1920x1080:rate=30:duration=14",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=14",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            &src.to_string_lossy(),
        ]),
        None,
        &Cancel::new(),
    )
    .unwrap();
    let dir = root.join("job");
    std::fs::create_dir_all(&dir).unwrap();
    let parts = vec![
        Part {
            start: 1.0,
            end: 6.0,
            ..Default::default()
        },
        Part {
            start: 7.0,
            end: 12.0,
            transition: Some("wipe".into()),
            ..Default::default()
        },
    ];
    let mut job = ClipJob::new(
        &src,
        parts,
        Size {
            w: 1080.0,
            h: 1920.0,
        },
    );
    job.captions = "aus".into();
    job.hook = Some("Handy-Test".into()); // ass + fonts/ müssen mit aufs Handy
    let o = SegOpts {
        preset: "veryfast".into(),
        ..Default::default()
    };
    let run = PhoneRunner::new(p.clone(), models());

    let t = Instant::now();
    let mut seen = Vec::new();
    let mut cb = |x: f64| seen.push(x);
    let handy =
        clip_segs_with(&run, &job, "handy", &dir, &o, Some(&mut cb), &Cancel::new()).unwrap();
    let t_handy = t.elapsed();
    assert_eq!(run.fault(), None, "Handy ist ausgestiegen: {}", run.label());
    assert!(
        seen.last().is_some_and(|&x| x > 50.0),
        "Fortschritt {seen:?}"
    );
    // zweiter Lauf: Quelle liegt schon im Cache auf dem Handy
    let t = Instant::now();
    clip_segs_with(&run, &job, "handy2", &dir, &o, None, &Cancel::new()).unwrap();
    let t_handy2 = t.elapsed();
    let t = Instant::now();
    let pc = clip_segs(&job, "pc", &dir, &o, None, &Cancel::new()).unwrap();
    let t_pc = t.elapsed();
    eprintln!(
        "Clip-Gruppen 2×5 s 1080×1920 veryfast: Handy {t_handy:?} (mit Upload), Handy {t_handy2:?} (Quelle im Cache), PC {t_pc:?}"
    );
    for seg in handy.iter().chain(&pc) {
        decodes(Path::new(&seg.file));
    }
    // gemischt: Handy- und PC-Zwischenstände per concat -c:v copy in eine Datei
    let segs: Vec<_> = handy.iter().chain(&pc).cloned().collect();
    let out = dir.join("gemischt.mp4");
    finish(
        &segs,
        &out,
        &dir,
        &FinishOpts {
            loudnorm: true,
            ..Default::default()
        },
        None,
        &Cancel::new(),
    )
    .unwrap();
    decodes(&out);
    let len: f64 = segs.iter().map(|x| x.dur).sum();
    let r = ffmpeg::probe(&out).unwrap();
    assert!(
        (r.duration - len).abs() < 0.15,
        "MP4 {} s statt {len} s",
        r.duration
    );
    assert_eq!((r.w, r.h), (1080.0, 1920.0));
    cleanup(&p);
}

#[test]
#[ignore]
fn abbruch_beendet_ffmpeg_auf_dem_handy() {
    let Some(p) = phone() else { return };
    let _g = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let dir = work("abbruch");
    // läuft ohne Abbruch endlos (Echtzeit-testsrc)
    let args = s(&[
        "-re",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=30",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        &dir.join("endlos.mkv").to_string_lossy(),
    ]);
    let job = plan_remote(&dir, &args, &p.work).unwrap();
    let c = Cancel::new();
    let c2 = c.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(6));
        c2.cancel();
    });
    let mut last = 0.0;
    let mut cb = |x: f64| last = x;
    let r = p.run_remote_ffmpeg(&models(), &job, Some(&mut cb), &c);
    t.join().unwrap();
    assert!(matches!(r, Err(Error::Cancelled)), "{r:?}");
    assert!(last > 0.0, "kein Fortschritt vor dem Abbruch");
    let ps = p
        .shell("ps -A -o ARGS | grep rust-test/export | grep -v grep; true")
        .unwrap();
    assert!(
        ps.trim().is_empty(),
        "ffmpeg läuft auf dem Handy weiter: {ps}"
    );
    assert!(!dir.join("endlos.mkv").exists());
    cleanup(&p);
}

fn read_wav(f: &Path) -> Vec<f32> {
    // 16 kHz mono 16 bit; Chunks (z. B. LIST) bis „data“ überspringen
    let b = std::fs::read(f).unwrap();
    assert_eq!(u32::from_le_bytes(b[24..28].try_into().unwrap()), 16000);
    let mut o = 12;
    while &b[o..o + 4] != b"data" {
        o += 8 + u32::from_le_bytes(b[o + 4..o + 8].try_into().unwrap()) as usize;
    }
    b[o + 8..]
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect()
}

#[test]
#[ignore]
fn spracherkennung_auf_dem_handy() {
    let Some(p) = phone() else { return };
    let _g = ONE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = PathBuf::from(std::env::var_os("HOME").unwrap()).join(".cache/deckwerk-phone");
    // b.wav: Sprache; 6 s Sprache aus test5min.wav (ab 60 s, davor lange still); a.wav ist Stille (−91 dB) → leeres Ergebnis an seinem Platz
    let long = read_wav(&cache.join("test5min.wav"));
    let parts = vec![
        read_wav(&cache.join("b.wav")),
        long[16000 * 60..16000 * 66].to_vec(),
        read_wav(&cache.join("a.wav")),
    ];
    p.ensure_asr(&models(), "parakeet-ultra", &Cancel::new())
        .unwrap();
    let t = Instant::now();
    let r = p
        .decode(&models(), "parakeet-ultra", &parts, &Cancel::new())
        .unwrap();
    eprintln!(
        "ASR 4 s + 6 s + 4 s auf dem Handy: {:?} → {:?}",
        t.elapsed(),
        r.iter().map(|x| &x.text).collect::<Vec<_>>()
    );
    assert_eq!(r.len(), 3);
    assert!(
        r[..2]
            .iter()
            .all(|x| !x.text.trim().is_empty() && !x.tokens.is_empty()),
        "{r:?}"
    );
    assert!(r[2].text.trim().is_empty(), "{r:?}");
    let left = p
        .shell(&format!("ls {}/rust-test 2>/dev/null; true", PHONE_DIR))
        .unwrap();
    assert!(
        left.trim().is_empty(),
        "Job-Ordner nicht aufgeräumt: {left}"
    );
    cleanup(&p);
}
