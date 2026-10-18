//! Medien-Helfer (`main/timeline-media.ts`): Wellenform-Spitzen, Schnitt-Proxys, R128-Messung.
//! Nur Argumente und Auswertung; den ffmpeg-Prozess startet der Aufrufer.

use dw_lint::js::round;
use std::io::Read;

fn s(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| x.to_string()).collect()
}

/// ffmpeg-Argumente: Ton mono mit 8 kHz als f32le auf stdout
pub fn peaks_args(file: &str) -> Vec<String> {
    s(&[
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-f",
        "f32le",
        "pipe:1",
    ])
}

/// Betragsmaxima je `win` Samples aus einem f32le-Strom, gestreamt (das PCM liegt nie ganz im Speicher). Zweiter Wert: Samples gesamt.
pub fn window_peaks(mut r: impl Read, win: usize) -> std::io::Result<(Vec<f32>, usize)> {
    let (mut out, mut max, mut n, mut total) = (Vec::new(), 0f32, 0usize, 0usize);
    let mut buf = vec![0u8; 1 << 16];
    let mut rest = 0usize; // Bytes eines Floats, der über die Chunk-Grenze reicht
    loop {
        let k = r.read(&mut buf[rest..])?;
        if k == 0 {
            break;
        }
        let len = rest + k;
        let end = len & !3;
        for c in buf[..end].chunks_exact(4) {
            let x = f32::from_le_bytes([c[0], c[1], c[2], c[3]]).abs();
            if x > max {
                max = x;
            }
            n += 1;
            if n == win {
                out.push(max);
                max = 0.0;
                n = 0;
            }
        }
        total += end / 4;
        buf.copy_within(end..len, 0);
        rest = len - end;
    }
    if n > 0 {
        out.push(max);
    }
    Ok((out, total))
}

/// Wellenform der Timeline: je 1/per_sec s das Maximum als 0..255
pub fn peaks(r: impl Read, per_sec: f64) -> std::io::Result<Vec<u8>> {
    let win = 1f64.max(round(8000.0 / per_sec)) as usize;
    Ok(window_peaks(r, win)?
        .0
        .into_iter()
        .map(|m| round(1f64.min(m as f64) * 255.0) as u8)
        .collect())
}

/// Proxy nötig: kurze Seite über 1080 oder ein schwer dekodierbarer Codec (ProRes, DNxHD, HEVC 10 bit)
pub fn needs_proxy(w: f64, h: f64, codec: Option<&str>) -> bool {
    if w.min(h) > 1080.0 {
        return true;
    }
    let Some(c) = codec else { return false };
    let c = c.to_lowercase();
    let hevc = c.contains("hevc") || c.contains("h265") || c.contains("h.265");
    let ten = c.contains("10le")
        || c.contains("main10")
        || c.contains("main 10")
        || ["10bit", "10-bit", "10 bit"].iter().any(|x| c.contains(x));
    c.contains("prores") || c.contains("dnxh") || (hevc && ten)
}

/// Schnitt-Proxy: kurze Seite 540, H.264 ultrafast crf 28, AAC 128k, faststart; tmp ist die Teildatei neben dem Ziel
pub fn proxy_args(file: &str, tmp: &str) -> Vec<String> {
    s(&[
        "-i",
        file,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        "scale='if(gt(iw,ih),-2,540)':'if(gt(iw,ih),540,-2)'",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "28",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        tmp,
    ])
}

/// EBU R128 (loudnorm, erster Durchgang)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct R128 {
    pub i: f64,
    pub lra: f64,
    pub tp: f64,
    pub thresh: f64,
    pub offset: f64,
}

pub fn r128_args(file: &str) -> Vec<String> {
    s(&[
        "-hide_banner",
        "-nostdin",
        "-nostats",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-vn",
        "-af",
        "loudnorm=I=-23:print_format=json",
        "-f",
        "null",
        "-",
    ])
}

/// `+text` in JS: "-inf" und "nan" werden NaN, nicht ±∞ wie in Rust
pub fn js_number(t: &str) -> f64 {
    let t = dw_lint::js::trim(t);
    match t {
        "" => 0.0,
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ if t
            .bytes()
            .all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) =>
        {
            t.parse().unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    }
}

/// JSON-Block von loudnorm aus stderr; None, wenn er fehlt
pub fn parse_r128(stderr: &str) -> Option<R128> {
    let k = stderr.find("\"input_i\"")?;
    let a = stderr[..k].rfind('{')?;
    let b = k + stderr[k..].find('}')?;
    let block = &stderr[a..=b];
    if block[1..block.len() - 1].contains(['{', '}']) {
        return None;
    }
    let j: serde_json::Map<String, serde_json::Value> = serde_json::from_str(block).ok()?;
    let g = |k: &str| {
        j.get(k)
            .and_then(|v| v.as_str())
            .map_or(f64::NAN, js_number)
    };
    Some(R128 {
        i: g("input_i"),
        lra: g("input_lra"),
        tp: g("input_tp"),
        thresh: g("input_thresh"),
        offset: g("target_offset"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peaks_ueber_chunkgrenzen() {
        // Reader, der in 3-Byte-Stücken liefert: Floats reichen über Grenzen
        struct Drip(Vec<u8>, usize);
        impl Read for Drip {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                let n = 3.min(self.0.len() - self.1).min(b.len());
                b[..n].copy_from_slice(&self.0[self.1..self.1 + n]);
                self.1 += n;
                Ok(n)
            }
        }
        let xs: Vec<u8> = [0.5f32, -1.0, 0.25, 2.0, -0.1]
            .iter()
            .flat_map(|x| x.to_le_bytes())
            .collect();
        let (m, total) = window_peaks(Drip(xs, 0), 2).unwrap();
        assert_eq!((m, total), (vec![1.0, 2.0, 0.1], 5));
        assert!(needs_proxy(3840.0, 2160.0, None));
        assert!(needs_proxy(
            1920.0,
            1080.0,
            Some("Video: hevc (Main 10), yuv420p10le")
        ));
        assert!(!needs_proxy(1920.0, 1080.0, Some("Video: h264 (High)")));
        let r = parse_r128("x\n{\n\"input_i\" : \"-inf\",\n\"input_tp\" : \"-1.5\",\n\"input_lra\" : \"0.00\",\n\"input_thresh\" : \"-70.0\",\n\"target_offset\" : \"inf\"\n}\n").unwrap();
        assert!(r.i.is_nan() && r.offset.is_nan() && r.tp == -1.5);
    }
}
