//! Bewusste Abweichungen vom TS-Stand, je mit Begründung (der Differenztest `video_diff.rs` deckt den Rest).

use dw_video::cut::{overlay_w, snap_to_scenes};
use dw_video::export::{norm_from_measure, pad_parts};
use dw_video::ffmpeg::parse_probe;
use dw_video::{PAD, Part};
use std::path::Path;
use std::time::Instant;

fn rnd(seed: &mut u64) -> f64 {
    *seed ^= *seed << 13;
    *seed ^= *seed >> 7;
    *seed ^= *seed << 17;
    (*seed >> 11) as f64 / (1u64 << 53) as f64
}

fn parts(n: usize, seed: &mut u64) -> Vec<Part> {
    let mut t = 0.0;
    (0..n)
        .map(|_| {
            t += rnd(seed) * 3.0;
            let p = Part {
                start: t,
                end: t + 0.5 + rnd(seed) * 4.0,
                ..Default::default()
            };
            t = if rnd(seed) < 0.2 {
                p.end
            } else {
                p.end + rnd(seed)
            };
            p
        })
        .collect()
}

// padParts wörtlich aus TS (O(n²))
fn pad_naive(parts: &[Part], duration: f64, cuts: &[f64]) -> Vec<Part> {
    parts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let (mut start, mut end) = ((p.start - PAD).max(0.0), (p.end + PAD).min(duration));
            for (j, q) in parts.iter().enumerate() {
                if j == i {
                    continue;
                }
                if q.end <= p.start {
                    start = start.max((q.end + p.start) / 2.0)
                }
                if q.start >= p.end {
                    end = end.min((p.end + q.start) / 2.0)
                }
            }
            for &c in cuts {
                if c > start && c <= p.start {
                    start = c
                }
                if c >= p.end && c < end {
                    end = c
                }
            }
            Part {
                start,
                end,
                ..p.clone()
            }
        })
        .collect()
}

/// §7.5: padParts und snapToScenes waren O(n²) bzw. O(parts·cuts) mit Spread; sortiert + Binärsuche gibt dasselbe Ergebnis
#[test]
fn pad_und_einrasten_ohne_quadrat() {
    let mut seed = 0x9e3779b97f4a7c15;
    for n in [1, 2, 7, 40, 300] {
        let ps = parts(n, &mut seed);
        let d = ps.last().unwrap().end + 1.0;
        let cuts: Vec<f64> = (0..n * 2).map(|_| rnd(&mut seed) * d).collect();
        assert_eq!(
            pad_parts(&ps, d, &cuts),
            pad_naive(&ps, d, &cuts),
            "n = {n}"
        );
    }
    // 8-h-Stream: 20 000 Ausschnitte, 200 000 Bildwechsel
    let ps = parts(20_000, &mut seed);
    let d = ps.last().unwrap().end + 1.0;
    let cuts: Vec<f64> = (0..200_000).map(|_| rnd(&mut seed) * d).collect();
    let t = Instant::now();
    let a = pad_parts(&ps, d, &cuts);
    let b = snap_to_scenes(&ps, &cuts, None, 0.3);
    // quadratisch wären das ~4·10⁹ Vergleiche (Minuten im Debug-Build); großzügige Grenze, der Rechner ist oft ausgelastet
    assert!(
        t.elapsed().as_secs_f64() < 30.0,
        "zu langsam: {:?}",
        t.elapsed()
    );
    assert_eq!(a.len(), ps.len());
    assert!(b.moved > 0);
}

/// TS: `OVERLAY_W[x.size ?? 'mittel']` gab für unbekannte Größen undefined → `scale=NaN:-1` (ffmpeg-Fehler); hier mittel
#[test]
fn unbekannte_bildgroesse_ist_mittel() {
    assert_eq!(overlay_w(Some("riesig")), overlay_w(Some("mittel")));
    assert_eq!(overlay_w(None), 0.4);
}

/// §8.3: Probe per ffprobe-JSON. TS las „29.97 fps“ (gerundet) aus der stderr; avg_frame_rate ist exakt 30000/1001,
/// damit trifft die NTSC-Erkennung der xmeml-Schnittliste sicher
#[test]
fn probe_fps_exakt() {
    let j = r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,"avg_frame_rate":"30000/1001"}],"format":{"duration":"1"}}"#;
    assert_eq!(
        parse_probe(j, Path::new("x.mp4")).unwrap().fps,
        Some(30000.0 / 1001.0)
    );
    let j = r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,"avg_frame_rate":"0/0"}],"format":{"duration":"1"}}"#;
    assert_eq!(parse_probe(j, Path::new("x.mp4")).unwrap().fps, None);
}

/// Plan §5.1: loudnorm-Messwerte aus dem JSON-Block statt per Regex über die ganze stderr
#[test]
fn loudnorm_aus_json() {
    let err = "Stream #0: \"input_i\" : \"-1\"\n[Parsed_loudnorm_0 @ 0x1]\n{\n\t\"input_i\" : \"-20.5\",\n\t\"input_tp\" : \"-2\",\n\t\"input_lra\" : \"4\",\n\t\"input_thresh\" : \"-31\",\n\t\"target_offset\" : \"0.5\"\n}\n";
    assert!(norm_from_measure(-14.0, err).contains("measured_I=-20.5:"));
    assert_eq!(
        norm_from_measure(-14.0, "kaputt"),
        ",loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,asetpts=N/SR/TB"
    );
}

/// Fix (Injection): ein Name wie `a:b,c's` landete ungefiltert in `ass=<id>.ass` (Filtergraph) und in der concat-Liste
#[test]
fn namen_ohne_filter_injection() {
    use dw_video::export::{ClipJob, SegOpts, finish_plan, plan_clip, safe_name};
    use dw_video::ffmpeg::Probe;
    let parts = vec![Part {
        start: 1.0,
        end: 3.0,
        ..Default::default()
    }];
    let mut job = ClipJob::new(
        "/q/v.mp4",
        parts.clone(),
        dw_video::Size { w: 360.0, h: 640.0 },
    );
    job.hook = Some("Hook".into());
    let info = Probe {
        duration: 10.0,
        w: 640.0,
        h: 360.0,
        fps: None,
        audio: true,
    };
    let plan = plan_clip(
        &job,
        &info,
        &parts,
        &[],
        "",
        "a:b,c's",
        Path::new("job"),
        &SegOpts::default(),
    );
    let g = &plan.groups[0];
    assert_eq!(g.id, "a_b_c_s-01");
    let graph = &g.args[g.args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
    assert!(graph.contains("ass=a_b_c_s-01.ass:fontsdir=fonts") && !graph.contains("a:b"));
    let f = finish_plan(
        std::slice::from_ref(&g.seg),
        Path::new("job/a:b,c's.mp4"),
        None,
    );
    assert_eq!(f.list_name, "a_b_c_s.mp4.txt");
    assert_eq!(f.list, "file 'a_b_c_s-01.mkv'");
    assert_eq!(safe_name("", false), "clip");
}
