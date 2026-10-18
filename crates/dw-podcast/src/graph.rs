//! Podcast-Export (`main/podcast.ts`) als reine Bausteine: Filtergraph, Lautheit, Kapitel, Wellenform, Vorhör-Mix.
//! Kette: Spuren (gain) mischen → Schnitte (atrim + 10-ms-Blenden an jeder Naht) → Sprachkette (ton) → Intro/Outro überblendet
//! → Soundeffekte → Musik geduckt → loudnorm −16 LUFS in zwei Durchgängen. Den ffmpeg-Prozess startet der Aufrufer.

use crate::episode::*;
use dw_lint::js::{num, round, to_fixed};

/// Überblendung Intro/Outro (s)
const XF: f64 = 1.0;
/// Blende an jeder Schnittnaht (s) gegen Knackser
const SEAM: f64 = 0.01;
const FMT: &str = "aformat=sample_rates=48000:channel_layouts=stereo";
fn sec(s: f64) -> String {
    to_fixed(s, 3)
}

// ponytail: Kopie aus export-video.ts (SPEECH, DUCK, sfxGraph, duckMusic, loudnorm); nach dw-video ziehen, sobald es dort liegt
/// Sprachkette 'klar': Brummen weg, moderat entrauschen, Kompressor 3:1, Zischlaute dämpfen; afftdn-Verzögerung vorn abgeschnitten
pub const SPEECH: &str = "apad=pad_len=1200,highpass=f=80,afftdn=nr=12:nf=-40:tn=1,acompressor=threshold=0.05:ratio=3:attack=15:release=150,deesser,atrim=start_sample=1200,asetpts=N/SR/TB";
pub struct Duck {
    pub volume: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    pub threshold: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
}
pub const DUCK: Duck = Duck {
    volume: 0.25,
    fade_in: 1.0,
    fade_out: 2.0,
    threshold: 0.006,
    ratio: 8.0,
    attack_ms: 20.0,
    release_ms: 300.0,
};

pub struct Fx {
    pub input: usize,
    pub at: f64,
    pub gain: Option<f64>,
}
/// Soundeffekte in den Ton mischen: je Effekt adelay (ms), Länge gibt main vor; ohne Effekte durchgereicht
pub fn sfx_graph(main: &str, fx: &[Fx], out: &str) -> String {
    if fx.is_empty() {
        return format!("[{main}]anull[{out}]");
    }
    let g: Vec<String> = fx
        .iter()
        .enumerate()
        .map(|(j, f)| {
            let ms = num(0f64.max(round(f.at * 1000.0)));
            format!("[{}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={}dB,adelay={ms}|{ms}[fx{j}]", f.input, num(f.gain.unwrap_or(0.0)))
        })
        .collect();
    let labels: String = (0..fx.len()).map(|j| format!("[fx{j}]")).collect();
    format!(
        "{};[{main}]{labels}amix=inputs={}:normalize=0:duration=first[{out}]",
        g.join(";"),
        fx.len() + 1
    )
}
/// Musik unter den Ton, geduckt per sidechaincompress; dur = Länge des Tons für die Abblende
pub fn duck_music(speech: &str, music: &str, volume: f64, dur: f64, out: &str) -> String {
    format!(
        "[{speech}]asplit[mus_s][mus_k];[{music}]aformat=sample_rates=48000:channel_layouts=stereo,volume={},afade=t=in:d={}[mus_m];[mus_m][mus_k]sidechaincompress=threshold={}:ratio={}:attack={}:release={},afade=t=out:st={}:d={}[mus_d];[mus_s][mus_d]amix=inputs=2:normalize=0:duration=first[{out}]",
        num(1f64.min(0f64.max(volume))),
        num(DUCK.fade_in),
        num(DUCK.threshold),
        num(DUCK.ratio),
        num(DUCK.attack_ms),
        num(DUCK.release_ms),
        sec(0f64.max(dur - DUCK.fade_out)),
        num(DUCK.fade_out)
    )
}

/// Zeitachse der fertigen Episode: off = Beginn der Sprache (Intro minus Überblendung), total = Gesamtlänge (s)
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct Timing {
    pub len: f64,
    #[serde(rename = "dI")]
    pub d_i: f64,
    #[serde(rename = "dO")]
    pub d_o: f64,
    pub off: f64,
    pub total: f64,
}
#[derive(Debug, Clone, Copy, Default)]
pub struct GraphOpts {
    /// Musikpegel 0..1 (Musik ist dann der letzte Eingang, -stream_loop -1)
    pub music: Option<f64>,
    pub intro_dur: Option<f64>,
    pub outro_dur: Option<f64>,
}

pub fn timing(ep: &Episode, o: &GraphOpts) -> Result<Timing, String> {
    let len = edited_length(&ep.cuts, ep.duration);
    let has = |s: &Option<String>| s.as_deref().is_some_and(|s| !s.is_empty());
    let (intro, outro) = (has(&ep.intro), has(&ep.outro));
    let id = if intro {
        Some(o.intro_dur.ok_or("Intro ohne Länge (introDur)")?)
    } else {
        None
    };
    let od = if outro {
        Some(o.outro_dur.ok_or("Outro ohne Länge (outroDur)")?)
    } else {
        None
    };
    let d_i = id.map_or(0.0, |d| XF.min(d).min(len));
    let d_o = od.map_or(0.0, |d| XF.min(d).min(len));
    let off = id.map_or(0.0, |d| d - d_i);
    Ok(Timing {
        len,
        d_i,
        d_o,
        off,
        total: off + len + od.map_or(0.0, |d| d - d_o),
    })
}

/// Filtergraph bis zum Label [pre] (ohne Lautheit). inputs = Quellen in Eingangsreihenfolge: nicht stumme Spuren (alle, nicht nur Spur 1),
/// dann Intro, Outro, je Soundeffekt seine Datei. Schnitte einmal nach dem Mischen, zweistufig über √n Fenster (asplit flach wäre ~6× langsamer).
pub fn build_graph(ep: &Episode, o: &GraphOpts) -> Result<(Vec<String>, String), String> {
    let tracks: Vec<&PodTrack> = ep.tracks.iter().filter(|t| t.mute != Some(true)).collect();
    if tracks.is_empty() {
        return Err("Alle Spuren sind stumm, es gibt nichts zu exportieren.".into());
    }
    let keep = keep_ranges(&ep.cuts, ep.duration);
    if keep.is_empty() {
        return Err("Die Schnitte entfernen die ganze Episode.".into());
    }
    let t = timing(ep, o)?;
    let mut inputs: Vec<String> = tracks.iter().map(|x| x.src.clone()).collect();
    let mut g: Vec<String> = Vec::new();
    for (i, x) in tracks.iter().enumerate() {
        g.push(format!(
            "[{i}:a]{FMT},volume={}dB[tr{i}]",
            num(x.gain.unwrap_or(0.0))
        ));
    }
    g.push(if tracks.len() > 1 {
        format!(
            "{}amix=inputs={}:normalize=0:duration=longest[mix]",
            (0..tracks.len())
                .map(|i| format!("[tr{i}]"))
                .collect::<String>(),
            tracks.len()
        )
    } else {
        "[tr0]anull[mix]".into()
    });
    let k = (keep.len() as f64).sqrt().ceil() as usize;
    let gn = keep.len().div_ceil(k);
    g.push(format!(
        "[mix]asplit={gn}{}",
        (0..gn).map(|i| format!("[g{i}]")).collect::<String>()
    ));
    for i in 0..gn {
        let ks = &keep[i * k..(i * k + k).min(keep.len())];
        g.push(format!(
            "[g{i}]atrim=start={}:end={},asplit={}{}",
            sec(ks[0][0]),
            sec(ks[ks.len() - 1][1]),
            ks.len(),
            (0..ks.len())
                .map(|j| format!("[k{}]", i * k + j))
                .collect::<String>()
        ));
    }
    for (j, &[a, b]) in keep.iter().enumerate() {
        let d = SEAM.min((b - a) / 2.0);
        let fin = if j > 0 || a > 0.0 {
            format!(",afade=t=in:d={}", num(d))
        } else {
            String::new()
        };
        let fout = if j < keep.len() - 1 || b < ep.duration {
            format!(",afade=t=out:st={}:d={}", sec(b - a - d), num(d))
        } else {
            String::new()
        };
        g.push(format!(
            "[k{j}]atrim=start={}:end={},asetpts=PTS-STARTPTS{fin}{fout}[s{j}]",
            sec(a),
            sec(b)
        ));
    }
    g.push(format!(
        "{}concat=n={}:v=0:a=1[cut]",
        (0..keep.len())
            .map(|j| format!("[s{j}]"))
            .collect::<String>(),
        keep.len()
    ));
    let chain = match ep.ton.unwrap_or(PodTon::Klar) {
        PodTon::Original => "anull".to_string(),
        PodTon::Stark => SPEECH.replace("nr=12", "nr=20"),
        PodTon::Klar => SPEECH.into(),
    };
    g.push(format!("[cut]{chain}[sp]"));
    let mut cur = "sp";
    if let Some(intro) = ep.intro.as_ref().filter(|s| !s.is_empty()) {
        g.push(format!(
            "[{}:a]{FMT}[intro];[intro][{cur}]acrossfade=d={}[wi]",
            inputs.len(),
            num(t.d_i)
        ));
        inputs.push(intro.clone());
        cur = "wi";
    }
    if let Some(outro) = ep.outro.as_ref().filter(|s| !s.is_empty()) {
        g.push(format!(
            "[{}:a]{FMT}[outro];[{cur}][outro]acrossfade=d={}[wo]",
            inputs.len(),
            num(t.d_o)
        ));
        inputs.push(outro.clone());
        cur = "wo";
    }
    // sfx in einem Schnitt fallen weg (wie im Lint)
    let cuts = norm_cuts(&ep.cuts, ep.duration);
    let mut fx = Vec::new();
    for s in ep.sfx.iter().flatten().filter(|s| !in_cut(s.at, &cuts)) {
        inputs.push(s.src.clone());
        fx.push(Fx {
            input: inputs.len() - 1,
            at: to_edited(s.at, &ep.cuts, ep.duration) + t.off,
            gain: s.gain,
        });
    }
    g.push(sfx_graph(cur, &fx, "fx"));
    g.push(match o.music {
        Some(v) => duck_music("fx", &format!("{}:a", inputs.len()), v, t.total, "pre"),
        None => "[fx]anull[pre]".into(),
    });
    Ok((inputs, g.join(";\n")))
}

/// loudnorm-Filter (ohne Messwerte)
pub fn norm(i: f64) -> String {
    format!("loudnorm=I={}:TP=-1.5:LRA=11", num(i))
}
/// Messlauf: args = Eingänge, graph_args = Graph-Datei mit `,{norm}:print_format=json` vor [a] (siehe graph_file)
pub fn measure_args(args: &[String], graph_args: &[String]) -> Vec<String> {
    let mut a: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-progress",
        "pipe:1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.extend_from_slice(args);
    a.extend_from_slice(graph_args);
    a.extend(
        ["-map", "[a]", "-f", "null", "-"]
            .iter()
            .map(|s| s.to_string()),
    );
    a
}
/// Lautheitskette für den Endlauf aus dem stderr des Messlaufs (mit führendem Komma); still/fehlend → dynamisch in einem Durchgang
pub fn measured_norm(i: f64, stderr: &str) -> String {
    let v: Vec<f64> = [
        "input_i",
        "input_tp",
        "input_lra",
        "input_thresh",
        "target_offset",
    ]
    .iter()
    .map(|k| {
        let pat = format!("\"{k}\" : \"");
        stderr
            .find(&pat)
            .and_then(|p| stderr[p + pat.len()..].split('"').next())
            .map_or(f64::NAN, dw_timeline::media::js_number)
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
/// Inhalt der Graph-Datei: Graph + `[pre]anull{loud}[a]`
pub fn graph_file(graph: &str, loud: &str) -> String {
    format!("{graph};\n[pre]anull{loud}[a]")
}

/// ffmpeg 7 ersetzt -filter_complex_script durch -/filter_complex (9 kennt das alte nicht mehr)
pub fn script_flag(version_out: &str) -> &'static str {
    let v = version_out
        .split("version ")
        .nth(1)
        .map(|s| s.trim_start_matches('n'));
    let major = v
        .and_then(|s| s.split('.').next())
        .and_then(|s| s.parse::<u32>().ok());
    match major {
        Some(m) if m < 7 => "-filter_complex_script",
        _ => "-/filter_complex",
    }
}
/// libmp3lame in `ffmpeg -encoders`? Befund K23 (§7.2): TS cachte auch eine fehlgeschlagene Abfrage; der Aufrufer cacht hier nur Erfolge.
pub fn has_lame(encoders: &str) -> bool {
    encoders.split_whitespace().any(|w| w == "libmp3lame")
}

/// Kapitel in Sekunden der fertigen Datei; in einem Schnitt zählt dessen Anfang, ein Kapitel ganz vorn umfasst das Intro
pub fn chapter_marks(ep: &Episode, t: &Timing) -> Vec<Chapter> {
    let mut cs: Vec<Chapter> = ep
        .chapters
        .iter()
        .flatten()
        .map(|c| {
            let e = to_edited(c.at, &ep.cuts, ep.duration);
            Chapter {
                at: if e > 0.0 { e + t.off } else { 0.0 },
                title: c.title.clone(),
            }
        })
        .collect();
    cs.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap_or(std::cmp::Ordering::Equal));
    cs
}
// FFMETADATA: = ; # \ und Zeilenumbruch mit Backslash schützen
fn meta_esc(s: &str) -> String {
    s.chars().fold(String::new(), |mut o, c| {
        if "=;#\\\n".contains(c) {
            o.push('\\');
        }
        o.push(c);
        o
    })
}
/// FFMETADATA mit Titel und Kapiteln (ms)
pub fn meta_txt(title: &str, chapters: &[Chapter], total: f64) -> String {
    let mut l = vec![
        ";FFMETADATA1".to_string(),
        format!("title={}", meta_esc(title)),
    ];
    for (i, c) in chapters.iter().enumerate() {
        let end = chapters.get(i + 1).map_or(total, |n| n.at);
        l.extend([
            "[CHAPTER]".into(),
            "TIMEBASE=1/1000".into(),
            format!("START={}", num(round(c.at * 1000.0))),
            format!("END={}", num(round(end * 1000.0))),
            format!("title={}", meta_esc(&c.title)),
        ]);
    }
    l.push(String::new());
    l.join("\n")
}
/// Kapitel als Podcasting-2.0-JSON
pub fn chapters_json(chapters: &[Chapter]) -> String {
    let cs: Vec<serde_json::Value> = chapters.iter().map(|c| serde_json::json!({ "startTime": to_fixed(c.at, 3).parse::<f64>().unwrap(), "title": c.title })).collect();
    serde_json::to_string_pretty(&serde_json::json!({ "version": "1.2.0", "chapters": cs }))
        .unwrap()
}
/// Kodierung der Episode
pub fn encode_args(format: &str) -> Vec<String> {
    let a: &[&str] = if format == "mp3" {
        &["-c:a", "libmp3lame", "-b:a", "128k"]
    } else {
        &["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
    };
    a.iter().map(|s| s.to_string()).collect()
}

/// Wellenform der Episode: Betragsmaximum je 1/50 s, 0..1 auf 3 Stellen; dauer aus der Sample-Zahl (mono 8 kHz)
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Peaks {
    pub duration: f64,
    pub rate: f64,
    pub data: Vec<f64>,
}
pub fn peaks_args(file: &str) -> Vec<String> {
    [
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-i",
        file,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "f32le",
        "pipe:1",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}
pub fn peaks(r: impl std::io::Read) -> std::io::Result<Peaks> {
    let (m, total) = dw_timeline::media::window_peaks(r, 160)?;
    Ok(Peaks {
        duration: total as f64 / 8000.0,
        rate: 50.0,
        data: m
            .into_iter()
            .map(|x| round(1f64.min(x as f64) * 1000.0) / 1000.0)
            .collect(),
    })
}

/// Vorhören: eine nicht stumme Spur ohne gain = die Originaldatei (None); sonst Mix aller nicht stummen Spuren (Opus 64k mono) nach tmp
pub fn preview_mix_args(
    ep: &Episode,
    files: &[String],
    tmp: &str,
) -> Result<Option<Vec<String>>, String> {
    let tracks: Vec<&PodTrack> = ep.tracks.iter().filter(|t| t.mute != Some(true)).collect();
    if tracks.is_empty() {
        return Err("Alle Spuren sind stumm.".into());
    }
    if tracks.len() == 1 && tracks[0].gain.is_none_or(|g| g == 0.0 || g.is_nan()) {
        return Ok(None);
    }
    let mut g = tracks
        .iter()
        .enumerate()
        .map(|(i, t)| format!("[{i}:a]{FMT},volume={}dB[t{i}]", num(t.gain.unwrap_or(0.0))))
        .collect::<Vec<_>>()
        .join(";");
    g += &if tracks.len() > 1 {
        format!(
            ";{}amix=inputs={}:normalize=0:duration=longest[a]",
            (0..tracks.len())
                .map(|i| format!("[t{i}]"))
                .collect::<String>(),
            tracks.len()
        )
    } else {
        ";[t0]anull[a]".into()
    };
    let mut a: Vec<String> = files
        .iter()
        .flat_map(|f| ["-i".to_string(), f.clone()])
        .collect();
    a.extend([
        "-filter_complex".into(),
        g,
        "-map".into(),
        "[a]".into(),
        "-ac".into(),
        "1".into(),
        "-c:a".into(),
        "libopus".into(),
        "-b:a".into(),
        "64k".into(),
        tmp.into(),
    ]);
    Ok(Some(a))
}
