//! Clip-Lint (Layout clip, clip-lint.ts): prüft Länge, Schnitte, Transkript, Überschneidungen und Musik, damit sich die KI
//! beim Schneiden selbst korrigiert. Befund-Texte wortgleich wie in TS.

use super::{
    ClipContent, Overlay, Part, Transcript, Word, bare, by_diff, clip_spans, ends_sentence,
    estimate_words, jmax, jmin, mmss, part_len, parts_length, retakes, speed_of, truthy,
};
use crate::js::{de, len16, num, trim, words as split_words};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warn,
    Info,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClipIssue {
    pub severity: Severity,
    pub rule: String,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Size {
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SlideRef {
    pub layout: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
}

/// music: je Quellsekunde 0..1; deck_music: ob das Deck Hintergrundmusik hat (None = unbekannt); slides: alle Folien (None = Verweise nicht prüfen)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<Transcript>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub music: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deck_music: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slides: Option<Vec<SlideRef>>,
}

/// Andere clip-Folie des Decks
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OtherClip {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video: Option<String>,
    #[serde(default)]
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Moved {
    pub i: usize,
    /// "start" oder "end"
    pub edge: String,
    pub from: f64,
    pub to: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapped {
    pub parts: Vec<Part>,
    pub moved: Vec<Moved>,
}

const TOL: f64 = 0.05;
pub const SNAP: f64 = 0.4;
const CALM: f64 = 8.0;
const BROLL: f64 = 8.0;
const HOOK_S: f64 = 3.0;
const MARK: f64 = 6.0;
const OUTRO: f64 = 8.0;
pub const MUSIC: f64 = 0.15;
const CONJ: &[&str] = &[
    "und",
    "aber",
    "also",
    "dann",
    "deshalb",
    "weil",
    "außerdem",
    "denn",
    "oder",
    "sondern",
    "and",
    "but",
    "because",
    "then",
];
const PRON: &[&str] = &[
    "die", "der", "das", "es", "er", "sie", "dies", "this", "that", "it", "he", "she", "they",
];

fn real_words(t: &Transcript) -> Vec<Word> {
    t.segments
        .iter()
        .flat_map(|s| s.words.iter().flatten().cloned())
        .collect()
}

fn valid(p: &Part) -> bool {
    p.start.is_finite() && p.end.is_finite() && p.start >= 0.0 && p.end > p.start
}

/// Wortliste mit schnellen Abfragen; ist sie nach Zeit sortiert, per Binärsuche, sonst linear (gleiches Ergebnis wie find/filter).
struct Words {
    ws: Vec<Word>,
    mids: Vec<f64>,
    // start und end aufsteigend: inWord per Binärsuche
    edges_sorted: bool,
    // Wortmitten aufsteigend: Wörter eines parts sind ein zusammenhängender Bereich
    mids_sorted: bool,
}

impl Words {
    fn new(ws: Vec<Word>) -> Self {
        let mids: Vec<f64> = ws.iter().map(|w| (w.start + w.end) / 2.0).collect();
        let edges_sorted = ws
            .windows(2)
            .all(|p| p[0].start <= p[1].start && p[0].end <= p[1].end);
        let mids_sorted = mids.iter().all(|m| !m.is_nan()) && mids.windows(2).all(|p| p[0] <= p[1]);
        Words {
            ws,
            mids,
            edges_sorted,
            mids_sorted,
        }
    }

    /// erstes Wort mit start + tol < x < end − tol
    fn in_word(&self, x: f64) -> Option<&Word> {
        if self.edges_sorted {
            // start + tol < x gilt für einen Anfang, x < end − tol für ein Ende der Liste
            let k = self.ws.partition_point(|w| w.start + TOL < x);
            #[allow(clippy::neg_cmp_op_on_partial_ord)] // NaN wie in JS
            let j = self.ws.partition_point(|w| !(x < w.end - TOL));
            return (j < k).then(|| &self.ws[j]);
        }
        self.ws
            .iter()
            .find(|w| w.start + TOL < x && x < w.end - TOL)
    }

    /// Indizes der Wörter mit Mitte in [a, b)
    fn within(&self, a: f64, b: f64) -> Vec<usize> {
        if self.mids_sorted {
            let lo = self.mids.partition_point(|&m| m < a);
            let hi = self.mids.partition_point(|&m| m < b).max(lo);
            return (lo..hi).collect();
        }
        (0..self.ws.len())
            .filter(|&k| self.mids[k] >= a && self.mids[k] < b)
            .collect()
    }
}

/// Kanten, die in einem Wort liegen, auf die Wortgrenze legen, höchstens max s weit. Nur echte Wortzeiten.
/// Nahtlose Schnitte (part beginnt, wo der vorige endet) bleiben.
pub fn snap_to_words(parts: &[Part], t: &Transcript, max: f64) -> Snapped {
    snap_with(parts, &Words::new(real_words(t)), max)
}

fn snap_with(parts: &[Part], ws: &Words, max: f64) -> Snapped {
    let mut moved = Vec::new();
    let joined =
        |j: usize| j > 0 && j < parts.len() && (parts[j - 1].end - parts[j].start).abs() < 1e-3;
    let out = parts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut q = p.clone();
            for start in [true, false] {
                if joined(if start { i } else { i + 1 }) {
                    continue;
                }
                let x = if start { p.start } else { p.end };
                let Some(w) = ws.in_word(x) else { continue };
                let to = if start { w.start } else { w.end };
                if (to - x).abs() > max {
                    continue;
                }
                moved.push(Moved {
                    i,
                    edge: if start { "start" } else { "end" }.into(),
                    from: x,
                    to,
                });
                if start { q.start = to } else { q.end = to }
            }
            q
        })
        .collect();
    Snapped { parts: out, moved }
}

// Teile von a–b, die nicht in t.covered liegen (covered fehlt = ganzes Video, kein Transkript = alles)
fn gaps(t: Option<&Transcript>, a: f64, b: f64) -> Vec<[f64; 2]> {
    let Some(t) = t else { return vec![[a, b]] };
    let Some(cov) = &t.covered else { return vec![] };
    let mut out = Vec::new();
    let mut x = a;
    for &[s, e] in cov {
        if e <= x || s >= b {
            continue;
        }
        if s > x + TOL {
            out.push([x, s]);
        }
        x = jmax(x, e);
    }
    if x < b - TOL {
        out.push([x, b]);
    }
    out
}

struct Hit {
    msg: String,
    ex: String,
}

fn hit(msg: String, ex: String) -> Hit {
    Hit { msg, ex }
}

fn sum_spans(sp: &[[f64; 2]]) -> f64 {
    sp.iter().fold(0.0, |s, [a, b]| s + b - a)
}

/// Prüft eine clip-Folie. others: clip-Folien des Decks in Reihenfolge („Clip n“ = others[n-1]), self_idx: Index der geprüften darin.
#[allow(clippy::manual_range_contains)] // NaN-Länge meldet in JS nichts, !contains schon
pub fn lint_clip(
    c: &ClipContent,
    size: Size,
    info: &ClipInfo,
    others: &[OtherClip],
    self_idx: Option<usize>,
) -> Vec<ClipIssue> {
    use Severity::*;
    let mut out: Vec<ClipIssue> = Vec::new();
    let add = |out: &mut Vec<ClipIssue>, severity: Severity, rule: &str, message: String| {
        out.push(ClipIssue {
            severity,
            rule: rule.into(),
            message,
        })
    };
    // Je Regel eine Meldung: ein Treffer ausführlich, mehrere gebündelt mit höchstens 3 Beispielen
    let bundle = |out: &mut Vec<ClipIssue>,
                  rule: &str,
                  hits: Vec<Hit>,
                  head: &str,
                  tail: &str,
                  severity: Severity| {
        if hits.len() == 1 {
            add(out, severity, rule, hits.into_iter().next().unwrap().msg);
        } else if !hits.is_empty() {
            let ex = hits
                .iter()
                .take(3)
                .map(|h| h.ex.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            add(
                out,
                severity,
                rule,
                format!(
                    "{} {head}: {ex}{} – {tail}",
                    hits.len(),
                    if hits.len() > 3 { " …" } else { "" }
                ),
            );
        }
    };
    let n = |i: usize| format!("Ausschnitt {}", i + 1);
    let t = info.transcript.as_ref();
    let dur = [info.duration, t.map(|t| t.duration)]
        .into_iter()
        .flatten()
        .find(|&d| truthy(Some(d)))
        .unwrap_or(0.0);
    let short = size.w <= size.h;
    let all = &c.parts;
    let use_: Vec<(&Part, usize)> = all
        .iter()
        .enumerate()
        .filter(|(_, p)| valid(p))
        .map(|(i, p)| (p, i))
        .collect();
    let up: Vec<Part> = use_.iter().map(|(p, _)| (*p).clone()).collect();
    let bad: Vec<String> = all
        .iter()
        .enumerate()
        .filter(|(_, p)| !valid(p))
        .map(|(i, _)| (i + 1).to_string())
        .collect();

    if c.video.as_deref().is_none_or(|v| trim(v).is_empty()) {
        add(
            &mut out,
            Error,
            "clip-video",
            "Kein Video gesetzt – Pfad aus dem Anhang in video eintragen".into(),
        );
    }
    if !bad.is_empty() {
        add(
            &mut out,
            Warn,
            "clip-zeit",
            format!(
                "{} {} ohne gültige Zeiten (start ≥ 0, end nach start) – Zeiten aus dem Transkript nehmen",
                if bad.len() > 1 {
                    "Ausschnitte"
                } else {
                    "Ausschnitt"
                },
                bad.join(", ")
            ),
        );
    }

    if dur > 0.0 {
        for &(p, i) in &use_ {
            if p.start >= dur {
                add(
                    &mut out,
                    Error,
                    "clip-ende",
                    format!(
                        "{} beginnt bei {} s, das Video ist nur {} s lang – Zeiten aus dem Transkript nehmen",
                        n(i),
                        de(p.start, 1),
                        de(dur, 1)
                    ),
                );
            } else if p.end > dur + TOL {
                add(
                    &mut out,
                    Warn,
                    "clip-ende",
                    format!(
                        "{} endet bei {} s, nach dem Videoende ({} s) – wird gekappt",
                        n(i),
                        de(p.end, 1),
                        de(dur, 1)
                    ),
                );
            }
        }
    }

    let len = parts_length(&up);
    let len_txt = if c.pauses.as_deref() == Some("kurz") {
        format!("Länge {} s vor dem Pausenkürzen", de(len, 1))
    } else {
        format!("Länge {} s", de(len, 1))
    };
    if short && (len < 20.0 || len > 90.0) {
        add(
            &mut out,
            Warn,
            "clip-laenge",
            format!(
                "{len_txt} – für einen Short 20–90 s; {}",
                if len > 90.0 { "kürzen" } else { "verlängern" }
            ),
        );
    } else if short && (len < 55.0 || len > 75.0) {
        add(
            &mut out,
            Info,
            "clip-laenge",
            format!("{len_txt} – ideal für einen Short 55–75 s"),
        );
    }

    // Nahtlos anschließende parts zeigen keinen Schnitt, sie laufen als ein Stück
    if short {
        let mut runs: Vec<(usize, f64)> = Vec::new();
        for (k, &(p, i)) in use_.iter().enumerate() {
            match runs.last_mut() {
                Some(r) if (use_[k - 1].0.end - p.start).abs() < 1e-3 => r.1 += part_len(p),
                _ => runs.push((i, part_len(p))),
            }
        }
        let fix = if c.style.as_deref() == Some("lebendig") {
            "teilen (Füllsatz raus)"
        } else {
            "teilen (Füllsatz raus) oder style lebendig für Zoom-Wechsel"
        };
        let hits = runs
            .iter()
            .filter(|r| r.1 > CALM)
            .map(|&(i, l)| {
                hit(
                    format!("{} läuft {} s ohne Schnitt – {fix}", n(i), de(l, 1)),
                    format!("{} ({} s)", i + 1, de(l, 1)),
                )
            })
            .collect();
        bundle(
            &mut out,
            "clip-ruhe",
            hits,
            &format!(
                "von {} Stücken laufen über {} s ohne Schnitt",
                runs.len(),
                num(CALM)
            ),
            fix,
            Info,
        );
    }

    // Ohne Transkript: nur bis zum Videoende, Lücken unter 0,5 s zählen nicht
    let missing = |p: &Part| -> Vec<[f64; 2]> {
        gaps(t, p.start, if dur > 0.0 { jmin(p.end, dur) } else { p.end })
            .into_iter()
            .filter(|[a, b]| b - a >= 0.5)
            .collect()
    };

    if let Some(tr) = t {
        let real = Words::new(real_words(tr));
        let mut cut: HashSet<(usize, bool)> = HashSet::new(); // Kanten mitten im Wort: dort keine zweite Meldung zur Satzgrenze
        let mut hits = Vec::new();
        for m in snap_with(&up, &real, f64::INFINITY).moved {
            let Some(w) = real.in_word(m.from) else {
                continue;
            };
            if (m.to - m.from).abs() <= SNAP {
                continue; // bis SNAP rastet der Export die Kante selbst ein
            }
            let i = use_[m.i].1;
            let start = m.edge == "start";
            let edge = if start { "Start" } else { "Ende" };
            cut.insert((i, start));
            hits.push(hit(
                format!(
                    "{} {} mitten in „{}“ – {edge} auf {} s legen",
                    n(i),
                    if start { "beginnt" } else { "endet" },
                    trim(&w.w),
                    de(m.to, 2)
                ),
                format!("{} {edge} → {} s", i + 1, de(m.to, 2)),
            ));
        }
        bundle(
            &mut out,
            "clip-wort",
            hits,
            &format!("von {} Schnitten liegen mitten im Wort", use_.len() * 2),
            "Kanten auf die Vorschläge legen",
            Warn,
        );

        // Satz- und Einstiegsprüfung auch mit geschätzten Wortzeiten (Segmente ohne words)
        let words = Words::new(
            tr.segments
                .iter()
                .flat_map(|s| match &s.words {
                    Some(w) if !w.is_empty() => w.clone(),
                    _ => estimate_words(s, &[]),
                })
                .collect(),
        );
        let wsx = &words.ws;
        let (mut weak, mut open, mut quiet) = (Vec::new(), Vec::new(), Vec::new());
        for (k, &(p, i)) in use_.iter().enumerate() {
            if !missing(p).is_empty() {
                continue;
            }
            let idx = words.within(p.start, p.end);
            let (Some(&fi), Some(&li)) = (idx.first(), idx.last()) else {
                continue;
            };
            let (first, last) = (&wsx[fi], &wsx[li]);
            // Querformat (ganzes Video kürzen): Schnitte dazwischen sind gewollt, nur Anfang und Ende des Clips zählen
            if short || k == 0 {
                let prev = fi.checked_sub(1).map(|j| &wsx[j]);
                let b = bare(&first.w);
                if !cut.contains(&(i, true))
                    && (CONJ.contains(&b.as_str())
                        || (PRON.contains(&b.as_str())
                            && prev.is_some_and(|pw| !ends_sentence(&pw.w))))
                {
                    weak.push(hit(
                        format!("{} beginnt mit „{}“ – Start früher legen, damit der Clip für sich steht", n(i), trim(&first.w)),
                        format!("{} (ab {} s „{}“)", i + 1, de(p.start, 1), trim(&first.w)),
                    ));
                }
                let g = first.start - p.start;
                if g > 0.8 {
                    quiet.push(hit(
                        format!(
                            "{}: Stille am Anfang ({} s) – Start auf {} s legen",
                            n(i),
                            de(g, 1),
                            de(first.start, 2)
                        ),
                        format!(
                            "{} ({} s, Start auf {} s)",
                            i + 1,
                            de(g, 1),
                            de(first.start, 2)
                        ),
                    ));
                }
            }
            if (short || k == use_.len() - 1)
                && !cut.contains(&(i, false))
                && !ends_sentence(&last.w)
            {
                let tail = idx[idx.len().saturating_sub(3)..]
                    .iter()
                    .map(|&j| trim(&wsx[j].w))
                    .collect::<Vec<_>>()
                    .join(" ");
                open.push(hit(
                    format!(
                        "{} endet ohne Satzende („…{tail}“) – Ende hinter das Satzende legen",
                        n(i)
                    ),
                    format!("{} (bis {} s)", i + 1, de(p.end, 1)),
                ));
            }
        }
        // Standbild hält das letzte Bild bei stillem Ton: mitten im Satz bricht die Rede ab
        let hits = use_
            .iter()
            .filter(|(p, _)| truthy(p.freeze))
            .filter(|(p, _)| words.in_word(p.end).is_some() || words.within(p.start, p.end).last().is_some_and(|&j| !ends_sentence(&wsx[j].w)))
            .map(|&(_, i)| {
                hit(
                    format!("{} hält ein Standbild (freeze) mitten im Satz – nur am Satzende, Ende hinter das Satzende legen oder freeze weglassen", n(i)),
                    format!("{}", i + 1),
                )
            })
            .collect();
        bundle(
            &mut out,
            "clip-standbild",
            hits,
            "Standbilder mitten im Satz",
            "freeze nur am Satzende",
            Warn,
        );
        bundle(
            &mut out,
            "clip-satz",
            weak,
            &format!(
                "von {} Ausschnitten beginnen mitten im Gedanken",
                use_.len()
            ),
            "Start früher legen, damit jeder für sich steht",
            Warn,
        );
        bundle(
            &mut out,
            "clip-satz",
            open,
            &format!("von {} Ausschnitten enden ohne Satzende", use_.len()),
            "Enden hinter das Satzende legen",
            Warn,
        );
        let hits = use_
            .iter()
            .filter(|(p, _)| {
                speed_of(p) != 1.0 && c.captions.as_deref() != Some("aus") && words.within(p.start, p.end).len() as f64 >= jmax(3.0, p.end - p.start) // ab ~1 Wort je Sekunde
            })
            .map(|&(p, i)| {
                hit(
                    format!(
                        "{} läuft mit speed {} über Sprache – Sprache in Zeitlupe/Zeitraffer klingt unnatürlich; meist nur bei Aktion ohne Sprache, sonst speed weglassen",
                        n(i),
                        de(speed_of(p), 2)
                    ),
                    format!("{} (speed {})", i + 1, de(speed_of(p), 2)),
                )
            })
            .collect();
        bundle(
            &mut out,
            "clip-tempo",
            hits,
            &format!(
                "von {} Ausschnitten laufen mit Tempo über Sprache",
                use_.len()
            ),
            "Sprache in Zeitlupe/Zeitraffer klingt unnatürlich; speed nur bei Aktion ohne Sprache",
            Info,
        );
        bundle(
            &mut out,
            "clip-einstieg",
            quiet,
            &format!("von {} Ausschnitten beginnen mit Stille", use_.len()),
            "Start auf das erste Wort legen",
            Warn,
        );

        // Neuansatz: erster Anlauf läuft (über die Hälfte) mit, und der neue auch – dann hört man den Satz zweimal
        let in_parts = |a: f64, b: f64| {
            use_.iter().fold(0.0, |s, (p, _)| {
                s + jmax(0.0, jmin(b, p.end) - jmax(a, p.start))
            })
        };
        let hits = retakes(tr)
            .into_iter()
            .filter_map(|r| {
                let [a, b] = r.drop;
                let k = use_
                    .iter()
                    .find(|(p, _)| p.start <= r.keep && r.keep < p.end)?;
                if in_parts(a, b) <= (b - a) / 2.0 {
                    return None;
                }
                Some(hit(
                    format!(
                        "{} enthält einen Neuansatz („{}“) – {}–{} s herausschneiden",
                        n(k.1),
                        r.text,
                        de(a, 2),
                        de(b, 2)
                    ),
                    format!("{} ({}–{} s)", k.1 + 1, de(a, 2), de(b, 2)),
                ))
            })
            .collect();
        bundle(
            &mut out,
            "clip-neuansatz",
            hits,
            "Neuansätze in den Ausschnitten",
            "jeweils den ersten Anlauf herausschneiden",
            Warn,
        );
    }

    if c.captions.as_deref() != Some("aus") {
        // Lücken unter 10 s zusammenfassen: ein transcribe_video mit from/to statt vieler kleiner
        let mut gs: Vec<[f64; 2]> = use_.iter().flat_map(|(p, _)| missing(p)).collect();
        gs.sort_by(|a, b| by_diff(a[0] - b[0]));
        let mut miss: Vec<[f64; 2]> = Vec::new();
        for g in gs {
            match miss.last_mut() {
                Some(l) if g[0] - l[1] < 10.0 => l[1] = jmax(l[1], g[1]),
                _ => miss.push(g),
            }
        }
        if !miss.is_empty() {
            let list = miss
                .iter()
                .map(|[a, b]| format!("{}–{} s", num(a.floor()), num(b.ceil())))
                .collect::<Vec<_>>()
                .join(", ");
            add(
                &mut out,
                Warn,
                "clip-transkript",
                format!(
                    "Kein Transkript für {list}: erst transcribe_video mit from/to, sonst keine Untertitel"
                ),
            );
        }
    }

    let overlap = |a: &Part, b: &Part| jmax(0.0, jmin(a.end, b.end) - jmax(a.start, b.start));
    let mut hits = Vec::new();
    for (k, &(a, ai)) in use_.iter().enumerate() {
        for &(b, bi) in &use_[k + 1..] {
            let o = overlap(a, b);
            if o > TOL {
                hits.push(hit(
                    format!("{} und {} überschneiden sich ({} s) – Bereiche trennen, sonst läuft die Stelle doppelt", n(ai), bi + 1, de(o, 1)),
                    format!("{}/{} ({} s)", ai + 1, bi + 1, de(o, 1)),
                ));
            }
        }
    }
    bundle(
        &mut out,
        "clip-overlap",
        hits,
        "Paare von Ausschnitten überschneiden sich",
        "Bereiche trennen, sonst laufen Stellen doppelt",
        Warn,
    );
    for (k, x) in others.iter().enumerate() {
        if Some(k) == self_idx || x.video != c.video {
            continue;
        }
        let o = use_.iter().fold(0.0, |s, (a, _)| {
            s + x
                .parts
                .iter()
                .filter(|b| valid(b))
                .fold(0.0, |s2, b| s2 + overlap(a, b))
        });
        if o > 5.0 {
            add(
                &mut out,
                Warn,
                "clip-overlap",
                format!(
                    "überschneidet sich {} s mit Clip {} (gleiches Video) – andere Stelle wählen",
                    de(o, 0),
                    k + 1
                ),
            );
        }
    }

    // Fremde Hintergrundmusik bringt Copyright-Strikes; volle Quellsekunden zählen je einmal
    if let Some(music) = &info.music {
        let mut secs: HashSet<i64> = HashSet::new();
        let mut first = f64::INFINITY;
        for (p, _) in &use_ {
            let mut s = p.start.ceil();
            while s < jmin(p.end.floor(), music.len() as f64) {
                if music[s as usize] >= MUSIC {
                    secs.insert(s as i64);
                    first = jmin(first, s);
                }
                s += 1.0;
            }
        }
        if secs.len() >= 5 {
            add(
                &mut out,
                Warn,
                "clip-musik",
                format!(
                    "Musik im Hintergrund ({} s, u. a. bei {}) – bei fremder Musik droht ein Copyright-Strike; Stelle meiden oder Musik prüfen",
                    secs.len(),
                    mmss(first)
                ),
            );
        }
    }

    // Effekte sparsam: Übergänge mit Bewegung nur an Orts- oder Szenenwechseln; vor dem ersten Ausschnitt gibt es keinen Schnitt
    let cuts_at: Vec<&Part> = use_
        .iter()
        .enumerate()
        .filter(|&(k, (p, _))| k > 0 && (use_[k - 1].0.end - p.start).abs() >= 1e-3)
        .map(|(_, (p, _))| *p)
        .collect();
    let fancy: Vec<&str> = cuts_at
        .iter()
        .filter_map(|p| p.transition.as_deref())
        .filter(|tr| !tr.is_empty() && !["none", "fade", "dissolve"].contains(tr))
        .collect();
    if fancy.len() >= 2 && fancy.len() as f64 > cuts_at.len() as f64 / 3.0 {
        let mut kinds: Vec<&str> = Vec::new();
        for f in &fancy {
            if !kinds.contains(f) {
                kinds.push(f);
            }
        }
        add(
            &mut out,
            Info,
            "clip-uebergang",
            format!(
                "{} von {} Schnitten mit Effekt-Übergang ({}) – sparsam einsetzen: nur an Orts- oder Szenenwechseln, sonst transition weglassen (automatische Blende)",
                fancy.len(),
                cuts_at.len(),
                kinds.join(", ")
            ),
        );
    }
    if info.deck_music == Some(false) {
        let hits = use_
            .iter()
            .filter(|(p, _)| p.music.is_some())
            .map(|&(_, i)| hit(format!("{} setzt music, das Deck hat keine Hintergrundmusik – erst find_music und update_deck music, sonst music weglassen", n(i)), format!("{}", i + 1)))
            .collect();
        bundle(
            &mut out,
            "clip-musik",
            hits,
            "Ausschnitte setzen music, das Deck hat keine Hintergrundmusik",
            "erst find_music und update_deck music, sonst music weglassen",
            Warn,
        );
    }
    let ov: &[Overlay] = c.overlays.as_deref().unwrap_or(&[]);
    let ov_n = |k: usize| format!("Einblendung {}", k + 1);
    let spans: Vec<Vec<[f64; 2]>> = ov.iter().map(|o| clip_spans(&up, o.start, o.end)).collect();
    let hits = ov
        .iter()
        .enumerate()
        .filter(|&(k, _)| spans[k].is_empty())
        .map(|(k, o)| {
            hit(
                format!(
                    "{} ({}–{} s) liegt in keinem Ausschnitt und ist nie zu sehen – Zeiten in einen Ausschnitt legen (Quellsekunden wie parts)",
                    ov_n(k),
                    de(o.start, 1),
                    de(o.end, 1)
                ),
                format!("{} ({}–{} s)", k + 1, de(o.start, 1), de(o.end, 1)),
            )
        })
        .collect();
    bundle(
        &mut out,
        "clip-einblendung",
        hits,
        &format!("von {} Einblendungen liegen in keinem Ausschnitt", ov.len()),
        "Zeiten in einen Ausschnitt legen (Quellsekunden wie parts)",
        Warn,
    );
    let tlen = |s: &Option<String>| s.as_deref().map_or(0, |s| len16(trim(s)));
    let hits = ov
        .iter()
        .enumerate()
        .filter_map(|(k, o)| {
            let l = (if o.art.as_deref() == Some("zitat") { 0 } else { tlen(&o.text) }).max(tlen(&o.sub));
            (l > 40).then(|| hit(format!("{} hat {l} Zeichen in einer Zeile – kürzer (höchstens 40: Name, Funktion, Ort, Zahl)", ov_n(k)), format!("{}", k + 1)))
        })
        .collect();
    bundle(
        &mut out,
        "clip-einblendung",
        hits,
        "Einblendungen über 40 Zeichen",
        "kürzer (höchstens 40: Name, Funktion, Ort, Zahl)",
        Info,
    );
    // Verpixeln liegt unter allem; zwei sichtbare Einblendungen zugleich überladen das Bild – nur der Abspann darf ein Bild (Logo) dabeihaben
    let shown: Vec<(usize, &Overlay)> = ov
        .iter()
        .enumerate()
        .filter(|(_, o)| o.art.as_deref() != Some("verpixeln"))
        .collect();
    let has_img = |o: &Overlay| o.image.as_deref().is_some_and(|s| !s.is_empty());
    let logo = |a: &Overlay, b: &Overlay| {
        (a.art.as_deref() == Some("abspann") && has_img(b))
            || (b.art.as_deref() == Some("abspann") && has_img(a))
    };
    let mut hits = Vec::new();
    for (j, &(ak, a)) in shown.iter().enumerate() {
        for &(bk, b) in &shown[j + 1..] {
            if !logo(a, b) && jmin(a.end, b.end) - jmax(a.start, b.start) > TOL {
                hits.push(hit(format!("{} und {} stehen gleichzeitig – höchstens eine Einblendung zur Zeit, Zeiten trennen", ov_n(ak), bk + 1), format!("{}/{}", ak + 1, bk + 1)));
            }
        }
    }
    bundle(
        &mut out,
        "clip-einblendung",
        hits,
        "Paare von Einblendungen stehen gleichzeitig",
        "höchstens eine Einblendung zur Zeit, Zeiten trennen",
        Warn,
    );
    let hits = ov
        .iter()
        .enumerate()
        .filter_map(|(k, o)| {
            let l = sum_spans(&spans[k]);
            (o.pos.as_deref() == Some("voll") && l > BROLL).then(|| {
                hit(
                    format!(
                        "{} (pos voll) verdeckt {} s den Sprecher – B-Roll 2–6 s, höchstens {} s",
                        ov_n(k),
                        de(l, 1),
                        num(BROLL)
                    ),
                    format!("{} ({} s)", k + 1, de(l, 1)),
                )
            })
        })
        .collect();
    bundle(
        &mut out,
        "clip-einblendung",
        hits,
        &format!("Einblendungen mit pos voll länger als {} s", num(BROLL)),
        "B-Roll 2–6 s",
        Info,
    );
    let hits = ov
        .iter()
        .enumerate()
        .filter_map(|(k, o)| {
            let l = sum_spans(&spans[k]);
            (o.art.as_deref() == Some("markierung") && l > MARK).then(|| {
                hit(
                    format!("{} (markierung) steht {} s – ein Rahmen zeigt kurz, wo man hinschauen soll: 2–{} s", ov_n(k), de(l, 1), num(MARK)),
                    format!("{} ({} s)", k + 1, de(l, 1)),
                )
            })
        })
        .collect();
    bundle(
        &mut out,
        "clip-einblendung",
        hits,
        &format!("Markierungen länger als {} s", num(MARK)),
        &format!("2–{} s, solange das Detail erklärt wird", num(MARK)),
        Info,
    );
    let ends: Vec<usize> = (0..ov.len())
        .filter(|&k| ov[k].art.as_deref() == Some("abspann"))
        .collect();
    let hits = ends
        .iter()
        .filter_map(|&k| {
            let sp = &spans[k];
            (!sp.is_empty() && sp[0][0] < len - OUTRO).then(|| {
                hit(
                    format!(
                        "{} (abspann) beginnt {} s vor dem Ende – Abspann nur in die letzten {} s",
                        ov_n(k),
                        de(len - sp[0][0], 1),
                        num(OUTRO)
                    ),
                    format!("{}", k + 1),
                )
            })
        })
        .collect();
    bundle(
        &mut out,
        "clip-einblendung",
        hits,
        &format!("Abspann vor den letzten {} s", num(OUTRO)),
        &format!("Abspann nur in die letzten {} s", num(OUTRO)),
        Warn,
    );
    if ends.len() > 1 {
        add(
            &mut out,
            Warn,
            "clip-einblendung",
            format!("{} Abspanne – höchstens einer je Clip, am Ende", ends.len()),
        );
    }
    if c.hook.as_deref().is_some_and(|h| !trim(h).is_empty()) {
        let hits = ov
            .iter()
            .enumerate()
            .filter(|&(k, o)| o.pos.as_deref() == Some("voll") && spans[k].iter().any(|&[a, _]| a < HOOK_S))
            .map(|(k, _)| {
                hit(
                    format!("{} (pos voll) steht in den ersten {} s – dort hält das Gesicht mit dem Hook den Zuschauer, später einblenden", ov_n(k), num(HOOK_S)),
                    format!("{}", k + 1),
                )
            })
            .collect();
        bundle(
            &mut out,
            "clip-einblendung",
            hits,
            &format!("Einblendungen mit pos voll in den ersten {} s", num(HOOK_S)),
            "dort hält das Gesicht mit dem Hook den Zuschauer, später einblenden",
            Warn,
        );
    }
    if let Some(sl) = &info.slides {
        // sl[o.slide - 1] wie in JS: nur ganze Nummern ab 1 treffen eine Folie
        let at = |s: f64| {
            let j = s - 1.0;
            (j >= 0.0 && j.fract() == 0.0 && j < sl.len() as f64).then(|| &sl[j as usize])
        };
        let hits = ov
            .iter()
            .enumerate()
            .filter_map(|(k, o)| {
                let no = o.slide?;
                let s = at(no);
                (s.is_none_or(|s| s.layout == "clip")).then(|| {
                    hit(
                        format!(
                            "{}: Folie {} {} – Nummer einer ausgeblendeten Folie aus dem Katalog eintragen",
                            ov_n(k),
                            num(no),
                            if s.is_some() { "ist ein Clip" } else { "gibt es nicht" }
                        ),
                        format!("{} (Folie {})", k + 1, num(no)),
                    )
                })
            })
            .collect();
        bundle(
            &mut out,
            "clip-einblendung",
            hits,
            "Einblendungen verweisen auf keine passende Folie",
            "Nummer einer ausgeblendeten Folie aus dem Katalog eintragen",
            Error,
        );
        let hits = ov
            .iter()
            .enumerate()
            .filter_map(|(k, o)| {
                let no = o.slide?;
                let s = at(no)?;
                (s.layout != "clip" && !s.hidden.unwrap_or(false)).then(|| {
                    hit(
                        format!("{}: Folie {} ist nicht ausgeblendet und läuft zusätzlich als eigene Folie – update_slide hidden: true", ov_n(k), num(no)),
                        format!("{} (Folie {})", k + 1, num(no)),
                    )
                })
            })
            .collect();
        bundle(
            &mut out,
            "clip-einblendung",
            hits,
            "eingeblendete Folien sind nicht ausgeblendet",
            "update_slide hidden: true",
            Warn,
        );
    }
    // Punch-in wirkt nur als Ausnahme: viele Stufen oder Zoom an den meisten Schnitten wirkt hektisch
    let zoomed: Vec<f64> = use_
        .iter()
        .filter_map(|(p, _)| p.zoom.filter(|&z| truthy(Some(z)) && z != 1.0))
        .collect();
    let mut levels: Vec<f64> = Vec::new();
    for z in &zoomed {
        if !levels.contains(z) {
            levels.push(*z);
        }
    }
    if levels.len() > 2 || (zoomed.len() >= 2 && zoomed.len() as f64 > use_.len() as f64 / 2.0) {
        add(
            &mut out,
            Info,
            "clip-zoom",
            format!(
                "zoom an {} von {} Ausschnitten, {} {} – Punch-in nur an Pointen (1.1–1.2), höchstens zwei Stufen",
                zoomed.len(),
                use_.len(),
                levels.len(),
                if levels.len() == 1 { "Stufe" } else { "Stufen" }
            ),
        );
    }

    let hook_words = c.hook.as_deref().map_or(0, |h| split_words(h).len());
    if short && hook_words == 0 {
        add(
            &mut out,
            Info,
            "clip-hook",
            "Kein Hook – für Shorts eine Einstiegszeile setzen (3–9 Wörter)".into(),
        );
    }
    if hook_words > 9 {
        add(
            &mut out,
            Info,
            "clip-hook",
            format!("Hook hat {hook_words} Wörter – kürzer (3–9 Wörter)"),
        );
    }
    if short && c.post.as_deref().is_none_or(|p| trim(p).is_empty()) {
        add(
            &mut out,
            Info,
            "clip-post",
            "Kein Post-Text – post mit Titel, 1–2 Sätzen und 3–5 Hashtags setzen".into(),
        );
    }
    if let Some(cv) = c.cover
        && (!cv.is_finite() || cv < 0.0 || (dur > 0.0 && cv > dur))
    {
        let range = if dur > 0.0 {
            format!(" (0–{} s)", de(dur, 1))
        } else {
            String::new()
        };
        add(
            &mut out,
            Warn,
            "clip-post",
            format!(
                "cover bei {} s liegt nicht im Video{range} – Sekunde aus dem Kontaktabzug nehmen",
                de(cv, 1)
            ),
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // NaN kann kein Fixture tragen (JSON): ungültige Zeiten direkt prüfen
    #[test]
    fn nan_parts() {
        let p = |start, end| Part {
            start,
            end,
            ..Default::default()
        };
        let c = ClipContent {
            video: Some("asset://a.mp4".into()),
            parts: vec![p(0.0, 60.0), p(5.0, 5.0), p(f64::NAN, 3.0), p(-1.0, 4.0)],
            ..Default::default()
        };
        let r = lint_clip(
            &c,
            Size {
                w: 1280.0,
                h: 720.0,
            },
            &ClipInfo {
                duration: Some(100.0),
                ..Default::default()
            },
            &[],
            None,
        );
        let rules: Vec<_> = r.iter().map(|x| x.rule.as_str()).collect();
        assert_eq!(rules, ["clip-zeit", "clip-transkript"]);
        assert_eq!(
            r[0].message,
            "Ausschnitte 2, 3, 4 ohne gültige Zeiten (start ≥ 0, end nach start) – Zeiten aus dem Transkript nehmen"
        );
        assert!(!r.iter().any(|x| x.message.contains("NaN")));
    }

    // Binärsuche und lineare Suche liefern dasselbe Wort, auch bei unsortierten Wörtern
    #[test]
    fn in_word_fallback() {
        let w = |s: &str, start, end| Word {
            w: s.into(),
            start,
            end,
        };
        let sorted = Words::new(vec![w("a", 0.0, 1.0), w("b", 1.0, 2.0), w("c", 2.0, 3.0)]);
        assert!(sorted.edges_sorted);
        assert_eq!(sorted.in_word(1.5).map(|x| x.w.as_str()), Some("b"));
        assert_eq!(sorted.in_word(1.0), None);
        let un = Words::new(vec![w("c", 2.0, 3.0), w("a", 0.0, 5.0), w("b", 1.0, 2.0)]);
        assert!(!un.edges_sorted);
        assert_eq!(un.in_word(2.5).map(|x| x.w.as_str()), Some("c"));
        assert_eq!(un.within(0.0, 2.0), vec![2]);
    }
}
