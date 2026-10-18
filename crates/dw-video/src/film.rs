//! Feature „Animation“ (`shared/film.ts`, Teile von `main/export-film.ts`): Sprechertext → Takte und Sätze, Zeitplan der Stimme,
//! Zeitachse einer Szene, Bildschirm-Zoom. Zeiten in Sekunden.

use crate::{Cue, Word, jmax, jmin, round};
use dw_lint::js::{is_ws, len16};
use serde::{Deserialize, Serialize};

pub const FPS: f64 = 30.0;
pub const VOICE_SPEED: (f64, f64) = (0.8, 1.3);
pub const PAUSE_SENTENCE: f64 = 0.25;
pub const PAUSE_BEAT: f64 = 0.45;
pub const GAP: f64 = 1.2;
pub const HOLD: f64 = 1.5;
pub const TAIL: f64 = 0.6;
pub const MIN_SCENE: f64 = 2.0;
const CHARS_PER_SEC: f64 = 14.0;
/// Überblendung an einer Naht im Film (joinSegs: 15 Frames)
pub const BLEND: f64 = 0.5;

/// `text.split(/\[klick\]/gi)`
fn split_beats(text: &str) -> Vec<&str> {
    let low = text.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut last = 0;
    let mut i = 0;
    while let Some(k) = low[i..].find("[klick]") {
        out.push(&text[last..i + k]);
        i += k + 7;
        last = i;
    }
    out.push(&text[last..]);
    out
}

fn strip_beats(s: &str) -> String {
    split_beats(s).concat()
}

// Satzgrenze: Leerzeichen nach [.!?…] (optional ["“»)]) und vor Großbuchstabe, Ziffer oder „"»(
fn sentences(s: &str) -> Vec<String> {
    let cs: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    for (i, &c) in cs.iter().enumerate() {
        if c == ' ' && i > 0 && i + 1 < cs.len() {
            let p = cs[i - 1];
            let end = |x: char| matches!(x, '.' | '!' | '?' | '…');
            let behind = end(p) || (matches!(p, '"' | '“' | '»' | ')') && i >= 2 && end(cs[i - 2]));
            let n = cs[i + 1];
            let ahead =
                n.is_uppercase() || n.is_ascii_digit() || matches!(n, '„' | '"' | '»' | '(');
            if behind && ahead {
                out.push(std::mem::take(&mut cur));
                continue;
            }
        }
        cur.push(c);
    }
    out.push(cur);
    out
}

const ABBRS: [&str; 15] = [
    "bzw", "ca", "vgl", "nr", "dr", "prof", "etc", "usw", "inkl", "ggf", "evtl", "vs", "mio",
    "mrd", "tsd",
];

// Kein Satzende: einzelner Buchstabe („z.“), Ordinalzahl („3.“) oder übliche Abkürzung
fn abbr(s: &str) -> bool {
    let Some(body) = s.strip_suffix('.') else {
        return false;
    };
    let cs: Vec<char> = body.chars().collect();
    let Some(&last) = cs.last() else { return false };
    let before = |k: usize| if k == 0 { None } else { Some(cs[k - 1]) };
    if last.is_alphabetic()
        && !before(cs.len() - 1).is_some_and(|b| b.is_alphabetic() || b.is_ascii_digit())
    {
        return true;
    }
    let digits = cs.iter().rev().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 && !before(cs.len() - digits).is_some_and(|b| matches!(b, '.' | ',')) {
        return true;
    }
    let low = body.to_lowercase();
    ABBRS.iter().any(|a| {
        low.ends_with(a) && {
            let lc: Vec<char> = low.chars().collect();
            let k = lc.len() - a.chars().count();
            !(k > 0 && (lc[k - 1].is_ascii_alphanumeric() || lc[k - 1] == '_'))
        }
    })
}

/// Sprechertext → Takte (getrennt an [klick]) → Sätze; leere Takte bleiben stehen
pub fn voice_chunks(text: &str) -> Vec<Vec<String>> {
    split_beats(text)
        .into_iter()
        .map(|beat| {
            let flat = dw_lint::js::words(beat).join(" ");
            let mut out: Vec<String> = Vec::new();
            for part in sentences(&flat) {
                if part.is_empty() {
                    continue;
                }
                match out.last_mut() {
                    Some(l) if abbr(l) => {
                        l.push(' ');
                        l.push_str(&part)
                    }
                    _ => out.push(part),
                }
            }
            out
        })
        .collect()
}

fn estimate_sec(sentence: &str, speed: f64) -> f64 {
    len16(dw_lint::js::trim(&strip_beats(sentence))) as f64 / (CHARS_PER_SEC * speed)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VoiceTiming {
    pub beats: Vec<f64>,
    pub total: f64,
    pub cues: Vec<Cue>,
}

// Eine Untertitelzeile je Satz, Wortzeiten anteilig nach Buchstaben
fn sentence_cue(sentence: &str, start: f64, end: f64) -> Cue {
    let ws: Vec<&str> = sentence.split(is_ws).filter(|w| !w.is_empty()).collect();
    let len = ws.iter().map(|w| len16(w) + 1).sum::<usize>();
    let len = if len == 0 { 1.0 } else { len as f64 };
    let mut t = start;
    let words = ws
        .iter()
        .map(|w| {
            let d = ((len16(w) as f64 + 1.0) / len) * (end - start);
            let x = Word {
                w: (*w).into(),
                start: t,
                end: t + d,
            };
            t += d;
            x
        })
        .collect();
    Cue { start, end, words }
}

/// Zeitplan der Stimme aus den Satzdauern (durs wie chunks: Takt × Satz; fehlend = geschätzt)
pub fn voice_timing(chunks: &[Vec<String>], durs: &[Vec<f64>]) -> VoiceTiming {
    let (mut beats, mut cues) = (Vec::new(), Vec::new());
    let (mut t, mut first) = (0.0, true);
    for (b, beat) in chunks.iter().enumerate() {
        if b > 0 && !beat.is_empty() && !first {
            t += PAUSE_BEAT - PAUSE_SENTENCE;
        }
        beats.push(t);
        for (k, s) in beat.iter().enumerate() {
            let d = jmax(
                0.1,
                durs.get(b)
                    .and_then(|x| x.get(k))
                    .copied()
                    .unwrap_or_else(|| estimate_sec(s, 1.0)),
            );
            cues.push(sentence_cue(s, t, t + d));
            t += d + PAUSE_SENTENCE;
            first = false;
        }
    }
    VoiceTiming {
        beats,
        total: jmax(0.0, t - if first { 0.0 } else { PAUSE_SENTENCE }),
        cues,
    }
}

/// Geschätzter Zeitplan, solange die Stimme nicht synthetisiert ist
pub fn estimate_voice(text: &str, speed: f64) -> VoiceTiming {
    let chunks = voice_chunks(text);
    let durs: Vec<Vec<f64>> = chunks
        .iter()
        .map(|b| b.iter().map(|s| estimate_sec(s, speed)).collect())
        .collect();
    voice_timing(&chunks, &durs)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneTimeline {
    pub beats: Vec<f64>,
    pub dur: f64,
    pub hold: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SceneIn {
    pub steps: Vec<f64>,
    #[serde(default)]
    pub voice: Option<VoiceTiming>,
    #[serde(default)]
    pub duration: Option<f64>,
    pub words: f64,
    pub lead: f64,
    #[serde(default)]
    pub endless: Option<bool>,
    #[serde(default)]
    pub media: Option<f64>,
}

/// Zeitachse einer Szene (Takte, Länge, ab wann das Bild steht)
pub fn scene_timeline(o: &SceneIn) -> SceneTimeline {
    let vb = o.voice.as_ref().map_or(0, |v| v.beats.len());
    let n = o.steps.len().max(vb).max(1);
    let step = |k: usize| o.steps.get(k).copied().unwrap_or(0.0);
    let mut beats: Vec<f64> = Vec::new();
    for k in 0..n {
        if k == 0 {
            beats.push(o.lead);
            continue;
        }
        let prev = beats[k - 1] + step(k - 1) + GAP;
        let spoken = o
            .voice
            .as_ref()
            .filter(|v| k < v.beats.len())
            .map(|v| o.lead + v.beats[k]);
        beats.push(jmax(beats[k - 1], spoken.unwrap_or(prev)));
    }
    let anim_end = beats
        .iter()
        .enumerate()
        .map(|(k, b)| b + step(k))
        .fold(o.lead, jmax);
    let voice_end = o.voice.as_ref().map_or(0.0, |v| o.lead + v.total + TAIL);
    let has_voice = o.voice.is_some();
    let auto = [
        anim_end + if has_voice { 0.3 } else { HOLD },
        voice_end,
        if has_voice {
            0.0
        } else {
            o.lead + 1.0 + o.words / 3.0
        },
        o.lead + o.media.unwrap_or(0.0),
        MIN_SCENE,
    ]
    .into_iter()
    .fold(f64::NEG_INFINITY, jmax);
    let dur = jmax(jmax(o.duration.unwrap_or(auto), voice_end), 0.5);
    SceneTimeline {
        beats,
        dur,
        hold: if o.endless == Some(true) {
            dur
        } else {
            jmin(dur, anim_end)
        },
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScenePlan {
    pub beats: Vec<f64>,
    pub dur: f64,
    pub hold: f64,
    pub lead: f64,
    pub times: Vec<f64>,
}

/// Zeitachse der Szene wie im Export: lead = Überblendung davor (blend), times = Frames bis zum letzten bewegten Bild
pub fn plan_scene(blend: bool, scene: &SceneIn) -> ScenePlan {
    let lead = if blend { BLEND } else { 0.0 };
    let tl = scene_timeline(&SceneIn {
        lead,
        ..scene.clone()
    });
    let n = jmin(
        jmax(1.0, round(tl.dur * FPS)),
        (tl.hold * FPS - 1e-6).ceil() + 1.0,
    );
    ScenePlan {
        lead,
        times: (0..n as usize).map(|k| k as f64 / FPS).collect(),
        beats: tl.beats,
        dur: tl.dur,
        hold: tl.hold,
    }
}

/// Untertitel im Film auf halbtransparentem Kasten (BorderStyle 4): Style Cap umbauen
pub fn boxed(ass: &str, pad: f64) -> String {
    let mut done = false;
    ass.split('\n')
        .map(|l| {
            if done || !l.starts_with("Style: Cap,") {
                return l.to_string();
            }
            done = true;
            let mut f: Vec<String> = l.split(',').map(String::from).collect();
            if f.len() < 18 {
                f.resize(18, String::new());
            }
            for (i, v) in [
                (5, "&HFF000000".to_string()),
                (6, "&H5C000000".into()),
                (15, "4".into()),
                (16, crate::num(pad)),
                (17, "0".into()),
            ] {
                f[i] = v;
            }
            f.join(",")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ScreenZoom {
    pub start: f64,
    pub end: f64,
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
}

pub const ZOOM_SCALE: (f64, f64, f64) = (1.2, 3.0, 2.0);
const ZOOM_EASE: f64 = 0.6;

pub fn smooth(p: f64) -> f64 {
    let x = jmin(1.0, jmax(0.0, p));
    x * x * (3.0 - 2.0 * x)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct View {
    pub s: f64,
    pub x: f64,
    pub y: f64,
}

/// Ausschnitt zum Zeitpunkt t: s = Vergrößerung, x/y = Mitte des sichtbaren Ausschnitts (an den Bildrand geklemmt)
pub fn zoom_at(zooms: &[ScreenZoom], t: f64) -> View {
    let mut zs = zooms.to_vec();
    zs.sort_by(|a, b| {
        (a.start - b.start)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let scale = |z: &ScreenZoom| {
        jmin(
            ZOOM_SCALE.1,
            jmax(ZOOM_SCALE.0, z.scale.unwrap_or(ZOOM_SCALE.2)),
        )
    };
    let view = |x: f64, y: f64, s: f64| {
        let at = |q: f64| {
            let c = q + (0.5 - q) / s;
            let h = 0.5 / s;
            jmin(1.0 - h, jmax(h, c))
        };
        View {
            s,
            x: at(x),
            y: at(y),
        }
    };
    if let Some(on) = zs.iter().rev().find(|z| t >= z.start && t <= z.end) {
        return view(on.x, on.y, scale(on));
    }
    let mut ended: Vec<&ScreenZoom> = zs.iter().filter(|z| z.end < t).collect();
    ended.sort_by(|a, b| {
        (a.end - b.end)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let prev = ended.last().copied();
    let next = zs.iter().find(|z| z.start > t);
    if let (Some(p), Some(n)) = (prev, next)
        && n.start - p.end < 2.0 * ZOOM_EASE
    {
        let k = smooth((t - p.end) / (n.start - p.end));
        let mix = |a: f64, b: f64| a + (b - a) * k;
        return view(mix(p.x, n.x), mix(p.y, n.y), mix(scale(p), scale(n)));
    }
    let p_in = next.map_or(0.0, |n| smooth(1.0 - (n.start - t) / ZOOM_EASE));
    let p_out = prev.map_or(0.0, |p| smooth(1.0 - (t - p.end) / ZOOM_EASE));
    let z = if p_in >= p_out { next } else { prev };
    let p = jmax(p_in, p_out);
    match z {
        Some(z) if p > 0.0 => view(z.x, z.y, 1.0 + (scale(z) - 1.0) * p),
        _ => View {
            s: 1.0,
            x: 0.5,
            y: 0.5,
        },
    }
}
