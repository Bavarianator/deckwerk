//! Schnitt-Operationen auf der Pro-Timeline (`shared/timeline-edit.ts`): rein, die Eingabe bleibt unverändert.
//! Zeiten sind Timeline-Sekunden und werden auf Bilder (fps) gerundet; Fehler als deutsche Meldung.

use crate::model::*;
use dw_lint::js::num;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

const EPS: f64 = 1e-6;
pub type EditResult = Result<TimelineContent, String>;

fn locate(tl: &TimelineContent, clip_id: &str) -> Result<(usize, usize), String> {
    for (ti, t) in tl.tracks.iter().enumerate() {
        if let Some(ci) = t.clips.iter().position(|c| c.id == clip_id) {
            return Ok((ti, ci));
        }
    }
    Err(format!("Clip {clip_id} nicht gefunden"))
}
fn track_of(tl: &TimelineContent, track_id: &str) -> Result<usize, String> {
    tl.tracks
        .iter()
        .position(|t| t.id == track_id)
        .ok_or_else(|| format!("Spur {track_id} nicht gefunden"))
}
/// Stabil nach at sortieren; Ergebnis: alte Indizes in neuer Reihenfolge
fn sort_clips(t: &mut TlTrack) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..t.clips.len()).collect();
    idx.sort_by(|&a, &b| by(t.clips[a].at - t.clips[b].at));
    let old = std::mem::take(&mut t.clips);
    t.clips = idx.iter().map(|&i| old[i].clone()).collect();
    idx
}
fn assert_free(track: &TlTrack, c: &TlClip) -> Result<(), String> {
    match track
        .clips
        .iter()
        .find(|o| o.id != c.id && c.at < clip_end(o) - EPS && o.at < clip_end(c) - EPS)
    {
        Some(hit) => Err(format!(
            "Clip {} überlappt {} auf Spur {}",
            c.id, hit.id, track.id
        )),
        None => Ok(()),
    }
}
// Clips derselben Spur ab Zeit from um d verschieben (ripple)
fn shift_from(track: &mut TlTrack, from: f64, d: f64, fps: f64, except: Option<&str>) {
    for c in &mut track.clips {
        if Some(c.id.as_str()) != except && c.at >= from - EPS {
            c.at = snap_frame(0f64.max(c.at + d), fps);
        }
    }
}

/// Teilt den Clip an Timeline-Zeit t; der zweite Teil bekommt eine neue ID, Pegel-Keys bleiben in ihrem Quellbereich
pub fn split(tl: &TimelineContent, clip_id: &str, t: f64, fps: f64) -> EditResult {
    let mut out = tl.clone();
    let (ti, ci) = locate(&out, clip_id)?;
    let t = snap_frame(t, fps);
    let id = new_id(&out.tracks, "c");
    let clip = &mut out.tracks[ti].clips[ci];
    if t < clip.at + MIN_LEN - EPS || t > clip_end(clip) - MIN_LEN + EPS {
        return Err(format!(
            "Schnitt bei {}s liegt nicht innerhalb von Clip {clip_id}",
            num(t)
        ));
    }
    let s = src_at(clip, t);
    let mut b = TlClip {
        id,
        at: t,
        in_: s,
        ..clip.clone()
    };
    clip.out = s;
    // Einblenden und Überblendung bleiben vorn, Ausblenden hinten
    b.xfade = None;
    if let Some([fi, fo]) = clip.fade {
        b.fade = Some([0.0, fo]);
        clip.fade = Some([fi, 0.0]);
    }
    if let Some(keys) = &clip.keys {
        b.keys = Some(keys.iter().filter(|k| k[0] >= s).copied().collect());
        clip.keys = Some(keys.iter().filter(|k| k[0] <= s).copied().collect());
    }
    out.tracks[ti].clips.insert(ci + 1, b);
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    In,
    Out,
}

/// Zieht die In- oder Out-Kante auf t. Ohne ripple am Nachbarn und an Quellsekunde 0 geklemmt;
/// mit ripple bleibt der Anfang stehen und spätere Clips derselben Spur rücken mit
pub fn trim(
    tl: &TimelineContent,
    clip_id: &str,
    edge: Edge,
    t: f64,
    ripple: bool,
    fps: f64,
) -> EditResult {
    let mut out = tl.clone();
    let (ti, ci) = locate(&out, clip_id)?;
    let track = &mut out.tracks[ti];
    let order = sort_clips(track);
    let i = order.iter().position(|&o| o == ci).unwrap();
    let prev_end = i.checked_sub(1).map(|p| clip_end(&track.clips[p]));
    let next_at = track.clips.get(i + 1).map(|n| n.at);
    let clip = &mut track.clips[i];
    let (old_end, old_len) = (clip_end(clip), clip_len(clip));
    let mut t = snap_frame(t, fps);
    match edge {
        Edge::In => {
            let lo = ((tl_at(clip, 0.0) * fps - 1e-6).ceil() / fps).max(match prev_end {
                Some(e) if !ripple => e,
                _ => f64::NEG_INFINITY,
            });
            t = t.max(lo).min(old_end - MIN_LEN);
            clip.in_ = 0f64.max(src_at(clip, t));
            if !ripple {
                clip.at = t;
            }
        }
        Edge::Out => {
            t = t.max(clip.at + MIN_LEN);
            if let Some(n) = next_at
                && !ripple
            {
                t = t.min(n);
            }
            clip.out = src_at(clip, t);
        }
    }
    if ripple {
        let (d, id) = (clip_len(clip) - old_len, clip.id.clone());
        shift_from(track, old_end, d, fps, Some(&id));
    }
    Ok(out)
}

/// Verschiebt den Clip auf at (≥ 0), wahlweise auf eine andere Spur gleicher Art; Fehler bei Überlappung
pub fn move_clip(
    tl: &TimelineContent,
    clip_id: &str,
    at: f64,
    track_id: Option<&str>,
    fps: f64,
) -> EditResult {
    if at < 0.0 {
        return Err("Startzeit darf nicht negativ sein".into());
    }
    let mut out = tl.clone();
    let (ti, ci) = locate(&out, clip_id)?;
    let di = match track_id {
        Some(id) => track_of(&out, id)?,
        None => ti,
    };
    let dest = &out.tracks[di];
    if dest.kind != out.tracks[ti].kind {
        let k = if dest.kind == Kind::Video {
            "Videospur"
        } else {
            "Audiospur"
        };
        return Err(format!("Clip {clip_id} passt nicht auf {k} {}", dest.id));
    }
    out.tracks[ti].clips[ci].at = snap_frame(at, fps);
    assert_free(&out.tracks[di], &out.tracks[ti].clips[ci])?;
    if di != ti {
        let c = out.tracks[ti].clips.remove(ci);
        out.tracks[di].clips.push(c);
    }
    sort_clips(&mut out.tracks[di]);
    Ok(out)
}

fn remove(tl: &TimelineContent, clip_id: &str, ripple: bool, fps: f64) -> EditResult {
    let mut out = tl.clone();
    let (ti, ci) = locate(&out, clip_id)?;
    let c = out.tracks[ti].clips.remove(ci);
    if ripple {
        shift_from(&mut out.tracks[ti], clip_end(&c), -clip_len(&c), fps, None);
    }
    Ok(out)
}
/// Entfernt den Clip, die Lücke bleibt
pub fn lift(tl: &TimelineContent, clip_id: &str, fps: f64) -> EditResult {
    remove(tl, clip_id, false, fps)
}
/// Entfernt den Clip, spätere Clips derselben Spur rücken nach
pub fn ripple_delete(tl: &TimelineContent, clip_id: &str, fps: f64) -> EditResult {
    remove(tl, clip_id, true, fps)
}

/// Legt den Clip auf die Spur; leere oder vergebene ID → neue
pub fn add_clip(tl: &TimelineContent, track_id: &str, clip: &TlClip, fps: f64) -> EditResult {
    let mut out = tl.clone();
    let ti = track_of(&out, track_id)?;
    let taken = !clip.id.is_empty()
        && out
            .tracks
            .iter()
            .any(|t| t.id == clip.id || t.clips.iter().any(|c| c.id == clip.id));
    let id = if !clip.id.is_empty() && !taken {
        clip.id.clone()
    } else {
        new_id(&out.tracks, "c")
    };
    let c = TlClip {
        id,
        at: snap_frame(0f64.max(clip.at), fps),
        ..clip.clone()
    };
    assert_free(&out.tracks[ti], &c)?;
    out.tracks[ti].clips.push(c);
    sort_clips(&mut out.tracks[ti]);
    Ok(out)
}

/// Neue leere Spur ganz oben (am Ende)
pub fn add_track(tl: &TimelineContent, kind: Kind) -> EditResult {
    if tl.tracks.len() >= MAX_TRACKS {
        return Err(format!("Höchstens {MAX_TRACKS} Spuren"));
    }
    let mut out = tl.clone();
    let id = new_id(&out.tracks, if kind == Kind::Video { "v" } else { "a" });
    out.tracks.push(TlTrack {
        id,
        kind,
        clips: vec![],
        mute: None,
        hide: None,
        volume: None,
    });
    Ok(out)
}

/// Felder des Clips überschreiben (wie `Object.assign`), id bleibt
pub fn set_clip(
    tl: &TimelineContent,
    clip_id: &str,
    patch: &Map<String, Value>,
    fps: f64,
) -> EditResult {
    let mut out = tl.clone();
    let (ti, ci) = locate(&out, clip_id)?;
    let mut v = serde_json::to_value(&out.tracks[ti].clips[ci]).map_err(|e| e.to_string())?;
    let m = v.as_object_mut().unwrap();
    for (k, x) in patch {
        m.insert(k.clone(), x.clone());
    }
    m.insert("id".into(), Value::String(clip_id.into()));
    let mut clip: TlClip = serde_json::from_value(v).map_err(|e| format!("Clip {clip_id}: {e}"))?;
    if let Some(at) = patch.get("at").and_then(Value::as_f64) {
        if at < 0.0 {
            return Err("Startzeit darf nicht negativ sein".into());
        }
        clip.at = snap_frame(at, fps);
    }
    // Befund K16 (§7.2): TS prüfte out > in erst im Schema; hier gleich, damit kein ungültiger Clip entsteht
    if !(clip.out >= clip.in_ + MIN_LEN) {
        return Err(format!("Clip {clip_id}: out muss nach in liegen"));
    }
    out.tracks[ti].clips[ci] = clip;
    assert_free(&out.tracks[ti], &out.tracks[ti].clips[ci])?;
    sort_clips(&mut out.tracks[ti]);
    Ok(out)
}

/// Einrastziele: alle Clip-Kanten (außer vom gezogenen Clip), Marker und extra, sortiert
pub fn snap_targets(tl: &TimelineContent, except_clip_id: Option<&str>, extra: &[f64]) -> Vec<f64> {
    let mut ts: Vec<f64> = extra.to_vec();
    ts.extend(tl.markers.iter().flatten().map(|m| m.t));
    for t in &tl.tracks {
        for c in &t.clips {
            if Some(c.id.as_str()) != except_clip_id {
                ts.push(c.at);
                ts.push(clip_end(c));
            }
        }
    }
    uniq_sorted(ts)
}
/// Nächstes Ziel innerhalb von tol, sonst t
pub fn snap(t: f64, targets: &[f64], tol: f64) -> f64 {
    let (mut best, mut d) = (t, tol);
    for &x in targets {
        if (x - t).abs() <= d {
            best = x;
            d = (x - t).abs();
        }
    }
    best
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum TlOp {
    Split {
        clip: String,
        t: f64,
    },
    Trim {
        clip: String,
        edge: Edge,
        t: f64,
        #[serde(default)]
        ripple: Option<bool>,
    },
    Move {
        clip: String,
        at: f64,
        #[serde(default)]
        track: Option<String>,
    },
    Lift {
        clip: String,
    },
    RippleDelete {
        clip: String,
    },
    AddClip {
        track: String,
        clip: Box<TlClip>,
    },
    AddTrack {
        kind: Kind,
    },
    Set {
        clip: String,
        patch: Map<String, Value>,
    },
}

impl TlOp {
    pub fn name(&self) -> &'static str {
        match self {
            TlOp::Split { .. } => "split",
            TlOp::Trim { .. } => "trim",
            TlOp::Move { .. } => "move",
            TlOp::Lift { .. } => "lift",
            TlOp::RippleDelete { .. } => "ripple_delete",
            TlOp::AddClip { .. } => "add_clip",
            TlOp::AddTrack { .. } => "add_track",
            TlOp::Set { .. } => "set",
        }
    }
}

pub fn apply_op(tl: &TimelineContent, o: &TlOp, fps: f64) -> EditResult {
    match o {
        TlOp::Split { clip, t } => split(tl, clip, *t, fps),
        TlOp::Trim {
            clip,
            edge,
            t,
            ripple,
        } => trim(tl, clip, *edge, *t, ripple.unwrap_or(false), fps),
        TlOp::Move { clip, at, track } => move_clip(tl, clip, *at, track.as_deref(), fps),
        TlOp::Lift { clip } => lift(tl, clip, fps),
        TlOp::RippleDelete { clip } => ripple_delete(tl, clip, fps),
        TlOp::AddClip { track, clip } => add_clip(tl, track, clip, fps),
        TlOp::AddTrack { kind } => add_track(tl, *kind),
        TlOp::Set { clip, patch } => set_clip(tl, clip, patch, fps),
    }
}
/// Wendet die Operationen nacheinander an; ein Fehler nennt die Nummer der Op (ab 1)
pub fn apply_ops(tl: &TimelineContent, ops: &[TlOp], fps: f64) -> EditResult {
    let mut cur = tl.clone();
    for (i, o) in ops.iter().enumerate() {
        cur = apply_op(&cur, o, fps).map_err(|e| format!("Op {} ({}): {e}", i + 1, o.name()))?;
    }
    Ok(cur)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Error,
    Warn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TlIssue {
    pub level: Level,
    pub msg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clip: Option<String>,
}

pub fn lint_timeline(tl: &TimelineContent, fps: f64) -> Vec<TlIssue> {
    let mut res = Vec::new();
    let mut push = |level, msg: String, clip: Option<&str>| {
        res.push(TlIssue {
            level,
            msg,
            clip: clip.map(str::to_string),
        })
    };
    let all: Vec<&TlClip> = tl.tracks.iter().flat_map(|t| &t.clips).collect();
    if tl.tracks.len() > MAX_TRACKS {
        push(
            Level::Error,
            format!("{} Spuren, höchstens {MAX_TRACKS}", tl.tracks.len()),
            None,
        );
    }
    if all.len() > MAX_CLIPS {
        push(
            Level::Error,
            format!("{} Clips, höchstens {MAX_CLIPS}", all.len()),
            None,
        );
    }
    let mut seen = std::collections::HashSet::new();
    for id in tl
        .tracks
        .iter()
        .map(|t| &t.id)
        .chain(all.iter().map(|c| &c.id))
    {
        if !seen.insert(id) {
            push(Level::Error, format!("ID {id} doppelt"), Some(id));
        }
    }
    for t in &tl.tracks {
        let cs = sorted_refs(&t.clips);
        for (i, c) in cs.iter().enumerate() {
            let id = Some(c.id.as_str());
            if c.in_ < 0.0 {
                push(
                    Level::Error,
                    format!("Clip {}: in vor Quellsekunde 0", c.id),
                    id,
                );
            }
            if c.out <= c.in_ {
                push(
                    Level::Error,
                    format!("Clip {}: out muss nach in liegen", c.id),
                    id,
                );
            } else if clip_len(c) < 2.0 / fps - EPS {
                push(
                    Level::Warn,
                    format!("Clip {} ist kürzer als 2 Bilder", c.id),
                    id,
                );
            }
            if let Some([a, b]) = c.fade
                && a + b > clip_len(c) + EPS
            {
                push(
                    Level::Warn,
                    format!(
                        "Clip {}: Ein- und Ausblenden sind zusammen länger als der Clip",
                        c.id
                    ),
                    id,
                );
            }
            if let Some(n) = cs.get(i + 1)
                && n.at < clip_end(c) - EPS
            {
                push(
                    Level::Error,
                    format!("Clip {} überlappt {} auf Spur {}", c.id, n.id, t.id),
                    id,
                );
            }
        }
        let xs = xfades_of(&cs);
        for c in &cs {
            if !c.xfade.is_some_and(|x| x != 0.0 && !x.is_nan()) {
                continue;
            }
            let id = Some(c.id.as_str());
            match xs.iter().find(|x| std::ptr::eq(x.to, *c)) {
                None => push(
                    Level::Warn,
                    format!(
                        "Clip {}: Überblendung ohne direkt anschließenden Clip davor, sie fällt weg",
                        c.id
                    ),
                    id,
                ),
                Some(x) => {
                    let need = (c.at - x.a) * speed_of(c);
                    if c.in_ < need - EPS {
                        push(
                            Level::Warn,
                            format!(
                                "Clip {}: vor in fehlen {} s Material für die Überblendung, der Anfang steht kurz still",
                                c.id,
                                num(fixed(need - c.in_, 2))
                            ),
                            id,
                        );
                    }
                }
            }
        }
    }
    match tl.tracks.iter().find(|t| t.kind == Kind::Video) {
        None => push(Level::Warn, "Keine Videospur".into(), None),
        Some(v1) => {
            let mut end = 0f64;
            for c in sorted_refs(&v1.clips) {
                if c.at > end + EPS {
                    push(
                        Level::Warn,
                        format!(
                            "Lücke auf {} von {}s bis {}s (Schwarzbild)",
                            v1.id,
                            num(fixed(end, 3)),
                            num(fixed(c.at, 3))
                        ),
                        Some(&c.id),
                    );
                }
                end = end.max(clip_end(c));
            }
        }
    }
    res
}
