//! Vergleich dw-scene ↔ Chromium-Referenz (RUST-REWRITE.md §4.6): Autofit-Stufe, Text- und Box-Elemente je Slot, Pixel.

use std::collections::BTreeMap;

use dw_model::{El, ElBox, Measured};
use image::{Rgb, RgbImage};

/// Toleranz für Boxen in Folienpixeln (§4.6).
pub const BOX_TOL: f64 = 2.0;
/// Toleranz für sizePx/lineHeightPx.
pub const SIZE_TOL: f64 = 0.01;

#[derive(Debug, Clone, PartialEq)]
pub struct TextDiff {
    pub slot: String,
    /// Abweichung ours − ref in x, y, w, h
    pub d: [f64; 4],
    pub lines: (u32, u32), // (ref, ours)
    pub size_px: (f64, f64),
    pub line_height_px: (f64, f64),
}

impl TextDiff {
    /// sizePx und lineHeightPx gleich innerhalb SIZE_TOL.
    pub fn size_same(&self) -> bool {
        (self.size_px.0 - self.size_px.1).abs() <= SIZE_TOL
            && (self.line_height_px.0 - self.line_height_px.1).abs() <= SIZE_TOL
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BoxDiff {
    pub slot: String,
    pub d: [f64; 4],
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Report {
    pub fit_ref: (bool, u32, u32), // (ok, head, body)
    pub fit_ours: (bool, u32, u32),
    pub texts: Vec<TextDiff>,
    pub boxes: Vec<BoxDiff>,
    pub missing: Vec<String>, // nur in der Referenz
    pub extra: Vec<String>,   // nur in dw-scene
}

fn delta(r: &ElBox, o: &ElBox) -> [f64; 4] {
    [o.x - r.x, o.y - r.y, o.w - r.w, o.h - r.h]
}

fn max_abs(d: &[f64; 4]) -> f64 {
    d.iter().fold(0., |m, v| m.max(v.abs()))
}

fn kind(e: &El) -> &'static str {
    match e {
        El::Text(_) => "text",
        El::Box(_) => "box",
        El::Img(_) => "img",
        El::Icon(_) => "icon",
        El::Chart(_) => "chart",
        El::Media(_) => "media",
        El::Table(_) => "table",
    }
}

/// Elemente nach `kind:slot`; doppelte Slots bekommen `#n`.
fn index(m: &Measured) -> BTreeMap<String, &El> {
    let mut out = BTreeMap::new();
    for e in &m.els {
        let base = format!("{}:{}", kind(e), e.base().slot);
        let mut key = base.clone();
        let mut n = 1;
        while out.contains_key(&key) {
            key = format!("{base}#{n}");
            n += 1;
        }
        out.insert(key, e);
    }
    out
}

impl Report {
    pub fn fit_same(&self) -> bool {
        self.fit_ref == self.fit_ours
    }
    pub fn lines_same(&self) -> bool {
        self.texts.iter().all(|t| t.lines.0 == t.lines.1)
    }
    /// Größte Box-Abweichung über Text und Boxen.
    pub fn max_box(&self) -> f64 {
        self.texts
            .iter()
            .map(|t| max_abs(&t.d))
            .chain(self.boxes.iter().map(|b| max_abs(&b.d)))
            .fold(0., f64::max)
    }
    pub fn sizes_same(&self) -> bool {
        self.texts.iter().all(TextDiff::size_same)
    }
    pub fn slots_same(&self) -> bool {
        self.missing.is_empty() && self.extra.is_empty()
    }
    /// Gleich innerhalb Toleranz: Stufe gleich, alle Zeilenzahlen gleich, Boxen ≤ BOX_TOL, gleiche Slots.
    pub fn ok(&self) -> bool {
        self.fit_same()
            && self.lines_same()
            && self.sizes_same()
            && self.max_box() <= BOX_TOL
            && self.slots_same()
    }
}

pub fn compare(reference: &Measured, ours: &Measured) -> Report {
    let f = |m: &Measured| (m.fit.ok, m.fit.head, m.fit.body);
    let (r, o) = (index(reference), index(ours));
    let mut rep = Report {
        fit_ref: f(reference),
        fit_ours: f(ours),
        ..Default::default()
    };
    for (key, re) in &r {
        let Some(oe) = o.get(key) else {
            rep.missing.push(key.clone());
            continue;
        };
        let slot = re.base().slot.clone();
        let d = delta(&re.base().bbox, &oe.base().bbox);
        match (re, oe) {
            (El::Text(a), El::Text(b)) => rep.texts.push(TextDiff {
                slot,
                d,
                lines: (a.lines, b.lines),
                size_px: (a.size_px, b.size_px),
                line_height_px: (a.line_height_px, b.line_height_px),
            }),
            // andere Arten (Bild, Icon …) zählen wie Boxen: nur die Lage
            _ => rep.boxes.push(BoxDiff { slot, d }),
        }
    }
    rep.extra = o.keys().filter(|k| !r.contains_key(*k)).cloned().collect();
    rep
}

#[derive(Debug, Clone, PartialEq)]
pub struct PixelDiff {
    pub mean: [f64; 3], // mittlere |Δ| je Kanal (0–255)
    pub over32: f64,    // Anteil Pixel mit max. Kanal-Δ > 32
    pub size_same: bool,
}

/// Vergleicht auf der gemeinsamen Fläche; Diff-Bild: Δ > 32 rot, sonst die Referenz abgeblasst.
pub fn pixel_diff(reference: &RgbImage, ours: &RgbImage) -> (PixelDiff, RgbImage) {
    let (w, h) = (
        reference.width().min(ours.width()),
        reference.height().min(ours.height()),
    );
    let mut sum = [0u64; 3];
    let mut over = 0u64;
    let mut img = RgbImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let (a, b) = (reference.get_pixel(x, y).0, ours.get_pixel(x, y).0);
            let d: [u8; 3] = std::array::from_fn(|c| a[c].abs_diff(b[c]));
            for c in 0..3 {
                sum[c] += u64::from(d[c]);
            }
            let hit = d.iter().any(|&v| v > 32);
            over += u64::from(hit);
            let fade = |v: u8| 191 + v / 4;
            img.put_pixel(
                x,
                y,
                if hit {
                    Rgb([255, 0, 0])
                } else {
                    Rgb(a.map(fade))
                },
            );
        }
    }
    let n = (u64::from(w) * u64::from(h)).max(1) as f64;
    (
        PixelDiff {
            mean: sum.map(|s| s as f64 / n),
            over32: over as f64 / n,
            size_same: reference.dimensions() == ours.dimensions(),
        },
        img,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn measured(v: serde_json::Value) -> Measured {
        serde_json::from_value(v).unwrap()
    }

    fn text(slot: &str, x: f64, y: f64, lines: u32) -> serde_json::Value {
        json!({ "kind": "text", "slot": slot, "box": { "x": x, "y": y, "w": 100, "h": 20 }, "font": "body", "role": "body",
            "sizePx": 20, "lineHeightPx": 27.6, "trackingPx": 0, "align": "left", "upper": false, "runs": [], "lines": lines, "bg": "#FFFFFF" })
    }

    fn deck(els: Vec<serde_json::Value>, body: u32) -> Measured {
        measured(
            json!({ "els": els, "fit": { "ok": true, "head": 0, "body": body, "overflow": [] } }),
        )
    }

    #[test]
    fn same_is_ok() {
        let a = deck(vec![text("title", 72., 60., 2)], 0);
        let r = compare(&a, &a);
        assert!(r.ok());
        assert_eq!(r.max_box(), 0.);
    }

    #[test]
    fn known_differences() {
        let box_el = json!({ "kind": "box", "slot": "_dot.0", "box": { "x": 72, "y": 200, "w": 14, "h": 2 }, "radius": 0, "ellipse": false });
        let a = deck(
            vec![
                text("title", 72., 60., 2),
                text("sub", 72., 100., 1),
                box_el.clone(),
            ],
            0,
        );
        let mut moved = box_el;
        moved["box"]["y"] = json!(203.5);
        let b = deck(
            vec![text("title", 73., 58., 3), moved, text("meta", 0., 0., 1)],
            1,
        );
        let r = compare(&a, &b);
        assert!(!r.fit_same());
        assert_eq!(r.texts.len(), 1);
        assert_eq!(r.texts[0].d, [1., -2., 0., 0.]);
        assert_eq!(r.texts[0].lines, (2, 3));
        assert!(!r.lines_same());
        assert_eq!(r.boxes[0].d, [0., 3.5, 0., 0.]);
        assert_eq!(r.max_box(), 3.5);
        assert_eq!(r.missing, vec!["text:sub"]);
        assert_eq!(r.extra, vec!["text:meta"]);
        assert!(!r.ok());
    }

    #[test]
    fn size_differences() {
        let a = deck(vec![text("title", 72., 60., 2)], 0);
        for (field, v) in [("sizePx", 21.0), ("lineHeightPx", 27.0)] {
            let mut t = text("title", 72., 60., 2);
            t[field] = json!(v);
            let r = compare(&a, &deck(vec![t], 0));
            assert!(!r.sizes_same() && !r.ok(), "{field}");
        }
        let mut t = text("title", 72., 60., 2);
        t["lineHeightPx"] = json!(27.605);
        assert!(compare(&a, &deck(vec![t], 0)).ok());
    }

    #[test]
    fn pixels() {
        let a = RgbImage::from_pixel(2, 2, Rgb([0, 0, 0]));
        let mut b = a.clone();
        b.put_pixel(0, 0, Rgb([40, 0, 8]));
        let (d, img) = pixel_diff(&a, &b);
        assert_eq!(d.mean, [10., 0., 2.]);
        assert_eq!(d.over32, 0.25);
        assert!(d.size_same);
        assert_eq!(img.get_pixel(0, 0), &Rgb([255, 0, 0]));
    }
}
