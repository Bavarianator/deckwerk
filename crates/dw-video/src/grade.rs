//! Farbkorrektur (`shared/grade.ts`): Tabellen je Kanal (lift/gamma/gain/temp) und Sättigungsmatrix, gleich für Vorschau
//! (SVG feComponentTransfer + feColorMatrix) und Export (ffmpeg lut1d + colorchannelmixer). Eingang und Ausgang sRGB.

use crate::{clamp, num, round};
use serde::{Deserialize, Serialize};

pub type Rgb = [f64; 3];

/// Grenzen wie `TL` in `shared/timeline.ts`
pub const LIFT: (f64, f64) = (-0.5, 0.5);
pub const GAMMA: (f64, f64) = (0.5, 2.0);
pub const GAIN: (f64, f64) = (0.5, 2.0);
pub const SAT: (f64, f64) = (0.0, 2.0);
pub const TEMP: (f64, f64) = (-1.0, 1.0);

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Grade {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lift: Option<Rgb>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gamma: Option<Rgb>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gain: Option<Rgb>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sat: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temp: Option<f64>,
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-4
}

fn rgb(v: Option<Rgb>, d: f64, lim: (f64, f64)) -> Rgb {
    [0, 1, 2].map(|i| clamp(v.map_or(d, |v| v[i]), lim.0, lim.1))
}

fn sat_of(sat: Option<f64>) -> f64 {
    clamp(sat.unwrap_or(1.0), SAT.0, SAT.1)
}

pub fn is_neutral(g: Option<&Grade>) -> bool {
    let Some(g) = g else { return true };
    rgb(g.lift, 0.0, LIFT).iter().all(|v| near(*v, 0.0))
        && rgb(g.gamma, 1.0, GAMMA).iter().all(|v| near(*v, 1.0))
        && rgb(g.gain, 1.0, GAIN).iter().all(|v| near(*v, 1.0))
        && near(sat_of(g.sat), 1.0)
        && near(clamp(g.temp.unwrap_or(0.0), TEMP.0, TEMP.1), 0.0)
}

/// Je Kanal 256 Ausgangswerte: y = gain·(x + lift·(1−x)), geklemmt, dann ^(1/gamma); temp > 0 wärmer
pub fn grade_tables(g: Option<&Grade>) -> [[u8; 256]; 3] {
    let lift = rgb(g.and_then(|g| g.lift), 0.0, LIFT);
    let gamma = rgb(g.and_then(|g| g.gamma), 1.0, GAMMA);
    let gain = rgb(g.and_then(|g| g.gain), 1.0, GAIN);
    let temp = clamp(g.and_then(|g| g.temp).unwrap_or(0.0), TEMP.0, TEMP.1);
    let k = [1.0 + 0.1 * temp, 1.0, 1.0 - 0.1 * temp];
    [0, 1, 2].map(|c| {
        let mut t = [0u8; 256];
        for (i, v) in t.iter_mut().enumerate() {
            let x = i as f64 / 255.0;
            let y = clamp(gain[c] * k[c] * (x + lift[c] * (1.0 - x)), 0.0, 1.0);
            *v = round(libm::pow(y, 1.0 / gamma[c]) * 255.0) as u8;
        }
        t
    })
}

/// Sättigung als 3×3-Matrix (zeilenweise): M = (1−s)·L + s·I mit Rec.709-Luma
pub fn sat_matrix(sat: Option<f64>) -> [f64; 9] {
    let s = sat_of(sat);
    let l = [0.2126, 0.7152, 0.0722];
    std::array::from_fn(|i| (1.0 - s) * l[i % 3] + if i / 3 == i % 3 { s } else { 0.0 })
}

fn fx4(v: f64) -> String {
    num(dw_lint::js::to_fixed(v, 4).parse().unwrap_or(f64::NAN))
}

/// ffmpeg-Filter für die Sättigung, None wenn neutral
pub fn sat_filter(sat: Option<f64>) -> Option<String> {
    if near(sat_of(sat), 1.0) {
        return None;
    }
    let m = sat_matrix(sat);
    let k = ["rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb"];
    Some(format!(
        "colorchannelmixer={}",
        k.iter()
            .enumerate()
            .map(|(i, n)| format!("{n}={}", fx4(m[i])))
            .collect::<Vec<_>>()
            .join(":")
    ))
}

/// Inhalt einer .cube-Datei für ffmpeg lut1d
pub fn cube1d(g: Option<&Grade>) -> String {
    let [r, gr, b] = grade_tables(g);
    let f = |v: u8| dw_lint::js::to_fixed(v as f64 / 255.0, 6);
    let mut rows = vec!["LUT_1D_SIZE 256".to_string()];
    rows.extend((0..256).map(|i| format!("{} {} {}", f(r[i]), f(gr[i]), f(b[i]))));
    rows.join("\n") + "\n"
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SvgTables {
    pub r: String,
    pub g: String,
    pub b: String,
}

/// tableValues je Kanal für feComponentTransfer type=table
pub fn svg_tables(g: Option<&Grade>) -> SvgTables {
    let t = grade_tables(g).map(|t| {
        t.iter()
            .map(|v| dw_lint::js::to_fixed(*v as f64 / 255.0, 4))
            .collect::<Vec<_>>()
            .join(" ")
    });
    let [r, g, b] = t;
    SvgTables { r, g, b }
}

/// Tabellen und Sättigung in place auf RGBA-Pixel (Uint8ClampedArray: runden halb-gerade, klemmen)
pub fn apply_tables(data: &mut [u8], t: &[[u8; 256]; 3], sat: Option<f64>) {
    let m = (!near(sat_of(sat), 1.0)).then(|| sat_matrix(sat));
    let c8 = |v: f64| v.clamp(0.0, 255.0).round_ties_even() as u8;
    for px in data.chunks_exact_mut(4) {
        let (r, g, b) = (
            t[0][px[0] as usize],
            t[1][px[1] as usize],
            t[2][px[2] as usize],
        );
        let Some(m) = m else {
            px[..3].copy_from_slice(&[r, g, b]);
            continue;
        };
        let (r, g, b) = (r as f64, g as f64, b as f64);
        px[0] = c8(m[0] * r + m[1] * g + m[2] * b);
        px[1] = c8(m[3] * r + m[4] * g + m[5] * b);
        px[2] = c8(m[6] * r + m[7] * g + m[8] * b);
    }
}

/// Zurückhaltende Annäherungen an die Clip-Looks
pub fn grade_preset(name: &str) -> Option<Grade> {
    let all = |v: f64| Some([v, v, v]);
    Some(match name {
        "neutral" => Grade::default(),
        "warm" => Grade {
            temp: Some(0.5),
            ..Default::default()
        },
        "kuehl" => Grade {
            temp: Some(-0.5),
            ..Default::default()
        },
        "kontrast" => Grade {
            lift: all(-0.057),
            gain: all(1.06),
            sat: Some(1.15),
            ..Default::default()
        },
        "matt" => Grade {
            lift: all(0.064),
            gain: all(0.94),
            sat: Some(0.85),
            ..Default::default()
        },
        "sw" => Grade {
            lift: all(-0.038),
            gain: all(1.04),
            sat: Some(0.0),
            ..Default::default()
        },
        _ => return None,
    })
}
