//! Hintergrundebene (slide.tsx Decor/MOTIFS, slide.css .decor/.sig): Motive, Signaturen, Folienhintergrund.
//! Alles landet als Szene-Knoten ohne Export im Hintergrundbild.

use dw_color::{Rgb, mix};
use dw_model::{Color, Node, NodeMeta, Paint, Stop, Stroke};
use dw_theme::{Decor, SigKind, SigSide, Signature};
use kurbo::{Point, Rect};
use serde_json::Value;

use crate::blocks::Cx;
use crate::tree::color;

fn rgba(c: Rgb, a: f32) -> Color {
    let mut k = color(c);
    k.a = (k.a as f32 * a.clamp(0., 1.)).round() as u8;
    k
}

fn rect(r: Rect, radius: f64, fill: Paint) -> Node {
    Node::Rect {
        meta: NodeMeta::default(),
        rect: r,
        radius,
        fill: Some(fill),
        stroke: None,
        shadow: None,
    }
}

/// Folienhintergrund aus Slide.bg: Farbe oder Verlauf (linear-gradient(angle, a, b)).
pub fn background(cx: &Cx, bg: Option<&Value>) -> Vec<Node> {
    let Some(bg) = bg else { return Vec::new() };
    let all = Rect::new(0., 0., cx.w as f64, cx.h as f64);
    let hex = |v: &Value| v.as_str().and_then(Color::from_hex);
    if let Some(g) = bg.get("gradient").and_then(Value::as_array)
        && let (Some(a), Some(b)) = (g.first().and_then(hex), g.get(1).and_then(hex))
    {
        // CSS: Gradientenlinie durch die Mitte, so lang, dass die Ecken die Endfarben treffen
        let ang = bg
            .get("angle")
            .and_then(Value::as_f64)
            .unwrap_or(135.)
            .to_radians();
        let (w, h) = (cx.w as f64, cx.h as f64);
        let (dx, dy) = (ang.sin(), -ang.cos());
        let len = (w * dx).abs() + (h * dy).abs();
        let c = Point::new(w / 2., h / 2.);
        let d = kurbo::Vec2::new(dx, dy) * (len / 2.);
        return vec![rect(
            all,
            0.,
            Paint::Linear {
                start: c - d,
                end: c + d,
                stops: vec![
                    Stop {
                        offset: 0.,
                        color: a,
                    },
                    Stop {
                        offset: 1.,
                        color: b,
                    },
                ],
            },
        )];
    }
    match bg.get("color").and_then(hex) {
        Some(c) => vec![rect(all, 0., Paint::Solid(c))],
        None => Vec::new(),
    }
}

// erfc nach Abramowitz/Stegun 7.1.26 (Fehler < 1,5e-7)
fn erfc(x: f64) -> f64 {
    let z = x.abs();
    let t = 1. / (1. + 0.3275911 * z);
    let y = t
        * (0.254829592
            + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
        * (-z * z).exp();
    if x >= 0. { y } else { 2. - y }
}

/// .blob: Kreis mit filter: blur(90px) als radialer Verlauf (Kantenprofil einer Gaußunschärfe).
/// ponytail: 1-D-Profil statt echter 2-D-Faltung; bei großen Kreisen kaum sichtbar
fn blob(x: f64, y: f64, d: f64, c: Rgb, opacity: f32) -> Node {
    const SIGMA: f64 = 90.;
    let r = d / 2.;
    let reach = r + 3. * SIGMA;
    let stops = (0..=12)
        .map(|i| {
            let dist = reach * i as f64 / 12.;
            let a = 0.5 * erfc((dist - r) / (SIGMA * std::f64::consts::SQRT_2));
            Stop {
                offset: (dist / reach) as f32,
                color: rgba(c, opacity * a as f32),
            }
        })
        .collect();
    let center = Point::new(x + r, y + r);
    rect(
        Rect::new(
            center.x - reach,
            center.y - reach,
            center.x + reach,
            center.y + reach,
        ),
        0.,
        Paint::Radial {
            center,
            radius: reach,
            stops,
        },
    )
}

/// .ring: Kreislinie 1,5 px
fn ring(x: f64, y: f64, d: f64, c: Rgb) -> Node {
    Node::Rect {
        meta: NodeMeta::default(),
        rect: Rect::new(x + 0.75, y + 0.75, x + d - 0.75, y + d - 0.75),
        radius: d / 2.,
        fill: None,
        stroke: Some(Stroke {
            width: 1.5,
            color: color(c),
            dash: None,
        }),
        shadow: None,
    }
}

/// mask-image: radial-gradient(ellipse at px% py%, #000 0%, transparent stop%) mit farthest-corner.
fn mask(w: f64, h: f64, px: f64, py: f64, stop: f64) -> impl Fn(f64, f64) -> f64 {
    let (cx, cy) = (w * px, h * py);
    // Seitenverhältnis wie closest-side, Größe bis zur fernsten Ecke
    let ratio = cx.min(w - cx) / cy.min(h - cy);
    let (dx, dy) = (cx.max(w - cx), cy.max(h - cy));
    let ry = ((dx / ratio).powi(2) + dy * dy).sqrt();
    let rx = ry * ratio;
    move |x, y| {
        let t = (((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2)).sqrt();
        (1. - t / stop).clamp(0., 1.)
    }
}

/// .grid-lines: 1-px-Raster alle 64 px, je Zelle mit der Maske an ihrer Mitte.
fn grid_lines(w: f64, h: f64, line: Rgb, opacity: f64, m: impl Fn(f64, f64) -> f64) -> Vec<Node> {
    let mut out = Vec::new();
    let mut y = 0.;
    while y < h {
        let mut x = 0.;
        while x < w {
            let a = (m(x + 32., y + 32.) * opacity) as f32;
            if a > 0.004 {
                let p = Paint::Solid(rgba(line, a));
                out.push(rect(
                    Rect::new(x, y, x + 1., (y + 64.).min(h)),
                    0.,
                    p.clone(),
                ));
                out.push(rect(Rect::new(x + 1., y, (x + 64.).min(w), y + 1.), 0., p));
            }
            x += 64.;
        }
        y += 64.;
    }
    out
}

/// .dots: Punkte (Radius ~1,85 px) im 22-px-Raster
fn dots(w: f64, h: f64, c: Rgb, m: impl Fn(f64, f64) -> f64) -> Vec<Node> {
    let mut out = Vec::new();
    let mut y = 11.;
    while y < h {
        let mut x = 11.;
        while x < w {
            let a = m(x, y) as f32;
            if a > 0.004 {
                out.push(rect(
                    Rect::new(x - 1.85, y - 1.85, x + 1.85, y + 1.85),
                    1.85,
                    Paint::Solid(rgba(c, a)),
                ));
            }
            x += 22.;
        }
        y += 22.;
    }
    out
}

/// Motiv der Hintergrundebene; hero = Cover/Statement/Kapitel (kräftiger).
/// ponytail: Textur grain (Rauschen) fehlt; bei Bedarf als gekacheltes Rauschbild
pub fn motif(cx: &Cx, id: Decor, hero: bool) -> Vec<Node> {
    let tk = cx.tk;
    let (w, h) = (cx.w as f64, cx.h as f64);
    let (a, b) = (tk.accent, tk.accent2);
    let line = mix(tk.bg, tk.text, 0.08);
    let corner = || mask(w, h, 0.88, 0.08, 0.55);
    match id {
        Decor::None => Vec::new(),
        Decor::Blobs => {
            let mut v = vec![if hero {
                blob(w + 260. - 820., -320., 820., a, 0.16)
            } else {
                blob(w + 300. - 560., -360., 560., a, 0.07)
            }];
            if hero {
                v.push(blob(-240., h + 300. - 520., 520., b, 0.12));
                v.push(ring(w - 60. - 540., -300., 540., mix(tk.bg, a, 0.18)));
            }
            v
        }
        Decor::Glow => {
            let mut v = grid_lines(
                w,
                h,
                line,
                if hero { 1. } else { 0.6 },
                mask(w, h, 0.75, 0.15, 0.65),
            );
            let d = if hero { 760. } else { 520. };
            let (r, t) = if hero { (-200., -280.) } else { (-260., -320.) };
            v.push(blob(w - r - d, t, d, a, if hero { 0.5 } else { 0.22 }));
            v.push(blob(
                -220.,
                h + 300. - 560.,
                560.,
                b,
                if hero { 0.32 } else { 0.1 },
            ));
            v
        }
        Decor::Rings if hero => vec![
            ring(w + 180. - 620., h + 260. - 620., 620., mix(tk.bg, a, 0.35)),
            ring(w + 80. - 420., h + 160. - 420., 420., mix(tk.bg, b, 0.3)),
        ],
        Decor::Rings => Vec::new(),
        Decor::Grid if hero => grid_lines(w, h, line, 1., mask(w, h, 0.7, 0.4, 0.75)),
        Decor::Grid => grid_lines(w, h, line, 1., corner()),
        Decor::Stripe if hero => vec![
            rect(
                Rect::new(w - 380., 0., w, h),
                0.,
                Paint::Solid(color(mix(tk.bg, a, 0.1))),
            ),
            rect(
                Rect::new(w - 383., 0., w - 380., h),
                0.,
                Paint::Solid(color(a)),
            ),
        ],
        Decor::Stripe => vec![rect(Rect::new(0., 0., 8., h), 0., Paint::Solid(color(a)))],
        Decor::Dots => {
            let mut v = dots(w, h, mix(tk.bg, a, 0.45), corner());
            if hero {
                v.extend(dots(w, h, mix(tk.bg, a, 0.35), mask(w, h, 0.06, 0.96, 0.4)));
            }
            v
        }
    }
}

/// Signatur edge (Farbkante am Rand) bzw. passepartout (Rahmenlinie 20 px vom Rand).
pub fn signature(cx: &Cx, s: &Signature) -> Vec<Node> {
    let tk = cx.tk;
    let (w, h) = (cx.w as f64, cx.h as f64);
    let (Some(c), Some(size)) = (tk.sig_c, tk.sig_s) else {
        return Vec::new();
    };
    match s.kind {
        SigKind::Edge => {
            let r = if s.side == Some(SigSide::Top) {
                Rect::new(0., 0., w, size)
            } else {
                Rect::new(0., 0., size, h)
            };
            vec![rect(r, 0., Paint::Solid(color(c)))]
        }
        SigKind::Passepartout => {
            let i = 20. + size / 2.; // border liegt innen: Strichmitte
            vec![Node::Rect {
                meta: NodeMeta::default(),
                rect: Rect::new(i, i, w - i, h - i),
                radius: 0.,
                fill: None,
                stroke: Some(Stroke {
                    width: size as f32,
                    color: color(c),
                    dash: None,
                }),
                shadow: None,
            }]
        }
        _ => Vec::new(),
    }
}
