//! Szenengraph: Schnittstelle zwischen Layout-Engine (dw-scene) und Renderern (Raster, PDF, PPTX).
//! Koordinaten in px der Folie. Schriftdaten werden nicht serialisiert, damit Szenen als JSON lesbar bleiben.

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use kurbo::{Affine, BezPath, Rect};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::measured::ImgFit;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub width: f32,
    pub height: f32,
    pub background: Color,
    pub nodes: Vec<Node>,
}

/// sRGB mit Alpha; als JSON "#rrggbbaa".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Color {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

impl Color {
    pub const BLACK: Color = Color {
        r: 0,
        g: 0,
        b: 0,
        a: 255,
    };
    pub const WHITE: Color = Color {
        r: 255,
        g: 255,
        b: 255,
        a: 255,
    };
    pub const TRANSPARENT: Color = Color {
        r: 0,
        g: 0,
        b: 0,
        a: 0,
    };

    /// #rgb, #rrggbb, #rrggbbaa (ohne # ebenso).
    pub fn from_hex(s: &str) -> Option<Color> {
        let h = s.strip_prefix('#').unwrap_or(s);
        if !h.is_ascii() {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
        match h.len() {
            3 => {
                let n = |i: usize| u8::from_str_radix(&h[i..i + 1], 16).ok().map(|v| v * 17);
                Some(Color {
                    r: n(0)?,
                    g: n(1)?,
                    b: n(2)?,
                    a: 255,
                })
            }
            6 => Some(Color {
                r: byte(0)?,
                g: byte(2)?,
                b: byte(4)?,
                a: 255,
            }),
            8 => Some(Color {
                r: byte(0)?,
                g: byte(2)?,
                b: byte(4)?,
                a: byte(6)?,
            }),
            _ => None,
        }
    }

    /// #rrggbb, bei Transparenz #rrggbbaa.
    pub fn to_hex(&self) -> String {
        let Color { r, g, b, a } = *self;
        if a == 255 {
            format!("#{r:02x}{g:02x}{b:02x}")
        } else {
            format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
        }
    }
}

impl Serialize for Color {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Color::from_hex(&s).ok_or_else(|| serde::de::Error::custom(format!("keine Farbe: {s}")))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Stop {
    pub offset: f32,
    pub color: Color,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Paint {
    Solid(Color),
    Linear {
        start: kurbo::Point,
        end: kurbo::Point,
        stops: Vec<Stop>,
    },
    Radial {
        center: kurbo::Point,
        radius: f64,
        stops: Vec<Stop>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Stroke {
    pub width: f32,
    pub color: Color,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dash: Option<Vec<f32>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Shadow {
    pub color: Color,
    pub blur: f32,
    pub offset_y: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Blend {
    #[default]
    Normal,
    Multiply,
    Screen,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageSrc {
    Path(PathBuf),
    // im JSON nur die Länge
    Bytes(#[serde(serialize_with = "byte_len", skip_deserializing)] Arc<Vec<u8>>),
}

fn byte_len<S: Serializer>(b: &Arc<Vec<u8>>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_u64(b.len() as u64)
}

/// Schriftdatei für einen GlyphRun; im JSON nur die Beschreibung, nicht die Bytes.
#[derive(Clone, Serialize, Deserialize)]
pub struct FontData {
    #[serde(skip)]
    pub data: Arc<Vec<u8>>,
    pub index: u32,
    pub family: String,
    pub weight: u16,
    pub italic: bool,
}

impl fmt::Debug for FontData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FontData")
            .field("family", &self.family)
            .field("weight", &self.weight)
            .field("italic", &self.italic)
            .field("index", &self.index)
            .field("bytes", &self.data.len())
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Glyph {
    pub id: u32,
    pub x: f32,
    pub y: f32, // Grundlinie
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlyphRun {
    pub font: FontData,
    pub size: f32,
    pub color: Color,
    pub glyphs: Vec<Glyph>,
    pub text: String, // Klartext für PDF-Textebene und PPTX
}

/// Gemeinsame Metadaten jedes Knotens.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NodeMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
    // true = geht nativ in die PPTX, fehlt deshalb im Hintergrundbild
    #[serde(default)]
    pub export: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Node {
    Rect {
        #[serde(flatten)]
        meta: NodeMeta,
        rect: Rect,
        radius: f64,
        fill: Option<Paint>,
        stroke: Option<Stroke>,
        shadow: Option<Shadow>,
    },
    Path {
        #[serde(flatten)]
        meta: NodeMeta,
        path: BezPath,
        fill: Option<Paint>,
        stroke: Option<Stroke>,
    },
    Glyphs {
        #[serde(flatten)]
        meta: NodeMeta,
        run: GlyphRun,
    },
    Image {
        #[serde(flatten)]
        meta: NodeMeta,
        rect: Rect,
        src: ImageSrc,
        fit: ImgFit,
        focus: (f32, f32), // 0..1 wie background-position
        radius: f64,
    },
    Group {
        #[serde(flatten)]
        meta: NodeMeta,
        transform: Affine,
        opacity: f32,
        clip: Option<BezPath>,
        blend: Blend,
        children: Vec<Node>,
    },
}

impl Node {
    pub fn meta(&self) -> &NodeMeta {
        match self {
            Node::Rect { meta, .. }
            | Node::Path { meta, .. }
            | Node::Glyphs { meta, .. }
            | Node::Image { meta, .. }
            | Node::Group { meta, .. } => meta,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex() {
        assert_eq!(Color::from_hex("#fff"), Some(Color::WHITE));
        assert_eq!(Color::from_hex("#B0431A").unwrap().to_hex(), "#b0431a");
        assert_eq!(Color::from_hex("#11223380").unwrap().a, 0x80);
        assert_eq!(Color::from_hex("#12345"), None);
        assert_eq!(Color::from_hex("#ü1"), None);
    }

    #[test]
    fn scene_json() {
        let font = FontData {
            data: Arc::new(vec![0; 10]),
            index: 0,
            family: "Inter".into(),
            weight: 700,
            italic: false,
        };
        let scene = Scene {
            width: 1280.0,
            height: 720.0,
            background: Color::WHITE,
            nodes: vec![Node::Group {
                meta: NodeMeta::default(),
                transform: Affine::IDENTITY,
                opacity: 1.0,
                clip: None,
                blend: Blend::Normal,
                children: vec![
                    Node::Rect {
                        meta: NodeMeta {
                            slot: Some("bg".into()),
                            export: true,
                        },
                        rect: Rect::new(0.0, 0.0, 10.0, 10.0),
                        radius: 4.0,
                        fill: Some(Paint::Solid(Color::BLACK)),
                        stroke: None,
                        shadow: None,
                    },
                    Node::Glyphs {
                        meta: NodeMeta::default(),
                        run: GlyphRun {
                            font,
                            size: 24.0,
                            color: Color::BLACK,
                            glyphs: vec![Glyph {
                                id: 3,
                                x: 0.0,
                                y: 20.0,
                            }],
                            text: "A".into(),
                        },
                    },
                ],
            }],
        };
        let json = serde_json::to_string(&scene).unwrap();
        assert!(json.contains("\"family\":\"Inter\"") && !json.contains("data"));
        let back: Scene = serde_json::from_str(&json).unwrap();
        assert_eq!(serde_json::to_string(&back).unwrap(), json);
    }
}
