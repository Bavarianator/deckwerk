//! Video-Schnitt (Layout clip): Transkript-Typen und die reinen Rechnungen aus `video.ts`, dazu Clip-Lint, Neuansätze,
//! Highlights und Transkriptsuche. Zeiten in Sekunden, Zahlen wie in JS (Reihenfolge der Additionen gleich).

mod clip;
mod highlights;
mod retakes;
mod search;

pub use clip::{
    ClipInfo, ClipIssue, MUSIC, Moved, OtherClip, SNAP, Severity, Size, SlideRef, Snapped,
    lint_clip, snap_to_words,
};
pub use highlights::{Highlight, HighlightOpts, Signals, highlights};
pub use retakes::{Retake, retakes};
pub use search::{Hit, OverviewSignals, overview, search_transcript};

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Word {
    pub w: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<Word>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub duration: f64,
    #[serde(default)]
    pub lang: String,
    #[serde(default)]
    pub segments: Vec<Segment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub covered: Option<Vec<[f64; 2]>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub start: f64,
    pub end: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<Vec<[f64; 2]>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub music: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freeze: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay {
    pub start: f64,
    pub end: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slide: Option<f64>,
    #[serde(default, rename = "box", skip_serializing_if = "Option::is_none")]
    pub box_: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sfx {
    pub src: String,
    pub at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipContent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
    #[serde(default)]
    pub parts: Vec<Part>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pauses: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cuts: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ton: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlays: Option<Vec<Overlay>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub look: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stabil: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption_pos: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sfx: Option<Vec<Sfx>>,
}

/// Stille im Quellvideo (start, end)
pub type Quiet = [f64; 2];

pub const PAD: f64 = 0.15;
pub const SPEED_MIN: f64 = 0.25;
pub const SPEED_MAX: f64 = 4.0;
pub const FREEZE_MIN: f64 = 0.3;
pub const FREEZE_MAX: f64 = 3.0;

/// `Math.max` (NaN gewinnt, +0 vor −0); Rusts `f64::max` übergeht NaN.
pub(crate) fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && b.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.min` (NaN gewinnt, −0 vor +0)
pub(crate) fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// JS-Wahrheitswert einer Zahl (0 und NaN sind falsch)
pub(crate) fn truthy(x: Option<f64>) -> bool {
    matches!(x, Some(v) if v != 0.0 && !v.is_nan())
}

/// Median wie `Float64Array.from(v).sort()`: numerisch, −0 vor +0, NaN ans Ende. Leer: NaN.
pub(crate) fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| match (a.is_nan(), b.is_nan()) {
        (false, false) => a.total_cmp(b),
        (x, y) => x.cmp(&y),
    });
    let m = s.len() >> 1;
    if s.is_empty() {
        f64::NAN
    } else if s.len() % 2 == 1 {
        s[m]
    } else {
        (s[m - 1] + s[m]) / 2.0
    }
}

pub(crate) static SENTENCE_END: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[.!?…]["'»«“”‘’)\]]*$"#).unwrap());
pub(crate) static PUNCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{P}").unwrap());

/// `w.replace(/[\p{P}\s]/gu, '').toLowerCase()`
pub(crate) fn bare(w: &str) -> String {
    PUNCT
        .replace_all(w, "")
        .chars()
        .filter(|&c| !crate::js::is_ws(c))
        .collect::<String>()
        .to_lowercase()
}

pub(crate) fn ends_sentence(w: &str) -> bool {
    SENTENCE_END.is_match(crate::js::trim(w))
}

pub fn speed_of(p: &Part) -> f64 {
    jmin(SPEED_MAX, jmax(SPEED_MIN, p.speed.unwrap_or(1.0)))
}

pub fn freeze_of(p: &Part) -> f64 {
    if truthy(p.freeze) {
        jmin(FREEZE_MAX, jmax(FREEZE_MIN, p.freeze.unwrap_or(0.0)))
    } else {
        0.0
    }
}

/// Länge eines parts im fertigen Clip (s): Quelllänge durch Tempo, dazu das gehaltene Standbild am Ende
pub fn part_len(p: &Part) -> f64 {
    jmax(0.0, p.end - p.start) / speed_of(p) + freeze_of(p)
}

pub fn parts_length<'a>(parts: impl IntoIterator<Item = &'a Part>) -> f64 {
    parts.into_iter().fold(0.0, |s, p| s + part_len(p))
}

/// Quellbereich a–b auf der Zeitachse des fertigen Clips: je part, der ihn schneidet, ein Stück; aneinanderstoßende verbunden.
pub fn clip_spans<'a>(parts: impl IntoIterator<Item = &'a Part>, a: f64, b: f64) -> Vec<[f64; 2]> {
    let mut out: Vec<[f64; 2]> = Vec::new();
    let mut off = 0.0;
    for p in parts {
        let s = jmax(a, p.start);
        let e = jmin(b, p.end);
        let sp = speed_of(p);
        if e > s {
            let x = off + (s - p.start) / sp;
            let y = if e >= p.end - PAD - 1e-3 {
                off + part_len(p)
            } else {
                off + (e - p.start) / sp
            };
            match out.last_mut() {
                Some(l) if x - l[1] < 1e-3 => l[1] = y,
                _ => out.push([x, y]),
            }
        }
        off += part_len(p);
    }
    out
}

/// `(a, b) => x - y` als Vergleich für `sort` (NaN = gleich)
pub(crate) fn by_diff(d: f64) -> std::cmp::Ordering {
    if d < 0.0 {
        std::cmp::Ordering::Less
    } else if d > 0.0 {
        std::cmp::Ordering::Greater
    } else {
        std::cmp::Ordering::Equal
    }
}

// start–end ohne die Stillen
fn speech(start: f64, end: f64, quiet: &[Quiet]) -> Vec<Quiet> {
    let mut q = quiet.to_vec();
    q.sort_by(|x, y| by_diff(x[0] - y[0]));
    let mut out = Vec::new();
    let mut t = start;
    for [a, b] in q {
        if b <= t || a >= end {
            continue;
        }
        if a > t {
            out.push([t, a]);
        }
        t = jmax(t, b);
    }
    if t < end {
        out.push([t, end]);
    }
    out
}

/// Wortzeiten eines Segments nach Zeichenanteil, verteilt über die Sprechzeit ohne die Stillen in quiet.
pub fn estimate_words(seg: &Segment, quiet: &[Quiet]) -> Vec<Word> {
    let ws = crate::js::words(&seg.text);
    let chars = ws
        .iter()
        .fold(0.0, |s, w| s + crate::js::len16(w) as f64 + 1.0);
    let mut spans = speech(seg.start, seg.end, quiet);
    if spans.is_empty() {
        spans.push([seg.start, jmax(seg.start, seg.end)]);
    }
    let total = spans.iter().fold(0.0, |s, [a, b]| s + b - a);
    let mut t = 0.0;
    ws.iter()
        .map(|w| {
            let d = (total * (crate::js::len16(w) as f64 + 1.0)) / chars;
            let mut mid = t + d / 2.0;
            let mut k = 0;
            while k < spans.len() - 1 && mid > spans[k][1] - spans[k][0] {
                mid -= spans[k][1] - spans[k][0];
                k += 1;
            }
            let [a, b] = spans[k];
            t += d;
            Word {
                w: (*w).to_string(),
                start: jmax(a, a + mid - d / 2.0),
                end: jmin(b, a + mid + d / 2.0),
            }
        })
        .collect()
}

/// `m:ss`
pub fn mmss(s: f64) -> String {
    let sec = crate::js::num((s % 60.0).floor());
    format!("{}:{sec:0>2}", crate::js::num((s / 60.0).floor()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        let p = |start, end| Part {
            start,
            end,
            ..Default::default()
        };
        let sp = clip_spans(
            &[
                p(0.0, 4.0),
                Part {
                    speed: Some(2.0),
                    ..p(10.0, 14.0)
                },
                p(14.0, 16.0),
            ],
            2.0,
            15.0,
        );
        assert_eq!(sp, vec![[2.0, 7.0]]);
        let fz = [
            Part {
                freeze: Some(1.0),
                ..p(0.0, 4.0)
            },
            p(10.0, 12.0),
        ];
        assert_eq!(parts_length(&fz), 7.0);
        assert_eq!(clip_spans(&fz, 2.0, 11.0), vec![[2.0, 6.0]]);
        assert_eq!(mmss(62.5), "1:02");
        assert!(median(&[]).is_nan());
        assert_eq!(median(&[3.0, f64::NAN, 1.0]), 3.0); // NaN ans Ende: [1, 3, NaN]
        // NaN-Tempo bleibt NaN wie Math.max/min
        assert!(
            speed_of(&Part {
                speed: Some(f64::NAN),
                ..p(0.0, 1.0)
            })
            .is_nan()
        );
        assert_eq!(bare(" Äh,"), "äh");
    }
}
