//! ASS-Untertitel des Clip-Exports (`assSubs` in `export-video.ts`): Hook, Untertitel (wort/satz), Fortschrittsbalken,
//! Text-Einblendungen, Lage nach Format.

use crate::cut::{fxv, ov_pos};
use crate::fx::{ArtIn, art_events, hook_box, hook_fade, is_art, pop, progress_bar};
use crate::{Cue, Size, jmin, num, round, trim};
use serde::{Deserialize, Serialize};

/// ASS-Zeit H:MM:SS.cc
pub fn at(s: f64) -> String {
    let cs = crate::jmax(0.0, round(s * 100.0));
    if !cs.is_finite() {
        return "NaN:NaN:NaN.NaN".into();
    }
    let cs = cs as u64;
    format!(
        "{}:{:02}:{:02}.{:02}",
        cs / 360_000,
        (cs / 6000) % 60,
        (cs / 100) % 60,
        cs % 100
    )
}

/// Backslash als Vollbreiten-Zeichen, Klammern per \{ \}, Zeilenumbruch als \N
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\\' => out.push('＼'),
            '{' | '}' => {
                out.push('\\');
                out.push(c)
            }
            '\r' => {
                if it.peek() == Some(&'\n') {
                    it.next();
                }
                out.push_str("\\N")
            }
            '\n' => out.push_str("\\N"),
            _ => out.push(c),
        }
    }
    out
}

// parseInt(x, 16) || 0: führende Hex-Ziffern
fn hex2(s: &str) -> f64 {
    let d: String = s.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    u32::from_str_radix(&d, 16).map_or(0.0, f64::from)
}

/// ASS-Farbe &HBBGGRR&; dunkle Akzente halb Richtung Weiß
pub fn ass_color(hex: &str) -> String {
    let sl = |i: usize| hex.chars().skip(i).take(2).collect::<String>();
    let mut c = [hex2(&sl(1)), hex2(&sl(3)), hex2(&sl(5))];
    if 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] < 110.0 {
        c = c.map(|v| round((v + 255.0) / 2.0));
    }
    format!(
        "&H{:02X}{:02X}{:02X}&",
        c[2] as u32, c[1] as u32, c[0] as u32
    )
}

/// Abstand der Untertitelzeile von unten (MarginV): Querformat 7 %, 9:16 33 %, sonst 12 %
pub fn cap_margin(s: Size) -> f64 {
    s.h * if s.w > s.h {
        0.07
    } else if s.h / s.w >= 1.6 {
        0.33
    } else {
        0.12
    }
}

pub fn ov_align(pos: &str) -> f64 {
    match pos {
        "oben" => 8.0,
        "unten" => 2.0,
        "oben-links" => 7.0,
        "oben-rechts" => 9.0,
        "unten-links" => 1.0,
        "unten-rechts" => 3.0,
        _ => 5.0, // mitte, voll
    }
}

/// Text-Einblendung für assSubs (Zeiten ab Gruppenanfang)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AssOverlay {
    pub start: f64,
    pub end: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pos: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub art: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<String>>,
    #[serde(default, rename = "box", skip_serializing_if = "Option::is_none")]
    pub box_: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub el: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub len: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade: Option<[bool; 2]>,
}

/// Lage der Gruppe in der Szene für den Fortschrittsbalken (s)
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BarPos {
    pub off: f64,
    pub dur: f64,
    pub total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssIn {
    pub size: Size,
    pub font: String,
    pub bold: bool,
    pub accent: String,
    #[serde(default)]
    pub hook: Option<String>,
    pub hook_dur: f64,
    #[serde(default)]
    pub cues: Vec<Cue>,
    /// wort | satz | aus
    pub mode: String,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub bar: Option<BarPos>,
    #[serde(default)]
    pub overlays: Option<Vec<AssOverlay>>,
    #[serde(default)]
    pub caption_pos: Option<String>,
}

/// Untertitel-Datei: Hook oben linksbündig, Untertitel unten mittig, Lage nach Format; style lebendig mit Wort-Pop,
/// Hook-Balken und Fortschrittsbalken
pub fn ass_subs(o: &AssIn) -> String {
    let (w, h) = (o.size.w, o.size.h);
    let m = jmin(w, h);
    let line = crate::jmax(1.0, round(m * 0.002));
    let wide = w > h;
    let wort = o.mode == "wort";
    let live = o.style.as_deref() == Some("lebendig");
    let hook_v = h * if wide { 0.07 } else { 0.12 };
    let cap_v = cap_margin(o.size);
    let style = |name: &str, size: f64, align: f64, margin_v: f64| {
        format!(
            "Style: {name},{},{},&H00FFFFFF,&H00FFFFFF,&H40000000,&H80000000,{},0,0,0,100,100,0,0,1,{},{},{},{},{},{},1",
            o.font,
            num(round(size)),
            if o.bold { -1 } else { 0 },
            num(line),
            num(line),
            num(align),
            num(round(w * 0.08)),
            num(round(w * 0.08)),
            num(round(margin_v))
        )
    };
    let dlg = |start: f64, end: f64, st: &str, text: &str| {
        format!("Dialogue: 0,{},{},{st},,0,0,0,,{text}", at(start), at(end))
    };
    let mut events: Vec<String> = Vec::new();
    let bar = match (live, o.bar) {
        (true, Some(b)) => Some(progress_bar(
            o.size,
            &ass_color(&o.accent),
            b.off,
            b.dur,
            b.total,
            at,
        )),
        _ => None,
    };
    if let Some(b) = &bar {
        events.push(b.event.clone());
    }
    let hook = o.hook.as_deref().map(trim).filter(|s| !s.is_empty());
    if let Some(hk) = hook {
        events.push(if live {
            dlg(0.0, o.hook_dur, "HookBox", &(hook_fade() + &esc(hk)))
        } else {
            dlg(0.0, o.hook_dur, "Hook", &esc(hk))
        });
    }
    if o.mode == "satz" {
        for c in &o.cues {
            let t: Vec<String> = c.words.iter().map(|x| esc(&x.w)).collect();
            events.push(dlg(c.start, c.end, "Cap", &t.join(" ")));
        }
    }
    if wort {
        let accent = ass_color(&o.accent);
        let p = if live { pop() } else { String::new() };
        for c in &o.cues {
            for (k, x) in c.words.iter().enumerate() {
                let text: Vec<String> = c
                    .words
                    .iter()
                    .enumerate()
                    .map(|(j, y)| {
                        if j == k {
                            format!("{{\\c{accent}{p}}}{}{{\\r}}", esc(&y.w))
                        } else {
                            esc(&y.w)
                        }
                    })
                    .collect();
                let start = if k > 0 { x.start } else { c.start };
                let end = c.words.get(k + 1).map_or(c.end, |n| n.start);
                events.push(dlg(start, end, "Cap", &text.join(" ")));
            }
        }
    }
    let ovs: Vec<(&AssOverlay, f64)> = o
        .overlays
        .iter()
        .flatten()
        .map(|x| (x, ov_align(ov_pos(x.art.as_deref(), x.pos.as_deref()))))
        .collect();
    let low = cap_v + m * 0.16;
    let hook_size = m * if wide { 0.045 } else { 0.06 };
    let accent = ass_color(&o.accent);
    for &(x, al) in &ovs {
        let fade = x.fade.unwrap_or([true, true]);
        if let Some(kind) = x.art.as_deref().filter(|a| is_art(Some(a))) {
            let r = art_events(
                &ArtIn {
                    size: o.size,
                    accent: &accent,
                    art: kind,
                    text: x.text.as_deref(),
                    sub: x.sub.as_deref(),
                    items: x.items.as_deref(),
                    r#box: x.box_,
                    el: x.el,
                    len: x.len,
                    al,
                    top: hook_v,
                    low,
                    start: x.start,
                    end: x.end,
                    fade,
                    fade_ms: fxv::HOOK_FADE_MS,
                },
                at,
                esc,
            )
            .unwrap_or_default(); // is_art geprüft
            events.splice(0..0, r.back);
            events.extend(r.front);
        } else {
            let f = |b: bool| num(if b { fxv::HOOK_FADE_MS } else { 0.0 });
            let text = format!(
                "{{\\fad({},{})}}{}",
                f(fade[0]),
                f(fade[1]),
                esc(x.text.as_deref().map(trim).unwrap_or(""))
            );
            events.push(dlg(x.start, x.end, &format!("Ov{}", num(al)), &text));
        }
    }
    let cap = match o.caption_pos.as_deref() {
        Some("oben") => (8.0, hook_v + hook_size * 1.6),
        Some("mitte") => (5.0, 0.0),
        _ => (2.0, cap_v),
    };
    let hook_style = style("Hook", hook_size, 7.0, hook_v);
    let cap_size = m * if wort {
        if wide { 0.065 } else { 0.075 }
    } else {
        0.055
    };
    let mut aligns: Vec<f64> = Vec::new();
    for &(_, al) in &ovs {
        if !aligns.contains(&al) {
            aligns.push(al);
        }
    }
    let mut out: Vec<String> = [
        "[Script Info]",
        "ScriptType: v4.00+",
        &format!("PlayResX: {}", num(w)),
        &format!("PlayResY: {}", num(h)),
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ]
    .map(String::from)
    .to_vec();
    out.push(if live {
        hook_box(&hook_style, round(m * 0.012))
    } else {
        hook_style
    });
    out.push(style("Cap", cap_size, cap.0, cap.1));
    if let Some(b) = &bar {
        out.push(b.style.clone());
    }
    for al in aligns {
        out.push(style(
            &format!("Ov{}", num(al)),
            m * 0.05,
            al,
            if al <= 3.0 { low } else { hook_v },
        ));
    }
    out.extend(
        [
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        ]
        .map(String::from),
    );
    out.extend(events);
    out.push(String::new());
    out.join("\n")
}
