//! Podcast-Schnitt (`shared/podcast.ts`): Datenmodell und Zeitrechnung. Zeiten in Sekunden.
//! Zwei Zeitachsen: Quellzeit (alle Spuren laufen gleichzeitig ab 0) und geschnittene Zeit (ohne die cuts). Gespeichert wird Quellzeit.

use dw_lint::js::{WS, trim};
use dw_lint::video::{ClipContent, PAD, Segment, Sfx, Transcript, retakes};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::sync::LazyLock;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PodTrack {
    pub src: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// dB (−12…12)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mute: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CutWhy {
    Pause,
    Fuell,
    Versprecher,
    Hand,
}

/// Entfernter Bereich in Quellzeit
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cut {
    pub start: f64,
    pub end: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<CutWhy>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Chapter {
    pub at: f64,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PodTon {
    Original,
    Klar,
    Stark,
}

/// deck.podcast
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Episode {
    /// Quelllänge = längste Spur
    pub duration: f64,
    pub tracks: Vec<PodTrack>,
    pub cuts: Vec<Cut>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sfx: Option<Vec<Sfx>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intro: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outro: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chapters: Option<Vec<Chapter>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ton: Option<PodTon>,
}

pub type Span = [f64; 2];
/// Podcast-Ziel (Apple/Spotify-Sprache); Video bleibt bei −14
pub const LUFS: f64 = -16.0;
/// Kürzere automatische Pausenschnitte lohnen nicht
const MIN_CUT: f64 = 0.2;

fn by(d: f64) -> Ordering {
    d.partial_cmp(&0.0).unwrap_or(Ordering::Equal)
}

/// Prüfung wie `episodeSchema`; erste Verletzung als Text
pub fn validate(ep: &Episode) -> Result<(), String> {
    let src = |s: &str, w: &str| {
        if s.is_empty() {
            Err(format!("{w}: Pfad fehlt"))
        } else {
            Ok(())
        }
    };
    if !(ep.duration > 0.0) {
        return Err("duration muss positiv sein".into());
    }
    if ep.tracks.is_empty() || ep.tracks.len() > 4 {
        return Err("1 bis 4 Spuren".into());
    }
    for t in &ep.tracks {
        src(&t.src, "Spur")?;
        if t.name.as_ref().is_some_and(|n| dw_lint::js::len16(n) > 40) {
            return Err("Spurname höchstens 40 Zeichen".into());
        }
        if t.gain.is_some_and(|g| !(-12.0..=12.0).contains(&g)) {
            return Err("gain −12…12 dB".into());
        }
    }
    if ep.cuts.len() > 5000 || ep.cuts.iter().any(|c| !(c.start >= 0.0 && c.end >= 0.0)) {
        return Err("Schnitte ungültig".into());
    }
    let sfx = ep.sfx.as_deref().unwrap_or(&[]);
    if sfx.len() > 200
        || sfx.iter().any(|s| {
            s.src.is_empty()
                || !(s.at >= 0.0)
                || s.gain.is_some_and(|g| !(-24.0..=12.0).contains(&g))
        })
    {
        return Err("Soundeffekte ungültig".into());
    }
    for s in [&ep.intro, &ep.outro].into_iter().flatten() {
        src(s, "Jingle")?;
    }
    let ch = ep.chapters.as_deref().unwrap_or(&[]);
    if ch.len() > 100
        || ch
            .iter()
            .any(|c| !(c.at >= 0.0) || c.title.is_empty() || dw_lint::js::len16(&c.title) > 80)
    {
        return Err("Kapitel ungültig".into());
    }
    Ok(())
}

/// Schnitte sortiert, auf 0…duration begrenzt, überlappende und angrenzende zusammengelegt (why vom ersten, Hand gewinnt). Leere fallen weg.
pub fn norm_cuts(cuts: &[Cut], duration: f64) -> Vec<Cut> {
    let mut cs: Vec<Cut> = cuts
        .iter()
        .map(|c| Cut {
            start: 0f64.max(c.start),
            end: duration.min(c.end),
            why: c.why,
        })
        .filter(|c| c.end > c.start)
        .collect();
    cs.sort_by(|a, b| by(a.start - b.start));
    let mut out: Vec<Cut> = Vec::new();
    for c in cs {
        match out.last_mut() {
            Some(l) if c.start <= l.end + 1e-3 => {
                l.end = l.end.max(c.end);
                // Hand-Schnitt gewinnt: sonst rechnete das nächste clean ihn als Pause weg
                if l.why.is_some_and(|w| w != CutWhy::Hand)
                    && c.why.is_none_or(|w| w == CutWhy::Hand)
                {
                    l.why = Some(CutWhy::Hand);
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// Was stehen bleibt, in Quellzeit
pub fn keep_ranges(cuts: &[Cut], duration: f64) -> Vec<Span> {
    let mut out = Vec::new();
    let mut t = 0.0;
    for c in norm_cuts(cuts, duration) {
        if c.start > t {
            out.push([t, c.start]);
        }
        t = c.end;
    }
    if t < duration {
        out.push([t, duration]);
    }
    out
}

pub fn edited_length(cuts: &[Cut], duration: f64) -> f64 {
    keep_ranges(cuts, duration)
        .iter()
        .fold(0.0, |s, [a, b]| s + b - a)
}
pub fn in_cut(t: f64, cuts: &[Cut]) -> bool {
    cuts.iter().any(|c| t > c.start + 1e-3 && t < c.end - 1e-3)
}

/// Quellzeit → geschnittene Zeit; in einem Schnitt zählt dessen Anfang
pub fn to_edited(t: f64, cuts: &[Cut], duration: f64) -> f64 {
    let mut out = 0.0;
    for [a, b] in keep_ranges(cuts, duration) {
        if t <= a {
            break;
        }
        out += t.min(b) - a;
    }
    out
}
/// Geschnittene Zeit → Quellzeit
pub fn to_source(e: f64, cuts: &[Cut], duration: f64) -> f64 {
    let mut rest = 0f64.max(e);
    let ks = keep_ranges(cuts, duration);
    for &[a, b] in &ks {
        if rest <= b - a {
            return a + rest;
        }
        rest -= b - a;
    }
    ks.last().map_or(0.0, |k| k[1])
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WordSpan {
    pub start: f64,
    pub end: f64,
}
/// Kanten, die in einem Wort liegen, auf dessen Rand legen, damit nie ein halbes Wort bleibt
pub fn snap_cut(c: &Cut, words: &[WordSpan]) -> Cut {
    let hit = |t: f64| words.iter().find(|w| t > w.start && t < w.end);
    Cut {
        start: hit(c.start).map_or(c.start, |w| w.start),
        end: hit(c.end).map_or(c.end, |w| w.end),
        why: c.why,
    }
}

// Echte Wortzeiten aller Sprecher, nach Start sortiert; dazu Präfix-Maximum der Enden und Enden sortiert für Binärsuche.
// Befund L9 (§7.5): TS suchte je Wort/Pause linear über alle Wörter (O(n²)) und nutzte Math.max(...spread), das bei 8 h die Argumentgrenze sprengt.
struct Words {
    w: Vec<(String, f64, f64, Option<f64>)>,
    pmax: Vec<f64>,
    ends: Vec<(f64, usize)>,
}
impl Words {
    fn new(t: &Transcript) -> Self {
        let mut w: Vec<(String, f64, f64, Option<f64>)> = t
            .segments
            .iter()
            .flat_map(|s| {
                s.words
                    .iter()
                    .flatten()
                    .map(|x| (x.w.clone(), x.start, x.end, s.speaker))
            })
            .collect();
        w.sort_by(|a, b| by(a.1 - b.1));
        let mut m = f64::NEG_INFINITY;
        let pmax = w
            .iter()
            .map(|x| {
                m = m.max(x.2);
                m
            })
            .collect();
        let mut ends: Vec<(f64, usize)> = w.iter().enumerate().map(|(i, x)| (x.2, i)).collect();
        ends.sort_by(|a, b| a.0.total_cmp(&b.0));
        Words { w, pmax, ends }
    }
    /// Indizes der Wörter, die (a, b) schneiden können: Start < b und ein Ende bis dahin > a
    fn around(&self, a: f64, b: f64) -> std::ops::Range<usize> {
        let lo = self.pmax.partition_point(|&e| e <= a);
        let hi = self.w.partition_point(|x| x.1 < b);
        lo..hi.max(lo)
    }
    // Gemeinsame Zeitachse: ein Schnitt trifft alle Spuren, also nie, solange ein anderer Sprecher redet
    fn other_talks(&self, a: f64, b: f64, speaker: Option<f64>) -> bool {
        self.around(a, b).any(|i| {
            let x = &self.w[i];
            x.3 != speaker && x.2 > a && x.1 < b
        })
    }
}

/// Füllwort; „um“ nur im Englischen, im Deutschen meist Präposition
static FILLERS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)^[\p{{P}}{WS}]*(?:äh|ähm|öh|öhm|hm|hmm|mhm|uh|um|uhm|erm)[\p{{P}}{WS}]*$"
    ))
    .unwrap()
});
static PUNCT_WS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"[\p{{P}}{WS}]")).unwrap());
pub fn is_filler(w: &str, lang: &str) -> bool {
    FILLERS.is_match(w)
        && (lang.starts_with("en") || !PUNCT_WS.replace_all(w, "").eq_ignore_ascii_case("um"))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AutoClean {
    /// längste erlaubte Pause in s
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pauses: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fillers: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retakes: Option<bool>,
}

/// Transkripte je Spur zu einem: Sprecher = Spurnummer. Eine Spur bleibt, wie sie ist.
pub fn merge_tracks(ts: &[Option<Transcript>]) -> Option<Transcript> {
    let ok: Vec<(&Transcript, usize)> = ts
        .iter()
        .enumerate()
        .filter_map(|(k, t)| t.as_ref().map(|t| (t, k)))
        .collect();
    let first = ok.first()?;
    if ts.len() == 1 {
        return Some(first.0.clone());
    }
    let mut segments: Vec<Segment> = ok
        .iter()
        .flat_map(|(t, k)| {
            t.segments.iter().map(|s| Segment {
                speaker: Some(*k as f64),
                ..s.clone()
            })
        })
        .collect();
    segments.sort_by(|a, b| by(a.start - b.start));
    Some(Transcript {
        duration: ok
            .iter()
            .fold(f64::NEG_INFINITY, |m, (t, _)| m.max(t.duration)),
        lang: first.0.lang.clone(),
        segments,
        covered: None,
    })
}

/// Transkript der Episode über alle Spuren.
/// Befund K22 (§7.2): create_episode nahm nur das Transkript von Spur 1, edit_episode alle; beide nutzen jetzt diese Funktion.
pub fn episode_transcript(
    ep: &Episode,
    transcript_of: impl Fn(&str) -> Option<Transcript>,
) -> Option<Transcript> {
    merge_tracks(
        &ep.tracks
            .iter()
            .map(|t| transcript_of(&t.src))
            .collect::<Vec<_>>(),
    )
}

/// Neue Schnittliste: Hand-Schnitte bleiben, automatische (Pausen, Füllwörter, Versprecher) neu aus o. quiet = Stillen der gemischten Sprache.
pub fn auto_cuts(ep: &Episode, t: Option<&Transcript>, quiet: &[Span], o: &AutoClean) -> Vec<Cut> {
    let mut out: Vec<Cut> = ep
        .cuts
        .iter()
        .filter(|c| c.why.is_none_or(|w| w == CutWhy::Hand))
        .cloned()
        .collect();
    let ws = t.map(Words::new);
    let wl = ws.as_ref().map_or(&[][..], |w| &w.w[..]);
    if let Some(p) = o.pauses {
        let p = 0f64.max(p);
        for &[a, b] in quiet {
            if b - a <= p {
                continue;
            }
            // kürzen, nicht entfernen: Atempause bleibt
            let (mut start, mut end) = (a + p / 2.0, b - p / 2.0);
            // leise Wortenden (silencedetect hört sie nicht) bleiben ganz: der Schnitt weicht den Wörtern aus.
            // start wächst, end schrumpft: Wörter außerhalb des Anfangsfensters treffen nie
            if let Some(ws) = &ws {
                for i in ws.around(start, end) {
                    let w = &ws.w[i];
                    if w.2 > start && w.1 < end {
                        if w.1 + w.2 < start + end {
                            start = w.2
                        } else {
                            end = w.1
                        }
                    }
                }
            }
            if end - start >= MIN_CUT {
                out.push(Cut {
                    start,
                    end,
                    why: Some(CutWhy::Pause),
                });
            }
        }
    }
    if let (Some(t), Some(ws)) = (t, &ws)
        && o.fillers == Some(true)
    {
        for (i, w) in wl.iter().enumerate() {
            if !is_filler(&w.0, &t.lang) || ws.other_talks(w.1, w.2, w.3) {
                continue;
            }
            // Rand höchstens PAD und nie ins Nachbarwort (gleich welcher Sprecher)
            let k = ws.ends.partition_point(|e| e.0 <= w.1);
            let prev = ws.ends[..k]
                .iter()
                .rev()
                .find(|e| e.1 != i)
                .map_or(f64::NEG_INFINITY, |e| e.0);
            let j = wl.partition_point(|v| v.1 < w.2);
            let next = (j..wl.len())
                .find(|&j| j != i)
                .map_or(f64::INFINITY, |j| wl[j].1);
            out.push(Cut {
                start: (w.1 - PAD).max(prev),
                end: (w.2 + PAD).min(next),
                why: Some(CutWhy::Fuell),
            });
        }
    }
    if let (Some(t), Some(ws)) = (t, &ws)
        && o.retakes == Some(true)
    {
        for r in retakes(t) {
            let k = wl.partition_point(|w| w.1 < r.drop[0] - 1e-3);
            let sp = wl.get(k).and_then(|w| w.3);
            if !ws.other_talks(r.drop[0], r.drop[1], sp) {
                out.push(Cut {
                    start: r.drop[0],
                    end: r.drop[1],
                    why: Some(CutWhy::Versprecher),
                });
            }
        }
    }
    norm_cuts(&out, ep.duration)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
    Info,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PodIssue {
    pub level: Level,
    pub rule: String,
    pub msg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<f64>,
}

/// m:ss bzw. h:mm:ss
pub fn clock(s: f64) -> String {
    let r = dw_lint::js::round(0f64.max(s)) as u64;
    let (h, m, sec) = (r / 3600, (r % 3600) / 60, r % 60);
    if h > 0 {
        format!("{h}:{m:02}:{sec:02}")
    } else {
        format!("{m}:{sec:02}")
    }
}

const SNAP: f64 = 0.05;
const CHAPTER_MIN: f64 = 30.0;
const LONG_PAUSE: f64 = 3.0;

pub fn lint_episode(ep: &Episode, t: Option<&Transcript>) -> Vec<PodIssue> {
    let mut out = Vec::new();
    let mut push = |level, rule: &str, at: Option<f64>, msg: String| {
        out.push(PodIssue {
            level,
            rule: rule.into(),
            msg,
            at,
        })
    };
    let cuts = norm_cuts(&ep.cuts, ep.duration);
    let len = edited_length(&cuts, ep.duration);
    let ws = t.map(Words::new);
    let wl = ws.as_ref().map_or(&[][..], |w| &w.w[..]);
    for c in &cuts {
        for e in [c.start, c.end] {
            if e <= 0.0 || e >= ep.duration {
                continue;
            }
            let hit = ws.as_ref().and_then(|ws| {
                ws.around(e + SNAP, e - SNAP)
                    .find(|&i| e > wl[i].1 + SNAP && e < wl[i].2 - SNAP)
            });
            if let Some(i) = hit {
                push(
                    Level::Warn,
                    "schnitt-wort",
                    Some(e),
                    format!(
                        "Schnitt bei {} trennt das Wort „{}“ – Kante an den Wortrand legen (snapCut).",
                        clock(e),
                        trim(&wl[i].0)
                    ),
                );
            }
        }
    }
    for s in ep.sfx.iter().flatten() {
        if in_cut(s.at, &cuts) {
            push(
                Level::Warn,
                "sfx-im-schnitt",
                Some(s.at),
                format!(
                    "Soundeffekt bei {} liegt in einem Schnitt und fällt weg – verschieben oder löschen.",
                    clock(s.at)
                ),
            );
        }
    }
    let mut chapters: Vec<&Chapter> = ep.chapters.iter().flatten().collect();
    chapters.sort_by(|a, b| by(a.at - b.at));
    for c in &chapters {
        if in_cut(c.at, &cuts) {
            push(
                Level::Warn,
                "kapitel-im-schnitt",
                Some(c.at),
                format!(
                    "Kapitel „{}“ ({}) liegt in einem Schnitt – an den Anfang des folgenden Satzes legen.",
                    c.title,
                    clock(c.at)
                ),
            );
        }
    }
    if len < ep.duration * 0.5 {
        push(
            Level::Warn,
            "zu-kurz",
            None,
            format!(
                "Schnitt sehr aggressiv: von {} bleiben nur {} – Pausen weniger stark kürzen oder Schnitte prüfen.",
                clock(ep.duration),
                clock(len)
            ),
        );
    }
    for (i, c) in chapters.iter().enumerate() {
        let from = to_edited(c.at, &cuts, ep.duration);
        let to = chapters
            .get(i + 1)
            .map_or(len, |n| to_edited(n.at, &cuts, ep.duration));
        if to - from < CHAPTER_MIN {
            push(
                Level::Info,
                "kapitel-kurz",
                Some(c.at),
                format!(
                    "Kapitel „{}“ ist nur {} s lang – mit dem Nachbarkapitel zusammenlegen.",
                    c.title,
                    dw_lint::js::num(dw_lint::js::round(to - from))
                ),
            );
        }
    }
    if !chapters.is_empty()
        && !chapters
            .iter()
            .any(|c| to_edited(c.at, &cuts, ep.duration) <= 1.0)
    {
        push(
            Level::Info,
            "kapitel-start",
            Some(chapters[0].at),
            "Das erste Kapitel sollte bei 0:00 beginnen – ein Kapitel an den Anfang setzen.".into(),
        );
    }
    if t.is_none() {
        push(
            Level::Info,
            "ohne-transkript",
            None,
            "Kein Transkript – erst transcribe_video, sonst keine Füllwörter/Kapitel-Vorschläge."
                .into(),
        );
    }
    let mut end = wl.first().map_or(0.0, |w| w.2);
    for w in wl.iter().skip(1) {
        if w.1 - end > LONG_PAUSE
            && to_edited(w.1, &cuts, ep.duration) - to_edited(end, &cuts, ep.duration) > LONG_PAUSE
        {
            push(
                Level::Info,
                "pause-lang",
                Some(end),
                format!(
                    "Bei {} bleibt eine Stille über {} s – kürzen, wenn sie nicht gewollt ist.",
                    clock(end),
                    dw_lint::js::num(LONG_PAUSE)
                ),
            );
        }
        end = end.max(w.2);
    }
    let n = ep.sfx.as_ref().map_or(0, Vec::len);
    if n as f64 > 1f64.max(len / 60.0) {
        push(
            Level::Warn,
            "sfx-viele",
            None,
            format!(
                "{n} Soundeffekte auf {} – höchstens einer je Minute, Effekte sparsam einsetzen.",
                clock(len)
            ),
        );
    }
    out
}

/// „Als Podcast“: Clip-Folien → Episode. Alle müssen dieselbe Quelle haben; was keine Folie zeigt, wird geschnitten.
pub fn deck_to_episode(slides: &[dw_model::Slide], duration: f64) -> Result<Episode, String> {
    let clips: Vec<ClipContent> = slides
        .iter()
        .filter(|s| s.layout == "clip" && s.hidden != Some(true))
        .map(|s| {
            serde_json::from_value(s.content.clone())
                .map_err(|e| format!("Clip-Folie {}: {e}", s.id))
        })
        .collect::<Result<_, _>>()?;
    if clips.is_empty() {
        return Err("Als Podcast geht nur mit Clip-Folien; das Deck hat keine.".into());
    }
    let mut srcs: Vec<String> = Vec::new();
    for c in &clips {
        let v = c.video.clone().unwrap_or_default();
        if !srcs.contains(&v) {
            srcs.push(v);
        }
    }
    if srcs.len() > 1 {
        return Err(format!(
            "Als Podcast geht nur mit einer Quelle; das Deck nutzt {} Videos. Erst auf ein Video beschränken.",
            srcs.len()
        ));
    }
    // Vereinigung aller parts
    let keep = norm_cuts(
        &clips
            .iter()
            .flat_map(|c| {
                c.parts.iter().map(|p| Cut {
                    start: p.start,
                    end: p.end,
                    why: None,
                })
            })
            .collect::<Vec<_>>(),
        duration,
    );
    let mut cuts = Vec::new();
    let mut at = 0.0;
    for k in &keep {
        if k.start > at {
            cuts.push(Cut {
                start: at,
                end: k.start,
                why: Some(CutWhy::Hand),
            });
        }
        at = k.end;
    }
    if at < duration {
        cuts.push(Cut {
            start: at,
            end: duration,
            why: Some(CutWhy::Hand),
        });
    }
    let chapters: Vec<Chapter> = clips
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let p = c.parts.first()?;
            let hook = c.hook.as_deref().map(trim).filter(|h| !h.is_empty());
            Some(Chapter {
                at: p.start,
                title: hook.map_or_else(|| format!("Teil {}", i + 1), str::to_string),
            })
        })
        .collect();
    // Clip-Soundeffekte: at zählt im fertigen Clip, hier in Quellzeit über die parts der Folie
    let sfx: Vec<Sfx> = clips
        .iter()
        .flat_map(|c| {
            c.sfx.iter().flatten().filter_map(|f| {
                let mut t = f.at;
                for p in &c.parts {
                    if t < p.end - p.start {
                        return Some(Sfx {
                            at: p.start + t,
                            ..f.clone()
                        });
                    }
                    t -= p.end - p.start;
                }
                None
            })
        })
        .collect();
    let ton = if clips.iter().any(|c| c.ton.as_deref() == Some("klar")) {
        PodTon::Klar
    } else {
        PodTon::Original
    };
    Ok(Episode {
        duration,
        tracks: vec![PodTrack {
            src: srcs.remove(0),
            ..Default::default()
        }],
        cuts,
        chapters: Some(chapters),
        sfx: (!sfx.is_empty()).then_some(sfx),
        ton: Some(ton),
        ..Default::default()
    })
}

/// Eine Zeile für Tool-Antworten und UI
pub fn episode_summary(ep: &Episode) -> String {
    let cuts = norm_cuts(&ep.cuts, ep.duration);
    let len = edited_length(&cuts, ep.duration);
    let n = |k: usize, one: &str, many: &str| format!("{k} {}", if k == 1 { one } else { many });
    let by_why = |w: CutWhy| {
        cuts.iter()
            .filter(|c| c.why.unwrap_or(CutWhy::Hand) == w)
            .count()
    };
    let kinds: Vec<String> = [
        (CutWhy::Pause, "Pause", "Pausen"),
        (CutWhy::Fuell, "Füllwort", "Füllwörter"),
        (CutWhy::Versprecher, "Versprecher", "Versprecher"),
        (CutWhy::Hand, "von Hand", "von Hand"),
    ]
    .iter()
    .map(|&(w, one, many)| (by_why(w), one, many))
    .filter(|x| x.0 > 0)
    .map(|(k, one, many)| n(k, one, many))
    .collect();
    let jingles: Vec<&str> = [
        ep.intro
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|_| "Intro"),
        ep.outro
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|_| "Outro"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut parts = vec![
        format!(
            "Länge {} → {} (−{})",
            clock(ep.duration),
            clock(len),
            clock(ep.duration - len)
        ),
        if cuts.is_empty() {
            "keine Schnitte".into()
        } else {
            format!(
                "{}: {}",
                n(cuts.len(), "Schnitt", "Schnitte"),
                kinds.join(", ")
            )
        },
        n(ep.tracks.len(), "Spur", "Spuren"),
    ];
    if let Some(k) = ep.chapters.as_ref().map(Vec::len).filter(|&k| k > 0) {
        parts.push(n(k, "Kapitel", "Kapitel"));
    }
    if let Some(k) = ep.sfx.as_ref().map(Vec::len).filter(|&k| k > 0) {
        parts.push(n(k, "Soundeffekt", "Soundeffekte"));
    }
    if !jingles.is_empty() {
        parts.push(jingles.join(", "));
    }
    parts.join(" · ")
}
