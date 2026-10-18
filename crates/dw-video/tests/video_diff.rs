//! Differenztest Rust ↔ TS: tests/fixtures/video.json kommt aus tests/gen/gen.mjs (Aufruf dort in Zeile 1).
//! Ergebnisse exakt gleich: Texte und ffmpeg-Argumente zeichengleich, Zahlen bitgleich (Fixture trägt sie als String(x)).
//! Bewusste Abweichungen stehen in `video_fixes.rs`.

use dw_lint::js::num;
use dw_video::ass::{AssIn, ass_subs};
use dw_video::cut::{self, SplitRects, Turn};
use dw_video::export::{
    self, ClipJob, FinishPlan, FxIn, Music, Seg, SegOpts, SfxFile, SubFont, Vol, check_clip,
    check_parts, cover_args, finish_plan, join_plan, measure_args, norm_from_measure, plan_clip,
    snap_stage, still_args,
};
use dw_video::ffmpeg::Probe;
use dw_video::film::{self, SceneIn, ScreenZoom, VoiceTiming};
use dw_video::fx::{self, ArtIn, Track};
use dw_video::grade::{self, Grade};
use dw_video::xmeml::{self, Scene};
use dw_video::{Cue, Overlay, Part, Quiet, Rect, Segment, Size, Transcript, Word, cache, music};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use std::path::Path;

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

/// got (Zahlen echt) gegen exp (Zahlen als String); Fehler mit Pfad
fn same(got: &Value, exp: &Value, path: &str) -> Result<(), String> {
    let bad = || Err(format!("{path}:\n  erwartet {exp}\n  bekommen {got}"));
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
        (Value::String(g), Value::String(e)) if g != e => {
            let at = g.chars().zip(e.chars()).take_while(|(a, b)| a == b).count();
            let ctx = |s: &str| {
                s.chars()
                    .skip(at.saturating_sub(60))
                    .take(160)
                    .collect::<String>()
            };
            Err(format!(
                "{path}: Text weicht ab bei Zeichen {at}\n  erwartet …{}\n  bekommen …{}",
                ctx(e),
                ctx(g)
            ))
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

fn f(c: &Value, k: &str) -> f64 {
    arg(c, k)
}

#[derive(Deserialize)]
struct FontIn {
    name: String,
    bold: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobIn {
    file: String,
    parts: Vec<Part>,
    hook: Option<String>,
    captions: String,
    transcript: Option<Transcript>,
    size: Size,
    font: FontIn,
    accent: String,
    pauses: Option<String>,
    fit: Option<String>,
    style: Option<String>,
    cuts: Option<Vec<f64>>,
    ton: Option<String>,
    #[serde(default)]
    overlays: Vec<Overlay>,
    look: Option<String>,
    #[serde(default)]
    stabil: bool,
    caption_pos: Option<String>,
    cam: Option<[f64; 4]>,
    #[serde(default)]
    sfx: Vec<SfxFile>,
}

fn job(c: &Value) -> ClipJob {
    let j: JobIn = arg(c, "job");
    ClipJob {
        file: j.file.into(),
        parts: j.parts,
        hook: j.hook,
        captions: j.captions,
        transcript: j.transcript,
        size: j.size,
        font: SubFont {
            name: j.font.name,
            files: vec![],
            bold: j.font.bold,
        },
        accent: j.accent,
        loudnorm: false,
        pauses: j.pauses,
        fit: j.fit,
        style: j.style,
        cuts: j.cuts,
        ton: j.ton,
        overlays: j.overlays,
        look: j.look,
        stabil: j.stabil,
        caption_pos: j.caption_pos,
        cam: j.cam,
        sfx: j.sfx,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptsIn {
    preset: String,
    fade_in: bool,
    fade_out: bool,
    hevc: bool,
}

fn seg_opts(c: &Value) -> SegOpts {
    let o: OptsIn = arg(c, "o");
    SegOpts {
        preset: o.preset,
        fade_in: o.fade_in,
        fade_out: o.fade_out,
        hevc: o.hevc,
    }
}

fn err(e: impl std::fmt::Display) -> Value {
    json!({ "error": e.to_string() })
}

fn clip_segs(c: &Value) -> Value {
    let job = job(c);
    let info: Probe = arg(c, "info");
    let exp = &c["expected"];
    if let Err(e) = check_parts(&job.parts, "video.mp4").and_then(|_| check_clip(&job, &info)) {
        return err(e);
    }
    let (snapped, _) = snap_stage(&job);
    let rec = exp["quiet"].as_array().cloned().unwrap_or_default();
    let mut quiet: Vec<Quiet> = Vec::new();
    let mut k = 0;
    if job.pauses.as_deref() == Some("kurz") && info.audio {
        for p in &snapped {
            let r = &rec[k];
            k += 1;
            assert_eq!(
                (num(p.start), num(p.end)),
                (
                    r["from"].as_str().unwrap().into(),
                    r["to"].as_str().unwrap().into()
                ),
                "{}: Stillen-Abfrage",
                c["name"]
            );
            let out: Vec<[String; 2]> = serde_json::from_value(r["out"].clone()).unwrap();
            quiet.extend(
                out.iter()
                    .map(|[a, b]| [a.parse::<f64>().unwrap(), b.parse::<f64>().unwrap()]),
            );
            if let Some(t) = &job.transcript {
                quiet.extend(cut::filler_quiet(t, p.start, p.end));
            }
        }
    }
    let look = fx::look_filter(job.look.as_deref().unwrap_or("neutral"));
    let dir: String = arg(c, "dir");
    let name: String = arg(c, "name");
    let plan = plan_clip(
        &job,
        &info,
        &snapped,
        &quiet,
        look,
        &name,
        Path::new(&dir),
        &seg_opts(c),
    );
    let files: serde_json::Map<String, Value> = plan
        .groups
        .iter()
        .filter_map(|g| Some((format!("{}.ass", g.id), json!(g.ass.clone()?))))
        .collect();
    json!({
        "segs": plan.groups.iter().map(|g| &g.seg).collect::<Vec<_>>(),
        "calls": plan.groups.iter().map(|g| json!({ "args": g.args, "cwd": dir, "duration": g.seg.dur })).collect::<Vec<_>>(),
        "quiet": exp["quiet"],
        "files": files,
    })
}

fn cover(c: &Value) -> Value {
    let job = job(c);
    let info: Probe = arg(c, "info");
    let t: Option<f64> = arg(c, "t");
    let out: String = arg(c, "out");
    let dir: String = arg(c, "dir");
    let look = fx::look_filter(job.look.as_deref().unwrap_or("neutral"));
    let (args, ass) = cover_args(&job, &info, t, look, Path::new(&out)).unwrap();
    let mut files = serde_json::Map::new();
    if let Some(a) = ass {
        files.insert("gesamt.ass".into(), json!(a));
    }
    json!({ "calls": [{ "args": args, "cwd": dir }], "files": files })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinishIn {
    loudnorm: bool,
    music: Option<Music>,
    hevc: bool,
}

fn finish(c: &Value) -> Value {
    let segs: Vec<Seg> = arg(c, "segs");
    let out: String = arg(c, "out");
    let dir: String = arg(c, "dir");
    let e: String = arg(c, "err");
    let o: FinishIn = arg(c, "o");
    let plan: FinishPlan = finish_plan(&segs, Path::new(&out), o.music.as_ref());
    let mut runs = vec![];
    let loud = if o.loudnorm {
        let mut a: Vec<String> = [
            "-hide_banner",
            "-nostdin",
            "-nostats",
            "-progress",
            "pipe:1",
        ]
        .map(String::from)
        .to_vec();
        a.extend(measure_args(-14.0, &plan.input, |l| plan.graph(l)));
        runs.push(a);
        norm_from_measure(-14.0, &e)
    } else {
        String::new()
    };
    let mut files = serde_json::Map::new();
    files.insert(plan.list_name.clone(), json!(plan.list));
    json!({ "calls": [{ "args": plan.args(&loud, &out, o.hevc), "cwd": dir, "duration": plan.dur }], "runs": runs, "files": files })
}

fn run(kind: &str, c: &Value) -> Value {
    match kind {
        "tighten" => json!(cut::tighten(
            &arg::<Vec<Part>>(c, "parts"),
            &arg::<Vec<Quiet>>(c, "quiet")
        )),
        "fillerQuiet" => json!(cut::filler_quiet(&arg(c, "t"), f(c, "from"), f(c, "to"))),
        "snapToScenes" => {
            let t: Option<Transcript> = arg(c, "t");
            json!(cut::snap_to_scenes(
                &arg::<Vec<Part>>(c, "parts"),
                &arg::<Vec<f64>>(c, "cuts"),
                t.as_ref(),
                f(c, "max")
            ))
        }
        "clipWords" => json!(cut::clip_words(
            &arg(c, "t"),
            &arg::<Vec<Part>>(c, "parts"),
            &arg::<Vec<Quiet>>(c, "quiet")
        )),
        "cues" => json!(cut::cues(
            &arg::<Vec<Word>>(c, "words"),
            arg::<String>(c, "mode") == "wort"
        )),
        "cutIndex" => json!(cut::cut_index(&arg::<Vec<Part>>(c, "parts"), arg(c, "i"))),
        "followParts" => json!(cut::follow_parts(
            &arg::<Vec<Part>>(c, "parts"),
            &arg::<Vec<Turn>>(c, "turns"),
            &arg::<Vec<(f64, f64)>>(c, "sx"),
            f(c, "min")
        )),
        "transcriptLines" => json!(cut::transcript_lines(&arg(c, "t"))),
        "outSize" => json!(cut::out_size(
            arg(c, "size"),
            arg::<Option<String>>(c, "res").as_deref()
        )),
        "videoSize" => json!(cut::video_size(
            arg(c, "size"),
            arg::<Option<String>>(c, "res").as_deref(),
            &arg::<Vec<Size>>(c, "sources")
        )),
        "cropRect" => json!(cut::crop_rect(arg(c, "src"), arg(c, "out"), f(c, "focus"))),
        "splitRects" => json!(cut::split_rects(
            arg(c, "src"),
            arg(c, "out"),
            arg(c, "cam"),
            f(c, "focus")
        )),
        "joinOf" => json!(cut::join_of(&arg::<String>(c, "t"), arg(c, "still"))),
        "ovPos" => json!(cut::ov_pos(
            arg::<Option<String>>(c, "art").as_deref(),
            arg::<Option<String>>(c, "pos").as_deref()
        )),
        "progressBar" => {
            let b = fx::progress_bar(
                arg(c, "size"),
                &arg::<String>(c, "accent"),
                f(c, "off"),
                f(c, "dur"),
                f(c, "total"),
                dw_video::ass::at,
            );
            json!({ "style": b.style, "event": b.event })
        }
        "hookBox" => json!(fx::hook_box(&arg::<String>(c, "style"), f(c, "pad"))),
        "zoomCrop" => json!(fx::zoom_crop(arg(c, "c"), f(c, "zoom"))),
        "cropFilter" => {
            #[derive(Deserialize)]
            struct T {
                src: Size,
                keys: Vec<[f64; 2]>,
                start: f64,
            }
            let t: Option<T> = arg(c, "track");
            let tr = t.as_ref().map(|t| Track {
                src: t.src,
                keys: &t.keys,
                start: t.start,
            });
            json!(fx::crop_filter(
                arg::<Rect>(c, "c"),
                arg(c, "size"),
                f(c, "zoom"),
                tr.as_ref()
            ))
        }
        "splitFilter" => json!(fx::split_filter(
            &arg::<SplitRects>(c, "r"),
            arg(c, "size"),
            &arg::<String>(c, "k")
        )),
        "levelExpr" => json!(fx::level_expr(
            f(c, "base"),
            &arg::<Vec<[f64; 3]>>(c, "spans"),
            f(c, "ramp")
        )),
        "autoLook" => json!(fx::auto_look(f(c, "avg"), f(c, "low"), f(c, "high"))),
        "artEvents" => {
            let s = |k: &str| arg::<Option<String>>(c, k);
            let (text, sub, items) = (s("text"), s("sub"), arg::<Option<Vec<String>>>(c, "items"));
            let r = fx::art_events(
                &ArtIn {
                    size: arg(c, "size"),
                    accent: &arg::<String>(c, "accent"),
                    art: &arg::<String>(c, "art"),
                    text: text.as_deref(),
                    sub: sub.as_deref(),
                    items: items.as_deref(),
                    r#box: arg(c, "box"),
                    el: arg(c, "el"),
                    len: arg(c, "len"),
                    al: f(c, "al"),
                    top: f(c, "top"),
                    low: f(c, "low"),
                    start: f(c, "start"),
                    end: f(c, "end"),
                    fade: arg(c, "fade"),
                    fade_ms: f(c, "fadeMs"),
                },
                dw_video::ass::at,
                dw_video::ass::esc,
            )
            .unwrap();
            json!({ "back": r.back, "front": r.front })
        }
        "srt" => json!(fx::srt(&arg::<Vec<Cue>>(c, "cs"))),
        "padParts" => json!(export::pad_parts(
            &arg::<Vec<Part>>(c, "parts"),
            f(c, "duration"),
            &arg::<Vec<f64>>(c, "cuts")
        )),
        "sfxGraph" => {
            #[derive(Deserialize)]
            struct X {
                input: usize,
                at: f64,
                gain: Option<f64>,
            }
            let fx: Vec<FxIn> = arg::<Vec<X>>(c, "fx")
                .into_iter()
                .map(|x| FxIn {
                    input: x.input,
                    at: x.at,
                    gain: x.gain,
                })
                .collect();
            json!(export::sfx_graph(
                &arg::<String>(c, "main"),
                &fx,
                &arg::<String>(c, "out")
            ))
        }
        "duckMusic" => {
            let v = c.get("volume").cloned().unwrap_or(Value::Null);
            let vol = match &v {
                Value::String(s) => Vol::Expr(s),
                Value::Number(n) => Vol::Num(n.as_f64()),
                _ => Vol::Num(None),
            };
            json!(export::duck_music("0:a", "1:a", vol, f(c, "dur"), "mx"))
        }
        "presetFor" => json!(export::preset_for(f(c, "s"), arg(c, "big"))),
        "assSubs" => json!(ass_subs(&arg::<AssIn>(c, "o"))),
        "clipSegs" => clip_segs(c),
        "cover" => cover(c),
        "finish" => finish(c),
        "joinSegs" => {
            let (args, seg) = join_plan(
                &arg(c, "a"),
                &arg(c, "b"),
                &arg::<String>(c, "t"),
                &arg::<String>(c, "out"),
                &arg::<String>(c, "preset"),
                arg(c, "hevc"),
            );
            json!({ "seg": seg, "calls": [{ "args": args, "cwd": arg::<String>(c, "dir") }] })
        }
        "still" => {
            let out: String = arg(c, "out");
            let args = still_args(&arg::<String>(c, "png"), &out, &seg_opts(c));
            json!({ "seg": { "file": out, "dur": 3 }, "calls": [{ "args": args, "cwd": arg::<String>(c, "dir"), "duration": 3 }] })
        }
        "voiceChunks" => json!(film::voice_chunks(&arg::<String>(c, "text"))),
        "estimateVoice" => json!(film::estimate_voice(
            &arg::<String>(c, "text"),
            f(c, "speed")
        )),
        "voiceTiming" => json!(film::voice_timing(
            &arg::<Vec<Vec<String>>>(c, "chunks"),
            &arg::<Vec<Vec<f64>>>(c, "durs")
        )),
        "sceneTimeline" => json!(film::scene_timeline(&arg::<SceneIn>(c, "o"))),
        "planScene" => {
            #[derive(Deserialize)]
            struct S {
                steps: Vec<f64>,
                words: f64,
                endless: Option<bool>,
                media: Option<f64>,
                voice: Option<VoiceTiming>,
                duration: Option<f64>,
            }
            let s: S = arg(c, "scene");
            json!(film::plan_scene(
                arg(c, "blend"),
                &SceneIn {
                    steps: s.steps,
                    voice: s.voice,
                    duration: s.duration,
                    words: s.words,
                    lead: 0.0,
                    endless: s.endless,
                    media: s.media
                }
            ))
        }
        "zoomAt" => json!(film::zoom_at(
            &arg::<Vec<ScreenZoom>>(c, "zooms"),
            f(c, "t")
        )),
        "grade" => {
            let g: Grade = arg(c, "g");
            json!({
                "neutral": grade::is_neutral(Some(&g)),
                "tables": grade::grade_tables(Some(&g)).map(|t| t.to_vec()),
                "sat": grade::sat_matrix(g.sat),
                "filter": grade::sat_filter(g.sat),
                "cube": grade::cube1d(Some(&g)),
                "svg": grade::svg_tables(Some(&g)),
            })
        }
        "applyTables" => {
            let g: Grade = arg(c, "g");
            let mut px: Vec<u8> = arg(c, "px");
            grade::apply_tables(&mut px, &grade::grade_tables(Some(&g)), g.sat);
            json!(px)
        }
        "clipMarks" => json!(xmeml::clip_marks(
            arg::<Option<String>>(c, "hook").as_deref(),
            &arg::<Vec<Overlay>>(c, "overlays"),
            &arg::<Vec<Part>>(c, "parts")
        )),
        "xmeml" => {
            let o = &c["o"];
            json!(xmeml::xmeml(
                &arg::<String>(o, "name"),
                arg(o, "size"),
                f(o, "duration"),
                &arg::<Vec<Scene>>(o, "scenes")
            ))
        }
        "music" => {
            let h: music::Hit = arg(c, "h");
            json!({ "ext": music::ext_of(&h), "usable": music::usable(&h, false), "kurz": music::usable(&h, true), "track": music::track(&h) })
        }
        "engineFor" => {
            let langs: Vec<String> = arg(c, "langs");
            let l: Vec<&str> = langs.iter().map(String::as_str).collect();
            json!(cache::engine_for(
                arg::<Option<String>>(c, "lang").as_deref(),
                &l,
                arg(c, "only")
            ))
        }
        "chunkWindow" => {
            let (from, dur) = cache::chunk_window(f(c, "k"), f(c, "duration"));
            json!({ "from": from, "dur": dur })
        }
        "chunksIn" => json!(cache::chunks_in(
            &arg::<Vec<[f64; 2]>>(c, "ranges"),
            f(c, "duration"),
            f(c, "size"),
            f(c, "back")
        )),
        "inChunk" => json!(cache::in_chunk(&arg::<Vec<Segment>>(c, "segs"), f(c, "k"))),
        "mergeSegments" => json!(cache::merge_segments(&arg::<Vec<Segment>>(c, "segs"))),
        "coveredOf" => json!(cache::covered_of(
            &arg::<Vec<f64>>(c, "ks"),
            f(c, "duration")
        )),
        "withSpeakers" => json!(cache::with_speakers(
            &arg::<Vec<Segment>>(c, "segs"),
            &arg::<Vec<Turn>>(c, "turns")
        )),
        "chatPerSecond" => json!(cache::chat_per_second(
            &arg::<Vec<Value>>(c, "chat"),
            arg(c, "n")
        )),
        "loudRanges" => json!(cache::loud_ranges(&arg::<Vec<f64>>(c, "loud"))),
        _ => panic!("unbekannte Art {kind}"),
    }
}

#[test]
fn video_gleich_ts() {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/video.json"
    ))
    .unwrap();
    let all: serde_json::Map<String, Value> = serde_json::from_str(&raw).unwrap();
    let pool = all["transcripts"].as_array().cloned().unwrap_or_default();
    let mut fails = Vec::new();
    let mut n = 0;
    for (kind, cases) in &all {
        if kind == "transcripts" {
            continue;
        }
        for c in cases.as_array().unwrap() {
            let c = resolve(c, &pool);
            n += 1;
            let got = run(kind, &c);
            if let Err(e) = same(&got, &c["expected"], c["name"].as_str().unwrap()) {
                fails.push(e);
            }
        }
    }
    assert!(n > 1000, "zu wenige Fälle: {n}");
    if !fails.is_empty() {
        let k = fails.len();
        fails.truncate(8);
        panic!("{k} Abweichungen:\n{}", fails.join("\n\n"));
    }
}
