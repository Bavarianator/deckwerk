//! CMYK-Spike: sRGB → FOGRA39 per lcms2, OutputIntent für PDF/X-4, Farbauftrag.

use std::sync::Arc;

use dw_model::{Color, ImageSrc, Node, Paint, Scene};
use krilla::color::cmyk;
use krilla::image::{BitsPerComponent, CustomImage, Image, ImageColorspace};
use lcms2::{Flags, Intent, PixelFormat, Profile, Transform};
use lopdf::{Object, Stream, dictionary};

use crate::{Error, Result};

pub(crate) const FOGRA39: &[u8] = include_bytes!("../../../assets/icc/FOGRA39L_coated.icc");

pub(crate) struct Converter {
    xf: Transform<[u8; 3], [u8; 4]>,
}

impl Converter {
    pub(crate) fn new() -> Result<Self> {
        let out = Profile::new_icc(FOGRA39).map_err(|e| Error::Icc(e.to_string()))?;
        let xf = Transform::new_flags(
            &Profile::new_srgb(),
            PixelFormat::RGB_8,
            &out,
            PixelFormat::CMYK_8,
            Intent::RelativeColorimetric,
            Flags::BLACKPOINT_COMPENSATION,
        )
        .map_err(|e| Error::Icc(e.to_string()))?;
        Ok(Self { xf })
    }

    fn convert(&self, c: Color, text: bool) -> [u8; 4] {
        let (max, min) = (c.r.max(c.g).max(c.b), c.r.min(c.g).min(c.b));
        // Schwarzer und fast schwarzer neutraler Text nur in K, wie Druckereien es erwarten.
        if text && max - min <= 8 && max <= 0x40 {
            let avg = (u16::from(c.r) + u16::from(c.g) + u16::from(c.b)) / 3;
            return [0, 0, 0, 255 - avg as u8];
        }
        let mut out = [[0u8; 4]];
        self.xf.transform_pixels(&[[c.r, c.g, c.b]], &mut out);
        out[0]
    }

    pub(crate) fn color(&self, c: Color, text: bool) -> cmyk::Color {
        let [k0, k1, k2, k3] = self.convert(c, text);
        cmyk::Color::new(k0, k1, k2, k3)
    }

    fn pixels(&self, bytes: &[u8]) -> Result<CmykImage> {
        let img = image::load_from_memory(bytes)
            .map_err(|e| Error::Image(e.to_string()))?
            .to_rgba8();
        let (w, h) = img.dimensions();
        let rgb: Vec<[u8; 3]> = img.pixels().map(|p| [p[0], p[1], p[2]]).collect();
        let mut out = vec![[0u8; 4]; rgb.len()];
        self.xf.transform_pixels(&rgb, &mut out);
        let alpha: Vec<u8> = img.pixels().map(|p| p[3]).collect();
        Ok(CmykImage {
            color: Arc::new(out.concat()),
            alpha: alpha.iter().any(|&a| a < 255).then(|| Arc::new(alpha)),
            size: (w, h),
        })
    }

    pub(crate) fn image(&self, bytes: &[u8]) -> Result<Image> {
        Image::from_custom(self.pixels(bytes)?, true).map_err(Error::Image)
    }
}

#[derive(Clone, Hash)]
struct CmykImage {
    color: Arc<Vec<u8>>,
    alpha: Option<Arc<Vec<u8>>>,
    size: (u32, u32),
}

impl CustomImage for CmykImage {
    fn color_channel(&self) -> &[u8] {
        &self.color
    }
    fn alpha_channel(&self) -> Option<&[u8]> {
        self.alpha.as_deref().map(Vec::as_slice)
    }
    fn bits_per_component(&self) -> BitsPerComponent {
        BitsPerComponent::Eight
    }
    fn size(&self) -> (u32, u32) {
        self.size
    }
    fn icc_profile(&self) -> Option<&[u8]> {
        None
    }
    fn color_space(&self) -> ImageColorspace {
        ImageColorspace::Cmyk
    }
}

/// Höchster Farbauftrag (C+M+Y+K in %) aller Flächen, Bilder je Pixel; Grundlage für den Lint (> 300 %).
pub fn total_area_coverage(scene: &Scene) -> f32 {
    let Ok(conv) = Converter::new() else {
        return 0.0;
    };
    let tac = |k: [u8; 4]| k.iter().map(|&v| u32::from(v)).sum::<u32>();
    let paint = |p: &Paint| match p {
        Paint::Solid(c) => tac(conv.convert(*c, false)),
        Paint::Linear { stops, .. } | Paint::Radial { stops, .. } => stops
            .iter()
            .map(|s| tac(conv.convert(s.color, false)))
            .max()
            .unwrap_or(0),
    };
    fn walk(nodes: &[Node], f: &mut dyn FnMut(&Node)) {
        for n in nodes {
            f(n);
            if let Node::Group { children, .. } = n {
                walk(children, f);
            }
        }
    }
    let mut max = tac(conv.convert(scene.background, false));
    walk(&scene.nodes, &mut |n| {
        let v = match n {
            Node::Rect {
                fill,
                stroke,
                shadow,
                ..
            } => fill
                .iter()
                .map(paint)
                .chain(stroke.iter().map(|s| tac(conv.convert(s.color, false))))
                .chain(shadow.iter().map(|s| tac(conv.convert(s.color, false))))
                .max()
                .unwrap_or(0),
            Node::Path { fill, stroke, .. } => fill
                .iter()
                .map(paint)
                .chain(stroke.iter().map(|s| tac(conv.convert(s.color, false))))
                .max()
                .unwrap_or(0),
            Node::Glyphs { run, .. } => tac(conv.convert(run.color, true)),
            Node::Image { src, .. } => {
                let bytes = match src {
                    ImageSrc::Path(p) => std::fs::read(p).unwrap_or_default(),
                    ImageSrc::Bytes(b) => b.to_vec(),
                };
                conv.pixels(&bytes).map_or(0, |img| {
                    img.color
                        .chunks_exact(4)
                        .enumerate()
                        .filter(|(i, _)| img.alpha.as_ref().is_none_or(|a| a[*i] > 0))
                        .map(|(_, k)| tac([k[0], k[1], k[2], k[3]]))
                        .max()
                        .unwrap_or(0)
                })
            }
            Node::Group { .. } => 0,
        };
        max = max.max(v);
    });
    max as f32 * 100.0 / 255.0
}

/// Ergänzt OutputIntent (FOGRA39), Info- und XMP-Kennung für PDF/X-4.
pub(crate) fn add_output_intent(pdf: &[u8]) -> Result<Vec<u8>> {
    let err = |e: lopdf::Error| Error::Pdf(e.to_string());
    let mut doc = lopdf::Document::load_mem(pdf).map_err(err)?;
    doc.version = "1.6".into();

    // krilla schreibt Transparenzgruppen immer in DeviceRGB; PDF/X-4 mit CMYK-Ausgabe verlangt CMYK.
    for obj in doc.objects.values_mut() {
        let dict = match obj {
            Object::Dictionary(d) => d,
            Object::Stream(s) => &mut s.dict,
            _ => continue,
        };
        fix_group(dict);
        if let Ok(Object::Dictionary(g)) = dict.get_mut(b"Group") {
            fix_group(g);
        }
    }

    let icc = doc.add_object(Stream::new(dictionary! { "N" => 4 }, FOGRA39.to_vec()));
    let intent = dictionary! {
        "Type" => "OutputIntent",
        "S" => "GTS_PDFX",
        "OutputConditionIdentifier" => Object::string_literal("FOGRA39"),
        "OutputCondition" => Object::string_literal("Offsetdruck, gestrichenes Papier (ISO 12647-2:2004)"),
        "RegistryName" => Object::string_literal("http://www.color.org"),
        "Info" => Object::string_literal("FOGRA39L coated"),
        "DestOutputProfile" => icc,
    };
    let meta = doc
        .catalog()
        .ok()
        .and_then(|c| c.get(b"Metadata").ok()?.as_reference().ok());
    doc.catalog_mut()
        .map_err(err)?
        .set("OutputIntents", vec![Object::Dictionary(intent)]);

    let info = match doc.trailer.get(b"Info").and_then(Object::as_reference) {
        Ok(id) => id,
        Err(_) => {
            let id = doc.add_object(dictionary! {});
            doc.trailer.set("Info", id);
            id
        }
    };
    let info = doc.get_dictionary_mut(info).map_err(err)?;
    info.set("GTS_PDFXVersion", Object::string_literal("PDF/X-4"));
    info.set("Trapped", Object::Name(b"False".to_vec()));

    // PDF/X-4 verlangt die Kennung auch im XMP; ohne XMP lieber Fehler als ein halbes PDF/X.
    let no_xmp = || Error::Pdf("XMP-Metadaten fehlen".into());
    let Some(Ok(Object::Stream(s))) = meta.map(|id| doc.get_object_mut(id)) else {
        return Err(no_xmp());
    };
    {
        let xml = String::from_utf8_lossy(&s.get_plain_content().map_err(err)?).into_owned();
        if !xml.contains("</rdf:RDF>") {
            return Err(no_xmp());
        }
        let xml = xml.replacen(
            "</rdf:RDF>",
            concat!(
                r#"<rdf:Description rdf:about="" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">"#,
                "<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion><pdf:Trapped>False</pdf:Trapped>",
                "</rdf:Description></rdf:RDF>"
            ),
            1,
        );
        s.dict.remove(b"Filter");
        s.set_content(xml.into_bytes());
    }

    let mut out = Vec::new();
    doc.save_to(&mut out)
        .map_err(|e| Error::Pdf(e.to_string()))?;
    Ok(out)
}

fn fix_group(d: &mut lopdf::Dictionary) {
    let transparency = matches!(d.get(b"S"), Ok(Object::Name(n)) if n == b"Transparency");
    let rgb = matches!(d.get(b"CS"), Ok(Object::Name(n)) if n == b"DeviceRGB");
    if transparency && rgb {
        d.set("CS", Object::Name(b"DeviceCMYK".to_vec()));
    }
}

/// Jetzt als krilla-Datum (UTC), für CreationDate/ModDate, die PDF/X-4 verlangt.
pub(crate) fn now() -> krilla::metadata::DateTime {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    // Tage → Kalenderdatum (Algorithmus von H. Hinnant)
    let z = (secs / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let t = secs % 86_400;
    krilla::metadata::DateTime::new(y as u16)
        .month(m as u8)
        .day(d as u8)
        .hour((t / 3600) as u8)
        .minute((t / 60 % 60) as u8)
        .second((t % 60) as u8)
        .utc_offset_hour(0)
        .utc_offset_minute(0)
}
