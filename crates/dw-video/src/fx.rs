//! Bausteine der Clip-Stile und Einblendungen (`main/video-fx.ts`): ASS-Tags, Zuschnitt und Kamerafahrt, Facecam-Split,
//! Musikpegel-Ausdruck, Farblooks, Profi-Einblendungen als ASS, SRT.

use crate::cut::{fxv, list_step};
use crate::{Cue, Rect, Size, even, fnum, jmax, jmin, num, round, trim};
use dw_lint::js::len16;

/// Gesprochenes Wort: kurz größer, in popMs zurück
pub fn pop() -> String {
    let p = num(round(fxv::POP * 100.0));
    format!(
        "\\fscx{p}\\fscy{p}\\t(0,{},\\fscx100\\fscy100)",
        num(fxv::POP_MS)
    )
}

/// Hook blendet ein und aus
pub fn hook_fade() -> String {
    let f = num(fxv::HOOK_FADE_MS);
    format!("{{\\fad({f},{f})}}")
}

fn set(f: &mut Vec<String>, i: usize, v: String) {
    if f.len() <= i {
        f.resize(i + 1, String::new());
    }
    f[i] = v;
}

/// Hook-Style als ruhiger Balken: BorderStyle 3 = opake Box in OutlineColour
pub fn hook_box(style: &str, pad: f64) -> String {
    let mut f: Vec<String> = style.split(',').map(String::from).collect();
    set(&mut f, 0, "Style: HookBox".into());
    set(&mut f, 5, "&H59000000".into());
    set(&mut f, 15, "3".into());
    set(&mut f, 16, num(pad));
    set(&mut f, 17, "0".into());
    f.join(",")
}

pub struct Bar {
    pub style: String,
    pub event: String,
}

/// Fortschrittsbalken unten in der Akzentfarbe (Zeiten ab 0), wächst von off/total auf (off+dur)/total
pub fn progress_bar(
    size: Size,
    accent: &str,
    off: f64,
    dur: f64,
    total: f64,
    at: impl Fn(f64) -> String,
) -> Bar {
    let (w, h) = (size.w, size.h);
    let bh = jmax(4.0, round(fxv::BAR * h));
    let x = |t: f64| num(round((w * t) / total));
    let (w_, h_, bh_) = (num(w), num(h), num(bh));
    Bar {
        style: format!(
            "Style: Bar,Arial,10,{accent},{accent},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1"
        ),
        event: format!(
            "Dialogue: 0,{},{},Bar,,0,0,0,,{{\\pos(0,{})\\clip(0,0,{},{h_})\\t(\\clip(0,0,{},{h_}))\\p1}}m 0 0 l {w_} 0 {w_} {bh_} 0 {bh_}",
            at(0.0),
            at(dur),
            num(h - bh),
            x(off),
            x(off + dur)
        ),
    }
}

/// Zuschnitt um zoom enger, gleicher Mittelpunkt
pub fn zoom_crop(c: Rect, zoom: f64) -> Rect {
    if zoom <= 1.0 {
        return c;
    }
    let w = even(c.w / zoom);
    let h = even(c.h / zoom);
    Rect {
        x: round(c.x + (c.w - w) / 2.0),
        y: round(c.y + (c.h - h) / 2.0),
        w,
        h,
    }
}

/// Kamerafahrt: Stützpunkte (Quellsekunde, focus), t = 0 im Filter bei Quellsekunde start
pub struct Track<'a> {
    pub src: Size,
    pub keys: &'a [[f64; 2]],
    pub start: f64,
}

// x der Kamerafahrt als ffmpeg-Ausdruck in t, von hinten verschachtelt
fn track_x(w: f64, tr: &Track) -> String {
    let pt: Vec<[f64; 2]> = tr
        .keys
        .iter()
        .map(|[t, f]| [t - tr.start, f * tr.src.w - w / 2.0])
        .collect();
    let mut e = fnum(pt[pt.len() - 1][1]);
    for k in (0..pt.len() - 1).rev() {
        let ([ta, xa], [tb, xb]) = (pt[k], pt[k + 1]);
        if tb > ta {
            e = format!(
                "if(lt(t,{}),{}+({})*max(0,t-{}),{e})",
                fnum(tb),
                fnum(xa),
                fnum((xb - xa) / (tb - ta)),
                fnum(ta)
            );
        }
    }
    format!("'clip({e},0,{})'", num(tr.src.w - w))
}

/// ffmpeg-Filter für fit crop: Ausschnitt (ggf. gezoomt, mit Fahrt), dann auf die Zielgröße
pub fn crop_filter(c: Rect, size: Size, zoom: f64, track: Option<&Track>) -> String {
    let z = zoom_crop(c, zoom);
    let xy = match track {
        Some(tr) if !tr.keys.is_empty() => format!("{}:{}:exact=1", track_x(z.w, tr), num(z.y)),
        _ => format!("{}:{}", num(z.x), num(z.y)),
    };
    format!(
        "crop={}:{}:{xy},scale={}:{}",
        num(z.w),
        num(z.h),
        num(size.w),
        num(size.h)
    )
}

/// ffmpeg-Filter für fit split: Facecam oben, Spielbild darunter; k macht die Labels eindeutig
pub fn split_filter(r: &crate::cut::SplitRects, size: Size, k: &str) -> String {
    let (c, g) = (r.cam, r.game);
    format!(
        "split[sc{k}][sg{k}];[sc{k}]crop={}:{}:{}:{},scale={}:{}[st{k}];[sg{k}]crop={}:{}:{}:{},scale={}:{}[sb{k}];[st{k}][sb{k}]vstack",
        num(c.w),
        num(c.h),
        num(c.x),
        num(c.y),
        num(size.w),
        num(r.top),
        num(g.w),
        num(g.h),
        num(g.x),
        num(g.y),
        num(size.w),
        num(size.h - r.top)
    )
}

/// Musikpegel über die Zeit als ffmpeg-Ausdruck in t: Grundpegel base, in den Spans [von, bis, pegel] deren Pegel,
/// an jeder Grenze eine lineare Rampe von ramp s
pub fn level_expr(base: f64, spans: &[[f64; 3]], ramp: f64) -> String {
    let mut sorted = spans.to_vec();
    sorted.sort_by(|x, y| {
        (x[0] - y[0])
            .partial_cmp(&0.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut edges: Vec<[f64; 3]> = Vec::new();
    for [a, b, v] in sorted {
        match edges.last_mut() {
            Some(l) if a - l[0] < 1e-3 => l[2] = v,
            _ => edges.push([a, base, v]),
        }
        edges.push([b, v, base]);
    }
    let es: Vec<[f64; 3]> = edges.into_iter().filter(|[_, f, to]| f != to).collect();
    let pt: Vec<[f64; 2]> = es
        .iter()
        .enumerate()
        .flat_map(|(k, &[t, f, to])| {
            let prev = if k > 0 {
                (t - es[k - 1][0]) / 2.0
            } else {
                f64::INFINITY
            };
            let next = if k + 1 < es.len() {
                (es[k + 1][0] - t) / 2.0
            } else {
                f64::INFINITY
            };
            let h = jmin(jmin(ramp / 2.0, prev), next);
            [[t - h, f], [t + h, to]]
        })
        .collect();
    if pt.is_empty() {
        return format!("'{}'", fnum(base));
    }
    let mut e = fnum(pt[pt.len() - 1][1]);
    for k in (0..pt.len() - 1).rev() {
        let ([ta, va], [tb, vb]) = (pt[k], pt[k + 1]);
        if tb > ta {
            e = format!(
                "if(lt(t,{}),{}+({})*max(0,t-{}),{e})",
                fnum(tb),
                fnum(va),
                fnum((vb - va) / (tb - ta)),
                fnum(ta)
            );
        }
    }
    format!("'{e}'")
}

/// Farblook je Clip als ffmpeg-Filter (auto: autoLook); unbekannt = keiner
pub fn look_filter(look: &str) -> &'static str {
    match look {
        "warm" => "colorbalance=rs=0.06:gs=0.02:bs=-0.06:rm=0.04:bm=-0.04",
        "kuehl" => "colorbalance=rs=-0.05:bs=0.06:rm=-0.03:bm=0.04",
        "kontrast" => "eq=contrast=1.12:saturation=1.15",
        "matt" => "curves=all='0/0.06 1/0.94',eq=saturation=0.85",
        "sw" => "hue=s=0,eq=contrast=1.08",
        _ => "",
    }
}

/// Look auto aus signalstats (8 bit): Kontrast strecken, Gamma bis das Mittel bei 45 % liegt; gut belichtet: kein Filter
pub fn auto_look(avg: f64, low: f64, high: f64) -> String {
    if ![avg, low, high].iter().all(|v| v.is_finite()) {
        return String::new();
    }
    let c = jmin(1.25, jmax(1.0, 140.0 / jmax(1.0, high - low)));
    let mid = jmin(0.95, jmax(0.05, (avg / 255.0 - 0.5) * c + 0.5));
    let g = jmin(1.6, jmax(0.8, libm::log(mid) / libm::log(0.45)));
    if c < 1.02 && (g - 1.0).abs() < 0.05 {
        String::new()
    } else {
        format!("eq=contrast={}:gamma={}", fnum(c), fnum(g))
    }
}

/// Profi-Einblendung: Schriftgrößen und Akzentlinie als Anteile der kürzeren Seite
pub struct Art {
    pub text: f64,
    pub sub: f64,
    pub line: Option<[f64; 2]>,
}

pub const ART_KINDS: [&str; 7] = [
    "bauchbinde",
    "titel",
    "zahl",
    "liste",
    "zitat",
    "markierung",
    "abspann",
];
pub const ART_GAP: f64 = 0.018;
pub const ART_DIM: &str = "&H80&";
pub const ART_SLIDE: f64 = 0.03;
pub const ART_SLIDE_MS: f64 = 400.0;

pub fn art(kind: &str) -> Option<Art> {
    let (text, sub, line) = match kind {
        "bauchbinde" => (0.055, 0.034, Some([0.07, 0.006])),
        "titel" => (0.08, 0.04, None),
        "zahl" => (0.12, 0.04, Some([0.1, 0.006])),
        "liste" => (0.05, 0.042, Some([0.07, 0.006])),
        "zitat" => (0.06, 0.034, None),
        "markierung" => (0.04, 0.04, Some([0.0, 0.006])),
        "abspann" => (0.08, 0.04, Some([0.1, 0.006])),
        _ => return None,
    };
    Some(Art { text, sub, line })
}

pub fn is_art(a: Option<&str>) -> bool {
    a.is_some_and(|a| ART_KINDS.contains(&a))
}

/// Eingabe für art_events (Zeiten ab Gruppenanfang)
pub struct ArtIn<'a> {
    pub size: Size,
    pub accent: &'a str,
    pub art: &'a str,
    pub text: Option<&'a str>,
    pub sub: Option<&'a str>,
    pub items: Option<&'a [String]>,
    pub r#box: Option<[f64; 4]>,
    pub el: Option<f64>,
    pub len: Option<f64>,
    pub al: f64,
    pub top: f64,
    pub low: f64,
    pub start: f64,
    pub end: f64,
    pub fade: [bool; 2],
    pub fade_ms: f64,
}

#[derive(Debug, Default)]
pub struct ArtEvents {
    pub back: Vec<String>,
    pub front: Vec<String>,
}

static QUOTES: std::sync::LazyLock<regex::Regex> =
    std::sync::LazyLock::new(|| regex::Regex::new(r#"^[„“"»«]+|[„“"»«]+$"#).unwrap());

/// Einblendungen mit eigenem Baustein als ASS-Dialogues (al: ASS-Lage 1–9); unbekannte Art → Err
pub fn art_events(
    o: &ArtIn,
    at: impl Fn(f64) -> String,
    esc: impl Fn(&str) -> String,
) -> Result<ArtEvents, String> {
    let (w, h) = (o.size.w, o.size.h);
    let m = jmin(w, h);
    let a = art(o.art).ok_or_else(|| format!("unbekannte Einblendung „{}“", o.art))?;
    let col = (o.al - 1.0) % 3.0;
    let row = ((o.al - 1.0) / 3.0).floor();
    let fs = round(m * a.text);
    let fs2 = round(m * a.sub);
    let line = a.line.map(|l| l.map(|v| jmax(2.0, round(m * v))));
    let fad = |i: bool, u: bool| {
        format!(
            "\\fad({},{})",
            num(if i { o.fade_ms } else { 0.0 }),
            num(if u { o.fade_ms } else { 0.0 })
        )
    };
    let ev = |st: &str, text: &str, s0: f64| {
        format!("Dialogue: 0,{},{},{st},,0,0,0,,{text}", at(s0), at(o.end))
    };
    let style = format!("Ov{}", num(o.al));
    let mut r = ArtEvents::default();
    let text = o.text.map(trim).unwrap_or("");
    let rect = |rw: f64, rh: f64| {
        format!(
            "m 0 0 l {} 0 {} {} 0 {}",
            num(rw),
            num(rw),
            num(rh),
            num(rh)
        )
    };
    if o.art == "markierung" {
        let b = o.r#box.unwrap_or([0.0, 0.0, 1.0, 1.0]);
        let [bx, by, bw, bh] = [0, 1, 2, 3].map(|i| round(b[i] * if i % 2 == 1 { h } else { w }));
        let t = line.map_or(2.0, |l| l[1]);
        r.front.push(ev(
            &style,
            &format!(
                "{{\\an7\\pos({},{})\\bord{}\\shad0\\1a&HFF&\\3c{}\\3a&H00&{}\\p1}}{}",
                num(bx),
                num(by),
                num(t),
                o.accent,
                fad(o.fade[0], o.fade[1]),
                rect(bw, bh)
            ),
            o.start,
        ));
        if !text.is_empty() {
            let above = by - t - fs * 1.4 >= 0.0;
            r.front.push(ev(
                &style,
                &format!(
                    "{{\\an{}\\pos({},{}){}\\fs{}}}{}",
                    if above { 1 } else { 7 },
                    num(bx),
                    num(if above {
                        by - t * 2.0
                    } else {
                        by + bh + t * 2.0
                    }),
                    fad(o.fade[0], o.fade[1]),
                    num(fs),
                    esc(text)
                ),
                o.start,
            ));
        }
        return Ok(r);
    }
    let items: Vec<&str> = if o.art == "liste" {
        o.items
            .unwrap_or(&[])
            .iter()
            .map(|x| trim(x))
            .filter(|x| !x.is_empty())
            .collect()
    } else {
        Vec::new()
    };
    let lines =
        |s: &str, size: f64| jmax(1.0, ((len16(s) as f64 * size * 0.55) / (w * 0.84)).ceil());
    let shown = if o.art == "zitat" && !text.is_empty() {
        format!("„{}“", QUOTES.replace_all(text, ""))
    } else {
        text.to_string()
    };
    let sub = o.sub.map(trim).filter(|s| !s.is_empty());
    let gap = if line.is_some() {
        round(m * ART_GAP)
    } else {
        0.0
    };
    let head_h = if shown.is_empty() {
        0.0
    } else {
        lines(&shown, fs) * fs * 1.2
    };
    let text_h = head_h
        + if sub.is_some() {
            lines(o.sub.unwrap_or(""), fs2) * fs2 * 1.2
        } else {
            0.0
        }
        + items.len() as f64 * fs2 * 1.35;
    let block_h = line.map_or(0.0, |l| l[1] + gap) + text_h;
    let x = [round(w * 0.08), round(w / 2.0), round(w * 0.92)][col as usize];
    let top = round(if row == 2.0 {
        o.top
    } else if row == 1.0 {
        (h - block_h) / 2.0
    } else {
        h - o.low - block_h
    });
    let ty = top + line.map_or(0.0, |l| l[1] + gap);
    let dx = if o.art == "bauchbinde" && o.fade[0] && col != 1.0 {
        round(m * ART_SLIDE) * if col == 0.0 { -1.0 } else { 1.0 }
    } else {
        0.0
    };
    let place = |px: f64, py: f64| {
        if dx != 0.0 {
            format!(
                "\\move({},{},{},{},0,{})",
                num(px + dx),
                num(py),
                num(px),
                num(py),
                num(ART_SLIDE_MS)
            )
        } else {
            format!("\\pos({},{})", num(px), num(py))
        }
    };
    if matches!(o.art, "titel" | "zitat" | "abspann") {
        r.back.push(ev(
            &style,
            &format!(
                "{{\\an7\\pos(0,0)\\bord0\\shad0\\c&H000000&\\1a{ART_DIM}{}\\p1}}{}",
                fad(o.fade[0], o.fade[1]),
                rect(w, h)
            ),
            o.start,
        ));
    }
    if let Some(l) = line {
        let lx = if col == 0.0 {
            x
        } else if col == 1.0 {
            x - l[0] / 2.0
        } else {
            x - l[0]
        };
        r.front.push(ev(
            &style,
            &format!(
                "{{\\an7{}\\bord0\\shad0\\c{}{}\\p1}}{}",
                place(round(lx), top),
                o.accent,
                fad(o.fade[0], o.fade[1]),
                rect(l[0], l[1])
            ),
            o.start,
        ));
    }
    if !shown.is_empty() || sub.is_some() {
        let tail = match sub {
            Some(s) => format!(
                "{}{{\\fs{}\\b0}}{}",
                if shown.is_empty() { "" } else { "\\N" },
                num(fs2),
                esc(s)
            ),
            None => String::new(),
        };
        r.front.push(ev(
            &style,
            &format!(
                "{{\\an{}{}{}\\fs{}}}{}{tail}",
                num(7.0 + col),
                place(x, ty),
                fad(o.fade[0], o.fade[1]),
                num(fs),
                esc(&shown)
            ),
            o.start,
        ));
    }
    let step = list_step(items.len() as f64, o.len.unwrap_or(o.end - o.start));
    let el = o.el.unwrap_or(0.0);
    for (k, it) in items.iter().enumerate() {
        let kf = k as f64;
        let s0 = o.start + jmax(0.0, kf * step - el);
        if s0 < o.end - 0.05 {
            r.front.push(ev(
                &style,
                &format!(
                    "{{\\an{}\\pos({},{}){}\\fs{}\\b0}}{}",
                    num(7.0 + col),
                    num(x),
                    num(round(ty + head_h + kf * fs2 * 1.35)),
                    fad(kf * step >= el - 1e-3 && (k > 0 || o.fade[0]), o.fade[1]),
                    num(fs2),
                    esc(it)
                ),
                s0,
            ));
        }
    }
    Ok(r)
}

/// Ken-Burns bei Bild-Einblendung voll: Zoom je Sekunde, höchstens max
pub const KEN_BURNS_PER_SEC: f64 = 0.015;
pub const KEN_BURNS_MAX: f64 = 0.06;

fn srt_time(s: f64) -> String {
    let ms = jmax(0.0, round(s * 1000.0)) as u64;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        (ms / 60_000) % 60,
        (ms / 1000) % 60,
        ms % 1000
    )
}

/// Untertitel als SRT: je Häppchen ein Eintrag, Zeiten auf der Achse des fertigen Videos
pub fn srt(cs: &[Cue]) -> String {
    cs.iter()
        .enumerate()
        .map(|(k, c)| {
            format!(
                "{}\n{} --> {}\n{}\n",
                k + 1,
                srt_time(c.start),
                srt_time(c.end),
                c.words
                    .iter()
                    .map(|x| trim(&x.w))
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
