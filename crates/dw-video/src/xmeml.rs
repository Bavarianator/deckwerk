//! Schnittliste neben dem Video-Export als Final-Cut-7-XML (`main/export-xmeml.ts`, xmeml version 5) für Premiere und Resolve.
//! Die Zeitleiste spiegelt das MP4 (30 fps, fertige parts, V1 + A1/A2), Hook, Einblendungen, Standbild und Zuschnitt als Marker.

use crate::ffmpeg::Probe;
use crate::{
    Overlay, Part, clip_spans, freeze_of, has, jmax, jmin, num, part_len, parts_length, round,
    speed_of, trim,
};
use serde::{Deserialize, Serialize};

/// Marker in Sekunden ab Anfang der Szene; ohne end ein Punkt
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mark {
    pub t: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<f64>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// Eine Clip-Szene in der Ausgabedatei: at = Anfang (s), parts wie exportiert
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Scene {
    pub at: f64,
    pub src: String,
    pub info: Probe,
    pub parts: Vec<Part>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marks: Option<Vec<Mark>>,
}

const FPS: f64 = 30.0;

#[derive(Clone, Copy)]
struct Rate {
    tb: f64,
    ntsc: bool,
    real: f64,
}

// timebase + ntsc wie FCP 7: 29,97 → 30 TRUE, 25 → 25 FALSE
fn rate_of(fps: Option<f64>) -> Rate {
    let fps = match fps {
        Some(f) if f.is_finite() && f > 0.0 => f,
        _ => FPS,
    };
    let tb = jmax(1.0, round(fps));
    let ntsc = (fps - (tb * 1000.0) / 1001.0).abs() < (fps - tb).abs();
    Rate {
        tb,
        ntsc,
        real: if ntsc { (tb * 1000.0) / 1001.0 } else { tb },
    }
}

fn rate(r: Rate) -> String {
    format!(
        "<rate><timebase>{}</timebase><ntsc>{}</ntsc></rate>",
        num(r.tb),
        if r.ntsc { "TRUE" } else { "FALSE" }
    )
}

// Steuerzeichen sind in XML 1.0 verboten
fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\0'..='\x08' | '\x0B' | '\x0C' | '\x0E'..='\x1F' => {}
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            _ => o.push(c),
        }
    }
    o
}

fn de(n: f64) -> String {
    dw_lint::js::de(n, 2)
}

fn basename(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or(p)
}

/// `pathToFileURL(p).href` mit `file://localhost/` wie Premiere (Pfad absolut, Unix)
pub fn file_url(p: &str) -> String {
    let mut o = String::from("file://localhost");
    if !p.starts_with('/') {
        o.push('/');
    }
    for b in p.bytes() {
        match b {
            b'%'
            | b'\\'
            | b'#'
            | b'?'
            | b'"'
            | b'<'
            | b'>'
            | b'`'
            | b'{'
            | b'}'
            | b' '
            | 0..=0x1F
            | 0x7F.. => o.push_str(&format!("%{b:02X}")),
            _ => o.push(b as char),
        }
    }
    o
}

fn param(id: &str, value: &str, range: Option<(f64, f64)>) -> String {
    format!(
        "<parameter authoringApp=\"PremierePro\"><parameterid>{id}</parameterid><name>{id}</name>{}<value>{value}</value></parameter>",
        range.map_or(String::new(), |(a, b)| format!(
            "<valuemin>{}</valuemin><valuemax>{}</valuemax>",
            num(a),
            num(b)
        ))
    )
}

// Konstantes Tempo als Time Remap wie Premieres Export
fn remap(sp: f64, video: bool) -> String {
    let pct = dw_lint::js::to_fixed(sp * 100.0, 4)
        .parse::<f64>()
        .unwrap_or(f64::NAN);
    format!(
        "<filter><effect><name>Time Remap</name><effectid>timeremap</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype>{}{}{}{}{}</effect></filter>",
        if video {
            "<mediatype>video</mediatype>"
        } else {
            ""
        },
        param("variablespeed", "0", Some((0.0, 1.0))),
        param("speed", &num(pct), Some((-100000.0, 100000.0))),
        param("reverse", "FALSE", None),
        param("frameblending", "FALSE", None)
    )
}

/// Marker einer Clip-Szene: Hook ab 0, je Einblendung ihre sichtbaren Stücke auf der Clip-Achse
pub fn clip_marks(hook: Option<&str>, overlays: &[Overlay], parts: &[Part]) -> Vec<Mark> {
    let mut out = Vec::new();
    if let Some(h) = hook.map(trim).filter(|h| !h.is_empty()) {
        out.push(Mark {
            t: 0.0,
            end: Some(jmin(4.0, parts_length(parts))),
            name: "Hook".into(),
            comment: Some(h.into()),
        });
    }
    for x in overlays {
        let what = if crate::truthy(x.slide) {
            format!("Folie {}", num(x.slide.unwrap()))
        } else if has(&x.video) {
            "Video".into()
        } else if has(&x.image) {
            "Bild".into()
        } else {
            x.art.clone().unwrap_or_else(|| "text".into())
        };
        let comment: Vec<&str> = [x.text.as_deref(), x.sub.as_deref()]
            .into_iter()
            .chain(x.items.iter().flatten().map(|s| Some(s.as_str())))
            .flatten()
            .filter(|s| !trim(s).is_empty())
            .collect();
        for [t, end] in clip_spans(parts, x.start, x.end) {
            out.push(Mark {
                t,
                end: Some(end),
                name: format!("Einblendung {what}"),
                comment: Some(comment.join(" · ")),
            });
        }
    }
    out
}

struct Item<'a> {
    sc: &'a Scene,
    file: usize,
    r: Rate,
    sp: f64,
    start: f64,
    end: f64,
    r#in: f64,
    out: f64,
}

struct M {
    r#in: f64,
    out: f64,
    name: String,
    comment: String,
}

/// xmeml-Dokument für eine Ausgabedatei (duration in s); Spurzeiten kumulativ gerundet, kein Drift gegen das MP4
pub fn xmeml(name: &str, size: crate::Size, duration: f64, scenes: &[Scene]) -> String {
    let fr = |t: f64| round(t * FPS);
    let seq = rate(rate_of(Some(FPS)));
    let mut files: Vec<&str> = Vec::new();
    let mut items: Vec<Item> = Vec::new();
    let mut marks: Vec<M> = Vec::new();
    let len = |x: &Item| round(((x.end - x.start) * x.r.real) / FPS);
    for sc in scenes {
        if !files.contains(&sc.src.as_str()) {
            files.push(&sc.src);
        }
        let r = rate_of(sc.info.fps);
        let file = files.iter().position(|f| *f == sc.src).unwrap() + 1;
        let crop = sc.info.w / sc.info.h > size.w / size.h + 0.01;
        let mut t = sc.at;
        let mut focus: Option<f64> = None;
        for p in &sc.parts {
            let sp = speed_of(p);
            let ff = round(freeze_of(p) * FPS);
            let start = fr(t);
            t += part_len(p);
            let end = jmax(start, fr(t) - ff);
            let mut x = Item {
                sc,
                file,
                r,
                sp,
                start,
                end,
                r#in: round((p.start * r.real) / sp),
                out: 0.0,
            };
            x.out = x.r#in + len(&x);
            if end > start {
                items.push(x);
            }
            if ff != 0.0 {
                marks.push(M {
                    r#in: end,
                    out: end + ff,
                    name: "Standbild".into(),
                    comment: format!("Letztes Bild {} s halten (Freeze Frame)", de(ff / FPS)),
                });
            }
            if crop
                && let Some(f) = p.focus
                && Some(f) != focus
            {
                marks.push(M {
                    r#in: start,
                    out: -1.0,
                    name: "Zuschnitt".into(),
                    comment: format!("Bildmitte bei {} % der Breite", num(round(f * 100.0))),
                });
            }
            if let Some(z) = p.zoom
                && z > 1.0
            {
                marks.push(M {
                    r#in: start,
                    out: end,
                    name: "Zoom".into(),
                    comment: format!("{}×", de(z)),
                });
            }
            focus = p.focus;
        }
        for m in sc.marks.iter().flatten() {
            marks.push(M {
                r#in: fr(sc.at + m.t),
                out: m.end.map_or(-1.0, |e| fr(sc.at + e)),
                name: m.name.clone(),
                comment: m.comment.clone().unwrap_or_default(),
            });
        }
    }
    // Folienblende: die nächste Szene beginnt vor dem Ende der vorigen; harter Schnitt am Anfang der Blende
    for i in 1..items.len() {
        if items[i].start < items[i - 1].end {
            let s = items[i].start;
            let a = &mut items[i - 1];
            a.end = jmax(a.start, s);
            a.out = a.r#in + round(((a.end - a.start) * a.r.real) / FPS);
        }
    }
    let vs: Vec<&Item> = items.iter().filter(|x| x.end > x.start).collect();
    let r#as: Vec<&Item> = vs.iter().copied().filter(|x| x.sc.info.audio).collect();
    let vid = |i: usize| format!("clipitem-{}", i + 1);
    let aud = |k: usize, j: usize| format!("clipitem-{}", vs.len() + (k - 1) * r#as.len() + j + 1);
    let link = |r: &str, ty: &str, track: usize, idx: usize| {
        format!(
            "<link><linkclipref>{r}</linkclipref><mediatype>{ty}</mediatype><trackindex>{track}</trackindex><clipindex>{idx}</clipindex>{}</link>",
            if ty == "audio" {
                "<groupindex>1</groupindex>"
            } else {
                ""
            }
        )
    };
    let links = |x: &Item| {
        let i = vs.iter().position(|y| std::ptr::eq(*y, x)).unwrap();
        let mut s = link(&vid(i), "video", 1, i + 1);
        if let Some(j) = r#as.iter().position(|y| std::ptr::eq(*y, x)) {
            s += &link(&aud(1, j), "audio", 1, j + 1);
            s += &link(&aud(2, j), "audio", 2, j + 1);
        }
        s
    };
    let mut defined: Vec<usize> = Vec::new();
    // Erste Erwähnung beschreibt die Datei, danach nur die id (die Videospur steht vorn)
    let mut file_el = |x: &Item| {
        if defined.contains(&x.file) {
            return format!("<file id=\"file-{}\"/>", x.file);
        }
        defined.push(x.file);
        let (info, src) = (&x.sc.info, &x.sc.src);
        format!(
            "<file id=\"file-{}\"><name>{}</name><pathurl>{}</pathurl>{}<duration>{}</duration><timecode>{}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media>\
             <video><samplecharacteristics>{}<width>{}</width><height>{}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>{}</media></file>",
            x.file,
            esc(basename(src)),
            esc(&file_url(src)),
            rate(x.r),
            num(round(info.duration * x.r.real)),
            rate(x.r),
            rate(x.r),
            num(info.w),
            num(info.h),
            if info.audio {
                "<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>"
            } else {
                ""
            }
        )
    };
    // track: 0 = Video, 1/2 = linker/rechter Kanal
    let mut clip = |x: &Item, id: &str, track: usize| {
        format!(
            "<clipitem id=\"{id}\"{}><name>{}</name><enabled>TRUE</enabled><duration>{}</duration>{}<start>{}</start><end>{}</end><in>{}</in><out>{}</out>{}{}{}{}</clipitem>",
            if track > 0 {
                " premiereChannelType=\"stereo\""
            } else {
                ""
            },
            esc(basename(&x.sc.src)),
            num(round((x.sc.info.duration * x.r.real) / x.sp)),
            rate(x.r),
            num(x.start),
            num(x.end),
            num(x.r#in),
            num(x.out),
            file_el(x),
            if x.sp != 1.0 {
                remap(x.sp, track == 0)
            } else {
                String::new()
            },
            if track > 0 {
                format!(
                    "<sourcetrack><mediatype>audio</mediatype><trackindex>{track}</trackindex></sourcetrack>"
                )
            } else {
                String::new()
            },
            links(x)
        )
    };
    let group = |k: usize| {
        format!(
            "<group><index>{k}</index><numchannels>1</numchannels><downmix>0</downmix><channel><index>{k}</index></channel></group>"
        )
    };
    let mut out: Vec<String> = [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<!DOCTYPE xmeml>",
        "<xmeml version=\"5\">",
        "<sequence id=\"sequence-1\">",
    ]
    .map(String::from)
    .to_vec();
    out.push(format!("<name>{}</name>", esc(name)));
    out.push(format!("<duration>{}</duration>", num(fr(duration))));
    out.push(seq.clone());
    out.push("<media>".into());
    out.push("<video>".into());
    out.push(format!(
        "<format><samplecharacteristics>{seq}<width>{}</width><height>{}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>",
        num(size.w),
        num(size.h)
    ));
    out.push("<track>".into());
    for (i, x) in vs.iter().enumerate() {
        out.push(clip(x, &vid(i), 0));
    }
    out.push("<enabled>TRUE</enabled><locked>FALSE</locked></track>".into());
    out.push("</video>".into());
    out.push("<audio>".into());
    out.push("<numOutputChannels>2</numOutputChannels>".into());
    out.push("<format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>".into());
    out.push(format!("<outputs>{}{}</outputs>", group(1), group(2)));
    for k in [1, 2] {
        out.push(format!("<track currentExplodedTrackIndex=\"{}\" totalExplodedTrackCount=\"2\" premiereTrackType=\"Stereo\">", k - 1));
        for (j, x) in r#as.iter().enumerate() {
            out.push(clip(x, &aud(k, j), k));
        }
        out.push(format!("<enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>{k}</outputchannelindex></track>"));
    }
    out.push("</audio>".into());
    out.push("</media>".into());
    out.push(format!("<timecode>{seq}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>"));
    marks.sort_by(|a, b| {
        (a.r#in - b.r#in)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for m in &marks {
        out.push(format!(
            "<marker><comment>{}</comment><name>{}</name><in>{}</in><out>{}</out></marker>",
            esc(&m.comment),
            esc(&m.name),
            num(m.r#in),
            num(m.out)
        ));
    }
    out.extend(["</sequence>", "</xmeml>", ""].map(String::from));
    out.join("\n")
}
