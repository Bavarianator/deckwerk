//! Szene → PDF mit krilla: Bildschirm-PDF, Druck-PDF mit Beschnitt, PDF/X-4 in CMYK (Spike).

mod cmyk;

use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;

use dw_model::{Blend, Color, ImageSrc, Node, Paint, Scene, Stop};
use krilla::color::rgb;
use krilla::geom::{Path, PathBuilder, Point, Rect as KRect, Size, Transform};
use krilla::image::Image;
use krilla::num::NormalizedF32;
use krilla::page::PageSettings;
use krilla::paint::{Fill, FillRule, LinearGradient, RadialGradient, StrokeDash};
use krilla::surface::Surface;
use krilla::text::{Font, GlyphId, KrillaGlyph};
use kurbo::{Affine, BezPath, PathEl, Rect, RoundedRect, Shape};

pub use cmyk::total_area_coverage;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ungültige Seitengröße")]
    Size,
    #[error("Bild nicht lesbar: {0}")]
    Image(String),
    #[error("Schrift nicht lesbar: {0}")]
    Font(String),
    #[error("Farbprofil: {0}")]
    Icc(String),
    #[error("PDF: {0}")]
    Pdf(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, Default)]
pub struct PdfOpts {
    /// Beschnitt je Seite in mm; die Hintergrundfarbe reicht in den Beschnitt.
    pub bleed_mm: f32,
    /// Endformat in mm (Breite, Höhe); None = Foliengröße (px · 0,75 pt).
    pub trim: Option<(f32, f32)>,
    /// PDF/X-4 in CMYK (FOGRA39) statt RGB.
    pub cmyk: bool,
}

const PT_PER_MM: f32 = 72.0 / 25.4;

/// Eine Seite je Szene.
pub fn render_pdf(scenes: &[Scene], opts: &PdfOpts) -> Result<Vec<u8>> {
    let conv = if opts.cmyk {
        Some(cmyk::Converter::new()?)
    } else {
        None
    };
    let mut settings = krilla::SerializeSettings::default();
    if opts.cmyk {
        // PDF/X-4 setzt PDF 1.6 voraus.
        settings.configuration = krilla::configure::ConfigurationBuilder::new()
            .with_version(krilla::configure::PdfVersion::Pdf16)
            .finish()
            .map_err(|e| Error::Pdf(format!("{e:?}")))?;
    }
    let mut doc = krilla::Document::new_with(settings);
    doc.set_metadata(
        krilla::metadata::Metadata::new()
            .title("Deckwerk".into())
            .producer("Deckwerk".into())
            .creation_date(cmyk::now()),
    );
    let mut pdf = Pdf {
        conv,
        fonts: HashMap::new(),
    };
    for scene in scenes {
        let print = opts.trim.is_some() || opts.bleed_mm > 0.0;
        let (tw, th) = match opts.trim {
            Some((w, h)) => (w * PT_PER_MM, h * PT_PER_MM),
            None => (scene.width * 0.75, scene.height * 0.75),
        };
        let b = opts.bleed_mm.max(0.0) * PT_PER_MM;
        let (pw, ph) = (tw + 2.0 * b, th + 2.0 * b);
        let mut ps = PageSettings::from_wh(pw, ph).ok_or(Error::Size)?;
        if print {
            ps = ps
                .with_trim_box(KRect::from_xywh(b, b, tw, th))
                .with_bleed_box(KRect::from_xywh(0.0, 0.0, pw, ph));
        }
        if !(scene.width > 0.0 && scene.height > 0.0) {
            return Err(Error::Size);
        }
        // Inhalt auf das Endformat skaliert und zentriert, Hintergrund bis in den Beschnitt.
        let s = (tw / scene.width).min(th / scene.height);
        let (ox, oy) = (
            b + (tw - scene.width * s) / 2.0,
            b + (th - scene.height * s) / 2.0,
        );
        let mut page = doc.start_page_with(ps);
        let mut sf = page.surface();
        let bg = Rect::new(0.0, 0.0, f64::from(pw), f64::from(ph)).to_path(0.1);
        pdf.fill(&mut sf, &bg, &Paint::Solid(scene.background), false);
        sf.push_transform(&Transform::from_row(s, 0.0, 0.0, s, ox, oy));
        for n in &scene.nodes {
            pdf.node(&mut sf, n)?;
        }
        sf.pop();
        sf.finish();
        page.finish();
    }
    let bytes = doc.finish().map_err(|e| Error::Pdf(format!("{e:?}")))?;
    if opts.cmyk {
        cmyk::add_output_intent(&bytes)
    } else {
        Ok(bytes)
    }
}

struct Pdf {
    conv: Option<cmyk::Converter>,
    // Font::new hasht die ganze Datei, deshalb je Schriftdatei nur einmal.
    fonts: HashMap<(usize, u32), Font>,
}

impl Pdf {
    fn color(&self, c: Color, text: bool) -> (krilla::color::Color, NormalizedF32) {
        let col = match &self.conv {
            Some(conv) => conv.color(c, text).into(),
            None => rgb::Color::new(c.r, c.g, c.b).into(),
        };
        (col, norm(f32::from(c.a) / 255.0))
    }

    fn paint(&self, p: &Paint, text: bool) -> (krilla::paint::Paint, NormalizedF32) {
        let stops = |s: &[Stop]| {
            s.iter()
                .map(|s| {
                    let (color, opacity) = self.color(s.color, false);
                    krilla::paint::Stop {
                        offset: norm(s.offset),
                        color,
                        opacity,
                    }
                })
                .collect()
        };
        match p {
            Paint::Solid(c) => {
                let (col, op) = self.color(*c, text);
                (col.into(), op)
            }
            Paint::Linear {
                start,
                end,
                stops: s,
            } => (
                LinearGradient {
                    x1: start.x as f32,
                    y1: start.y as f32,
                    x2: end.x as f32,
                    y2: end.y as f32,
                    transform: Transform::identity(),
                    spread_method: Default::default(),
                    stops: stops(s),
                    anti_alias: true,
                }
                .into(),
                NormalizedF32::ONE,
            ),
            Paint::Radial {
                center,
                radius,
                stops: s,
            } => (
                RadialGradient {
                    fx: center.x as f32,
                    fy: center.y as f32,
                    fr: 0.0,
                    cx: center.x as f32,
                    cy: center.y as f32,
                    cr: *radius as f32,
                    transform: Transform::identity(),
                    spread_method: Default::default(),
                    stops: stops(s),
                    anti_alias: true,
                }
                .into(),
                NormalizedF32::ONE,
            ),
        }
    }

    fn fill(&self, sf: &mut Surface, path: &BezPath, p: &Paint, text: bool) {
        let Some(path) = kpath(path) else { return };
        let (paint, opacity) = self.paint(p, text);
        sf.set_stroke(None);
        sf.set_fill(Some(Fill {
            paint,
            opacity,
            rule: FillRule::NonZero,
        }));
        sf.draw_path(&path);
    }

    fn stroke(&self, sf: &mut Surface, path: &BezPath, s: &dw_model::Stroke) {
        let Some(path) = kpath(path) else { return };
        let (col, opacity) = self.color(s.color, false);
        sf.set_fill(None);
        sf.set_stroke(Some(krilla::paint::Stroke {
            paint: col.into(),
            width: s.width,
            opacity,
            dash: s.dash.as_ref().map(|d| StrokeDash {
                array: d.clone(),
                offset: 0.0,
            }),
            ..Default::default()
        }));
        sf.draw_path(&path);
        sf.set_stroke(None);
    }

    fn node(&mut self, sf: &mut Surface, node: &Node) -> Result<()> {
        match node {
            Node::Rect {
                rect,
                radius,
                fill,
                stroke,
                shadow,
                ..
            } => {
                if let Some(sh) = shadow {
                    // ponytail: Weichzeichnung als gestapelte Ringe statt Gauß, reicht für dezente Schatten; echtes Blur per Raster-SMask, falls nötig.
                    const N: usize = 6;
                    let r = *rect + kurbo::Vec2::new(0.0, f64::from(sh.offset_y));
                    let mut c = sh.color;
                    c.a = (f32::from(c.a) / N as f32).round() as u8;
                    for i in 0..N {
                        let d = f64::from(sh.blur) * (i as f64 / (N - 1) as f64 - 0.5);
                        let rr = r.inflate(d, d);
                        if rr.width() > 0.0 && rr.height() > 0.0 {
                            let p = rect_path(&rr, (radius + d).max(0.0));
                            self.fill(sf, &p, &Paint::Solid(c), false);
                        }
                    }
                }
                let path = rect_path(rect, *radius);
                if let Some(f) = fill {
                    self.fill(sf, &path, f, false);
                }
                if let Some(s) = stroke {
                    self.stroke(sf, &path, s);
                }
            }
            Node::Path {
                path, fill, stroke, ..
            } => {
                if let Some(f) = fill {
                    self.fill(sf, path, f, false);
                }
                if let Some(s) = stroke {
                    self.stroke(sf, path, s);
                }
            }
            Node::Glyphs { run, .. } => {
                let Some(first) = run.glyphs.first() else {
                    return Ok(());
                };
                let key = (Arc::as_ptr(&run.font.data) as usize, run.font.index);
                let font = match self.fonts.get(&key) {
                    Some(f) => f.clone(),
                    None => {
                        let f = Font::new(run.font.data.clone().into(), run.font.index)
                            .ok_or_else(|| Error::Font(run.font.family.clone()))?;
                        self.fonts.insert(key, f.clone());
                        f
                    }
                };
                let ranges = text_ranges(&run.text, run.glyphs.len());
                let size = run.size;
                let glyphs: Vec<KrillaGlyph> = run
                    .glyphs
                    .iter()
                    .enumerate()
                    .map(|(i, g)| {
                        // Absolute Positionen als Vorschub zum nächsten Glyph; y relativ zur ersten Grundlinie.
                        let adv = run.glyphs.get(i + 1).map_or(0.0, |n| n.x - g.x);
                        KrillaGlyph::new(
                            GlyphId::new(g.id),
                            adv / size,
                            0.0,
                            (first.y - g.y) / size,
                            0.0,
                            ranges[i].clone(),
                            None,
                        )
                    })
                    .collect();
                let (paint, opacity) = self.paint(&Paint::Solid(run.color), true);
                sf.set_stroke(None);
                sf.set_fill(Some(Fill {
                    paint,
                    opacity,
                    rule: FillRule::NonZero,
                }));
                sf.draw_glyphs(
                    Point::from_xy(first.x, first.y),
                    &glyphs,
                    font,
                    &run.text,
                    size,
                    false,
                );
            }
            Node::Image {
                rect,
                src,
                fit,
                focus,
                radius,
                ..
            } => {
                let bytes = match src {
                    ImageSrc::Path(p) => std::fs::read(p)
                        .map_err(|e| Error::Image(format!("{}: {e}", p.display())))?,
                    ImageSrc::Bytes(b) => b.to_vec(),
                };
                let img = match &self.conv {
                    Some(conv) => conv.image(&bytes)?,
                    None => rgb_image(bytes)?,
                };
                let (iw, ih) = img.size();
                let place = fit_rect(*rect, f64::from(iw), f64::from(ih), *fit, *focus);
                // Leere Bildbox zeichnet nichts, wie leere Pfade.
                let (Some(clip), Some(size)) = (
                    kpath(&rect_path(rect, *radius)),
                    Size::from_wh(place.width() as f32, place.height() as f32),
                ) else {
                    return Ok(());
                };
                sf.push_clip_path(&clip, &FillRule::NonZero);
                sf.push_transform(&Transform::from_translate(place.x0 as f32, place.y0 as f32));
                sf.draw_image(img, size);
                sf.pop();
                sf.pop();
            }
            Node::Group {
                transform,
                opacity,
                clip,
                blend,
                children,
                ..
            } => {
                let mut pushed = 1;
                sf.push_transform(&ktransform(transform));
                if *opacity < 1.0 {
                    sf.push_opacity(norm(*opacity));
                    pushed += 1;
                }
                if *blend != Blend::Normal {
                    sf.push_blend_mode(match blend {
                        Blend::Multiply => krilla::blend::BlendMode::Multiply,
                        _ => krilla::blend::BlendMode::Screen,
                    });
                    pushed += 1;
                }
                if let Some(p) = clip.as_ref().and_then(kpath) {
                    sf.push_clip_path(&p, &FillRule::NonZero);
                    pushed += 1;
                }
                for c in children {
                    self.node(sf, c)?;
                }
                for _ in 0..pushed {
                    sf.pop();
                }
            }
        }
        Ok(())
    }
}

/// Ein Glyph je Zeichen → Zeichen einzeln zuordnen, sonst trägt der erste Glyph den ganzen
/// Text und die übrigen nichts, damit der Text beim Kopieren nur einmal erscheint.
fn text_ranges(text: &str, n: usize) -> Vec<Range<usize>> {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    if chars.len() == n {
        chars.iter().map(|(i, c)| *i..*i + c.len_utf8()).collect()
    } else {
        let mut r = vec![text.len()..text.len(); n];
        if let Some(first) = r.first_mut() {
            *first = 0..text.len();
        }
        r
    }
}

fn rgb_image(bytes: Vec<u8>) -> Result<Image> {
    let fmt = image::guess_format(&bytes).map_err(|e| Error::Image(e.to_string()))?;
    let r = match fmt {
        image::ImageFormat::Jpeg => Image::from_jpeg(bytes.into(), true),
        image::ImageFormat::Png => Image::from_png(bytes.into(), true),
        _ => {
            let img = image::load_from_memory(&bytes)
                .map_err(|e| Error::Image(e.to_string()))?
                .to_rgba8();
            let (w, h) = img.dimensions();
            Ok(Image::from_rgba8(img.into_raw(), w, h))
        }
    };
    r.map_err(Error::Image)
}

fn norm(v: f32) -> NormalizedF32 {
    NormalizedF32::new(v.clamp(0.0, 1.0)).unwrap_or(NormalizedF32::ONE)
}

fn ktransform(a: &Affine) -> Transform {
    let [a, b, c, d, e, f] = a.as_coeffs().map(|v| v as f32);
    Transform::from_row(a, b, c, d, e, f)
}

fn kpath(p: &BezPath) -> Option<Path> {
    let mut pb = PathBuilder::new();
    for el in p.elements() {
        match *el {
            PathEl::MoveTo(p) => pb.move_to(p.x as f32, p.y as f32),
            PathEl::LineTo(p) => pb.line_to(p.x as f32, p.y as f32),
            PathEl::QuadTo(a, p) => pb.quad_to(a.x as f32, a.y as f32, p.x as f32, p.y as f32),
            PathEl::CurveTo(a, b, p) => pb.cubic_to(
                a.x as f32, a.y as f32, b.x as f32, b.y as f32, p.x as f32, p.y as f32,
            ),
            PathEl::ClosePath => pb.close(),
        }
    }
    pb.finish()
}

fn rect_path(r: &Rect, radius: f64) -> BezPath {
    if radius > 0.0 {
        RoundedRect::from_rect(*r, radius).to_path(0.1)
    } else {
        r.to_path(0.1)
    }
}

// Gleiche Regel wie dw_raster::fit_rect (dw-pdf hängt bewusst nicht vom Raster ab).
fn fit_rect(rect: Rect, iw: f64, ih: f64, fit: dw_model::ImgFit, focus: (f32, f32)) -> Rect {
    let (sx, sy) = (rect.width() / iw, rect.height() / ih);
    let s = match fit {
        dw_model::ImgFit::Cover => sx.max(sy),
        dw_model::ImgFit::Contain => sx.min(sy),
    };
    let (w, h) = (iw * s, ih * s);
    let x = rect.x0 + (rect.width() - w) * f64::from(focus.0);
    let y = rect.y0 + (rect.height() - h) * f64::from(focus.1);
    Rect::new(x, y, x + w, y + h)
}
