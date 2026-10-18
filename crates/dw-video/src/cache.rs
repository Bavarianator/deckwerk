//! Rechnungen hinter dem Video-Teil der Engine (`main/video-cache.ts`): Chunk-Planung des Transkripts, Sprecherzuordnung,
//! Chat je Sekunde, laute Bereiche. Ohne I/O. Zeiten in Sekunden.

use crate::cut::Turn;
use crate::{Segment, jmax, jmin};
use std::cmp::Ordering;

pub const CHUNK: f64 = 300.0;
const LEAD: f64 = 2.0;
const SEG_MAX: f64 = 30.0;

/// Erkennung, die lang verlangt (None = jede)
pub fn engine_for(
    lang: Option<&str>,
    parakeet_langs: &[&str],
    whisper_only: bool,
) -> Option<&'static str> {
    let lang = lang.filter(|l| !l.is_empty())?;
    let base = lang.to_lowercase();
    let base = base.split(['-', '_']).next().unwrap_or("");
    if !parakeet_langs.contains(&base) {
        Some("whisper")
    } else if whisper_only {
        None
    } else {
        Some("parakeet")
    }
}

/// Gelesener Tonbereich für Chunk k: 2 s Vorlauf, 30 s Überhang, an die Videolänge geklemmt → (from, dur)
pub fn chunk_window(k: f64, duration: f64) -> (f64, f64) {
    let from = jmax(0.0, k * CHUNK - LEAD);
    (from, jmin(k * CHUNK + CHUNK + SEG_MAX, duration) - from)
}

/// Stücke der Länge size, deren Inhalt in die Bereiche reichen kann, aufsteigend
pub fn chunks_in(ranges: &[[f64; 2]], duration: f64, size: f64, back: f64) -> Vec<f64> {
    let mut ks: Vec<f64> = Vec::new();
    for &[from, to] in ranges {
        let mut k = (jmax(0.0, from - back) / size).floor();
        while k * size < jmin(to, duration) {
            if !ks.contains(&k) {
                ks.push(k);
            }
            k += 1.0;
        }
    }
    ks.sort_by(f64::total_cmp);
    ks
}

/// Segmente, die in Chunk k beginnen
pub fn in_chunk(segs: &[Segment], k: f64) -> Vec<Segment> {
    segs.iter()
        .filter(|s| s.start >= k * CHUNK && s.start < (k + 1.0) * CHUNK)
        .cloned()
        .collect()
}

/// Segmente aller Chunks nach Start; ein Segment, das zu mehr als der Hälfte in einem übernommenen liegt, fällt weg
pub fn merge_segments(segs: &[Segment]) -> Vec<Segment> {
    let mut sorted = segs.to_vec();
    sorted.sort_by(|a, b| {
        (a.start - b.start)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut out: Vec<Segment> = Vec::new();
    for s in sorted {
        let mut dup = false;
        let mut j = out.len();
        while j > 0 && !dup && out[j - 1].start > s.start - SEG_MAX {
            j -= 1;
            dup = jmin(s.end, out[j].end) - jmax(s.start, out[j].start) > (s.end - s.start) / 2.0;
        }
        if !dup {
            out.push(s);
        }
    }
    out
}

/// Transkribierte Bereiche aus den vorhandenen Chunks, Nachbarn verbunden
pub fn covered_of(ks: &[f64], duration: f64) -> Vec<[f64; 2]> {
    let mut ks = ks.to_vec();
    ks.sort_by(f64::total_cmp);
    let mut out: Vec<[f64; 2]> = Vec::new();
    for k in ks {
        let (a, b) = (k * CHUNK, jmin((k + 1.0) * CHUNK, duration));
        match out.last_mut() {
            Some(l) if l[1] >= a => l[1] = jmax(l[1], b),
            _ => out.push([a, b]),
        }
    }
    out
}

/// speaker je Segment = Sprecher mit der größten zeitlichen Überlappung
pub fn with_speakers(segs: &[Segment], turns: &[Turn]) -> Vec<Segment> {
    segs.iter()
        .map(|s| {
            let mut talk: Vec<(f64, f64)> = Vec::new();
            for t in turns {
                let o = jmin(s.end, t.end) - jmax(s.start, t.start);
                if o > 0.0 {
                    match talk.iter_mut().find(|(k, _)| *k == t.speaker) {
                        Some(e) => e.1 += o,
                        None => talk.push((t.speaker, o)),
                    }
                }
            }
            // stabil absteigend nach Dauer: bei Gleichstand der zuerst gesehene
            let best = talk.iter().fold(None::<(f64, f64)>, |b, &x| match b {
                Some(b) if x.1.partial_cmp(&b.1) != Some(Ordering::Greater) => Some(b),
                _ => Some(x),
            });
            match best {
                Some((sp, _)) => Segment {
                    speaker: Some(sp),
                    ..s.clone()
                },
                None => s.clone(),
            }
        })
        .collect()
}

/// Chat-Aufzeichnung [{ t, w }] → Gewicht je Sekunde, n Sekunden lang; kaputte Einträge fallen weg
pub fn chat_per_second(chat: &[serde_json::Value], n: usize) -> Vec<f64> {
    let mut out = vec![0.0; n];
    for x in chat {
        let (Some(t), Some(w)) = (
            x.get("t").and_then(|v| v.as_f64()),
            x.get("w").and_then(|v| v.as_f64()),
        ) else {
            continue;
        };
        if w.is_finite() && t >= 0.0 && t < n as f64 {
            out[t.floor() as usize] += w;
        }
    }
    out
}

/// Bereiche für die Ereignis-Erkennung: Sekunden über Median + 6 dB, je ±5 s, verbunden
pub fn loud_ranges(loud: &[f64]) -> Vec<[f64; 2]> {
    let mut s = loud.to_vec();
    s.sort_by(|a, b| {
        (a - b)
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let med = s.get(s.len() >> 1).copied().unwrap_or(-100.0);
    let mut out: Vec<[f64; 2]> = Vec::new();
    for (i, &v) in loud.iter().enumerate() {
        if v.partial_cmp(&(med + 6.0)) != Some(Ordering::Greater) {
            continue;
        }
        let (a, b) = (
            jmax(0.0, i as f64 - 5.0),
            jmin(loud.len() as f64, i as f64 + 6.0),
        );
        match out.last_mut() {
            Some(l) if l[1] >= a => l[1] = b,
            _ => out.push([a, b]),
        }
    }
    out
}
