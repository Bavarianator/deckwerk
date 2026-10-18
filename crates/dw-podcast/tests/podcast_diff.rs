//! Differenztest Rust ↔ TS für den Podcast-Schnitt: tests/fixtures/podcast.json kommt aus tests/gen/gen-podcast.ts (Aufruf dort in Zeile 1).
//! Ergebnisse exakt gleich; die Fixes K22/K23/L9 ändern keine Ausgabe (L9 nur die Laufzeit, eigener Test).

use dw_lint::js::num;
use dw_lint::video::{Segment, Transcript, Word};
use dw_podcast::graph::*;
use dw_podcast::*;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::time::Instant;

fn same(got: &Value, exp: &Value, path: &str) -> Result<(), String> {
    let bad = || Err(format!("{path}: erwartet {exp}, bekommen {got}"));
    match (got, exp) {
        (Value::Number(g), Value::String(e)) => {
            if &num(g.as_f64().unwrap()) == e {
                Ok(())
            } else {
                bad()
            }
        }
        (Value::Array(g), Value::Array(e)) => {
            if g.len() != e.len() {
                return bad();
            }
            g.iter()
                .zip(e)
                .enumerate()
                .try_for_each(|(k, (g, e))| same(g, e, &format!("{path}[{k}]")))
        }
        (Value::Object(g), Value::Object(e)) => {
            if g.len() != e.len() || g.keys().any(|k| !e.contains_key(k)) {
                return bad();
            }
            g.iter()
                .try_for_each(|(k, gv)| same(gv, &e[k], &format!("{path}.{k}")))
        }
        _ => {
            if got == exp {
                Ok(())
            } else {
                bad()
            }
        }
    }
}
fn arg<T: DeserializeOwned>(c: &Value, k: &str) -> T {
    serde_json::from_value(c.get(k).cloned().unwrap_or(Value::Null))
        .unwrap_or_else(|e| panic!("{}: Feld {k}: {e}", c["name"]))
}
fn ok(v: impl serde::Serialize) -> Value {
    json!({ "ok": v })
}
fn res<T: serde::Serialize>(r: Result<T, String>) -> Value {
    match r {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "err": e }),
    }
}

fn run(kind: &str, c: &Value) -> Value {
    match kind {
        "cuts" => {
            let (cuts, d, ts): (Vec<Cut>, f64, Vec<f64>) =
                (arg(c, "cuts"), arg(c, "duration"), arg(c, "ts"));
            let n = norm_cuts(&cuts, d);
            ok(json!({
                "norm": n, "keep": keep_ranges(&cuts, d), "len": edited_length(&cuts, d),
                "edited": ts.iter().map(|&t| to_edited(t, &cuts, d)).collect::<Vec<_>>(),
                "source": ts.iter().map(|&t| to_source(t, &cuts, d)).collect::<Vec<_>>(),
                "inCut": ts.iter().map(|&t| in_cut(t, &n)).collect::<Vec<_>>(),
            }))
        }
        "snapCut" => ok(snap_cut(&arg(c, "c"), &arg::<Vec<WordSpan>>(c, "words"))),
        "filler" => ok(is_filler(&arg::<String>(c, "w"), &arg::<String>(c, "lang"))),
        "merge" => ok(merge_tracks(&arg::<Vec<Option<Transcript>>>(c, "ts"))),
        "auto" => {
            let t: Option<Transcript> = arg(c, "t");
            ok(auto_cuts(
                &arg(c, "ep"),
                t.as_ref(),
                &arg::<Vec<Span>>(c, "quiet"),
                &arg(c, "o"),
            ))
        }
        "lint" => {
            let t: Option<Transcript> = arg(c, "t");
            ok(lint_episode(&arg(c, "ep"), t.as_ref()))
        }
        "summary" => ok(episode_summary(&arg(c, "ep"))),
        "deck" => res(deck_to_episode(
            &arg::<Vec<dw_model::Slide>>(c, "slides"),
            arg(c, "duration"),
        )),
        "graph" => {
            let o = &c["o"];
            let go = GraphOpts {
                music: o.get("music").map(|m| arg(m, "volume")),
                intro_dur: arg(o, "introDur"),
                outro_dur: arg(o, "outroDur"),
            };
            res(build_graph(&arg(c, "ep"), &go)
                .map(|(inputs, graph)| json!({ "inputs": inputs, "graph": graph })))
        }
        "validate" => {
            ok(serde_json::from_value::<Episode>(c["ep"].clone())
                .is_ok_and(|e| validate(&e).is_ok()))
        }
        _ => panic!("unbekannte Art {kind}"),
    }
}

#[test]
fn podcast_gleich_wie_ts() {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/podcast.json"
    ))
    .expect("Fixture fehlt: gen-podcast.ts laufen lassen");
    let fx: Value = serde_json::from_str(&raw).unwrap();
    let (mut ok_n, mut total, mut fails) = (0, 0, Vec::new());
    for (kind, cases) in fx.as_object().unwrap() {
        let (mut k_ok, cases) = (0, cases.as_array().unwrap());
        for c in cases {
            match same(&run(kind, c), &c["expected"], "") {
                Ok(()) => k_ok += 1,
                Err(e) => fails.push(format!("{} – {e}", c["name"].as_str().unwrap())),
            }
        }
        println!("{kind}: {k_ok}/{} identisch", cases.len());
        ok_n += k_ok;
        total += cases.len();
    }
    println!("gesamt: {ok_n}/{total} identisch");
    assert!(
        fails.is_empty(),
        "{} Abweichungen:\n{}",
        fails.len(),
        fails
            .iter()
            .take(15)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

fn w(w: &str, start: f64, end: f64) -> Word {
    Word {
        w: w.into(),
        start,
        end,
    }
}

/// L9 (§7.5): autoCuts (Pausen, Füllwörter) und Lint über 8 h mit 100 000 Wörtern in Sekunden (O(n²) bräuchte Minuten); Grenze großzügig für Debug-Build und Last (TS: O(n²), Math.max-Spread über die Argumentgrenze)
#[test]
fn l9_acht_stunden() {
    let n = 100_000;
    let segments: Vec<Segment> = (0..n / 10)
        .map(|s| {
            let words: Vec<Word> = (0..10)
                .map(|k| {
                    let t = (s * 10 + k) as f64 * 0.288;
                    w(if k == 3 { " äh" } else { " Wort" }, t, t + 0.2)
                })
                .collect();
            Segment {
                start: words[0].start,
                end: words[9].end,
                text: String::new(),
                words: Some(words),
                speaker: Some((s % 2) as f64),
            }
        })
        .collect();
    let t = Transcript {
        duration: 28800.0,
        lang: "de".into(),
        segments,
        covered: None,
    };
    let ep = Episode {
        duration: 28800.0,
        tracks: vec![PodTrack {
            src: "/a.wav".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let quiet: Vec<Span> = (0..2000)
        .map(|k| [k as f64 * 14.0, k as f64 * 14.0 + 1.5])
        .collect();
    let t0 = Instant::now();
    // ohne retakes: das liegt in dw-lint und braucht im Debug-Build allein ~5 s für 100 000 Wörter
    let cuts = auto_cuts(
        &ep,
        Some(&t),
        &quiet,
        &AutoClean {
            pauses: Some(0.6),
            fillers: Some(true),
            retakes: None,
        },
    );
    let issues = lint_episode(
        &Episode {
            cuts: cuts.clone(),
            ..ep.clone()
        },
        Some(&t),
    );
    let ms = t0.elapsed().as_secs_f64() * 1e3;
    assert_eq!(
        cuts.iter().filter(|c| c.why == Some(CutWhy::Fuell)).count(),
        n / 10
    );
    assert!(issues.iter().all(|i| i.rule != "schnitt-wort"));
    assert!(ms < 10000.0, "zu langsam: {ms} ms");
}

/// K22: das Transkript der Episode kommt aus allen Spuren (Sprecher = Spurnummer), nicht nur aus Spur 1
#[test]
fn k22_transkript_aller_spuren() {
    let tr = |x: f64| Transcript {
        duration: 10.0,
        lang: "de".into(),
        segments: vec![Segment {
            start: x,
            end: x + 1.0,
            text: "a".into(),
            words: Some(vec![w(" a", x, x + 1.0)]),
            speaker: None,
        }],
        covered: None,
    };
    let ep = Episode {
        duration: 10.0,
        tracks: vec![
            PodTrack {
                src: "/a.wav".into(),
                ..Default::default()
            },
            PodTrack {
                src: "/b.wav".into(),
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    let t = episode_transcript(&ep, |s| Some(tr(if s == "/a.wav" { 5.0 } else { 1.0 }))).unwrap();
    assert_eq!(
        t.segments
            .iter()
            .map(|s| (s.start, s.speaker))
            .collect::<Vec<_>>(),
        [(1.0, Some(1.0)), (5.0, Some(0.0))]
    );
    // nur die zweite Spur hat ein Transkript: es zählt trotzdem (TS create_episode meldete dann „ohne Transkript“)
    assert!(episode_transcript(&ep, |s| (s == "/b.wav").then(|| tr(1.0))).is_some());
}

#[test]
fn hilfen() {
    assert_eq!(
        script_flag("ffmpeg version 6.1.1-static"),
        "-filter_complex_script"
    );
    assert_eq!(
        script_flag("ffmpeg version n9.0.1 Copyright"),
        "-/filter_complex"
    );
    assert!(has_lame(" A..... libmp3lame           libmp3lame MP3") && !has_lame(" A..... aac"));
    let loud = measured_norm(
        -16.0,
        "{\n\"input_i\" : \"-20.5\",\n\"input_tp\" : \"-3.1\",\n\"input_lra\" : \"4.2\",\n\"input_thresh\" : \"-31.0\",\n\"target_offset\" : \"0.4\"\n}",
    );
    assert_eq!(
        loud,
        ",loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-20.5:measured_TP=-3.1:measured_LRA=4.2:measured_thresh=-31:offset=0.4:linear=true,aresample=48000,asetpts=N/SR/TB"
    );
    assert_eq!(
        measured_norm(-16.0, "\"input_i\" : \"-inf\""),
        ",loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,asetpts=N/SR/TB"
    );
    let ch = [
        Chapter {
            at: 0.0,
            title: "A=1".into(),
        },
        Chapter {
            at: 61.5,
            title: "B".into(),
        },
    ];
    assert_eq!(
        meta_txt("Folge; 1", &ch, 120.0),
        ";FFMETADATA1\ntitle=Folge\\; 1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=61500\ntitle=A\\=1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=61500\nEND=120000\ntitle=B\n"
    );
    assert!(chapters_json(&ch).contains("\"startTime\": 61.5"));
}
