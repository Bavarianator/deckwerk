//! Stellen im Transkript finden (Zitat, Thema) und lange Videos grob überblicken (transcript-search.ts).

use super::{Transcript, Word, estimate_words, jmax, median as median_nan, mmss};
use crate::js::{is_ws, len16, num, round, trim, words};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Hit {
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub score: f64,
    pub seg: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OverviewSignals {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loud: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heat: Option<Vec<f64>>,
}

const QUOTE: f64 = 100.0;
const STOP: &str = "der die das den dem des ein eine einen einem einer und oder aber nicht ist sind war es er sie wir ihr ich du zu im in an auf mit von für auch dass wie so noch nur ja nein \
the a an and or but not is are was it he she we you i to of in on at for with that this as so be";
static STOPS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| STOP.split(' ').collect());
static NOT_LN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}]").unwrap());
static NOT_LNM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N}\p{M}]+").unwrap());

// klein, Umlaute/ß gefaltet, alles außer Buchstaben und Ziffern weg
// Wortschatz ist klein, die Faltung teuer: je Rohwort einmal (wie memo in TS)
thread_local! {
    static NORM: std::cell::RefCell<HashMap<String, String>> = std::cell::RefCell::new(HashMap::new());
}

fn norm(s: &str) -> String {
    NORM.with_borrow_mut(|c| {
        if let Some(r) = c.get(s) {
            return r.clone();
        }
        if c.len() > 50000 {
            c.clear();
        }
        let r = norm_raw(s);
        c.insert(s.to_string(), r.clone());
        r
    })
}

fn norm_raw(s: &str) -> String {
    let folded: String = s
        .to_lowercase()
        .replace('ß', "ss")
        .nfd()
        .filter(|&c| !is_combining_mark(c))
        .collect();
    NOT_LN.replace_all(&folded, "").into_owned()
}

// Mini-Stemmer wie /(en|er|es|e|n|s)$/: zwei Zeichen vor einem
fn stem(k: String) -> String {
    if len16(&k) <= 5 {
        return k;
    }
    for suf in ["en", "er", "es", "e", "n", "s"] {
        if let Some(r) = k.strip_suffix(suf) {
            return r.to_string();
        }
    }
    k
}

fn term(w: &str) -> String {
    let k = norm(w);
    if STOPS.contains(k.as_str()) {
        String::new()
    } else {
        stem(k)
    }
}

fn terms(s: &str) -> Vec<String> {
    NOT_LNM
        .split(s)
        .map(term)
        .filter(|t| !t.is_empty())
        .collect()
}

fn need_of(m: usize) -> usize {
    (m.saturating_sub(2)).max((m as f64 * 0.7).ceil() as usize)
}

/// Zitat: q als Wortfolge; exakt (100) oder mit 1–2 anderen Wörtern (Ordnung egal, 50–90).
fn quote(t: &Transcript, q: &[String], n: usize) -> Vec<Hit> {
    let m = q.len();
    if m == 0 {
        return vec![];
    }
    let need = need_of(m);
    // billiger Vorfilter: ohne genug Zitatwörter lohnt das Schätzen der Wortzeiten nicht
    let mut have: HashSet<String> = HashSet::new();
    for s in &t.segments {
        match &s.words {
            Some(ws) if !ws.is_empty() => have.extend(ws.iter().map(|w| norm(&w.w))),
            _ => have.extend(s.text.split(is_ws).map(norm)),
        }
    }
    if q.iter().filter(|k| have.contains(k.as_str())).count() < need {
        return vec![];
    }
    let mut tok: Vec<String> = Vec::new();
    let mut ws: Vec<(Word, usize)> = Vec::new();
    for (seg, s) in t.segments.iter().enumerate() {
        let list = match &s.words {
            Some(w) if !w.is_empty() => w.clone(),
            _ => estimate_words(s, &[]),
        };
        for w in list {
            let k = norm(&w.w);
            if !k.is_empty() {
                tok.push(k);
                ws.push((w, seg));
            }
        }
    }
    let mut qc: HashMap<&str, usize> = HashMap::new();
    for k in q {
        *qc.entry(k.as_str()).or_insert(0) += 1;
    }
    struct Cand {
        i: usize,
        j: usize,
        score: f64,
    }
    let mut cand: Vec<Cand> = Vec::new();
    for i in 0..tok.len() {
        if !qc.contains_key(tok[i].as_str()) {
            continue;
        }
        if i + m <= tok.len() && q.iter().enumerate().all(|(d, k)| &tok[i + d] == k) {
            cand.push(Cand {
                i,
                j: i + m - 1,
                score: QUOTE,
            });
            continue;
        }
        if m < 4 {
            continue;
        }
        let mut best: Option<Cand> = None;
        for l in need.max(m - 2)..=m + 2 {
            let j = i + l - 1;
            if j >= tok.len() || !qc.contains_key(tok[j].as_str()) {
                continue;
            }
            let mut left = qc.clone();
            let mut hit = 0usize;
            for tk in &tok[i..=j] {
                if let Some(c) = left.get_mut(tk.as_str())
                    && *c > 0
                {
                    *c -= 1;
                    hit += 1;
                }
            }
            let score = 50.0 + (40.0 * hit as f64) / m.max(l) as f64;
            if hit >= need && best.as_ref().is_none_or(|b| score > b.score) {
                best = Some(Cand { i, j, score });
            }
        }
        if let Some(b) = best {
            cand.push(b);
        }
    }
    cand.sort_by(|a, b| super::by_diff(b.score - a.score).then(a.i.cmp(&b.i)));
    let mut out: Vec<&Cand> = Vec::new();
    for c in &cand {
        if out.len() >= n {
            break;
        }
        if !out.iter().any(|o| c.i <= o.j && o.i <= c.j) {
            out.push(c);
        }
    }
    out.iter()
        .map(|c| Hit {
            start: ws[c.i].0.start,
            end: ws[c.j].0.end,
            text: ws[c.i..=c.j]
                .iter()
                .map(|x| trim(&x.0.w))
                .collect::<Vec<_>>()
                .join(" "),
            score: c.score,
            seg: ws[c.i].1,
        })
        .collect()
}

/// Thema: BM25 über Segmente, Nachbarn ±1 gehen mit 0,3 in den Score ein und in den Treffer als Kontext.
fn bm25(t: &Transcript, query: &str, n: usize) -> Vec<Hit> {
    let segs = &t.segments;
    let mut q = terms(query);
    if q.is_empty() {
        return vec![];
    }
    let mut seen = HashSet::new();
    q.retain(|k| seen.insert(k.clone()));
    let docs: Vec<Vec<String>> = segs
        .iter()
        .map(|s| {
            let tt = trim(&s.text);
            if tt.is_empty() {
                terms(
                    &s.words
                        .iter()
                        .flatten()
                        .map(|w| w.w.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            } else {
                terms(tt)
            }
        })
        .collect();
    let nd = docs.len();
    let sum = docs.iter().fold(0.0, |a, d| a + d.len() as f64);
    let avg = sum / (if nd == 0 { 1.0 } else { nd as f64 });
    let avg = if avg == 0.0 || avg.is_nan() { 1.0 } else { avg };
    let tf: Vec<HashMap<&str, f64>> = docs
        .iter()
        .map(|d| {
            let mut m = HashMap::new();
            for k in d {
                *m.entry(k.as_str()).or_insert(0.0) += 1.0;
            }
            m
        })
        .collect();
    let mut raw = vec![0.0f64; nd];
    for k in &q {
        let df = tf.iter().filter(|m| m.contains_key(k.as_str())).count() as f64;
        if df == 0.0 {
            continue;
        }
        let idf = (1.0 + (nd as f64 - df + 0.5) / (df + 0.5)).ln();
        for (i, m) in tf.iter().enumerate() {
            if let Some(&f) = m.get(k.as_str()) {
                raw[i] += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].len() as f64 / avg));
            }
        }
    }
    let sc: Vec<f64> = (0..nd)
        .map(|i| {
            raw[i]
                + 0.3
                    * ((if i > 0 { raw[i - 1] } else { 0.0 })
                        + raw.get(i + 1).copied().unwrap_or(0.0))
        })
        .collect();
    let mut order: Vec<usize> = (0..nd).filter(|&i| raw[i] > 0.0).collect();
    order.sort_by(|&a, &b| super::by_diff(sc[b] - sc[a]));
    let mut out: Vec<Hit> = Vec::new();
    for i in order {
        if out.len() >= n {
            break;
        }
        if out.iter().any(|h| h.seg.abs_diff(i) <= 2) {
            continue;
        }
        let a = i.saturating_sub(1);
        let b = (nd - 1).min(i + 1);
        out.push(Hit {
            start: segs[a].start,
            end: segs[b].end,
            text: segs[a..=b]
                .iter()
                .map(|s| trim(&s.text))
                .collect::<Vec<_>>()
                .join(" "),
            score: sc[i],
            seg: i,
        });
    }
    out
}

/// Zitat zuerst (Wortzeiten), sonst Thema per BM25.
pub fn search_transcript(t: &Transcript, query: &str, n: usize) -> Vec<Hit> {
    let q: Vec<String> = query
        .split(is_ws)
        .map(norm)
        .filter(|k| !k.is_empty())
        .collect();
    if q.is_empty() {
        return vec![];
    }
    let hits = quote(t, &q, n);
    if hits.is_empty() {
        bm25(t, query, n)
    } else {
        hits
    }
}

// Median, leer = 0
fn median(v: &[f64]) -> f64 {
    if v.is_empty() { 0.0 } else { median_nan(v) }
}

// Lage und Streuung für z gegen Median/MAD aller Fenster; einmal je Liste statt je Fenster (gleiches Ergebnis)
fn spread(all: &[f64], min_scale: f64) -> (f64, f64) {
    let m = median(all);
    (
        m,
        jmax(
            1.4826 * median(&all.iter().map(|v| (v - m).abs()).collect::<Vec<_>>()),
            min_scale,
        ),
    )
}

/// `x.slice(a, b)` mit Zahl-Indizes (abgeschnitten, an den Rändern begrenzt)
fn js_slice(x: &[f64], a: f64, b: f64) -> &[f64] {
    let idx = |v: f64| {
        if v.is_nan() {
            0
        } else {
            (v.trunc().max(0.0) as usize).min(x.len())
        }
    };
    let (a, b) = (idx(a), idx(b));
    if b > a { &x[a..b] } else { &[] }
}

/// Eine Zeile je Fenster (win s): Zeit, auffällige Signale, Anfang des Gesagten.
pub fn overview(
    t: Option<&Transcript>,
    s: Option<&OverviewSignals>,
    duration: f64,
    win: f64,
) -> Vec<String> {
    let win = if win >= 10.0 { win } else { 90.0 };
    let nf = jmax(0.0, (duration / win).ceil());
    let n = if nf.is_nan() { 0 } else { nf as usize };
    fn window(x: Option<&Vec<f64>>, k: usize, win: f64, duration: f64) -> &[f64] {
        x.map_or(&[][..], |x| {
            js_slice(
                x,
                k as f64 * win,
                super::jmin(duration, (k + 1) as f64 * win),
            )
        })
    }
    let slice = |x, k| window(x, k, win, duration);
    let mean = |v: &[f64]| {
        v.iter().fold(0.0, |a, b| a + b) / (if v.is_empty() { 1.0 } else { v.len() as f64 })
    };
    let (s_loud, s_chat, s_ev, s_heat) = (
        s.and_then(|s| s.loud.as_ref()),
        s.and_then(|s| s.chat.as_ref()),
        s.and_then(|s| s.events.as_ref()),
        s.and_then(|s| s.heat.as_ref()),
    );
    let loud: Vec<f64> = (0..n)
        .map(|k| {
            let v: Vec<f64> = slice(s_loud, k)
                .iter()
                .copied()
                .filter(|&d| d > -100.0)
                .collect();
            if v.is_empty() { f64::NAN } else { mean(&v) }
        })
        .collect();
    let chat: Vec<f64> = (0..n)
        .map(|k| slice(s_chat, k).iter().fold(0.0, |a, b| a + b))
        .collect();
    let loud_all: Vec<f64> = loud.iter().copied().filter(|v| !v.is_nan()).collect();
    let chat_med = median(&chat);
    let (loud_m, loud_s) = spread(&loud_all, 1.0);
    let (chat_m, chat_s) = spread(&chat, 2.0);
    let mut wds: Vec<Vec<&str>> = vec![Vec::new(); n];
    for sg in t.map_or(&[][..], |t| &t.segments[..]) {
        let k = (sg.start / win).floor();
        if k >= 0.0 && k < n as f64 && wds[k as usize].len() < 13 {
            wds[k as usize].extend(words(&sg.text));
        }
    }
    (0..n)
        .map(|k| {
            let a = k as f64 * win;
            let b = super::jmin(duration, a + win);
            let mut parts = vec![format!("{}–{}", mmss(a), mmss(b))];
            if loud_all.len() > 2
                && !loud[k].is_nan()
                && (loud[k] - loud_m) / loud_s >= 2.0
                && loud[k] - loud_m >= 3.0
            {
                parts.push(format!("laut +{} dB", num(round(loud[k] - loud_m))));
            }
            if s_chat.is_some()
                && chat[k] > 0.0
                && (chat[k] - chat_m) / chat_s >= 2.0
                && chat[k] >= 2.0 * jmax(chat_med, 1.0)
            {
                parts.push(format!(
                    "Chat ×{}",
                    num(round(chat[k] / jmax(chat_med, 1.0)))
                ));
            }
            if slice(s_ev, k).iter().fold(0.0, |m, &v| jmax(m, v)) >= 0.6 {
                parts.push("Lachen/Jubel".into());
            }
            if s_heat.is_some() && mean(slice(s_heat, k)) >= 0.7 {
                parts.push("oft gesehen".into());
            }
            let w = &wds[k];
            if !w.is_empty() {
                let joined = w[..w.len().min(12)].join(" ");
                // .slice(0, 100) zählt UTF-16-Einheiten; ein halbes Ersatzpaar am Schnitt fällt hier weg
                let mut u = 0;
                let cut: String = joined
                    .chars()
                    .take_while(|c| {
                        u += c.len_utf16();
                        u <= 100
                    })
                    .collect();
                parts.push(format!("„{cut}{}“", if w.len() > 12 { " …" } else { "" }));
            } else {
                let none = match t {
                    None => true,
                    Some(t) => t
                        .covered
                        .as_ref()
                        .is_some_and(|c| !c.iter().any(|&[x, y]| x < b && y > a)),
                };
                parts.push(
                    if none {
                        "(noch kein Transkript)"
                    } else {
                        "(keine Sprache)"
                    }
                    .into(),
                );
            }
            parts.join(" · ")
        })
        .collect()
}
