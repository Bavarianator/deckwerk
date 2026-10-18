//! Farbmathematik ohne culori: Hex, WCAG-Kontrast, OKLab/OKLCH, Mischen, Kontrast erzwingen, CIEDE2000.
//! Konstanten und Abläufe wie culori 4 (themes.ts, lint.ts, theme-lint.ts), damit Rust und TS dieselben Hexwerte liefern.

// Konstanten wörtlich aus culori, damit der Abgleich mit TS nachvollziehbar bleibt
#![allow(clippy::excessive_precision)]

use std::f64::consts::PI;

/// sRGB, 8 Bit je Kanal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Rgb {
    pub const BLACK: Rgb = Rgb {
        r: 0,
        g: 0,
        b: 0,
        a: 255,
    };
    pub const WHITE: Rgb = Rgb {
        r: 255,
        g: 255,
        b: 255,
        a: 255,
    };

    /// #rgb, #rrggbb, #rrggbbaa (Groß/klein egal, # optional).
    pub fn parse(s: &str) -> Option<Rgb> {
        let h = s.trim().strip_prefix('#').unwrap_or(s.trim());
        if !h.is_ascii() {
            return None;
        }
        let hex = |i: usize, n: usize| u8::from_str_radix(&h[i..i + n], 16).ok();
        match h.len() {
            3 => Some(Rgb {
                r: hex(0, 1)? * 17,
                g: hex(1, 1)? * 17,
                b: hex(2, 1)? * 17,
                a: 255,
            }),
            6 => Some(Rgb {
                r: hex(0, 2)?,
                g: hex(2, 2)?,
                b: hex(4, 2)?,
                a: 255,
            }),
            8 => Some(Rgb {
                r: hex(0, 2)?,
                g: hex(2, 2)?,
                b: hex(4, 2)?,
                a: hex(6, 2)?,
            }),
            _ => None,
        }
    }

    /// #rrggbb wie culori formatHex (Alpha fällt weg).
    pub fn to_hex(&self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }

    fn unit(&self) -> [f64; 3] {
        [self.r, self.g, self.b].map(|v| v as f64 / 255.0)
    }

    // culori fixup: begrenzen, dann runden
    fn from_unit(c: [f64; 3], a: u8) -> Rgb {
        let q = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        Rgb {
            r: q(c[0]),
            g: q(c[1]),
            b: q(c[2]),
            a,
        }
    }

    pub fn to_oklab(&self) -> Oklab {
        Oklab::from_linear(self.unit().map(to_linear))
    }
}

fn to_linear(c: f64) -> f64 {
    let abs = c.abs();
    if abs <= 0.04045 {
        c / 12.92
    } else {
        c.signum() * ((abs + 0.055) / 1.055).powf(2.4)
    }
}

fn from_linear(c: f64) -> f64 {
    let abs = c.abs();
    if abs > 0.0031308 {
        c.signum() * (1.055 * abs.powf(1.0 / 2.4) - 0.055)
    } else {
        c * 12.92
    }
}

/// Relative Luminanz nach WCAG.
pub fn luminance(c: Rgb) -> f64 {
    let [r, g, b] = c.unit().map(to_linear);
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// WCAG-Kontrast 1..21.
pub fn contrast(a: Rgb, b: Rgb) -> f64 {
    let (l1, l2) = (luminance(a), luminance(b));
    (l1.max(l2) + 0.05) / (l1.min(l2) + 0.05)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Oklab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

impl Oklab {
    fn from_linear([r, g, b]: [f64; 3]) -> Oklab {
        let l = (0.412221469470763 * r + 0.5363325372617348 * g + 0.0514459932675022 * b).cbrt();
        let m = (0.2119034958178252 * r + 0.6806995506452344 * g + 0.1073969535369406 * b).cbrt();
        let s = (0.0883024591900564 * r + 0.2817188391361215 * g + 0.6299787016738222 * b).cbrt();
        Oklab {
            l: 0.210454268309314 * l + 0.7936177747023054 * m - 0.0040720430116193 * s,
            a: 1.9779985324311684 * l - 2.4285922420485799 * m + 0.450593709617411 * s,
            b: 0.0259040424655478 * l + 0.7827717124575296 * m - 0.8086757549230774 * s,
        }
    }

    /// sRGB 0..1, ungeklammert (kann außerhalb des Farbraums liegen).
    pub fn to_srgb(self) -> [f64; 3] {
        let Oklab { l, a, b } = self;
        let l_ = (l + 0.3963377773761749 * a + 0.2158037573099136 * b).powi(3);
        let m_ = (l - 0.1055613458156586 * a - 0.0638541728258133 * b).powi(3);
        let s_ = (l - 0.0894841775298119 * a - 1.2914855480194092 * b).powi(3);
        [
            4.0767416360759574 * l_ - 3.3077115392580616 * m_ + 0.2309699031821044 * s_,
            -1.2684379732850317 * l_ + 2.6097573492876887 * m_ - 0.3413193760026573 * s_,
            -0.0041960761386756 * l_ - 0.7034186179359362 * m_ + 1.7076146940746117 * s_,
        ]
        .map(from_linear)
    }

    pub fn to_rgb(self) -> Rgb {
        Rgb::from_unit(self.to_srgb(), 255)
    }
}

/// Mischen in OKLab (t = 0 → a, 1 → b): fast unbunte Gründe kippen sonst ins Gelb-Oliv.
pub fn mix(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let (x, y) = (a.to_oklab(), b.to_oklab());
    let lerp = |p: f64, q: f64| p + (q - p) * t;
    let c = Oklab {
        l: lerp(x.l, y.l),
        a: lerp(x.a, y.a),
        b: lerp(x.b, y.b),
    };
    Rgb::from_unit(c.to_srgb(), lerp(a.a as f64, b.a as f64).round() as u8)
}

fn displayable(c: [f64; 3]) -> bool {
    c.iter().all(|v| (0.0..=1.0).contains(v))
}

/// culori clampChroma in OKLCH: Chroma halbieren, bis die Farbe im sRGB liegt (Auflösung 0,4 / 2^13)
/// Eingabe OKLCH mit h in Radiant, Ausgabe sRGB 0..1.
pub fn clamp_chroma(l: f64, c: f64, h: f64) -> [f64; 3] {
    let at = |c: f64| {
        Oklab {
            l,
            a: c * h.cos(),
            b: c * h.sin(),
        }
        .to_srgb()
    };
    let full = at(c);
    if displayable(full) {
        return full;
    }
    let grey = at(0.0);
    if !displayable(grey) {
        return grey.map(|v| v.clamp(0.0, 1.0));
    }
    let (mut start, mut end, mut good) = (0.0, c, 0.0);
    let mut last = 0.0;
    while end - start > 0.4 / 8192.0 {
        last = start + (end - start) * 0.5;
        if displayable(at(last)) {
            good = last;
            start = last;
        } else {
            end = last;
        }
    }
    if displayable(at(last)) {
        at(last)
    } else {
        at(good)
    }
}

/// Auf hellem Grund abdunkeln, auf dunklem aufhellen (OKLCH-Helligkeit in 0,02-Schritten), bis `min` erreicht ist.
pub fn ensure_contrast(fg: Rgb, bg: Rgb, min: f64) -> Rgb {
    let lab = fg.to_oklab();
    let (mut l, c, h) = (lab.l, lab.a.hypot(lab.b), lab.b.atan2(lab.a));
    let step = if contrast(bg, Rgb::BLACK) > contrast(bg, Rgb::WHITE) {
        -0.02
    } else {
        0.02
    };
    let mut out = Rgb {
        a: 255,
        ..lab.to_rgb()
    };
    for _ in 0..50 {
        if contrast(out, bg) >= min {
            break;
        }
        l = (l + step).clamp(0.0, 1.0);
        out = Rgb::from_unit(clamp_chroma(l, c, h), 255);
    }
    out
}

/// CIELAB unter D65 (wie culori lab65).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

impl Rgb {
    pub fn to_lab(&self) -> Lab {
        let [r, g, b] = self.unit().map(to_linear);
        let x = 0.4123907992659593 * r + 0.357584339383878 * g + 0.1804807884018343 * b;
        let y = 0.2126390058715102 * r + 0.715168678767756 * g + 0.0721923153607337 * b;
        let z = 0.0193308187155918 * r + 0.119194779794626 * g + 0.9505321522496607 * b;
        let (k, e) = (29f64.powi(3) / 27.0, 216.0 / 29f64.powi(3));
        let f = |v: f64| {
            if v > e {
                v.cbrt()
            } else {
                (k * v + 16.0) / 116.0
            }
        };
        let (fx, fy, fz) = (
            f(x / (0.3127 / 0.329)),
            f(y),
            f(z / ((1.0 - 0.3127 - 0.329) / 0.329)),
        );
        Lab {
            l: 116.0 * fy - 16.0,
            a: 500.0 * (fx - fy),
            b: 200.0 * (fy - fz),
        }
    }
}

/// Farbabstand CIEDE2000 (kL = kC = kH = 1).
pub fn ciede2000(s: Lab, t: Lab) -> f64 {
    let (c1, c2) = (s.a.hypot(s.b), t.a.hypot(t.b));
    let cavg7 = ((c1 + c2) / 2.0).powi(7);
    let g = 0.5 * (1.0 - (cavg7 / (cavg7 + 25f64.powi(7))).sqrt());
    let (a1, a2) = (s.a * (1.0 + g), t.a * (1.0 + g));
    let (cp1, cp2) = (a1.hypot(s.b), a2.hypot(t.b));
    let hue = |a: f64, b: f64| {
        if a.abs() + b.abs() == 0.0 {
            0.0
        } else {
            let h = b.atan2(a);
            if h < 0.0 { h + 2.0 * PI } else { h }
        }
    };
    let (hp1, hp2) = (hue(a1, s.b), hue(a2, t.b));
    let dl = t.l - s.l;
    let dc = cp2 - cp1;
    let mut dhp = if cp1 * cp2 == 0.0 { 0.0 } else { hp2 - hp1 };
    if dhp > PI {
        dhp -= 2.0 * PI;
    } else if dhp < -PI {
        dhp += 2.0 * PI;
    }
    let dh = 2.0 * (cp1 * cp2).sqrt() * (dhp / 2.0).sin();
    let lp = (s.l + t.l) / 2.0;
    let cp = (cp1 + cp2) / 2.0;
    let hp = if cp1 * cp2 == 0.0 {
        hp1 + hp2
    } else {
        let mut h = (hp1 + hp2) / 2.0;
        if (hp1 - hp2).abs() > PI {
            h -= PI;
        }
        if h < 0.0 { h + 2.0 * PI } else { h }
    };
    let lpm50 = (lp - 50.0).powi(2);
    let tt = 1.0 - 0.17 * (hp - PI / 6.0).cos()
        + 0.24 * (2.0 * hp).cos()
        + 0.32 * (3.0 * hp + PI / 30.0).cos()
        - 0.2 * (4.0 * hp - 63.0 * PI / 180.0).cos();
    let sl = 1.0 + 0.015 * lpm50 / (20.0 + lpm50).sqrt();
    let sc = 1.0 + 0.045 * cp;
    let sh = 1.0 + 0.015 * cp * tt;
    let theta = 30f64.to_radians() * (-((hp.to_degrees() - 275.0) / 25.0).powi(2)).exp();
    let cp7 = cp.powi(7);
    let rt = -(2.0 * theta).sin() * 2.0 * (cp7 / (cp7 + 25f64.powi(7))).sqrt();
    ((dl / sl).powi(2) + (dc / sc).powi(2) + (dh / sh).powi(2) + rt * (dc / sc) * (dh / sh)).sqrt()
}

/// CIEDE2000 zweier sRGB-Farben (theme-lint.ts `dist`).
pub fn delta_e(a: Rgb, b: Rgb) -> f64 {
    ciede2000(a.to_lab(), b.to_lab())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Rgb {
        Rgb::parse(s).unwrap()
    }

    #[test]
    fn parse() {
        assert_eq!(hex("#fff"), Rgb::WHITE);
        assert_eq!(hex("B0431A").to_hex(), "#b0431a");
        assert_eq!(hex("#11223380").a, 0x80);
        assert!(
            Rgb::parse("#12").is_none()
                && Rgb::parse("#gggggg").is_none()
                && Rgb::parse("#äb").is_none()
        );
    }

    #[test]
    fn wcag() {
        assert!((contrast(Rgb::BLACK, Rgb::WHITE) - 21.0).abs() < 1e-9);
        let c = contrast(hex("#777"), Rgb::WHITE);
        assert!((c - 4.48).abs() < 0.01, "{c}");
        assert_eq!(contrast(hex("#123456"), hex("#123456")), 1.0);
    }

    #[test]
    fn oklab_roundtrip() {
        for s in [
            "#000000", "#ffffff", "#b0431a", "#7c6cff", "#2ed3e6", "#808080", "#ff0000",
        ] {
            assert_eq!(hex(s).to_oklab().to_rgb().to_hex(), s);
        }
        // Referenz Ottosson: Weiß L = 1, Rot ≈ (0.628, 0.225, 0.126)
        let w = Rgb::WHITE.to_oklab();
        assert!((w.l - 1.0).abs() < 1e-4 && w.a.abs() < 1e-4 && w.b.abs() < 1e-4);
        let r = hex("#ff0000").to_oklab();
        assert!(
            (r.l - 0.628).abs() < 1e-3
                && (r.a - 0.2249).abs() < 1e-3
                && (r.b - 0.1258).abs() < 1e-3
        );
    }

    #[test]
    fn mixing() {
        assert_eq!(mix(Rgb::BLACK, Rgb::WHITE, 0.0), Rgb::BLACK);
        assert_eq!(mix(Rgb::BLACK, Rgb::WHITE, 1.0), Rgb::WHITE);
        // OKLab-Mitte von Schwarz und Weiß: L 0.5 → #636363
        assert_eq!(mix(Rgb::BLACK, Rgb::WHITE, 0.5).to_hex(), "#636363");
    }

    #[test]
    fn ensure() {
        for (fg, bg, min) in [
            ("#cccccc", "#ffffff", 4.5),
            ("#7c6cff", "#faf7f2", 4.6),
            ("#333333", "#0a0f1e", 4.5),
            ("#ffd60a", "#ffffff", 3.0),
        ] {
            let out = ensure_contrast(hex(fg), hex(bg), min);
            assert!(
                contrast(out, hex(bg)) >= min,
                "{fg} auf {bg}: {}",
                out.to_hex()
            );
        }
        // Sollwerte aus culori 4.0.2 (themes.ts ensureContrast/mix, theme-lint dist)
        let ens = [
            ("#cccccc", "#ffffff", 4.5, "#767676"),
            ("#7c6cff", "#faf7f2", 4.6, "#6c58ea"),
            ("#333333", "#0a0f1e", 4.5, "#808080"),
            ("#ffd60a", "#ffffff", 3.0, "#ae9100"),
            ("#ff0000", "#ff8800", 4.5, "#7c0000"),
            ("#00ff88", "#ffffff", 4.6, "#008443"),
            ("#2ed3e6", "#131a2e", 7.0, "#2ed3e6"),
        ];
        for (fg, bg, min, want) in ens {
            assert_eq!(
                ensure_contrast(hex(fg), hex(bg), min).to_hex(),
                want,
                "{fg} auf {bg}"
            );
        }
        for (a, b, t, want) in [
            ("#000000", "#ffffff", 0.3, "#2e2e2e"),
            ("#b0431a", "#ffffff", 0.12, "#bc5b3a"),
            ("#0a0f1e", "#7c6cff", 0.7, "#564eb4"),
        ] {
            assert_eq!(mix(hex(a), hex(b), t).to_hex(), want);
        }
        assert!((delta_e(hex("#b0431a"), hex("#c4552d")) - 6.586866).abs() < 1e-5);
        // reicht der Kontrast schon, bleibt die Farbe
        assert_eq!(
            ensure_contrast(hex("#111111"), Rgb::WHITE, 4.5).to_hex(),
            "#111111"
        );
    }

    #[test]
    fn ciede2000_sharma() {
        // Sharma, Wu, Dalal (2005), Tabelle 1: Paare 1, 7, 17
        let lab = |l, a, b| Lab { l, a, b };
        for (x, y, d) in [
            (
                lab(50.0, 2.6772, -79.7751),
                lab(50.0, 0.0, -82.7485),
                2.0425,
            ),
            (lab(50.0, 0.0, 0.0), lab(50.0, -1.0, 2.0), 2.3669),
            (lab(50.0, 2.5, 0.0), lab(73.0, 25.0, -18.0), 27.1492),
        ] {
            assert!((ciede2000(x, y) - d).abs() < 1e-4, "{}", ciede2000(x, y));
        }
        assert_eq!(delta_e(hex("#b0431a"), hex("#b0431a")), 0.0);
    }
}
