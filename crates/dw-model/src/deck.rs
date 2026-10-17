//! deck.json (deck.ts `Deck`, `Slide`, `Item`). Typisiert ist nur, was Rendern und Export brauchen;
//! alles Übrige reicht `extra` unverändert durch, damit Lesen und Schreiben nichts verliert.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::format::Size;
use crate::measured::Crop;

type Extra = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Deck {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<Size>, // ohne = 1280×720
    pub theme: ThemeRef,
    // in TS Pflicht, fehlt aber in älteren deck.json
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>, // click | auto
    pub slides: Vec<Slide>,
    #[serde(flatten)]
    pub extra: Extra,
}

impl Deck {
    pub fn size(&self) -> Size {
        self.size.unwrap_or(Size {
            w: 1280.0,
            h: 720.0,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThemeRef {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand: Option<BrandKit>,
    // ThemeSpec; resolveTheme wandert in einem späteren Task nach Rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fonts: Option<(String, String)>, // [Titel, Text]
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandKit {
    pub primary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_dark: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_font: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_font: Option<String>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Slide {
    pub id: String,
    pub layout: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    pub content: Value, // je Layout später typisiert
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<Item>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden: Option<bool>,
    #[serde(flatten)]
    pub extra: Extra,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ItemKind {
    Text,
    Shape,
    Image,
    Icon,
    Chart,
    Video,
    Audio,
    Qr,
    Graphic,
    Table,
    // unbekannte Art (neuere/fremde deck.json): bleibt erhalten statt das Deck abzulehnen
    #[serde(untagged)]
    Other(String),
}

/// Freies Element, Position in px auf der Folie.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: ItemKind,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rot: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<String>, // head | body | FontName
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stroke_w: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub src: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<Value>, // ChartSpec; ungeprüft, damit ein unbekannter spec.type das Deck nicht kippt
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cells: Option<Vec<Vec<String>>>,
    #[serde(flatten)]
    pub extra: Extra,
}
