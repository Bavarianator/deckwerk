//! Szene → Pixel mit vello_cpu: PNG-Export, Thumbnails, Hintergrundbild für PPTX/DOCX.

use std::collections::HashMap;
use std::sync::Arc;

use dw_model::{Blend, Color, ImageSrc, ImgFit, Node, Paint, Scene, Stroke};
use kurbo::{Affine, BezPath, Rect, RoundedRect, Shape};
use vello_cpu::color::{AlphaColor, Srgb};
use vello_cpu::peniko::{
    self, BlendMode, ColorStop, ColorStops, Extend, Gradient, ImageAlphaType, ImageQuality,
    ImageSampler, LinearGradientPosition, Mix, RadialGradientPosition,
};
use vello_cpu::{Image, ImageSource, PixelMetadata, Pixmap, RenderContext, Resources};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("ungültige Bildgröße {0}×{1} px")]
    Size(f32, f32),
    #[error("Bild nicht lesbar: {0}")]
    Image(String),
    #[error("PNG: {0}")]
    Png(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, Default)]
pub struct RasterOpts {
    /// true = Hintergrundbild für PPTX/DOCX: Knoten mit `meta.export` fehlen.
    pub skip_exported: bool,
}

/// PNG der Szene; `scale` 2 entspricht den heutigen 2×-PNGs.
pub fn render_png(scene: &Scene, scale: f32, opts: &RasterOpts) -> Result<Vec<u8>> {
    render_pixmap(scene, scale, opts)?
        .into_png()
        .map_err(|e| Error::Png(e.to_string()))
}

/// RGBA ohne vormultipliziertes Alpha, z. B. für Thumbnails oder den Editor-Fallback.
pub fn render_rgba(scene: &Scene, scale: f32, opts: &RasterOpts) -> Result<image::RgbaImage> {
    let pm = render_pixmap(scene, scale, opts)?;
    let (w, h) = (u32::from(pm.width()), u32::from(pm.height()));
    image::RgbaImage::from_raw(w, h, pm.take_rgba8(ImageAlphaType::Alpha))
        .ok_or(Error::Size(w as f32, h as f32))
}

fn render_pixmap(scene: &Scene, scale: f32, opts: &RasterOpts) -> Result<Pixmap> {
    let (w, h) = (scene.width * scale, scene.height * scale);
    let ok = |v: f32| v.is_finite() && v.round() >= 1.0 && v.round() <= f32::from(u16::MAX);
    if !ok(w) || !ok(h) {
        return Err(Error::Size(w, h));
    }
    let (w, h) = (w.round() as u16, h.round() as u16);
    let mut r = Raster {
        ctx: RenderContext::new(w, h),
        res: Resources::new(),
        fonts: HashMap::new(),
        opts: *opts,
    };
    let base = Affine::scale(f64::from(scale));
    r.ctx.set_transform(base);
    r.ctx.set_paint(color(scene.background));
    r.ctx.fill_rect(&Rect::new(
        0.0,
        0.0,
        f64::from(scene.width),
        f64::from(scene.height),
    ));
    for n in &scene.nodes {
        r.node(n, base)?;
    }
    r.ctx.flush();
    let mut pm = Pixmap::new(w, h);
    r.ctx.render(&mut pm, &mut r.res);
    Ok(pm)
}

struct Raster {
    ctx: RenderContext,
    res: Resources,
    // Ein peniko-Blob je Schriftdatei, sonst greift der Glyphen-Cache nicht.
    fonts: HashMap<usize, peniko::FontData>,
    opts: RasterOpts,
}

impl Raster {
    fn node(&mut self, node: &Node, t: Affine) -> Result<()> {
        if self.opts.skip_exported && node.meta().export {
            return Ok(());
        }
        self.ctx.set_transform(t);
        match node {
            Node::Rect {
                rect,
                radius,
                fill,
                stroke,
                shadow,
                ..
            } => {
                if let Some(s) = shadow {
                    self.ctx.set_paint(color(s.color));
                    let r = *rect + kurbo::Vec2::new(0.0, f64::from(s.offset_y));
                    // CSS-Blur-Radius = 2σ
                    self.ctx
                        .fill_blurred_rounded_rect(&r, *radius as f32, s.blur / 2.0, false);
                }
                let path = rect_path(rect, *radius);
                self.shape(&path, fill.as_ref(), stroke.as_ref());
            }
            Node::Path {
                path, fill, stroke, ..
            } => self.shape(path, fill.as_ref(), stroke.as_ref()),
            Node::Glyphs { run, .. } => {
                let key = Arc::as_ptr(&run.font.data) as usize;
                let font = self
                    .fonts
                    .entry(key)
                    .or_insert_with(|| {
                        peniko::FontData::new(
                            peniko::Blob::new(run.font.data.clone()),
                            run.font.index,
                        )
                    })
                    .clone();
                self.ctx.set_paint(color(run.color));
                // Glyphen, die die Schrift nicht kennt, bleiben leer wie im Browser.
                let _ = self
                    .ctx
                    .glyph_run(&mut self.res, &font)
                    .font_size(run.size)
                    .hint(false)
                    .fill_glyphs(run.glyphs.iter().map(|g| vello_cpu::Glyph {
                        id: g.id,
                        x: g.x,
                        y: g.y,
                    }));
            }
            Node::Image {
                rect,
                src,
                fit,
                focus,
                radius,
                ..
            } => {
                let img = decode(src)?;
                let (iw, ih) = img.dimensions();
                let place = fit_rect(*rect, f64::from(iw), f64::from(ih), *fit, *focus);
                let pm = Pixmap::from_parts(
                    img.into_raw(),
                    iw as u16,
                    ih as u16,
                    PixelMetadata {
                        may_have_transparency: true,
                        alpha_type: ImageAlphaType::Alpha,
                    },
                );
                if *radius > 0.0 {
                    self.ctx.push_clip_layer(&rect_path(rect, *radius));
                }
                self.ctx.set_paint(Image {
                    image: ImageSource::Pixmap(Arc::new(pm)),
                    sampler: ImageSampler {
                        x_extend: Extend::Pad,
                        y_extend: Extend::Pad,
                        quality: ImageQuality::High,
                        alpha: 1.0,
                    },
                });
                self.ctx.set_paint_transform(
                    Affine::translate((place.x0, place.y0))
                        * Affine::scale_non_uniform(
                            place.width() / f64::from(iw),
                            place.height() / f64::from(ih),
                        ),
                );
                self.ctx.fill_rect(&place.intersect(*rect));
                self.ctx.reset_paint_transform();
                if *radius > 0.0 {
                    self.ctx.pop_layer();
                }
            }
            Node::Group {
                transform,
                opacity,
                clip,
                blend,
                children,
                ..
            } => {
                let t = t * *transform;
                self.ctx.set_transform(t);
                let mode = match blend {
                    Blend::Normal => Mix::Normal,
                    Blend::Multiply => Mix::Multiply,
                    Blend::Screen => Mix::Screen,
                };
                let layer = clip.is_some() || *blend != Blend::Normal || *opacity < 1.0;
                if layer {
                    self.ctx.push_layer(
                        clip.as_ref(),
                        Some(BlendMode::from(mode)),
                        Some(*opacity),
                        None,
                        None,
                    );
                }
                for c in children {
                    self.node(c, t)?;
                }
                if layer {
                    self.ctx.pop_layer();
                }
            }
        }
        Ok(())
    }

    fn shape(&mut self, path: &BezPath, fill: Option<&Paint>, stroke: Option<&Stroke>) {
        if let Some(p) = fill {
            match p {
                Paint::Solid(c) => self.ctx.set_paint(color(*c)),
                _ => self.ctx.set_paint(gradient(p)),
            }
            self.ctx.fill_path(path);
        }
        if let Some(s) = stroke {
            let mut k = kurbo::Stroke::new(f64::from(s.width));
            if let Some(d) = &s.dash {
                k = k.with_dashes(0.0, d.iter().map(|v| f64::from(*v)));
            }
            self.ctx.set_stroke(k);
            self.ctx.set_paint(color(s.color));
            self.ctx.stroke_path(path);
        }
    }
}

fn color(c: Color) -> AlphaColor<Srgb> {
    AlphaColor::from_rgba8(c.r, c.g, c.b, c.a)
}

fn gradient(p: &Paint) -> Gradient {
    let stops = |s: &[dw_model::Stop]| {
        let v: Vec<ColorStop> = s
            .iter()
            .map(|s| ColorStop::from((s.offset, color(s.color))))
            .collect();
        ColorStops::from(v.as_slice())
    };
    match p {
        Paint::Linear {
            start,
            end,
            stops: s,
        } => Gradient {
            kind: LinearGradientPosition {
                start: *start,
                end: *end,
            }
            .into(),
            stops: stops(s),
            extend: Extend::Pad,
            ..Default::default()
        },
        Paint::Radial {
            center,
            radius,
            stops: s,
        } => Gradient {
            kind: RadialGradientPosition {
                start_center: *center,
                start_radius: 0.0,
                end_center: *center,
                end_radius: *radius as f32,
            }
            .into(),
            stops: stops(s),
            extend: Extend::Pad,
            ..Default::default()
        },
        Paint::Solid(_) => unreachable!("Vollfarbe wird direkt gesetzt"),
    }
}

fn rect_path(r: &Rect, radius: f64) -> BezPath {
    if radius > 0.0 {
        RoundedRect::from_rect(*r, radius).to_path(0.1)
    } else {
        r.to_path(0.1)
    }
}

fn decode(src: &ImageSrc) -> Result<image::RgbaImage> {
    let bytes = match src {
        ImageSrc::Path(p) => {
            std::fs::read(p).map_err(|e| Error::Image(format!("{}: {e}", p.display())))?
        }
        ImageSrc::Bytes(b) => b.to_vec(),
    };
    let img = image::load_from_memory(&bytes).map_err(|e| Error::Image(e.to_string()))?;
    if img.width() > u32::from(u16::MAX) || img.height() > u32::from(u16::MAX) {
        return Err(Error::Image(format!(
            "zu groß: {}×{}",
            img.width(),
            img.height()
        )));
    }
    Ok(img.to_rgba8())
}

/// Zielrechteck des Bildes wie `background-size: cover|contain` + `background-position: focus`.
pub fn fit_rect(rect: Rect, iw: f64, ih: f64, fit: ImgFit, focus: (f32, f32)) -> Rect {
    let (sx, sy) = (rect.width() / iw, rect.height() / ih);
    let s = match fit {
        ImgFit::Cover => sx.max(sy),
        ImgFit::Contain => sx.min(sy),
    };
    let (w, h) = (iw * s, ih * s);
    let x = rect.x0 + (rect.width() - w) * f64::from(focus.0);
    let y = rect.y0 + (rect.height() - h) * f64::from(focus.1);
    Rect::new(x, y, x + w, y + h)
}
