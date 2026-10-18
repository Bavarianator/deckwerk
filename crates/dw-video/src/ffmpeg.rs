//! ffmpeg/ffprobe als Prozess (`main/ffmpeg.ts`): Aufruf mit Fortschritt aus `-progress pipe:1`, Abbruch und Zeitlimit,
//! Probe per ffprobe-JSON statt stderr-Parsing, Stillen, harte Bildwechsel, Standbilder.
//!
//! Öffentliche, stabile API für andere Crates (Timeline, Podcast): [`run`] / [`run_in`] und [`probe`].
//! Fix (§7.2 K21): TS-Exporte waren nicht abbrechbar und liefen ohne Zeitlimit; hier [`Cancel`] mit optionaler Frist.
//! ffmpeg läuft in einer eigenen Prozessgruppe; beim Abbruch geht erst SIGTERM, nach 2 s SIGKILL an die Gruppe, und eine
//! halbfertige Ausgabedatei (letztes Argument von [`run`]) wird gelöscht.
//! Weggelassen: Laden eines statischen ffmpeg (gehört nach dw-media), Prozess-Priorität (setPriority 10).

use crate::{Quiet, jmax, jmin, sec};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, mpsc};
use std::time::{Duration, Instant};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Missing(String),
    #[error("ffmpeg fehlgeschlagen (Code {code}):\n{tail}")]
    Failed { code: String, tail: String },
    #[error("abgebrochen")]
    Cancelled,
    #[error("Zeitlimit überschritten")]
    Timeout,
    #[error("{0}")]
    Media(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Abbruch-Token, teilbar über Threads; optional mit Frist (Zeitlimit für den ganzen Aufruf)
#[derive(Debug, Clone, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    deadline: Option<Instant>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }
    /// Bricht nach `d` ab (Error::Timeout)
    pub fn with_timeout(d: Duration) -> Self {
        Self {
            deadline: Some(Instant::now() + d),
            ..Self::default()
        }
    }
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Relaxed)
    }
    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
    fn check(&self) -> Result<()> {
        if self.is_cancelled() {
            Err(Error::Cancelled)
        } else if self.deadline.is_some_and(|d| Instant::now() >= d) {
            Err(Error::Timeout)
        } else {
            Ok(())
        }
    }
}

/// Ergebnis eines rohen Aufrufs: Code, stdout, Ende von stderr (64 KiB)
#[derive(Debug, Clone)]
pub struct Output {
    pub code: Option<i32>,
    pub out: Vec<u8>,
    pub err: String,
}

fn usable(bin: &Path) -> bool {
    let has = |what: &str, re: &str| {
        Command::new(bin)
            .args(["-hide_banner", what])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .is_ok_and(|o| {
                regex::Regex::new(re)
                    .unwrap()
                    .is_match(&String::from_utf8_lossy(&o.stdout))
            })
    };
    // Untertitel brauchen den Filter ass (libass), das Encoding libx264
    has("-filters", r"\sass\s+V->V") && has("-encoders", r"\slibx264\s")
}

/// ffmpeg mit libass und libx264: `DW_FFMPEG` oder aus dem PATH; gemerkt, Fehler nicht
pub fn ffmpeg_bin() -> Result<PathBuf> {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    if let Some(b) = BIN.get() {
        return Ok(b.clone());
    }
    let bin = PathBuf::from(std::env::var_os("DW_FFMPEG").unwrap_or_else(|| "ffmpeg".into()));
    if !usable(&bin) {
        return Err(Error::Missing(
            "ffmpeg fehlt. Bitte ffmpeg mit libass und libx264 installieren (z. B. über den Paketmanager) und den Export noch einmal starten.".into(),
        ));
    }
    Ok(BIN.get_or_init(|| bin).clone())
}

/// ffprobe neben dem ffmpeg, sonst aus dem PATH
pub fn ffprobe_bin() -> Result<PathBuf> {
    let ff = ffmpeg_bin()?;
    let name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    Ok(match ff.parent() {
        Some(d) if !d.as_os_str().is_empty() && d.join(name).exists() => d.join(name),
        _ => PathBuf::from(name),
    })
}

enum Msg {
    Progress(f64),
    Done(Vec<u8>),
}

/// Ein Aufruf ohne Shell: stdout gesammelt (mit `progress` stattdessen `out_time` in s, nur steigend), von stderr das Ende.
/// Bricht bei `cancel` (oder dessen Frist) ab und beendet den Prozess.
pub fn exec(
    bin: &Path,
    args: &[String],
    cwd: Option<&Path>,
    mut progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<Output> {
    cancel.check()?;
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => Error::Missing(format!("{} nicht gefunden", bin.display())),
        _ => Error::Io(e),
    })?;
    let mut stderr = child.stderr.take().unwrap();
    let err_t = std::thread::spawn(move || {
        let (mut tail, mut buf) = (Vec::<u8>::new(), [0u8; 8192]);
        while let Ok(n) = stderr.read(&mut buf) {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buf[..n]);
            if tail.len() > 65536 {
                tail.drain(..tail.len() - 65536);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    });
    let mut stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let parse = progress.is_some();
    std::thread::spawn(move || {
        let (mut all, mut buf) = (Vec::<u8>::new(), [0u8; 65536]);
        let mut line = Vec::<u8>::new();
        while let Ok(n) = stdout.read(&mut buf) {
            if n == 0 {
                break;
            }
            if !parse {
                all.extend_from_slice(&buf[..n]);
                continue;
            }
            for &b in &buf[..n] {
                if b != b'\n' {
                    line.push(b);
                    continue;
                }
                if let Some(us) = line.strip_prefix(b"out_time_us=")
                    && let Some(us) = std::str::from_utf8(us)
                        .ok()
                        .and_then(|s| s.trim().parse::<u64>().ok())
                {
                    let _ = tx.send(Msg::Progress(us as f64 / 1e6));
                }
                line.clear();
            }
        }
        let _ = tx.send(Msg::Done(all));
    });
    let mut last = -1.0;
    let out = loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Msg::Progress(t)) => {
                // nur steigend melden: mit loudnorm (Vorlauf) springt out_time zurück
                if t > last {
                    last = t;
                    if let Some(p) = progress.as_mut() {
                        p(t)
                    }
                }
            }
            Ok(Msg::Done(o)) => break o,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Err(e) = cancel.check() {
                    stop(&mut child);
                    return Err(e);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break Vec::new(),
        }
    };
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if let Err(e) = cancel.check() {
            stop(&mut child);
            return Err(e);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(Output {
        code: status.code(),
        out,
        err: err_t.join().unwrap_or_default(),
    })
}

/// Abbruch: SIGTERM an die Prozessgruppe, nach 2 s SIGKILL; danach eingesammelt
fn stop(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pg = child.id() as libc::pid_t;
        // SAFETY: kill mit negativer pid trifft nur die eigene, per process_group(0) angelegte Gruppe
        unsafe { libc::kill(-pg, libc::SIGTERM) };
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: wie oben
        unsafe { libc::kill(-pg, libc::SIGKILL) };
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    let _ = child.wait();
}

/// Eingabepfad für `-i`/ffprobe: absolut, damit `-x`, `concat:` oder `http:` nicht als Option bzw. Protokoll gelten
pub fn input_path(p: &Path) -> String {
    let a = std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf());
    let s = a.to_string_lossy().into_owned();
    if s.starts_with('/') {
        s
    } else {
        format!("file:{s}")
    }
}

fn tail(err: &str, n: usize) -> String {
    let ls: Vec<&str> = err.trim().split('\n').collect();
    ls[ls.len().saturating_sub(n)..].join("\n")
}

/// ffmpeg-Aufruf (`-hide_banner -nostdin -y -nostats` davor); mit `on_progress` meldet er die Ausgabezeit in s
/// (aus `-progress pipe:1`, nur steigend), sonst kommt stdout zurück. Code ≠ 0 → Error::Failed mit dem Ende von stderr.
pub fn run(
    args: &[String],
    on_progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<Vec<u8>> {
    run_opt(None, args, on_progress, cancel)
}

/// wie [`run`], im Arbeitsordner `cwd` (relative Pfade im Filtergraphen, z. B. `ass=x.ass:fontsdir=fonts`)
pub fn run_in(
    cwd: &Path,
    args: &[String],
    on_progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<Vec<u8>> {
    run_opt(Some(cwd), args, on_progress, cancel)
}

fn run_opt(
    cwd: Option<&Path>,
    args: &[String],
    on_progress: Option<&mut dyn FnMut(f64)>,
    cancel: &Cancel,
) -> Result<Vec<u8>> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-nostats"]
        .map(String::from)
        .to_vec();
    if on_progress.is_some() {
        a.extend(["-progress".into(), "pipe:1".into()]);
    }
    a.extend_from_slice(args);
    let r = match exec(&ffmpeg_bin()?, &a, cwd, on_progress, cancel) {
        Err(e @ (Error::Cancelled | Error::Timeout)) => {
            // halbfertige Ausgabe weg (letztes Argument, sofern Datei und nicht stdout/null)
            if let Some(out) = args
                .last()
                .filter(|o| *o != "-" && !o.contains("pipe:") && !o.starts_with('-'))
            {
                let f = cwd.map_or_else(|| PathBuf::from(out), |d| d.join(out));
                if f.is_file() {
                    let _ = std::fs::remove_file(f);
                }
            }
            return Err(e);
        }
        r => r?,
    };
    if r.code != Some(0) {
        return Err(Error::Failed {
            code: r.code.map_or("null".into(), |c| c.to_string()),
            tail: tail(&r.err, 15),
        });
    }
    Ok(r.out)
}

/// Dauer und Maße, wie das Video angezeigt wird (Drehung 90/270 tauscht w und h), Bildrate und ob es Ton hat;
/// reine Audiodatei: w = h = 0
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Probe {
    pub duration: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fps: Option<f64>,
    /// fehlt im JSON = mit Ton (wie `info.audio !== false` in TS)
    #[serde(default = "yes")]
    pub audio: bool,
}

fn yes() -> bool {
    true
}

impl Probe {
    pub fn size(&self) -> crate::Size {
        crate::Size {
            w: self.w,
            h: self.h,
        }
    }
}

#[derive(Deserialize)]
struct FfStream {
    codec_type: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    avg_frame_rate: Option<String>,
    #[serde(default)]
    disposition: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    side_data_list: Vec<serde_json::Value>,
    #[serde(default)]
    tags: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize)]
struct FfProbe {
    #[serde(default)]
    streams: Vec<FfStream>,
    format: Option<FfFormat>,
}

#[derive(Deserialize)]
struct FfFormat {
    duration: Option<String>,
}

fn name_of(p: &Path) -> String {
    p.file_name().map_or_else(
        || p.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

/// ffprobe-JSON auswerten (getrennt für Tests)
pub fn parse_probe(json: &str, file: &Path) -> Result<Probe> {
    let unreadable = || Error::Media(format!("Video nicht lesbar: {}", name_of(file)));
    let p: FfProbe = serde_json::from_str(json).map_err(|_| unreadable())?;
    let duration = p
        .format
        .and_then(|f| f.duration)
        .and_then(|d| d.trim().parse::<f64>().ok())
        .filter(|d| d.is_finite())
        .ok_or_else(unreadable)?;
    // Cover-Bild in Audiodateien zählt nicht
    let video = p.streams.iter().find(|s| {
        s.codec_type.as_deref() == Some("video")
            && s.disposition.get("attached_pic").and_then(|v| v.as_i64()) != Some(1)
    });
    let audio = p
        .streams
        .iter()
        .any(|s| s.codec_type.as_deref() == Some("audio"));
    let size = video.and_then(|v| Some((v.width?, v.height?)));
    if size.is_none() && !audio {
        return Err(Error::Media(format!(
            "Weder Bild noch Ton in {}",
            name_of(file)
        )));
    }
    // ponytail: SAR ≠ 1 (anamorph) bleibt gestaucht wie in TS; Upgrade: Breite × sample_aspect_ratio
    let rot = video.map_or(0.0, |v| {
        v.side_data_list
            .iter()
            .find_map(|d| d.get("rotation").and_then(|r| r.as_f64()))
            .or_else(|| {
                v.tags
                    .get("rotate")
                    .and_then(|r| r.as_str()?.trim().parse().ok())
            })
            .unwrap_or(0.0)
            .round()
    });
    let (w, h) = match size {
        None => (0.0, 0.0),
        Some((w, h)) if rot.abs() % 180.0 == 90.0 => (h, w),
        Some(s) => s,
    };
    if duration > 48.0 * 3600.0 {
        return Err(Error::Media(format!(
            "Video ist länger als 48 Stunden ({}). So lange Videos kann Deckwerk nicht verarbeiten.",
            name_of(file)
        )));
    }
    // avg_frame_rate exakt (30000/1001) statt der gerundeten „29.97 fps“ aus stderr; variable Bildrate: Mittelwert
    let fps = video.and_then(|v| {
        let (a, b) = v.avg_frame_rate.as_deref()?.split_once('/')?;
        let f = a.parse::<f64>().ok()? / b.parse::<f64>().ok()?;
        (f.is_finite() && f > 0.0).then_some(f)
    });
    Ok(Probe {
        duration,
        w,
        h,
        fps,
        audio,
    })
}

/// Probe per ffprobe-JSON (§8.3: statt stderr von `ffmpeg -i`)
pub fn probe(path: &Path) -> Result<Probe> {
    let args: Vec<String> = [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ]
    .map(String::from)
    .into_iter()
    .chain([input_path(path)])
    .collect();
    let r = exec(&ffprobe_bin()?, &args, None, None, &Cancel::new())?;
    if r.code != Some(0) {
        let missing = r.err.to_lowercase().contains("no such file");
        return Err(Error::Media(format!(
            "Video nicht lesbar: {}{}",
            name_of(path),
            if missing {
                " (Datei nicht gefunden)"
            } else {
                ""
            }
        )));
    }
    parse_probe(&String::from_utf8_lossy(&r.out), path)
}

/// Stillen aus der stderr von silencedetect (Zeiten ab 0 = from); eine Stille bis zum Ende hat bei älterem ffmpeg kein silence_end
pub fn parse_silences(err: &str, from: f64, to: f64) -> Vec<Quiet> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"silence_(start|end): (-?[\d.]+)").unwrap());
    let mut out: Vec<Quiet> = Vec::new();
    for m in re.captures_iter(err) {
        let t = jmin(
            to,
            jmax(from, from + m[2].parse::<f64>().unwrap_or(f64::NAN)),
        );
        if &m[1] == "start" {
            out.push([t, to]);
        } else if let Some(l) = out.last_mut() {
            l[1] = t;
        }
    }
    out
}

/// Stillen ab min Sekunden zwischen from und to (Quellsekunden). ponytail: feste Schwelle −35 dB wie in TS
pub fn silences(file: &Path, from: f64, to: f64, min: f64, cancel: &Cancel) -> Result<Vec<Quiet>> {
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-nostats".into(),
        "-ss".into(),
        sec(from),
        "-t".into(),
        sec(to - from),
        "-i".into(),
        input_path(file),
        "-vn".into(),
        "-af".into(),
        format!("silencedetect=noise=-35dB:d={}", crate::num(min)),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    let r = exec(&ffmpeg_bin()?, &args, None, None, cancel)?;
    if r.code != Some(0) {
        return Err(Error::Media(format!(
            "Pausen in {} nicht messbar:\n{}",
            name_of(file),
            tail(&r.err, 5)
        )));
    }
    Ok(parse_silences(&r.err, from, to))
}

/// Harte Bildwechsel (scdet, Schwelle 12, auf 320 px) zwischen from und to: je Wechsel 5 ms vor seinem ersten Frame
pub fn scenes(file: &Path, from: f64, to: f64, cancel: &Cancel) -> Result<Vec<f64>> {
    let ss = sec(from);
    let args: Vec<String> = vec![
        "-ss".into(),
        ss.clone(),
        "-t".into(),
        sec(to - from),
        "-i".into(),
        input_path(file),
        "-an".into(),
        "-sn".into(),
        "-vf".into(),
        "scale=320:-2,scdet=threshold=12,metadata=mode=print:key=lavfi.scd.time:file=-".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ];
    let out = run(&args, None, cancel)?;
    let re = regex::Regex::new(r"lavfi\.scd\.time=([\d.]+)").unwrap();
    let base: f64 = ss.parse().unwrap_or(0.0);
    Ok(re
        .captures_iter(&String::from_utf8_lossy(&out))
        .filter_map(|m| m[1].parse::<f64>().ok())
        .map(|t| base + t - 0.005)
        .collect())
}

/// Je Zeitpunkt (s) ein JPEG in width px Breite. ponytail: ein Prozess je Bild wie in TS (§7.5 L6); Upgrade: select-Filter
pub fn frames(file: &Path, times: &[f64], width: f64, cancel: &Cancel) -> Result<Vec<Vec<u8>>> {
    times
        .iter()
        .map(|&t| {
            let args: Vec<String> = vec![
                "-ss".into(),
                crate::num(jmax(0.0, t)),
                "-i".into(),
                input_path(file),
                "-frames:v".into(),
                "1".into(),
                "-vf".into(),
                format!("scale={}:-2", crate::num(crate::round(width))),
                "-q:v".into(),
                "4".into(),
                "-f".into(),
                "image2pipe".into(),
                "-c:v".into(),
                "mjpeg".into(),
                "pipe:1".into(),
            ];
            let jpg = run(&args, None, cancel).map_err(|e| match e {
                Error::Failed { tail, .. }
                    if regex::Regex::new(
                        r"(?i)does not contain any stream|matches no streams|no video stream",
                    )
                    .unwrap()
                    .is_match(&tail) =>
                {
                    Error::Media(format!(
                        "{} hat kein Bild (reine Audiodatei).",
                        name_of(file)
                    ))
                }
                e => e,
            })?;
            if jpg.is_empty() {
                return Err(Error::Media(format!(
                    "Kein Bild bei {} s in {} (Video zu kurz?)",
                    crate::num(t),
                    name_of(file)
                )));
            }
            Ok(jpg)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_json() {
        let j = r#"{"streams":[{"codec_type":"video","width":1920,"height":1080,"avg_frame_rate":"30000/1001","side_data_list":[{"rotation":-90}]},
            {"codec_type":"audio"},{"codec_type":"video","width":300,"height":300,"disposition":{"attached_pic":1}}],"format":{"duration":"12.500000"}}"#;
        let p = parse_probe(j, Path::new("a.mp4")).unwrap();
        assert_eq!(
            (p.w, p.h, p.duration, p.audio),
            (1080.0, 1920.0, 12.5, true)
        );
        assert!((p.fps.unwrap() - 29.97).abs() < 0.01);
        let a = r#"{"streams":[{"codec_type":"audio"},{"codec_type":"video","width":300,"height":300,"disposition":{"attached_pic":1}}],"format":{"duration":"3"}}"#;
        let p = parse_probe(a, Path::new("a.mp3")).unwrap();
        assert_eq!((p.w, p.fps), (0.0, None));
        assert!(
            parse_probe(
                r#"{"streams":[],"format":{"duration":"3"}}"#,
                Path::new("x")
            )
            .is_err()
        );
    }

    #[test]
    fn silence_parse() {
        let e = "[silencedetect] silence_start: 1.5\n[silencedetect] silence_end: 2.25 | silence_duration: 0.75\n[silencedetect] silence_start: 9\n";
        assert_eq!(
            parse_silences(e, 10.0, 20.0),
            vec![[11.5, 12.25], [19.0, 20.0]]
        );
    }
}
