//! Highlights in langen Videos und Streams aus Signalen je Sekunde (highlights.ts): robuster z-Wert je Signal gegen
//! Block-Mediane, gewichtete Summe, Spitzen → Fenster → Top-n ohne Überlappung.

use super::{jmax, jmin, median};
use crate::js::{num, round, to_fixed};
use serde::{Deserialize, Serialize};

/// Je Sekunde: RMS dBFS, Chat-Gewicht, Ereignis-Wahrscheinlichkeit, YouTube-Heatmap, Musik-Wahrscheinlichkeit (nur Clip-Lint)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Signals {
    pub loud: Vec<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heat: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub music: Option<Vec<f64>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Highlight {
    pub start: f64,
    pub end: f64,
    pub score: f64,
    pub why: String,
}

/// len: Fenster (s, Standard 90), n: Anzahl (8), gap: Mindestabstand (s, 30)
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct HighlightOpts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub len: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap: Option<f64>,
}

const BLOCK: usize = 60;
const BLOCKS: i64 = 10;
const LOUD_SMOOTH: i64 = 1;
const CHAT_DELAY: i64 = 15;
const CHAT_SUM: i64 = 10;
const MIN_LOUD: f64 = 1.0;
const MIN_CHAT: f64 = 2.0;
const Z_MAX: f64 = 8.0;
const W_CHAT: f64 = 1.0;
const W_LOUD: f64 = 0.6;
const W_EVENTS: f64 = 2.0;
const W_HEAT: f64 = 1.5;
const MIN_SCORE: f64 = 1.5;
const MERGE: usize = 12;

// Summe (bzw. Mittel) von x[i+a … i+b] je i, an den Rändern gekürzt
fn win(x: &[f64], a: i64, b: i64, mean: bool) -> Vec<f64> {
    let n = x.len() as i64;
    let mut pre = Vec::with_capacity(x.len() + 1);
    pre.push(0.0);
    for v in x {
        pre.push(pre[pre.len() - 1] + v);
    }
    (0..n)
        .map(|i| {
            let lo = (i + a).clamp(0, n) as usize;
            let hi = (i + b + 1).clamp(0, n) as usize;
            if mean {
                if hi > lo {
                    (pre[hi] - pre[lo]) / (hi - lo) as f64
                } else {
                    0.0
                }
            } else {
                pre[hi] - pre[lo]
            }
        })
        .collect()
}

struct Z {
    z: Vec<f64>,
    med: Vec<f64>,
}

fn robust_z(x: &[f64], min_scale: f64) -> Z {
    let nb = x.len().div_ceil(BLOCK);
    let (mut meds, mut mads) = (Vec::with_capacity(nb), Vec::with_capacity(nb));
    for b in 0..nb {
        let v = &x[b * BLOCK..((b + 1) * BLOCK).min(x.len())];
        let m = median(v);
        meds.push(m);
        mads.push(median(&v.iter().map(|y| (y - m).abs()).collect::<Vec<_>>()));
    }
    let (mut z, mut med) = (Vec::with_capacity(x.len()), Vec::with_capacity(x.len()));
    let nbi = nb as i64;
    for b in 0..nb {
        let lo = 0.max((b as i64 - BLOCKS / 2).min(nbi - BLOCKS)) as usize;
        let hi = nb.min(lo + BLOCKS as usize);
        let m = median(&meds[lo..hi]);
        let scale = jmax(min_scale, 1.4826 * median(&mads[lo..hi]));
        for xi in &x[b * BLOCK..((b + 1) * BLOCK).min(x.len())] {
            z.push((xi - m) / scale);
            med.push(m);
        }
    }
    Z { z, med }
}

fn de1(n: f64) -> String {
    to_fixed(n, 1).replacen('.', ",", 1)
}

/// Die n stärksten Momente: Fenster von len s um die Spitze (60 % davor, 40 % danach), mindestens gap s auseinander, zeitlich sortiert.
pub fn highlights(s: &Signals, o: HighlightOpts) -> Vec<Highlight> {
    let len = o.len.unwrap_or(90.0);
    let n = o.n.unwrap_or(8.0);
    let gap = o.gap.unwrap_or(30.0);
    let dur = s.loud.len();
    let fill = |x: &[f64]| {
        (0..dur)
            .map(|i| x.get(i).copied().filter(|v| v.is_finite()).unwrap_or(0.0))
            .collect::<Vec<_>>()
    };
    let clamp = |z: f64| jmin(Z_MAX, jmax(0.0, z));
    let loud_in: Vec<f64> = s
        .loud
        .iter()
        .map(|&v| {
            if v.is_finite() {
                jmax(-100.0, v)
            } else {
                -100.0
            }
        })
        .collect();
    let loud = win(&loud_in, -LOUD_SMOOTH, LOUD_SMOOTH, true);
    let l = robust_z(&loud, MIN_LOUD);
    let chat = s.chat.as_ref().map(|c| {
        win(
            &fill(c),
            CHAT_DELAY - CHAT_SUM / 2,
            CHAT_DELAY + CHAT_SUM / 2 - 1,
            false,
        )
    });
    let cz = chat.as_ref().map(|c| robust_z(c, MIN_CHAT));
    let ev = s.events.as_ref().map(|x| fill(x));
    let heat = s.heat.as_ref().map(|x| fill(x));
    let score: Vec<f64> = (0..dur)
        .map(|i| {
            W_LOUD * clamp(l.z[i])
                + cz.as_ref().map_or(0.0, |c| W_CHAT * clamp(c.z[i]))
                + ev.as_ref().map_or(0.0, |e| W_EVENTS * e[i])
                + heat.as_ref().map_or(0.0, |h| W_HEAT * h[i])
        })
        .collect();

    // Spitzen: lokale Maxima über MIN_SCORE; näher als MERGE zu einer zusammenlegen, die höchste bleibt
    let mut peaks: Vec<usize> = Vec::new();
    let mut prev: Option<usize> = None;
    for i in 0..dur {
        let before = if i > 0 {
            score[i - 1]
        } else {
            f64::NEG_INFINITY
        };
        let after = score.get(i + 1).copied().unwrap_or(f64::NEG_INFINITY);
        if score[i] < MIN_SCORE || score[i] < before || score[i] < after {
            continue;
        }
        match (prev, peaks.last_mut()) {
            (Some(p), Some(last)) if i - p < MERGE => {
                if score[i] > score[*last] {
                    *last = i;
                }
            }
            _ => peaks.push(i),
        }
        prev = Some(i);
    }
    peaks.sort_by(|&a, &b| super::by_diff(score[b] - score[a]));

    let mut out: Vec<(Highlight, usize)> = Vec::new();
    for p in peaks {
        if out.len() as f64 >= n {
            break;
        }
        let start = jmax(0.0, jmin(dur as f64 - len, p as f64 - 0.6 * len));
        let end = jmin(dur as f64, start + len);
        if out
            .iter()
            .any(|(h, _)| start < h.end + gap && end > h.start - gap)
        {
            continue;
        }
        let mut why: Vec<String> = Vec::new();
        if let (Some(c), Some(chat)) = (&cz, &chat)
            && c.z[p] >= 1.0
        {
            why.push(if c.med[p] >= 1.0 {
                format!("Chat ×{}", de1(chat[p] / c.med[p]))
            } else {
                format!("Chat {} in 10 s", num(round(chat[p])))
            });
        }
        if ev.as_ref().is_some_and(|e| e[p] >= 0.5) {
            why.push("Lachen/Jubel".into());
        }
        if loud[p] - l.med[p] >= 3.0 {
            why.push(format!("laut +{} dB", num(round(loud[p] - l.med[p]))));
        }
        if heat.as_ref().is_some_and(|h| h[p] >= 0.5) {
            why.push("oft gesehen".into());
        }
        let why = if why.is_empty() {
            "mehrere Signale leicht erhöht".into()
        } else {
            why.join(" · ")
        };
        let score = to_fixed(score[p], 2).parse::<f64>().unwrap_or(f64::NAN);
        out.push((
            Highlight {
                start,
                end,
                score,
                why,
            },
            p,
        ));
    }
    out.sort_by(|a, b| super::by_diff(a.0.start - b.0.start));
    out.into_iter().map(|(h, _)| h).collect()
}
