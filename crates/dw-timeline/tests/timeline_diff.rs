//! Differenztest Rust ↔ TS für die Pro-Timeline: tests/fixtures/timeline.json kommt aus tests/gen/gen-timeline.ts (Aufruf dort in Zeile 1).
//! Ergebnisse exakt gleich (Texte wortgleich, Zahlen bitgleich als String(x)) außer an den bewusst gefixten Stellen:
//! K14 (tpad im Bild), K16 (set mit out ≤ in), K18 (zusätzliche xmeml-Elemente). Jede Ausnahme ist unten begründet und gezählt.

use dw_lint::js::num;
use dw_timeline::export::srt;
use dw_timeline::from_clips::from_clips;
use dw_timeline::grade::{cube1d, is_neutral, sat_filter};
use dw_timeline::graph::*;
use dw_timeline::xmeml::{Info, XmemlOpts, xmeml_timeline};
use dw_timeline::*;
use regex::Regex;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::collections::HashMap;

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
fn res<T: serde::Serialize>(r: Result<T, String>) -> Value {
    match r {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "err": e }),
    }
}
fn ok(v: impl serde::Serialize) -> Value {
    json!({ "ok": v })
}
fn act(a: &[Active]) -> Value {
    json!(
        a.iter()
            .map(|a| json!([a.index, a.clip.id, a.src]))
            .collect::<Vec<_>>()
    )
}

fn lut(c: &TlClip) -> Option<String> {
    (!is_neutral(c.grade.as_ref())).then(|| format!("/w/grade:{}'.cube", c.id))
}

#[derive(Default)]
struct Fixed {
    k14: usize,
    k16: usize,
    k18: usize,
}

fn run(kind: &str, c: &Value, fixed: &mut Fixed) -> Value {
    match kind {
        "edit" => {
            let tl: TimelineContent = arg(c, "tl");
            let ops: Vec<TlOp> = arg(c, "ops");
            let r = apply_ops(&tl, &ops, arg(c, "fps"));
            // K16: Rust lehnt set mit out < in + 1/30 ab, TS übernahm es (erst das Schema fing es). Ausnahme nur, wenn TS genau so einen Clip erzeugt hat
            if let Err(e) = &r
                && e.ends_with("out muss nach in liegen")
                && let Some(t) = c["expected"].get("ok")
            {
                let bad = t["tracks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .flat_map(|t| t["clips"].as_array().unwrap())
                    .any(|c| {
                        let f = |k: &str| c[k].as_str().unwrap().parse::<f64>().unwrap();
                        f("out") < f("in") + MIN_LEN
                    });
                if bad {
                    fixed.k16 += 1;
                    return c["expected"].clone();
                }
            }
            res(r)
        }
        "lint" => ok(lint_timeline(&arg(c, "tl"), arg(c, "fps"))),
        "snap" => {
            let tl: TimelineContent = arg(c, "tl");
            let except: Option<String> = arg(c, "except");
            let ts = snap_targets(&tl, except.as_deref(), &arg::<Vec<f64>>(c, "extra"));
            let s = snap(arg(c, "t"), &ts, arg(c, "tol"));
            ok(json!({ "ts": ts, "s": s }))
        }
        "validate" => ok(validate(&arg(c, "tl")).is_ok()),
        "misc" => {
            let tl: TimelineContent = arg(c, "tl");
            let t: f64 = arg(c, "t");
            let xf: Vec<Value> = tl
                .tracks
                .iter()
                .map(|tr| {
                    json!(
                        xfades(&tr.clips)
                            .iter()
                            .map(|x| json!([x.from.id, x.to.id, x.a, x.b]))
                            .collect::<Vec<_>>()
                    )
                })
                .collect();
            ok(json!({
                "cuts": cut_points(&tl.tracks),
                "active": act(&active_at(&tl, t, None)),
                "activeV": active_at(&tl, t, Some(Kind::Video)).iter().map(|a| a.index).collect::<Vec<_>>(),
                "xf": xf,
            }))
        }
        "sections" => {
            let tl: TimelineContent = arg(c, "tl");
            let fps: Option<f64> = arg(c, "fps");
            let ss = sections(&tl, fps.unwrap_or_else(|| default_fps(&tl)));
            ok(ss.iter().map(|s| json!({ "start": s.start, "end": s.end, "video": act(&s.video), "audio": act(&s.audio) })).collect::<Vec<_>>())
        }
        "args" => {
            let tl: TimelineContent = arg(c, "tl");
            let d: Deliver = arg(c, "deliver");
            let aspect: f64 = arg(c, "aspect");
            // K14: Rust wartet im Bild mit tpad, wo TS die geklemmte Quelle zu früh zeigte; sonst gleich
            let tpad = Regex::new(r",tpad=start_duration=[0-9.e-]+:color=black@0").unwrap();
            let out: Vec<Value> = sections(&tl, default_fps(&tl))
                .iter()
                .map(|s| {
                    let v: Vec<String> = video_args(s, &d, aspect, &lut)
                        .into_iter()
                        .map(|a| {
                            if tpad.is_match(&a) {
                                fixed.k14 += 1;
                            }
                            tpad.replace_all(&a, "").into_owned()
                        })
                        .collect();
                    json!({ "video": v, "audio": audio_args(s, 48000) })
                })
                .collect();
            ok(out)
        }
        "estimate" => ok(estimate(&arg(c, "tl"), &arg(c, "deliver"))),
        "keyExpr" => ok(key_expr(
            &arg::<Vec<[f64; 2]>>(c, "keys"),
            &arg(c, "clip"),
            arg(c, "offset"),
        )),
        "encode" => {
            let d: Deliver = arg(c, "d");
            let e = encode_args(&d);
            let (w, h) = size(&d, arg(c, "aspect"));
            ok(
                json!({ "enc": { "args": e.args, "ext": e.ext, "encoder": e.encoder }, "size": { "w": w, "h": h }, "fps": fps_arg(d.fps) }),
            )
        }
        "grade" => {
            let g: Option<Grade> = arg(c, "g");
            ok(
                json!({ "neutral": is_neutral(g.as_ref()), "sat": sat_filter(g.as_ref().and_then(|g| g.sat)), "cube": cube1d(g.as_ref()) }),
            )
        }
        "fromClips" => {
            let r = from_clips(
                &arg::<Vec<dw_lint::video::ClipContent>>(c, "slides"),
                arg(c, "fps"),
            );
            ok(json!({ "tl": r.tl, "dropped": r.dropped }))
        }
        "xmeml" => {
            let tl: TimelineContent = arg(c, "tl");
            let o = &c["opts"];
            let info: HashMap<String, Info> = arg(o, "info");
            let x = xmeml_timeline(
                &tl,
                &XmemlOpts {
                    name: o["name"].as_str().unwrap(),
                    fps: arg(o, "fps"),
                    w: arg(o, "w"),
                    h: arg(o, "h"),
                    info: &info,
                },
            );
            // K18: zusätzliche Elemente (Pegel, Bewegung, Farbe, Kommentar, Untertitelspur) entfernen, der Rest muss wortgleich sein
            let extra = Regex::new(r"<filter><effect><name>(Audio Levels|Basic Motion|Color Corrector 3-way)</name>.*?</effect></filter>|<comments>.*?</comments>|\n<track><generatoritem.*?</track>").unwrap();
            let n = extra.find_iter(&x).count();
            fixed.k18 += n;
            ok(extra.replace_all(&x, "").into_owned())
        }
        _ => panic!("unbekannte Art {kind}"),
    }
}

#[test]
fn timeline_gleich_wie_ts() {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/timeline.json"
    ))
    .expect("Fixture fehlt: gen-timeline.ts laufen lassen");
    let fx: Value = serde_json::from_str(&raw).unwrap();
    let (mut ok_n, mut total, mut fails, mut fixed) = (0, 0, Vec::new(), Fixed::default());
    for (kind, cases) in fx.as_object().unwrap() {
        let (mut k_ok, cases) = (0, cases.as_array().unwrap());
        for c in cases {
            match same(&run(kind, c, &mut fixed), &c["expected"], "") {
                Ok(()) => k_ok += 1,
                Err(e) => fails.push(format!("{} – {e}", c["name"].as_str().unwrap())),
            }
        }
        println!("{kind}: {k_ok}/{} identisch", cases.len());
        ok_n += k_ok;
        total += cases.len();
    }
    println!(
        "gesamt: {ok_n}/{total} identisch; bewusst anders: K14 {} Bildketten, K16 {} Ops, K18 {} xmeml-Elemente",
        fixed.k14, fixed.k16, fixed.k18
    );
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
    // Die Fixes müssen in den Zufallsfällen auch vorkommen, sonst prüft der Test sie nicht
    assert!(fixed.k18 > 0, "keine xmeml-Erweiterung geprüft");
}

fn clip(id: &str, at: f64, in_: f64, out: f64) -> TlClip {
    TlClip {
        id: id.into(),
        src: "/m/a.mp4".into(),
        at,
        in_,
        out,
        ..Default::default()
    }
}
fn track(id: &str, kind: Kind, clips: Vec<TlClip>) -> TlTrack {
    TlTrack {
        id: id.into(),
        kind,
        clips,
        mute: None,
        hide: None,
        volume: None,
    }
}

/// K15: estimate rechnet mit der fps der Ausgabe, auch wenn tl.deliver fehlt (TS nahm dann 30)
#[test]
fn k15_estimate_mit_ausgabe_fps() {
    // Die Ebenenzahl hängt kaum an der fps; geprüft wird die Formel mit deliver.fps und dass die Abschnitte mit ihr gebildet werden
    let v1 = track(
        "v1",
        Kind::Video,
        vec![TlClip {
            fade: Some([0.0, 1.0]),
            ..clip("c1", 0.0, 0.0, 2.0)
        }],
    );
    let tl = TimelineContent {
        tracks: vec![v1],
        ..Default::default()
    };
    let d = Deliver {
        fps: 60.0,
        ..DELIVER
    };
    let e = estimate(&tl, &d);
    let (w, h) = size(&d, 16.0 / 9.0);
    assert_eq!(e, w * h * 60.0 * 2.0 / 1.2e8);
    assert_eq!(sections(&tl, 60.0).len(), 2);
}

/// K17: Ton einer ausgeblendeten Videospur fehlt im Export wie in der Vorschau; im xmeml ist sein Tonpaar aus
#[test]
fn k17_hide_nimmt_den_ton() {
    let mut v1 = track("v1", Kind::Video, vec![clip("c1", 0.0, 0.0, 2.0)]);
    v1.hide = Some(true);
    let tl = TimelineContent {
        tracks: vec![
            v1,
            track("v2", Kind::Video, vec![clip("c2", 0.0, 0.0, 2.0)]),
        ],
        ..Default::default()
    };
    let s = sections(&tl, 30.0);
    assert_eq!(
        s[0].audio
            .iter()
            .map(|a| a.clip.id.as_str())
            .collect::<Vec<_>>(),
        ["c2"]
    );
    assert!(active_at(&tl, 1.0, None).iter().all(|a| a.clip.id != "c1"));
    let x = xmeml_timeline(
        &tl,
        &XmemlOpts {
            name: "x",
            fps: 30.0,
            w: 1920.0,
            h: 1080.0,
            info: &HashMap::new(),
        },
    );
    let audio = &x[x.find("<audio>").unwrap()..];
    assert_eq!(
        audio
            .matches("<enabled>FALSE</enabled><locked>FALSE</locked><outputchannelindex>")
            .count(),
        2
    );
}

/// K14: to einer Überblendung mit zu wenig Material vor in setzt im Bild so spät ein wie im Ton
#[test]
fn k14_bild_wartet_wie_ton() {
    let a = clip("c1", 0.0, 0.0, 2.0);
    let b = TlClip {
        xfade: Some(1.0),
        ..clip("c2", 2.0, 0.2, 4.0)
    }; // braucht 0,5 s vor in, hat 0,2
    let tl = TimelineContent {
        tracks: vec![track("v1", Kind::Video, vec![a, b])],
        ..Default::default()
    };
    let ss = sections(&tl, 30.0);
    let s = ss.iter().find(|s| s.start == 1.5).unwrap();
    let v = video_args(s, &DELIVER, 16.0 / 9.0, &|_| None).join(" ");
    let au = audio_args(s, 48000).join(" ");
    assert!(v.contains("tpad=start_duration=0.3:color=black@0"), "{v}");
    assert!(au.contains("adelay=300:all=1"), "{au}");
}

/// K16: set mit out ≤ in wird abgelehnt
#[test]
fn k16_set_prueft_out() {
    let tl = TimelineContent {
        tracks: vec![track("v1", Kind::Video, vec![clip("c1", 0.0, 1.0, 3.0)])],
        ..Default::default()
    };
    let p: serde_json::Map<String, Value> = serde_json::from_value(json!({ "out": 1.0 })).unwrap();
    assert_eq!(
        set_clip(&tl, "c1", &p, 30.0).unwrap_err(),
        "Clip c1: out muss nach in liegen"
    );
}

/// K18: Pegel, Keys, Farbe, Bild-in-Bild und Untertitel landen im xmeml
#[test]
fn k18_xmeml_mit_mix_farbe_untertiteln() {
    let c = TlClip {
        volume: Some(0.5),
        keys: Some(vec![[0.0, 0.0], [1.0, -6.0]]),
        grade: Some(Grade {
            sat: Some(0.5),
            temp: Some(0.3),
            ..Default::default()
        }),
        box_: Some([0.5, 0.5, 0.4]),
        ..clip("c1", 0.0, 0.0, 2.0)
    };
    let mut a1 = track(
        "a1",
        Kind::Audio,
        vec![TlClip {
            src: "/m/musik.wav".into(),
            ..clip("c2", 0.0, 0.0, 2.0)
        }],
    );
    a1.volume = Some(2.0);
    let tl = TimelineContent {
        tracks: vec![track("v1", Kind::Video, vec![c]), a1],
        subs: Some(vec![Sub {
            start: 0.0,
            end: 1.0,
            text: "Hallo & tschüss".into(),
        }]),
        ..Default::default()
    };
    let info = HashMap::from([(
        "/m/a.mp4".to_string(),
        Info {
            duration: 10.0,
            w: 1920.0,
            h: 1080.0,
            fps: Some(30.0),
            audio: true,
        },
    )]);
    let x = xmeml_timeline(
        &tl,
        &XmemlOpts {
            name: "x",
            fps: 30.0,
            w: 1920.0,
            h: 1080.0,
            info: &info,
        },
    );
    assert!(x.contains("<value>0.5</value><keyframe><when>0</when><value>0.5</value></keyframe><keyframe><when>30</when><value>0.25059</value></keyframe>"), "{x}");
    assert!(x.contains(
        "<name>Level</name><valuemin>0</valuemin><valuemax>3.98109</valuemax><value>2</value>"
    ));
    assert!(x.contains("<parameterid>scale</parameterid><name>scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>40</value>"));
    assert!(x.contains("<horiz>0.2</horiz><vert>0.2</vert>"));
    assert!(x.contains("<value>50</value></parameter></effect></filter><comments><mastercomment1>deckwerk-grade {&quot;sat&quot;:0.5,&quot;temp&quot;:0.3}</mastercomment1></comments>"));
    assert!(x.contains("<value>Hallo &amp; tschüss</value>"));
    assert_eq!(
        srt(tl.subs.as_ref().unwrap()),
        "1\n00:00:00,000 --> 00:00:01,000\nHallo & tschüss\n"
    );
}
