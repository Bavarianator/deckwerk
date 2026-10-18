//! Clip-Export (`main/export-video.ts`): Teilstücke je Gruppe als Zwischenstand (mkv, PCM-Ton), Endschritt je Ausgabedatei
//! (concat, Video kopiert, Ton einmal AAC + loudnorm + Musik), Folienblende, Standbild, Titelbild.
//!
//! Die Argumente und Filtergraphen baut der reine Teil (`plan_*`, `*_args`), die `encode_*`/`clip_segs`/`finish`-Funktionen
//! führen sie mit [`crate::ffmpeg`] aus (Fortschritt 0–100, Abbruch). Weggelassen: Handy-Export (phone-ffmpeg),
//! Chat-Einblendung (chat-overlay), Deck-Ablauf `exportOnce` (braucht Folien-Rendering und Theme, gehört in den Daemon).

use crate::ass::{AssIn, AssOverlay, BarPos, ass_subs, cap_margin};
use crate::cut::{
    self, JUMP_FRAMES, MAX_PARTS, MIN_PAUSE, MOMENT_FRAMES, ZOOM, crop_rect, cut_frames,
    cut_indices, duck, filler_quiet, overlay_w, snap_to_scenes, split_rects, tighten, xfade,
    zoom_of,
};
use crate::ffmpeg::{self, Cancel, Error, Probe, Result};
use crate::fx::{
    KEN_BURNS_MAX, KEN_BURNS_PER_SEC, Track, auto_look, crop_filter, hook_fade, level_expr,
    look_filter, split_filter,
};
use crate::xmeml::{Scene, clip_marks};
use crate::{
    Cue, Overlay, Part, Quiet, Size, Transcript, clamp, clip_spans, freeze_of, has, jmax, jmin, n2,
    num, part_len, parts_length, round, sec, speed_of, trim, truthy,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Lautheit der Musikdateien nach dem Angleich (LUFS)
pub const MUSIC_LUFS: f64 = -16.0;
const FADE: f64 = 0.4;
const AFADE: f64 = 0.08;
pub const SPEECH: &str = "apad=pad_len=1200,highpass=f=80,afftdn=nr=12:nf=-40:tn=1,acompressor=threshold=0.05:ratio=3:attack=15:release=150,deesser,atrim=start_sample=1200,asetpts=N/SR/TB";

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// Video-Parameter aller Zwischenstände (sonst passt -c:v copy nicht); hevc ab 4K
pub fn video(preset: &str, hevc: bool) -> Vec<String> {
    let mut v = if hevc {
        s(&["-c:v", "libx265", "-preset", preset, "-crf", "24"])
    } else {
        s(&[
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-profile:v",
            "high",
            "-crf",
            "20",
        ])
    };
    v.extend(s(&["-pix_fmt", "yuv420p", "-r", "30"]));
    v
}

pub fn pcm() -> Vec<String> {
    s(&["-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"])
}

fn audio() -> Vec<String> {
    s(&["-c:a", "aac", "-b:a", "160k", "-ar", "48000"])
}

/// x264-Preset für einen Export (Gesamtlänge in s); big ab 4K
pub fn preset_for(seconds: f64, big: bool) -> &'static str {
    match (seconds > 600.0, big) {
        (true, true) => "ultrafast",
        (true, false) | (false, true) => "superfast",
        _ => "veryfast",
    }
}

/// Teilstücke je ffmpeg-Aufruf nach Pixelzahl (1080p: 20, 4K: 5, 8K: 3)
pub fn group_for(px: f64) -> usize {
    jmax(3.0, jmin(20.0, round((20.0 * 1920.0 * 1080.0) / px))) as usize
}

fn norm(i: f64) -> String {
    format!("loudnorm=I={}:TP=-1.5:LRA=11", num(i))
}

/// Soundeffekt im Ton: input = Eingangsnummer, at = Sekunde im Ton, gain dB
#[derive(Debug, Clone, Copy)]
pub struct FxIn {
    pub input: usize,
    pub at: f64,
    pub gain: Option<f64>,
}

/// Soundeffekte in den Ton main mischen → Label out
pub fn sfx_graph(main: &str, fx: &[FxIn], out: &str) -> String {
    if fx.is_empty() {
        return format!("[{main}]anull[{out}]");
    }
    let g: Vec<String> = fx
        .iter()
        .enumerate()
        .map(|(j, f)| {
            let ms = num(jmax(0.0, round(f.at * 1000.0)));
            format!(
                "[{}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={}dB,adelay={ms}|{ms}[fx{j}]",
                f.input,
                num(f.gain.unwrap_or(0.0))
            )
        })
        .collect();
    let ins: String = (0..fx.len()).map(|j| format!("[fx{j}]")).collect();
    format!(
        "{};[{main}]{ins}amix=inputs={}:normalize=0:duration=first[{out}]",
        g.join(";"),
        fx.len() + 1
    )
}

/// Musikpegel: feste Zahl oder fertiger volume-Ausdruck
pub enum Vol<'a> {
    Num(Option<f64>),
    Expr(&'a str),
}

/// Musik unter den Ton legen (Sidechain-Ducking, Ein-/Ausblende) → Label out
pub fn duck_music(speech: &str, music: &str, volume: Vol, dur: f64, out: &str) -> String {
    let v = match volume {
        Vol::Expr(e) => e.to_string(),
        // wie TS: die feste Zahl wird geklemmt, der Ausdruck (Pegel je Ausschnitt × gain) nicht – gain > 1 kann dort
        // bewusst übersteuern; ob das so bleiben soll, entscheidet der Nutzer
        Vol::Num(v) => num(clamp(v.unwrap_or(duck::VOLUME), 0.0, 1.0)),
    };
    format!(
        "[{speech}]asplit[mus_s][mus_k];[{music}]aformat=sample_rates=48000:channel_layouts=stereo,volume={v},afade=t=in:d={}[mus_m];\
         [mus_m][mus_k]sidechaincompress=threshold={}:ratio={}:attack={}:release={},afade=t=out:st={}:d={}[mus_d];[mus_s][mus_d]amix=inputs=2:normalize=0:duration=first[{out}]",
        num(duck::FADE_IN),
        num(duck::THRESHOLD),
        num(duck::RATIO),
        num(duck::ATTACK_MS),
        num(duck::RELEASE_MS),
        sec(jmax(0.0, dur - duck::FADE_OUT)),
        num(duck::FADE_OUT)
    )
}

/// Filterkette (mit führendem Komma) aus der loudnorm-Messung; fällt sie aus oder ist alles still, dynamisch.
/// Fix (Plan §5.1): Werte aus dem JSON-Block statt per Regex aus der stderr.
pub fn norm_from_measure(i: f64, err: &str) -> String {
    let block = err
        .rfind('{')
        .and_then(|a| err[a..].find('}').map(|b| &err[a..=a + b]));
    let m: serde_json::Map<String, serde_json::Value> = block
        .and_then(|b| serde_json::from_str(b).ok())
        .unwrap_or_default();
    let v: Vec<f64> = [
        "input_i",
        "input_tp",
        "input_lra",
        "input_thresh",
        "target_offset",
    ]
    .iter()
    .map(|k| {
        m.get(*k)
            .and_then(|x| x.as_str())
            .and_then(|x| x.trim().parse::<f64>().ok())
            .unwrap_or(f64::NAN)
    })
    .collect();
    if v.iter().all(|x| x.is_finite()) {
        format!(
            ",{}:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear=true,aresample=48000,asetpts=N/SR/TB",
            norm(i),
            num(v[0]),
            num(v[1]),
            num(v[2]),
            num(v[3]),
            num(v[4])
        )
    } else {
        format!(",{},aresample=48000,asetpts=N/SR/TB", norm(i))
    }
}

/// Argumente des Messlaufs (ohne die ffmpeg-Vorsilben): input + graph(Messfilter) + Null-Ausgabe
pub fn measure_args(i: f64, input: &[String], graph: impl Fn(&str) -> Vec<String>) -> Vec<String> {
    let mut a = input.to_vec();
    a.extend(graph(&format!(",{}:print_format=json", norm(i))));
    a.extend(s(&["-map", "[a]", "-f", "null", "-"]));
    a
}

/// Lautheit auf i LUFS, zwei Durchgänge: Messlauf, dann die Kette für den Endlauf. Messlauf zählt bis 50 %.
pub fn measured_norm(
    i: f64,
    input: &[String],
    graph: impl Fn(&str) -> Vec<String>,
    cwd: &Path,
    dur: f64,
    on_progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<String> {
    let mut a = s(&[
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-progress",
        "pipe:1",
    ]);
    a.extend(measure_args(i, input, graph));
    let mut cb = on_progress;
    let mut f = |t: f64| {
        if let Some(p) = cb.as_mut()
            && dur > 0.0
        {
            p(jmin(50.0, (t * 1e6 / 2e4 / dur).floor()))
        }
    };
    let err = match ffmpeg::exec(&ffmpeg::ffmpeg_bin()?, &a, Some(cwd), Some(&mut f), cancel) {
        Ok(r) if r.code == Some(0) => r.err,
        Err(e @ (Error::Cancelled | Error::Timeout)) => return Err(e),
        _ => String::new(),
    };
    Ok(norm_from_measure(i, &err))
}

/// atempo je Instanz nur 0,5–2: Kette
pub fn atempo(sp: f64) -> Vec<String> {
    if sp > 2.0 {
        let mut v = vec!["atempo=2".to_string()];
        v.extend(atempo(sp / 2.0));
        v
    } else if sp < 0.5 {
        let mut v = vec!["atempo=0.5".to_string()];
        v.extend(atempo(sp / 0.5));
        v
    } else if sp == 1.0 {
        vec![]
    } else {
        vec![format!("atempo={}", num(sp))]
    }
}

/// parts um PAD verlängern, höchstens bis zur Mitte der Lücke zum nächsten part, nicht über das Video und nicht über
/// einen harten Bildwechsel. Fix (§7.5): TS verglich jeden part mit jedem (O(n²)); hier sortiert + Binärsuche, gleiches Ergebnis.
pub fn pad_parts(parts: &[Part], duration: f64, cuts: &[f64]) -> Vec<Part> {
    let mut ends: Vec<f64> = parts
        .iter()
        .map(|p| p.end)
        .filter(|v| !v.is_nan())
        .collect();
    let mut starts: Vec<f64> = parts
        .iter()
        .map(|p| p.start)
        .filter(|v| !v.is_nan())
        .collect();
    let mut cs: Vec<f64> = cuts.iter().copied().filter(|v| !v.is_nan()).collect();
    ends.sort_by(f64::total_cmp);
    starts.sort_by(f64::total_cmp);
    cs.sort_by(f64::total_cmp);
    parts
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut start = jmax(0.0, p.start - cut::PAD);
            let mut end = jmin(duration, p.end + cut::PAD);
            if p.end > p.start {
                // eigener part zählt nie (end > start); (q.end + start)/2 steigt mit q.end
                let k = ends.partition_point(|&e| e <= p.start);
                if k > 0 {
                    start = jmax(start, (ends[k - 1] + p.start) / 2.0);
                }
                let k = starts.partition_point(|&s| s < p.end);
                if k < starts.len() {
                    end = jmin(end, (p.end + starts[k]) / 2.0);
                }
            } else {
                // verdrehter part (checkParts lässt ihn nicht durch): wie TS einzeln vergleichen
                for (j, q) in parts.iter().enumerate() {
                    if j == i {
                        continue;
                    }
                    if q.end <= p.start {
                        start = jmax(start, (q.end + p.start) / 2.0);
                    }
                    if q.start >= p.end {
                        end = jmin(end, (p.end + q.start) / 2.0);
                    }
                }
            }
            // größter Wechsel in (start, p.start], kleinster in [p.end, end)
            let k = cs.partition_point(|&c| c <= p.start);
            if k > 0 && cs[k - 1] > start {
                start = cs[k - 1];
            }
            let k = cs.partition_point(|&c| c < p.end);
            if k < cs.len() && cs[k] < end {
                end = cs[k];
            }
            Part {
                start,
                end,
                ..p.clone()
            }
        })
        .collect()
}

/// Kanten mitten in einem Wort auf die Wortgrenze legen (höchstens 0,4 s); ohne Transkript unverändert
pub fn snap_parts(parts: &[Part], t: Option<&Transcript>) -> (Vec<Part>, usize) {
    match t {
        None => (parts.to_vec(), 0),
        Some(t) => {
            let r = dw_lint::video::snap_to_words(parts, t, 0.4);
            let n = r.moved.len();
            (r.parts, n)
        }
    }
}

/// Schnitte, an denen das Quellvideo nahtlos weiterläuft
pub fn seamless(parts: &[Part]) -> Vec<bool> {
    (0..parts.len())
        .map(|i| i > 0 && (parts[i - 1].end - parts[i].start).abs() < 1e-3)
        .collect()
}

/// Leere oder verdrehte parts vor ffmpeg abfangen
pub fn check_parts(parts: &[Part], wo: &str) -> Result<()> {
    if parts.is_empty() {
        return Err(Error::Media(format!(
            "{wo}: Der Clip hat keine Ausschnitte (parts)."
        )));
    }
    if let Some(bad) = parts
        .iter()
        .position(|p| p.end.partial_cmp(&p.start) != Some(std::cmp::Ordering::Greater))
    {
        return Err(Error::Media(format!(
            "{wo}: Ausschnitt {} endet nicht nach seinem Anfang (start {} s, end {} s).",
            bad + 1,
            num(parts[bad].start),
            num(parts[bad].end)
        )));
    }
    let n = seamless(parts).iter().filter(|j| !**j).count();
    if n > MAX_PARTS {
        return Err(Error::Media(format!(
            "{wo}: Der Clip hat {n} Ausschnitte, höchstens {MAX_PARTS} gehen. Bitte zusammenfassen oder auf mehrere Clip-Folien verteilen."
        )));
    }
    Ok(())
}

/// Untertitel-Schrift (TTF-Dateien landen in `<Job>/fonts`)
#[derive(Debug, Clone, Default)]
pub struct SubFont {
    pub name: String,
    pub files: Vec<Vec<u8>>,
    pub bold: bool,
}

/// Soundeffekt mit aufgelöstem Pfad, at = Sekunde im fertigen Clip
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SfxFile {
    pub file: String,
    pub at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain: Option<f64>,
}

/// Ein Clip zum Export; overlays mit aufgelösten Pfaden (image/video), Folien schon als PNG in image
#[derive(Debug, Clone)]
pub struct ClipJob {
    pub file: PathBuf,
    pub parts: Vec<Part>,
    pub hook: Option<String>,
    /// wort | satz | aus
    pub captions: String,
    pub transcript: Option<Transcript>,
    pub size: Size,
    pub font: SubFont,
    pub accent: String,
    pub loudnorm: bool,
    pub pauses: Option<String>,
    pub fit: Option<String>,
    pub style: Option<String>,
    pub cuts: Option<Vec<f64>>,
    pub ton: Option<String>,
    pub overlays: Vec<Overlay>,
    pub look: Option<String>,
    pub stabil: bool,
    pub caption_pos: Option<String>,
    pub cam: Option<[f64; 4]>,
    pub sfx: Vec<SfxFile>,
}

impl ClipJob {
    /// Grundwerte wie im Export: captions wort, keine Extras
    pub fn new(file: impl Into<PathBuf>, parts: Vec<Part>, size: Size) -> Self {
        Self {
            file: file.into(),
            parts,
            hook: None,
            captions: "wort".into(),
            transcript: None,
            size,
            font: SubFont {
                name: "Archivo".into(),
                files: vec![],
                bold: true,
            },
            accent: "#e4572e".into(),
            loudnorm: false,
            pauses: None,
            fit: None,
            style: None,
            cuts: None,
            ton: None,
            overlays: vec![],
            look: None,
            stabil: false,
            caption_pos: None,
            cam: None,
            sfx: vec![],
        }
    }
}

/// Zwischenstand (mkv): Länge, Musikpegel [von, bis, pegel] ab Seg-Anfang, Untertitel-Zeilen (SRT), Clip-Szenen (xmeml)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Seg {
    pub file: String,
    pub dur: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub music: Option<Vec<[f64; 3]>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cues: Option<Vec<Cue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub xml: Option<Vec<Scene>>,
}

/// Hintergrundmusik: absoluter Pfad, volume 0–1, gain = Angleich auf MUSIC_LUFS
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Music {
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain: Option<f64>,
}

#[derive(Debug, Clone, Default)]
pub struct SegOpts {
    pub preset: String,
    pub fade_in: bool,
    pub fade_out: bool,
    pub hevc: bool,
}

fn base_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Fix (Injection): interne Namen landen in Filtergraphen (`ass=<id>.ass`) und der concat-Liste; dort trennen `:` `,` `'` `;` `[`
/// Optionen bzw. Filter. Darum nur `[A-Za-z0-9_-]` (Rest → `_`), mit `.` für Dateinamen (`keep_dot`). Die Ausgabedatei behält ihren Namen.
pub fn safe_name(s: &str, keep_dot: bool) -> String {
    let n: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || (keep_dot && c == '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    // führendes `-` läse ffmpeg als Option (`-i -x.mp4.txt`)
    let n = n.strip_prefix('-').map_or(n.clone(), |r| format!("_{r}"));
    if n.is_empty() { "clip".into() } else { n }
}

/// Ausgabepfad als Argument: relativ mit `:` oder führendem `-` als `file:…`, sonst läse ffmpeg ein Protokoll bzw. eine Option
pub fn out_arg(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if p.is_relative() && (s.contains(':') || s.starts_with('-')) {
        format!("file:{s}")
    } else {
        s
    }
}

/// `basename(p).replace(/\.\w+$/, '')`
fn strip_ext(p: &Path) -> String {
    let n = base_name(p);
    match n.rfind('.') {
        Some(i)
            if i + 1 < n.len()
                && n[i + 1..]
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_') =>
        {
            n[..i].to_string()
        }
        _ => n,
    }
}

fn join(dir: &Path, f: &str) -> String {
    dir.join(f).to_string_lossy().into_owned()
}

/// Polster, Pausen und Standbilder: aus den eingerasteten parts und den Stillen die Ausschnitte des Exports
pub fn final_parts(snapped: &[Part], quiet: &[Quiet], duration: f64, cuts: &[f64]) -> Vec<Part> {
    // Übergang nur am ersten Stück eines geteilten parts, Standbild nur am letzten
    let split: Vec<Part> = snapped
        .iter()
        .flat_map(|p| {
            let all = tighten(std::slice::from_ref(p), quiet);
            let n = all.len();
            all.into_iter().enumerate().map(move |(j, mut q)| {
                if j > 0 && has(&q.transition) {
                    q.transition = None;
                }
                if truthy(q.freeze) && j < n - 1 {
                    q.freeze = None;
                }
                q
            })
        })
        .collect();
    let unfrozen: Vec<Part> = split
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut p = p.clone();
            if truthy(p.freeze)
                && split
                    .get(i + 1)
                    .is_some_and(|n| (n.start - p.end).abs() < 1e-3)
            {
                p.freeze = None;
            }
            p
        })
        .collect();
    pad_parts(&unfrozen, duration, cuts)
}

/// Eingerastete parts (Wortgrenzen, dann Bildwechsel mit Wortschutz) und Zahl der verschobenen Kanten
pub fn snap_stage(job: &ClipJob) -> (Vec<Part>, usize) {
    let (parts, moved) = snap_parts(&job.parts, job.transcript.as_ref());
    match job.cuts.as_deref() {
        Some(c) if !c.is_empty() => (
            snap_to_scenes(&parts, c, job.transcript.as_ref(), 0.3).parts,
            moved,
        ),
        _ => (parts, moved),
    }
}

/// Eine Gruppe als ffmpeg-Aufruf
#[derive(Debug, Clone)]
pub struct GroupPlan {
    pub id: String,
    /// Argumente ohne die Vorsilben von [`ffmpeg::run`]
    pub args: Vec<String>,
    /// Inhalt von `<id>.ass` im Job-Ordner
    pub ass: Option<String>,
    pub seg: Seg,
}

#[derive(Debug, Clone)]
pub struct ClipPlan {
    pub parts: Vec<Part>,
    /// Schriften nach `<dir>/fonts` legen
    pub fonts: bool,
    pub groups: Vec<GroupPlan>,
}

struct OvPiece<'a> {
    x: &'a Overlay,
    a: f64,
    b: f64,
    len: f64,
    vt: f64,
    fade: [bool; 2],
}

/// Filtergraphen und Eingänge aller Gruppen einer Clip-Szene (rein). quiet = Stillen + Füllwörter der eingerasteten parts.
// Eingänge wie clipSegs in TS (Job, Probe, Zwischenergebnisse, Name, Ordner, Optionen)
#[allow(clippy::too_many_arguments)]
pub fn plan_clip(
    job: &ClipJob,
    info: &Probe,
    snapped: &[Part],
    quiet: &[Quiet],
    look: &str,
    name: &str,
    dir: &Path,
    o: &SegOpts,
) -> ClipPlan {
    let name = &safe_name(name, false);
    let cuts = job.cuts.as_deref().unwrap_or(&[]);
    let parts = final_parts(snapped, quiet, info.duration, cuts);
    let joined = seamless(&parts);
    let total = parts_length(&parts);
    let size = job.size;
    let src = info.size();
    let other = (info.w / info.h - size.w / size.h).abs() > 0.01;
    let fit = job.fit.as_deref();
    let cam = if fit == Some("split") && other {
        job.cam
    } else {
        None
    };
    let blur = (fit == Some("blur") || (fit == Some("split") && cam.is_none())) && other;
    let (bw, bh) = (
        jmax(2.0, round(size.w / 24.0) * 2.0),
        jmax(2.0, round(size.h / 24.0) * 2.0),
    );
    let captions = if job.transcript.is_some() && job.captions != "aus" {
        Some(job.captions.as_str())
    } else {
        None
    };
    let live = job.style.as_deref() == Some("lebendig");
    let hook_all = job.hook.as_deref().map(trim);
    let fonts = hook_all.is_some_and(|h| !h.is_empty())
        || captions.is_some()
        || live
        || job.overlays.iter().any(|x| {
            x.text.as_deref().is_some_and(|t| !trim(t).is_empty())
                || x.items.as_ref().is_some_and(|i| !i.is_empty())
        });
    let group = group_for(jmax(info.w * info.h, size.w * size.h));
    let cidx = cut_indices(&parts);
    let fr = |t: f64| round(t * 30.0);
    // Platz bis Videoanfang/-ende und bis zum nächsten harten Bildwechsel
    let room = |s0: f64, dir: f64| {
        let base = if dir > 0.0 { info.duration - s0 } else { s0 };
        cuts.iter()
            .map(|c| (c - s0) * dir)
            .filter(|d| *d > -1e-6)
            .fold(base, jmin)
    };
    let file = job.file.to_string_lossy().into_owned();
    let mut groups: Vec<GroupPlan> = Vec::new();
    let mut done = 0.0;
    let mut k0 = 0;
    while k0 < parts.len() {
        let ps = &parts[k0..(k0 + group).min(parts.len())];
        let dur = parts_length(ps);
        let first = k0 == 0;
        let last = k0 + group >= parts.len();
        let id = format!("{name}-{}", n2(groups.len() + 1));
        let hook = if first { hook_all } else { None };
        let words = match (captions, &job.transcript) {
            (Some(_), Some(t)) => cut::clip_words(t, ps, quiet),
            _ => vec![],
        };
        // Einblendungen je sichtbarem Stück über alle parts, auf die Gruppe beschnitten; vt = Sekunde im Einblend-Video
        let mut ovs: Vec<OvPiece> = Vec::new();
        for x in &job.overlays {
            let spans = clip_spans(&parts, x.start, x.end);
            let len = spans.iter().fold(0.0, |q, [c, d]| q + d - c);
            let mut run = 0.0;
            for &[a, b] in &spans {
                if b > done && a < done + dur {
                    ovs.push(OvPiece {
                        x,
                        a: jmax(0.0, a - done),
                        b: jmin(dur, b - done),
                        len,
                        vt: x.from.unwrap_or(0.0) + run + jmax(0.0, done - a),
                        fade: [a >= done - 1e-3, b <= done + dur + 1e-3],
                    });
                }
                run = run + b - a;
            }
        }
        let texts: Vec<AssOverlay> = ovs
            .iter()
            .filter(|v| {
                v.x.text.as_deref().is_some_and(|t| !trim(t).is_empty())
                    || v.x.items.as_ref().is_some_and(|i| !i.is_empty())
                    || (v.x.art.as_deref() == Some("markierung") && v.x.box_.is_some())
            })
            .map(|v| AssOverlay {
                start: v.a,
                end: v.b,
                text: v.x.text.clone(),
                pos: v.x.pos.clone(),
                art: v.x.art.clone(),
                sub: v.x.sub.clone(),
                items: v.x.items.clone(),
                box_: v.x.box_,
                el: Some(v.vt - v.x.from.unwrap_or(0.0)),
                len: Some(v.len),
                fade: Some(v.fade),
            })
            .collect();
        let imgs: Vec<&OvPiece> = ovs
            .iter()
            .filter(|v| has(&v.x.image) || has(&v.x.video))
            .collect();
        let pix: Vec<&OvPiece> = ovs
            .iter()
            .filter(|v| v.x.art.as_deref() == Some("verpixeln") && v.x.box_.is_some())
            .collect();
        let subs =
            hook.is_some_and(|h| !h.is_empty()) || !words.is_empty() || live || !texts.is_empty();
        let ass = subs.then(|| {
            ass_subs(&AssIn {
                size,
                font: job.font.name.clone(),
                bold: job.font.bold,
                accent: job.accent.clone(),
                hook: hook.map(String::from),
                hook_dur: jmin(4.0, dur),
                cues: match captions {
                    Some(c) if !words.is_empty() => cut::cues(&words, c == "wort"),
                    _ => vec![],
                },
                mode: job.captions.clone(),
                style: job.style.clone(),
                bar: Some(BarPos {
                    off: done,
                    dur,
                    total,
                }),
                overlays: (!texts.is_empty()).then(|| texts.clone()),
                caption_pos: job.caption_pos.clone(),
            })
        });
        // Frames je Ausschnitt aus aufsummierten Nahtzeiten (Bild, Ton und Untertitel laufen nicht auseinander)
        let mut at = vec![0.0];
        for p in ps {
            at.push(at[at.len() - 1] + part_len(p));
        }
        let sp: Vec<f64> = ps.iter().map(speed_of).collect();
        let own = |i: usize| fr(at[i + 1]) - fr(at[i]);
        let blend = |p: &Part, gap: f64| match p.transition.as_deref() {
            Some("none") => 0.0,
            t if xfade(t.unwrap_or("")).is_some() => MOMENT_FRAMES,
            _ => cut_frames(gap),
        };
        let hv: Vec<f64> = ps
            .iter()
            .enumerate()
            .map(|(i, p)| {
                if i == 0 || joined[k0 + i] {
                    return 0.0;
                }
                let v = [
                    (blend(p, p.start - ps[i - 1].end) / 2.0).floor(),
                    (own(i - 1) / 2.0).floor(),
                    (own(i) / 2.0).floor(),
                    ((room(ps[i - 1].end, 1.0) * 30.0) / sp[i - 1]).floor(),
                    ((room(p.start, -1.0) * 30.0) / sp[i]).floor(),
                ]
                .into_iter()
                .fold(f64::INFINITY, jmin);
                jmax(0.0, v)
            })
            .collect();
        let hv_at = |i: usize| hv.get(i).copied().unwrap_or(0.0);
        let ha: Vec<f64> = hv.iter().map(|h| jmin(*h, JUMP_FRAMES / 2.0)).collect();
        let ha_at = |i: usize| ha.get(i).copied().unwrap_or(0.0);
        let joined_at = |i: usize| joined.get(i).copied().unwrap_or(false);
        let mut graph: Vec<String> = ps
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let before = hv[i] / 30.0;
                let frames = own(i) + hv[i] + hv_at(i + 1);
                let a0 = ha[i] / 30.0;
                let c = crop_rect(src, size, p.focus.unwrap_or(0.5));
                let len = part_len(p) + a0 + ha_at(i + 1) / 30.0;
                let k = k0 + i;
                let pz = clamp(p.zoom.unwrap_or(1.0), ZOOM.0, ZOOM.1);
                let fz = freeze_of(p);
                let ff = round(fz * 30.0);
                let h1 = hv_at(i + 1);
                let end = if ff != 0.0 {
                    let keep = jmax(1.0, frames - ff - h1);
                    format!("trim=end_frame={},tpad=stop_mode=clone:stop={}", num(keep), num(frames - keep))
                } else {
                    format!("trim=end_frame={}", num(frames))
                };
                let fitf = if let Some(cam) = cam {
                    split_filter(&split_rects(src, size, cam, p.focus.unwrap_or(0.5)), size, &i.to_string())
                } else if blur {
                    format!(
                        "split[b{i}][f{i}];[b{i}]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},boxblur=4,lutyuv=y=val*0.55,scale={sw}:{sh}[g{i}];\
                         [f{i}]scale={sw}:{sh}:force_original_aspect_ratio=decrease:force_divisible_by=2[h{i}];[g{i}][h{i}]overlay=(W-w)/2:(H-h)/2",
                        bw = num(bw), bh = num(bh), sw = num(size.w), sh = num(size.h)
                    )
                } else {
                    let z = if fit == Some("blur") || fit == Some("split") { 1.0 } else { zoom_of(job.style.as_deref(), cidx[k]) };
                    let tr = p.track.as_ref().map(|keys| Track { src, keys, start: p.start - before * sp[i] });
                    crop_filter(c, size, z * pz, tr.as_ref())
                };
                let vol = match p.volume {
                    Some(v) if v != 1.0 => format!("volume={},", num(clamp(v, 0.0, 2.0))),
                    _ => String::new(),
                };
                let srcl = if fz != 0.0 { len - fz - ha_at(i + 1) / 30.0 } else { len };
                let still = if fz != 0.0 {
                    format!("afade=t=out:st={}:d={},apad=whole_dur={},", sec(jmax(0.0, srcl - AFADE)), num(AFADE), sec(len))
                } else {
                    String::new()
                };
                let a = if info.audio {
                    format!(
                        "[{i}:a]atrim=start={}:duration={},asetpts=PTS-STARTPTS,{}{vol}{still}",
                        sec((before - a0) * sp[i]),
                        sec(srcl * sp[i]),
                        atempo(sp[i]).iter().map(|x| format!("{x},")).collect::<String>()
                    )
                } else {
                    format!("anullsrc=r=48000:cl=stereo,atrim=duration={},", sec(len))
                };
                let fade_in = if joined_at(k) || ha[i] != 0.0 { String::new() } else { format!(",afade=t=in:d={}", num(AFADE)) };
                let fade_out = if joined_at(k + 1) || ha_at(i + 1) != 0.0 {
                    String::new()
                } else {
                    format!(",afade=t=out:st={}:d={}", sec(jmax(0.0, len - AFADE)), num(AFADE))
                };
                let ds = if job.stabil { "deshake," } else { "" };
                let v = if sp[i] == 1.0 {
                    if ff != 0.0 {
                        format!("[{i}:v]{ds}setpts=PTS-STARTPTS,fps=30,{fitf},{end},")
                    } else {
                        format!("[{i}:v]{ds}setpts=PTS-STARTPTS,fps=30,{end},{fitf},")
                    }
                } else {
                    format!("[{i}:v]{ds}setpts=PTS-STARTPTS,{fitf},setpts=PTS/{},fps=30,{end},", num(sp[i]))
                };
                format!("{v}setsar=1,format=yuv420p[v{i}];{a}aformat=sample_rates=48000:channel_layouts=stereo{fade_in}{fade_out}[a{i}]")
            })
            .collect();
        // Bild und Ton getrennt verketten: xfade/acrossfade an Nähten mit Blende, sonst concat; offset einen halben Frame davor
        let mut cv = "[v0]".to_string();
        let mut ca = "[a0]".to_string();
        let mut n = own(0) + hv_at(1);
        for i in 1..ps.len() {
            let (h, g) = (hv[i], ha[i]);
            let frames = own(i) + h + hv_at(i + 1);
            graph.push(if h != 0.0 {
                format!(
                    "{cv}[v{i}]xfade=transition={}:duration={}:offset={}[xv{i}]",
                    xfade(ps[i].transition.as_deref().unwrap_or("")).unwrap_or("fade"),
                    sec((2.0 * h) / 30.0),
                    sec((n - 2.0 * h - 0.5) / 30.0)
                )
            } else {
                format!("{cv}[v{i}]concat=n=2:v=1:a=0,settb=1/30[xv{i}]")
            });
            graph.push(if g != 0.0 {
                format!("{ca}[a{i}]acrossfade=d={}[xa{i}]", sec((2.0 * g) / 30.0))
            } else {
                format!("{ca}[a{i}]concat=n=2:v=0:a=1[xa{i}]")
            });
            cv = format!("[xv{i}]");
            ca = format!("[xa{i}]");
            n += frames - 2.0 * h;
        }
        if !look.is_empty() {
            graph.push(format!("{cv}{look}[lk]"));
            cv = "[lk]".into();
        }
        // Bild-Einblendungen vor den Untertiteln
        let r4 = round(size.w * 0.04);
        let low = round(cap_margin(size) + jmin(size.w, size.h) * 0.16);
        let kb =
            |x: &Overlay| x.pos.as_deref() == Some("voll") && !has(&x.video) && !truthy(x.slide);
        for (j, v) in imgs.iter().enumerate() {
            let x = v.x;
            let d = sec(jmin(0.2, (v.b - v.a) / 2.0));
            let pos = x.pos.as_deref().unwrap_or("unten");
            let voll = pos == "voll";
            let nfr = ((v.b - v.a) * 30.0).ceil() + 2.0;
            let ox = if voll {
                "0".to_string()
            } else if pos.ends_with("links") {
                num(r4)
            } else if pos.ends_with("rechts") {
                format!("W-w-{}", num(r4))
            } else {
                "(W-w)/2".into()
            };
            let oy = if voll {
                "0".to_string()
            } else if pos.starts_with("oben") {
                num(r4)
            } else if pos == "mitte" {
                "(H-h)/2".into()
            } else {
                format!("H-h-{}", num(low))
            };
            let cover = |w: f64, h: f64| {
                format!(
                    "scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}",
                    w = num(w),
                    h = num(h)
                )
            };
            let fitx = if kb(x) {
                format!(
                    "{},zoompan=z='1+{}*on/{}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d={}:s={}x{}:fps=30,setpts=PTS-STARTPTS+{}/TB",
                    cover(2.0 * size.w, 2.0 * size.h),
                    num(jmin(KEN_BURNS_MAX, KEN_BURNS_PER_SEC * (v.b - v.a))),
                    num(nfr),
                    num(nfr),
                    num(size.w),
                    num(size.h),
                    sec(v.a)
                )
            } else {
                format!(
                    "{}{}",
                    if has(&x.video) {
                        format!("setpts=PTS-STARTPTS+{}/TB,", sec(v.a))
                    } else {
                        String::new()
                    },
                    if voll {
                        cover(size.w, size.h)
                    } else {
                        format!(
                            "scale={}:-1",
                            num(round(overlay_w(x.size.as_deref()) * size.w))
                        )
                    }
                )
            };
            let dn: f64 = d.parse().unwrap_or(0.0);
            graph.push(format!(
                "[{}:v]{fitx},format=rgba{}{}[o{j}]",
                ps.len() + j,
                if v.fade[0] {
                    format!(",fade=t=in:st={}:d={d}:alpha=1", sec(v.a))
                } else {
                    String::new()
                },
                if v.fade[1] {
                    format!(",fade=t=out:st={}:d={d}:alpha=1", sec(v.b - dn))
                } else {
                    String::new()
                }
            ));
            graph.push(format!(
                "{cv}[o{j}]overlay={ox}:{oy}:enable='between(t,{},{})'[ov{j}]",
                sec(v.a),
                sec(v.b)
            ));
            cv = format!("[ov{j}]");
        }
        // Verpixeln: Bereich klein rechnen und blockig zurück, ohne Blende
        for (j, v) in pix.iter().enumerate() {
            let [bx, by, bw2, bh2] = v.x.box_.unwrap();
            let blk = jmax(4.0, round(jmin(size.w, size.h) / 36.0));
            let ev = |x: f64| jmax(2.0, round(x / 2.0) * 2.0);
            let cw = jmin(ev(bw2 * size.w), size.w);
            let ch = jmin(ev(bh2 * size.h), size.h);
            let cx = jmin(ev(bx * size.w), size.w - cw);
            let cy = jmin(ev(by * size.h), size.h - ch);
            graph.push(format!("{cv}split[pa{j}][pb{j}]"));
            graph.push(format!(
                "[pb{j}]crop={}:{}:{}:{},scale={}:{}:flags=area,scale={}:{}:flags=neighbor[pc{j}]",
                num(cw),
                num(ch),
                num(cx),
                num(cy),
                num(jmax(1.0, round(cw / blk))),
                num(jmax(1.0, round(ch / blk))),
                num(cw),
                num(ch)
            ));
            graph.push(format!(
                "[pa{j}][pc{j}]overlay={}:{}:enable='between(t,{},{})'[px{j}]",
                num(cx),
                num(cy),
                sec(v.a),
                sec(v.b)
            ));
            cv = format!("[px{j}]");
        }
        let fade_out_st = sec(jmax(0.0, dur - FADE));
        let vf: Vec<String> = [
            subs.then(|| format!("ass={id}.ass:fontsdir=fonts")),
            (o.fade_in && first).then(|| format!("fade=t=in:d={}", num(FADE))),
            (o.fade_out && last).then(|| format!("fade=t=out:st={fade_out_st}:d={}", num(FADE))),
        ]
        .into_iter()
        .flatten()
        .collect();
        let af: Vec<String> = [
            (job.ton.as_deref() == Some("klar") && info.audio).then(|| SPEECH.to_string()),
            (o.fade_in && first).then(|| format!("afade=t=in:d={}", num(FADE))),
            (o.fade_out && last).then(|| format!("afade=t=out:st={fade_out_st}:d={}", num(FADE))),
        ]
        .into_iter()
        .flatten()
        .collect();
        // ponytail: ein Effekt über das Gruppenende hinaus wird dort abgeschnitten (wie TS)
        let fx: Vec<&SfxFile> = job
            .sfx
            .iter()
            .filter(|f| f.at >= done && (f.at < done + dur || last))
            .collect();
        graph.push(format!(
            "{cv}{}[v]",
            if vf.is_empty() {
                "null".into()
            } else {
                vf.join(",")
            }
        ));
        graph.push(format!(
            "{ca}{}[as]",
            if af.is_empty() {
                "anull".into()
            } else {
                af.join(",")
            }
        ));
        let fxin: Vec<FxIn> = fx
            .iter()
            .enumerate()
            .map(|(j, f)| FxIn {
                input: ps.len() + imgs.len() + j,
                at: f.at - done,
                gain: f.gain,
            })
            .collect();
        graph.push(sfx_graph("as", &fxin, "a"));
        // je Ausschnitt mit Vorlauf für die Blende, 0,1 s Reserve (Clip-Zeit, auch bei Zeitraffer)
        let mut args: Vec<String> = Vec::new();
        for (i, p) in ps.iter().enumerate() {
            args.extend([
                "-ss".into(),
                sec(p.start - (hv[i] / 30.0) * sp[i]),
                "-t".into(),
                sec(p.end - p.start
                    + ((hv[i] + hv_at(i + 1)) / 30.0) * sp[i]
                    + 0.1 * jmax(1.0, sp[i])),
                "-i".into(),
                file.clone(),
            ]);
        }
        for v in &imgs {
            let x = v.x;
            if has(&x.video) {
                args.extend([
                    "-ss".into(),
                    sec(v.vt),
                    "-t".into(),
                    sec(v.b - v.a + 0.5),
                    "-i".into(),
                    x.video.clone().unwrap(),
                ]);
            } else if kb(x) {
                args.extend(["-i".into(), x.image.clone().unwrap()]);
            } else {
                args.extend(s(&["-loop", "1", "-framerate", "30", "-t"]));
                args.extend([sec(v.b), "-i".into(), x.image.clone().unwrap()]);
            }
        }
        for f in &fx {
            args.extend(["-i".into(), f.file.clone()]);
        }
        let out = join(dir, &format!("{id}.mkv"));
        args.extend(["-filter_complex".into(), graph.join(";")]);
        args.extend(s(&["-map", "[v]", "-map", "[a]"]));
        args.extend(video(&o.preset, o.hevc));
        args.extend(pcm());
        args.push(out.clone());
        let music: Vec<[f64; 3]> = ps
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.music.map(|m| [at[i], at[i + 1], m]))
            .collect();
        let seg = Seg {
            file: out,
            dur,
            music: (!music.is_empty()).then_some(music),
            cues: (!words.is_empty()).then(|| cut::cues(&words, false)),
            xml: first.then(|| {
                vec![Scene {
                    at: 0.0,
                    src: file.clone(),
                    info: *info,
                    parts: parts.clone(),
                    marks: Some(clip_marks(job.hook.as_deref(), &job.overlays, &parts)),
                }]
            }),
        };
        groups.push(GroupPlan { id, args, ass, seg });
        done += dur;
        k0 += group;
    }
    ClipPlan {
        parts,
        fonts,
        groups,
    }
}

fn write_fonts(dir: &Path, font: &SubFont) -> Result<()> {
    std::fs::create_dir_all(dir.join("fonts"))?;
    for (i, b) in font.files.iter().enumerate() {
        std::fs::write(dir.join("fonts").join(format!("font-{i}.ttf")), b)?;
    }
    Ok(())
}

fn stats_avg(out: &str, k: &str) -> f64 {
    let re = regex::Regex::new(&format!(r"signalstats\.{k}=([\d.]+)")).unwrap();
    let v: Vec<f64> = re
        .captures_iter(out)
        .filter_map(|m| m[1].parse().ok())
        .collect();
    v.iter().sum::<f64>() / v.len() as f64
}

/// Filter des Farblooks; auto misst Helligkeit und Kontrast (signalstats, bis 5 s am Anfang des ersten parts)
pub fn look_of(job: &ClipJob, cancel: &Cancel) -> Result<String> {
    if job.look.as_deref() != Some("auto") {
        return Ok(look_filter(job.look.as_deref().unwrap_or("neutral")).to_string());
    }
    let p = job
        .parts
        .first()
        .ok_or_else(|| Error::Media("Der Clip hat keine Ausschnitte (parts).".into()))?;
    let a: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-nostats".into(),
        "-ss".into(),
        sec(p.start),
        "-t".into(),
        sec(jmin(5.0, p.end - p.start)),
        "-i".into(),
        job.file.to_string_lossy().into_owned(),
        "-an".into(),
        "-vf".into(),
        "scale=320:-2,signalstats,metadata=mode=print:file=-".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    let r = ffmpeg::exec(&ffmpeg::ffmpeg_bin()?, &a, None, None, cancel)?;
    let out = String::from_utf8_lossy(&r.out);
    Ok(auto_look(
        stats_avg(&out, "YAVG"),
        stats_avg(&out, "YLOW"),
        stats_avg(&out, "YHIGH"),
    ))
}

fn pct_cb<'a>(dur: f64, mut f: impl FnMut(f64) + 'a) -> impl FnMut(f64) + 'a {
    move |t: f64| f(jmin(100.0, (t * 1e6 / 1e4 / dur).floor()))
}

/// Prüfungen nach der Probe: Bild vorhanden, kein Ausschnitt hinter dem Videoende
pub fn check_clip(job: &ClipJob, info: &Probe) -> Result<()> {
    if info.w == 0.0 {
        return Err(Error::Media(format!(
            "{} hat kein Bild (reine Audiodatei): Ein Clip braucht ein Video.",
            base_name(&job.file)
        )));
    }
    if let Some(late) = job
        .parts
        .iter()
        .position(|p| p.start >= info.duration - 0.2)
    {
        return Err(Error::Media(format!(
            "Ausschnitt {} beginnt bei {} s, das Video ist nur {} s lang.",
            late + 1,
            num(job.parts[late].start),
            dw_lint::js::to_fixed(info.duration, 1)
        )));
    }
    Ok(())
}

/// Eine Clip-Szene als Zwischenstände (je group_for Teilstücke ein mkv); Fortschritt 0–100 über alle Gruppen
pub fn clip_segs(
    job: &ClipJob,
    name: &str,
    dir: &Path,
    o: &SegOpts,
    on_progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<Vec<Seg>> {
    clip_segs_with(&ffmpeg::Local, job, name, dir, o, on_progress, cancel)
}

/// wie [`clip_segs`], die Gruppen-Encodes rechnet `runner` (Probe, Stillen und Look weiter lokal)
pub fn clip_segs_with(
    runner: &dyn ffmpeg::Runner,
    job: &ClipJob,
    name: &str,
    dir: &Path,
    o: &SegOpts,
    mut on_progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<Vec<Seg>> {
    check_parts(&job.parts, &base_name(&job.file))?;
    let info = ffmpeg::probe(&job.file)?;
    check_clip(job, &info)?;
    let (snapped, _) = snap_stage(job);
    let mut quiet: Vec<Quiet> = Vec::new();
    if job.pauses.as_deref() == Some("kurz") && info.audio {
        for p in &snapped {
            quiet.extend(ffmpeg::silences(
                &job.file, p.start, p.end, MIN_PAUSE, cancel,
            )?);
            if let Some(t) = &job.transcript {
                quiet.extend(filler_quiet(t, p.start, p.end));
            }
        }
    }
    let look = look_of(job, cancel)?;
    let plan = plan_clip(job, &info, &snapped, &quiet, &look, name, dir, o);
    if plan.fonts {
        write_fonts(dir, &job.font)?;
    }
    let total = parts_length(&plan.parts);
    let mut done = 0.0;
    let mut segs = Vec::new();
    for g in plan.groups {
        if let Some(a) = &g.ass {
            std::fs::write(dir.join(format!("{}.ass", g.id)), a)?;
        }
        let dur = g.seg.dur;
        match on_progress.as_mut() {
            Some(p) => {
                let mut cb = pct_cb(dur, |pct| {
                    p(((done + (dur * pct) / 100.0) / total * 100.0).floor())
                });
                runner.run_in(dir, &g.args, Some(&mut cb), cancel)?;
            }
            None => {
                runner.run_in(dir, &g.args, None, cancel)?;
            }
        }
        done += dur;
        segs.push(g.seg);
    }
    Ok(segs)
}

/// Titelbild bei Quellsekunde t (Standard: Mitte des ersten parts): Zuschnitt wie der Clip, Hook eingebrannt.
/// Gibt (Argumente, Inhalt der .ass) zurück.
pub fn cover_args(
    job: &ClipJob,
    info: &Probe,
    t: Option<f64>,
    look: &str,
    out: &Path,
) -> Result<(Vec<String>, Option<String>)> {
    let p0 = job
        .parts
        .first()
        .ok_or_else(|| Error::Media("Der Clip hat keine Ausschnitte (parts).".into()))?;
    let at = jmin(
        jmax(0.0, t.unwrap_or((p0.start + p0.end) / 2.0)),
        jmax(0.0, info.duration - 0.1),
    );
    let p = job
        .parts
        .iter()
        .find(|x| at >= x.start && at <= x.end)
        .unwrap_or(p0);
    // Kamerafahrt: focus linear zwischen den Stützpunkten (wie crop_filter)
    let focus = match p.track.as_deref() {
        Some(tr) if !tr.is_empty() => match tr.iter().position(|[kt, _]| *kt > at) {
            None => Some(tr[tr.len() - 1][1]),
            Some(0) => Some(tr[0][1]),
            Some(k) => Some(
                tr[k - 1][1]
                    + ((tr[k][1] - tr[k - 1][1]) * (at - tr[k - 1][0])) / (tr[k][0] - tr[k - 1][0]),
            ),
        },
        _ => p.focus,
    }
    .unwrap_or(0.5);
    let size = job.size;
    let src = info.size();
    let hook = job.hook.as_deref().map(trim).filter(|h| !h.is_empty());
    let name = safe_name(&strip_ext(out), false);
    let (bw, bh) = (
        jmax(2.0, round(size.w / 24.0) * 2.0),
        jmax(2.0, round(size.h / 24.0) * 2.0),
    );
    let other = (info.w / info.h - size.w / size.h).abs() > 0.01;
    let fit = job.fit.as_deref();
    let cam = if fit == Some("split") && other {
        job.cam
    } else {
        None
    };
    let fitf = if let Some(cam) = cam {
        split_filter(&split_rects(src, size, cam, focus), size, "")
    } else if (fit == Some("blur") || fit == Some("split")) && other {
        format!(
            "split[b][f];[b]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},boxblur=4,lutyuv=y=val*0.55,scale={sw}:{sh}[g];\
             [f]scale={sw}:{sh}:force_original_aspect_ratio=decrease:force_divisible_by=2[h];[g][h]overlay=(W-w)/2:(H-h)/2",
            bw = num(bw),
            bh = num(bh),
            sw = num(size.w),
            sh = num(size.h)
        )
    } else {
        crop_filter(crop_rect(src, size, focus), size, 1.0, None)
    };
    // Einblendung weg: das Standbild läge sonst im Moment ganz durchsichtig
    let ass = hook.map(|h| {
        ass_subs(&AssIn {
            size,
            font: job.font.name.clone(),
            bold: job.font.bold,
            accent: job.accent.clone(),
            hook: Some(h.to_string()),
            hook_dur: 1.0,
            cues: vec![],
            mode: "aus".into(),
            style: job.style.clone(),
            bar: None,
            overlays: None,
            caption_pos: None,
        })
        .replacen(&hook_fade(), "", 1)
    });
    let vf = format!(
        "{fitf}{}{},setsar=1{}",
        if look.is_empty() { "" } else { "," },
        look,
        if hook.is_some() {
            format!(",ass={name}.ass:fontsdir=fonts")
        } else {
            String::new()
        }
    );
    let args = vec![
        "-ss".into(),
        sec(at),
        "-i".into(),
        job.file.to_string_lossy().into_owned(),
        "-frames:v".into(),
        "1".into(),
        "-update".into(),
        "1".into(),
        "-vf".into(),
        vf,
        "-q:v".into(),
        "2".into(),
        out_arg(out),
    ];
    Ok((args, ass))
}

/// Titelbild als JPEG (out im Job-Ordner dir)
pub fn encode_cover(
    job: &ClipJob,
    t: Option<f64>,
    out: &Path,
    dir: &Path,
    cancel: &Cancel,
) -> Result<()> {
    let info = ffmpeg::probe(&job.file)?;
    let look = look_of(job, cancel)?;
    let (args, ass) = cover_args(job, &info, t, &look, out)?;
    if let Some(a) = ass {
        write_fonts(dir, &job.font)?;
        std::fs::write(
            dir.join(format!("{}.ass", safe_name(&strip_ext(out), false))),
            a,
        )?;
    }
    ffmpeg::run_in(dir, &args, None, cancel)?;
    Ok(())
}

/// Standbild (PNG in Ausgabegröße) als Zwischenstand von STILL s mit stillem Ton
pub fn still_args(png: &str, out: &str, o: &SegOpts) -> Vec<String> {
    let still = num(cut::STILL);
    let vf: Vec<String> = [
        Some("setsar=1".to_string()),
        o.fade_in.then(|| format!("fade=t=in:d={}", num(FADE))),
        o.fade_out
            .then(|| format!("fade=t=out:st={}:d={}", num(cut::STILL - FADE), num(FADE))),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut a = s(&[
        "-loop",
        "1",
        "-framerate",
        "30",
        "-t",
        &still,
        "-i",
        png,
        "-f",
        "lavfi",
        "-t",
        &still,
        "-i",
        "anullsrc=r=48000:cl=stereo",
        "-vf",
    ]);
    a.push(vf.join(","));
    a.extend(video(&o.preset, o.hevc));
    a.extend(pcm());
    a.push(out.into());
    a
}

pub fn encode_still(
    png: &Path,
    out: &Path,
    dir: &Path,
    o: &SegOpts,
    on_progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<Seg> {
    let args = still_args(&png.to_string_lossy(), &out_arg(out), o);
    match on_progress {
        Some(p) => {
            let mut cb = pct_cb(cut::STILL, p);
            ffmpeg::run_in(dir, &args, Some(&mut cb), cancel)?
        }
        None => ffmpeg::run_in(dir, &args, None, cancel)?,
    };
    Ok(Seg {
        file: out.to_string_lossy().into_owned(),
        dur: cut::STILL,
        ..Default::default()
    })
}

/// Endschritt: Liste für den concat-Demuxer, Eingänge, Graph(loud) und Länge
pub struct FinishPlan {
    pub list_name: String,
    pub list: String,
    pub input: Vec<String>,
    pub dur: f64,
    music: Option<(f64, Vec<[f64; 3]>)>,
}

impl FinishPlan {
    pub fn new(segs: &[Seg], out: &Path, music: Option<&Music>) -> Self {
        let dur = segs.iter().fold(0.0, |s, x| s + x.dur);
        let list_name = format!("{}.txt", safe_name(&base_name(out), true));
        // concat-Liste: ' als '\'' wie im Demuxer-Format, sonst endet der Name dort (-safe 0)
        let list = segs
            .iter()
            .map(|s| {
                format!(
                    "file '{}'",
                    base_name(Path::new(&s.file)).replace('\'', "'\\''")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        // gain wirkt auch auf die Pegel je Ausschnitt, sonst springt der Pegel an deren Grenzen
        let music = music.map(|m| {
            let gain = m.gain.unwrap_or(1.0);
            let mut off = 0.0;
            let mut spans = Vec::new();
            for x in segs {
                for [a, b, v] in x.music.iter().flatten() {
                    // gain nach dem Klemmen: kann über 1 gehen (bewusst 1:1 wie TS, siehe duck_music)
                    spans.push([off + a, off + b, clamp(*v, 0.0, 1.0) * gain]);
                }
                off += x.dur;
            }
            (
                clamp(m.volume.unwrap_or(duck::VOLUME), 0.0, 1.0) * gain,
                spans,
            )
        });
        let input = s(&["-f", "concat", "-safe", "0", "-i", &list_name]);
        Self {
            list_name,
            list,
            input,
            dur,
            music,
        }
    }

    pub fn graph(&self, loud: &str) -> Vec<String> {
        let g = match &self.music {
            Some((vol, spans)) => {
                let expr = (!spans.is_empty())
                    .then(|| format!("{}:eval=frame", level_expr(*vol, spans, 0.5)));
                let v = match &expr {
                    Some(e) => Vol::Expr(e),
                    None => Vol::Num(Some(*vol)),
                };
                format!(
                    "{};[mx]anull{loud}[a]",
                    duck_music("0:a", "1:a", v, self.dur, "mx")
                )
            }
            None => format!("[0:a]anull{loud}[a]"),
        };
        vec!["-filter_complex".into(), g]
    }

    pub fn args(&self, loud: &str, out: &str, hevc: bool) -> Vec<String> {
        let mut a = self.input.clone();
        a.extend(self.graph(loud));
        a.extend(s(&["-map", "0:v", "-map", "[a]", "-c:v", "copy"]));
        if hevc {
            a.extend(s(&["-tag:v", "hvc1"]));
        }
        a.extend(audio());
        a.extend(s(&["-movflags", "+faststart"]));
        a.push(out.into());
        a
    }
}

/// Musik-Eingang (endlos) an die Eingänge hängen
pub fn finish_plan(segs: &[Seg], out: &Path, music: Option<&Music>) -> FinishPlan {
    let mut p = FinishPlan::new(segs, out, music);
    if let Some(m) = music {
        let f = std::path::absolute(&m.file)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| m.file.clone());
        p.input
            .extend(["-stream_loop".into(), "-1".into(), "-i".into(), f]);
    }
    p
}

#[derive(Debug, Clone, Default)]
pub struct FinishOpts {
    pub loudnorm: bool,
    pub music: Option<Music>,
    pub hevc: bool,
}

/// Endschritt je Ausgabedatei: Zwischenstände (alle in dir) verbinden, Video kopiert, Ton einmal AAC (+ Musik, loudnorm −14)
pub fn finish(
    segs: &[Seg],
    out: &Path,
    dir: &Path,
    o: &FinishOpts,
    mut on_progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<()> {
    let plan = finish_plan(segs, out, o.music.as_ref());
    std::fs::write(dir.join(&plan.list_name), &plan.list)?;
    let loud = if o.loudnorm {
        let reb: Option<&mut dyn FnMut(f64)> = match on_progress.as_mut() {
            Some(p) => Some(*p),
            None => None,
        };
        measured_norm(
            -14.0,
            &plan.input,
            |l| plan.graph(l),
            dir,
            plan.dur,
            reb,
            cancel,
        )?
    } else {
        String::new()
    };
    let args = plan.args(&loud, &out_arg(out), o.hevc);
    let ln = o.loudnorm;
    match on_progress {
        Some(p) => {
            let mut cb = pct_cb(plan.dur, |pct| {
                p(if ln { 50.0 + (pct / 2.0).floor() } else { pct })
            });
            ffmpeg::run_in(dir, &args, Some(&mut cb), cancel)?
        }
        None => ffmpeg::run_in(dir, &args, None, cancel)?,
    };
    Ok(())
}

/// Folienübergang im mp4: letzten Zwischenstand davor und ersten danach per xfade + acrossfade verbinden (Blende ≤ 0,5 s)
pub fn join_plan(
    a: &Seg,
    b: &Seg,
    transition: &str,
    out: &str,
    preset: &str,
    hevc: bool,
) -> (Vec<String>, Seg) {
    let fa = round(a.dur * 30.0);
    let d = jmax(
        1.0,
        jmin(
            jmin(15.0, (fa / 2.0).floor()),
            (round(b.dur * 30.0) / 2.0).floor(),
        ),
    );
    let off = (fa - d) / 30.0;
    let mut args = s(&[
        "-i",
        &base_name(Path::new(&a.file)),
        "-i",
        &base_name(Path::new(&b.file)),
        "-filter_complex",
    ]);
    args.push(format!(
        "[0:v][1:v]xfade=transition={transition}:duration={}:offset={}[v];[0:a][1:a]acrossfade=d={}[a]",
        sec(d / 30.0),
        sec((fa - d - 0.5) / 30.0),
        sec(d / 30.0)
    ));
    args.extend(s(&["-map", "[v]", "-map", "[a]"]));
    args.extend(video(preset, hevc));
    args.extend(pcm());
    args.push(out.into());
    let music: Vec<[f64; 3]> = a
        .music
        .iter()
        .flatten()
        .copied()
        .chain(
            b.music
                .iter()
                .flatten()
                .map(|[x, y, v]| [x + off, y + off, *v]),
        )
        .collect();
    let cues: Vec<Cue> = a
        .cues
        .iter()
        .flatten()
        .cloned()
        .chain(b.cues.iter().flatten().map(|c| Cue {
            start: c.start + off,
            end: c.end + off,
            ..c.clone()
        }))
        .collect();
    let xml: Vec<Scene> = a
        .xml
        .iter()
        .flatten()
        .cloned()
        .chain(b.xml.iter().flatten().map(|s| Scene {
            at: s.at + off,
            ..s.clone()
        }))
        .collect();
    let seg = Seg {
        file: out.into(),
        dur: a.dur + b.dur - d / 30.0,
        music: (!music.is_empty()).then_some(music),
        cues: (!cues.is_empty()).then_some(cues),
        xml: (!xml.is_empty()).then_some(xml),
    };
    (args, seg)
}

/// Folienübergang ausführen (preset und hevc aus o)
pub fn join_segs(
    a: &Seg,
    b: &Seg,
    transition: &str,
    out: &Path,
    dir: &Path,
    o: &SegOpts,
    cancel: &Cancel,
) -> Result<Seg> {
    let (args, seg) = join_plan(a, b, transition, &out.to_string_lossy(), &o.preset, o.hevc);
    ffmpeg::run_in(dir, &args, None, cancel)?;
    Ok(seg)
}

/// Eine Clip-Szene fertig als MP4 (Zwischenstände + Endschritt) im Job-Ordner dir; gibt die Länge (s) zurück
pub fn encode_clip(
    job: &ClipJob,
    out: &Path,
    dir: &Path,
    music: Option<Music>,
    on_progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<f64> {
    encode_clip_with(&ffmpeg::Local, job, out, dir, music, on_progress, cancel)
}

/// wie [`encode_clip`], die Gruppen rechnet `runner`, den Endschritt der PC
pub fn encode_clip_with(
    runner: &dyn ffmpeg::Runner,
    job: &ClipJob,
    out: &Path,
    dir: &Path,
    music: Option<Music>,
    mut on_progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<f64> {
    let stem = strip_ext(out);
    let o = SegOpts {
        preset: preset_for(parts_length(&job.parts), false).into(),
        ..Default::default()
    };
    let segs = {
        let mut cb = |p: f64| {
            if let Some(f) = on_progress.as_mut() {
                f((p * 0.9).floor())
            }
        };
        clip_segs_with(runner, job, &stem, dir, &o, Some(&mut cb), cancel)?
    };
    let mut cb = |p: f64| {
        if let Some(f) = on_progress.as_mut() {
            f(90.0 + (p / 10.0).floor())
        }
    };
    finish(
        &segs,
        out,
        dir,
        &FinishOpts {
            loudnorm: job.loudnorm,
            music,
            hevc: false,
        },
        Some(&mut cb),
        cancel,
    )?;
    Ok(segs.iter().fold(0.0, |s, x| s + x.dur))
}

/// Musik einmal anspielen und messen (erste 3 min) → gain auf MUSIC_LUFS, höchstens ×4
pub fn with_music_gain(m: &Music, cancel: &Cancel) -> Result<Music> {
    let file = std::path::absolute(&m.file)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| m.file.clone());
    let a: Vec<String> = s(&[
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-t",
        "180",
        "-i",
        &file,
        "-map",
        "0:a:0",
        "-af",
        "ebur128",
        "-f",
        "null",
        "-",
    ]);
    let r = ffmpeg::exec(&ffmpeg::ffmpeg_bin()?, &a, None, None, cancel)?;
    if r.code != Some(0) {
        let why = if r.err.to_lowercase().contains("no such file") {
            "fehlt"
        } else if r.err.to_lowercase().contains("matches no streams") {
            "hat keine Tonspur"
        } else {
            "ist nicht lesbar"
        };
        return Err(Error::Media(format!("Die Musikdatei {} {why}.", m.file)));
    }
    Ok(Music {
        gain: Some(music_gain(&r.err)),
        ..m.clone()
    })
}

/// gain aus der ebur128-Zusammenfassung (−70 = still → 1)
pub fn music_gain(err: &str) -> f64 {
    let re = regex::Regex::new(r"Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS").unwrap();
    let i = re
        .captures(err)
        .and_then(|c| c[1].parse::<f64>().ok())
        .unwrap_or(f64::NAN);
    if i.is_finite() && i > -60.0 {
        jmin(4.0, libm::pow(10.0, (MUSIC_LUFS - i) / 20.0))
    } else {
        1.0
    }
}
