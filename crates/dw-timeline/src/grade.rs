//! Farbkorrektur (`shared/grade.ts`): dieselben Tabellen für Vorschau und Export (ffmpeg lut1d + colorchannelmixer).
//! Reihenfolge: erst Tabellen je Kanal (lift/gamma/gain/temp), dann Sättigungsmatrix. Ein- und Ausgang gamma-kodiertes sRGB.

use crate::model::*;
use dw_lint::js::{num, round, to_fixed};

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-4
}
fn rgb(v: Option<Rgb>, d: f64, lim: &Range) -> [f64; 3] {
    [0, 1, 2].map(|i| clamp(v.map_or(d, |v| v[i]), lim.min, lim.max))
}
fn sat_of(sat: Option<f64>) -> f64 {
    clamp(sat.unwrap_or(1.0), SAT.min, SAT.max)
}

pub fn is_neutral(g: Option<&Grade>) -> bool {
    let Some(g) = g else { return true };
    rgb(g.lift, 0.0, &LIFT).iter().all(|&v| near(v, 0.0))
        && rgb(g.gamma, 1.0, &GAMMA).iter().all(|&v| near(v, 1.0))
        && rgb(g.gain, 1.0, &GAIN).iter().all(|&v| near(v, 1.0))
        && near(sat_of(g.sat), 1.0)
        && near(clamp(g.temp.unwrap_or(0.0), TEMP.min, TEMP.max), 0.0)
}

/// Je Kanal 256 Ausgangswerte: y = gain·(x + lift·(1−x)), geklemmt, dann ^(1/gamma); temp > 0 verstärkt Rot, dämpft Blau
pub fn grade_tables(g: Option<&Grade>) -> [[u8; 256]; 3] {
    let lift = rgb(g.and_then(|g| g.lift), 0.0, &LIFT);
    let gamma = rgb(g.and_then(|g| g.gamma), 1.0, &GAMMA);
    let gain = rgb(g.and_then(|g| g.gain), 1.0, &GAIN);
    let temp = clamp(g.and_then(|g| g.temp).unwrap_or(0.0), TEMP.min, TEMP.max);
    let k = [1.0 + 0.1 * temp, 1.0, 1.0 - 0.1 * temp];
    [0, 1, 2].map(|c| {
        let mut t = [0u8; 256];
        for (i, v) in t.iter_mut().enumerate() {
            let x = i as f64 / 255.0;
            let y = clamp(gain[c] * k[c] * (x + lift[c] * (1.0 - x)), 0.0, 1.0);
            *v = round(y.powf(1.0 / gamma[c]) * 255.0) as u8;
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

/// ffmpeg-Filter für die Sättigung, None wenn neutral
pub fn sat_filter(sat: Option<f64>) -> Option<String> {
    if near(sat_of(sat), 1.0) {
        return None;
    }
    let m = sat_matrix(sat);
    let k = ["rr", "rg", "rb", "gr", "gg", "gb", "br", "bg", "bb"];
    let parts: Vec<String> = k
        .iter()
        .zip(m)
        .map(|(n, v)| format!("{n}={}", num(fixed(v, 4))))
        .collect();
    Some(format!("colorchannelmixer={}", parts.join(":")))
}

/// Inhalt einer .cube-Datei für ffmpeg lut1d
pub fn cube1d(g: Option<&Grade>) -> String {
    let [r, gr, b] = grade_tables(g);
    let mut s = String::from("LUT_1D_SIZE 256");
    for i in 0..256 {
        let row: Vec<String> = [r[i], gr[i], b[i]]
            .iter()
            .map(|&v| to_fixed(v as f64 / 255.0, 6))
            .collect();
        s.push('\n');
        s.push_str(&row.join(" "));
    }
    s.push('\n');
    s
}

/// Zurückhaltende Looks (GRADE_PRESETS); unbekannt = None
pub fn preset(name: &str) -> Option<Grade> {
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
