//! Was die Engine misst und an Lint und PPTX-Export weitergibt (px, relativ zur Folie). Abbild von deck.ts `El`/`Measured`.
//! Offene Aufzählungen (anim, shape, mask …) bleiben `String`, damit neue TS-Werte nicht am Lesen scheitern.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ElBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontRole {
    Head,
    Body,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub break_after: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    // nur, wenn die Schrift vom Element abweicht (Einheit einer Kennzahl)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_px: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tracking_px: Option<f64>,
}

/// Gemeinsame Felder aller Elemente (TS `Base`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Base {
    pub slot: String,
    #[serde(rename = "box")]
    pub bbox: ElBox,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rot: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anim: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anim_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anim_speed: Option<String>,
    // Klickziel freier Elemente (Item.link)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextEffect {
    #[serde(rename = "type")]
    pub kind: String, // shadow | lift | hollow | neon
    pub color: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ListType {
    Bullet,
    Number,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextList {
    #[serde(rename = "type")]
    pub kind: ListType,
    pub indent_px: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEl {
    #[serde(flatten)]
    pub base: Base,
    pub font: FontRole,
    pub role: String,
    pub size_px: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<TextEffect>,
    // freier Text mit eigener Schrift, sonst Theme-Schrift nach `font`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_face: Option<String>,
    pub line_height_px: f64,
    pub tracking_px: f64,
    pub align: Align,
    pub upper: bool,
    pub runs: Vec<Run>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<TextList>,
    pub lines: u32,
    pub bg: String, // effektiver Hintergrund hinter dem Text (Kontrast-Lint)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoxFill {
    pub color: String,
    pub alpha: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Border {
    pub color: String,
    pub width: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxShadow {
    pub color: String,
    pub alpha: f64,
    pub blur: f64,
    pub offset_y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GradientStop {
    pub color: String,
    pub alpha: f64,
    pub pos: f64, // 0..1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Gradient {
    pub angle: f64, // CSS-Grad
    pub stops: Vec<GradientStop>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxEl {
    #[serde(flatten)]
    pub base: Base,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<BoxFill>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<Border>,
    pub radius: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shadow: Option<BoxShadow>,
    pub ellipse: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient: Option<Gradient>,
    // freie Form (Dreieck, Stern …) als native PowerPoint-Form
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dash: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImgFit {
    Cover,
    Contain,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Focus {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct NatSize {
    pub w: f64,
    pub h: f64,
}

// −100…100 (blur 0…100)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Adjust {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bright: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contrast: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sat: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blur: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImgEl {
    #[serde(flatten)]
    pub base: Base,
    pub src: String,
    pub radius: f64,
    pub fit: ImgFit,
    pub focus: Focus,
    // Foto unter Text (Vollbild): Überlappung erlaubt
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub under: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nat: Option<NatSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub look: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adjust: Option<Adjust>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpha: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flip: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IconEl {
    #[serde(flatten)]
    pub base: Base,
    pub svg: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub png: Option<String>,
    // name/qr: Herkunft, damit „Layout lösen“ echte Icon-/QR-Elemente erzeugt
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChartType {
    Bar,
    Hbar,
    Stacked,
    Waterfall,
    Line,
    Donut,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Series {
    pub name: String,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartSpec {
    #[serde(rename = "type")]
    pub kind: ChartType,
    pub categories: Vec<String>,
    pub series: Vec<Series>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotate: Option<String>, // cagr | delta
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartEl {
    #[serde(flatten)]
    pub base: Base,
    pub spec: ChartSpec,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MediaEl {
    #[serde(flatten)]
    pub base: Base,
    pub media: MediaKind,
    pub src: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
}

// Zeile 0 = Kopfzeile
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableEl {
    #[serde(flatten)]
    pub base: Base,
    pub cells: Vec<Vec<String>>,
    pub col_w: Vec<f64>,
    pub row_h: Vec<f64>,
    pub size_px: f64,
    pub font: FontRole,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_face: Option<String>,
    pub color: String,
    pub line: String,
    pub align: Vec<Align>, // je Spalte; TS kennt nur left/right
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum El {
    Text(TextEl),
    Box(BoxEl),
    Img(ImgEl),
    Icon(IconEl),
    Chart(ChartEl),
    Media(MediaEl),
    Table(TableEl),
}

impl El {
    pub fn base(&self) -> &Base {
        match self {
            El::Text(e) => &e.base,
            El::Box(e) => &e.base,
            El::Img(e) => &e.base,
            El::Icon(e) => &e.base,
            El::Chart(e) => &e.base,
            El::Media(e) => &e.base,
            El::Table(e) => &e.base,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverflowKind {
    Height,
    Width,
    Lines,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overflow {
    pub slot: String,
    pub over_px: f64,
    pub kind: OverflowKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fit {
    pub ok: bool,
    pub head: u32, // Stufe der Typo-Skala
    pub body: u32,
    pub overflow: Vec<Overflow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Measured {
    pub els: Vec<El>,
    pub fit: Fit,
}
