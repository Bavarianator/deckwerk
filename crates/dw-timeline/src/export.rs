//! Export der Pro-Timeline (`main/export-timeline.ts`) als reine Bausteine: je Abschnitt Ton und Bild einzeln kodieren,
//! Ton zweistufig auf das Lautheitsziel, dann verbinden; daneben Schnittliste (.xml) und Untertitel (.srt).
//! Die Reihenfolge der Läufe zeigt der Ende-zu-Ende-Test (`tests/e2e.rs`); den Prozess startet der Aufrufer (später dw-video).
//! Weggelassen: die ASS-Datei der Titel (`assSubs` aus export-video.ts gehört zu dw-video); `section_texts` liefert ihr die Eingaben.

use crate::graph::{Section, audio_args, encode_args, even};
use crate::media::R128;
use crate::model::*;
use crate::xmeml::Info;
use dw_lint::js::{num, round};
use dw_lint::video::Overlay;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn s(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| x.to_string()).collect()
}
/// Dateinummer dreistellig
pub fn n3(k: usize) -> String {
    format!("{k:03}")
}

/// Reine Tondatei aus der Ausgabe von `ffmpeg -i` (probe verlangt eine Videospur): Dauer und Ton, ohne Bild
pub fn audio_only_info(stderr: &str) -> Option<Info> {
    let k = stderr.find("Duration: ")? + 10;
    let mut p = stderr[k..].splitn(3, ':');
    let h: f64 = p.next()?.parse().ok()?;
    let m: f64 = p.next()?.parse().ok()?;
    let sec: String = p
        .next()?
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let sec: f64 = sec.parse().ok()?;
    let audio = stderr
        .lines()
        .any(|l| l.contains("Stream #") && l.contains(" Audio: "));
    audio.then_some(Info {
        duration: h * 3600.0 + m * 60.0 + sec,
        w: 0.0,
        h: 0.0,
        fps: None,
        audio: true,
    })
}

/// Quellen auflösen und prüfen: Kopie mit aufgelösten Pfaden; Clips aus Quellen ohne Ton gelten als stumm (audio_args nimmt Ton an).
/// info: Angaben je aufgelöstem Pfad (probe bzw. audio_only_info).
pub fn prepare(
    tl: &TimelineContent,
    resolve: &dyn Fn(&str) -> String,
    info: &HashMap<String, Info>,
) -> Result<TimelineContent, String> {
    let mut rt = tl.clone();
    for t in &mut rt.tracks {
        for c in &mut t.clips {
            c.src = resolve(&c.src);
            let i = info
                .get(&c.src)
                .ok_or_else(|| format!("{}: Quelle nicht geprüft", base(&c.src)))?;
            if !i.audio {
                c.mute = Some(true);
            }
            if t.kind == Kind::Video && !(i.w > 0.0) {
                return Err(format!(
                    "{} hat kein Bild und kann nicht auf einer Videospur liegen. Tondateien gehören auf eine Audiospur.",
                    base(&c.src)
                ));
            }
        }
    }
    Ok(rt)
}
fn base(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// Encoder in `ffmpeg -encoders` vorhanden?
pub fn has_encoder(encoders: &str, enc: &str) -> bool {
    encoders.split_whitespace().any(|w| w == enc)
}
pub fn encoder_error(deliver: &Deliver, enc: &str) -> String {
    format!(
        "Das installierte ffmpeg kann nicht als {} kodieren (Encoder {enc} fehlt). Bitte ein ffmpeg mit {enc} installieren oder H.264 wählen.",
        deliver.codec.name()
    )
}

/// Platzbedarf grob vorab (Segmente + fertige Datei, WAV dreifach, ×1,2 Reserve) in Byte
pub fn disk_need(dur: f64, deliver: &Deliver, w: f64, h: f64) -> f64 {
    // Grobe Datenrate bei 1080p30 (Byte/s)
    let rate = match deliver.codec {
        Codec::H264 => 1.5e6,
        Codec::H264_10 => 2e6,
        Codec::Prores | Codec::Dnxhr => 27.5e6,
    };
    let v = (rate * w * h * deliver.fps) / (1920.0 * 1080.0 * 30.0);
    dur * (2.0 * v + 3.0 * 0.19e6) * 1.2
}
pub fn space_error(need: f64, free: f64) -> String {
    format!(
        "Zu wenig freier Speicherplatz für den Timeline-Export: nötig sind rund {} GB, frei {} GB.",
        num((need / 1e8).ceil() / 10.0),
        num((free / 1e8).floor() / 10.0)
    )
}

/// LUT je Clip mit Farbkorrektur: (Clip, Datei grade-NNN.cube in work, Inhalt)
pub fn luts<'a>(rt: &'a TimelineContent, work: &Path) -> Vec<(&'a TlClip, PathBuf, String)> {
    rt.tracks
        .iter()
        .flat_map(|t| &t.clips)
        .filter(|c| !crate::grade::is_neutral(c.grade.as_ref()))
        .enumerate()
        .map(|(k, c)| {
            (
                c,
                work.join(format!("grade-{}.cube", n3(k + 1))),
                crate::grade::cube1d(c.grade.as_ref()),
            )
        })
        .collect()
}

pub const WAV: [&str; 6] = ["-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"];

/// Ton eines Abschnitts als WAV; -t an der Ausgabe: amix+apad endete sonst nur über atrim, das hing einmal unter Last
pub fn section_audio_args(sec: &Section, out: &str) -> Vec<String> {
    let mut a = audio_args(sec, 48000);
    a.extend(s(&WAV));
    a.extend(["-t".into(), num(sec.end - sec.start), out.into()]);
    a
}
/// Liste für den concat-Demuxer
pub fn concat_list(prefix: &str, n: usize, ext: &str) -> String {
    (0..n)
        .map(|i| format!("file '{prefix}-{}.{ext}'", n3(i)))
        .collect::<Vec<_>>()
        .join("\n")
}
/// a.txt → mix.wav (cwd = work)
pub fn concat_audio_args() -> Vec<String> {
    s(&[
        "-f", "concat", "-safe", "0", "-i", "a.txt", "-c", "copy", "mix.wav",
    ])
}
/// Zweiter loudnorm-Durchgang mix.wav → mixn.wav (cwd = work); None bei stillem Ton (Messung nicht endlich)
pub fn loudnorm_args(target: f64, m: &R128) -> Option<Vec<String>> {
    if ![m.i, m.tp, m.lra, m.thresh].iter().all(|v| v.is_finite()) {
        return None;
    }
    let af = format!(
        "loudnorm=I={}:TP=-1:LRA=11:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:linear=true,aresample=48000",
        num(target),
        num(m.i),
        num(m.tp),
        num(m.lra),
        num(m.thresh)
    );
    let mut a = s(&["-i", "mix.wav", "-af"]);
    a.push(af);
    a.extend(s(&WAV));
    a.push("mixn.wav".into());
    Some(a)
}
pub const SILENT: &str = "Der Ton ist still, die Lautheit wurde nicht angepasst.";

/// Was als Einblendung zählt: Text, Liste, Markierung/Verpixeln mit box
pub fn export_overlays(tl: &TimelineContent) -> Vec<&Overlay> {
    tl.overlays
        .iter()
        .flatten()
        .filter(|x| {
            x.text
                .as_deref()
                .is_some_and(|t| !dw_lint::js::trim(t).is_empty())
                || x.items.as_ref().is_some_and(|i| !i.is_empty())
                || (matches!(x.art.as_deref(), Some("markierung" | "verpixeln"))
                    && x.box_.is_some())
        })
        .collect()
}
/// Untertitel des Exports. ponytail: immer als Zeile (satz), 'wort' bräuchte Wortzeiten in tl.subs
pub fn export_subs(tl: &TimelineContent) -> &[Sub] {
    if tl.captions.as_deref() == Some("aus") {
        &[]
    } else {
        tl.subs.as_deref().unwrap_or(&[])
    }
}

/// Auf einen Abschnitt beschnittenes Element: Zeiten ab Abschnittsanfang, el = schon gelaufene Zeit, fade = echte Enden
#[derive(Debug, Clone)]
pub struct Clipped<'a, T> {
    pub item: &'a T,
    pub start: f64,
    pub end: f64,
    pub el: f64,
    pub len: f64,
    pub fade: [bool; 2],
}
pub fn clip_to<'a, T>(
    xs: impl IntoIterator<Item = (&'a T, f64, f64)>,
    sec: &Section,
) -> Vec<Clipped<'a, T>> {
    let len = sec.end - sec.start;
    xs.into_iter()
        .filter(|&(_, a, b)| b > sec.start && a < sec.end)
        .map(|(item, a, b)| Clipped {
            item,
            start: 0f64.max(a - sec.start),
            end: len.min(b - sec.start),
            el: 0f64.max(sec.start - a),
            len: b - a,
            fade: [a >= sec.start - 1e-3, b <= sec.end + 1e-3],
        })
        .collect()
}
/// Einblendungen und Untertitel eines Abschnitts (Eingabe für die ASS-Datei und das Verpixeln)
pub fn section_texts<'a>(
    ovs: &[&'a Overlay],
    subs: &'a [Sub],
    sec: &Section,
) -> (Vec<Clipped<'a, Overlay>>, Vec<Clipped<'a, Sub>>) {
    (
        clip_to(ovs.iter().map(|o| (*o, o.start, o.end)), sec),
        clip_to(subs.iter().map(|x| (x, x.start, x.end)), sec),
    )
}

/// Bild eines Abschnitts fertig machen: Verpixeln (Bereich klein rechnen und blockig zurück), ASS-Datei (relativ zu cwd = work), Pixelformat.
/// a = video_args; danach Codec-Argumente, -an, -t und Ausgabe anhängen (siehe section_video_out).
pub fn finish_video_args(
    mut a: Vec<String>,
    here: &[Clipped<Overlay>],
    w: f64,
    h: f64,
    ass: Option<&str>,
    pix: &str,
) -> Vec<String> {
    let mut g: Vec<String> = Vec::new();
    let mut cv = "[vout]".to_string();
    let blk = 4f64.max(round(w.min(h) / 36.0));
    for (j, x) in here
        .iter()
        .filter(|x| x.item.art.as_deref() == Some("verpixeln"))
        .enumerate()
    {
        let [bx, by, bw, bh] = x.item.box_.unwrap();
        let cw = even(bw * w).min(w);
        let ch = even(bh * h).min(h);
        let cx = even(bx * w).min(w - cw);
        let cy = even(by * h).min(h - ch);
        g.push(format!("{cv}split[pa{j}][pb{j}]"));
        g.push(format!(
            "[pb{j}]crop={}:{}:{}:{},scale={}:{}:flags=area,scale={}:{}:flags=neighbor[pc{j}]",
            num(cw),
            num(ch),
            num(cx),
            num(cy),
            num(1f64.max(round(cw / blk))),
            num(1f64.max(round(ch / blk))),
            num(cw),
            num(ch)
        ));
        g.push(format!(
            "[pa{j}][pc{j}]overlay={}:{}:enable='between(t,{},{})'[px{j}]",
            num(cx),
            num(cy),
            num(x.start),
            num(x.end)
        ));
        cv = format!("[px{j}]");
    }
    let ass = ass.map_or(String::new(), |f| format!("ass={f}:fontsdir=fonts,"));
    g.push(format!("{cv}{ass}format={pix}[vf]"));
    let fi = a.iter().position(|x| x == "-filter_complex").unwrap();
    a[fi + 1] = format!("{};{}", a[fi + 1], g.join(";"));
    let m = a.iter().rposition(|x| x == "[vout]").unwrap();
    a[m] = "[vf]".into();
    a
}
pub fn section_video_out(
    mut a: Vec<String>,
    deliver: &Deliver,
    len: f64,
    out: &str,
) -> Vec<String> {
    a.extend(encode_args(deliver).args);
    a.extend(["-an".into(), "-t".into(), num(len), out.into()]);
    a
}
/// Pixelformat der Ausgabe aus den Codec-Argumenten
pub fn pix_fmt(deliver: &Deliver) -> String {
    let a = encode_args(deliver).args;
    a[a.iter().position(|x| x == "-pix_fmt").unwrap() + 1].clone()
}

/// Segmente kopieren, Ton einmal kodieren (cwd = work)
pub fn mux_args(deliver: &Deliver, mix: &str, tmp: &str) -> Vec<String> {
    let mut a = s(&[
        "-f", "concat", "-safe", "0", "-i", "v.txt", "-i", mix, "-map", "0:v", "-map", "1:a",
        "-c:v", "copy",
    ]);
    a.extend(crate::graph::audio_codec(deliver));
    if encode_args(deliver).ext == "mp4" {
        a.extend(s(&["-movflags", "+faststart"]));
    }
    a.push(tmp.into());
    a
}

fn srt_time(s: f64) -> String {
    let ms = 0f64.max(round(s * 1000.0)) as u64;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3600000,
        (ms / 60000) % 60,
        (ms / 1000) % 60,
        ms % 1000
    )
}
/// Untertitel als SRT (wie srt() in video-fx.ts, je Untertitel ein Eintrag)
pub fn srt(subs: &[Sub]) -> String {
    subs.iter()
        .enumerate()
        .map(|(k, c)| {
            format!(
                "{}\n{} --> {}\n{}\n",
                k + 1,
                srt_time(c.start),
                srt_time(c.end),
                dw_lint::js::trim(&c.text)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
