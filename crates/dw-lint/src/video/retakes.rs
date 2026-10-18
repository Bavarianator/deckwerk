//! Neuansätze und Versprecher im Transkript finden (retakes.ts): verworfene Anläufe, die beim Schnitt raus sollen.

use super::{Transcript, Word, bare, ends_sentence};
use crate::js::trim;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Retake {
    /// verworfener Anlauf (Quellsekunden)
    pub drop: [f64; 2],
    /// Start des neuen Anlaufs
    pub keep: f64,
    /// die wiederholten Wörter
    pub text: String,
}

const MAX_GAP: f64 = 15.0;
const MIN_MATCH: usize = 3;
const MIN_BROKEN: usize = 2;
const MAX_BROKEN: usize = 8;
const PAUSE: f64 = 0.6;
const DOUBLE: &[&str] = &["der", "die", "das", "den", "dem"];
const CONJ: &[&str] = &[
    "und", "oder", "aber", "sondern", "denn", "dann", "also", "and", "or", "but", "then", "so",
];
const FUNC: &[&str] = &[
    "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "ich",
    "du", "er", "sie", "es", "wir", "ihr", "man", "ist", "sind", "bin", "war", "hat", "habe",
    "haben", "wird", "in", "im", "an", "am", "auf", "mit", "zu", "von", "für", "ja", "nein", "so",
    "äh", "ähm", "the", "a", "i", "you", "we", "it", "is", "are", "was", "to", "of", "on", "for",
    "and", "uh", "um",
];

fn is_func(w: &str) -> bool {
    CONJ.contains(&w) || FUNC.contains(&w)
}

pub fn retakes(t: &Transcript) -> Vec<Retake> {
    let ws: Vec<&Word> = t
        .segments
        .iter()
        .flat_map(|s| s.words.iter().flatten())
        .collect();
    let n = ws.len();
    let b: Vec<String> = ws.iter().map(|w| bare(&w.w)).collect();
    let spk: Vec<Option<f64>> = t
        .segments
        .iter()
        .flat_map(|s| s.words.iter().flatten().map(|_| s.speaker))
        .collect();
    let ends: Vec<bool> = ws.iter().map(|w| ends_sentence(&w.w)).collect();
    // Präfixsumme der Satzenden: ws.slice(i, j).some(ends) in O(1)
    let mut pre = vec![0usize; n + 1];
    for k in 0..n {
        pre[k + 1] = pre[k] + ends[k] as usize;
    }
    let bs = |k: usize| b.get(k).map(String::as_str);
    let mut out: Vec<Retake> = Vec::new();
    let text = |from: usize, k: usize| {
        ws[from..from + k]
            .iter()
            .map(|w| trim(&w.w))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let mut i = 0;
    while i < n {
        // Stottern „ich ich ich“: nur die Doppelung raus; „die, die …“ mit Komma ist gewollt
        let last_punct = trim(&ws[i].w)
            .chars()
            .last()
            .is_some_and(|c| super::PUNCT.is_match(c.encode_utf8(&mut [0; 4])));
        if !b[i].is_empty()
            && bs(i + 1) == Some(&b[i])
            && spk.get(i + 1) == Some(&spk[i])
            && !last_punct
        {
            let mut j = i + 1;
            while bs(j + 1) == Some(&b[i]) {
                j += 1;
            }
            if j == i + 1 && DOUBLE.contains(&b[i].as_str()) {
                i += 1;
                continue;
            }
            out.push(Retake {
                drop: [ws[i].start, ws[j].start],
                keep: ws[j].start,
                text: trim(&ws[i].w).to_string(),
            });
            i = j;
            continue;
        }
        let start = i == 0
            || ends[i - 1]
            || out.last().is_some_and(|r| ws[i].start == r.keep)
            || ws[i].start - ws[i - 1].end >= PAUSE;
        let mut next = i + 1;
        let mut j = i + 1;
        while start && j < n && ws[j].start - ws[i].start <= MAX_GAP {
            let mut k = 0;
            while k < j - i && j + k < n && !b[i + k].is_empty() && b[i + k] == b[j + k] {
                k += 1;
            }
            if k == 0 || spk[i] != spk[j] || (0..k).all(|m| is_func(&b[i + m])) {
                j += 1;
                continue;
            }
            let len = j - i;
            let lastc = trim(&ws[j - 1].w).chars().last();
            let broken = pre[j] == pre[i] && !matches!(lastc, Some(',' | ';' | ':' | '–' | '-'));
            let ok = if broken {
                k >= MIN_BROKEN && len <= MAX_BROKEN && !CONJ.contains(&b[j - 1].as_str())
            } else {
                k >= MIN_MATCH && k == len
            };
            if !ok {
                j += 1;
                continue;
            }
            out.push(Retake {
                drop: [ws[i].start, ws[j].start],
                keep: ws[j].start,
                text: text(j, k),
            });
            next = j;
            break;
        }
        i = next;
    }
    out
}
