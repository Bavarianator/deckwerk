//! Spracherkennung am PC (`sherpa.ts`/`sherpa-worker.ts`): Silero-VAD teilt 16 kHz mono f32 in Sprachstücke, Parakeet
//! (nemo_transducer über sherpa-onnx) erkennt sie. Ergebnis wie TS: Segmente = Sätze mit echten Wortzeiten.
//! ponytail: nur Parakeet/fc-de (gleiche Dateinamen) + Wortzeiten; Whisper-Fallback (`transcribe.ts`), CED-Tagging,
//! Diarisierung, TTS, Streaming, Modell-Download und eigener Worker-Prozess fehlen – nachziehen, wenn ein Aufrufer sie braucht.

use dw_video::ffmpeg::{self, Cancel, Error, Result};
use dw_video::{Segment, Word};
use regex::Regex;
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, SileroVadModelConfig, VadModelConfig,
    VoiceActivityDetector,
};
use std::path::Path;
use std::sync::LazyLock;

pub const SR: usize = 16000;
const WINDOW: usize = 512;
const MAX: usize = 30 * SR;
const GAP: usize = 2 * SR;
const ASR: [&str; 4] = [
    "encoder.int8.onnx",
    "decoder.int8.onnx",
    "joiner.int8.onnx",
    "tokens.txt",
];

/// 16 kHz mono f32 aus einer Mediendatei (ffmpeg, stdout)
pub fn pcm(file: &Path, cancel: &Cancel) -> Result<Vec<f32>> {
    let args: Vec<String> = [
        "-i",
        &ffmpeg::input_path(file),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "f32le",
        "pipe:1",
    ]
    .map(String::from)
    .to_vec();
    let out = ffmpeg::run(&args, None, cancel)?;
    Ok(out
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// Fehlende Modelldateien unter `models` (Erkennung in `models/<dir>`, VAD in `models/silero-vad`) als saubere Meldung
fn check_models(models: &Path, dir: &str) -> Result<()> {
    let missing: Vec<String> = ASR
        .iter()
        .map(|f| models.join(dir).join(f))
        .chain([models.join("silero-vad/silero_vad.onnx")])
        .filter(|p| !p.is_file())
        .map(|p| p.display().to_string())
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(Error::Missing(format!(
            "Spracherkennungs-Modell fehlt: {}",
            missing.join(", ")
        )))
    }
}

/// Transkript aus 16 kHz mono f32 (`dir`: Modellordner, z. B. `parakeet-ultra` oder `fc-de`). Zeiten in s + offset.
/// memCheck aus sherpa.ts: vor dem Laden des Modells genug freien Speicher verlangen (nur Linux, sonst ohne Prüfung).
fn mem_check(need_gb: f64) -> Result<()> {
    let Ok(info) = std::fs::read_to_string("/proc/meminfo") else {
        return Ok(());
    };
    let Some(kb) = info.lines().find_map(|l| {
        l.strip_prefix("MemAvailable:")?
            .trim()
            .strip_suffix("kB")?
            .trim()
            .parse::<f64>()
            .ok()
    }) else {
        return Ok(());
    };
    let gb = kb / 1024f64.powi(2);
    if gb < need_gb {
        return Err(Error::Media(format!(
            "Zu wenig freier Arbeitsspeicher für die Audio-Analyse ({} GB frei, nötig ca. {} GB). Andere Programme schließen und erneut versuchen.",
            format!("{gb:.1}").replace('.', ","),
            need_gb.to_string().replace('.', ",")
        )));
    }
    Ok(())
}

pub fn asr(
    pcm: &[f32],
    models: &Path,
    dir: &str,
    offset: f64,
    threads: i32,
) -> Result<Vec<Segment>> {
    check_models(models, dir)?;
    mem_check(1.5)?;
    let s = |p: &Path| Some(p.to_string_lossy().into_owned());
    let m = models.join(dir);
    let mut cfg = OfflineRecognizerConfig::default();
    cfg.model_config.transducer.encoder = s(&m.join("encoder.int8.onnx"));
    cfg.model_config.transducer.decoder = s(&m.join("decoder.int8.onnx"));
    cfg.model_config.transducer.joiner = s(&m.join("joiner.int8.onnx"));
    cfg.model_config.tokens = s(&m.join("tokens.txt"));
    cfg.model_config.num_threads = threads;
    cfg.model_config.provider = Some("cpu".into());
    cfg.model_config.model_type = Some("nemo_transducer".into());
    let rec = OfflineRecognizer::create(&cfg)
        .ok_or_else(|| Error::Media(format!("Erkennungsmodell nicht ladbar: {}", m.display())))?;
    // Pausen ab 0,4 s schneiden, Stücke höchstens 20 s; Folgestücke mit Pausen bis 2 s gemeinsam erkennen (bis 30 s),
    // sonst setzt Parakeet an jeder Pause einen Punkt (Gründe in sherpa-worker.ts)
    let vad = VoiceActivityDetector::create(
        &VadModelConfig {
            silero_vad: SileroVadModelConfig {
                model: s(&models.join("silero-vad/silero_vad.onnx")),
                threshold: 0.5,
                min_silence_duration: 0.4,
                min_speech_duration: 0.25,
                window_size: WINDOW as i32,
                max_speech_duration: 20.0,
            },
            sample_rate: SR as i32,
            num_threads: 1,
            ..Default::default()
        },
        60.0,
    )
    .ok_or_else(|| Error::Media("Silero-VAD nicht ladbar".into()))?;
    let decode = |(a, b): (usize, usize), out: &mut Vec<Segment>| {
        let st = rec.create_stream();
        st.accept_waveform(SR as i32, &pcm[a..b]);
        rec.decode(&st);
        if let Some(r) = st.get_result() {
            let ts: Vec<Option<f64>> = r
                .timestamps
                .unwrap_or_default()
                .iter()
                .map(|&t| fin(t))
                .collect();
            let ds = r
                .durations
                .map(|d| d.iter().map(|&t| fin(t)).collect::<Vec<_>>());
            let t0 = offset + a as f64 / SR as f64;
            out.extend(sentences(&words(
                &r.tokens,
                &ts,
                ds.as_deref(),
                t0,
                offset + b as f64 / SR as f64,
            )));
        }
    };
    let drain = |cur: &mut Option<(usize, usize)>, out: &mut Vec<Segment>| {
        while let Some(seg) = vad.front() {
            vad.pop();
            let start = seg.start().max(0) as usize;
            let end = (start + seg.samples().len()).min(pcm.len());
            if let Some(c) = *cur
                && (end - c.0 > MAX || start.saturating_sub(c.1) > GAP)
            {
                decode(c, out);
                *cur = None;
            }
            *cur = Some((cur.map_or(start, |c| c.0), end));
        }
    };
    let (mut out, mut cur) = (Vec::new(), None);
    for w in pcm.chunks(WINDOW) {
        vad.accept_waveform(w);
        drain(&mut cur, &mut out);
    }
    vad.flush();
    drain(&mut cur, &mut out);
    if let Some(c) = cur {
        decode(c, &mut out);
    }
    Ok(out)
}

fn fin(t: f32) -> Option<f64> {
    t.is_finite().then_some(t as f64)
}

fn at(s: f64) -> f64 {
    (s * 100.0).round() / 100.0
}

static PUNCT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[.,!?;:…]+$").unwrap());
static LETTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]").unwrap());

/// Wörter aus SentencePiece-Token (auch die Handy-Ergebnisse von dw-phone): ▁ bzw. Leerzeichen beginnt ein Wort,
/// Satzzeichen hängen am vorigen. Zeitstempel None (nan) zählen wie in TS als 0. t0/t1 = Stück in s.
pub fn words(
    tokens: &[String],
    ts: &[Option<f64>],
    durs: Option<&[Option<f64>]>,
    t0: f64,
    t1: f64,
) -> Vec<Word> {
    let mut out: Vec<Word> = Vec::new();
    let mut gap = true; // Ziffern stehen nur ohne ▁ im Vokabular und folgen einem einzelnen ▁
    for (i, tok) in tokens.iter().enumerate() {
        let start = t0 + ts.get(i).copied().flatten().unwrap_or(0.0);
        let d = durs
            .and_then(|d| d.get(i).copied().flatten())
            .unwrap_or(0.0);
        let end = t1.min(start + d);
        let piece = tok.replace('▁', " ");
        let t = piece.trim();
        if piece.starts_with(char::is_whitespace) {
            gap = true;
        }
        if t.is_empty() {
            continue;
        }
        match out.last_mut() {
            Some(last) if !(gap && !PUNCT.is_match(t)) => {
                last.w.push_str(t);
                if LETTER.is_match(t) {
                    last.end = last.end.max(end); // Satzzeichen verlängern das Wort nicht
                }
            }
            _ => out.push(Word {
                w: t.into(),
                start,
                end,
            }),
        }
        gap = false;
    }
    for i in 0..out.len() {
        // ohne Token-Dauer (kein TDT) bis zum Folgewort, nie darüber hinaus
        let next = out.get(i + 1).map_or(t1, |w| w.start);
        if out[i].end <= out[i].start {
            out[i].end = out[i].start + 0.3;
        }
        out[i].end = at(out[i].end.min(next));
        out[i].start = at(out[i].start);
    }
    out
}

static ABBR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:z\.B|d\.h|u\.a|i\.d\.R|u\.U|v\.a|z\.T|o\.ä|usw|bzw|ca|Dr|Nr|Prof|Hr|Fr|St|Str|vgl|ggf|evtl|inkl|zzgl|bspw|sog|Mio|Mrd|Mr|Mrs|Ms|vs|Abs|Tel)\.$").unwrap()
});
static MONTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\P{L}*$").unwrap()
});
static ORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{1,3}\.$").unwrap());
static LOWER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{Ll}").unwrap());

/// Punkt an ws[i] beendet keinen Satz: Abkürzung (auch über Wörter, „z.“ + „B.“) oder Ordinalzahl vor kleinem Wort bzw. Monat
fn no_end(ws: &[Word], i: usize) -> bool {
    let next = ws.get(i + 1).map_or("", |w| w.w.as_str());
    if ORD.is_match(&ws[i].w) {
        return LOWER.is_match(next) || MONTH.is_match(next);
    }
    (i.saturating_sub(2)..=i).any(|a| {
        (i..=(ws.len() - 1).min(a + 2))
            .any(|b| ABBR.is_match(&ws[a..=b].iter().map(|w| w.w.as_str()).collect::<String>()))
    })
}

/// Segmente = Sätze (Bruch nach . ! ? …)
pub fn sentences(ws: &[Word]) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut from = 0;
    for (i, w) in ws.iter().enumerate() {
        let w = &w.w;
        if i + 1 == ws.len() || w.ends_with(['!', '?', '…']) || (w.ends_with('.') && !no_end(ws, i))
        {
            let cur = &ws[from..=i];
            out.push(Segment {
                start: cur[0].start,
                end: cur[cur.len() - 1].end,
                text: cur
                    .iter()
                    .map(|w| w.w.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                words: Some(cur.to_vec()),
                speaker: None,
            });
            from = i + 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn woerter_und_saetze() {
        // Parakeet-Token mit Dauer (TDT), Ziffern nach einzelnem ▁, Abkürzung über zwei Wörter, nan als None
        let t = tok(&[
            "▁Wir",
            "▁treffen",
            "▁uns",
            "▁z",
            ".",
            "▁B",
            ".",
            "▁am",
            "▁",
            "3",
            ".",
            "▁Oktober",
            ".",
            "▁Gut",
            "?",
            "▁Ja",
        ]);
        let ts: Vec<Option<f64>> = (0..t.len()).map(|i| Some(i as f64 * 0.2)).collect();
        let ds = vec![Some(0.15); t.len()];
        let ws = words(&t, &ts, Some(&ds), 10.0, 14.0);
        let w: Vec<&str> = ws.iter().map(|w| w.w.as_str()).collect();
        assert_eq!(
            w,
            [
                "Wir", "treffen", "uns", "z.", "B.", "am", "3.", "Oktober.", "Gut?", "Ja"
            ]
        );
        assert_eq!((ws[0].start, ws[0].end), (10.0, 10.15));
        assert_eq!((ws[6].start, ws[6].end), (11.8, 11.95)); // „▁“ ohne Text: Ziffer beginnt das Wort
        let s = sentences(&ws);
        let txt: Vec<&str> = s.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(txt, ["Wir treffen uns z. B. am 3. Oktober.", "Gut?", "Ja"]);
        assert_eq!((s[1].start, s[1].end), (12.6, 12.75));
        // ohne Dauer (fc-de) und mit nan: 0,3 s, höchstens bis zum Folgewort bzw. Stückende
        let ws = words(
            &tok(&["▁Hallo", "▁,", "▁Welt"]),
            &[Some(0.0), None, Some(0.2)],
            None,
            0.0,
            0.4,
        );
        assert_eq!(
            ws.iter().map(|w| (w.w.as_str(), w.end)).collect::<Vec<_>>(),
            [("Hallo,", 0.2), ("Welt", 0.4)]
        );
    }

    #[test]
    fn modell_fehlt() {
        let m = asr(
            &[0.0; 16000],
            Path::new("/gibt/es/nicht"),
            "parakeet-ultra",
            0.0,
            1,
        )
        .unwrap_err()
        .to_string();
        assert!(
            m.starts_with(
                "Spracherkennungs-Modell fehlt: /gibt/es/nicht/parakeet-ultra/encoder.int8.onnx"
            ),
            "{m}"
        );
        assert!(m.contains("silero_vad.onnx"), "{m}");
    }
}
