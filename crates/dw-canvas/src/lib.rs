//! GPU-Canvas für die Stage: dw-model-Szene → vello::Scene → wgpu-Textur auf dem Device der GUI
//! (bei Slint: `GraphicsAPI::WGPU30`), ohne Umweg über die CPU. Gleiche Malregeln wie dw-raster (vello_cpu);
//! ohne GPU bleibt `dw_raster::render_rgba` der Fallback.
//!
//! Einstieg: `GpuCanvas::new(device, queue)` einmal je Device, dann `render(&scene, scale)` je Bild.

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Arc;

use dw_model::{Blend, Color, ImageSrc, Node, Paint, Scene, Stroke};
use kurbo::{Affine, BezPath, Rect, RoundedRect, Shape};
use vello::peniko::{
    self, BlendMode, ColorStop, ColorStops, Extend, Fill, Gradient, ImageAlphaType, ImageBrush,
    ImageData, ImageFormat, ImageQuality, LinearGradientPosition, Mix, RadialGradientPosition,
    color::{AlphaColor, Srgb},
};
pub use vello::wgpu;
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions};

/// Limits, die das GUI-Device für vello mindestens braucht (Compute-Shader mit Storage-Buffern).
/// Slints Standard (`downlevel_webgl2_defaults`) hat keine Storage-Buffer und reicht nicht.
pub fn required_limits() -> wgpu::Limits {
    wgpu::Limits::default()
}

/// Bytes (hält die Adresse fest) und vello-Schrift
type FontEntry = (Arc<Vec<u8>>, peniko::FontData);

pub struct GpuCanvas {
    device: wgpu::Device,
    queue: wgpu::Queue,
    renderer: Renderer,
    // Ping-Pong: Slint hält die zuletzt gezeigte Textur, wir zeichnen in die andere
    targets: [Option<wgpu::Texture>; 2],
    flip: usize,
    // Arc mit im Eintrag: solange er lebt, kann keine andere Schrift dieselbe Adresse bekommen
    fonts: HashMap<(usize, u32), FontEntry>,
    images: ImageCache,
}

impl GpuCanvas {
    pub fn new(device: wgpu::Device, queue: wgpu::Queue) -> Result<GpuCanvas, String> {
        let renderer = Renderer::new(
            &device,
            RendererOptions {
                use_cpu: false,
                antialiasing_support: AaSupport::area_only(),
                num_init_threads: NonZeroUsize::new(1),
                pipeline_cache: None,
            },
        )
        .map_err(|e| e.to_string())?;
        Ok(GpuCanvas {
            device,
            queue,
            renderer,
            targets: [None, None],
            flip: 0,
            fonts: HashMap::new(),
            images: ImageCache::default(),
        })
    }

    /// Rendert die Szene in `scale`-facher Größe in eine Rgba8Unorm-Textur (TEXTURE_BINDING + RENDER_ATTACHMENT),
    /// die Slint per `slint::Image::try_from` direkt anzeigt. Zwei Texturen im Wechsel, damit die gezeigte nicht
    /// überschrieben wird.
    pub fn render(&mut self, scene: &Scene, scale: f32) -> Result<wgpu::Texture, String> {
        let (w, h) = (
            (scene.width * scale).round().max(1.) as u32,
            (scene.height * scale).round().max(1.) as u32,
        );
        let mut vs = vello::Scene::new();
        let base = Affine::scale(f64::from(scale));
        vs.fill(
            Fill::NonZero,
            base,
            color(scene.background),
            None,
            &Rect::new(0., 0., f64::from(scene.width), f64::from(scene.height)),
        );
        for n in &scene.nodes {
            self.node(&mut vs, n, base);
        }
        self.flip ^= 1;
        let slot = &mut self.targets[self.flip];
        if slot
            .as_ref()
            .is_none_or(|t| t.width() != w || t.height() != h)
        {
            *slot = Some(self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("dw-stage"),
                size: wgpu::Extent3d {
                    width: w,
                    height: h,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8Unorm,
                // STORAGE für vello, TEXTURE_BINDING + RENDER_ATTACHMENT verlangt Slints Import
                usage: wgpu::TextureUsages::STORAGE_BINDING
                    | wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::RENDER_ATTACHMENT,
                view_formats: &[],
            }));
        }
        let tex = slot.clone().expect("Textur angelegt");
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        self.renderer
            .render_to_texture(
                &self.device,
                &self.queue,
                &vs,
                &view,
                &RenderParams {
                    base_color: color(scene.background),
                    width: w,
                    height: h,
                    antialiasing_method: AaConfig::Area,
                },
            )
            .map_err(|e| e.to_string())?;
        Ok(tex)
    }

    fn node(&mut self, vs: &mut vello::Scene, node: &Node, t: Affine) {
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
                    let r = *rect + kurbo::Vec2::new(0., f64::from(s.offset_y));
                    // CSS-Blur-Radius = 2σ (wie dw-raster)
                    vs.draw_blurred_rounded_rect(
                        t,
                        r,
                        color(s.color),
                        *radius,
                        f64::from(s.blur) / 2.,
                    );
                }
                shape(
                    vs,
                    t,
                    &rect_path(rect, *radius),
                    fill.as_ref(),
                    stroke.as_ref(),
                );
            }
            Node::Path {
                path, fill, stroke, ..
            } => shape(vs, t, path, fill.as_ref(), stroke.as_ref()),
            Node::Glyphs { run, .. } => {
                let key = (Arc::as_ptr(&run.font.data) as usize, run.font.index);
                let (_, font) = self
                    .fonts
                    .entry(key)
                    .or_insert_with(|| {
                        let f = peniko::FontData::new(
                            peniko::Blob::new(run.font.data.clone()),
                            run.font.index,
                        );
                        (run.font.data.clone(), f)
                    })
                    .clone();
                vs.draw_glyphs(&font)
                    .transform(t)
                    .font_size(run.size)
                    .hint(false)
                    .brush(color(run.color))
                    .draw(
                        Fill::NonZero,
                        run.glyphs.iter().map(|g| vello::Glyph {
                            id: g.id,
                            x: g.x,
                            y: g.y,
                        }),
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
                let Some(img) = self.image(src) else { return };
                let (iw, ih) = (f64::from(img.width), f64::from(img.height));
                let place = dw_raster::fit_rect(*rect, iw, ih, *fit, *focus);
                vs.push_clip_layer(
                    Fill::NonZero,
                    t,
                    &rect_path(&place.intersect(*rect), *radius),
                );
                let brush = ImageBrush::new(img)
                    .with_extend(Extend::Pad)
                    .with_quality(ImageQuality::High);
                vs.draw_image(
                    &brush,
                    t * Affine::translate((place.x0, place.y0))
                        * Affine::scale_non_uniform(place.width() / iw, place.height() / ih),
                );
                vs.pop_layer();
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
                let mode = match blend {
                    Blend::Normal => Mix::Normal,
                    Blend::Multiply => Mix::Multiply,
                    Blend::Screen => Mix::Screen,
                };
                let layer = clip.is_some() || *blend != Blend::Normal || *opacity < 1.;
                if layer {
                    let all = Rect::new(-1e5, -1e5, 1e5, 1e5).to_path(0.1);
                    vs.push_layer(
                        Fill::NonZero,
                        BlendMode::from(mode),
                        *opacity,
                        t,
                        clip.as_ref().unwrap_or(&all),
                    );
                }
                for c in children {
                    self.node(vs, c, t);
                }
                if layer {
                    vs.pop_layer();
                }
            }
        }
    }

    /// Bilder einmal dekodieren: beim Tippen wird dieselbe Folie oft neu gezeichnet.
    fn image(&mut self, src: &ImageSrc) -> Option<ImageData> {
        self.images.get_or_decode(src, |src| {
            let img = dw_raster::decode_image(src)
                .map_err(|e| eprintln!("Bild: {e}"))
                .ok()?;
            let (w, h) = img.dimensions();
            Some(ImageData {
                data: peniko::Blob::new(Arc::new(img.into_raw())),
                format: ImageFormat::Rgba8,
                alpha_type: ImageAlphaType::Alpha,
                width: w,
                height: h,
            })
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
enum ImageKey {
    /// Pfad + Änderungszeit: neu gespeicherte Datei wird neu gelesen
    Path(std::path::PathBuf, Option<std::time::SystemTime>),
    /// Adresse der Bytes; der Eintrag hält den Arc, damit die Adresse nicht neu vergeben wird
    Bytes(usize),
}

type ImageEntry = (ImageKey, Option<Arc<Vec<u8>>>, ImageData);

/// Kleiner LRU-Puffer für dekodierte Bilder (Anzahl und Bytes begrenzt).
#[derive(Default)]
struct ImageCache {
    // vorn = zuletzt benutzt
    entries: Vec<ImageEntry>,
}

const IMAGE_MAX: usize = 32;
const IMAGE_BYTES: usize = 256 << 20;

impl ImageCache {
    fn get_or_decode(
        &mut self,
        src: &ImageSrc,
        decode: impl FnOnce(&ImageSrc) -> Option<ImageData>,
    ) -> Option<ImageData> {
        let (key, keep) = match src {
            ImageSrc::Path(p) => (
                ImageKey::Path(
                    p.clone(),
                    std::fs::metadata(p).and_then(|m| m.modified()).ok(),
                ),
                None,
            ),
            ImageSrc::Bytes(b) => (ImageKey::Bytes(Arc::as_ptr(b) as usize), Some(b.clone())),
        };
        if let Some(i) = self.entries.iter().position(|e| e.0 == key) {
            let e = self.entries.remove(i);
            let data = e.2.clone();
            self.entries.insert(0, e);
            return Some(data);
        }
        let data = decode(src)?;
        // ältere Fassung derselben Datei weg
        if let ImageKey::Path(p, _) = &key {
            self.entries
                .retain(|e| !matches!(&e.0, ImageKey::Path(q, _) if q == p));
        }
        self.entries.insert(0, (key, keep, data.clone()));
        let mut bytes = 0;
        let mut n = 0;
        for e in &self.entries {
            bytes += e.2.data.len();
            if n >= IMAGE_MAX || (n > 0 && bytes > IMAGE_BYTES) {
                break;
            }
            n += 1;
        }
        self.entries.truncate(n);
        Some(data)
    }
}

fn shape(
    vs: &mut vello::Scene,
    t: Affine,
    path: &BezPath,
    fill: Option<&Paint>,
    stroke: Option<&Stroke>,
) {
    if let Some(p) = fill {
        match p {
            Paint::Solid(c) => vs.fill(Fill::NonZero, t, color(*c), None, path),
            _ => vs.fill(Fill::NonZero, t, &gradient(p), None, path),
        }
    }
    if let Some(s) = stroke {
        let mut k = kurbo::Stroke::new(f64::from(s.width));
        if let Some(d) = &s.dash {
            k = k.with_dashes(0., d.iter().map(|v| f64::from(*v)));
        }
        vs.stroke(&k, t, color(s.color), None, path);
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
                start_radius: 0.,
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
    if radius > 0. {
        RoundedRect::from_rect(*r, radius).to_path(0.1)
    } else {
        r.to_path(0.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(px: usize) -> ImageData {
        ImageData {
            data: peniko::Blob::new(Arc::new(vec![0; px * 4])),
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: px as u32,
            height: 1,
        }
    }

    #[test]
    fn cache_keys_and_limits() {
        let mut c = ImageCache::default();
        let mut calls = 0;
        let b = Arc::new(vec![1u8, 2, 3]);
        let src = ImageSrc::Bytes(b.clone());
        for _ in 0..3 {
            c.get_or_decode(&src, |_| {
                calls += 1;
                Some(img(1))
            });
        }
        assert_eq!(calls, 1, "Treffer über die Adresse");
        // Eintrag hält die Bytes: Adresse bleibt belegt, auch wenn der Aufrufer loslässt
        drop(src);
        assert_eq!(Arc::strong_count(&b), 2);
        // Pfad: geänderte Datei (mtime) wird neu dekodiert, alte Fassung verdrängt
        let dir = std::env::temp_dir().join(format!("dw-canvas-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.png");
        std::fs::write(&p, b"x").unwrap();
        let src = ImageSrc::Path(p.clone());
        c.get_or_decode(&src, |_| Some(img(1)));
        let f = std::fs::File::options().write(true).open(&p).unwrap();
        f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
            .unwrap();
        let mut again = false;
        c.get_or_decode(&src, |_| {
            again = true;
            Some(img(1))
        });
        assert!(again);
        assert_eq!(c.entries.len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
        // Grenze: höchstens IMAGE_MAX Einträge
        for _ in 0..IMAGE_MAX + 5 {
            c.get_or_decode(&ImageSrc::Bytes(Arc::new(vec![0])), |_| Some(img(1)));
        }
        assert_eq!(c.entries.len(), IMAGE_MAX);
        // Bytegrenze: ein Riesenbild verdrängt den Rest, bleibt selbst aber drin
        c.get_or_decode(&ImageSrc::Bytes(Arc::new(vec![0])), |_| {
            Some(img(IMAGE_BYTES / 4 + 1))
        });
        assert_eq!(c.entries.len(), 1);
    }
}
