//! Datenmodell und Zeitrechnung der Pro-Timeline (`shared/timeline.ts`, Datenteil von `layouts-timeline.ts`).
//! Timeline-Zeit = Lage auf der Zeitachse (`at`), Quellzeit = Sekunde im Quellvideo (`in`/`out`, `keys`). Zeiten in Sekunden.

use dw_lint::js::{num, round, to_fixed};
use dw_lint::video::Overlay;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

pub type Rgb = [f64; 3];

/// Farbe: lift −0,5..0,5, gamma 0,5..2, gain 0,5..2 je Kanal; sat 0..2; temp −1 (kühl) .. 1 (warm). Fehlt ein Feld = neutral.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Grade {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lift: Option<Rgb>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gamma: Option<Rgb>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain: Option<Rgb>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sat: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temp: Option<f64>,
}

/// EQ in dB bei 100 Hz (Kuhschwanz), 1 kHz (Glocke), 8 kHz (Kuhschwanz)
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Eq {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub low: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mid: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub high: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fit {
    Crop,
    Contain,
}

/// Clip auf einer Spur: Quelle `src` von `in` bis `out` (Quellsekunden) ab `at`, Länge (out−in)/speed. Felder wie `TLClip`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TlClip {
    // default: add_clip darf ohne ID kommen
    #[serde(default)]
    pub id: String,
    pub src: String,
    pub at: f64,
    #[serde(rename = "in")]
    pub in_: f64,
    pub out: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    /// Pegel-Stützpunkte [Quellsekunde, dB]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<[f64; 2]>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eq: Option<Eq>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grade: Option<Grade>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mute: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<Fit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focus: Option<f64>,
    /// Bild-in-Bild [x, y, w] als Anteile des Bildes
    #[serde(default, rename = "box", skip_serializing_if = "Option::is_none")]
    pub box_: Option<[f64; 3]>,
    /// [Einblenden, Ausblenden] in s
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xfade: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Video,
    Audio,
}

/// Spuren von unten nach oben: höhere Videospuren liegen über tieferen
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TlTrack {
    pub id: String,
    pub kind: Kind,
    pub clips: Vec<TlClip>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mute: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sub {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub t: f64,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Codec {
    #[serde(rename = "h264")]
    H264,
    #[serde(rename = "h264-10")]
    H264_10,
    #[serde(rename = "prores")]
    Prores,
    #[serde(rename = "dnxhr")]
    Dnxhr,
}

impl Codec {
    pub fn name(self) -> &'static str {
        match self {
            Codec::H264 => "h264",
            Codec::H264_10 => "h264-10",
            Codec::Prores => "prores",
            Codec::Dnxhr => "dnxhr",
        }
    }
}

pub const RESOLUTIONS: [f64; 4] = [720.0, 1080.0, 1440.0, 2160.0];

/// Ausgabe: res = kurze Seite in px, fps frei, lufs Lautheitsziel
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Deliver {
    pub res: f64,
    pub fps: f64,
    pub codec: Codec,
    pub lufs: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DeliverOpt {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub res: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec: Option<Codec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lufs: Option<f64>,
}

/// Inhalt des Layouts timeline (deck.json)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TimelineContent {
    pub tracks: Vec<TlTrack>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overlays: Option<Vec<Overlay>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subs: Option<Vec<Sub>>,
    /// wort | satz | aus
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub captions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub markers: Option<Vec<Marker>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deliver: Option<DeliverOpt>,
}

pub const DELIVER: Deliver = Deliver {
    res: 1080.0,
    fps: 30.0,
    codec: Codec::H264,
    lufs: -14.0,
};

/// Grenzen wie `TL` in timeline.ts
pub struct Range {
    pub min: f64,
    pub max: f64,
}
pub const SPEED: Range = Range {
    min: 0.25,
    max: 4.0,
};
pub const VOLUME: Range = Range { min: 0.0, max: 2.0 };
pub const DB: Range = Range {
    min: -60.0,
    max: 12.0,
};
pub const EQ: Range = Range {
    min: -12.0,
    max: 12.0,
};
pub const LIFT: Range = Range {
    min: -0.5,
    max: 0.5,
};
pub const GAMMA: Range = Range { min: 0.5, max: 2.0 };
pub const GAIN: Range = Range { min: 0.5, max: 2.0 };
pub const SAT: Range = Range { min: 0.0, max: 2.0 };
pub const TEMP: Range = Range {
    min: -1.0,
    max: 1.0,
};
pub const LUFS: Range = Range {
    min: -30.0,
    max: -9.0,
};
pub const FADE: Range = Range {
    min: 0.0,
    max: 10.0,
};
pub const XFADE: Range = Range { min: 0.0, max: 5.0 };
pub const FPS: Range = Range {
    min: 10.0,
    max: 120.0,
};
pub const MIN_LEN: f64 = 1.0 / 30.0;
pub const MAX_TRACKS: usize = 12;
pub const MAX_CLIPS: usize = 400;
pub const EQ_HZ: [f64; 3] = [100.0, 1000.0, 8000.0];

/// `Math.min(hi, Math.max(lo, v))`
pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    hi.min(lo.max(v))
}

/// `(a, b) => a - b` als Vergleich (NaN = gleich), für stabile Sortierung wie `Array.sort`
pub(crate) fn by(d: f64) -> Ordering {
    d.partial_cmp(&0.0).unwrap_or(Ordering::Equal)
}

pub fn speed_of(c: &TlClip) -> f64 {
    clamp(c.speed.unwrap_or(1.0), SPEED.min, SPEED.max)
}
/// Länge eines Clips auf der Zeitachse (s)
pub fn clip_len(c: &TlClip) -> f64 {
    0f64.max(c.out - c.in_) / speed_of(c)
}
pub fn clip_end(c: &TlClip) -> f64 {
    c.at + clip_len(c)
}
/// Ende des spätesten Clips
pub fn tl_duration(tracks: &[TlTrack]) -> f64 {
    tracks.iter().fold(0.0, |m, t| {
        t.clips.iter().fold(m, |n, c| n.max(clip_end(c)))
    })
}
/// Quellsekunde zur Timeline-Zeit t (nicht geklemmt)
pub fn src_at(c: &TlClip, t: f64) -> f64 {
    c.in_ + (t - c.at) * speed_of(c)
}
/// Timeline-Zeit zur Quellsekunde s
pub fn tl_at(c: &TlClip, s: f64) -> f64 {
    c.at + (s - c.in_) / speed_of(c)
}
pub fn deliver_of(tl: &TimelineContent) -> Deliver {
    let d = tl.deliver.clone().unwrap_or_default();
    Deliver {
        res: d.res.unwrap_or(DELIVER.res),
        fps: d.fps.unwrap_or(DELIVER.fps),
        codec: d.codec.unwrap_or(DELIVER.codec),
        lufs: d.lufs.unwrap_or(DELIVER.lufs),
    }
}

/// Auf das nächste Bild runden, damit Schnitte in Vorschau, Export und XML auf denselben Frame fallen
pub fn snap_frame(t: f64, fps: f64) -> f64 {
    round(t * fps) / fps
}

/// `+x.toFixed(d)` als Zahl
pub(crate) fn fixed(x: f64, d: usize) -> f64 {
    to_fixed(x, d).parse().unwrap_or(f64::NAN)
}

/// Bildrate als ffmpeg-Argument: NTSC-Raten exakt als N*1000/1001
pub fn fps_arg(fps: f64) -> String {
    let n = round(fps);
    if (fps - (n * 1000.0) / 1001.0).abs() < 0.005 && (fps - n).abs() > 0.005 {
        format!("{}/1001", num(n * 1000.0))
    } else {
        num(fixed(fps, 3))
    }
}

/// Aktiver Clip einer Spur: index = Spurnummer, src = Quellsekunde
#[derive(Debug, Clone, Copy)]
pub struct Active<'a> {
    pub track: &'a TlTrack,
    pub clip: &'a TlClip,
    pub index: usize,
    pub src: f64,
}

/// Sichtbare/hörbare Clips zur Zeit t, von unten nach oben; ausgeblendete bzw. stumme Spuren fallen weg
pub fn active_at(tl: &TimelineContent, t: f64, kind: Option<Kind>) -> Vec<Active<'_>> {
    let mut out = Vec::new();
    for (index, track) in tl.tracks.iter().enumerate() {
        if kind.is_some_and(|k| k != track.kind) {
            continue;
        }
        let off = if track.kind == Kind::Video {
            track.hide
        } else {
            track.mute
        };
        if off == Some(true) {
            continue;
        }
        // Toleranz: Gleitkomma-Reste an Schnitten zeigen sonst den Vorgänger
        if let Some(clip) = track
            .clips
            .iter()
            .rev()
            .find(|c| t >= c.at - 1e-6 && t < clip_end(c) - 1e-6)
        {
            out.push(Active {
                track,
                clip,
                index,
                src: src_at(clip, t),
            });
        }
    }
    out
}

/// Sortieren und Dubletten weg (`[...new Set(xs)].sort((a, b) => a - b)`)
pub(crate) fn uniq_sorted(mut xs: Vec<f64>) -> Vec<f64> {
    xs.sort_by(|a, b| by(a - b));
    xs.dedup_by(|a, b| a == b);
    xs
}

/// Alle Schnittpunkte samt 0 und Ende, auf 1e-4 gerundet, sortiert, ohne Dubletten
pub fn cut_points(tracks: &[TlTrack]) -> Vec<f64> {
    let mut ts = vec![0.0, tl_duration(tracks)];
    for t in tracks {
        for c in &t.clips {
            ts.push(c.at);
            ts.push(clip_end(c));
        }
    }
    uniq_sorted(ts.into_iter().map(|x| round(x * 1e4) / 1e4).collect())
}

/// Neue, in der Timeline eindeutige ID mit Präfix (c = Clip, v/a = Spur)
pub fn new_id(tracks: &[TlTrack], prefix: &str) -> String {
    let used: std::collections::HashSet<&str> = tracks
        .iter()
        .flat_map(|t| std::iter::once(t.id.as_str()).chain(t.clips.iter().map(|c| c.id.as_str())))
        .collect();
    (1..)
        .map(|i| format!("{prefix}{i}"))
        .find(|id| !used.contains(id.as_str()))
        .unwrap()
}

/// Faktor 0..1 aus fade zur Timeline-Zeit t
pub fn fade_gain(c: &TlClip, t: f64) -> f64 {
    let [fi, fo] = c.fade.unwrap_or([0.0, 0.0]);
    let end = clip_end(c);
    let a = if fi > 0.0 { (t - c.at) / fi } else { 1.0 };
    let b = if fo > 0.0 { (end - t) / fo } else { 1.0 };
    0f64.max(1f64.min(a).min(b))
}

/// Überblendung: from läuft bis b weiter, to beginnt schon bei a
#[derive(Debug, Clone, Copy)]
pub struct XFade<'a> {
    pub from: &'a TlClip,
    pub to: &'a TlClip,
    pub a: f64,
    pub b: f64,
}
const XF_GAP: f64 = 1e-3;

/// Clips nach at sortiert (stabil), als Referenzen
pub(crate) fn sorted_refs(clips: &[TlClip]) -> Vec<&TlClip> {
    let mut cs: Vec<&TlClip> = clips.iter().collect();
    cs.sort_by(|a, b| by(a.at - b.at));
    cs
}

/// Alle Überblendungen einer Spur; Länge höchstens die halbe Länge beider Clips
pub fn xfades(clips: &[TlClip]) -> Vec<XFade<'_>> {
    xfades_of(&sorted_refs(clips))
}
pub(crate) fn xfades_of<'a>(cs: &[&'a TlClip]) -> Vec<XFade<'a>> {
    let mut out = Vec::new();
    for i in 1..cs.len() {
        let (to, from) = (cs[i], cs[i - 1]);
        let xf = to.xfade.unwrap_or(0.0);
        if !(xf > 0.0) || (clip_end(from) - to.at).abs() > XF_GAP {
            continue;
        }
        let d = xf.min(XFADE.max).min(clip_len(from)).min(clip_len(to));
        out.push(XFade {
            from,
            to,
            a: to.at - d / 2.0,
            b: to.at + d / 2.0,
        });
    }
    out
}
/// Überblendung der Spur zur Zeit t und Fortschritt k (0 = nur from, 1 = nur to)
pub fn xfade_at(clips: &[TlClip], t: f64) -> Option<(XFade<'_>, f64)> {
    xfades(clips)
        .into_iter()
        .find(|x| t >= x.a && t < x.b)
        .map(|x| (x, (t - x.a) / (x.b - x.a)))
}

/// Prüfung wie `timelineSchema` (layouts-timeline.ts): Grenzen, Überlappung je Spur, doppelte Clip-IDs. Erste Verletzung als Text.
pub fn validate(tl: &TimelineContent) -> Result<(), String> {
    let within = |v: f64, r: &Range, what: &str| {
        if v >= r.min && v <= r.max {
            Ok(())
        } else {
            Err(format!(
                "{what} {} außerhalb {}..{}",
                num(v),
                num(r.min),
                num(r.max)
            ))
        }
    };
    if tl.tracks.is_empty() || tl.tracks.len() > MAX_TRACKS {
        return Err(format!("1 bis {MAX_TRACKS} Spuren"));
    }
    let mut seen = std::collections::HashSet::new();
    for tr in &tl.tracks {
        if tr.id.is_empty() {
            return Err("Spur ohne ID".into());
        }
        if tr.clips.len() > MAX_CLIPS {
            return Err(format!("Spur {}: höchstens {MAX_CLIPS} Clips", tr.id));
        }
        if let Some(v) = tr.volume {
            within(v, &VOLUME, "volume")?;
        }
        for c in &tr.clips {
            if c.id.is_empty() {
                return Err("Clip ohne ID".into());
            }
            for (v, w) in [(c.at, "at"), (c.in_, "in"), (c.out, "out")] {
                if !(v >= 0.0) {
                    return Err(format!("Clip {}: {w} negativ", c.id));
                }
            }
            if !(c.out >= c.in_ + MIN_LEN) {
                return Err("out muss nach in liegen".into());
            }
            let opt = |v: Option<f64>, r: &Range, w: &str| v.map_or(Ok(()), |v| within(v, r, w));
            opt(c.speed, &SPEED, "speed")?;
            opt(c.volume, &VOLUME, "volume")?;
            opt(c.xfade, &XFADE, "xfade")?;
            opt(c.focus, &Range { min: 0.0, max: 1.0 }, "focus")?;
            for k in c.keys.iter().flatten() {
                within(
                    k[0],
                    &Range {
                        min: 0.0,
                        max: f64::INFINITY,
                    },
                    "key",
                )?;
                within(k[1], &DB, "dB")?;
            }
            if c.keys.as_ref().is_some_and(|k| k.len() > 100) {
                return Err(format!("Clip {}: höchstens 100 Pegel-Keys", c.id));
            }
            if let Some(e) = &c.eq {
                for v in [e.low, e.mid, e.high] {
                    opt(v, &EQ, "eq")?;
                }
            }
            if let Some(g) = &c.grade {
                for (v, r, w) in [
                    (g.lift, &LIFT, "lift"),
                    (g.gamma, &GAMMA, "gamma"),
                    (g.gain, &GAIN, "gain"),
                ] {
                    for x in v.iter().flatten() {
                        within(*x, r, w)?;
                    }
                }
                opt(g.sat, &SAT, "sat")?;
                opt(g.temp, &TEMP, "temp")?;
            }
            if let Some([x, y, w]) = c.box_ {
                within(x, &Range { min: 0.0, max: 1.0 }, "box")?;
                within(y, &Range { min: 0.0, max: 1.0 }, "box")?;
                within(
                    w,
                    &Range {
                        min: 0.05,
                        max: 1.0,
                    },
                    "box",
                )?;
            }
            for v in c.fade.iter().flatten() {
                within(*v, &FADE, "fade")?;
            }
            if !seen.insert(c.id.as_str()) {
                return Err(format!("Clip-ID {} doppelt", c.id));
            }
        }
        let cs = sorted_refs(&tr.clips);
        for w in cs.windows(2) {
            if clip_end(w[0]) > w[1].at + 1e-3 {
                return Err(format!("Spur {}: {} überlappt {}", tr.id, w[0].id, w[1].id));
            }
        }
    }
    for o in tl.overlays.iter().flatten() {
        if !(o.end > o.start + 0.3) {
            return Err("end muss nach start liegen".into());
        }
        let art = o.art.as_deref();
        let ok = match art {
            Some("verpixeln" | "markierung") => o.box_.is_some(),
            Some("liste") => o.items.is_some(),
            _ => o.text.is_some(),
        };
        if !ok {
            return Err("verpixeln/markierung brauchen box, liste items, sonst text".into());
        }
    }
    if let Some(d) = &tl.deliver {
        if let Some(r) = d.res
            && !RESOLUTIONS.contains(&r)
        {
            return Err(format!("res {} nicht erlaubt", num(r)));
        }
        if let Some(f) = d.fps {
            within(f, &FPS, "fps")?;
        }
        if let Some(l) = d.lufs {
            within(l, &LUFS, "lufs")?;
        }
    }
    if let Some(c) = tl.captions.as_deref()
        && !["wort", "satz", "aus"].contains(&c)
    {
        return Err(format!("captions {c} unbekannt"));
    }
    Ok(())
}
