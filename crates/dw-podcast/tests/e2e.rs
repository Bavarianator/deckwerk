//! Ende-zu-Ende mit echtem ffmpeg (übersprungen, wenn keins im PATH): zwei Spuren, Schnitte, Intro/Outro, Soundeffekt, Musik, Kapitel →
//! Messlauf, zweiter loudnorm-Durchgang, m4a mit Kapiteln; dazu Wellenform und Vorhör-Mix. Ablauf wie renderOnce in main/podcast.ts.

use dw_lint::video::Sfx;
use dw_podcast::graph::*;
use dw_podcast::*;
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
fn episode_mit_echtem_ffmpeg() {
    if Command::new("ffmpeg")
        .arg("-version")
        .stdout(Stdio::null())
        .status()
        .is_err()
    {
        eprintln!("ffmpeg fehlt, übersprungen");
        return;
    }
    let work = Path::new(env!("CARGO_TARGET_TMPDIR")).join("dw-podcast-e2e");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    for (f, src) in [
        ("a.wav", "sine=f=300:d=6"),
        ("b.wav", "sine=f=500:d=5"),
        ("intro.wav", "sine=f=800:d=1.5"),
        ("outro.wav", "sine=f=900:d=1.5"),
        ("plopp.wav", "sine=f=1200:d=0.2"),
        ("musik.wav", "anoisesrc=d=2:a=0.1"),
    ] {
        ffmpeg(
            &sv(&["-f", "lavfi", "-i", src, "-ac", "2", "-ar", "48000", f]),
            &work,
        );
    }
    let ep = Episode {
        duration: 6.0,
        tracks: vec![
            PodTrack {
                src: "a.wav".into(),
                gain: Some(-3.0),
                ..Default::default()
            },
            PodTrack {
                src: "b.wav".into(),
                ..Default::default()
            },
        ],
        cuts: vec![
            Cut {
                start: 1.0,
                end: 2.0,
                why: Some(CutWhy::Pause),
            },
            Cut {
                start: 4.0,
                end: 4.5,
                why: Some(CutWhy::Hand),
            },
        ],
        sfx: Some(vec![Sfx {
            src: "plopp.wav".into(),
            at: 3.0,
            gain: Some(-6.0),
        }]),
        intro: Some("intro.wav".into()),
        outro: Some("outro.wav".into()),
        chapters: Some(vec![
            Chapter {
                at: 0.0,
                title: "Anfang".into(),
            },
            Chapter {
                at: 3.0,
                title: "Mitte = Kern".into(),
            },
        ]),
        ton: Some(PodTon::Klar),
    };
    validate(&ep).unwrap();
    let o = GraphOpts {
        music: Some(0.3),
        intro_dur: Some(1.5),
        outro_dur: Some(1.5),
    };
    let (inputs, graph) = build_graph(&ep, &o).unwrap();
    let t = timing(&ep, &o).unwrap();
    assert_eq!((t.len, t.off, t.total), (4.5, 0.5, 5.5));
    let mut args: Vec<String> = inputs
        .iter()
        .flat_map(|s| ["-i".to_string(), s.clone()])
        .collect();
    args.extend(sv(&["-stream_loop", "-1", "-i", "musik.wav"]));
    let meta = args.iter().filter(|a| *a == "-i").count();
    let version = String::from_utf8_lossy(
        &Command::new("ffmpeg")
            .arg("-version")
            .output()
            .unwrap()
            .stdout,
    )
    .into_owned();
    let flag = script_flag(&version);

    std::fs::write(
        work.join("graph-0.txt"),
        graph_file(&graph, &format!(",{}:print_format=json", norm(LUFS))),
    )
    .unwrap();
    let err = ffmpeg(&measure_args(&args, &sv(&[flag, "graph-0.txt"])), &work);
    let loud = measured_norm(LUFS, &err);
    assert!(loud.contains("measured_I="), "{loud}");
    std::fs::write(work.join("graph-1.txt"), graph_file(&graph, &loud)).unwrap();
    let chapters = chapter_marks(&ep, &t);
    assert_eq!(
        chapters.iter().map(|c| c.at).collect::<Vec<_>>(),
        [0.0, 2.5]
    );
    std::fs::write(
        work.join("meta.txt"),
        meta_txt("Folge 1", &chapters, t.total),
    )
    .unwrap();
    let mut fin = args.clone();
    fin.extend(sv(&[
        "-f",
        "ffmetadata",
        "-i",
        "meta.txt",
        flag,
        "graph-1.txt",
        "-map",
        "[a]",
        "-map_metadata",
    ]));
    fin.extend([meta.to_string(), "-map_chapters".into(), meta.to_string()]);
    fin.extend(encode_args("m4a"));
    fin.push("episode.m4a".into());
    ffmpeg(&fin, &work);

    let info = String::from_utf8_lossy(
        &Command::new("ffmpeg")
            .args(["-hide_banner", "-i", "episode.m4a"])
            .current_dir(&work)
            .output()
            .unwrap()
            .stderr,
    )
    .into_owned();
    assert!(
        info.contains("Chapter #0:1")
            && info.contains("Mitte = Kern")
            && info.contains("Audio: aac"),
        "{info}"
    );
    let d = info.split("Duration: ").nth(1).unwrap();
    let secs: f64 = d[6..11].parse().unwrap();
    assert!((secs - t.total).abs() < 0.15, "Dauer {d}");
    // Lautheit am Ziel (kurzer Ausschnitt: grob)
    let r = ffmpeg(
        &sv(&[
            "-i",
            "episode.m4a",
            "-af",
            "loudnorm=print_format=json",
            "-f",
            "null",
            "-",
        ]),
        &work,
    );
    let i: f64 = r
        .split("\"input_i\" : \"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert!((i - LUFS).abs() < 2.0, "Lautheit {i}");

    // Wellenform (6 s × 50/s) und Vorhör-Mix beider Spuren
    let o = Command::new("ffmpeg")
        .args(peaks_args("a.wav"))
        .current_dir(&work)
        .stderr(Stdio::null())
        .output()
        .unwrap();
    let p = peaks(&o.stdout[..]).unwrap();
    assert_eq!((p.duration, p.data.len(), p.data[10]), (6.0, 300, 0.125));
    let mix = preview_mix_args(&ep, &sv(&["a.wav", "b.wav"]), "mix.ogg")
        .unwrap()
        .unwrap();
    ffmpeg(&mix, &work);
    assert!(work.join("mix.ogg").metadata().unwrap().len() > 1000);
}
