//! Schnittliste (`shared/video.ts`): Konstanten, Übergänge, Pausen kürzen, Füllwörter, Einrasten an Bildwechseln,
//! Wörter und Untertitel auf der Clip-Achse, Sprecher folgen, Ausgabegrößen und Zuschnitte.

use crate::{
    Cue, Part, Quiet, Rect, Segment, Size, Transcript, Word, estimate_words, even, jmax, jmin,
    part_len, round, speed_of, trim, truthy,
};
use dw_lint::js::{len16, to_fixed};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

pub use dw_lint::video::PAD;

pub const CUT_TRANSITIONS: [&str; 10] = [
    "none", "fade", "dissolve", "push", "wipe", "circle", "zoom", "split", "stack", "color",
];

/// Übergang als ffmpeg-xfade-Typ (nur Typen, die auch ffmpeg 6.1 kennt); none/morph = harter Schnitt
pub fn xfade(t: &str) -> Option<&'static str> {
    Some(match t {
        "fade" => "fade",
        "dissolve" => "dissolve",
        "push" | "slide" => "slideleft",
        "wipe" => "wipeleft",
        "circle" => "circleopen",
        "zoom" => "zoomin",
        "split" => "horzopen",
        "cover" | "stack" => "smoothleft",
        "color" => "fadeblack",
        _ => return None,
    })
}

/// Folienwechsel im mp4
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Join {
    Blend,
    Schwarz,
    Hart,
}

/// blend = echte Überblendung, schwarz = über Schwarz, hart = Schnitt; still = eine der beiden Folien hat kein Video
pub fn join_of(t: &str, still: bool) -> Join {
    if t != "color" && xfade(t).is_some() {
        Join::Blend
    } else if t == "color" || still {
        Join::Schwarz
    } else {
        Join::Hart
    }
}

pub const OVERLAY_POS: [&str; 8] = [
    "oben",
    "mitte",
    "unten",
    "oben-links",
    "oben-rechts",
    "unten-links",
    "unten-rechts",
    "voll",
];

/// Lage einer Einblendung: titel, zitat, abspann immer mitte, sonst pos oder Standard je Art
pub fn ov_pos<'a>(art: Option<&str>, pos: Option<&'a str>) -> &'a str {
    match art {
        Some("titel" | "zitat" | "abspann") => "mitte",
        _ => pos.unwrap_or(match art {
            Some("bauchbinde") => "unten-links",
            Some("liste") => "oben-links",
            Some("zahl") => "mitte",
            _ => "unten",
        }),
    }
}

/// Abstand der Listenpunkte (s)
pub fn list_step(n: f64, len: f64) -> f64 {
    jmin(1.2, len / (n + 1.0))
}

pub fn is_media(o: &crate::Overlay) -> bool {
    crate::has(&o.image) || crate::has(&o.video) || truthy(o.slide)
}

pub const MAX_MEDIA: usize = 8;
pub const SPLIT_TOP: f64 = 0.4;

/// Bildbreite einer Bild-Einblendung als Anteil der Videobreite (Standard mittel).
/// TS lieferte für unbekannte Größen `undefined` → `scale=NaN`; hier mittel (Schema lässt nur die drei zu).
pub fn overlay_w(size: Option<&str>) -> f64 {
    match size {
        Some("klein") => 0.25,
        Some("gross") => 0.6,
        _ => 0.4,
    }
}

pub const SPEED: (f64, f64) = (0.25, 4.0);
pub const ZOOM: (f64, f64) = (1.0, 1.5);
pub const FREEZE: (f64, f64) = (0.3, 3.0);

/// Werte des Clip-Stils lebendig (Export und Vorschau)
pub mod fxv {
    pub const POP: f64 = 1.08;
    pub const POP_MS: f64 = 120.0;
    pub const HOOK_FADE_MS: f64 = 200.0;
    pub const ZOOM: f64 = 1.08;
    pub const BAR: f64 = 0.006;
}

/// Hintergrundmusik: Pegel, Blenden (s), Ducking (Schwelle linear, Verhältnis, ms)
pub mod duck {
    pub const VOLUME: f64 = 0.25;
    pub const FADE_IN: f64 = 1.0;
    pub const FADE_OUT: f64 = 2.0;
    pub const THRESHOLD: f64 = 0.006;
    pub const RATIO: f64 = 8.0;
    pub const ATTACK_MS: f64 = 20.0;
    pub const RELEASE_MS: f64 = 300.0;
}

/// Sprung ab dem ein neuer Moment beginnt (s) und Blenden in Frames bei 30 fps
pub const CUT_MOMENT: f64 = 20.0;
pub const JUMP_FRAMES: f64 = 4.0;
pub const MOMENT_FRAMES: f64 = 16.0;

// NaN zählt wie in TS als Jump-Cut, darum kein Range::contains
#[allow(clippy::manual_range_contains)]
pub fn cut_frames(gap: f64) -> f64 {
    if gap >= CUT_MOMENT || gap < 0.0 {
        MOMENT_FRAMES
    } else {
        JUMP_FRAMES
    }
}

pub const STILL: f64 = 3.0;
pub const MIN_PAUSE: f64 = 0.6;
pub const MAX_PARTS: usize = 100;
pub const LONG_VIDEO: f64 = 600.0;

/// Zahl der Momentwechsel bis Ausschnitt i
pub fn cut_index(parts: &[Part], i: usize) -> usize {
    (1..=i.min(parts.len().saturating_sub(1)))
        .filter(|&k| cut_frames(parts[k].start - parts[k - 1].end) == MOMENT_FRAMES)
        .count()
}

/// cut_index für alle i auf einmal. TS rief cutIndex je Ausschnitt neu auf (O(n²), §7.5).
pub(crate) fn cut_indices(parts: &[Part]) -> Vec<usize> {
    let mut out = Vec::with_capacity(parts.len());
    let mut n = 0;
    for k in 0..parts.len() {
        if k > 0 && cut_frames(parts[k].start - parts[k - 1].end) == MOMENT_FRAMES {
            n += 1;
        }
        out.push(n);
    }
    out
}

/// Zoom nach dem part-ten Momentwechsel: jeder zweite, nur im Stil lebendig
pub fn zoom_of(style: Option<&str>, part: usize) -> f64 {
    if part % 2 == 1 && style == Some("lebendig") {
        fxv::ZOOM
    } else {
        1.0
    }
}

fn by_diff(d: f64) -> std::cmp::Ordering {
    d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
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

/// Pausen kürzen: jeden part an den Stillen teilen. Ein part aus reiner Stille bleibt, wie er ist.
pub fn tighten(parts: &[Part], quiet: &[Quiet]) -> Vec<Part> {
    parts
        .iter()
        .flat_map(|p| {
            let s = speech(p.start, p.end, quiet);
            if s.is_empty() {
                vec![p.clone()]
            } else {
                s.into_iter()
                    .map(|[start, end]| Part {
                        start,
                        end,
                        ..p.clone()
                    })
                    .collect()
            }
        })
        .collect()
}

static FILLERS: LazyLock<Regex> = LazyLock::new(|| {
    let ws = dw_lint::js::WS;
    Regex::new(&format!(
        r"(?i)^[\p{{P}}{ws}]*(?:äh|ähm|öh|öhm|hm|hmm|mhm|uh|um|uhm|erm)[\p{{P}}{ws}]*$"
    ))
    .unwrap()
});
static PUNCT_WS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"[\p{{P}}{}]", dw_lint::js::WS)).unwrap());

/// Füllwort (ganzes Wort, Satzzeichen und Groß/klein egal)
pub fn is_filler(w: &str) -> bool {
    FILLERS.is_match(w)
}

fn all_words(t: &Transcript) -> impl Iterator<Item = &Word> {
    t.segments.iter().flat_map(|s| s.words.iter().flatten())
}

/// Füllwörter in from–to als Stillen für tighten(), je Seite PAD breiter; nur echte Wortzeiten
pub fn filler_quiet(t: &Transcript, from: f64, to: f64) -> Vec<Quiet> {
    let en = t.lang.starts_with("en");
    all_words(t)
        .filter(|w| {
            w.end > from
                && w.start < to
                && is_filler(&w.w)
                && (en || PUNCT_WS.replace_all(&w.w, "").to_lowercase() != "um")
        })
        .map(|w| [jmax(from, w.start - PAD), jmin(to, w.end + PAD)])
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneSnap {
    pub parts: Vec<Part>,
    pub moved: usize,
}

/// Kanten bis max s vor/nach einem harten Bildwechsel auf den Wechsel legen, außer ein echtes Wort würde angeschnitten,
/// an nahtlosen Übergängen oder wenn der Teil unter 0,5 s fiele.
/// Fix (§7.5 L9): TS nahm `Math.max(...cuts.filter())` je part (O(parts·cuts), Spread sprengt bei langen Videos die
/// Argumentgrenze); hier sortiert + Binärsuche, gleiches Ergebnis.
pub fn snap_to_scenes(parts: &[Part], cuts: &[f64], t: Option<&Transcript>, max: f64) -> SceneSnap {
    let ws: Vec<&Word> = t.map(|t| all_words(t).collect()).unwrap_or_default();
    let mut cs: Vec<f64> = cuts.iter().copied().filter(|c| !c.is_nan()).collect();
    cs.sort_by(f64::total_cmp);
    let joined =
        |j: usize| j > 0 && j < parts.len() && (parts[j - 1].end - parts[j].start).abs() < 1e-3;
    let mut moved = 0;
    let out = parts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut q = p.clone();
            // größter Wechsel mit c > start und c − start ≤ max (c − start steigt mit c)
            let lo = cs.partition_point(|&c| c <= p.start);
            let hi = lo + cs[lo..].partition_point(|&c| c - p.start <= max);
            let start = if hi > lo {
                cs[hi - 1]
            } else {
                f64::NEG_INFINITY
            };
            // kleinster Wechsel mit c < end und end − c ≤ max
            let e = cs.partition_point(|&c| c < p.end);
            let b = cs[..e].partition_point(|&c| p.end - c > max);
            let end = if b < e { cs[b] } else { f64::INFINITY };
            for (is_start, to) in [(true, start), (false, end)] {
                if !to.is_finite() || joined(if is_start { i } else { i + 1 }) {
                    continue;
                }
                let (a, b) = if is_start { (p.start, to) } else { (to, p.end) };
                let short = if is_start { q.end - to } else { to - q.start } < 0.5;
                if ws.iter().any(|w| w.end - 0.05 > a && w.start + 0.05 < b) || short {
                    continue;
                }
                if is_start {
                    q.start = to
                } else {
                    q.end = to
                }
                moved += 1;
            }
            q
        })
        .collect();
    SceneSnap { parts: out, moved }
}

/// Wörter der parts auf der Zeitachse des fertigen Clips; ein Wort gehört zum part, in dem seine Mitte liegt.
pub fn clip_words(t: &Transcript, parts: &[Part], quiet: &[Quiet]) -> Vec<Word> {
    let all: Vec<Word> = t
        .segments
        .iter()
        .flat_map(|s| match &s.words {
            Some(w) if !w.is_empty() => w.clone(),
            _ => estimate_words(s, quiet),
        })
        .collect();
    let mut out = Vec::new();
    let mut offset = 0.0;
    for p in parts {
        let sp = speed_of(p);
        for w in &all {
            let mid = (w.start + w.end) / 2.0;
            if mid < p.start || mid >= p.end {
                continue;
            }
            out.push(Word {
                w: w.w.clone(),
                start: offset + jmax(0.0, w.start - p.start) / sp,
                end: offset + (jmin(p.end, w.end) - p.start) / sp,
            });
        }
        offset += part_len(p);
    }
    out
}

/// Untertitel-Häppchen: wort = bis 3 Wörter (≤ 18 Zeichen), satz = bis ~42 Zeichen; Bruch an Satzende und Pausen > 0,6 s
pub fn cues(words: &[Word], wort: bool) -> Vec<Cue> {
    let (max_words, max_chars) = if wort { (3, 18) } else { (12, 42) };
    let mut out: Vec<Cue> = Vec::new();
    let mut cur: Vec<Word> = Vec::new();
    let flush = |cur: &mut Vec<Word>, out: &mut Vec<Cue>| {
        if let (Some(a), Some(b)) = (cur.first(), cur.last()) {
            out.push(Cue {
                start: a.start,
                end: b.end,
                words: std::mem::take(cur),
            });
        }
    };
    for w in words {
        let len = cur.iter().map(|x| len16(&x.w) + 1).sum::<usize>() + len16(&w.w);
        if let Some(last) = cur.last()
            && (cur.len() >= max_words
                || len > max_chars
                || w.start - last.end > 0.6
                || last.w.ends_with(['.', '!', '?', '…']))
        {
            flush(&mut cur, &mut out);
        }
        cur.push(w.clone());
    }
    flush(&mut cur, &mut out);
    for i in 0..out.len().saturating_sub(1) {
        if out[i + 1].start - out[i].end < 0.3 {
            out[i].end = out[i + 1].start;
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Turn {
    pub start: f64,
    pub end: f64,
    pub speaker: f64,
}

// Nachbarn desselben Sprechers verbinden, Stücke kürzer als min dem Vorgänger (am Anfang dem Nachfolger) zuschlagen
fn settle(ts: &[Turn], min: f64) -> Vec<Turn> {
    let merge = |xs: &[Turn]| {
        let mut o: Vec<Turn> = Vec::new();
        for t in xs {
            match o.last_mut() {
                Some(l) if l.speaker == t.speaker => l.end = jmax(l.end, t.end),
                _ => o.push(*t),
            }
        }
        o
    };
    let mut out = merge(ts);
    while out.len() > 1 {
        let Some(k) = out.iter().position(|t| t.end - t.start < min) else {
            break;
        };
        if k > 0 {
            out[k - 1].end = out[k].end
        } else {
            out[1].start = out[0].start
        }
        out.remove(k);
        out = merge(&out);
    }
    out
}

/// Zuschnitt folgt dem Sprecher: parts an Sprecherwechseln teilen, focus je Stück = speaker_x des Sprechers.
pub fn follow_parts(
    parts: &[Part],
    turns: &[Turn],
    speaker_x: &[(f64, f64)],
    min: f64,
) -> Vec<Part> {
    let x_of = |s: f64| speaker_x.iter().find(|(k, _)| *k == s).map(|(_, v)| *v);
    let mut known: Vec<Turn> = turns
        .iter()
        .copied()
        .filter(|t| x_of(t.speaker).is_some())
        .collect();
    if known.is_empty() {
        return parts.to_vec();
    }
    known.sort_by(|a, b| by_diff(a.start - b.start));
    let chained: Vec<Turn> = known
        .iter()
        .enumerate()
        .map(|(k, t)| Turn {
            end: known.get(k + 1).map_or(t.end, |n| n.start),
            ..*t
        })
        .collect();
    let shots = settle(&chained, min);
    let at = |t: f64| {
        *shots
            .iter()
            .rev()
            .find(|s| s.start <= t)
            .unwrap_or(&shots[0])
    };
    parts
        .iter()
        .flat_map(|p| {
            if p.focus.is_some() {
                return vec![p.clone()];
            }
            let mut cuts = vec![p.start];
            cuts.extend(
                shots
                    .iter()
                    .map(|s| s.start)
                    .filter(|&t| t > p.start && t < p.end),
            );
            let pieces: Vec<Turn> = cuts
                .iter()
                .enumerate()
                .map(|(k, &start)| Turn {
                    start,
                    end: cuts.get(k + 1).copied().unwrap_or(p.end),
                    speaker: at(start).speaker,
                })
                .collect();
            settle(&pieces, min)
                .into_iter()
                .map(|s| Part {
                    start: s.start,
                    end: s.end,
                    focus: x_of(s.speaker),
                    ..p.clone()
                })
                .collect()
        })
        .collect()
}

/// Wählbare Auflösung (kurze Seite in px)
pub fn video_res(res: &str) -> Option<f64> {
    Some(match res {
        "720p" => 720.0,
        "1080p" => 1080.0,
        "1440p" => 1440.0,
        "4k" => 2160.0,
        "8k" => 4320.0,
        _ => return None,
    })
}

/// Ausgabegröße im MP4: ohne res 1,5-fach (längere Seite ≤ 3840), mit res kurze Seite nach video_res (längere ≤ 7680)
pub fn out_size(size: Size, res: Option<&str>) -> Size {
    let k = match res.and_then(video_res) {
        Some(r) => jmin(r / jmin(size.w, size.h), 7680.0 / jmax(size.w, size.h)),
        None => jmin(1.5, 3840.0 / jmax(size.w, size.h)),
    };
    Size {
        w: even(size.w * k),
        h: even(size.h * k),
    }
}

/// Ausgabegröße mit Wahl res, nie hochskaliert: min(Wahl, max(Standard, Quelle))
pub fn video_size(size: Size, res: Option<&str>, sources: &[Size]) -> Size {
    let want = out_size(size, res);
    let base = out_size(size, None);
    if res.is_none() || sources.is_empty() || base.w >= want.w {
        return want;
    }
    let f = sources
        .iter()
        .map(|s| {
            let c = crop_rect(*s, want, 0.5);
            jmin(c.w / want.w, c.h / want.h)
        })
        .fold(f64::NEG_INFINITY, jmax);
    if f >= 1.0 {
        want
    } else if f * want.w <= base.w {
        base
    } else {
        Size {
            w: even(want.w * f),
            h: even(want.h * f),
        }
    }
}

/// Ausschnitt der Quelle (px), der das Zielformat füllt: horizontal um focus, vertikal mittig
pub fn crop_rect(src: Size, out: Size, focus: f64) -> Rect {
    let r = out.w / out.h;
    if src.w / src.h > r {
        let w = jmin(src.w, even(src.h * r));
        return Rect {
            x: round(jmin(src.w - w, jmax(0.0, focus * src.w - w / 2.0))),
            y: 0.0,
            w,
            h: src.h,
        };
    }
    let h = jmin(src.h, even(src.w / r));
    Rect {
        x: 0.0,
        y: round((src.h - h) / 2.0),
        w: src.w,
        h,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SplitRects {
    pub top: f64,
    pub cam: Rect,
    pub game: Rect,
}

/// fit split: Facecam-Fenster cam (Anteile der Quelle) füllt oben top px, darunter das Spielbild um focus
pub fn split_rects(src: Size, out: Size, cam: [f64; 4], focus: f64) -> SplitRects {
    let top = even(out.h * SPLIT_TOP);
    let x = round(jmin(src.w - 2.0, jmax(0.0, cam[0] * src.w)));
    let y = round(jmin(src.h - 2.0, jmax(0.0, cam[1] * src.h)));
    let c = crop_rect(
        Size {
            w: jmin(src.w - x, even(cam[2] * src.w)),
            h: jmin(src.h - y, even(cam[3] * src.h)),
        },
        Size { w: out.w, h: top },
        0.5,
    );
    SplitRects {
        top,
        cam: Rect {
            x: c.x + x,
            y: c.y + y,
            ..c
        },
        game: crop_rect(
            src,
            Size {
                w: out.w,
                h: out.h - top,
            },
            focus,
        ),
    }
}

/// Transkript für die KI: „[s12] 61.2–66.8 Text“
pub fn transcript_lines(t: &Transcript) -> Vec<String> {
    t.segments
        .iter()
        .enumerate()
        .map(|(i, s): (usize, &Segment)| {
            format!(
                "[s{i}] {}–{} {}",
                to_fixed(s.start, 1),
                to_fixed(s.end, 1),
                trim(&s.text)
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(x: &str, start: f64) -> Word {
        Word {
            w: x.into(),
            start,
            end: start + 0.3,
        }
    }

    // Selbstprüfung aus video.ts
    #[test]
    fn fillers() {
        let t = Transcript {
            duration: 10.0,
            lang: "de".into(),
            segments: vec![
                Segment {
                    start: 0.0,
                    end: 3.0,
                    words: Some(vec![
                        w(" Also", 0.0),
                        w(" Äh,", 1.0),
                        w(" um", 1.5),
                        w(" hmm…", 2.0),
                    ]),
                    ..Default::default()
                },
                Segment {
                    start: 3.0,
                    end: 5.0,
                    text: "ähm geschätzt".into(),
                    ..Default::default()
                },
            ],
            covered: None,
        };
        let q = filler_quiet(&t, 0.0, 10.0);
        assert_eq!(q.len(), 2);
        assert_eq!(q[0][0], 1.0 - PAD);
        assert_eq!(q[1][1], 2.3 + PAD);
        let en = Transcript {
            lang: "en".into(),
            ..t.clone()
        };
        assert_eq!(filler_quiet(&en, 0.0, 10.0).len(), 3);
        assert_eq!(filler_quiet(&t, 1.6, 10.0).len(), 1);
        assert!(!is_filler("ähnlich") && !is_filler("Hummel") && is_filler("Ähm..."));
    }

    #[test]
    fn indices() {
        let p = |s, e| Part {
            start: s,
            end: e,
            ..Default::default()
        };
        let ps = [p(0.0, 2.0), p(30.0, 32.0), p(32.5, 34.0), p(1.0, 2.0)];
        let all = cut_indices(&ps);
        assert_eq!(all, (0..4).map(|i| cut_index(&ps, i)).collect::<Vec<_>>());
        assert_eq!(all, vec![0, 1, 1, 2]);
    }
}
