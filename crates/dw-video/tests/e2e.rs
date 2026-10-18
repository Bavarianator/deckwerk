//! Ende-zu-Ende mit echtem ffmpeg (fehlt es, werden die Tests übersprungen; mit DW_REQUIRE_FFMPEG=1 schlagen sie fehl): synthetisches Testvideo (lavfi testsrc + sine),
//! daraus ein Clip mit Schnitt und Übergang, dazu Fortschritt, Abbruch und Zeitlimit.

use dw_video::export::{ClipJob, encode_clip, encode_cover};
use dw_video::ffmpeg::{self, Cancel, Error};
use dw_video::{Part, Size};
use std::path::PathBuf;
use std::time::Duration;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Arbeitsordner unter target/tmp (nie /tmp: kleines tmpfs)
fn work(name: &str) -> Option<PathBuf> {
    if let Err(e) = ffmpeg::ffmpeg_bin() {
        assert!(
            std::env::var("DW_REQUIRE_FFMPEG").as_deref() != Ok("1"),
            "ffmpeg verlangt: {e}"
        );
        eprintln!("übersprungen: {e}");
        return None;
    }
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join("dw-video-e2e")
        .join(name);
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    Some(d)
}

fn testvideo(dir: &std::path::Path, secs: u32) -> PathBuf {
    let src = dir.join("quelle.mp4");
    let d = secs.to_string();
    ffmpeg::run(
        &s(&[
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc=size=640x360:rate=30:duration={d}"),
            "-f",
            "lavfi",
            "-i",
            &format!("sine=frequency=440:duration={d}"),
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
    src
}

#[test]
fn clip_mit_schnitt_und_uebergang() {
    let Some(dir) = work("clip") else { return };
    let src = testvideo(&dir, 6);
    let p = ffmpeg::probe(&src).unwrap();
    assert_eq!((p.w, p.h, p.audio), (640.0, 360.0, true));
    assert!((p.fps.unwrap() - 30.0).abs() < 1e-6, "fps {:?}", p.fps);
    let parts = vec![
        Part {
            start: 0.5,
            end: 2.0,
            ..Default::default()
        },
        // eigener Übergang: xfade wipeleft über 16 Frames, Mitte auf der Naht
        Part {
            start: 3.5,
            end: 5.0,
            transition: Some("wipe".into()),
            ..Default::default()
        },
    ];
    let mut job = ClipJob::new(&src, parts, Size { w: 360.0, h: 640.0 });
    job.captions = "aus".into();
    job.hook = Some("Schnitt-Test".into());
    job.loudnorm = true;
    // Name mit : , ' – interne Namen (ass=…, concat-Liste) werden bereinigt, die Ausgabedatei behält ihn
    let out = dir.join("a:b,c's.mp4");
    let mut seen: Vec<f64> = Vec::new();
    let mut cb = |p: f64| seen.push(p);
    let len = encode_clip(&job, &out, &dir, None, Some(&mut cb), &Cancel::new()).unwrap();
    // Polster PAD 0,15 s je Seite: 1,8 + 1,8; die Blende ändert die Länge nicht
    assert!((len - 3.6).abs() < 1e-9, "Länge {len}");
    let r = ffmpeg::probe(&out).unwrap();
    assert_eq!((r.w, r.h, r.audio), (360.0, 640.0, true));
    assert!(
        (r.duration - len).abs() < 0.1,
        "MP4 {} s statt {len} s",
        r.duration
    );
    assert!(
        seen.windows(2).all(|w| w[0] <= w[1]),
        "Fortschritt nicht steigend: {seen:?}"
    );
    assert!(
        seen.last().is_some_and(|&p| p >= 90.0),
        "Fortschritt endet bei {seen:?}"
    );
    let jpg = dir.join("a:b,c's.jpg");
    encode_cover(&job, None, &jpg, &dir, &Cancel::new()).unwrap();
    assert!(std::fs::metadata(&jpg).unwrap().len() > 0);
}

// läuft ffmpeg noch, dessen Kommandozeile marker enthält?
#[cfg(target_os = "linux")]
fn running(marker: &str) -> bool {
    std::fs::read_dir("/proc").unwrap().flatten().any(|e| {
        std::fs::read(e.path().join("cmdline"))
            .is_ok_and(|c| String::from_utf8_lossy(&c).contains(marker))
    })
}
#[cfg(not(target_os = "linux"))]
fn running(_: &str) -> bool {
    false
}

#[test]
fn abbruch_und_zeitlimit() {
    let Some(dir) = work("abbruch") else { return };
    // läuft ohne Abbruch endlos (Echtzeit-testsrc); Größe als Marker für die Prozesssuche, Ausgabe in eine Datei
    let part = dir.join("halb.mkv");
    let long = |size: &str| {
        s(&[
            "-re",
            "-f",
            "lavfi",
            "-i",
            &format!("testsrc=size={size}:rate=30"),
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            &part.to_string_lossy(),
        ])
    };
    let c = Cancel::new();
    let c2 = c.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(3000));
        c2.cancel();
    });
    let mut last = 0.0;
    let mut cb = |x: f64| last = x;
    let r = ffmpeg::run(&long("322x242"), Some(&mut cb), &c);
    t.join().unwrap();
    assert!(matches!(r, Err(Error::Cancelled)), "{r:?}");
    assert!(last > 0.0, "kein Fortschritt vor dem Abbruch");
    assert!(
        !running("testsrc=size=322x242"),
        "ffmpeg läuft nach dem Abbruch weiter"
    );
    assert!(!part.exists(), "halbfertige Ausgabe liegt noch da");
    let r = ffmpeg::run(
        &long("324x244"),
        None,
        &Cancel::with_timeout(Duration::from_millis(500)),
    );
    assert!(matches!(r, Err(Error::Timeout)), "{r:?}");
    assert!(!running("testsrc=size=324x244"));
    // Fehler mit dem Ende von stderr
    let r = ffmpeg::run(
        &s(&["-i", "/gibt/es/nicht.mp4", "-f", "null", "-"]),
        None,
        &Cancel::new(),
    );
    assert!(
        matches!(&r, Err(Error::Failed { tail, .. }) if tail.contains("No such file")),
        "{r:?}"
    );
}
