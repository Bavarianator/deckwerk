//! Ende-zu-Ende mit echtem ffmpeg (übersprungen, wenn keins im PATH): synthetische lavfi-Quellen, Export wie export-timeline.ts
//! (Ton je Abschnitt → verbinden → R128 → loudnorm → Bild je Abschnitt → verbinden + muxen), dazu xmeml und Wellenform.

use dw_lint::video::Overlay;
use dw_timeline::export::*;
use dw_timeline::graph::*;
use dw_timeline::media::*;
use dw_timeline::xmeml::{Info, XmemlOpts, xmeml_timeline};
use dw_timeline::*;
use std::collections::HashMap;
use std::path::Path;
use std::process::{Command, Stdio};

fn ffmpeg(args: &[String], cwd: &Path) -> String {
    let o = Command::new("ffmpeg")
        .args(["-hide_banner", "-nostdin", "-y"])
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&o.stderr).into_owned();
    assert!(
        o.status.success(),
        "ffmpeg {args:?}\n{}",
        err.lines().rev().take(8).collect::<Vec<_>>().join("\n")
    );
    err
}
fn sv(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

#[test]
fn export_mit_echtem_ffmpeg() {
    if Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .status()
        .is_err()
    {
        eprintln!("ffmpeg fehlt, übersprungen");
        return;
    }
    let work = Path::new(env!("CARGO_TARGET_TMPDIR")).join("dw-timeline-e2e");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let p = |f: &str| work.join(f).to_string_lossy().into_owned();
    // Quellen: 2 Videos mit Ton, ein Logo, eine Tondatei (je ≤ 3 s, 320×180)
    ffmpeg(
        &sv(&[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=320x180:r=25:d=3",
            "-f",
            "lavfi",
            "-i",
            "sine=f=440:d=3",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-shortest",
            "a.mp4",
        ]),
        &work,
    );
    ffmpeg(
        &sv(&[
            "-f",
            "lavfi",
            "-i",
            "color=red:s=320x180:r=25:d=3",
            "-f",
            "lavfi",
            "-i",
            "sine=f=880:d=3",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            "-shortest",
            "b.mp4",
        ]),
        &work,
    );
    ffmpeg(
        &sv(&[
            "-f",
            "lavfi",
            "-i",
            "color=white:s=64x64",
            "-frames:v",
            "1",
            "logo.png",
        ]),
        &work,
    );
    ffmpeg(
        &sv(&["-f", "lavfi", "-i", "sine=f=220:d=3", "m.wav"]),
        &work,
    );

    let c = |id: &str, src: &str, at: f64, in_: f64, out: f64| TlClip {
        id: id.into(),
        src: src.into(),
        at,
        in_,
        out,
        ..Default::default()
    };
    let tl = TimelineContent {
        tracks: vec![
            TlTrack {
                id: "v1".into(),
                kind: Kind::Video,
                // c2 braucht 0,25 s vor in, hat 0,1: K14-Fall; Farbe und fade aus Schwarz
                clips: vec![
                    TlClip {
                        fade: Some([0.4, 0.0]),
                        grade: Some(Grade {
                            sat: Some(0.3),
                            temp: Some(0.5),
                            ..Default::default()
                        }),
                        ..c("c1", "a.mp4", 0.0, 0.0, 1.6)
                    },
                    TlClip {
                        xfade: Some(0.5),
                        speed: Some(2.0),
                        ..c("c2", "b.mp4", 1.6, 0.1, 2.5)
                    },
                ],
                mute: None,
                hide: None,
                volume: None,
            },
            TlTrack {
                id: "v2".into(),
                kind: Kind::Video,
                clips: vec![TlClip {
                    box_: Some([0.7, 0.1, 0.2]),
                    ..c("c3", "logo.png", 0.4, 0.0, 1.0)
                }],
                mute: None,
                hide: None,
                volume: None,
            },
            TlTrack {
                id: "a1".into(),
                kind: Kind::Audio,
                clips: vec![TlClip {
                    keys: Some(vec![[0.0, -12.0], [1.0, 0.0]]),
                    eq: Some(Eq {
                        low: Some(3.0),
                        ..Default::default()
                    }),
                    ..c("c4", "m.wav", 0.0, 0.0, 2.0)
                }],
                mute: None,
                hide: None,
                volume: Some(0.8),
            },
        ],
        overlays: Some(vec![Overlay {
            start: 0.2,
            end: 1.0,
            art: Some("verpixeln".into()),
            box_: Some([0.1, 0.1, 0.3, 0.3]),
            ..Default::default()
        }]),
        subs: Some(vec![Sub {
            start: 0.0,
            end: 1.0,
            text: "Hallo".into(),
        }]),
        deliver: Some(DeliverOpt {
            res: Some(180.0),
            fps: Some(25.0),
            ..Default::default()
        }),
        ..Default::default()
    };
    // res 180 liegt außerhalb der Katalogwerte (klein für den Test), sonst gültig
    if let Err(e) = validate(&tl) {
        assert!(e.starts_with("res"), "{e}");
    }
    let info: HashMap<String, Info> = HashMap::from([
        (
            p("a.mp4"),
            Info {
                duration: 3.0,
                w: 320.0,
                h: 180.0,
                fps: Some(25.0),
                audio: true,
            },
        ),
        (
            p("b.mp4"),
            Info {
                duration: 3.0,
                w: 320.0,
                h: 180.0,
                fps: Some(25.0),
                audio: true,
            },
        ),
        (
            p("logo.png"),
            Info {
                duration: 0.04,
                w: 64.0,
                h: 64.0,
                fps: None,
                audio: false,
            },
        ),
        (
            p("m.wav"),
            audio_only_info(&ffmpeg_err(&work, "m.wav")).expect("Tondatei erkannt"),
        ),
    ]);
    let deliver = deliver_of(&tl);
    let (w, h) = size(&deliver, 16.0 / 9.0);
    let rt = prepare(&tl, &|s| p(s), &info).unwrap();
    let enc = encode_args(&deliver);
    assert!(has_encoder(
        &String::from_utf8_lossy(
            &Command::new("ffmpeg")
                .args(["-hide_banner", "-encoders"])
                .output()
                .unwrap()
                .stdout
        ),
        enc.encoder
    ));
    let lut_files = luts(&rt, &work);
    for (_, f, cube) in &lut_files {
        std::fs::write(f, cube).unwrap();
    }
    let lut = |c: &TlClip| {
        lut_files
            .iter()
            .find(|(x, ..)| std::ptr::eq(*x, c))
            .map(|(_, f, _)| f.to_string_lossy().into_owned())
    };
    let secs = sections(&rt, deliver.fps);
    assert!(secs.len() >= 5, "Abschnitte {}", secs.len());

    // Ton
    for (i, s) in secs.iter().enumerate() {
        ffmpeg(&section_audio_args(s, &format!("a-{}.wav", n3(i))), &work);
    }
    std::fs::write(work.join("a.txt"), concat_list("a", secs.len(), "wav")).unwrap();
    ffmpeg(&concat_audio_args(), &work);
    let m = parse_r128(&ffmpeg(&r128_args("mix.wav"), &work)).expect("R128");
    let mix = match loudnorm_args(deliver.lufs, &m) {
        Some(a) => {
            ffmpeg(&a, &work);
            "mixn.wav"
        }
        None => "mix.wav",
    };
    let after = parse_r128(&ffmpeg(&r128_args(mix), &work)).unwrap().i;
    assert!(
        (after - deliver.lufs).abs() < 1.5,
        "Lautheit {after} statt {}",
        deliver.lufs
    );

    // Bild
    let ovs = export_overlays(&tl);
    let pix = pix_fmt(&deliver);
    for (i, s) in secs.iter().enumerate() {
        let (here, _cues) = section_texts(&ovs, export_subs(&tl), s);
        let a = finish_video_args(
            video_args(s, &deliver, 16.0 / 9.0, &lut),
            &here,
            w,
            h,
            None,
            &pix,
        );
        ffmpeg(
            &section_video_out(
                a,
                &deliver,
                s.end - s.start,
                &format!("v-{}.{}", n3(i), enc.ext),
            ),
            &work,
        );
    }
    std::fs::write(work.join("v.txt"), concat_list("v", secs.len(), enc.ext)).unwrap();
    ffmpeg(&mux_args(&deliver, mix, &format!("out.{}", enc.ext)), &work);

    // Ergebnis: Länge wie die Timeline, Bild und Ton vorhanden
    let err = ffmpeg_err(&work, &format!("out.{}", enc.ext));
    assert!(
        err.contains("Video: h264") && err.contains("Audio: aac"),
        "{err}"
    );
    let d = audio_only_info(&err).unwrap().duration;
    assert!((d - tl_duration(&tl.tracks)).abs() < 0.1, "Dauer {d}");

    // xmeml und Wellenform
    let x = xmeml_timeline(
        &rt,
        &XmemlOpts {
            name: "e2e",
            fps: deliver.fps,
            w,
            h,
            info: &info,
        },
    );
    assert!(
        x.contains("Audio Levels") && x.contains("Basic Motion") && x.contains("<generatoritem")
    );
    let o = Command::new("ffmpeg")
        .args(peaks_args(&p("m.wav")))
        .stderr(Stdio::null())
        .output()
        .unwrap();
    let pk = peaks(&o.stdout[..], 100.0).unwrap();
    assert_eq!(pk.len(), 300);
    // lavfi-Sinus hat die Amplitude 1/8 → 32 von 255
    assert!(pk.iter().all(|&v| (28..=36).contains(&v)), "{:?}", &pk[..5]);
}

// stderr von `ffmpeg -i datei` (endet ohne Ausgabe mit Fehlercode, darum ohne Prüfung)
fn ffmpeg_err(cwd: &Path, f: &str) -> String {
    let o = Command::new("ffmpeg")
        .args(["-hide_banner", "-nostdin", "-i", f])
        .current_dir(cwd)
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stderr).into_owned()
}
