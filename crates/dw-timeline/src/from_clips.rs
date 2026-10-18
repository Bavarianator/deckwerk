//! Clip-Folien (Layout clip) in eine Timeline umwandeln (`shared/timeline-from-clips.ts`): alle Ausschnitte hintereinander auf V1,
//! Text-Einblendungen auf Timeline-Zeit. `dropped` nennt, was die Timeline nicht abbildet.

use crate::grade::preset;
use crate::model::*;
use dw_lint::video::{ClipContent, Overlay, Part, clip_spans};

fn truthy_s(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|s| !s.is_empty())
}
fn truthy_n(x: Option<f64>) -> bool {
    x.is_some_and(|v| v != 0.0 && !v.is_nan())
}
fn is_media(o: &Overlay) -> bool {
    truthy_s(&o.image) || truthy_s(&o.video) || truthy_n(o.slide)
}

pub struct FromClips {
    pub tl: TimelineContent,
    pub dropped: Vec<String>,
}

pub fn from_clips(contents: &[ClipContent], fps: f64) -> FromClips {
    let mut dropped: Vec<String> = Vec::new();
    let mut drop = |s: &str| {
        if !dropped.iter().any(|d| d == s) {
            dropped.push(s.into());
        }
    };
    let mut clips: Vec<TlClip> = Vec::new();
    let mut overlays: Vec<Overlay> = Vec::new();
    let mut cum = 0.0;
    for c in contents {
        let look = c.look.as_deref().filter(|l| !l.is_empty());
        let grade = look
            .filter(|&l| l != "auto" && l != "neutral")
            .and_then(preset);
        if look == Some("auto") {
            drop("Farblook auto (automatische Korrektur)");
        }
        if truthy_s(&c.hook) {
            drop("Hook-Zeile");
        }
        if c.pauses.as_deref() == Some("kurz") {
            drop("Pausen kürzen");
        }
        if c.ton.as_deref() == Some("klar") {
            drop("Tonaufbereitung klar");
        }
        if truthy_s(&c.follow) {
            drop("Sprecher folgen");
        }
        if c.style.as_deref() == Some("lebendig") {
            drop("Stil lebendig");
        }
        if c.stabil == Some(true) {
            drop("Stabilisieren");
        }
        if truthy_s(&c.caption_pos) {
            drop("Lage der Untertitel");
        }
        if c.cover.is_some() || truthy_s(&c.post) {
            drop("Titelbild und Post-Text");
        }
        let mut ats = Vec::new();
        for p in &c.parts {
            if truthy_n(p.freeze) {
                drop("Standbilder (freeze)");
            }
            if p.zoom.is_some_and(|z| z != 1.0 && z != 0.0 && !z.is_nan()) {
                drop("Punch-in (zoom)");
            }
            if truthy_s(&p.transition) {
                drop("Übergänge an Schnitten");
            }
            if p.music.is_some() {
                drop("Musikpegel je Ausschnitt");
            }
            if p.track.is_some() {
                drop("Kamerafahrt (track)");
            }
            // ceil statt round: ein abgerundetes at würde den Vorgänger überlappen
            let at = 0f64.max((cum * fps - 1e-6).ceil() / fps);
            ats.push(at);
            let mut clip = TlClip {
                id: format!("c{}", clips.len() + 1),
                src: c.video.clone().unwrap_or_default(),
                at,
                in_: p.start,
                out: p.end,
                ..Default::default()
            };
            if let Some(sp) = p.speed
                && sp != 1.0
            {
                clip.speed = Some(sp);
            }
            clip.volume = p.volume;
            clip.focus = p.focus;
            if truthy_s(&c.fit) {
                clip.fit = Some(if c.fit.as_deref() == Some("blur") {
                    Fit::Contain
                } else {
                    Fit::Crop
                });
            }
            clip.grade = grade.clone();
            cum = at + (p.end - p.start) / clip.speed.unwrap_or(1.0);
            clips.push(clip);
        }
        for o in c.overlays.iter().flatten() {
            if is_media(o) {
                drop("Bild-, Video- und Folien-Einblendungen (als Clips auf V2+ anlegen)");
                continue;
            }
            let text = Overlay {
                image: None,
                video: None,
                from: None,
                slide: None,
                ..o.clone()
            };
            // je part einzeln, damit die tatsächliche Lage at gilt; aneinanderstoßende Stücke verbinden
            let mut spans: Vec<[f64; 2]> = Vec::new();
            for (i, p) in c.parts.iter().enumerate() {
                let part = Part {
                    start: p.start,
                    end: p.end,
                    speed: p.speed,
                    ..Default::default()
                };
                for [x, y] in clip_spans([&part], o.start, o.end) {
                    match spans.last_mut() {
                        Some(l) if ats[i] + x - l[1] < 1.5 / fps => l[1] = ats[i] + y,
                        _ => spans.push([ats[i] + x, ats[i] + y]),
                    }
                }
            }
            for [x, y] in spans {
                let (start, end) = (snap_frame(x, fps), snap_frame(y, fps));
                if end > start + 0.3 {
                    overlays.push(Overlay {
                        start,
                        end,
                        ..text.clone()
                    });
                } else {
                    drop("zu kurze Stücke von Einblendungen");
                }
            }
        }
    }
    let mut tl = TimelineContent {
        tracks: vec![TlTrack {
            id: "v1".into(),
            kind: Kind::Video,
            clips,
            mute: None,
            hide: None,
            volume: None,
        }],
        ..Default::default()
    };
    if !overlays.is_empty() {
        tl.overlays = Some(overlays);
    }
    if let Some(c) = contents
        .first()
        .and_then(|c| c.captions.clone())
        .filter(|c| !c.is_empty())
    {
        tl.captions = Some(c);
    }
    FromClips { tl, dropped }
}
