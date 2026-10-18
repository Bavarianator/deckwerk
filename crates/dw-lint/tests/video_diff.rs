//! Differenztest Rust ↔ TS für die Video-Logik: tests/fixtures/video.json kommt aus tests/gen/gen-video.ts (Aufruf dort in Zeile 1).
//! Ergebnisse müssen exakt gleich sein: Texte wortgleich, Zahlen bitgleich (die Fixture trägt sie als String(x), verglichen mit js::num).

use dw_lint::js::num;
use dw_lint::video::*;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::time::Instant;

fn resolve(v: &Value, pool: &[Value]) -> Value {
    match v {
        Value::Object(m) if m.len() == 1 && m.contains_key("$ref") => {
            pool[m["$ref"].as_u64().unwrap() as usize].clone()
        }
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| (k.clone(), resolve(x, pool)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(|x| resolve(x, pool)).collect()),
        _ => v.clone(),
    }
}

/// Vergleicht got mit expected (Zahlen dort als String); Fehler mit Pfad
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

fn run(kind: &str, c: &Value) -> Value {
    match kind {
        "lintClip" => {
            let others: Option<Vec<OtherClip>> = arg(c, "others");
            json!(lint_clip(
                &arg(c, "c"),
                arg(c, "size"),
                &arg(c, "info"),
                &others.unwrap_or_default(),
                arg(c, "self")
            ))
        }
        "snap" => {
            let max: Option<f64> = arg(c, "max");
            json!(snap_to_words(
                &arg::<Vec<Part>>(c, "parts"),
                &arg(c, "t"),
                max.unwrap_or(SNAP)
            ))
        }
        "retakes" => json!(retakes(&arg(c, "t"))),
        "highlights" => json!(highlights(
            &arg(c, "s"),
            arg::<Option<HighlightOpts>>(c, "o").unwrap_or_default()
        )),
        "search" => json!(search_transcript(
            &arg(c, "t"),
            &arg::<String>(c, "query"),
            arg(c, "n")
        )),
        "overview" => {
            let t: Option<Transcript> = arg(c, "t");
            let s: Option<OverviewSignals> = arg(c, "s");
            json!(overview(
                t.as_ref(),
                s.as_ref(),
                arg(c, "duration"),
                arg(c, "win")
            ))
        }
        "estimateWords" => json!(estimate_words(
            &arg(c, "seg"),
            &arg::<Vec<Quiet>>(c, "quiet")
        )),
        "clipSpans" => json!(clip_spans(
            &arg::<Vec<Part>>(c, "parts"),
            arg(c, "a"),
            arg(c, "b")
        )),
        "partsLength" => json!(parts_length(&arg::<Vec<Part>>(c, "parts"))),
        "mmss" => json!(mmss(arg(c, "s"))),
        _ => panic!("unbekannte Art {kind}"),
    }
}

#[test]
fn video_gleich_wie_ts() {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/video.json"
    ))
    .expect("Fixture fehlt: gen-video.ts laufen lassen");
    let fx: Value = serde_json::from_str(&raw).unwrap();
    let pool = fx["transcripts"].as_array().unwrap();
    let (mut ok, mut total, mut fails) = (0, 0, Vec::new());
    for (kind, cases) in fx
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| *k != "transcripts")
    {
        let (mut k_ok, cases) = (0, cases.as_array().unwrap());
        for c in cases {
            let c = resolve(c, pool);
            match same(&run(kind, &c), &c["expected"], "") {
                Ok(()) => k_ok += 1,
                Err(e) => fails.push(format!("{} – {e}", c["name"].as_str().unwrap())),
            }
        }
        println!("{kind}: {k_ok}/{} identisch", cases.len());
        ok += k_ok;
        total += cases.len();
    }
    println!("gesamt: {ok}/{total} identisch");
    assert!(
        fails.is_empty(),
        "{} Abweichungen:\n{}",
        fails.len(),
        fails
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// Laufzeit wie in den TS-Selbsttests (dort: highlights 8 h < 1 s CPU, BM25 über 1000 Segmente < 50 ms); Grenzen großzügig für Debug-Builds
#[test]
fn video_laufzeit() {
    let mut seed = 7.0f64;
    let mut rnd = move || {
        seed = (seed * 16807.0) % 2147483647.0;
        seed / 2147483647.0
    };
    let n = 28800;
    let mut noise = |base: f64, amp: f64| {
        (0..n)
            .map(|_| base + (rnd() - 0.5) * 2.0 * amp)
            .collect::<Vec<_>>()
    };
    let s = Signals {
        loud: noise(-25.0, 3.0),
        chat: Some(noise(2.5, 2.5).iter().map(|v| v.floor()).collect()),
        events: Some(noise(0.1, 0.1)),
        heat: Some(noise(0.3, 0.3)),
        music: None,
    };
    let t0 = Instant::now();
    let h = highlights(&s, HighlightOpts::default());
    let ms_h = t0.elapsed().as_secs_f64() * 1e3;
    assert!(!h.is_empty());

    let fill: Vec<&str> =
        "heute gibt es viel zu erzählen über das Wetter und die Stadt wegen den Nachbarn"
            .split(' ')
            .collect();
    let mut segs: Vec<Segment> = (0..1000)
        .map(|i| Segment {
            start: (i * 6) as f64,
            end: (i * 6 + 5) as f64,
            text: (0..8)
                .map(|j| fill[(i * 7 + j * 3) % fill.len()])
                .collect::<Vec<_>>()
                .join(" "),
            ..Default::default()
        })
        .collect();
    segs[640].text = "und dann haben wir über Kernfusion und Plasmaphysik gesprochen".into();
    let big = Transcript {
        duration: 6000.0,
        lang: "de".into(),
        segments: segs,
        covered: None,
    };
    let t0 = Instant::now();
    let hits = search_transcript(&big, "Kernfusion Plasma", 8);
    let ms_s = t0.elapsed().as_secs_f64() * 1e3;
    assert_eq!(hits[0].seg, 640);
    // zweiter Lauf ohne das einmalige Übersetzen der Unicode-Regexe
    let t0 = Instant::now();
    search_transcript(&big, "Kernfusion Plasma", 8);
    let ms_s2 = t0.elapsed().as_secs_f64() * 1e3;
    println!(
        "highlights 8 h: {ms_h:.1} ms, search_transcript 1000 Segmente: {ms_s:.1} ms (erneut {ms_s2:.1} ms)"
    );
    assert!(ms_h < 5000.0 && ms_s < 2000.0);
}
