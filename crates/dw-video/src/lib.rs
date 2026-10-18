//! Video-/Clip-Schnitt und -Export ohne Electron: Schnittliste (Pausen kürzen, Einrasten, Polster, Sprecher folgen),
//! ffmpeg-Argumente und Filtergraphen (Tempo, Lautstärke, Musik/Ducking, xfade, Zoom, Einblendungen, Verpixeln, Look,
//! Standbild, Untertitel/SRT), xmeml-Schnittliste, Film-Zeitachse, Farbkorrektur, Musik-Filter und Transkript-Chunks,
//! dazu ffmpeg/ffprobe als Prozess mit Fortschritt und Abbruch.
//!
//! Quelle: `shared/video.ts`, `film.ts`, `grade.ts`, `main/export-video.ts`, `video-fx.ts`, `ffmpeg.ts`, `export-film.ts`,
//! `export-xmeml.ts`, `music.ts`, `video-cache.ts`. Clip-Typen, Clip-Lint, Highlights und Neuansätze kommen aus
//! `dw_lint::video` und werden hier nur genutzt. Zahlen in Texten wie in JS (`String(x)`, `toFixed`), damit die
//! Filtergraphen zeichengleich zum TS-Stand sind (Differenztest `tests/video_diff.rs`).

pub mod ass;
pub mod cache;
pub mod cut;
pub mod export;
pub mod ffmpeg;
pub mod film;
pub mod fx;
pub mod grade;
pub mod music;
pub mod xmeml;

pub use dw_lint::video::{
    ClipContent, Overlay, PAD, Part, Quiet, Segment, Sfx, Size, Transcript, Word, clip_spans,
    estimate_words, freeze_of, mmss, part_len, parts_length, speed_of,
};
use serde::{Deserialize, Serialize};

/// Untertitel-Häppchen (Clip-Zeit)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    pub words: Vec<Word>,
}

/// Rechteck in px
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// `Math.max` (NaN gewinnt)
pub(crate) fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && b.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.min` (NaN gewinnt)
pub(crate) fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

pub(crate) fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    jmin(hi, jmax(lo, v))
}

/// JS-Wahrheitswert einer Zahl
pub(crate) fn truthy(x: Option<f64>) -> bool {
    matches!(x, Some(v) if v != 0.0 && !v.is_nan())
}

/// nicht leerer Text
pub(crate) fn has(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|s| !s.is_empty())
}

/// `${x}` für Zahlen
pub(crate) fn num(x: f64) -> String {
    dw_lint::js::num(x)
}

/// `x.toFixed(3)`
pub(crate) fn sec(x: f64) -> String {
    dw_lint::js::to_fixed(x, 3)
}

pub(crate) fn round(x: f64) -> f64 {
    dw_lint::js::round(x)
}

/// `String(i).padStart(2, '0')`
pub(crate) fn n2(i: usize) -> String {
    format!("{i:02}")
}

/// Gerade Maße für yuv420p, mindestens 2
pub(crate) fn even(n: f64) -> f64 {
    jmax(2.0, round(n / 2.0) * 2.0)
}

/// `String(Math.round(v * 1000) / 1000)`
pub(crate) fn fnum(v: f64) -> String {
    num(round(v * 1000.0) / 1000.0)
}

/// `s.trim()` nach JS
pub(crate) fn trim(s: &str) -> &str {
    dw_lint::js::trim(s)
}
